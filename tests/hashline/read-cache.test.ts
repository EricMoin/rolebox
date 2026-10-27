import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHashlineReadTool, formatReadOutput } from "../../src/hashline/hashline-read.ts";
import { createReadSnapshot, findReadLineStart, HashlineReadCache } from "../../src/hashline/read-cache.ts";
import { makeToolContext } from "./fixtures/tool-context.ts";

describe("bounded read snapshot cache", () => {
  it("reuses only an exact raw-text match", () => {
    const cache = new HashlineReadCache();
    const first = cache.get("file.txt", "a\r\nb\r\n");
    expect(cache.get("file.txt", ["a\r\n", "b\r\n"].join(""))).toBe(first);
    const changed = cache.get("file.txt", "a\nb\n");
    expect(changed).not.toBe(first);
    expect(changed.version).toBe(first.version);
    expect(cache.get("file.txt", "a\nc\n").version).not.toBe(first.version);
  });

  it("evicts the least recently used path at the entry limit", () => {
    const cache = new HashlineReadCache(4096, 2);
    const first = cache.get("first", "a");
    const second = cache.get("second", "b");
    expect(cache.get("first", "a")).toBe(first);
    cache.get("third", "c");
    expect(cache.get("second", "b")).not.toBe(second);
  });

  it("evicts at the retained-text budget independently of the entry limit", () => {
    const cache = new HashlineReadCache(1024, 8);
    const raw = "x".repeat(150);
    const first = cache.get("first", raw);
    cache.get("second", raw);
    expect(cache.get("first", raw)).not.toBe(first);
  });

  it("bypasses oversized files without evicting unrelated useful snapshots", () => {
    const cache = new HashlineReadCache(1024, 8);
    const small = cache.get("small", "ok");
    const large = "x".repeat(1024);
    expect(cache.get("large", large)).not.toBe(cache.get("large", large));
    expect(cache.get("small", "ok")).toBe(small);
  });

  it("charges both UTF-16 units of non-BMP characters", () => {
    const cache = new HashlineReadCache(512, 8);
    const ascii = "x".repeat(70);
    const unicode = "🙂".repeat(70);
    expect(cache.get("a", ascii)).toBe(cache.get("a", ascii));
    expect(cache.get("b", unicode)).not.toBe(cache.get("b", unicode));
  });

  it("charges separately retained normalized content", () => {
    const cache = new HashlineReadCache(900, 8);
    const crlf = "a\r\n".repeat(70);
    expect(cache.get("file", crlf)).not.toBe(cache.get("file", crlf));
    const lf = "a\n".repeat(70);
    expect(cache.get("file", lf)).toBe(cache.get("file", lf));
  });

  it("reclaims a changed path's entry and removes explicitly invalidated paths", () => {
    const cache = new HashlineReadCache(800, 8);
    const old = cache.get("file", "a".repeat(200));
    const replacement = cache.get("file", "b".repeat(200));
    expect(replacement).not.toBe(old);
    expect(cache.get("file", "b".repeat(200))).toBe(replacement);
    cache.delete("file");
    expect(cache.get("file", "b".repeat(200))).not.toBe(replacement);
  });

  it("indexes Unicode and empty lines across checkpoint boundaries", () => {
    const lines = Array.from({ length: 1025 }, (_, i) => i % 3 === 0 ? "" : `🙂${i}`);
    const content = `${lines.join("\n")}\n`;
    const snapshot = createReadSnapshot(content);
    expect(snapshot.totalLines).toBe(lines.length);
    for (const line of [1, 255, 256, 257, 511, 512, 513, 1024, 1025]) {
      const start = findReadLineStart(snapshot, line);
      const end = content.indexOf("\n", start);
      expect(content.slice(start, end)).toBe(lines[line - 1]);
    }
  });
});

describe("cached reads still observe the filesystem", () => {
  let directory: string;
  const previousWidth = process.env.ROLEBOX_HASHLINE_WIDTH;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hashline-read-cache-"));
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previousWidth === undefined) delete process.env.ROLEBOX_HASHLINE_WIDTH;
    else process.env.ROLEBOX_HASHLINE_WIDTH = previousWidth;
  });

  it("observes same-size external changes even when mtime is restored", async () => {
    const file = join(directory, "file.txt");
    const tool = createHashlineReadTool();
    const context = makeToolContext(directory);
    await writeFile(file, "alpha\nbeta\n");
    const metadata = await stat(file);
    const first = await tool.execute({ filePath: file }, context);
    await writeFile(file, "ALPHA\nbeta\n");
    await utimes(file, metadata.atime, metadata.mtime);
    const second = await tool.execute({ filePath: file }, context);
    expect(second).not.toBe(first);
    expect(second).toBe(formatReadOutput("ALPHA\nbeta\n", file));
  });

  it("observes replacement, deletion and recreation rather than serving cached content", async () => {
    const file = join(directory, "file.txt");
    const replacement = join(directory, "replacement.txt");
    const tool = createHashlineReadTool();
    const context = makeToolContext(directory);
    await writeFile(file, "old\n");
    await tool.execute({ filePath: file }, context);
    await writeFile(replacement, "new\n");
    await rename(replacement, file);
    expect(await tool.execute({ filePath: file }, context)).toBe(formatReadOutput("new\n", file));
    await rm(file);
    expect(await tool.execute({ filePath: file }, context)).toBe(`Error: File not found: ${file}`);
    await writeFile(file, "again\n");
    expect(await tool.execute({ filePath: file }, context)).toBe(formatReadOutput("again\n", file));
  });

  it("recomputes hash width for a cached snapshot when the override changes", async () => {
    const file = join(directory, "file.txt");
    const tool = createHashlineReadTool();
    const context = makeToolContext(directory);
    await writeFile(file, "alpha\n}\n");
    const first = await tool.execute({ filePath: file, offset: 2, limit: 1 }, context);
    expect(first).toContain("hashWidth: 2");
    process.env.ROLEBOX_HASHLINE_WIDTH = "8";
    const second = await tool.execute({ filePath: file, offset: 2, limit: 1 }, context);
    expect(second).toContain("hashWidth: 8");
    expect(second).toBe(formatReadOutput("alpha\n}\n", file, 2, 1));
  });

  it("serves different windows from one snapshot with the existing EOF clamp", async () => {
    const file = join(directory, "file.txt");
    const raw = `\uFEFF${Array.from({ length: 1200 }, (_, i) => `line ${i}`).join("\r\n")}\r\n\r\n`;
    await writeFile(file, raw);
    const tool = createHashlineReadTool();
    const context = makeToolContext(directory);
    for (const offset of [1, 257, 800, 1201, 2000]) {
      expect(await tool.execute({ filePath: file, offset, limit: 3 }, context)).toBe(
        formatReadOutput(raw, file, offset, 3),
      );
    }
  });
});
