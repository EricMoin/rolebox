import { describe, it, expect } from "bun:test";
import {
  formatDuration,
  compactDuration,
  truncate,
  shortSessionId,
  barSegments,
  statusGlyph,
} from "../../src/utils/display-helpers";

// ── formatDuration ─────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns '?' for NaN", () => {
    expect(formatDuration(NaN)).toBe("?");
  });

  it("returns '?' for Infinity", () => {
    expect(formatDuration(Infinity)).toBe("?");
  });

  it("returns '?' for negative values", () => {
    expect(formatDuration(-1)).toBe("?");
  });

  it("returns raw ms when < 1000", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("returns seconds when < 60000", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59999)).toBe("59s");
  });

  it("returns minutes with optional seconds when >= 60000", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(120000)).toBe("2m");
    expect(formatDuration(61000)).toBe("1m 1s");
    expect(formatDuration(3661000)).toBe("61m 1s");
  });
});

// ── compactDuration ────────────────────────────────────────────────────────

describe("compactDuration", () => {
  it("returns '0s' for zero", () => {
    expect(compactDuration(0)).toBe("0s");
  });

  it("returns '0s' for negative", () => {
    expect(compactDuration(-100)).toBe("0s");
  });

  it("returns raw ms when < 1000", () => {
    expect(compactDuration(500)).toBe("500ms");
  });

  it("returns seconds when < 60000", () => {
    expect(compactDuration(1500)).toBe("1s");
    expect(compactDuration(59999)).toBe("59s");
  });

  it("returns compact minutes when >= 60000", () => {
    expect(compactDuration(60000)).toBe("1m");
    expect(compactDuration(3661000)).toBe("61m");
  });
});

// ── truncate ───────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns the string unchanged when shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when equal to maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis when longer than maxLen", () => {
    expect(truncate("hello", 3)).toBe("he\u2026");
  });

  it("handles maxLen=1 (only ellipsis fits)", () => {
    expect(truncate("hello", 1)).toBe("\u2026");
  });
});

// ── shortSessionId ─────────────────────────────────────────────────────────

describe("shortSessionId", () => {
  it("returns short IDs (≤12 chars) unchanged", () => {
    expect(shortSessionId("abc")).toBe("abc");
    expect(shortSessionId("abcdefghijkl")).toBe("abcdefghijkl");
  });

  it("ellipsis-prefixes last 8 chars for 13-14 char IDs", () => {
    // 13 chars: shows … + last 8 = …fghijklm
    expect(shortSessionId("abcdefghijklm")).toBe("\u2026fghijklm");
    // 14 chars: shows … + last 8 = …ghijklmn
    expect(shortSessionId("abcdefghijklmn")).toBe("\u2026ghijklmn");
  });

  it("strips ses_ prefix and shows first3…last5 for long IDs", () => {
    // "ses_abcdefghijk123" length = 18 ≥ 15
    const result = shortSessionId("ses_abcdefghijk123");
    // stripped = "abcdefghijk123", first3 = "abc", last5 = "jk123"
    expect(result).toBe("abc\u2026jk123");
  });

  it("shows first3…last5 for long IDs without ses_ prefix", () => {
    // "abcdefghijklmno" length = 15 ≥ 15
    const result = shortSessionId("abcdefghijklmno");
    // first3 = "abc", last5 = "klmno"
    expect(result).toBe("abc\u2026klmno");
  });
});

// ── barSegments ────────────────────────────────────────────────────────────

describe("barSegments", () => {
  it("returns all empty when total is 0", () => {
    expect(barSegments(0, 0)).toEqual({ filled: 0, empty: 6 });
    expect(barSegments(5, 0)).toEqual({ filled: 0, empty: 6 });
  });

  it("returns all empty at 0% progress", () => {
    expect(barSegments(0, 10)).toEqual({ filled: 0, empty: 6 });
  });

  it("returns partial fill at 50% progress", () => {
    expect(barSegments(5, 10)).toEqual({ filled: 3, empty: 3 });
  });

  it("returns full bar at 100% progress", () => {
    expect(barSegments(10, 10)).toEqual({ filled: 6, empty: 0 });
  });

  it("caps at full bar when current exceeds total", () => {
    expect(barSegments(20, 10)).toEqual({ filled: 6, empty: 0 });
  });

  it("accepts a custom width", () => {
    expect(barSegments(3, 4, 8)).toEqual({ filled: 6, empty: 2 });
  });
});

// ── statusGlyph ────────────────────────────────────────────────────────────

describe("statusGlyph", () => {
  it('returns ▸ for "running"', () => {
    expect(statusGlyph("running")).toBe("\u25b8");
  });

  it('returns ✓ for "completed"', () => {
    expect(statusGlyph("completed")).toBe("\u2713");
  });

  it('returns ✗ for "error"', () => {
    expect(statusGlyph("error")).toBe("\u2717");
  });

  it('returns ● for "pending"', () => {
    expect(statusGlyph("pending")).toBe("\u25cf");
  });

  it('returns ⊘ for "cancelled"', () => {
    expect(statusGlyph("cancelled")).toBe("\u2298");
  });

  it('returns ⏱ for "timeout"', () => {
    expect(statusGlyph("timeout")).toBe("\u23f1");
  });

  it('returns "?" for unknown statuses', () => {
    expect(statusGlyph("unknown")).toBe("?");
    expect(statusGlyph("foobar")).toBe("?");
    expect(statusGlyph("")).toBe("?");
  });
});
