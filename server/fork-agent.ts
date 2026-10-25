import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import {
  FORK_POINT_LABEL,
  FORK_SOURCE_LABEL,
  forkPointsRpc,
  forkRpc,
  type ForkPoint,
} from "../shared/fork";
import { buildForkFile, forkFilePath, writeForkFile } from "./fork-file";
import { runPaseoImport, type ImportSession } from "./paseo-import";
import {
  activeBranch,
  branchPoints,
  messagePreview,
  parseSession,
  renderSession,
  sliceBranch,
  type PiSessionEntry,
} from "./pi-session";
import { resolveSessionFile } from "./pi-session-file";

/**
 * Why this is a fork and not a summary.
 *
 * Paseo's built-in Fork turns the conversation into a `<chat-history-summary>`
 * text attachment on a brand-new session, which re-serializes the history: the
 * provider sees different tokens and misses its cache. pi sessions are JSONL
 * trees, so a fork can copy the active branch into a new session file and have
 * pi resume that instead.
 *
 * Two details decide whether the cache actually answers the first turn:
 *   - the messages must be byte-identical (copy the entries, never re-render them);
 *   - the header must keep the source **session id**, because pi passes it to the
 *     provider as the prompt cache key. Measured on opencode-go/deepseek: same id
 *     → 248k cached input and ~$0.0008; fresh id → 0 cached and ~$0.037.
 *
 * The file is handed to Paseo with `paseo import`, which is the daemon's real
 * import path: it opens the session from the file, so the history is replayed
 * into the timeline. Creating an agent and patching its file afterwards does not
 * work — the daemon keeps the live pi process, which never reloads that file.
 */

async function listAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  const { entries } = await paseo.agents.list();
  return entries.find((entry) => entry.agent.id === agentId)?.agent ?? null;
}

async function requirePiAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent> {
  const agent = await listAgent(paseo, agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (agent.provider !== "pi") {
    throw new Error("Real Fork only supports pi agents (the fork reuses pi's own session file)");
  }
  return agent;
}

export function forkTitle(title: string | null): string {
  const base = title?.trim() || "Agent";
  return base.endsWith("· fork") ? base : `${base} · fork`;
}

/** Branch entries up to `messageId`, or the whole branch when it is omitted. */
function selectSlice(branch: readonly PiSessionEntry[], messageId: string | null) {
  if (messageId === null) {
    const point = branch.at(-1);
    if (!point) throw new Error("This agent has no session entries to fork yet");
    return { branch: [...branch], point, dropped: 0 };
  }
  const slice = sliceBranch(branch, messageId);
  if (!slice) {
    const points = branchPoints(branch);
    throw new Error(
      points.length === 0
        ? "This agent has no user message to fork at yet"
        : "That message is not a user message on this agent's active branch; fork at a user message instead",
    );
  }
  return slice;
}

export function createForkPointsHandler() {
  return async (input: RpcInput<typeof forkPointsRpc>, context: PluginHandlerContext) => {
    const agent = await requirePiAgent(context.paseo, input.agentId);
    const sessionFile = await resolveSessionFile(agent.persistence);
    const text = await readFile(sessionFile, "utf8");
    const branch = activeBranch(parseSession(text).entries);
    const points: ForkPoint[] = branchPoints(branch)
      .filter(({ entry }) => Boolean(entry.id))
      .map(({ entry, entries }) => ({
        messageId: entry.id ?? "",
        preview: messagePreview(entry),
        at: entry.timestamp ?? null,
        entries,
      }));
    return {
      agentId: agent.id,
      cwd: agent.cwd,
      sessionFile,
      branchEntries: branch.length,
      points,
    };
  };
}

export function createForkHandler(options: { importSession?: ImportSession } = {}) {
  const importSession = options.importSession ?? runPaseoImport;
  return async (input: RpcInput<typeof forkRpc>, context: PluginHandlerContext) => {
    const agent = await requirePiAgent(context.paseo, input.agentId);
    const sourceFile = await resolveSessionFile(agent.persistence);
    const source = parseSession(await readFile(sourceFile, "utf8"));
    const slice = selectSlice(activeBranch(source.entries), input.messageId ?? null);
    const title = forkTitle(agent.title);

    const fork = buildForkFile({
      sourceFile,
      header: source.header,
      branch: slice.branch,
      title,
    });
    const targetFile = forkFilePath(agent.cwd);
    await writeForkFile(
      { path: targetFile, header: fork.header, entries: fork.entries },
      renderSession,
    );

    const imported = await importSession({
      sessionFile: targetFile,
      cwd: agent.cwd,
      title,
      labels: {
        [FORK_SOURCE_LABEL]: agent.id,
        ...(slice.point.id ? { [FORK_POINT_LABEL]: slice.point.id } : {}),
      },
    });

    console.log(
      `[real-fork] forked ${imported.agentId} from ${agent.id}: ${slice.branch.length} entries, ${slice.dropped} dropped, cache key ${fork.header.id ?? "?"}`,
    );

    return {
      agentId: imported.agentId,
      title: imported.title ?? title,
      cwd: agent.cwd,
      sessionFile: targetFile,
      entries: slice.branch.length,
      dropped: slice.dropped,
    };
  };
}
