import { describe, expect, it } from "vitest";
import {
  activeBranch,
  branchPoints,
  forkHeader,
  messagePreview,
  parseSession,
  renderSession,
  sliceBranch,
  toolBatchPoints,
  toolBatchPreview,
  type PiSessionEntry,
} from "./pi-session";

const header = {
  type: "session" as const,
  version: 3,
  id: "session-a",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/home/user/project",
};

function entry(overrides: Partial<PiSessionEntry> & { type: string }): PiSessionEntry {
  return overrides as PiSessionEntry;
}

const user = (id: string, parentId: string | null, text: string): PiSessionEntry =>
  entry({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const assistant = (id: string, parentId: string | null, text: string): PiSessionEntry =>
  entry({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

/** An assistant message issuing `calls` = [toolCallId, toolName, args?], in order. */
const assistantToolCall = (
  id: string,
  parentId: string | null,
  calls: ReadonlyArray<readonly [string, string, Record<string, unknown>?]>,
): PiSessionEntry =>
  entry({
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: calls.map(([callId, name, args = {}]) => ({
        type: "toolCall",
        id: callId,
        name,
        arguments: args,
      })),
    },
  });

const toolResult = (
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
): PiSessionEntry =>
  entry({
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [] },
  });

const sessionText = (...entries: PiSessionEntry[]): string =>
  [JSON.stringify(header), ...entries.map((item) => JSON.stringify(item))].join("\n");

describe("parseSession", () => {
  it("splits the header from the entries and skips broken lines", () => {
    const text = `${sessionText(user("u1", null, "hi"))}\nnot json\n\n`;
    const parsed = parseSession(text);
    expect(parsed.header.id).toBe("session-a");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe("u1");
  });

  it("rejects files without a session header", () => {
    expect(() => parseSession(JSON.stringify(user("u1", null, "hi")))).toThrow(/session header/u);
  });
});

describe("activeBranch", () => {
  it("follows parentId from the last entry instead of file order", () => {
    const entries = [
      user("u1", null, "first"),
      assistant("a1", "u1", "answer"),
      user("u2", "a1", "second"),
      // A sibling branch: appended later, but not the active leaf's ancestor.
      assistant("a2-other", "u1", "abandoned"),
      assistant("a2", "u2", "answer two"),
    ];
    const branch = activeBranch(entries);
    expect(branch.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("stops when a parent is missing instead of jumping branches", () => {
    const branch = activeBranch([user("u1", null, "first"), assistant("a1", "missing", "answer")]);
    expect(branch.map((item) => item.id)).toEqual(["a1"]);
  });
});

describe("branchPoints", () => {
  it("lists user messages newest first with the entries a fork there would keep", () => {
    const branch = activeBranch([
      user("u1", null, "first"),
      assistant("a1", "u1", "answer"),
      user("u2", "a1", "second"),
    ]);
    const points = branchPoints(branch);
    expect(points.map((point) => point.entry.id)).toEqual(["u2", "u1"]);
    // Fork at u2 keeps [u1, a1]; fork at u1 (the first entry) keeps nothing.
    expect(points.map((point) => point.entries)).toEqual([2, 0]);
  });

  it("skips empty user messages", () => {
    const branch = activeBranch([user("u1", null, "   "), user("u2", "u1", "real")]);
    expect(branchPoints(branch).map((point) => point.entry.id)).toEqual(["u2"]);
  });
});

/**
 * u1 → a1 (bash + read, parallel) → t1 → t2 → a2 → u2 → a3 (bash) → t3 → a4.
 */
const TOOL_BRANCH: PiSessionEntry[] = [
  user("u1", null, "first"),
  assistantToolCall("a1", "u1", [
    ["tc1", "bash"],
    ["tc2", "read"],
  ]),
  toolResult("t1", "a1", "tc1", "bash"),
  toolResult("t2", "t1", "tc2", "read"),
  assistant("a2", "t2", "answer"),
  user("u2", "a2", "second"),
  assistantToolCall("a3", "u2", [["tc3", "bash"]]),
  toolResult("t3", "a3", "tc3", "bash"),
  assistant("a4", "t3", "answer two"),
];

describe("toolBatchPoints", () => {
  it("lists completed batches newest first, anchored at the batch's last result", () => {
    const points = toolBatchPoints(activeBranch(TOOL_BRANCH));
    expect(points.map((point) => point.entry.id)).toEqual(["t3", "t2"]);
    // Fork at t3 keeps u1..t3 (8); at t2 it keeps u1..t2 (4).
    expect(points.map((point) => point.entries)).toEqual([8, 4]);
    expect(points[1].toolNames).toEqual(["bash", "read"]);
    expect(points[0].toolNames).toEqual(["bash"]);
  });

  it("never offers a mid-batch result of a parallel batch", () => {
    const points = toolBatchPoints(activeBranch(TOOL_BRANCH));
    // t1's result comes before t2's; the batch completes only at t2.
    expect(points.some((point) => point.entry.id === "t1")).toBe(false);
  });

  it("offers a complete batch even when it ends the branch (turn interrupted)", () => {
    const branch = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [["tc1", "bash"]]),
      toolResult("t1", "a1", "tc1", "bash"),
    ]);
    const points = toolBatchPoints(branch);
    expect(points.map((point) => point.entry.id)).toEqual(["t1"]);
    expect(points[0].entries).toBe(3);
  });

  it("refuses an aborted batch whose parallel result is missing", () => {
    const branch = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [
        ["tc1", "bash"],
        ["tc2", "read"],
      ]),
      toolResult("t1", "a1", "tc1", "bash"),
    ]);
    expect(toolBatchPoints(branch)).toEqual([]);
  });

  it("carries the call's key argument for single-call batches", () => {
    const branch = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [["tc1", "bash", { command: "rg -n steering dist/" }]]),
      toolResult("t1", "a1", "tc1", "bash"),
      assistant("a2", "t1", "answer"),
    ]);
    const [point] = toolBatchPoints(branch);
    expect(point.toolNames).toEqual(["bash"]);
    expect(point.detail).toBe("rg -n steering dist/");
  });

  it("truncates long details and keeps parallel batches to names", () => {
    const long = `x ${"y".repeat(80)}`;
    const single = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [["tc1", "bash", { command: long }]]),
      toolResult("t1", "a1", "tc1", "bash"),
      assistant("a2", "t1", "answer"),
    ]);
    expect(toolBatchPoints(single)[0].detail).toBe(`x ${"y".repeat(46)}…`);

    const parallel = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [
        ["tc1", "bash", { command: "a" }],
        ["tc2", "read", { path: "/tmp/x" }],
      ]),
      toolResult("t1", "a1", "tc1", "bash"),
      toolResult("t2", "t1", "tc2", "read"),
      assistant("a2", "t2", "answer"),
    ]);
    expect(toolBatchPoints(parallel)[0].detail).toBeUndefined();
  });

  it("shortens cwd-relative paths and drops cd preambles", () => {
    const editBranch = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [["tc1", "edit", { path: "/home/proj/server/x.ts" }]]),
      toolResult("t1", "a1", "tc1", "edit"),
      assistant("a2", "t1", "answer"),
    ]);
    expect(toolBatchPoints(editBranch, "/home/proj/")[0].detail).toBe("server/x.ts");

    const bashBranch = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [
        ["tc1", "bash", { command: "cd /home/proj && npm run check" }],
      ]),
      toolResult("t1", "a1", "tc1", "bash"),
      assistant("a2", "t1", "answer"),
    ]);
    expect(toolBatchPoints(bashBranch)[0].detail).toBe("npm run check");
  });

  it("offers nothing for a settled conversation without tool calls", () => {
    const branch = activeBranch([user("u1", null, "first"), assistant("a1", "u1", "answer")]);
    expect(toolBatchPoints(branch)).toEqual([]);
  });
});

