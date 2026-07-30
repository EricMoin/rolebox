/// <reference types="bun-types" />

import { describe, it, expect } from "bun:test";
import {
  SIDEBAR_WIDTH,
  RULE_WIDTH_NARROW,
  INDENT,
  GLYPH_CELLS,
  VALUE_BUDGET,
  valueBudget,
  labelValue,
} from "../../src/tui/layout";

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
