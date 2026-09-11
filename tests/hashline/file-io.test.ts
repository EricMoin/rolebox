import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { atomicWriteFile, atomicWriteBatch } from "../../src/hashline/atomic-write.ts";
import {
  createHashlineReadTool,
  formatReadOutput,
} from "../../src/hashline/hashline-read.ts";

// ── Helpers ───────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `hashline-test-${randomBytes(4).toString("hex")}`);
  return dir;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = tmpDir();
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    // rmSync (node:fs) is used instead of shelling out to `rm -rf`, which does not
    // exist in Windows cmd. This is a real portability fix, not a platform skip.
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── atomicWriteFile ───────────────────────────────────────────────

describe("atomicWriteFile", () => {
  it("writes content correctly to disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.txt");
      await atomicWriteFile(filePath, "hello world\n");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("hello world\n");
    });
  });

  it("overwrites existing file content", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "test.txt");
      await writeFile(filePath, "old content\n", "utf-8");
      await atomicWriteFile(filePath, "new content\n");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("new content\n");
    });
  });

  it("writes empty content", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "empty.txt");
      await atomicWriteFile(filePath, "");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("");
    });
  });

  // chmod(0o444) is a no-op for the owner on Windows — write access is governed by
  // ACLs, not POSIX mode bits — so writes to a "read-only" directory still succeed
  // there and the failure path this test exercises can never occur. POSIX-only.
  it.skipIf(process.platform === "win32")("leaves original file intact if write fails (read-only directory)", async () => {
    await withTempDir(async (dir) => {
      // Create a subdirectory and an existing file
      const subDir = join(dir, "sub");
      await mkdir(subDir, { recursive: true });
      const filePath = join(subDir, "test.txt");
      await writeFile(filePath, "original content\n", "utf-8");

      // Make subdirectory read-only so writes fail
      await chmod(subDir, 0o444);

      try {
        await atomicWriteFile(filePath, "new content\n");
        expect.unreachable("Should have thrown an error");
      } catch {
        // Restore permissions so we can read the original
        await chmod(subDir, 0o755);
        const content = await readFile(filePath, "utf-8");
        expect(content).toBe("original content\n");
      }
    });
  });

  it("creates file in non-existent directory (fails gracefully)", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "nonexistent", "test.txt");
      try {
        await atomicWriteFile(filePath, "content\n");
        expect.unreachable("Should have thrown an error");
      } catch {
        // Expected — no cleanup needed since original doesn't exist
      }
    });
  });
});

// ── atomicWriteBatch ──────────────────────────────────────────────

describe("atomicWriteBatch", () => {
  it("writes all files when all succeed", async () => {
    await withTempDir(async (dir) => {
      const files = [
        { filePath: join(dir, "a.txt"), content: "file a\n" },
        { filePath: join(dir, "b.txt"), content: "file b\n" },
        { filePath: join(dir, "c.txt"), content: "file c\n" },
      ];
      await atomicWriteBatch(files);
      for (const f of files) {
        const content = await readFile(f.filePath, "utf-8");
        expect(content).toBe(f.content);
      }
    });
  });

  // Same POSIX-only premise as the atomicWriteFile read-only test: chmod is a no-op
  // on Windows, so the read-only directory never blocks writes there and the
  // partial-failure path cannot be reached. Skipped on win32.
  it.skipIf(process.platform === "win32")("leaves all originals intact on partial failure", async () => {
    await withTempDir(async (dir) => {
      // First two files go in a writable directory
      const subDirOk = join(dir, "ok");
      await mkdir(subDirOk, { recursive: true });

      // Third file goes in a read-only directory
      const subDirRo = join(dir, "ro");
      await mkdir(subDirRo, { recursive: true });

      // Create originals
      const fileA = join(subDirOk, "a.txt");
      const fileB = join(subDirOk, "b.txt");
      const fileC = join(subDirRo, "c.txt");
      await writeFile(fileA, "original a\n", "utf-8");
      await writeFile(fileB, "original b\n", "utf-8");
      await writeFile(fileC, "original c\n", "utf-8");

      // Make the third directory read-only
      await chmod(subDirRo, 0o444);

      try {
        await atomicWriteBatch([
          { filePath: fileA, content: "new a\n" },
          { filePath: fileB, content: "new b\n" },
          { filePath: fileC, content: "new c\n" },
        ]);
        expect.unreachable("Should have thrown an error");
      } catch {
        // Restore permissions so we can verify originals
        await chmod(subDirRo, 0o755);

        expect(await readFile(fileA, "utf-8")).toBe("original a\n");
        expect(await readFile(fileB, "utf-8")).toBe("original b\n");
        expect(await readFile(fileC, "utf-8")).toBe("original c\n");

        // Temp files must not remain in the ok directory
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(subDirOk);
        const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
        expect(tmpFiles).toHaveLength(0);
      }
    });
  });

  it("handles empty batch", async () => {
    await atomicWriteBatch([]);
    // No error — no-op is fine
  });
});

