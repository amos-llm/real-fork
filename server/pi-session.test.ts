import { describe, expect, it } from "vitest";
import {
  activeBranch,
  branchPoints,
  forkHeader,
  messagePreview,
  parseSession,
  renderSession,
  sliceBranch,
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
