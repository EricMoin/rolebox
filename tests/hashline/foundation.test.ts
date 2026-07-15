import { describe, it, expect } from "bun:test";
import {
  computeLineHash,
  computeFileVersion,
  hashWidthForLineCount,
  canonicalizeFileText,
  restoreFileText,
  formatHashLine,
  formatHashLines,
  formatReadOutput,
  BASE64_DICT,
} from "../../src/hashline/index.ts";

// ── Hash determinism ──────────────────────────────────────────────

describe("computeLineHash", () => {
  it("is deterministic: same content + same width → same hash", () => {
    const content = "const x = 42;";
    const a = computeLineHash(content, 3);
    const b = computeLineHash(content, 3);
    expect(a).toBe(b);
  });

  it("produces different hashes for different content", () => {
    const a = computeLineHash("hello world", 3);
    const b = computeLineHash("goodbye world", 3);
    expect(a).not.toBe(b);
  });

  it("produces correct width output (width=2)", () => {
    const hash = computeLineHash("test", 2);
    expect(hash.length).toBe(2);
    for (const ch of hash) {
      expect(BASE64_DICT).toContain(ch);
    }
  });

  it("produces correct width output (width=3)", () => {
    const hash = computeLineHash("test", 3);
    expect(hash.length).toBe(3);
    for (const ch of hash) {
      expect(BASE64_DICT).toContain(ch);
    }
  });

  it("produces correct width output (width=4)", () => {
    const hash = computeLineHash("test", 4);
    expect(hash.length).toBe(4);
    for (const ch of hash) {
      expect(BASE64_DICT).toContain(ch);
    }
  });

  it("strips carriage returns before hashing", () => {
    const a = computeLineHash("hello\r\n", 3);
    const b = computeLineHash("hello\n", 3);
    expect(a).toBe(b);
  });

  it("trims trailing whitespace", () => {
    const a = computeLineHash("  hello  ", 3);
    const b = computeLineHash("  hello", 3);
    expect(a).toBe(b);
  });

  it("uses default width=3 consistently for typical lines", () => {
    const hash = computeLineHash("console.log('hello');", 3);
    expect(hash.length).toBe(3);
  });

  // Symbol-only line differentiation (line number seeding)
  it("differentiates symbol-only lines at different positions when lineNumber is provided", () => {
    const content = "}";
    const hashLine1 = computeLineHash(content, 3, 1);
    const hashLine5 = computeLineHash(content, 3, 5);
    expect(hashLine1).not.toBe(hashLine5);
  });

  it("differentiates empty lines at different positions", () => {
    const hashLine1 = computeLineHash("", 3, 1);
    const hashLine5 = computeLineHash("", 3, 5);
    expect(hashLine1).not.toBe(hashLine5);
  });

  it("differentiates whitespace-only lines at different positions", () => {
    const hashLine1 = computeLineHash("   ", 3, 1);
    const hashLine10 = computeLineHash("   ", 3, 10);
    expect(hashLine1).not.toBe(hashLine10);
  });

  it("does NOT differentiate content lines at different positions (no line number seeding)", () => {
    const content = "const x = 1;";
    const hashLine1 = computeLineHash(content, 3, 1);
    const hashLine5 = computeLineHash(content, 3, 5);
    expect(hashLine1).toBe(hashLine5);
  });

  it("handles curly braces at different positions", () => {
    const hashLine10 = computeLineHash("{", 3, 10);
    const hashLine20 = computeLineHash("{", 3, 20);
    expect(hashLine10).not.toBe(hashLine20);
  });

  it("uses only base-64 dictionary characters", () => {
    const contents = ["hello", "world", "foo", "bar", "test", "123", "{}", "()", ";"];
    for (const content of contents) {
      const hash = computeLineHash(content, 4);
      for (const ch of hash) {
        expect(BASE64_DICT).toContain(ch);
      }
    }
  });
});

// ── Hash width auto-escalation ────────────────────────────────────

