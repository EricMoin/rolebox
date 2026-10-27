import { describe, expect, it } from "vitest";
import { canonicalizeFileContent, canonicalizeFileText, computeLineHash } from "../../src/hashline/hash.ts";

describe("line hash protocol compatibility", () => {
  const fixtures = [
    { content: "const x = 42;", line: 1, hashes: ["aX", "pdm", "5pdm", "ml2YZ", "aXZhlj", "pdmGWMZ", "5pdmGWMZ"] },
    { content: "}", line: 17, hashes: ["sG", "waX", "ewaX", "7BpcJ", "sGlwng", "waXCeBl", "ewaXCeBl"] },
    { content: "", line: undefined, hashes: ["zr", "Otm", "7Otm", "s62b-", "zrZv-I", "Otm-8hv", "7Otm-8hv"] },
    { content: " \t", line: 10001, hashes: ["MW", "xaR", "QxaR", "DFpEX", "MWkReh", "xaRF6GE", "QxaRF6GE"] },
    { content: "汉字１２３🙂  ", line: 999, hashes: ["yR", "JEy", "XJEy", "ckTKT", "yRMpNP", "JEyk08Y", "XJEyk08Y"] },
    { content: "a\rb\r\n", line: 4, hashes: ["4g", "iD8", "jiD8", "OIPwu", "4g-C5M", "iD8Lkw-", "jiD8Lkw-"] },
    { content: "🙂", line: 5, hashes: ["Ln", "ufn", "0ufn", "S5_fC", "Ln58KJ", "ufnwoni", "0ufnwoni"] },
    { content: "\0\ud800", line: 7, hashes: ["mM", "Ywt", "OYwt", "5jC19", "mMLX1Q", "YwtfVCw", "OYwtfVCw"] },
  ];

  for (const width of [2, 3, 4, 5, 6, 7, 8]) {
    it(`preserves existing width-${width} anchors`, () => {
      for (const fixture of fixtures) {
        expect(computeLineHash(fixture.content, width, fixture.line)).toBe(fixture.hashes[width - 2]);
      }
    });
  }
});

describe("content-only canonicalization", () => {
  it.each([
    ["", ""],
    ["\n", "\n"],
    ["a\n\n", "a\n\n"],
    ["a\rb\r", "a\nb\n"],
    ["a\r\nb\r\n", "a\nb\n"],
    ["a\rb\r\nc\n", "a\rb\nc\n"],
    ["a\n\rb\n", "a\n\nb\n"],
    ["\uFEFF", ""],
    ["\uFEFF\uFEFFa\r\n", "\uFEFFa\n"],
    ["🙂\r\n汉字\r", "🙂\n汉字\r"],
  ])("preserves canonical bytes for %j", (raw, expected) => {
    expect(canonicalizeFileContent(raw)).toBe(expected);
    expect(canonicalizeFileText(raw).content).toBe(expected);
  });
});
