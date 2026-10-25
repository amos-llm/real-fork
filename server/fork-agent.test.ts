import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createForkHandler, createForkPointsHandler, forkTitle } from "./fork-agent";
import { FORK_DIR } from "./fork-file";
import { parseSession, type PiSessionEntry } from "./pi-session";
import { forkRpc } from "../shared/fork";

const SESSION_ID = "01a17146-3194-7754-b8cd-5b39b16cebb0";

function header(cwd: string) {
  return {
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  };
}

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
): PiSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role, content: [{ type: "text", text }] },
  };
}

/** An assistant message issuing `calls` = [toolCallId, toolName, args?], in order. */
function assistantToolCall(
  id: string,
  parentId: string | null,
  calls: ReadonlyArray<readonly [string, string, Record<string, unknown>?]>,
): PiSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: calls.map(([callId, name, args = {}]) => ({
        type: "toolCall",
        id: callId,
        name,
        arguments: args,
      })),
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
): PiSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: [{ type: "text", text: "ok" }],
    },
  };
}

const SOURCE_ENTRIES: PiSessionEntry[] = [
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
  message("u1", "m1", "user", "first question"),
  message("a1", "u1", "assistant", "first answer"),
  message("u2", "a1", "user", "second question"),
  message("a2", "u2", "assistant", "second answer"),
];

/**
 * Two turns with tool batches: u1 → a1 (bash + read, parallel) → t1 → t2 →
 * a2 → u2 → a3 (bash) → t3 → a4.
 */
const TOOL_ENTRIES: PiSessionEntry[] = [
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
  message("u1", "m1", "user", "first question"),
  assistantToolCall("a1", "u1", [
    ["tc1", "bash"],
    ["tc2", "read"],
  ]),
  toolResultEntry("t1", "a1", "tc1", "bash"),
  toolResultEntry("t2", "t1", "tc2", "read"),
  message("a2", "t2", "assistant", "first answer"),
  message("u2", "a2", "user", "second question"),
  assistantToolCall("a3", "u2", [["tc3", "bash"]]),
  toolResultEntry("t3", "a3", "tc3", "bash"),
  message("a4", "t3", "assistant", "second answer"),
];

/** Turn aborted mid-batch: a1 issued two calls, only tc1 was answered. */
const ABORTED_BATCH_ENTRIES: PiSessionEntry[] = [
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
  message("u1", "m1", "user", "first question"),
  assistantToolCall("a1", "u1", [
    ["tc1", "bash"],
    ["tc2", "read"],
  ]),
  toolResultEntry("t1", "a1", "tc1", "bash"),
  message("u2", "t1", "user", "second question"),
  message("a2", "u2", "assistant", "second answer"),
];

/** Same branch, but the last assistant message issued a tool call with no result yet. */
const DANGLING_ENTRIES: PiSessionEntry[] = [
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
  message("u1", "m1", "user", "first question"),
  message("a1", "u1", "assistant", "first answer"),
  {
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 999" } },
      ],
    },
  },
];

interface StubOptions {
  provider?: string;
  title?: string | null;
  entries?: PiSessionEntry[];
  onWorkspaceArchive?: () => void;
}

/**
 * A source agent in a throwaway cwd: the fork writes into `<cwd>/.pi/forks`, so
 * the workspace has to be writable for the test.
 */
async function makeAgent(options: StubOptions = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "real-fork-cwd-"));
  const sourceFile = path.join(cwd, "session.jsonl");
  const lines = [header(cwd), ...(options.entries ?? SOURCE_ENTRIES)];
  await writeFile(sourceFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const parent = {
    id: "parent",
    provider: options.provider ?? "pi",
    cwd,
    workspaceId: "ws-1",
    status: "idle",
    model: "opencode-go/deepseek-v4.1-flash",
    thinkingOptionId: "high",
    title: options.title === undefined ? "Parent task" : options.title,
    persistence: { provider: "pi", sessionId: SESSION_ID, nativeHandle: sourceFile },
  };
  const paseo = {
    agents: { list: async () => ({ entries: [{ agent: parent }] }) },
    workspaces: {
      create: async () => ({
        id: "ws-fork",
        archive: async () => {
          options.onWorkspaceArchive?.();
          return {
            requestId: "req-archive",
            workspaceId: "ws-fork",
            archivedAt: "2026-01-01T00:00:02.000Z",
            error: null,
          };
        },
      }),
    },
  } as unknown as PaseoApi;
  return { cwd, sourceFile, paseo };
}

