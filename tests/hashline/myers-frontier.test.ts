import { describe, expect, it } from "vitest";
import { myersDiff } from "../../src/hashline/myers-diff.ts";

describe("compact Myers frontiers", () => {
  it("preserves the existing alignment when repeated lines permit multiple shortest paths", () => {
    expect(myersDiff(["a", "b"], ["b", "a"])).toEqual([
      { op: "delete", oldLine: 1, content: "a" },
      { op: "equal", oldLine: 2, newLine: 1, content: "b" },
      { op: "insert", newLine: 2, content: "a" },
    ]);
    expect(myersDiff(["a", "a", "b"], ["a", "b", "a"])).toEqual([
      { op: "equal", oldLine: 1, newLine: 1, content: "a" },
      { op: "delete", oldLine: 2, content: "a" },
      { op: "equal", oldLine: 3, newLine: 2, content: "b" },
      { op: "insert", newLine: 3, content: "a" },
    ]);
  });

  it("backtracks insertions and deletions at both file boundaries", () => {
    expect(myersDiff(["a"], ["x", "a", "x"])).toEqual([
      { op: "insert", newLine: 1, content: "x" },
      { op: "equal", oldLine: 1, newLine: 2, content: "a" },
      { op: "insert", newLine: 3, content: "x" },
    ]);
    expect(myersDiff(["x", "a", "x"], ["a"])).toEqual([
      { op: "delete", oldLine: 1, content: "x" },
      { op: "equal", oldLine: 2, newLine: 1, content: "a" },
      { op: "delete", oldLine: 3, content: "x" },
    ]);
  });

  it("reports only the changed line in a large file without changing surrounding positions", () => {
    const oldLines = Array.from({ length: 100000 }, (_, i) => `value ${i}`);
    const newLines = oldLines.slice();
    newLines[50000] = "changed";
    const entries = myersDiff(oldLines, newLines);
    expect(entries).toHaveLength(100001);
    expect(entries.slice(49999, 50003)).toEqual([
      { op: "equal", oldLine: 50000, newLine: 50000, content: "value 49999" },
      { op: "delete", oldLine: 50001, content: "value 50000" },
      { op: "insert", newLine: 50001, content: "changed" },
      { op: "equal", oldLine: 50002, newLine: 50002, content: "value 50001" },
    ]);
    expect(entries.at(-1)).toEqual({ op: "equal", oldLine: 100000, newLine: 100000, content: "value 99999" });
  });
});
