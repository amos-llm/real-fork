import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createForkHandler, createForkPointsHandler, forkTitle } from "./fork-agent";
import { FORK_DIR } from "./fork-file";
import { parseSession, type PiSessionEntry } from "./pi-session";

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

const SOURCE_ENTRIES: PiSessionEntry[] = [
  { type: "model_change", id: "m1", parentId: null, provider: "opencode-go", modelId: "m" },
  message("u1", "m1", "user", "first question"),
  message("a1", "u1", "assistant", "first answer"),
  message("u2", "a1", "user", "second question"),
  message("a2", "u2", "assistant", "second answer"),
];

interface StubOptions {
  provider?: string;
  title?: string | null;
}

/**
 * A source agent in a throwaway cwd: the fork writes into `<cwd>/.pi/forks`, so
 * the workspace has to be writable for the test.
 */
async function makeAgent(options: StubOptions = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "real-fork-cwd-"));
  const sourceFile = path.join(cwd, "session.jsonl");
  const lines = [header(cwd), ...SOURCE_ENTRIES];
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
  } as unknown as PaseoApi;
  return { cwd, sourceFile, paseo };
}

interface ImportCall {
  sessionFile: string;
  cwd: string;
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
    expect(result.points[0].entries).toBe(4);
    expect(result.branchEntries).toBe(5);
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
      { agentId: "parent" },
      context(paseo),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cwd).toBe(cwd);
    expect(call.title).toBe("Parent task · fork");
    expect(call.labels).toEqual({ "real-fork.source": "parent", "real-fork.point": "a2" });
    // The fork file lives in the workspace's own `.pi` area, not in pi's session list.
    expect(call.sessionFile.startsWith(path.join(cwd, FORK_DIR))).toBe(true);

    const written = parseSession(await readFile(call.sessionFile, "utf8"));
    // The cache key is the header id, so the fork must keep the source's.
    expect(written.header.id).toBe(SESSION_ID);
    expect(written.header.parentSession).toBe(sourceFile);
    // Every copied entry stays in order, and the fork is named after the parent.
    expect(written.entries.slice(0, 5).map((entry) => entry.id)).toEqual([
      "m1",
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(written.entries[5]).toMatchObject({ type: "session_info", name: "Parent task · fork" });
    expect(result).toMatchObject({
      agentId: "forked",
      title: "Parent task · fork",
      cwd,
      entries: 5,
      dropped: 0,
    });
  });

  it("rewinds to just before a chosen user message", async () => {
    const { paseo } = await makeAgent();
    const { calls, importSession } = recorder();

    const result = await createForkHandler({ importSession })(
      { agentId: "parent", messageId: "u2" },
      context(paseo),
    );

    expect(result.entries).toBe(4);
    expect(result.dropped).toBe(1);
    expect(calls[0].labels["real-fork.point"]).toBe("u2");
    const written = parseSession(await readFile(calls[0].sessionFile, "utf8"));
    expect(written.entries.slice(0, 4).map((entry) => entry.id)).toEqual(["m1", "u1", "a1", "u2"]);
    expect(written.entries).toHaveLength(5); // branch + session_info
  });

  it("refuses an assistant fork point without importing anything", async () => {
    const { paseo } = await makeAgent();
    const { calls, importSession } = recorder();

    await expect(
      createForkHandler({ importSession })({ agentId: "parent", messageId: "a1" }, context(paseo)),
    ).rejects.toThrow(/not a user message/u);
    expect(calls).toHaveLength(0);
  });

  it("propagates an import failure", async () => {
    const { paseo } = await makeAgent();
    const importSession = async () => {
      throw new Error("paseo import failed: no such binary");
    };

    await expect(
      createForkHandler({ importSession })({ agentId: "parent" }, context(paseo)),
    ).rejects.toThrow(/import failed/u);
  });

  it("titles the fork after the parent exactly once", () => {
    expect(forkTitle("Parent task")).toBe("Parent task · fork");
    expect(forkTitle("Parent task · fork")).toBe("Parent task · fork");
    expect(forkTitle(null)).toBe("Agent · fork");
  });
});