describe("toolBatchPreview", () => {
  it("labels a single call and joins batches", () => {
    expect(toolBatchPreview(["bash"])).toBe("bash");
    expect(toolBatchPreview(["bash", "read"])).toBe("bash · read");
  });

  it("caps long batches and reports the rest", () => {
    expect(toolBatchPreview(["a", "b", "c", "d", "e"])).toBe("a · b · c (+2)");
  });

  it("labels batches without names", () => {
    expect(toolBatchPreview([])).toBe("(tool call)");
  });
});

describe("sliceBranch", () => {
  const branch = activeBranch([
    user("u1", null, "first"),
    assistant("a1", "u1", "answer"),
    user("u2", "a1", "second"),
    assistant("a2", "u2", "answer two"),
  ]);

  it("cuts just before a user message and counts what the parent keeps", () => {
    const slice = sliceBranch(branch, "u2");
    expect(slice?.branch.map((item) => item.id)).toEqual(["u1", "a1"]);
    expect(slice?.point.id).toBe("u2");
    expect(slice?.dropped).toBe(2);
  });

  it("keeps nothing when forking at the first branch entry", () => {
    const slice = sliceBranch(branch, "u1");
    expect(slice?.branch).toEqual([]);
    expect(slice?.dropped).toBe(4);
  });

  it("refuses assistant messages as fork points", () => {
    expect(sliceBranch(branch, "a1")).toBeNull();
  });

  it("refuses ids that are not on the branch", () => {
    expect(sliceBranch(branch, "nope")).toBeNull();
  });
});

