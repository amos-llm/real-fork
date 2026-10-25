/** Display helpers for the fork-point picker. Pure, so they are unit-tested. */

export function fmtAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso || now <= 0) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function fmtEntries(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

/** "12 entries · 3m ago" — the context size and age of one fork point. */
export function fmtPointMeta(entries: number, at: string | null, now: number = Date.now()): string {
  const ago = fmtAgo(at, now);
  const size = fmtEntries(entries);
  return ago ? `${size} · ${ago}` : size;
}