describe("hashWidthForLineCount", () => {
  it("returns 2 for files ≤ 1000 lines", () => {
    expect(hashWidthForLineCount(0)).toBe(2);
    expect(hashWidthForLineCount(1)).toBe(2);
    expect(hashWidthForLineCount(500)).toBe(2);
    expect(hashWidthForLineCount(1000)).toBe(2);
  });

  it("returns 3 for files between 1001 and 10000 lines", () => {
    expect(hashWidthForLineCount(1001)).toBe(3);
    expect(hashWidthForLineCount(5000)).toBe(3);
    expect(hashWidthForLineCount(10000)).toBe(3);
  });

  it("returns 4 for files > 10000 lines", () => {
    expect(hashWidthForLineCount(10001)).toBe(4);
    expect(hashWidthForLineCount(50000)).toBe(4);
    expect(hashWidthForLineCount(100000)).toBe(4);
  });

  it("respects ROLEBOX_HASHLINE_WIDTH env var override", () => {
    process.env.ROLEBOX_HASHLINE_WIDTH = "5";
    expect(hashWidthForLineCount(10)).toBe(5);
    expect(hashWidthForLineCount(5000)).toBe(5);
    expect(hashWidthForLineCount(50000)).toBe(5);
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });

  it("ignores invalid env var overrides and falls back to default", () => {
    process.env.ROLEBOX_HASHLINE_WIDTH = "999";
    expect(hashWidthForLineCount(10)).toBe(2);
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });

  it("ignores non-numeric env var overrides", () => {
    process.env.ROLEBOX_HASHLINE_WIDTH = "abc";
    expect(hashWidthForLineCount(10)).toBe(2);
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });

  it("ignores env var overrides below 2", () => {
    process.env.ROLEBOX_HASHLINE_WIDTH = "1";
    expect(hashWidthForLineCount(10)).toBe(2);
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });
});

// ── File version computation ──────────────────────────────────────

describe("computeFileVersion", () => {
  it("produces a 64-character hex string", () => {
    const version = computeFileVersion("hello world");
    expect(version.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(version)).toBe(true);
  });

  it("is deterministic: same input → same output", () => {
    const a = computeFileVersion("const x = 42;");
    const b = computeFileVersion("const x = 42;");
    expect(a).toBe(b);
  });

  it("produces different versions for different content", () => {
    const a = computeFileVersion("hello");
    const b = computeFileVersion("world");
    expect(a).not.toBe(b);
  });

  it("includes trailing newline in computation", () => {
    const a = computeFileVersion("line1\n");
    const b = computeFileVersion("line1");
    expect(a).not.toBe(b);
  });
});

// ── BOM stripping and CRLF normalization ──────────────────────────

describe("canonicalizeFileText", () => {
  it("strips BOM when present", () => {
    const result = canonicalizeFileText("\uFEFFhello\nworld\n");
    expect(result.content).toBe("hello\nworld\n");
    expect(result.hadBom).toBe(true);
    expect(result.lineEnding).toBe("\n");
  });

  it("does not modify content without BOM", () => {
    const result = canonicalizeFileText("hello\nworld\n");
    expect(result.content).toBe("hello\nworld\n");
    expect(result.hadBom).toBe(false);
  });

  it("normalizes CRLF to LF", () => {
    const result = canonicalizeFileText("hello\r\nworld\r\n");
    expect(result.content).toBe("hello\nworld\n");
    expect(result.lineEnding).toBe("\r\n");
  });

  it("normalizes legacy CR (\\r-only) line endings", () => {
    const result = canonicalizeFileText("hello\rworld\r");
    expect(result.content).toBe("hello\nworld\n");
    expect(result.lineEnding).toBe("\r\n");
  });

  it("handles mixed content with both BOM and CRLF", () => {
    const result = canonicalizeFileText("\uFEFFline1\r\nline2\r\n");
    expect(result.content).toBe("line1\nline2\n");
    expect(result.hadBom).toBe(true);
    expect(result.lineEnding).toBe("\r\n");
  });

  it("detects LF line ending when no CRLF or CR present", () => {
    const result = canonicalizeFileText("hello\nworld\n");
    expect(result.lineEnding).toBe("\n");
  });

  it("handles empty content", () => {
    const result = canonicalizeFileText("");
    expect(result.content).toBe("");
    expect(result.hadBom).toBe(false);
    expect(result.lineEnding).toBe("\n");
  });
});

// ── Round-trip: canonicalize → restore ────────────────────────────

