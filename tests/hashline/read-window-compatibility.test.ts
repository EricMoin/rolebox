import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatReadOutput } from "../../src/hashline/hashline-read.ts";
import { computeLineHash } from "../../src/hashline/hash.ts";

const previousWidth = process.env.ROLEBOX_HASHLINE_WIDTH;

beforeAll(() => {
  delete process.env.ROLEBOX_HASHLINE_WIDTH;
});

afterAll(() => {
  if (previousWidth === undefined) delete process.env.ROLEBOX_HASHLINE_WIDTH;
  else process.env.ROLEBOX_HASHLINE_WIDTH = previousWidth;
});

function expectedOutput(
  canonical: string,
  logicalLines: string[],
  offset?: number,
  limit?: number,
): string {
  const width = logicalLines.length <= 1000 ? 2 : logicalLines.length <= 10000 ? 3 : 4;
  const output = [
    `version: ${createHash("sha256").update(canonical).digest("hex")}`,
    `hashWidth: ${width}`,
    `totalLines: ${logicalLines.length}`,
  ];
  if (logicalLines.length === 0) return output.join("\n");

  const start = Math.min(offset ?? 1, logicalLines.length);
  const end = limit === undefined ? logicalLines.length : Math.min(start + limit - 1, logicalLines.length);
  if (offset !== undefined || limit !== undefined) {
    output.push(`startLine: ${start}`, `endLine: ${end}`);
  }
  for (const [index, line] of logicalLines.slice(start - 1, end).entries()) {
    const number = start + index;
    const display = line.length > 2000 ? `${line.slice(0, 1997)}...` : line;
    output.push(`${number}#${computeLineHash(line, width, number)}|${display}`);
  }
  return output.join("\n");
}

describe("read window protocol compatibility", () => {
  const cases: Array<{ name: string; raw: string; canonical: string; lines: string[] }> = [
    { name: "empty", raw: "", canonical: "", lines: [] },
    { name: "BOM only", raw: "\uFEFF", canonical: "", lines: [] },
    { name: "one empty line", raw: "\n", canonical: "\n", lines: [""] },
    { name: "two empty lines", raw: "\n\n", canonical: "\n\n", lines: ["", ""] },
    { name: "unterminated final line", raw: "first\nlast", canonical: "first\nlast", lines: ["first", "last"] },
    { name: "terminated final line", raw: "first\nlast\n", canonical: "first\nlast\n", lines: ["first", "last"] },
    { name: "trailing blank line", raw: "first\n\n", canonical: "first\n\n", lines: ["first", ""] },
    { name: "CRLF", raw: "first\r\nlast\r\n", canonical: "first\nlast\n", lines: ["first", "last"] },
    { name: "CR only", raw: "first\rlast\r", canonical: "first\nlast\n", lines: ["first", "last"] },
    { name: "mixed CRLF and bare CR", raw: "first\r\nlast\rvalue\n", canonical: "first\nlast\rvalue\n", lines: ["first", "last\rvalue"] },
    { name: "BOM and mixed EOLs", raw: "\uFEFFfirst\nlast\r\n", canonical: "first\nlast\n", lines: ["first", "last"] },
    { name: "Unicode and symbol-only lines", raw: "汉字🙂\n}\n\t\n", canonical: "汉字🙂\n}\n\t\n", lines: ["汉字🙂", "}", "\t"] },
    { name: "embedded BOM", raw: "first\n\uFEFFlast", canonical: "first\n\uFEFFlast", lines: ["first", "\uFEFFlast"] },
  ];

  for (const fixture of cases) {
    it(`preserves headers, anchors, and window clamping for ${fixture.name}`, () => {
      for (const offset of [undefined, 1, 2, 20, Number.MAX_SAFE_INTEGER]) {
        for (const limit of [undefined, 1, 3]) {
          expect(formatReadOutput(fixture.raw, "example.txt", offset, limit)).toBe(
            expectedOutput(fixture.canonical, fixture.lines, offset, limit),
          );
        }
      }
    });
  }

  it("hashes the entire selected line even when its display is truncated", () => {
    const longLine = `${"x".repeat(2500)}hidden suffix`;
    const lines = ["first", longLine, "last"];
    const canonical = `${lines.join("\n")}\n`;
    expect(formatReadOutput(canonical, "example.txt", 2, 1)).toBe(
      expectedOutput(canonical, lines, 2, 1),
    );
  });

  for (const count of [999, 1000, 1001, 9999, 10000, 10001]) {
    it(`uses the whole ${count}-line file to choose the window's hash width`, () => {
      const lines = Array.from({ length: count }, (_, index) => `value ${index + 1}`);
      for (const ending of ["", "\n"]) {
        const canonical = lines.join("\n") + ending;
        expect(formatReadOutput(canonical, "example.txt", count - 1, 10)).toBe(
          expectedOutput(canonical, lines, count - 1, 10),
        );
      }
    });
  }
});
