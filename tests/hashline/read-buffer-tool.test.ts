import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHashlineEditTool } from "../../src/hashline/hashline-edit.ts";
import { createHashlineReadTool, formatReadOutput } from "../../src/hashline/hashline-read.ts";
import { makeToolContext } from "./fixtures/tool-context.ts";

describe("Unicode byte hashing through the read tool", () => {
  let directory: string;
  const previousWidth = process.env.ROLEBOX_HASHLINE_WIDTH;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hashline-read-buffer-"));
    delete process.env.ROLEBOX_HASHLINE_WIDTH;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (previousWidth === undefined) delete process.env.ROLEBOX_HASHLINE_WIDTH;
    else process.env.ROLEBOX_HASHLINE_WIDTH = previousWidth;
  });

  const fixtures: Array<[string, Buffer]> = [
    ["ASCII LF", Buffer.from("first\nsecond\n")],
    ["Unicode LF", Buffer.from("汉字🙂\né\n}\n")],
    ["BOM and ASCII", Buffer.from("\uFEFFfirst\nsecond\n")],
    ["BOM and Unicode", Buffer.from("\uFEFF汉字🙂\né\n")],
    ["BOM only", Buffer.from("\uFEFF")],
    ["two BOMs", Buffer.from("\uFEFF\uFEFFfirst\n")],
    ["Unicode CRLF", Buffer.from("汉字🙂\r\né\r\n")],
    ["Unicode bare CR", Buffer.from("汉字🙂\ré\n")],
    ["bare CR before a later CRLF", Buffer.from("汉\r字\n🙂\r\nlast\r")],
    ["invalid UTF-8 without CR", Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0x0a, 0xf0, 0x9f])],
  ];

  it.each(fixtures)("preserves cold and warm output for %s at every hash width", async (_name, bytes) => {
    const filePath = join(directory, "file.txt");
    await writeFile(filePath, bytes);
    const decoded = await readFile(filePath, "utf8");
    for (const width of [2, 3, 4, 5, 6, 7, 8]) {
      process.env.ROLEBOX_HASHLINE_WIDTH = String(width);
      const tool = createHashlineReadTool();
      const input = { filePath, offset: 1, limit: 3 };
      const expected = formatReadOutput(decoded, filePath, 1, 3);
      expect(await tool.execute(input, makeToolContext(directory))).toBe(expected);
      expect(await tool.execute(input, makeToolContext(directory))).toBe(expected);
    }
  });

  it("keeps UTF-16 window positions and long-line anchors after a cold Unicode read", async () => {
    const lines = Array.from({ length: 1025 }, (_, index) => index % 7 ? `${index}汉字🙂` : "");
    lines[256] = "🙂".repeat(1100) + "hidden suffix";
    const raw = `\uFEFF${lines.join("\n")}\n`;
    const filePath = join(directory, "file.txt");
    await writeFile(filePath, raw);
    const tool = createHashlineReadTool();
    for (const offset of [257, 1, 255, 511, 513, 1025, 2000]) {
      expect(await tool.execute({ filePath, offset, limit: 3 }, makeToolContext(directory))).toBe(
        formatReadOutput(raw, filePath, offset, 3),
      );
    }
  });

  it("observes same-size Unicode changes even when modification time is restored", async () => {
    const filePath = join(directory, "file.txt");
    const original = "甲🙂\n第二行\n";
    const changed = "乙🙂\n第二行\n";
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(changed));
    await writeFile(filePath, original);
    const timestamp = new Date(1700000000000);
    await utimes(filePath, timestamp, timestamp);
    const metadata = await stat(filePath);
    const tool = createHashlineReadTool();
    const first = await tool.execute({ filePath }, makeToolContext(directory));
    await writeFile(filePath, changed);
    await utimes(filePath, metadata.atime, metadata.mtime);
    const second = await tool.execute({ filePath }, makeToolContext(directory));
    expect(second).not.toBe(first);
    expect(second).toBe(formatReadOutput(changed, filePath));
    expect(await tool.execute({ filePath }, makeToolContext(directory))).toBe(second);
  });

  it.each([
    ["Unicode LF", "汉字🙂\nsecond\n", "新🙂\nsecond\n"],
    ["BOM Unicode LF", "\uFEFF汉字🙂\nsecond\n", "\uFEFF新🙂\nsecond\n"],
    ["Unicode CRLF fallback", "汉字🙂\r\nsecond\r\n", "新🙂\r\nsecond\r\n"],
  ])("provides accepted edit anchors and rejects a stale version for %s", async (_name, raw, expected) => {
    const filePath = join(directory, "file.txt");
    const context = makeToolContext(directory);
    await writeFile(filePath, raw);
    const output = String(await createHashlineReadTool().execute({ filePath }, context));
    const version = /^version: (\w+)/.exec(output)![1];
    const hashWidth = Number(/^hashWidth: (\d+)/m.exec(output)![1]);
    const pos = /^(1#[^|]+)\|/m.exec(output)![1];
    const input = { files: [{ filePath, version, hashWidth, edits: [{ op: "replace" as const, pos, lines: ["新🙂"] }] }] };
    const editTool = createHashlineEditTool();
    expect(String(await editTool.execute(input, context))).toMatch(/^version: /);
    expect(await readFile(filePath, "utf8")).toBe(expected);
    const externallyChanged = raw + "外部修改\n";
    await writeFile(filePath, externallyChanged);
    expect(String(await editTool.execute(input, context))).toContain("File version mismatch");
    expect(await readFile(filePath, "utf8")).toBe(externallyChanged);
  });
});
