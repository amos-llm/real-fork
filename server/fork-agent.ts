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
import { importIntoWorkspace, type ImportSession } from "./daemon-import";
import { buildForkFile, forkFilePath, writeForkFile } from "./fork-file";
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
 * The file is handed to the daemon's import path (the same one `paseo import`
 * drives), so the session opens from the file and the history replays into the
 * timeline. Creating an agent and patching its file afterwards does not work —
 * the daemon keeps the live pi process, which never reloads that file.
 *
 * The import targets a workspace the handler just created for the fork (same
 * directory, new sidebar entry): the daemon's untargeted import always lands
 * in the oldest active workspace for the cwd — the parent's — where the fork
 * would be a tab, not a conversation of its own.
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

/** Branch entries up to and including `messageId` (a user message). */
function selectSlice(branch: readonly PiSessionEntry[], messageId: string) {
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
  const importSession = options.importSession ?? importIntoWorkspace;
  return async (input: RpcInput<typeof forkRpc>, context: PluginHandlerContext) => {
    const agent = await requirePiAgent(context.paseo, input.agentId);
    const sourceFile = await resolveSessionFile(agent.persistence);
    const source = parseSession(await readFile(sourceFile, "utf8"));
    const branch = activeBranch(source.entries);
    // Forking always cuts at a user message, so the copy ends on a settled
    // state: whatever follows the point — including a half-finished turn with
    // a dangling tool call — is dropped with the parent's tail.
    const slice = selectSlice(branch, input.messageId);
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

    // A fork is a new conversation: give it its own workspace (its own sidebar
    // entry) in the same directory, then import the prepared session into it.
    const workspace = await context.paseo.workspaces.create({
      source: { kind: "directory", path: agent.cwd },
      title,
    });
    let imported;
    try {
      imported = await importSession({
        sessionFile: targetFile,
        cwd: agent.cwd,
        workspaceId: workspace.id,
        title,
        labels: {
          [FORK_SOURCE_LABEL]: agent.id,
          ...(slice.point.id ? { [FORK_POINT_LABEL]: slice.point.id } : {}),
        },
      });
    } catch (error) {
      // Do not leave an empty workspace behind when the import fails.
      await workspace.archive().catch((cleanupError) => {
        console.warn(
          `[real-fork] failed to archive half-created workspace ${workspace.id}: ${String(cleanupError)}`,
        );
      });
      throw error;
    }

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
