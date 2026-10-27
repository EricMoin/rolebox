import { describe, expect, it } from "vitest";
import { canonicalizeFileText, restoreFileText } from "../../src/hashline/hash.ts";

describe("uniform line-ending restoration", () => {
  it.each([
    { original: "a\nb\n", edited: "x\ny\n", expected: "x\ny\n" },
    { original: "a\nb", edited: "x\r\ny\n", expected: "x\r\ny\n" },
    { original: "a\nb\n", edited: "x\ry", expected: "x\ry" },
    { original: "a\r\nb\r\n", edited: "x\ny\n", expected: "x\r\ny\r\n" },
    { original: "a\r\nb", edited: "x\r\ny\r", expected: "x\r\ny\r" },
    { original: "a\r\nb", edited: "x\r\r\ny\n", expected: "x\r\r\ny\r\n" },
    { original: "a\rb\r", edited: "x\ny\nz\n", expected: "x\r\ny\r\nz\r\n" },
    { original: "\uFEFFa\n", edited: "x\n\n", expected: "\uFEFFx\n\n" },
    { original: "\uFEFFa\r\n", edited: "", expected: "\uFEFF" },
    { original: "a\nb\r\nc\n", edited: "x\ny\nz\nnew\n", expected: "x\ny\r\nz\nnew\r\n" },
  ])("preserves terminators for $original", ({ original, edited, expected }) => {
    expect(restoreFileText(edited, canonicalizeFileText(original))).toBe(expected);
  });

  it("uses the configured terminator when no original records exist", () => {
    const envelope = { content: "", hadBom: false, lineEnding: "\r\n" as const, lineEols: [] };
    expect(restoreFileText("x\n\ny\r\n", envelope)).toBe("x\r\n\r\ny\r\n");
  });
});
