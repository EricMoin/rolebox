import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  extractResultBlock,
  applyWindow,
  spillToFile,
  formatResultEnvelope,
  resultSidecarPath,
  writeResultSidecar,
  readResultSidecar,
  readSidecarWindow,
  readSidecarTail,
  applySidecarWindow,
  resultSidecarExists,
  cleanupOrphanSidecars,
  ORPHAN_SIDECAR_RETENTION_MS,
  RESULT_FENCE,
  DEFAULT_MAX_RESULT_CHARS,
} from "../../src/dispatch/completion/result-extractor.ts";
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

// ── sidecar windowing ───────────────────────────────────────────────

describe("readSidecarWindow", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("reads the requested window from a sidecar file", () => {
    const content = "line 0\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9";
    const path = writeResultSidecar("window-test", content, testDir);

    const window = readSidecarWindow(path, 7, 10);
    expect(window).not.toBeNull();
    // Byte 7 is 'l' (start of "line 1"); reading 10+4=14 bytes → "line 1\nline 2\nli" trimmed to 10 chars
    expect(window).toBe("line 1\nlin");
  });

  it("returns null for missing sidecar file", () => {
    const result = readSidecarWindow("/nonexistent/path.txt", 0, 100);
    expect(result).toBeNull();
  });

  it("returns empty string when offset is past file end", () => {
    const content = "short text";
    const path = writeResultSidecar("offset-past", content, testDir);
    const result = readSidecarWindow(path, 9999, 100);
    expect(result).toBe("");
  });

  it("returns remaining text when window extends beyond file end", () => {
    const content = "hello world";
    const path = writeResultSidecar("beyond-end", content, testDir);
    const result = readSidecarWindow(path, 6, 100);
    expect(result).toBe("world");
  });

  it("returns full file when limit exceeds file size at offset 0", () => {
    const content = "abcdefghij";
    const path = writeResultSidecar("full-read", content, testDir);
    const result = readSidecarWindow(path, 0, 99999);
    expect(result).toBe(content);
  });

  it("handles empty file gracefully", () => {
    const path = writeResultSidecar("empty", "", testDir);
    const result = readSidecarWindow(path, 0, 10);
    expect(result).toBe("");
  });

  it("handles large file reads efficiently", () => {
    // Generate ~500KB of ASCII text
    const line = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n";
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) lines.push(line);
    const bigContent = lines.join("");
    expect(Buffer.byteLength(bigContent)).toBeGreaterThanOrEqual(500 * 1024); // >500KB

    const path = writeResultSidecar("large", bigContent, testDir);

    // Read a small window from offset ~300KB
    const window = readSidecarWindow(path, 300 * 1024, 50);
    expect(window).not.toBeNull();
    expect(window!.length).toBe(50);
    expect(window).toBe(bigContent.slice(300 * 1024, 300 * 1024 + 50));
  });
});

describe("readSidecarTail", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("reads the last N characters from a sidecar file", () => {
    const content = "line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9";
    const path = writeResultSidecar("tail-test", content, testDir);

    const tail = readSidecarTail(path, 7);
    expect(tail).not.toBeNull();
    // Last 7 chars of "line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9" (59 chars)
    expect(tail).toBe(content.slice(-7));
    expect(tail).toBe("8\nline9");
  });

  it("returns full content when tailBytes >= file size", () => {
    const content = "short";
    const path = writeResultSidecar("tail-full", content, testDir);
    const tail = readSidecarTail(path, 99999);
    expect(tail).toBe(content);
  });

  it("returns null for missing file", () => {
    const result = readSidecarTail("/nonexistent.txt", 100);
    expect(result).toBeNull();
  });

  it("returns empty string for empty file", () => {
    const path = writeResultSidecar("tail-empty", "", testDir);
    const result = readSidecarTail(path, 10);
    expect(result).toBe("");
  });

  it("verifies tail content against known string", () => {
    const content = "the quick brown fox jumps over the lazy dog";
    const path = writeResultSidecar("tail-known", content, testDir);
    const tail = readSidecarTail(path, 20);
    // Content is 43 chars, last 20 chars = positions 23-42 = "ps over the lazy dog"
    expect(tail).toBe(content.slice(-20));
    expect(tail!.length).toBe(20);
  });

  it("handles large file tail efficiently", () => {
    // Generate ~500KB of text
    const line = "abcdefghijklmnopqrstuvwxyz0123456789\n";
    const lines: string[] = [];
    for (let i = 0; i < 16000; i++) lines.push(line);
    const bigContent = lines.join("");
    expect(Buffer.byteLength(bigContent)).toBeGreaterThanOrEqual(500 * 1024);

    const path = writeResultSidecar("large-tail", bigContent, testDir);

    // Read last 100 chars
    const tail = readSidecarTail(path, 100);
    expect(tail).not.toBeNull();
    expect(tail!.length).toBe(100);
    expect(tail).toBe(bigContent.slice(-100));
  });
});