describe("sliceBranch with tool anchors", () => {
  const branch = activeBranch(TOOL_BRANCH);

  it("cuts just after a completed batch, keeping the batch's results", () => {
    const slice = sliceBranch(branch, "t2");
    expect(slice?.branch.map((item) => item.id)).toEqual(["u1", "a1", "t1", "t2"]);
    expect(slice?.point.id).toBe("t2");
    expect(slice?.dropped).toBe(5); // a2, u2, a3, t3, a4
  });

  it("refuses a mid-batch result while a parallel call is pending", () => {
    expect(sliceBranch(branch, "t1")).toBeNull();
  });

  it("refuses an aborted batch whose parallel result is missing", () => {
    const aborted = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [
        ["tc1", "bash"],
        ["tc2", "read"],
      ]),
      toolResult("t1", "a1", "tc1", "bash"),
    ]);
    expect(sliceBranch(aborted, "t1")).toBeNull();
  });

  it("accepts a complete batch that ends the branch (turn interrupted)", () => {
    const interrupted = activeBranch([
      user("u1", null, "first"),
      assistantToolCall("a1", "u1", [["tc1", "bash"]]),
      toolResult("t1", "a1", "tc1", "bash"),
    ]);
    const slice = sliceBranch(interrupted, "t1");
    expect(slice?.branch.map((item) => item.id)).toEqual(["u1", "a1", "t1"]);
    expect(slice?.dropped).toBe(0);
  });
});

describe("messagePreview", () => {
  it("collapses whitespace and truncates", () => {
    const long = `line one\n\n  line two ${"x".repeat(200)}`;
    const preview = messagePreview(user("u1", null, long), 40);
    expect(preview.startsWith("line one line two")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBe(41);
  });

  it("labels messages without text", () => {
    expect(messagePreview(entry({ type: "message", message: { role: "user", content: [] } }))).toBe(
      "(no text)",
    );
  });
});

describe("renderSession", () => {
  it("writes the header first and points it at the source session", () => {
    const branch = activeBranch([user("u1", null, "first"), assistant("a1", "u1", "answer")]);
    const text = renderSession(forkHeader(header, "/tmp/source.jsonl"), branch);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = parseSession(text);
    expect(parsed.header.id).toBe("session-a");
    expect(parsed.header.parentSession).toBe("/tmp/source.jsonl");
    expect(parsed.entries.map((item) => item.id)).toEqual(["u1", "a1"]);
    // Entries keep their original parent links, so pi's tree stays intact.
    expect(parsed.entries[1].parentId).toBe("u1");
  });
});
