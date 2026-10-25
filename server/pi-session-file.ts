import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Locate the pi session file a Paseo agent is backed by.
 *
 * Paseo's pi provider records the JSONL path as `persistence.nativeHandle`
 * (pi resumes a session with `--session <file>`), which is all the plugin
 * needs. The id-based scan is the fallback for snapshots that were taken
 * before pi had written that handle.
 */

/** pi's sessions root: env override, else `~/.pi/agent/sessions`. */
export function piSessionsRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): string {
  const override = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (override) return expandTilde(override, homeDir);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const base = agentDir ? expandTilde(agentDir, homeDir) : path.join(homeDir, ".pi", "agent");
  return path.join(base, "sessions");
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

async function* walkSessionFiles(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSessionFiles(full, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

/** First line of a session file, parsed. Returns null for anything unreadable. */
async function readHeaderId(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, "utf8");
    const firstLine = text.split(/\r?\n/u, 1)[0]?.trim();
    if (!firstLine) return null;
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return record.type === "session" && typeof record.id === "string" ? record.id : null;
  } catch {
    return null;
  }
}

/** Find the session file whose header carries `sessionId`. */
export async function findSessionFileById(root: string, sessionId: string): Promise<string | null> {
  for await (const file of walkSessionFiles(root)) {
    const id = await readHeaderId(file);
    if (id === sessionId) return file;
  }
  return null;
}

export interface SessionHandle {
  sessionId?: string | null;
  nativeHandle?: string | null;
}

/** Resolve the pi session file for an agent, preferring the recorded handle. */
export async function resolveSessionFile(
  persistence: SessionHandle | null | undefined,
  options: { root?: string } = {},
): Promise<string> {
  const nativeHandle = persistence?.nativeHandle ?? null;
  if (nativeHandle && existsSync(nativeHandle)) return nativeHandle;
  const sessionId = persistence?.sessionId ?? null;
  if (!sessionId) {
    throw new Error("This agent has no pi session file yet");
  }
  const found = await findSessionFileById(options.root ?? piSessionsRoot(), sessionId);
  if (!found) {
    throw new Error(`Could not find the pi session file for session ${sessionId}`);
  }
  return found;
}

/** Write a session file in place (the caller restarts the provider afterwards). */
export async function replaceSessionFile(file: string, text: string): Promise<void> {
  await writeFile(file, text, "utf8");
}