describe("applySidecarWindow", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("reads a window with offset and limit", () => {
    const content = "abcdefghijklmnopqrstuvwxyz";
    const path = writeResultSidecar("aw-window", content, testDir);

    const result = applySidecarWindow(path, { maxChars: 100, offset: 5, limit: 5 }, content.length);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("fghij");
    expect(result!.returnedChars).toBe(5);
    expect(result!.truncated).toBe(true);
    expect(result!.totalChars).toBe(content.length - 5);
    expect(result!.nextOffset).toBe(10);
  });

  it("tail mode reads last N chars", () => {
    const content = "abcdefghijklmnopqrstuvwxyz";
    const path = writeResultSidecar("aw-tail", content, testDir);

    const result = applySidecarWindow(path, { maxChars: 5, tail: true }, content.length);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("vwxyz");
    expect(result!.returnedChars).toBe(5);
    expect(result!.truncated).toBe(true);
    expect(result!.totalChars).toBe(content.length);
  });

  it("tail mode with maxChars >= total returns full content, not truncated", () => {
    const content = "hello world";
    const path = writeResultSidecar("aw-tail-full", content, testDir);

    const result = applySidecarWindow(path, { maxChars: 999, tail: true }, content.length);
    expect(result).not.toBeNull();
    expect(result!.text).toBe(content);
    expect(result!.truncated).toBe(false);
    expect(result!.returnedChars).toBe(content.length);
  });

  it("returns null for missing sidecar", () => {
    const result = applySidecarWindow("/nonexistent.txt", { maxChars: 100 }, 1000);
    expect(result).toBeNull();
  });

  it("returns empty string for offset past end", () => {
    const content = "short";
    const path = writeResultSidecar("aw-past", content, testDir);

    const result = applySidecarWindow(path, { maxChars: 100, offset: 9999 }, content.length);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("");
    expect(result!.returnedChars).toBe(0);
    expect(result!.truncated).toBe(false);
    expect(result!.totalChars).toBe(0);
  });

  it("streams a window from a large (500KB+) sidecar", () => {
    // Generate ~500KB of ASCII text
    const line = "the quick brown fox jumps over the lazy dog. ";
    const lines: string[] = [];
    for (let i = 0; i < 12000; i++) lines.push(line);
    const bigContent = lines.join("");
    expect(Buffer.byteLength(bigContent)).toBeGreaterThanOrEqual(500 * 1024);

    const path = writeResultSidecar("aw-large", bigContent, testDir);

    // Read window from offset ~300KB, limit 1000
    const result = applySidecarWindow(path, { maxChars: 16000, offset: 300 * 1024, limit: 1000 }, bigContent.length);
    expect(result).not.toBeNull();
    expect(result!.text.length).toBe(1000);
    expect(result!.text).toBe(bigContent.slice(300 * 1024, 300 * 1024 + 1000));
    // Verify correct window content — should match slice at offset 300KB
    expect(result!.text[0]).toBe(bigContent[300 * 1024]);
    expect(result!.text[999]).toBe(bigContent[300 * 1024 + 999]);
  });
});