// ── formatReadOutput (core logic) ─────────────────────────────────

describe("formatReadOutput", () => {
  it("returns correct annotations for simple content", () => {
    const output = formatReadOutput("line1\nline2\nline3\n", "/fake/path");
    const lines = output.split("\n");
    // header
    expect(lines[0]).toMatch(/^version: [0-9a-f]{64}$/);
    expect(lines[1]).toBe("hashWidth: 2");
    expect(lines[2]).toBe("totalLines: 3");
    // annotated lines
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|line1$/);
    expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]{2}\|line2$/);
    expect(lines[5]).toMatch(/^3#[A-Za-z0-9_-]{2}\|line3$/);
  });

  it("returns correct SHA-256 version", () => {
    const output = formatReadOutput("hello\n", "/fake/path");
    const { computeFileVersion } = require("../../src/hashline/hash.ts");
    const expectedVersion = computeFileVersion("hello\n");
    const versionLine = output.split("\n")[0];
    expect(versionLine).toBe(`version: ${expectedVersion}`);
  });

  it("handles windowed reads with correct line numbers", () => {
    const content = "a\nb\nc\nd\ne\n";
    // offset=2, limit=3 → lines 2,3,4
    const output = formatReadOutput(content, "/fake/path", 2, 3);
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^version:/);
    expect(lines[1]).toBe("hashWidth: 2");
    expect(lines[2]).toBe("totalLines: 5");
    expect(lines[3]).toBe("startLine: 2");
    expect(lines[4]).toBe("endLine: 4");
    expect(lines[5]).toMatch(/^2#[A-Za-z0-9_-]{2}\|b$/);
    expect(lines[6]).toMatch(/^3#[A-Za-z0-9_-]{2}\|c$/);
    expect(lines[7]).toMatch(/^4#[A-Za-z0-9_-]{2}\|d$/);
    expect(lines.length).toBe(8); // 3 header + 2 window + 3 annotated
  });

  it("handles window that extends beyond file length", () => {
    const content = "a\nb\nc\n";
    const output = formatReadOutput(content, "/fake/path", 2, 100);
    const lines = output.split("\n");
    expect(lines[3]).toBe("startLine: 2");
    expect(lines[4]).toBe("endLine: 3");
    expect(lines[5]).toMatch(/^2#/);
    expect(lines[6]).toMatch(/^3#/);
    expect(lines.length).toBe(7);
  });

  it("handles single-line file", () => {
    const output = formatReadOutput("only line\n", "/fake/path");
    const lines = output.split("\n");
    expect(lines[2]).toBe("totalLines: 1");
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|only line$/);
  });

  it("handles file without trailing newline", () => {
    const output = formatReadOutput("line1\nline2", "/fake/path");
    const lines = output.split("\n");
    expect(lines[2]).toBe("totalLines: 2");
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|line1$/);
    expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]{2}\|line2$/);
  });

  it("strips BOM from content", () => {
    const output = formatReadOutput("\uFEFFline1\nline2\n", "/fake/path");
    const lines = output.split("\n");
    // BOM-stripped content should hash correctly — the first line content is "line1"
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|line1$/);
  });

  it("normalizes CRLF to LF before hashing", () => {
    const output = formatReadOutput("line1\r\nline2\r\n", "/fake/path");
    const lines = output.split("\n");
    // CRLF normalized — lines should not contain \r
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|line1$/);
    expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]{2}\|line2$/);
  });

  it("handles empty file", () => {
    const output = formatReadOutput("", "/fake/path");
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^version:/);
    expect(lines[1]).toBe("hashWidth: 2");
    expect(lines[2]).toBe("totalLines: 0");
    expect(lines.length).toBe(3); // header only, no annotated lines
  });

  it("handles file with just a newline (one empty line)", () => {
    const output = formatReadOutput("\n", "/fake/path");
    const lines = output.split("\n");
    expect(lines[2]).toBe("totalLines: 1");
    expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|$/);
    expect(lines.length).toBe(4); // 3 header + 1 annotated empty line
  });
});

// ── hashline_read tool creation ───────────────────────────────────

