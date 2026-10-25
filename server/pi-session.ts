/**
 * Pure pi session-file logic: parse a JSONL session, follow the active branch,
 * cut it just before a user message, and render a new file. No Paseo or
 * provider calls live here, so the whole fork shape is unit-testable.
 *
 * A pi session file is one JSON object per line:
 *
 *   {"type":"session","version":3,"id":"…","timestamp":"…","cwd":"…"}   ← header
 *   {"type":"model_change","id":"…","parentId":null,"provider":"…"}     ← entries
 *   {"type":"message","id":"…","parentId":"…","message":{"role":"user","content":…}}
 *
 * Entries form a tree through `parentId`; the active branch is what pi sends to
 * the model. Copying that branch verbatim keeps the provider prompt prefix
 * identical to the source session, and keeping the header id keeps the provider
 * cache key identical too, which is what lets the cache answer the fork's first
 * turn.
 */

import { randomUUID } from "node:crypto";

export type PiSessionEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
};

export type PiSessionHeader = PiSessionEntry & {
  type: "session";
  id?: string;
  cwd?: string;
  version?: number;
  parentSession?: string;
};

export interface ParsedSession {
  header: PiSessionHeader;
  entries: PiSessionEntry[];
}

export interface BranchPoint {
  entry: PiSessionEntry;
  /** How many entries a fork at this point keeps — everything before it. */
  entries: number;
}

export interface BranchSlice {
  /** Branch entries kept by the fork: root up to (not including) the point. */
  branch: PiSessionEntry[];
  /** The user message the fork was taken at; deliberately kept out of the copy. */
  point: PiSessionEntry;
  /** Entries dropped from the point on, including the point itself. */
  dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEntry(value: unknown): PiSessionEntry | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  return value as PiSessionEntry;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n\n");
}

/** Parse a session file body. Invalid lines are skipped, like pi's own reader. */
export function parseSession(text: string): ParsedSession {
  const entries: PiSessionEntry[] = [];
  let header: PiSessionHeader | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = asEntry(parsed);
    if (!entry) continue;
    if (entry.type === "session") {
      header ??= entry as PiSessionHeader;
      continue;
    }
    entries.push(entry);
  }
  if (!header) {
    throw new Error("Not a pi session file: no session header");
  }
  return { header, entries };
}

/**
 * The branch pi would load: root → leaf, following `parentId` from the last
 * entry in the file. Entries that point at a missing parent stop the walk
 * instead of resurrecting an unrelated branch.
 */
export function activeBranch(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  let cursor: PiSessionEntry | undefined = entries.at(-1);
  const path: PiSessionEntry[] = [];
  const seen = new Set<string>();
  while (cursor) {
    const id = cursor.id;
    if (id !== undefined) {
      if (seen.has(id)) break;
      seen.add(id);
    }
    path.push(cursor);
    const parentId = cursor.parentId;
    cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return path.toReversed();
}

/** One-line preview of a message entry's text. */
export function messagePreview(entry: PiSessionEntry, limit = 140): string {
  const text = textOf(entry.message?.content).trim().replace(/\s+/gu, " ");
  if (!text) return "(no text)";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * User messages on a branch, newest first. `entries` is the size of the
 * session a fork at that point would keep — everything before the message.
 */
export function branchPoints(branch: readonly PiSessionEntry[]): BranchPoint[] {
  const points: BranchPoint[] = [];
  branch.forEach((entry, index) => {
    if (entry.type !== "message") return;
    if (entry.message?.role !== "user") return;
    if (!textOf(entry.message.content).trim()) return;
    points.push({ entry, entries: index });
  });
  return points.toReversed();
}

/**
 * Cut the branch so it ends just before `messageId`. Returns null when that
 * entry is not a user message on the branch — Paseo's own message ids for
 * assistant rows are provider-derived, so a fork point must be anchored to a
 * user message. The point itself is dropped: the fork exists to rewrite that
 * message, so the copy ends on the settled state right before it.
 */
export function sliceBranch(
  branch: readonly PiSessionEntry[],
  messageId: string,
): BranchSlice | null {
  const index = branch.findIndex((entry) => entry.id === messageId);
  if (index < 0) return null;
  const point = branch[index];
  if (point.type !== "message" || point.message?.role !== "user") return null;
  return {
    branch: branch.slice(0, index),
    point,
    dropped: branch.length - index,
  };
}

/** Header to write for the fork: the new session's identity, source recorded. */
export function forkHeader(header: PiSessionHeader, parentSession: string): PiSessionHeader {
  return { ...header, type: "session", parentSession };
}

/**
 * A `session_info` entry, which pi renders as the session name and never sends to
 * the model — so naming a fork costs no context.
 */
export function sessionInfoEntry(name: string, parentId: string | null): PiSessionEntry {
  const sanitized = name.replace(/[\r\n]+/gu, " ").trim();
  return {
    type: "session_info",
    id: randomSessionEntryId(),
    parentId,
    timestamp: new Date().toISOString(),
    name: sanitized,
  };
}

/** pi entry ids are short hex strings; only uniqueness within the file matters. */
export function randomSessionEntryId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/** Serialize a session file: one JSON object per line, header first. */
export function renderSession(header: PiSessionHeader, entries: readonly PiSessionEntry[]): string {
  const lines = [JSON.stringify(header)];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}
