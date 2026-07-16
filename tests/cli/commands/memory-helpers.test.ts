import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectRoot, truncate, relevanceLevels } from "../../../src/cli/commands/memory/memory-helpers";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-helpers-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  it("returns the directory containing .rolebox when found above the start path", () => {
    mkdirSync(join(tmpDir, "a", "b", ".rolebox"), { recursive: true });
    const start = join(tmpDir, "a", "b", "c", "d");
    expect(resolveProjectRoot(start)).toBe(join(tmpDir, "a", "b"));
  });

  it("returns the start path when .rolebox is not found anywhere", () => {
    const start = join(tmpDir, "some", "deep", "path");
    mkdirSync(start, { recursive: true });
    expect(resolveProjectRoot(start)).toBe(start);
  });

  it("returns start path when .rolebox is not found and start is a temp dir", () => {
    // tmpDir itself has no .rolebox, walking up hits root boundary or 64-iteration limit
    expect(resolveProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("handles filesystem root boundary without infinite loop", () => {
    expect(resolveProjectRoot("/")).toBe("/");
  });

  it("stops at the nearest .rolebox ancestor, not the first parent", () => {
    // .rolebox exists at tmpDir/a and tmpDir/a/b
    mkdirSync(join(tmpDir, "a", ".rolebox"), { recursive: true });
    mkdirSync(join(tmpDir, "a", "b", ".rolebox"), { recursive: true });
    const start = join(tmpDir, "a", "b", "c", "d");
    // Should return tmpDir/a/b (nearest ancestor), not tmpDir/a
    expect(resolveProjectRoot(start)).toBe(join(tmpDir, "a", "b"));
  });
});

describe("truncate", () => {
  it("returns the string as-is when shorter than maxLen", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string as-is when length equals maxLen", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends ellipsis when longer than maxLen", () => {
    const result = truncate("hello world", 5);
    expect(result).toBe("hell\u2026");
    expect(result.length).toBe(5);
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });

  it("handles maxLen of 1 with a single character (no truncation)", () => {
    expect(truncate("a", 1)).toBe("a");
  });

  it("handles maxLen of 1 with a longer string (result is just ellipsis)", () => {
    const result = truncate("ab", 1);
    expect(result).toBe("\u2026");
    expect(result.length).toBe(1);
  });

  it("replaces the last character with ellipsis, not appends", () => {
    // slice(0, maxLen - 1) then append ellipsis means total length == maxLen
    const result = truncate("abcdef", 4);
    expect(result).toBe("abc\u2026");
    expect(result.length).toBe(4);
  });
});

describe("relevanceLevels", () => {
  it("returns ['high'] (most restrictive) for min='high'", () => {
    expect(relevanceLevels("high")).toEqual(["high"]);
  });

  it("returns ['high', 'medium'] for min='medium'", () => {
    expect(relevanceLevels("medium")).toEqual(["high", "medium"]);
  });

  it("returns ['high', 'medium', 'low'] (all) for min='low'", () => {
    expect(relevanceLevels("low")).toEqual(["high", "medium", "low"]);
  });

  it("falls back to all levels for unrecognized minRelevance", () => {
    expect(relevanceLevels("invalid")).toEqual(["high", "medium", "low"]);
  });

  it("falls back to all levels for empty string", () => {
    expect(relevanceLevels("")).toEqual(["high", "medium", "low"]);
  });

  it("preserves the canonical order in the filtered result", () => {
    const result = relevanceLevels("low");
    expect(result).toEqual(["high", "medium", "low"]);
  });

  it("returns a new array each call (no mutation leak)", () => {
    const a = relevanceLevels("medium");
    const b = relevanceLevels("medium");
    expect(a).toEqual(b);
    a.push("extra");
    expect(b).not.toContain("extra");
  });
});
