import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  extractResultBlock,
  applyWindow,
  spillToFile,
  formatResultEnvelope,
  resultSidecarPath,
  writeResultSidecar,
  readResultSidecar,
  RESULT_FENCE,
  DEFAULT_MAX_RESULT_CHARS,
} from "../../src/dispatch/result-extractor.ts";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `result-extractor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── extractResultBlock ───────────────────────────────────────────────

describe("extractResultBlock", () => {
  it("extracts content from a single ```result fenced block", () => {
    const text = [
      "Some preamble",
      "```result",
      "hello world",
      "the answer is 42",
      "```",
      "Some footer",
    ].join("\n");

    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(true);
    expect(result).toBe("hello world\nthe answer is 42");
  });

  it("picks the LAST block when multiple ```result blocks exist", () => {
    const text = [
      "```result",
      "first block content",
      "```",
      "middle text",
      "```result",
      "second block content",
      "```",
      "```result",
      "final block content",
      "line two",
      "```",
    ].join("\n");

    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(true);
    expect(result).toBe("final block content\nline two");
  });

  it("returns full text with hadFence:false when no result fence present", () => {
    const text = "just some text\nno fences here";
    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(false);
    expect(result).toBe(text);
  });

  it("handles empty fenced block", () => {
    const text = ["```result", "```"].join("\n");
    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(true);
    expect(result).toBe("");
  });

  it("treats unclosed ```result block as no fence (falls back to full text)", () => {
    const text = ["```result", "some content", "but no closing fence"].join("\n");
    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(false);
    expect(result).toBe(text);
  });

  it("ignores other fenced blocks (non-result)", () => {
    const text = [
      "```json",
      '{ "key": "value" }',
      "```",
      "real content, no result fence",
    ].join("\n");

    const { result, hadFence } = extractResultBlock(text);
    expect(hadFence).toBe(false);
    expect(result).toBe(text);
  });

  it("handles empty string input", () => {
    const { result, hadFence } = extractResultBlock("");
    expect(hadFence).toBe(false);
    expect(result).toBe("");
  });
});

// ── applyWindow ──────────────────────────────────────────────────────

describe("applyWindow", () => {
  const lorem =
    "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10";

  it("returns full text when total <= maxChars", () => {
    const r = applyWindow(lorem, { maxChars: 200 });
    expect(r.text).toBe(lorem);
    expect(r.truncated).toBe(false);
    expect(r.totalChars).toBe(lorem.length);
    expect(r.returnedChars).toBe(lorem.length);
    expect(r.nextOffset).toBeUndefined();
  });

  it("truncates from head with default limit = maxChars", () => {
    const r = applyWindow(lorem, { maxChars: 20 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
    expect(r.text).toBe(lorem.slice(0, 20));
    expect(r.returnedChars).toBe(20);
    expect(r.nextOffset).toBe(20);
  });

  it("respects explicit offset and limit in head mode", () => {
    const r = applyWindow(lorem, { maxChars: 20, offset: 7, limit: 10 });
    expect(r.text).toBe(lorem.slice(7, 7 + 10));
    expect(r.returnedChars).toBe(10);
    expect(r.totalChars).toBe(lorem.length - 7);
    expect(r.nextOffset).toBe(17);
    expect(r.truncated).toBe(true);
  });

  it("caps returned chars to maxChars even when limit > maxChars", () => {
    const r = applyWindow(lorem, { maxChars: 5, offset: 0, limit: 100 });
    expect(r.text.length).toBe(5);
    expect(r.returnedChars).toBe(5);
    expect(r.nextOffset).toBe(5);
  });

  it("tail mode returns last maxChars chars", () => {
    const r = applyWindow(lorem, { maxChars: 15, tail: true });
    expect(r.text).toBe(lorem.slice(-15));
    expect(r.returnedChars).toBe(15);
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(lorem.length);
    expect(r.nextOffset).toBeUndefined();
  });

  it("tail mode with maxChars >= length returns full text, not truncated", () => {
    const r = applyWindow(lorem, { maxChars: 500, tail: true });
    expect(r.text).toBe(lorem);
    expect(r.truncated).toBe(false);
    expect(r.returnedChars).toBe(lorem.length);
  });

  it("returns empty string when offset >= text length", () => {
    const r = applyWindow(lorem, { maxChars: 50, offset: 9999 });
    expect(r.text).toBe("");
    expect(r.returnedChars).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.nextOffset).toBeUndefined();
  });

  it("offset defaults to 0, limit defaults to maxChars", () => {
    const r = applyWindow(lorem, { maxChars: 8 });
    expect(r.text).toBe(lorem.slice(0, 8));
    expect(r.returnedChars).toBe(8);
    expect(r.nextOffset).toBe(8);
  });

  it("does not set nextOffset when all chars from offset are returned", () => {
    // offset 60 on a 69-char string: remaining = 9, limit defaults to 50, ret=9
    const r = applyWindow(lorem, { maxChars: 50, offset: 60 });
    expect(r.truncated).toBe(false);
    expect(r.nextOffset).toBeUndefined();
  });
});

// ── spillToFile ──────────────────────────────────────────────────────

describe("spillToFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("writes content atomically to {dir}/state/results/{taskId}.txt", () => {
    const content = "result payload content";
    const path = spillToFile("task-abc", content, testDir);
    expect(path).toContain(join(".rolebox", "state", "results", "task-abc.txt"));
    expect(fs.existsSync(path)).toBe(true);
    const readBack = fs.readFileSync(path, "utf-8");
    expect(readBack).toBe(content);
  });

  it("creates parent directories automatically", () => {
    const path = spillToFile("task-xyz", "hello", testDir);
    expect(fs.existsSync(path)).toBe(true);
    // The state/results dir should exist
    const resultsDir = join(testDir, ".rolebox", "state", "results");
    expect(fs.existsSync(resultsDir)).toBe(true);
  });

  it("returns the absolute path", () => {
    const path = spillToFile("task-123", "data", testDir);
    expect(path.startsWith("/")).toBe(true);
    expect(path).toBe(join(testDir, ".rolebox", "state", "results", "task-123.txt"));
  });

  it("overwrites existing file (idempotent)", () => {
    const path1 = spillToFile("task-overwrite", "first write", testDir);
    const path2 = spillToFile("task-overwrite", "second write", testDir);
    expect(path1).toBe(path2);
    const readBack = fs.readFileSync(path2, "utf-8");
    expect(readBack).toBe("second write");
  });

  it("handles content with special characters / newlines", () => {
    const content = "line1\nline2\n\tindented\n```result\nnested fence\n```";
    const path = spillToFile("task-special", content, testDir);
    const readBack = fs.readFileSync(path, "utf-8");
    expect(readBack).toBe(content);
  });
});