describe("canonicalizeFileText + restoreFileText", () => {
  it("round-trips plain LF content", () => {
    const original = "hello\nworld\n";
    const envelope = canonicalizeFileText(original);
    const restored = restoreFileText(envelope.content, envelope);
    expect(restored).toBe(original);
  });

  it("round-trips CRLF content", () => {
    const original = "hello\r\nworld\r\n";
    const envelope = canonicalizeFileText(original);
    const restored = restoreFileText(envelope.content, envelope);
    expect(restored).toBe(original);
  });

  it("round-trips BOM content", () => {
    const original = "\uFEFFhello\nworld\n";
    const envelope = canonicalizeFileText(original);
    const restored = restoreFileText(envelope.content, envelope);
    expect(restored).toBe(original);
  });

  it("round-trips BOM + CRLF content", () => {
    const original = "\uFEFFhello\r\nworld\r\n";
    const envelope = canonicalizeFileText(original);
    const restored = restoreFileText(envelope.content, envelope);
    expect(restored).toBe(original);
  });

  it("restores CRLF after canonicalization even when no CRLF was originally present", () => {
    const envelope: ReturnType<typeof canonicalizeFileText> = {
      content: "hello\nworld\n",
      hadBom: false,
      lineEnding: "\r\n",
    };
    const restored = restoreFileText("hello\nworld\n", envelope);
    expect(restored).toBe("hello\r\nworld\r\n");
  });

  it("re-adds BOM when hadBom is true", () => {
    const restored = restoreFileText("hello\n", { content: "hello\n", hadBom: true, lineEnding: "\n" });
    expect(restored).toBe("\uFEFFhello\n");
  });
});

// ── formatHashLine / formatHashLines ──────────────────────────────

describe("formatHashLine", () => {
  it("produces LINE#HASH|content format", () => {
    const result = formatHashLine(1, "hello", 3);
    expect(result).toMatch(/^1#[A-Za-z0-9_-]{3}\|hello$/);
  });

  it("is deterministic", () => {
    const a = formatHashLine(5, "const x = 1;", 3);
    const b = formatHashLine(5, "const x = 1;", 3);
    expect(a).toBe(b);
  });
});

describe("formatHashLines", () => {
  it("formats multiple lines with sequential line numbers", () => {
    const lines = ["a", "b", "c"];
    const result = formatHashLines(lines, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatch(/^1#[A-Za-z0-9_-]{3}\|a$/);
    expect(result[1]).toMatch(/^2#[A-Za-z0-9_-]{3}\|b$/);
    expect(result[2]).toMatch(/^3#[A-Za-z0-9_-]{3}\|c$/);
  });
});

// ── formatReadOutput: long-line display truncation ─────────────────

describe("formatReadOutput", () => {
  it("truncates lines longer than 2000 characters in display output", () => {
    // Build a short first line + a 3000-char second line
    const shortLine = 'const x = "hello";';
    const longContent = "x".repeat(3000);
    const content = shortLine + "\n" + longContent + "\n";

    const result = formatReadOutput(content, "/dev/null/test.ts");

    // Header should be present
    expect(result).toContain("version:");
    expect(result).toContain("hashWidth:");
    expect(result).toContain("totalLines: 2");

    // The short line should appear in full
    expect(result).toContain(shortLine);

    // Second line: find its annotated output
    const lines = result.split("\n");
    // Header = 3 lines, then 2 data lines (indices 3 and 4)
    const shortAnnotated = lines[3];
    const longAnnotated = lines[4];

    // Short line is intact
    expect(shortAnnotated).toMatch(/\|const x = "hello";$/);

    // Long line is truncated to 1997 chars + "..."
    expect(longAnnotated).toMatch(/\|x{1997}\.\.\.$/);
    expect(longAnnotated!.length).toBeLessThan(2000 + 100); // ~2000 + hash width + line number + pipe
    // Verify the displayed content after "|" is exactly 2000 chars (1997 x's + "...")
    const pipeIndex = longAnnotated!.indexOf("|");
    const afterPipe = longAnnotated!.slice(pipeIndex + 1);
    expect(afterPipe).toBe("x".repeat(1997) + "...");
    expect(afterPipe.length).toBe(2000);
  });

  it("does not truncate lines of exactly 2000 characters", () => {
    const content = "x".repeat(2000) + "\n";
    const result = formatReadOutput(content, "/dev/null/test.ts");
    const lines = result.split("\n");
    const annotLine = lines[3];
    const pipeIndex = annotLine!.indexOf("|");
    const afterPipe = annotLine!.slice(pipeIndex + 1);
    expect(afterPipe).toBe("x".repeat(2000));
    expect(afterPipe.length).toBe(2000);
  });

  it("does not truncate lines shorter than 2000 characters", () => {
    const shortLine = 'const y = "short";';
    const content = shortLine + "\n";
    const result = formatReadOutput(content, "/dev/null/test.ts");
    expect(result).toContain(shortLine);
    const lines = result.split("\n");
    const annotLine = lines[3];
    expect(annotLine).toContain(shortLine);
  });
});
