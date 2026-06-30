import { describe, it, expect } from "bun:test";
import {
  extractResultBlock,
  normalizeResult,
  hashResult,
  truncateResult,
} from "../../src/graph/result-capture";

// ── extractResultBlock ──────────────────────────────────────────────

describe("extractResultBlock", () => {
  it("extracts content from ```result fenced block", () => {
    const input = [
      "Some preamble text.",
      "```result",
      "actual result content",
      "more result lines",
      "```",
      "Some trailing text.",
    ].join("\n");

    const output = extractResultBlock(input);
    expect(output).toBe("actual result content\nmore result lines");
  });

  it("returns the last ```result fence when multiple exist", () => {
    const input = [
      "```result",
      "first result",
      "```",
      "middle text",
      "```result",
      "second result",
      "```",
    ].join("\n");

    const output = extractResultBlock(input);
    expect(output).toBe("second result");
  });

  it("returns full text when no result fence is present", () => {
    const input = "just plain text\nno fences here";
    const output = extractResultBlock(input);
    expect(output).toBe(input);
  });
});

// ── normalizeResult ─────────────────────────────────────────────────

describe("normalizeResult", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeResult("  hello  ")).toBe("hello");
    expect(normalizeResult("\n\thello world\n")).toBe("hello world");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(normalizeResult("hello   world")).toBe("hello world");
    expect(normalizeResult("hello\t\tworld")).toBe("hello world");
    expect(normalizeResult("hello\n\nworld")).toBe("hello world");
    expect(normalizeResult("hello \t \n world")).toBe("hello world");
  });

  it("is idempotent (applying twice yields the same result)", () => {
    const input = "  hello   \n  world\t  ";
    const once = normalizeResult(input);
    const twice = normalizeResult(once);
    expect(twice).toBe(once);
  });

  it("handles empty string", () => {
    expect(normalizeResult("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(normalizeResult("   \n\t  ")).toBe("");
  });
});

// ── hashResult ──────────────────────────────────────────────────────

describe("hashResult", () => {
  it("produces stable 12-char hex hash", () => {
    const h = hashResult("hello");
    expect(h.length).toBe(12);
    expect(/^[0-9a-f]{12}$/.test(h)).toBe(true);
  });

  it("identical-after-normalization texts produce equal hashes", () => {
    const a = "  hello   world  ";
    const b = "hello\t\tworld";
    // normalize both first, then hash the normalized versions
    const normA = normalizeResult(a);
    const normB = normalizeResult(b);
    expect(normA).toBe(normB); // same after normalization
    expect(hashResult(normA)).toBe(hashResult(normB));
  });

  it("near-but-not-identical texts produce different hashes", () => {
    const h1 = hashResult(normalizeResult("hello world"));
    const h2 = hashResult(normalizeResult("hello world!"));
    expect(h1).not.toBe(h2);
  });

  it("same text always produces same hash", () => {
    expect(hashResult("test")).toBe(hashResult("test"));
  });
});

// ── truncateResult ──────────────────────────────────────────────────

describe("truncateResult", () => {
  it("caps text at maxBytes (default 2048)", () => {
    const long = "x".repeat(3000);
    const result = truncateResult(long);
    expect(result.length).toBe(2048);
  });

  it("no-ops on short text", () => {
    const short = "hello";
    expect(truncateResult(short)).toBe(short);
    expect(truncateResult(short, 100)).toBe(short);
  });

  it("respects custom maxBytes", () => {
    const text = "hello world";
    expect(truncateResult(text, 5)).toBe("hello");
  });

  it("returns empty string when maxBytes is 0", () => {
    expect(truncateResult("hello", 0)).toBe("");
  });

  it("returns full text when exactly at maxBytes", () => {
    const text = "12345";
    expect(truncateResult(text, 5)).toBe("12345");
  });
});
