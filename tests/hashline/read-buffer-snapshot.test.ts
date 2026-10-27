import { afterEach, describe, expect, it, vi } from "vitest";
import * as hash from "../../src/hashline/hash.ts";
import { createReadSnapshot, findReadLineStart, HashlineReadCache } from "../../src/hashline/read-cache.ts";

afterEach(() => vi.restoreAllMocks());

describe("Unicode LF Buffer snapshots", () => {
  const cases: Array<[string, Buffer, boolean]> = [
    ["empty", Buffer.alloc(0), false],
    ["ASCII LF", Buffer.from("alpha\nbeta\n"), false],
    ["BOM only", Buffer.from("\uFEFF"), false],
    ["BOM with ASCII", Buffer.from("\uFEFFalpha\nbeta\n"), false],
    ["Unicode LF", Buffer.from("汉字🙂\nnext\n"), true],
    ["Unicode without final newline", Buffer.from("é\n🙂"), true],
    ["BOM with Unicode", Buffer.from("\uFEFF汉字🙂\n"), true],
    ["two leading BOMs", Buffer.from("\uFEFF\uFEFFascii\n"), true],
    ["embedded BOM", Buffer.from("ascii\n\uFEFFlast"), true],
    ["Unicode CRLF", Buffer.from("汉字\r\n🙂\r\n"), false],
    ["Unicode bare CR", Buffer.from("汉字\r🙂\r"), false],
    ["mixed LF and bare CR", Buffer.from("汉字\n🙂\rnext"), false],
    ["mixed CRLF and bare CR", Buffer.from("汉字\r\n🙂\rnext\n"), false],
    ["valid replacement character", Buffer.from("\uFFFD\n"), true],
    ["invalid Unicode bytes", Buffer.concat([Buffer.from("汉字\n"), Buffer.from([0xff])]), false],
    ["truncated Unicode bytes", Buffer.from([0xf0, 0x9f]), false],
    ["all byte values", Buffer.from(Array.from({ length: 256 }, (_, i) => i)), false],
  ];

  it.each(cases)("preserves the text snapshot and limits byte hashing for %s", (_name, bytes, fast) => {
    const expected = createReadSnapshot(bytes.toString("utf8"));
    const stringVersion = vi.spyOn(hash, "computeFileVersion");
    const actual = new HashlineReadCache().get("example.txt", bytes);
    expect(actual).toEqual(expected);
    expect(stringVersion).toHaveBeenCalledTimes(fast ? 0 : 1);
  });

  it("keeps the string input path unchanged", () => {
    const raw = "汉字🙂\n";
    const expected = createReadSnapshot(raw);
    const stringVersion = vi.spyOn(hash, "computeFileVersion");
    expect(new HashlineReadCache().get("example.txt", raw)).toEqual(expected);
    expect(stringVersion).toHaveBeenCalledExactlyOnceWith(raw);
  });

  it("hashes decoded text rather than shared mutable bytes", () => {
    const source = Buffer.from("汉字🙂\n");
    const bytes = Buffer.from(new SharedArrayBuffer(source.length));
    source.copy(bytes);
    const expected = createReadSnapshot(source.toString("utf8"));
    const stringVersion = vi.spyOn(hash, "computeFileVersion");
    expect(new HashlineReadCache().get("example.txt", bytes)).toEqual(expected);
    expect(stringVersion).toHaveBeenCalledOnce();
  });

  it("uses UTF-16 checkpoint positions for large Unicode snapshots", () => {
    const lines = Array.from({ length: 1030 }, (_, i) => i % 7 === 0 ? "" : `汉字🙂${i}`);
    const raw = `\uFEFF${lines.join("\n")}\n`;
    const actual = new HashlineReadCache().get("example.txt", Buffer.from(raw));
    expect(actual).toEqual(createReadSnapshot(raw));
    let start = 0;
    for (const [index, line] of lines.entries()) {
      expect(findReadLineStart(actual, index + 1)).toBe(start);
      start += line.length + 1;
    }
  });

  it("does not retain an input Buffer or let mutations change a cached snapshot", () => {
    const cache = new HashlineReadCache();
    const bytes = Buffer.from("汉字\n");
    const first = cache.get("example.txt", bytes);
    Buffer.from("中文\n").copy(bytes);
    expect(first.content).toBe("汉字\n");
    const changed = cache.get("example.txt", bytes);
    expect(changed).not.toBe(first);
    expect(changed).toEqual(createReadSnapshot("中文\n"));
    expect(cache.get("example.txt", "中文\n")).toBe(changed);
  });

  it("reuses only the complete decoded raw text across Buffer and string calls", () => {
    const cache = new HashlineReadCache();
    const first = cache.get("example.txt", Buffer.from("\uFEFF汉字\n"));
    const stringVersion = vi.spyOn(hash, "computeFileVersion");
    expect(cache.get("example.txt", "\uFEFF汉字\n")).toBe(first);
    expect(cache.get("example.txt", Buffer.from("\uFEFF汉字\n"))).toBe(first);
    expect(stringVersion).not.toHaveBeenCalled();
    const normalized = cache.get("example.txt", Buffer.from("汉字\n"));
    expect(normalized).not.toBe(first);
    expect(normalized.version).toBe(first.version);
  });

  it("preserves decoded-text equality for different malformed byte sequences", () => {
    const cache = new HashlineReadCache();
    const first = cache.get("example.txt", Buffer.from([0xff]));
    expect(cache.get("example.txt", Buffer.from([0xfe]))).toBe(first);
    expect(cache.get("example.txt", "\uFFFD")).toBe(first);
  });

  it("retains the existing decoded-text memory budget", () => {
    const cache = new HashlineReadCache(600, 8);
    const raw = "🙂".repeat(70);
    const first = cache.get("x", Buffer.from(raw));
    expect(cache.get("x", Buffer.from(raw))).toBe(first);
    const normalized = Buffer.from(`\uFEFF${raw}`);
    expect(cache.get("x", normalized)).not.toBe(cache.get("x", normalized));
  });
});