interface ImportCall {
  sessionFile: string;
  cwd: string;
  workspaceId: string;
  title: string;
  labels: Record<string, string>;
}

function recorder(agentId = "forked", title: string | null = "Parent task · fork") {
  const calls: ImportCall[] = [];
  return {
    calls,
    importSession: async (input: ImportCall) => {
      calls.push(input);
      return { agentId, title };
    },
  };
}

const context = (paseo: PaseoApi) => ({ paseo });

describe("real-fork.points", () => {
  it("lists user messages newest first", async () => {
    const { sourceFile, paseo } = await makeAgent();
    const result = await createForkPointsHandler()({ agentId: "parent" }, context(paseo));
    expect(result.sessionFile).toBe(sourceFile);
    expect(result.points.map((point) => point.messageId)).toEqual(["u2", "u1"]);
    expect(result.points[0].preview).toBe("second question");
    // Forking at u2 keeps [m1, u1, a1] — the point's own message is not kept.
    expect(result.points[0].entries).toBe(3);
    expect(result.branchEntries).toBe(5);
  });

  it("groups each turn's tool batches under the user message that started it", async () => {
    const { paseo } = await makeAgent({ entries: TOOL_ENTRIES });
    const result = await createForkPointsHandler()({ agentId: "parent" }, context(paseo));
    expect(result.branchEntries).toBe(10);
    // Newest user message first; each row carries only its own turn's batches.
    expect(result.points.map((point) => point.messageId)).toEqual(["u2", "u1"]);
    expect(result.points[0].toolPoints.map((point) => point.messageId)).toEqual(["t3"]);
    expect(result.points[0].toolPoints[0]).toMatchObject({ preview: "bash", entries: 9 });
    expect(result.points[1].toolPoints.map((point) => point.messageId)).toEqual(["t2"]);
    // The parallel batch is one point, anchored at its last result, named by
    // both calls. Forking there keeps m1, u1, a1, t1, t2.
    expect(result.points[1].toolPoints[0]).toMatchObject({ preview: "bash · read", entries: 5 });
  });

  it("labels a single-call batch with its key argument, not just the tool name", async () => {
    const { paseo } = await makeAgent({
      entries: [
        { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
        message("u1", "m1", "user", "first question"),
        assistantToolCall("a1", "u1", [["tc1", "bash", { command: "rg -n fork dist" }]]),
        toolResultEntry("t1", "a1", "tc1", "bash"),
        message("a2", "t1", "assistant", "first answer"),
      ],
    });
    const result = await createForkPointsHandler()({ agentId: "parent" }, context(paseo));
    expect(result.points[0].toolPoints[0].preview).toBe("bash · rg -n fork dist");
  });

  it("lists no tool batches for a settled conversation without tool calls", async () => {
    const { paseo } = await makeAgent();
    const result = await createForkPointsHandler()({ agentId: "parent" }, context(paseo));
    expect(result.points.every((point) => point.toolPoints.length === 0)).toBe(true);
  });

  it("rejects agents from other providers", async () => {
    const { paseo } = await makeAgent({ provider: "claude" });
    await expect(createForkPointsHandler()({ agentId: "parent" }, context(paseo))).rejects.toThrow(
      /only supports pi/u,
    );
  });
});

describe("real-fork.fork", () => {
  it("writes the branch under the source session id and imports it", async () => {
    const { cwd, sourceFile, paseo } = await makeAgent();
    const { calls, importSession } = recorder();

    const result = await createForkHandler({ importSession })(
      { agentId: "parent", messageId: "u2" },
      context(paseo),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cwd).toBe(cwd);
    // The fork gets its own workspace — its own sidebar entry, not a tab in the parent's.
    expect(call.workspaceId).toBe("ws-fork");
    expect(call.title).toBe("Parent task · fork");
    expect(call.labels).toEqual({ "real-fork.source": "parent", "real-fork.point": "u2" });
    // The fork file lives in the workspace's own `.pi` area, not in pi's session list.
    expect(call.sessionFile.startsWith(path.join(cwd, FORK_DIR))).toBe(true);

    const written = parseSession(await readFile(call.sessionFile, "utf8"));
    // The cache key is the header id, so the fork must keep the source's.
    expect(written.header.id).toBe(SESSION_ID);
    expect(written.header.parentSession).toBe(sourceFile);
    // Every copied entry stays in order, and the fork point's message is kept
    // out of the copy — the fork rewrites it. The fork is named after the parent.
    expect(written.entries.slice(0, 3).map((entry) => entry.id)).toEqual(["m1", "u1", "a1"]);
    expect(written.entries[3]).toMatchObject({ type: "session_info", name: "Parent task · fork" });
    expect(result).toMatchObject({
      agentId: "forked",
      title: "Parent task · fork",
      cwd,
      entries: 3,
      dropped: 2,
    });
  });

  it("rewinds to just before a chosen user message", async () => {
    const { paseo } = await makeAgent();
    const { calls, importSession } = recorder();

    const result = await createForkHandler({ importSession })(
      { agentId: "parent", messageId: "u2" },
      context(paseo),
    );

    // u2 ("second question") and a2 are dropped from the copy.
    expect(result.entries).toBe(3);
    expect(result.dropped).toBe(2);
    expect(calls[0].labels["real-fork.point"]).toBe("u2");
    const written = parseSession(await readFile(calls[0].sessionFile, "utf8"));
    expect(written.entries.slice(0, 3).map((entry) => entry.id)).toEqual(["m1", "u1", "a1"]);
    expect(written.entries).toHaveLength(4); // branch + session_info
  });

  it("refuses an assistant fork point without importing anything", async () => {
    const { paseo } = await makeAgent();
    const { calls, importSession } = recorder();

    await expect(
      createForkHandler({ importSession })({ agentId: "parent", messageId: "a1" }, context(paseo)),
    ).rejects.toThrow(/not a fork point/u);
    expect(calls).toHaveLength(0);
  });

  it("forks just after a completed tool batch, keeping the batch's results", async () => {
    const { paseo } = await makeAgent({ entries: TOOL_ENTRIES });
    const { calls, importSession } = recorder();

    const result = await createForkHandler({ importSession })(
      { agentId: "parent", messageId: "t2" },
      context(paseo),
    );

    // t2's batch (a1's bash + read, answered by t1 and t2) stays in the copy;
    // everything from a2 on is dropped with the parent's tail.
    expect(result.entries).toBe(5);
    expect(result.dropped).toBe(5);
    expect(calls[0].labels["real-fork.point"]).toBe("t2");
    const written = parseSession(await readFile(calls[0].sessionFile, "utf8"));
    expect(written.header.id).toBe(SESSION_ID);
    expect(written.entries.slice(0, 5).map((entry) => entry.id)).toEqual([
      "m1",
      "u1",
      "a1",
      "t1",
      "t2",
    ]);
    expect(written.entries[5]).toMatchObject({ type: "session_info", name: "Parent task · fork" });
  });

  it("refuses an aborted batch (a parallel result missing) without importing", async () => {
    const { paseo } = await makeAgent({ entries: ABORTED_BATCH_ENTRIES });
    const { calls, importSession } = recorder();

    // t1 answered only tc1; a1's tc2 is dangling, so a cut after t1 would
    // hand the provider a tool call with no result.
    await expect(
      createForkHandler({ importSession })({ agentId: "parent", messageId: "t1" }, context(paseo)),
    ).rejects.toThrow(/not a fork point/u);
    expect(calls).toHaveLength(0);
  });

  it("requires a fork point in the RPC input", () => {
    expect(forkRpc.input.safeParse({ agentId: "parent" }).success).toBe(false);
    expect(forkRpc.input.safeParse({ agentId: "parent", messageId: "u1" }).success).toBe(true);
  });

  it("cuts the mid-turn tail when forking at a user message", async () => {
    const { paseo } = await makeAgent({ entries: DANGLING_ENTRIES });
    const { calls, importSession } = recorder();

    const result = await createForkHandler({ importSession })(
      { agentId: "parent", messageId: "u1" },
      context(paseo),
    );

    // The cut drops the point and the dangling tail: the copy ends at the
    // model_change, before "first question".
    expect(result.entries).toBe(1);
    expect(result.dropped).toBe(3);
    expect(calls).toHaveLength(1);
  });

  it("propagates an import failure and archives the half-created workspace", async () => {
    let archived = 0;
    const { paseo } = await makeAgent({ onWorkspaceArchive: () => (archived += 1) });
    const importSession = async () => {
      throw new Error("paseo import failed: no such binary");
    };

    await expect(
      createForkHandler({ importSession })({ agentId: "parent", messageId: "u2" }, context(paseo)),
    ).rejects.toThrow(/import failed/u);
    expect(archived).toBe(1);
  });

  it("titles the fork after the parent exactly once", () => {
    expect(forkTitle("Parent task")).toBe("Parent task · fork");
    expect(forkTitle("Parent task · fork")).toBe("Parent task · fork");
    expect(forkTitle(null)).toBe("Agent · fork");
  });
});