describe("resultSidecarExists", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir();
  });

  afterEach(() => {
    cleanupDir(testDir);
  });

  it("returns true when file exists", () => {
    const path = writeResultSidecar("exists-test", "hello", testDir);
    expect(resultSidecarExists(path)).toBe(true);
  });

  it("returns false when file does not exist", () => {
    const path = join(testDir, ".rolebox", "state", "results", "nonexistent.txt");
    expect(resultSidecarExists(path)).toBe(false);
  });

  it("returns false after file is deleted", () => {
    const path = writeResultSidecar("delete-test", "data", testDir);
    expect(resultSidecarExists(path)).toBe(true);
    fs.unlinkSync(path);
    expect(resultSidecarExists(path)).toBe(false);
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

// ── Orphan sidecar cleanup ─────────────────────────────────────────

describe("cleanupOrphanSidecars", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("deletes orphan sidecar file older than retention", () => {
    // Create a sidecar file for a task that doesn't exist
    writeResultSidecar("orphan-task", "orphan data", testDir);
    const filePath = resultSidecarPath("orphan-task", testDir);
    expect(fs.existsSync(filePath)).toBe(true);

    // Set mtime to well past retention
    const oldTime = new Date(Date.now() - ORPHAN_SIDECAR_RETENTION_MS - 60_000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const cleaned = cleanupOrphanSidecars(
      testDir,
      new Set<string>(),  // no active tasks
      ORPHAN_SIDECAR_RETENTION_MS,
    );

    expect(cleaned).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("preserves files for known active tasks", () => {
    writeResultSidecar("active-task", "active data", testDir);
    const filePath = resultSidecarPath("active-task", testDir);

    const cleaned = cleanupOrphanSidecars(
      testDir,
      new Set(["active-task"]),
      ORPHAN_SIDECAR_RETENTION_MS,
    );

    expect(cleaned).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("preserves recent orphan files within retention period", () => {
    writeResultSidecar("recent-orphan", "recent data", testDir);
    const filePath = resultSidecarPath("recent-orphan", testDir);

    const cleaned = cleanupOrphanSidecars(
      testDir,
      new Set<string>(),
      ORPHAN_SIDECAR_RETENTION_MS,
    );

    // File was just written, should be within retention
    expect(cleaned).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("is a no-op when results directory does not exist", () => {
    const cleaned = cleanupOrphanSidecars(
      "/tmp/nonexistent-dir-orphan-test",
      new Set<string>(),
      ORPHAN_SIDECAR_RETENTION_MS,
    );

    expect(cleaned).toBe(0);
  });

  it("handles mixed: deletes old orphans, preserves active and recent", () => {
    // Active task (not orphan)
    writeResultSidecar("active-1", "active data", testDir);
    // Recent orphan (within retention)
    writeResultSidecar("recent-orphan", "recent data", testDir);
    // Old orphan (should be deleted)
    writeResultSidecar("old-orphan", "old data", testDir);
    const oldFilePath = resultSidecarPath("old-orphan", testDir);
    const oldTime = new Date(Date.now() - ORPHAN_SIDECAR_RETENTION_MS - 60_000);
    fs.utimesSync(oldFilePath, oldTime, oldTime);

    const cleaned = cleanupOrphanSidecars(
      testDir,
      new Set(["active-1"]),
      ORPHAN_SIDECAR_RETENTION_MS,
    );

    expect(cleaned).toBe(1);
    // Active file preserved
    expect(fs.existsSync(resultSidecarPath("active-1", testDir))).toBe(true);
    // Recent orphan preserved
    expect(fs.existsSync(resultSidecarPath("recent-orphan", testDir))).toBe(true);
    // Old orphan deleted
    expect(fs.existsSync(oldFilePath)).toBe(false);
  });
});