describe("createHashlineReadTool", () => {
  it("returns a tool object with required properties", () => {
    const toolObj = createHashlineReadTool();
    expect(toolObj).toHaveProperty("description");
    expect(toolObj).toHaveProperty("args");
    expect(toolObj).toHaveProperty("execute");
    expect(typeof toolObj.description).toBe("string");
    expect(typeof toolObj.execute).toBe("function");
  });

  it("has filePath as a required string argument", () => {
    const toolObj = createHashlineReadTool();
    const filePathArg = toolObj.args.filePath;
    expect(filePathArg).toBeDefined();
    // zod string check: parse a valid string
    expect(() => filePathArg.parse("/some/path")).not.toThrow();
    // undefined should fail for required field
    expect(() => filePathArg.parse(undefined)).toThrow();
  });

  it("has offset as an optional number argument", () => {
    const toolObj = createHashlineReadTool();
    const offsetArg = toolObj.args.offset;
    expect(offsetArg).toBeDefined();
    expect(() => offsetArg.parse(5)).not.toThrow();
    // undefined should work for optional
    expect(() => offsetArg.parse(undefined)).not.toThrow();
    // negative should fail
    expect(() => offsetArg.parse(-1)).toThrow();
  });

  it("has limit as an optional number argument", () => {
    const toolObj = createHashlineReadTool();
    const limitArg = toolObj.args.limit;
    expect(limitArg).toBeDefined();
    expect(() => limitArg.parse(10)).not.toThrow();
    expect(() => limitArg.parse(undefined)).not.toThrow();
  });

  it("reads actual file content when executed", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "hello.txt");
      await writeFile(filePath, "hello world\n", "utf-8");

      const toolObj = createHashlineReadTool();
      const result = await toolObj.execute(
        { filePath },
        // Minimal context mock
        {
          sessionID: "test",
          messageID: "test",
          agent: "test",
          directory: dir,
          worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        },
      );

      // Result is a string
      expect(typeof result).toBe("string");
      const lines = (result as string).split("\n");
      expect(lines[0]).toMatch(/^version: [0-9a-f]{64}$/);
      expect(lines[1]).toBe("hashWidth: 2");
      expect(lines[2]).toBe("totalLines: 1");
      expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|hello world$/);
    });
  });

  it("returns error for non-existent file", async () => {
    const toolObj = createHashlineReadTool();
    const result = await toolObj.execute(
      { filePath: "/tmp/nonexistent-file-xyz-123.test" },
      {
        sessionID: "test",
        messageID: "test",
        agent: "test",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      },
    );

    expect(typeof result).toBe("string");
    expect(result as string).toContain("File not found");
  });

  it("handles BOM files when reading from disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "bom.txt");
      await writeFile(filePath, "\uFEFFhello\nworld\n", "utf-8");

      const toolObj = createHashlineReadTool();
      const result = await toolObj.execute(
        { filePath },
        {
          sessionID: "test", messageID: "test", agent: "test",
          directory: dir, worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {}, ask: async () => {},
        },
      );

      const lines = (result as string).split("\n");
      // BOM-stripped content: "hello" and "world"
      expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|hello$/);
      expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]{2}\|world$/);
    });
  });

  it("handles CRLF files when reading from disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "crlf.txt");
      await writeFile(filePath, "hello\r\nworld\r\n", "utf-8");

      const toolObj = createHashlineReadTool();
      const result = await toolObj.execute(
        { filePath },
        {
          sessionID: "test", messageID: "test", agent: "test",
          directory: dir, worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {}, ask: async () => {},
        },
      );

      const lines = (result as string).split("\n");
      expect(lines[3]).toMatch(/^1#[A-Za-z0-9_-]{2}\|hello$/);
      expect(lines[4]).toMatch(/^2#[A-Za-z0-9_-]{2}\|world$/);
    });
  });

  it("handles empty file when reading from disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "empty.txt");
      await writeFile(filePath, "", "utf-8");

      const toolObj = createHashlineReadTool();
      const result = await toolObj.execute(
        { filePath },
        {
          sessionID: "test", messageID: "test", agent: "test",
          directory: dir, worktree: dir,
          abort: new AbortController().signal,
          metadata: () => {}, ask: async () => {},
        },
      );

      const lines = (result as string).split("\n");
      expect(lines[0]).toMatch(/^version:/);
      expect(lines[1]).toBe("hashWidth: 2");
      expect(lines[2]).toBe("totalLines: 0");
      expect(lines.length).toBe(3);
    });
  });
});
