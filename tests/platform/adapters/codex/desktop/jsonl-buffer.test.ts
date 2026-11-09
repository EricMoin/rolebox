import { describe, expect, it, vi } from "vitest";
import { JsonLineBuffer, JsonLineLimitError } from "../../../../../src/platform/adapters/codex/desktop/jsonl-buffer.ts";

describe("JSONL byte buffering", () => {
  it("preserves UTF-8 across chunks and splits coalesced lines before enforcing the limit", () => {
    const input = Buffer.from('中文🐋\n{}\n[]\n'); const lines: Buffer[] = [];
    const buffer = new JsonLineBuffer(10);
    buffer.write(input.subarray(0, 4), line => { lines.push(line); });
    buffer.write(input.subarray(4), line => { lines.push(line); });
    expect(lines.map(line => line.toString())).toEqual(["中文🐋", "{}", "[]"]);
  });

  it("accepts an exact-limit line and rejects an oversized unfinished line", () => {
    const buffer = new JsonLineBuffer(4); const lines: string[] = [];
    buffer.write(Buffer.from("1234\n"), line => { lines.push(line.toString()); });
    expect(lines).toEqual(["1234"]);
    buffer.write(Buffer.from("123"), () => {});
    expect(() => buffer.write(Buffer.from("45"), () => {})).toThrow(JsonLineLimitError);
  });

  it("copies a fragmented multi-megabyte line with linear total byte volume", () => {
    const input = Buffer.alloc(4 * 1024 * 1024, 120); const lines: Buffer[] = [];
    const buffer = new JsonLineBuffer(input.length); let copied = 0;
    const original = Buffer.concat;
    const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
      copied += length ?? list.reduce((sum, part) => sum + part.length, 0);
      return original(list, length);
    });
    try {
      for (let index = 0; index < input.length; index += 4096) buffer.write(input.subarray(index, index + 4096), line => { lines.push(line); });
      buffer.write(Buffer.from("\n"), line => { lines.push(line); });
    } finally { spy.mockRestore(); }
    expect(lines).toHaveLength(1); expect(lines[0]!.equals(input)).toBe(true);
    expect(copied).toBeLessThanOrEqual(input.length);
  });
});
