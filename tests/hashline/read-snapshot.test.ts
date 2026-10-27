import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeFileContent, splitLines } from "../../src/hashline/hash.ts";
import { createReadSnapshot, findReadLineStart } from "../../src/hashline/read-cache.ts";

function expectSnapshot(raw: string, content: string): void {
  const snapshot = createReadSnapshot(raw);
  const lines = splitLines(content);
  expect(snapshot.content).toBe(content);
  expect(snapshot.version).toBe(createHash("sha256").update(content).digest("hex"));
  expect(snapshot.totalLines).toBe(lines.length);
  expect(snapshot.lineStarts).toHaveLength(Math.ceil(lines.length / 256));
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    expect(findReadLineStart(snapshot, i + 1)).toBe(start);
    start += lines[i].length + 1;
  }
}

describe("read snapshot canonicalization", () => {
  it("strips exactly one leading BOM on the LF fast path", () => {
    expectSnapshot("\uFEFF\uFEFFfirst\n\uFEFFlast\n", "\uFEFFfirst\n\uFEFFlast\n");
    expectSnapshot("\uFEFF", "");
  });

  it("keeps CRLF precedence when a bare CR occurs before or after a CRLF", () => {
    expectSnapshot("\uFEFFfirst\rvalue\nsecond\r\nthird\r", "first\rvalue\nsecond\nthird\r");
    expectSnapshot("\uFEFF\uFEFFfirst\r\nlast\r", "\uFEFFfirst\nlast\r");
  });

  it("normalizes bare CR when LF is present but CRLF is absent", () => {
    expectSnapshot("first\nsecond\rlast\r", "first\nsecond\nlast\n");
  });

  it("matches the canonical text contract for all short delimiter and surrogate combinations", () => {
    const alphabet = ["a", "\r", "\n", "\uFEFF", "\ud800", "\udc00"];
    let samples = [""];
    for (let length = 0; length <= 4; length++) {
      for (const raw of samples) expectSnapshot(raw, canonicalizeFileContent(raw));
      samples = samples.flatMap((prefix) => alphabet.map((character) => prefix + character));
    }
  });

  it("retains UTF-16 checkpoint positions with mixed EOLs, blank lines and Unicode", () => {
    const lines = Array.from({ length: 1030 }, (_, i) => {
      if (i % 7 === 0) return "";
      return `${i}\u0000汉字🙂\ud800\udc00\ud800`;
    });
    const lf = `${lines.join("\n")}\n`;
    expectSnapshot(lf, lf);
    const mixed = lines.map((line, i) => line + (i % 3 === 0 ? "\r\n" : "\n")).join("");
    expectSnapshot(mixed, lf);
    const legacy = lines.join("\r");
    expectSnapshot(legacy, lines.join("\n"));
  });
});
