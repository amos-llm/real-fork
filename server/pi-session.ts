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
  message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string };
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
  /** How many entries a fork at this point keeps — everything up to the cut. */
  entries: number;
  /** Tool names of the completed batch, for after-tool-call points. */
  toolNames?: readonly string[];
  /**
   * For single-call batches: the call's key argument (bash command, file
   * path, …), so the picker row says *which* call it is.
   */
  detail?: string;
}

export interface BranchSlice {
  /** Branch entries kept by the fork: root up to the cut. */
  branch: PiSessionEntry[];
  /**
   * The anchor entry. A user message is cut just before, so it is kept out of
   * the copy (the fork rewrites it); a tool result is cut just after, so it is
   * the last entry kept.
   */
  point: PiSessionEntry;
  /** Entries dropped from the cut on. */
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

/** "bash" / "bash · read" / "bash · read · read (+2)": one label for a tool batch. */
export function toolBatchPreview(toolNames: readonly string[], limit = 3): string {
  if (toolNames.length === 0) return "(tool call)";
  const shown = toolNames.slice(0, limit).join(" · ");
  const rest = toolNames.length - limit;
  return rest > 0 ? `${shown} (+${rest})` : shown;
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
 * The batch a tool result belongs to: the run of consecutive results ending
 * at `index`, and the assistant message that issued them. `complete` is true
 * when every call that assistant issued has a result in the run — a cut just
 * after `index` then leaves a resumable state (pi's own steering produces the
 * same `…assistant(toolCall) → toolResult` shape), while a missing result
 * would dangle a tool call the provider rejects. Returns null when the run is
 * not anchored by an assistant message that issued tool calls.
 */
function toolBatchAt(
  branch: readonly PiSessionEntry[],
  index: number,
  strip?: string,
): { entry: PiSessionEntry; toolNames: string[]; detail?: string; complete: boolean } | null {
  const entry = branch[index];
  if (entry?.type !== "message" || entry.message?.role !== "toolResult") return null;
  const resultIds = new Set<string>();
  const toolNames: string[] = [];
  let j = index;
  for (;;) {
    const item = branch[j];
    if (item?.type !== "message" || item.message?.role !== "toolResult") break;
    const callId = item.message?.toolCallId;
    if (typeof callId === "string" && callId) resultIds.add(callId);
    const name = item.message?.toolName;
    if (typeof name === "string" && name.trim()) toolNames.unshift(name);
    j--;
  }
  const assistant = branch[j];
  if (assistant?.type !== "message" || assistant.message?.role !== "assistant") return null;
  const content = Array.isArray(assistant.message.content) ? assistant.message.content : [];
  const parts = content.filter((part): part is Record<string, unknown> => isRecord(part));
  const issued = parts
    .filter((part) => part.type === "toolCall")
    .map((part) => part.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const complete = issued.length > 0 && issued.every((id) => resultIds.has(id));
  // A single-call batch gets the call's key argument in its label, so the
  // picker row identifies *which* call it is, not just the tool name.
  let detail: string | undefined;
  if (complete && issued.length === 1) {
    const callPart = parts.find((part) => part.type === "toolCall" && part.id === issued[0]);
    const name = typeof callPart?.name === "string" ? callPart.name : "";
    detail = toolCallDetail(name, callPart?.arguments, strip) || undefined;
  }
  return { entry, toolNames, detail, complete };
}

/** The one argument that says what a call did: command, path, query, code… */
function toolCallDetail(name: string, args: unknown, strip?: string): string {
  if (!isRecord(args)) return "";
  const keys =
    name === "bash"
      ? ["command"]
      : name === "read" || name === "edit" || name === "write"
        ? ["path"]
        : name === "web_search"
          ? ["query"]
          : name === "codemode"
            ? ["code"]
            : ["command", "path", "query", "url", "code"];
  let detail = "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      detail = value;
      break;
    }
  }
  // File paths shorter relative to the session's cwd; commands without their
  // `cd <dir> &&` preamble — the leading context eats the useful part.
  if (
    (name === "read" || name === "edit" || name === "write") &&
    strip &&
    detail.startsWith(strip)
  ) {
    detail = detail.slice(strip.length);
  }
  if (name === "bash") {
    const cd = detail.match(/^cd \S+ && /u);
    if (cd) detail = detail.slice(cd[0].length);
  }
  const oneLine = detail.replace(/\s+/gu, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48).trimEnd()}…` : oneLine;
}

/**
 * After-tool-call points on a branch, newest first: one per completed tool
 * batch — the cut right after the batch's last tool result. "Completed" means
 * every call the batch's assistant message issued has its result before the
 * cut, so the fork's first message lands on the state pi's own steering
 * produces (`…toolResult → user`). A batch may also end the branch — a turn
 * interrupted after its last tool call is forkable the same way.
 * The anchor is the batch's last tool result; `entries` is the cut size.
 */
export function toolBatchPoints(branch: readonly PiSessionEntry[], strip?: string): BranchPoint[] {
  const points: BranchPoint[] = [];
  for (let i = 0; i < branch.length; i++) {
    const batch = toolBatchAt(branch, i, strip);
    if (!batch || !batch.complete) continue;
    points.push({
      entry: batch.entry,
      entries: i + 1,
      toolNames: batch.toolNames,
      ...(batch.detail ? { detail: batch.detail } : {}),
    });
  }
  return points.toReversed();
}

/**
 * Cut the branch at `messageId`, which must be a fork point on the branch.
 * A user message is cut just before: the point is dropped because the fork
 * rewrites it, so the copy ends on the settled state right before it. A tool
 * result is cut just after — but only when its batch is complete (every call
 * it issued has a result before the cut) — and the copy keeps the result, so
 * the fork redirects the turn from there. Anything else — including assistant
 * entries, whose Paseo ids are provider-derived — is not an anchor.
 */
export function sliceBranch(
  branch: readonly PiSessionEntry[],
  messageId: string,
): BranchSlice | null {
  const index = branch.findIndex((entry) => entry.id === messageId);
  if (index < 0) return null;
  const point = branch[index];
  if (point.type !== "message") return null;
  if (point.message?.role === "user") {
    return {
      branch: branch.slice(0, index),
      point,
      dropped: branch.length - index,
    };
  }
  if (point.message?.role === "toolResult") {
    const batch = toolBatchAt(branch, index);
    if (!batch || !batch.complete) return null;
    return {
      branch: branch.slice(0, index + 1),
      point,
      dropped: branch.length - (index + 1),
    };
  }
  return null;
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