// ── formatResultEnvelope ─────────────────────────────────────────────

describe("formatResultEnvelope", () => {
  it("includes truncated, returnedChars, totalChars", () => {
    const env = formatResultEnvelope({
      truncated: true,
      returnedChars: 100,
      totalChars: 500,
    });
    expect(env).toContain("truncated");
    expect(env).toContain("100");
    expect(env).toContain("500");
  });

  it("includes nextOffset when provided", () => {
    const env = formatResultEnvelope({
      truncated: true,
      returnedChars: 200,
      totalChars: 800,
      nextOffset: 200,
    });
    expect(env).toContain("next_offset");
    expect(env).toContain("200");
  });

  it("includes file path and hint when spilled", () => {
    const env = formatResultEnvelope({
      truncated: true,
      returnedChars: 50,
      totalChars: 1000,
      spilledFile: "/tmp/state/results/task-1.txt",
    });
    expect(env).toContain("/tmp/state/results/task-1.txt");
    expect(env).toContain("truncated");
    expect(env).toContain("offset");
    expect(env).toContain("limit");
  });

  it("works for non-truncated results", () => {
    const env = formatResultEnvelope({
      truncated: false,
      returnedChars: 42,
      totalChars: 42,
    });
    expect(env).not.toContain("truncated");
    // Should still have length info
    expect(env).toContain("42");
  });
});

// ── sidecar helpers ────────────────────────────────────────────────

describe("sidecar helpers", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("resultSidecarPath builds correct path", () => {
    const path = resultSidecarPath("task-sidecar", testDir);
    expect(path).toBe(join(testDir, ".rolebox", "state", "results", "task-sidecar.txt"));
    // Does not touch the filesystem
    expect(fs.existsSync(path)).toBe(false);
  });

  it("round-trip: write then read returns identical text", () => {
    const content = "sidecar result data\nwith multiple\nlines";
    const writtenPath = writeResultSidecar("roundtrip", content, testDir);
    const readBack = readResultSidecar(writtenPath);
    expect(readBack).toBe(content);
  });

  it("missing file returns null (no throw)", () => {
    const path = join(testDir, ".rolebox", "state", "results", "nonexistent.txt");
    const result = readResultSidecar(path);
    expect(result).toBeNull();
  });

  it("overwrite works (idempotent write)", () => {
    const path1 = writeResultSidecar("idempotent", "first", testDir);
    const path2 = writeResultSidecar("idempotent", "second", testDir);
    expect(path1).toBe(path2);
    const readBack = readResultSidecar(path2);
    expect(readBack).toBe("second");
  });

  it("writeResultSidecar returns absolute path", () => {
    const path = writeResultSidecar("abs-path", "data", testDir);
    expect(path.startsWith("/")).toBe(true);
    expect(fs.existsSync(path)).toBe(true);
  });

  it("readResultSidecar throws for non-ENOENT errors", () => {
    // Passing a directory instead of a file produces an EISDIR error
    const dirPath = join(testDir, ".rolebox", "state", "results");
    fs.mkdirSync(dirPath, { recursive: true });
    expect(() => readResultSidecar(dirPath)).toThrow();
  });
});

// ── Constants ────────────────────────────────────────────────────────

describe("constants", () => {
  it("RESULT_FENCE equals 'result'", () => {
    expect(RESULT_FENCE).toBe("result");
  });

  it("DEFAULT_MAX_RESULT_CHARS equals 16000", () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBe(16000);
  });
});
