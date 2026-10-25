import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import {
  FORK_POINT_LABEL,
  FORK_SOURCE_LABEL,
  forkPointsRpc,
  forkRpc,
  type ForkTurn,
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
  toolBatchPoints,
  toolBatchPreview,
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
 * The cut always lands on a prefix the source session itself requested from
 * the provider, so the copy stays byte-identical either way: a user-message
 * anchor sits just before a turn, and a tool-result anchor sits just after a
 * completed tool batch — the source's next request in that turn had exactly
 * that prefix.
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

/**
 * Branch entries kept when forking at `messageId` (a user message or a
 * completed tool batch).
 */
function selectSlice(branch: readonly PiSessionEntry[], messageId: string) {
  const slice = sliceBranch(branch, messageId);
  if (!slice) {
    const hasPoint = branchPoints(branch).length > 0 || toolBatchPoints(branch).length > 0;
    throw new Error(
      hasPoint
        ? "That entry is not a fork point on this agent's active branch; fork at a user message or a completed tool call instead"
        : "This agent has no forkable point yet — no user message or completed tool call",
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
    const users = branchPoints(branch).filter(({ entry }) => Boolean(entry.id));
    // Path details are shown relative to the agent's cwd when they live in it.
    const batches = toolBatchPoints(branch, `${agent.cwd}/`).filter(({ entry }) =>
      Boolean(entry.id),
    );
    // The picker is one interleaved timeline: each user row carries the tool
    // batches of the turn it started, collapsed by default on the client. A
    // batch belongs to that turn when its cut lies between the message and the
    // next newer user message (the branch end for the newest one). Batches
    // before the first user message cannot occur in a pi-produced branch.
    const points: ForkTurn[] = users.map(({ entry, entries }, i) => {
      const upper = i === 0 ? branch.length : users[i - 1].entries;
      return {
        messageId: entry.id ?? "",
        preview: messagePreview(entry),
        at: entry.timestamp ?? null,
        entries,
        toolPoints: batches
          .filter(({ entries: cut }) => cut > entries && cut < upper)
          .map(({ entry: toolEntry, entries: cut, toolNames, detail }) => ({
            messageId: toolEntry.id ?? "",
            // Single-call batches say which call it is (name + key argument);
            // parallel batches stay a compact list of names.
            preview:
              (toolNames?.length ?? 0) === 1 && detail
                ? `${toolNames?.[0]} · ${detail}`
                : toolBatchPreview(toolNames ?? []),
            at: toolEntry.timestamp ?? null,
            entries: cut,
          })),
      };
    });
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
    // The cut lands on a state pi can resume. A user-message anchor cuts just
    // before it: the copy is the settled conversation up to that point, and
    // the point itself is dropped because the fork rewrites it in its
    // composer. A tool-result anchor cuts just after a completed batch: the
    // copy keeps the batch and the fork redirects the turn from there — the
    // same state pi's own steering produces. Whatever follows the cut —
    // including a half-finished turn with a dangling tool call — is dropped
    // with the parent's tail.
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
