/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import {
  SIDEBAR_WIDTH,
  RULE_WIDTH_NARROW,
  INDENT,
  GLYPH_CELLS,
  VALUE_BUDGET,
  ELLIPSIS,
  valueBudget,
  labelValue,
  truncateMiddle,
  wrapCells,
} from "../../src/tui/layout.ts";

describe("narrow-sidebar constants", () => {
  it("defines the expected narrow-sidebar widths", () => {
    expect(SIDEBAR_WIDTH).toBe(40);
    expect(RULE_WIDTH_NARROW).toBe(28);
    expect(VALUE_BUDGET).toBe(22);
  });

  it("defines the indent and glyph cell budget", () => {
    expect(INDENT).toBe("  ");
    expect(GLYPH_CELLS).toBe(1);
  });
});

describe("valueBudget", () => {
  it("returns the remaining cells when reserved is less than total", () => {
    expect(valueBudget(10, 4)).toBe(6);
    expect(valueBudget(22, 6)).toBe(16);
  });

  it("returns the full total when nothing is reserved", () => {
    expect(valueBudget(10, 0)).toBe(10);
  });

  it("returns zero when reserved exactly equals total", () => {
    expect(valueBudget(10, 10)).toBe(0);
  });

  it("clamps negative budgets to zero", () => {
    expect(valueBudget(10, 14)).toBe(0);
    expect(valueBudget(5, 10)).toBe(0);
    expect(valueBudget(0, 0)).toBe(0);
  });
});

describe("labelValue", () => {
  it("keeps a short value untruncated", () => {
    expect(labelValue("name", "ab", 30)).toBe("name: ab");
  });

  it("keeps a value that fits exactly at the budget untruncated", () => {
    // label "name" -> prefix "name: " (6), value budget 24, value is exactly 24 chars
    const exact = "abcdefghijklmnopqrstuvwx";
    expect(exact).toHaveLength(24);
    const result = labelValue("name", exact, 30);
    expect(result).toBe("name: abcdefghijklmnopqrstuvwx");
    expect(result).toHaveLength(30);
  });

  it("truncates a value that overflows the budget with an ellipsis", () => {
    const overflow = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    expect(overflow).toHaveLength(26);
    const result = labelValue("name", overflow, 30);
    // value budget 24 -> truncated to 23 chars + "…" == 24 cells
    expect(result).toBe("name: abcdefghijklmnopqrstuvw…");
    expect(result).toHaveLength(30);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("never exceeds the total budget when the label prefix fits", () => {
    const result = labelValue("name", "x".repeat(100), 30);
    expect(result).toHaveLength(30);
  });

  it("omits the value when the label prefix consumes the whole budget", () => {
    // label "n" -> prefix "n: " (3), value budget 0
    expect(labelValue("n", "abcdefghijklmnopqrstuvwxyz", 3)).toBe("n: ");
  });

  it("omits the value for zero budget", () => {
    expect(labelValue("name", "abcdefghijklmnopqrstuvwxyz", 0)).toBe("name: ");
  });

  it("omits the value for negative budget", () => {
    expect(labelValue("name", "abcdefghijklmnopqrstuvwxyz", -5)).toBe("name: ");
  });

  it("composed result length stays within the label prefix length even when the budget is too small", () => {
    const result = labelValue("status", "running", 2);
    expect(result).toBe("status: ");
  });
});

describe("truncateMiddle", () => {
  it("returns a value that already fits unchanged", () => {
    expect(truncateMiddle("short", 20)).toBe("short");
    expect(truncateMiddle("exactly-ten", 11)).toBe("exactly-ten");
  });

  it("keeps the head and the tail with one ellipsis between them", () => {
    const line = "[error] graph:host attempt=a2 — a very long message that does not fit at all";
    const cut = truncateMiddle(line, 30, 20);

    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut.startsWith(line.slice(0, 20))).toBe(true);
    expect(cut.endsWith(line.slice(line.length - 9))).toBe(true);
    expect(cut).toContain(ELLIPSIS);
  });

  it("never exceeds the budget, for every budget from 0 to the full length", () => {
    const value = "abcdefghijklmnopqrstuvwxyz0123456789";
    for (let budget = 0; budget <= value.length + 2; budget += 1) {
      const cut = truncateMiddle(value, budget, 4);
      expect(cut.length).toBeLessThanOrEqual(Math.max(0, budget));
    }
  });

  it("answers an empty string for a non-positive budget and a bare ellipsis for one cell", () => {
    expect(truncateMiddle("anything", 0)).toBe("");
    expect(truncateMiddle("anything", -3)).toBe("");
    expect(truncateMiddle("anything", 1)).toBe(ELLIPSIS);
  });

  it("spends a whole-cell head budget on the head, because no cells are left for a tail", () => {
    // A head of 99 cells cannot be honoured inside a 6-cell budget without
    // eating the tail as well; the budget wins, the head is clamped to it and
    // the ellipsis is the last cell.
    expect(truncateMiddle("0123456789abcdefghij", 6, 99)).toBe("01234" + ELLIPSIS);
    // With cells reserved for the ellipsis, the head keeps what it asked for
    // and the tail gets exactly the remainder: 3 + 1 + 2 = the 6-cell budget.
    expect(truncateMiddle("0123456789abcdefghij", 6, 3)).toBe("012" + ELLIPSIS + "ij");
  });
});

describe("wrapCells", () => {
  it("answers the value in one line when it fits", () => {
    expect(wrapCells("short line", 20)).toEqual(["short line"]);
  });

  it("breaks at the last space inside the budget", () => {
    expect(wrapCells("alpha beta gamma delta", 12)).toEqual(["alpha beta", "gamma delta"]);
  });

  it("breaks mid-token when there is no space to break at, and never loses a character", () => {
    const lines = wrapCells("abcdefghijklmnop", 5);
    expect(lines).toEqual(["abcde", "fghij", "klmno", "p"]);
    expect(lines.join("")).toBe("abcdefghijklmnop");
  });

  it("clamps a width below two cells so the walk always makes progress", () => {
    expect(wrapCells("abcd", 0)).toEqual(["ab", "cd"]);
    expect(wrapCells("abcd", -5)).toEqual(["ab", "cd"]);
  });
});
