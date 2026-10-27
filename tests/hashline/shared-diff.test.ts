import { describe, expect, it } from "vitest";
import {
  countLineDiffs,
  generateDiffReport,
  generateUnifiedDiff,
  reanchorChangedLines,
} from "../../src/hashline/diff.ts";
import { splitLines } from "../../src/hashline/hash.ts";

const cases = [
  {
    name: "empty files",
    oldContent: "",
    newContent: "",
    expected: { diff: "", additions: 0, deletions: 0, reanchored: [] },
  },
  {
    name: "unchanged logical lines with a different final terminator",
    oldContent: "a\nb\n",
    newContent: "a\nb",
    expected: { diff: "", additions: 0, deletions: 0, reanchored: [] },
  },
  {
    name: "insertions into an empty file",
    oldContent: "",
    newContent: "a\nb\n",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,0 +1,2 @@\n+a\n+b\n",
      additions: 2,
      deletions: 0,
      reanchored: [
        { line: 1, oldAnchor: "rJz", newAnchor: "4ES", newContent: "a" },
        { line: 2, oldAnchor: "146", newAnchor: "_gW", newContent: "b" },
      ],
    },
  },
  {
    name: "complete deletion",
    oldContent: "a\nb\n",
    newContent: "",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,0 @@\n-a\n-b\n",
      additions: 0,
      deletions: 2,
      reanchored: [
        { line: 1, oldAnchor: "4ES", newAnchor: "", newContent: "" },
        { line: 2, oldAnchor: "_gW", newAnchor: "", newContent: "" },
      ],
    },
  },
  {
    name: "a replacement with context",
    oldContent: "a\nold\nc\n",
    newContent: "a\nnew\nc",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,3 +1,3 @@\n a\n-old\n+new\n c\n",
      additions: 1,
      deletions: 1,
      reanchored: [
        { line: 2, oldAnchor: "GtX", newAnchor: "", newContent: "" },
        { line: 2, oldAnchor: "GtX", newAnchor: "HoO", newContent: "new" },
      ],
    },
  },
  {
    name: "repeated lines with multiple valid alignments",
    oldContent: "a\nx\na\nx\n",
    newContent: "a\na\nx\nx\n",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,4 +1,4 @@\n a\n-x\n a\n x\n+x\n",
      additions: 1,
      deletions: 1,
      reanchored: [
        { line: 2, oldAnchor: "RZC", newAnchor: "", newContent: "" },
        { line: 4, oldAnchor: "RZC", newAnchor: "RZC", newContent: "x" },
      ],
    },
  },
  {
    name: "an inserted trailing blank line",
    oldContent: "a\n\n",
    newContent: "a\n\n\n",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,3 @@\n a\n \n+\n",
      additions: 1,
      deletions: 0,
      reanchored: [{ line: 3, oldAnchor: "0CF", newAnchor: "0CF", newContent: "" }],
    },
  },
  {
    name: "line-number-seeded symbol anchors",
    oldContent: "{\n}\n",
    newContent: "{\n;\n}\n",
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,2 +1,3 @@\n {\n+;\n }\n",
      additions: 1,
      deletions: 0,
      reanchored: [{ line: 2, oldAnchor: "B_C", newAnchor: "sNU", newContent: ";" }],
    },
  },
  {
    name: "separate hunks",
    oldContent: Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join("\n"),
    newContent: Array.from({ length: 25 }, (_, i) => i === 2 ? "X" : i === 22 ? "Y" : `L${i + 1}`).join("\n"),
    expected: {
      diff: "--- a/sample.ts\n+++ b/sample.ts\n@@ -1,6 +1,6 @@\n L1\n L2\n-L3\n+X\n L4\n L5\n L6\n@@ -20,6 +20,6 @@\n L20\n L21\n L22\n-L23\n+Y\n L24\n L25\n",
      additions: 2,
      deletions: 2,
      reanchored: [
        { line: 3, oldAnchor: "YPe", newAnchor: "", newContent: "" },
        { line: 3, oldAnchor: "YPe", newAnchor: "Ks4", newContent: "X" },
        { line: 23, oldAnchor: "7SV", newAnchor: "", newContent: "" },
        { line: 23, oldAnchor: "7SV", newAnchor: "ThN", newContent: "Y" },
      ],
    },
  },
];

describe("shared diff report compatibility", () => {
  it.each(cases)("preserves the report for $name", ({ oldContent, newContent, expected }) => {
    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);

    expect(generateDiffReport(oldLines, newLines, "sample.ts", 3)).toEqual(expected);
    expect(oldLines).toEqual(splitLines(oldContent));
    expect(newLines).toEqual(splitLines(newContent));
    expect(generateUnifiedDiff(oldContent, newContent, "sample.ts")).toBe(expected.diff);
    expect(countLineDiffs(oldContent, newContent)).toEqual({
      additions: expected.additions,
      deletions: expected.deletions,
    });
    expect(reanchorChangedLines(oldLines, newLines, 3)).toEqual(expected.reanchored);
  });
});
