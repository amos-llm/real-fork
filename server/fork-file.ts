import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionInfoEntry, type PiSessionEntry, type PiSessionHeader } from "./pi-session";

/**
 * Writes the artifact a fork hands to Paseo: a pi session file holding the
 * branch up to the fork point, with the source header's **session id kept**. The
 * id is the provider cache key (pi sends it as `prompt_cache_key`), so a fork
 * that keeps it repeats the source prefix under the same key and the cache
 * answers the first turn. A fresh id re-prefills the whole branch.
 */

export const FORK_DIR = path.join(".pi", "forks");

export interface ForkFile {
  path: string;
  header: PiSessionHeader;
  entries: PiSessionEntry[];
}

/** `<cwd>/.pi/forks/<ts>_<suffix>.jsonl` — inside pi's own `<cwd>/.pi` area. */
export function forkFilePath(cwd: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  return path.join(cwd, FORK_DIR, `${stamp}_${suffix}.jsonl`);
}

/**
 * The fork file for one branch. The header keeps the source's id so the provider
 * cache key stays the same; only `parentSession` records where it came from.
 */
export function buildForkFile(input: {
  sourceFile: string;
  header: PiSessionHeader;
  branch: readonly PiSessionEntry[];
  title?: string | null;
}): { header: PiSessionHeader; entries: PiSessionEntry[] } {
  const header: PiSessionHeader = { ...input.header, parentSession: input.sourceFile };
  const entries = [...input.branch];
  const title = input.title?.trim();
  if (title) {
    const parentId = entries.at(-1)?.id ?? null;
    entries.push(sessionInfoEntry(title, parentId));
  }
  return { header, entries };
}

export async function writeForkFile(
  file: ForkFile,
  render: (header: PiSessionHeader, entries: readonly PiSessionEntry[]) => string,
): Promise<void> {
  await mkdir(path.dirname(file.path), { recursive: true });
  await writeFile(file.path, render(file.header, file.entries), "utf8");
}
