/**
 * Regression tests for the canonical text/number formatting module.
 *
 * Every value marked "pinned" in the module brief is asserted here, plus the
 * hardening cases (non-finite input, surrogate pairs, ZWJ sequences, CJK/ANSI
 * width, markdown-cell escaping, zero-total progress bars, locale independence).
 */
import { describe, it, expect } from "bun:test";
import {
  formatDuration,
  formatTimestamp,
  formatRelativeTime,
  formatBytes,
  formatCount,
  stripAnsi,
  displayWidth,
  truncateText,
  padDisplayEnd,
  padDisplayStart,
  escapeMarkdownTableCell,
  renderMarkdownTable,
  progressBarParts,
  progressBar,
} from "../../src/utils/text-format.ts";
import type { DurationStyle } from "../../src/utils/text-format.ts";

const DURATION_STYLES: readonly DurationStyle[] = [
  "clock",
  "monitor",
  "narrow",
  "decimal",
  "stall",
  "largest",
];

const ESC = "\u001b";
const BEL = "\u0007";

/** True when the string contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ── formatDuration ──────────────────────────────────────────────────────────

describe("formatDuration — clock (default)", () => {
  it("is the default style", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(42_000)).toBe(formatDuration(42_000, "clock"));
  });

  it("matches the pinned values", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [0, "0s"],
      [999, "0s"],
      [42_000, "42s"],
      [60_000, "1m 0s"],
      [65_000, "1m 5s"],
      [3_599_000, "59m 59s"],
      [3_600_000, "1h 0m"],
      [7_200_000, "2h 0m"],
      [7_500_000, "2h 5m"],
      [90_000_000, "25h 0m"],
      [-1, "0s"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "clock")).toBe(expected);
  });
});

describe("formatDuration — monitor", () => {
  it("matches the pinned values", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [NaN, "?"],
      [Infinity, "?"],
      [-1, "?"],
      [0, "0ms"],
      [500, "500ms"],
      [999, "999ms"],
      [1000, "1s"],
      [5000, "5s"],
      [59_999, "59s"],
      [60_000, "1m"],
      [120_000, "2m"],
      [61_000, "1m 1s"],
      [3_661_000, "61m 1s"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "monitor")).toBe(expected);
  });
});

describe("formatDuration — narrow", () => {
  it("matches the pinned values", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [0, "0s"],
      [-100, "0s"],
      [500, "500ms"],
      [1500, "1s"],
      [59_999, "59s"],
      [60_000, "1m"],
      [3_661_000, "61m"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "narrow")).toBe(expected);
  });
});

describe("formatDuration — decimal", () => {
  it("matches the documented shapes", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [NaN, "?"],
      [Infinity, "?"],
      [-1, "?"],
      [0, "0ms"],
      [999, "999ms"],
      [1000, "1.0s"],
      [1500, "1.5s"],
      [65_000, "1m 5s"],
      [3_661_000, "61m 1s"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "decimal")).toBe(expected);
  });
});

describe("formatDuration — stall", () => {
  it("matches the pinned values", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [2500, "2.5s"],
      [59_999, "60.0s"],
      [60_000, "1m"],
      [61_000, "1m 1s"],
      [225_000, "3m 45s"],
      [-5, "?"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "stall")).toBe(expected);
  });
});

describe("formatDuration — largest", () => {
  it("rounds to a single unit and rolls at 60s / 60m / 24h", () => {
    const pinned: ReadonlyArray<readonly [number, string]> = [
      [0, "0s"],
      [42_000, "42s"],
      [59_999, "60s"],
      [60_000, "1m"],
      [720_000, "12m"],
      [3_599_000, "60m"],
      [3_600_000, "1h"],
      [10_800_000, "3h"],
      [86_400_000, "1d"],
      [172_800_000, "2d"],
      [-1, "0s"],
      [NaN, "0s"],
    ];
    for (const [ms, expected] of pinned) expect(formatDuration(ms, "largest")).toBe(expected);
  });
});

describe("formatDuration — hardening across all six styles", () => {
  it("returns the style sentinel — never NaN/Infinity text — for invalid input", () => {
    const invalid = [NaN, Infinity, -Infinity, -1, -100, -0.5];
    for (const style of DURATION_STYLES) {
      for (const ms of invalid) {
        const out = formatDuration(ms, style);
        expect(out === "0s" || out === "?").toBe(true);
      }
    }
  });
});

interface DurationCase {
  readonly label: string;
  readonly ms: number;
  readonly expected: Readonly<Record<DurationStyle, string>>;
}

const DURATION_CASES: readonly DurationCase[] = [
  { label: "negative", ms: -1, expected: { clock: "0s", monitor: "?", narrow: "0s", decimal: "?", stall: "?", largest: "0s" } },
  { label: "NaN", ms: NaN, expected: { clock: "0s", monitor: "?", narrow: "0s", decimal: "?", stall: "?", largest: "0s" } },
  { label: "Infinity", ms: Infinity, expected: { clock: "0s", monitor: "?", narrow: "0s", decimal: "?", stall: "?", largest: "0s" } },
  { label: "-Infinity", ms: -Infinity, expected: { clock: "0s", monitor: "?", narrow: "0s", decimal: "?", stall: "?", largest: "0s" } },
  { label: "zero", ms: 0, expected: { clock: "0s", monitor: "0ms", narrow: "0s", decimal: "0ms", stall: "0.0s", largest: "0s" } },
  { label: "500ms", ms: 500, expected: { clock: "0s", monitor: "500ms", narrow: "500ms", decimal: "500ms", stall: "0.5s", largest: "1s" } },
  { label: "999ms", ms: 999, expected: { clock: "0s", monitor: "999ms", narrow: "999ms", decimal: "999ms", stall: "1.0s", largest: "1s" } },
  { label: "1s", ms: 1000, expected: { clock: "1s", monitor: "1s", narrow: "1s", decimal: "1.0s", stall: "1.0s", largest: "1s" } },
  { label: "just under a minute", ms: 59_999, expected: { clock: "59s", monitor: "59s", narrow: "59s", decimal: "60.0s", stall: "60.0s", largest: "60s" } },
  { label: "one minute", ms: 60_000, expected: { clock: "1m 0s", monitor: "1m", narrow: "1m", decimal: "1m 0s", stall: "1m", largest: "1m" } },
  { label: "one minute one second", ms: 61_000, expected: { clock: "1m 1s", monitor: "1m 1s", narrow: "1m", decimal: "1m 1s", stall: "1m 1s", largest: "1m" } },
  { label: "3m45s", ms: 225_000, expected: { clock: "3m 45s", monitor: "3m 45s", narrow: "3m", decimal: "3m 45s", stall: "3m 45s", largest: "4m" } },
  { label: "just under an hour", ms: 3_599_000, expected: { clock: "59m 59s", monitor: "59m 59s", narrow: "59m", decimal: "59m 59s", stall: "59m 59s", largest: "60m" } },
  { label: "one hour", ms: 3_600_000, expected: { clock: "1h 0m", monitor: "60m", narrow: "60m", decimal: "60m 0s", stall: "60m", largest: "1h" } },
  { label: "61m1s", ms: 3_661_000, expected: { clock: "1h 1m", monitor: "61m 1s", narrow: "61m", decimal: "61m 1s", stall: "61m 1s", largest: "1h" } },
  { label: "two hours", ms: 7_200_000, expected: { clock: "2h 0m", monitor: "120m", narrow: "120m", decimal: "120m 0s", stall: "120m", largest: "2h" } },
  { label: "2h5m", ms: 7_500_000, expected: { clock: "2h 5m", monitor: "125m", narrow: "125m", decimal: "125m 0s", stall: "125m", largest: "2h" } },
  { label: "one day", ms: 86_400_000, expected: { clock: "24h 0m", monitor: "1440m", narrow: "1440m", decimal: "1440m 0s", stall: "1440m", largest: "1d" } },
  { label: "25h", ms: 90_000_000, expected: { clock: "25h 0m", monitor: "1500m", narrow: "1500m", decimal: "1500m 0s", stall: "1500m", largest: "1d" } },
  { label: "25h1m1s", ms: 90_061_000, expected: { clock: "25h 1m", monitor: "1501m 1s", narrow: "1501m", decimal: "1501m 1s", stall: "1501m 1s", largest: "1d" } },
  { label: "two days", ms: 172_800_000, expected: { clock: "48h 0m", monitor: "2880m", narrow: "2880m", decimal: "2880m 0s", stall: "2880m", largest: "2d" } },
];

describe("formatDuration — table over a shared input list", () => {
  for (const style of DURATION_STYLES) {
    it("keeps style " + style + " aligned across every shared input", () => {
      for (const entry of DURATION_CASES) {
        expect(formatDuration(entry.ms, style)).toBe(entry.expected[style]);
      }
    });
  }

  it("never renders NaN or Infinity for finite non-negative input", () => {
    for (const entry of DURATION_CASES) {
      if (!Number.isFinite(entry.ms) || entry.ms < 0) continue;
      for (const style of DURATION_STYLES) {
        const out = formatDuration(entry.ms, style);
        expect(out).not.toContain("NaN");
        expect(out).not.toContain("Infinity");
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── formatTimestamp ─────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("renders UTC YYYY-MM-DD HH:mm:ss", () => {
    expect(formatTimestamp(1_705_314_600_000)).toBe("2024-01-15 10:30:00");
    expect(formatTimestamp(0)).toBe("1970-01-01 00:00:00");
  });

  it("renders negative epochs", () => {
    expect(formatTimestamp(-1000)).toBe("1969-12-31 23:59:59");
    expect(formatTimestamp(-8.64e15)).toBe("-271821-04-20 00:00:00");
  });

  it("never throws and falls back outside the Date range", () => {
    for (const ms of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1, 1e300]) {
      expect(() => formatTimestamp(ms)).not.toThrow();
      expect(formatTimestamp(ms)).toBe("unknown");
    }
    expect(formatTimestamp(NaN, "n/a")).toBe("n/a");
  });

  it("still renders the inclusive Date range boundary", () => {
    expect(formatTimestamp(8.64e15)).not.toBe("unknown");
  });
});

// ── formatRelativeTime ──────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  const now = 1_705_314_600_000;

  it("returns 'unknown' for non-finite input", () => {
    expect(formatRelativeTime(NaN, now)).toBe("unknown");
    expect(formatRelativeTime(Infinity, now)).toBe("unknown");
    expect(formatRelativeTime(-Infinity, now)).toBe("unknown");
    expect(formatRelativeTime(0, NaN)).toBe("unknown");
  });

  it("returns 'just now' for future and sub-second deltas", () => {
    expect(formatRelativeTime(now + 100_000, now)).toBe("just now");
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 500, now)).toBe("just now");
    expect(formatRelativeTime(now - 999, now)).toBe("just now");
  });

  it("scales through seconds, minutes, hours and days", () => {
    expect(formatRelativeTime(now - 1000, now)).toBe("1s ago");
    expect(formatRelativeTime(now - 5000, now)).toBe("5s ago");
    expect(formatRelativeTime(now - 59_000, now)).toBe("59s ago");
    expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 3_540_000, now)).toBe("59m ago");
    expect(formatRelativeTime(now - 3_600_000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
    expect(formatRelativeTime(now - 86_400_000, now)).toBe("1 day ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toBe("30 days ago");
  });

  it("defaults now to Date.now()", () => {
    expect(formatRelativeTime(Date.now())).toBe("just now");
  });
});

// ── formatBytes ─────────────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("matches the pinned binary rendering", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(870_400)).toBe("850KB");
    expect(formatBytes(1_228_800)).toBe("1.2MB");
  });

  it("returns the invalid sentinel for non-finite input", () => {
    expect(formatBytes(NaN)).toBe("?");
    expect(formatBytes(Infinity)).toBe("?");
    expect(formatBytes(-Infinity)).toBe("?");
    expect(formatBytes(NaN, { invalid: "n/a" })).toBe("n/a");
  });

  it("clamps negatives to zero", () => {
    expect(formatBytes(-1)).toBe("0B");
    expect(formatBytes(-1_000_000)).toBe("0B");
  });

  it("switches to decimal scaling with binary: false", () => {
    expect(formatBytes(100_000)).toBe("97.7KB");
    expect(formatBytes(100_000, { binary: false })).toBe("100KB");
    expect(formatBytes(1000, { binary: false })).toBe("1.0KB");
  });

  it("stops at the largest known unit", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024TB");
  });

  it("promotes a value that rounds up to the next unit", () => {
    expect(formatBytes(1_048_575)).toBe("1.0MB");
    expect(formatBytes(1_048_576)).toBe("1.0MB");
    expect(formatBytes(1024 ** 3 - 1)).toBe("1.0GB");
    // A value that rounds below the boundary stays in its own unit.
    expect(formatBytes(1_048_000)).toBe("1023KB");
  });
});

// ── formatCount ─────────────────────────────────────────────────────────────

describe("formatCount", () => {
  it("groups base-10 thousands deterministically", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(5)).toBe("5");
    expect(formatCount(-5)).toBe("-5");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(100_000)).toBe("100,000");
    expect(formatCount(1_000_000)).toBe("1,000,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatCount(-1_234_567)).toBe("-1,234,567");
    expect(formatCount(-0)).toBe("0");
  });

  it("keeps fractional digits", () => {
    expect(formatCount(1234.5)).toBe("1,234.5");
    expect(formatCount(0.5)).toBe("0.5");
  });

  it("drops an exponential fraction tail instead of emitting e-notation", () => {
    // String(1e-7) is "1e-7", so slicing it would have produced "0e-7".
    expect(formatCount(1e-7)).toBe("0");
    // A magnitude that rounds to zero carries no sign.
    expect(formatCount(-1e-7)).toBe("0");
  });

  it("returns the invalid sentinel for non-finite input", () => {
    expect(formatCount(NaN)).toBe("?");
    expect(formatCount(Infinity)).toBe("?");
    expect(formatCount(-Infinity)).toBe("?");
    expect(formatCount(NaN, { invalid: "0" })).toBe("0");
  });

  it("is locale-independent and never routes through Intl", () => {
    const originalNumberFormat = Intl.NumberFormat;
    const originalToLocaleString = Number.prototype.toLocaleString;
    let localeCalls = 0;
    // A `function` (not an arrow) so it also records and throws when used as a
    // constructor via `new Intl.NumberFormat(...)`.
    const localeSpy = function localeSpy(): never {
      localeCalls += 1;
      throw new Error("locale formatting must not be used");
    };
    try {
      Intl.NumberFormat = localeSpy as unknown as typeof Intl.NumberFormat;
      Number.prototype.toLocaleString = localeSpy as unknown as Number["toLocaleString"];

      const thousands = formatCount(1000);
      const millions = formatCount(1_234_567);

      expect(localeCalls).toBe(0);
      expect(thousands).toBe("1,000");
      expect(millions).toBe("1,234,567");
    } finally {
      Intl.NumberFormat = originalNumberFormat;
      Number.prototype.toLocaleString = originalToLocaleString;
    }
  });
});

// ── stripAnsi / displayWidth ────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi(ESC + "[31mred" + ESC + "[39m")).toBe("red");
  });

  it("removes erase-in-line and other CSI finals", () => {
    expect(stripAnsi(ESC + "[2K")).toBe("");
    expect(stripAnsi(ESC + "[2;3Hx")).toBe("x");
    expect(stripAnsi(ESC + "[1A" + ESC + "[0J")).toBe("");
  });

  it("removes whole OSC-8 hyperlinks and OSC titles", () => {
    const hyperlink = ESC + "]8;;https://example.com" + BEL + "link" + ESC + "]8;;" + BEL;
    expect(stripAnsi(hyperlink)).toBe("link");
    const stTerminated = ESC + "]8;;https://example.com" + ESC + "\\" + "link" + ESC + "]8;;" + ESC + "\\";
    expect(stripAnsi(stTerminated)).toBe("link");
    expect(stripAnsi(ESC + "]0;my title" + BEL + "text")).toBe("text");
  });

  it("removes two-character escapes", () => {
    expect(stripAnsi(ESC + "(Bascii")).toBe("ascii");
  });

  it("leaves no escape introducer behind and is idempotent", () => {
    const samples = [
      ESC + "[31mred" + ESC + "[39m",
      ESC + "[2K",
      ESC + "]8;;https://example.com" + BEL + "link" + ESC + "]8;;" + BEL,
      ESC + "(Bascii",
      "\u009b31mred",
    ];
    for (const sample of samples) {
      const once = stripAnsi(sample);
      expect(once).not.toContain(ESC);
      expect(stripAnsi(once)).toBe(once);
    }
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
    expect(stripAnsi("")).toBe("");
  });

  it("stays linear on pathological unterminated CSI input", () => {
    const pathological = ESC + "[" + "[".repeat(20_000);
    expect(stripAnsi(pathological)).toBe(pathological);
  });
});

describe("displayWidth", () => {
  it("counts ASCII as one column", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("abc")).toBe(3);
  });

  it("counts East-Asian wide characters as two columns", () => {
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("Ａ")).toBe(2);
    expect(displayWidth("日本語")).toBe(6);
  });

  it("counts emoji as two columns", () => {
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("🇯🇵")).toBe(4);
  });

  it("ignores ANSI escapes", () => {
    expect(displayWidth("a" + ESC + "[31mb" + ESC + "[39m")).toBe(2);
    expect(displayWidth(ESC + "[2K")).toBe(0);
  });

  it("counts combining marks and zero-width characters as zero", () => {
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("a\u200db")).toBe(2);
    expect(displayWidth("\u2060")).toBe(0);
    expect(displayWidth("\ufeff")).toBe(0);
  });

  it("counts C0/C1 controls as zero", () => {
    expect(displayWidth("\u0000\u0007")).toBe(0);
    expect(displayWidth("\u0085\u009f")).toBe(0);
  });
});

// ── truncateText ────────────────────────────────────────────────────────────

describe("truncateText", () => {
  it("matches the pinned plain-text values", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello", 5)).toBe("hello");
    expect(truncateText("hello", 3)).toBe("he\u2026");
    expect(truncateText("hello", 1)).toBe("\u2026");
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", -5)).toBe("");
  });

  it("never cuts a surrogate pair", () => {
    const out = truncateText("😀😀😀", 4);
    expect(out).toBe("😀\u2026");
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).not.toContain("\ufffd");
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it("never leaves a dangling ZWJ", () => {
    const family = "👨\u200d👩\u200d👧";
    const out = truncateText(family, 5);
    expect(out.endsWith("\u200d")).toBe(false);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out).toBe("👨\u200d👩\u2026");
  });

  it("never leaves an unattached combining mark", () => {
    // A prefix of nothing but zero-width marks has no base glyph to attach to.
    expect(truncateText("\u0301你好", 2)).toBe("\u2026");
    expect(truncateText("\u200d你好", 2)).toBe("\u2026");
    // A mark kept together with its base is intact, not dangling.
    expect(truncateText("cafe\u0301 au lait", 5)).toBe("cafe\u0301\u2026");
    expect(truncateText("cafe\u0301 au lait", 2)).toBe("c\u2026");
  });

  it("keeps CJK truncation inside the column budget", () => {
    expect(truncateText("你好世界", 5)).toBe("你好\u2026");
    expect(truncateText("你好", 4)).toBe("你好");
  });

  it("preserves ANSI escapes in the kept prefix and costs them no columns", () => {
    const coloured = ESC + "[31mhello" + ESC + "[39m";
    expect(truncateText(coloured, 5)).toBe(coloured);
    const out = truncateText(coloured, 4);
    expect(out).toBe(ESC + "[31mhel\u2026");
    expect(displayWidth(out)).toBe(4);
  });

  it("treats +Infinity as no truncation and NaN/negative as empty", () => {
    expect(truncateText("hello", Number.POSITIVE_INFINITY)).toBe("hello");
    expect(truncateText("你好世界", Number.POSITIVE_INFINITY)).toBe("你好世界");
    expect(truncateText("hello", Number.NEGATIVE_INFINITY)).toBe("");
    expect(truncateText("hello", Number.NaN)).toBe("");
    expect(truncateText("hello", 0)).toBe("");
  });

  it("clips a wide ellipsis to the budget", () => {
    expect(truncateText("hello", 2, "😀")).toBe("😀");
    expect(truncateText("hello", 1, "😀")).toBe("");
    expect(truncateText("hello", 3, "..")).toBe("h..");
  });

  it("honours the column budget and surrogate safety over a corpus", () => {
    const corpus = [
      "hello",
      "😀😀😀",
      "👨\u200d👩\u200d👧\u200d👦",
      "你好世界",
      "a" + ESC + "[31mb" + ESC + "[39mc",
      "cafe\u0301 au lait",
      "🇯🇵🇯🇵",
      ESC + "[2Khello",
      "日本語のテキスト",
    ];
    for (const input of corpus) {
      for (let width = 0; width <= 10; width++) {
        const out = truncateText(input, width);
        expect(hasLoneSurrogate(out)).toBe(false);
        expect(displayWidth(out)).toBeLessThanOrEqual(width);
        expect(truncateText(out, width)).toBe(out);
      }
    }
  });
});

// ── padding ─────────────────────────────────────────────────────────────────

describe("padDisplayEnd / padDisplayStart", () => {
  it("pads CJK and emoji to the column budget", () => {
    expect(padDisplayEnd("你好", 6)).toBe("你好" + "  ");
    expect(padDisplayEnd("😀", 4)).toBe("😀" + "  ");
    expect(padDisplayStart("你好", 6)).toBe("  " + "你好");
    expect(padDisplayStart("😀", 4)).toBe("  " + "😀");
  });

  it("never truncates", () => {
    expect(padDisplayEnd("abcdef", 3)).toBe("abcdef");
    expect(padDisplayStart("abcdef", 3)).toBe("abcdef");
  });

  it("returns the input unchanged for non-positive width", () => {
    expect(padDisplayEnd("ab", 0)).toBe("ab");
    expect(padDisplayStart("ab", -3)).toBe("ab");
  });

  it("measures ANSI-coloured text by its display columns", () => {
    const coloured = ESC + "[31mab" + ESC + "[39m";
    expect(padDisplayEnd(coloured, 4)).toBe(coloured + "  ");
    expect(padDisplayStart(coloured, 4)).toBe("  " + coloured);
  });

  it("clamps the emitted padding so a hostile width cannot exhaust memory", () => {
    const end = padDisplayEnd("x", Number.MAX_SAFE_INTEGER);
    expect(end).toBe("x" + " ".repeat(10_000));
    const start = padDisplayStart("x", Number.MAX_SAFE_INTEGER);
    expect(start).toBe(" ".repeat(10_000) + "x");
  });
});

// ── markdown tables ─────────────────────────────────────────────────────────

describe("escapeMarkdownTableCell", () => {
  it("escapes pipes and line breaks", () => {
    expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
    expect(escapeMarkdownTableCell("line1\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownTableCell("line1\r\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownTableCell("line1\rline2")).toBe("line1<br>line2");
  });

  it("replaces TAB and drops C0/C1 controls", () => {
    expect(escapeMarkdownTableCell("a\tb")).toBe("a b");
    expect(escapeMarkdownTableCell("\u0000a\u0007b\u007fc\u0085d\u009f")).toBe("abcd");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeMarkdownTableCell("plain text")).toBe("plain text");
    expect(escapeMarkdownTableCell("")).toBe("");
  });

  it("escapes a backslash before a pipe so literal content round-trips", () => {
    // x, backslash, pipe, y → the backslash becomes \ and the pipe \|
    expect(escapeMarkdownTableCell("x\\|y")).toBe("x\\\\\\|y");
    expect(escapeMarkdownTableCell("a\\b")).toBe("a\\\\b");
  });

  it("passes raw HTML through — the guarantee is row structure only", () => {
    expect(escapeMarkdownTableCell("<b>bold</b>")).toBe("<b>bold</b>");
    expect(renderMarkdownTable(["A"], [["<b>x</b>"]])).toBe(
      "| A |\n| --- |\n| <b>x</b> |",
    );
  });
});

describe("renderMarkdownTable", () => {
  it("returns an empty string for empty headers", () => {
    expect(renderMarkdownTable([], [["a"]])).toBe("");
  });

  it("renders header, separator and rows", () => {
    expect(renderMarkdownTable(["A", "B"], [["1", "2"]])).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(renderMarkdownTable(["A"], [])).toBe("| A |\n| --- |");
  });

  it("escapes cells so a row cannot break out", () => {
    const table = renderMarkdownTable(["A", "B"], [["x|y", "l1\nl2"]]);
    const row = table.split("\n")[2];
    expect(row).toBe("| x\\|y | l1<br>l2 |");
  });

  it("pads ragged rows and clips extra cells", () => {
    expect(renderMarkdownTable(["A", "B"], [["only"]])).toContain("| only |  |");
    expect(renderMarkdownTable(["A", "B"], [["1", "2", "3"]])).toContain("| 1 | 2 |");
  });

  it("escapes headers too", () => {
    expect(renderMarkdownTable(["a|b"], [])).toBe("| a\\|b |\n| --- |");
  });
});

// ── progress bars ───────────────────────────────────────────────────────────

describe("progressBarParts", () => {
  it("matches the pinned segment counts", () => {
    expect(progressBarParts(0, 0)).toEqual({ filled: 0, empty: 6 });
    expect(progressBarParts(5, 0)).toEqual({ filled: 0, empty: 6 });
    expect(progressBarParts(0, 10)).toEqual({ filled: 0, empty: 6 });
    expect(progressBarParts(5, 10)).toEqual({ filled: 3, empty: 3 });
    expect(progressBarParts(10, 10)).toEqual({ filled: 6, empty: 0 });
    expect(progressBarParts(20, 10)).toEqual({ filled: 6, empty: 0 });
    expect(progressBarParts(3, 4, 8)).toEqual({ filled: 6, empty: 2 });
  });

  it("returns an empty bar for zero, negative or non-finite totals", () => {
    expect(progressBarParts(1, 0, 10)).toEqual({ filled: 0, empty: 10 });
    expect(progressBarParts(1, -5, 10)).toEqual({ filled: 0, empty: 10 });
    expect(progressBarParts(1, NaN, 10)).toEqual({ filled: 0, empty: 10 });
  });

  it("returns an empty bar for a non-finite current", () => {
    expect(progressBarParts(NaN, 5, 10)).toEqual({ filled: 0, empty: 10 });
    expect(progressBarParts(Infinity, 5, 10)).toEqual({ filled: 0, empty: 10 });
    expect(progressBarParts(-1, 5, 10)).toEqual({ filled: 0, empty: 10 });
  });

  it("clamps negative widths to zero", () => {
    expect(progressBarParts(5, 10, -3)).toEqual({ filled: 0, empty: 0 });
  });

  it("clamps a hostile width to a bounded bar instead of throwing", () => {
    expect(progressBarParts(1, 2, Number.MAX_SAFE_INTEGER)).toEqual({
      filled: 5_000,
      empty: 5_000,
    });
    expect(progressBar(1, 2, Number.MAX_SAFE_INTEGER).length).toBe(10_000);
    expect(progressBar(1, 1, Number.MAX_SAFE_INTEGER).length).toBe(10_000);
  });
});

describe("progressBar", () => {
  it("uses the documented default glyphs", () => {
    expect(progressBar(1, 1, 1)).toBe("\u25a0");
    expect(progressBar(0, 1, 1)).toBe("\u25a1");
    expect(progressBar(5, 10, 10)).toBe("\u25a0".repeat(5) + "\u25a1".repeat(5));
  });

  it("renders an empty bar when total is zero or current is NaN", () => {
    expect(progressBar(1, 0, 10)).toBe("\u25a1".repeat(10));
    expect(progressBar(NaN, 5, 10)).toBe("\u25a1".repeat(10));
  });

  it("supports custom glyphs", () => {
    expect(progressBar(1, 2, 4, { filled: "#", empty: "-" })).toBe("##--");
  });

  it("defaults to width 10", () => {
    expect(progressBar(0, 10).length).toBe(10);
  });
});
