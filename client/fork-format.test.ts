import { describe, expect, it } from "vitest";
import { fmtAgo, fmtEntries, fmtPointMeta } from "./fork-format";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

describe("fmtAgo", () => {
  it("formats minutes, hours and days", () => {
    expect(fmtAgo("2026-01-01T11:59:30.000Z", NOW)).toBe("just now");
    expect(fmtAgo("2026-01-01T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(fmtAgo("2026-01-01T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(fmtAgo("2025-12-29T12:00:00.000Z", NOW)).toBe("3d ago");
  });

  it("returns an empty string for missing or invalid timestamps", () => {
    expect(fmtAgo(null, NOW)).toBe("");
    expect(fmtAgo("not a date", NOW)).toBe("");
    // A query that has not delivered yet reports 0 as its update time.
    expect(fmtAgo("2026-01-01T11:55:00.000Z", 0)).toBe("");
  });
});

describe("fmtEntries", () => {
  it("pluralizes", () => {
    expect(fmtEntries(1)).toBe("1 entry");
    expect(fmtEntries(42)).toBe("42 entries");
  });
});

describe("fmtPointMeta", () => {
  it("joins size and age", () => {
    expect(fmtPointMeta(7, "2026-01-01T11:55:00.000Z", NOW)).toBe("7 entries · 5m ago");
    expect(fmtPointMeta(7, null, NOW)).toBe("7 entries");
  });
});
