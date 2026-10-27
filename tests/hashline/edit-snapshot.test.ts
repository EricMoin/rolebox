import { describe, expect, it } from "vitest";
import { applyEditsToLinesWithReport, applyEditsWithReport } from "../../src/hashline/edit-primitives.ts";
import { computeLineHash } from "../../src/hashline/hash.ts";
import type { EditOp } from "../../src/hashline/types.ts";

function ref(lines: string[], index: number): string {
  return `${index + 1}#${computeLineHash(lines[index], 3, index + 1)}`;
}

describe("shared edit snapshot", () => {
  it("keeps the input snapshot immutable across same-line edits and repeated invocations", () => {
    const original = ["first", "middle", "last"];
    const edits: EditOp[] = [
      { op: "replace", pos: ref(original, 1), lines: "updated" },
      { op: "append", pos: ref(original, 1), lines: "inserted" },
    ];
    const expected = { content: "first\nupdated\ninserted\nlast", noopEdits: 0, deduplicatedEdits: 0 };
    expect(applyEditsToLinesWithReport(original, edits, 3)).toEqual(expected);
    expect(original).toEqual(["first", "middle", "last"]);
    expect(applyEditsToLinesWithReport(original, edits, 3)).toEqual(expected);
    expect(applyEditsWithReport(`${original.join("\n")}\n`, edits, 3)).toEqual(expected);
  });

  it("preserves noop and dedup counts without copying the before snapshot", () => {
    const original = ["first", "middle", "last"];
    const unchanged: EditOp = { op: "replace", pos: ref(original, 1), lines: "middle" };
    expect(applyEditsToLinesWithReport(original, [unchanged, unchanged, { op: "append", lines: [] }], 3)).toEqual({
      content: "first\nmiddle\nlast", noopEdits: 2, deduplicatedEdits: 1,
    });
    expect(original).toEqual(["first", "middle", "last"]);
  });

  it("rejects stale anchors without mutating the shared snapshot", () => {
    const original = ["first", "middle", "last"];
    const edits: EditOp[] = [{ op: "replace", pos: `2#${computeLineHash("stale", 3, 2)}`, lines: "updated" }];
    expect(() => applyEditsToLinesWithReport(original, edits, 3)).toThrow();
    expect(original).toEqual(["first", "middle", "last"]);
  });
});
