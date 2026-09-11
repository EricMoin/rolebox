import { describe, it, expect } from "bun:test";
import {
  myersDiff,
  reanchorChangedLines,
  generateUnifiedDiff,
  countLineDiffs,
  UNIFIED_DIFF_CONTEXT,
} from "../../src/hashline/diff.ts";
import type { DiffEntry } from "../../src/hashline/diff.ts";
import {
  findNearbyMatch,
  suggestCorrectAnchor,
  detectUniformOffset,
} from "../../src/hashline/fuzzy.ts";
import { computeLineHash } from "../../src/hashline/hash.ts";
import { FUZZY_SEARCH_WINDOW } from "../../src/hashline/constants.ts";
import type { HashMismatch } from "../../src/hashline/types.ts";

// -----------------------------------------------------------------------
// Helper: build a diff script from a compact notation
// -----------------------------------------------------------------------

function formatDiff(diff: DiffEntry[]): string[] {
  return diff.map((e) => {
    switch (e.op) {
      case "equal":
        return ` ${e.content}`;
      case "insert":
        return `+${e.content}`;
      case "delete":
        return `-${e.content}`;
    }
  });
}

// -----------------------------------------------------------------------
// Myers diff — edge cases
// -----------------------------------------------------------------------

describe("myersDiff — edge cases", () => {
  it("both empty: returns []", () => {
    expect(myersDiff([], [])).toEqual([]);
  });

  it("one empty (insert all)", () => {
    const result = myersDiff([], ["a", "b"]);
    expect(result).toHaveLength(2);
    expect(result[0].op).toBe("insert");
    expect(result[0].newLine).toBe(1);
    expect(result[0].content).toBe("a");
    expect(result[1].op).toBe("insert");
    expect(result[1].newLine).toBe(2);
    expect(result[1].content).toBe("b");
  });

  it("one empty (delete all)", () => {
    const result = myersDiff(["x", "y", "z"], []);
    expect(result).toHaveLength(3);
    expect(result[0].op).toBe("delete");
    expect(result[0].oldLine).toBe(1);
    expect(result[0].content).toBe("x");
    expect(result[2].op).toBe("delete");
    expect(result[2].oldLine).toBe(3);
    expect(result[2].content).toBe("z");
  });

  it("identical files: all equal", () => {
    const result = myersDiff(["a", "b", "c"], ["a", "b", "c"]);
    expect(result).toHaveLength(3);
    for (const e of result) {
      expect(e.op).toBe("equal");
    }
    expect(result[0].oldLine).toBe(1);
    expect(result[0].newLine).toBe(1);
    expect(result[2].oldLine).toBe(3);
    expect(result[2].newLine).toBe(3);
  });

  it("identical single-line files", () => {
    const result = myersDiff(["hello"], ["hello"]);
    expect(result).toHaveLength(1);
    expect(result[0].op).toBe("equal");
  });

  it("single line changed", () => {
    const result = myersDiff(["a"], ["b"]);
    expect(result).toHaveLength(2);
    expect(result[0].op).toBe("delete");
    expect(result[0].content).toBe("a");
    expect(result[0].oldLine).toBe(1);
    expect(result[1].op).toBe("insert");
    expect(result[1].content).toBe("b");
    expect(result[1].newLine).toBe(1);
  });
});

// -----------------------------------------------------------------------
// Myers diff — core edit patterns
// -----------------------------------------------------------------------

describe("myersDiff — edit patterns", () => {
  it("pure insertion at beginning", () => {
    const result = myersDiff(["b", "c"], ["a", "b", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual(["+a", " b", " c"]);
    // Check line numbers
    expect(result[0].op).toBe("insert");
    expect(result[0].newLine).toBe(1);
    expect(result[1].op).toBe("equal");
    expect(result[1].oldLine).toBe(1);
    expect(result[1].newLine).toBe(2);
  });

  it("pure insertion in middle", () => {
    const result = myersDiff(["a", "c"], ["a", "b", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "+b", " c"]);
  });

  it("pure insertion at end", () => {
    const result = myersDiff(["a", "b"], ["a", "b", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", " b", "+c"]);
  });

  it("pure deletion at beginning", () => {
    const result = myersDiff(["a", "b", "c"], ["b", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual(["-a", " b", " c"]);
  });

  it("pure deletion in middle", () => {
    const result = myersDiff(["a", "b", "c"], ["a", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "-b", " c"]);
  });

  it("pure deletion at end", () => {
    const result = myersDiff(["a", "b", "c"], ["a", "b"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", " b", "-c"]);
  });

  it("replacement (delete+insert)", () => {
    const result = myersDiff(["a", "b", "c"], ["a", "x", "c"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "-b", "+x", " c"]);
  });

  it("multiple insertions", () => {
    const result = myersDiff(["a", "d"], ["a", "b", "c", "d"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "+b", "+c", " d"]);
  });

  it("multiple deletions", () => {
    const result = myersDiff(["a", "b", "c", "d"], ["a", "d"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "-b", "-c", " d"]);
  });

  it("mixed: delete + insert at same position", () => {
    const result = myersDiff(["x", "y"], ["a", "b"]);
    const fmt = formatDiff(result);
    // Should be: -x, -y, +a, +b (or -x, +a, -y, +b, etc.)
    // The exact order depends on the algorithm, but we need
    // 2 deletes and 2 inserts
    const deletes = result.filter((e) => e.op === "delete");
    const inserts = result.filter((e) => e.op === "insert");
    expect(deletes).toHaveLength(2);
    expect(inserts).toHaveLength(2);
  });

  it("mixed changes with context", () => {
    const oldLines = [
      "keep1",
      "remove me",
      "keep2",
      "remove me too",
      "keep3",
    ];
    const newLines = [
      "keep1",
      "inserted",
      "keep2",
      "also inserted",
      "keep3",
    ];
    const result = myersDiff(oldLines, newLines);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([
      " keep1",
      "-remove me",
      "+inserted",
      " keep2",
      "-remove me too",
      "+also inserted",
      " keep3",
    ]);
  });

  it("adjacent insert + delete", () => {
    const result = myersDiff(["a", "b"], ["a", "x", "y"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual([" a", "-b", "+x", "+y"]);
  });

  it("works with empty lines", () => {
    const result = myersDiff([""], ["hello"]);
    const fmt = formatDiff(result);
    expect(fmt).toEqual(["-", "+hello"]);
  });
});

// -----------------------------------------------------------------------
// reanchorChangedLines
// -----------------------------------------------------------------------

describe("reanchorChangedLines", () => {
  it("returns empty array when no changes", () => {
    const result = reanchorChangedLines(
      ["a", "b", "c"],
      ["a", "b", "c"],
      3,
    );
    expect(result).toEqual([]);
  });

  it("includes inserted lines with old→new anchor mapping", () => {
    const oldLines = ["a", "c"];
    const newLines = ["a", "b", "c"];
    const result = reanchorChangedLines(oldLines, newLines, 3);

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(2);
    expect(result[0].newContent).toBe("b");
    // D6b: oldAnchor is the hash of the OLD line at the insert position
    // (line 2 in oldLines was "c"), not the pre-insert empty placeholder
    expect(result[0].oldAnchor).toBe(
      computeLineHash("c", 3, 2),
    );
    // newAnchor should be the hash of "b" at line 2
    expect(result[0].newAnchor).toBe(
      computeLineHash("b", 3, 2),
    );
  });

  it("includes deleted lines with empty newAnchor", () => {
    const oldLines = ["a", "b", "c"];
    const newLines = ["a", "c"];
    const result = reanchorChangedLines(oldLines, newLines, 3);

    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(2);
    expect(result[0].newAnchor).toBe("");
    expect(result[0].newContent).toBe("");
    expect(result[0].oldAnchor).toBe(
      computeLineHash("b", 3, 2),
    );
  });

  it("handles replacement (delete + insert)", () => {
    const oldLines = ["a", "old", "c"];
    const newLines = ["a", "new", "c"];
    const result = reanchorChangedLines(oldLines, newLines, 3);

    // Should include both the delete and the insert
    expect(result.length).toBeGreaterThanOrEqual(1);

    const deleted = result.find((r) => r.newAnchor === "");
    const inserted = result.find((r) => r.newAnchor !== "" && r.newContent === "new");

    expect(deleted).toBeDefined();
    expect(deleted!.line).toBe(2);
    expect(deleted!.newContent).toBe("");

    expect(inserted).toBeDefined();
    expect(inserted!.line).toBe(2);
  });

  it("does NOT include unchanged lines", () => {
    const oldLines = ["a", "b", "c", "d", "e"];
    const newLines = ["a", "X", "c", "d", "e"];
    const result = reanchorChangedLines(oldLines, newLines, 3);

    for (const r of result) {
      expect(r.newContent).not.toBe("c");
      expect(r.newContent).not.toBe("d");
      expect(r.newContent).not.toBe("e");
    }
    expect(result.some((r) => r.newContent === "X")).toBe(true);
  });

  it("handles multiple changes", () => {
    const oldLines = ["a", "b", "c", "d"];
    const newLines = ["a", "X", "Y", "d"];
    const result = reanchorChangedLines(oldLines, newLines, 3);

    // Lines 2 and 3 changed (b→X and c→Y, each as delete+insert)
    // We should see 2 entries with empty newAnchor (deletions)
    // and 2 entries with non-empty newAnchor (insertions)
    const deletes = result.filter((r) => r.newAnchor === "");
    const inserts = result.filter((r) => r.newAnchor !== "");
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------
// generateUnifiedDiff
// -----------------------------------------------------------------------

describe("generateUnifiedDiff", () => {
  it("returns empty string for unchanged content", () => {
    const result = generateUnifiedDiff("hello\nworld\n", "hello\nworld\n", "test.ts");
    expect(result).toBe("");
  });

  it("returns empty string for identical empty content", () => {
    const result = generateUnifiedDiff("", "", "test.ts");
    expect(result).toBe("");
  });

  it("produces valid unified diff format with headers", () => {
    const oldContent = "line1\nline2\nline3\n";
    const newContent = "line1\nchanged\nline3\n";
    const result = generateUnifiedDiff(oldContent, newContent, "my-file.ts");

    // Check headers
    expect(result).toContain("--- a/my-file.ts");
    expect(result).toContain("+++ b/my-file.ts");

    // Check hunk header
    expect(result).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);

    // Check change markers
    expect(result).toContain("-line2");
    expect(result).toContain("+changed");

    // Should end with newline
    expect(result.endsWith("\n")).toBe(true);
  });

  it("includes context lines around changes", () => {
    const oldContent = ["a", "b", "c", "d", "e"].join("\n");
    const newContent = ["a", "b", "X", "d", "e"].join("\n");
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    // Should include context lines
    expect(result).toContain(" b");
    expect(result).toContain(" d");
    expect(result).toContain("-c");
    expect(result).toContain("+X");
  });

  it("handles insertions at start of file", () => {
    const oldContent = "b\nc\n";
    const newContent = "a\nb\nc\n";
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    expect(result).toContain("--- a/f.ts");
    expect(result).toContain("+++ b/f.ts");
    expect(result).toContain("+a");
  });

  it("handles insertions at end of file", () => {
    const oldContent = "a\nb\n";
    const newContent = "a\nb\nc\n";
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    expect(result).toContain("+c");
  });

  it("handles deletions at start of file", () => {
    const oldContent = "a\nb\nc\n";
    const newContent = "b\nc\n";
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    expect(result).toContain("-a");
  });

  it("handles complete file replacement", () => {
    const oldContent = "hello\nworld\n";
    const newContent = "goodbye\nuniverse\n";
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    expect(result).toContain("-hello");
    expect(result).toContain("-world");
    expect(result).toContain("+goodbye");
    expect(result).toContain("+universe");
  });

  it("handles single hunk with proper @@ format", () => {
    const oldContent = "a\nb\nc\n";
    const newContent = "a\nX\nc\n";
    const result = generateUnifiedDiff(oldContent, newContent, "f.ts");

    // Hunk header should match @@ -1,3 +1,3 @@ (or similar)
    const match = result.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    expect(match).not.toBeNull();
  });

  it("handles empty old content (new file)", () => {
    const result = generateUnifiedDiff("", "hello\nworld\n", "new.ts");
    expect(result).toContain("+hello");
    expect(result).toContain("+world");
  });

  it("handles empty new content (deleted file)", () => {
    const result = generateUnifiedDiff("hello\nworld\n", "", "gone.ts");
    expect(result).toContain("-hello");
    expect(result).toContain("-world");
  });
});

// -----------------------------------------------------------------------
// countLineDiffs
// -----------------------------------------------------------------------

describe("countLineDiffs", () => {
  it("counts 0 for unchanged content", () => {
    const result = countLineDiffs("a\nb\nc\n", "a\nb\nc\n");
    expect(result).toEqual({ additions: 0, deletions: 0 });
  });

  it("counts additions correctly", () => {
    const result = countLineDiffs("a\nc\n", "a\nb\nc\n");
    expect(result).toEqual({ additions: 1, deletions: 0 });
  });

  it("counts deletions correctly", () => {
    const result = countLineDiffs("a\nb\nc\n", "a\nc\n");
    expect(result).toEqual({ additions: 0, deletions: 1 });
  });

  it("counts both additions and deletions", () => {
    const result = countLineDiffs("a\nb\nc\n", "a\nX\nc\n");
    expect(result).toEqual({ additions: 1, deletions: 1 });
  });

  it("counts multiple changes", () => {
    const result = countLineDiffs(
      "a\nb\nc\nd\ne\n",
      "a\nX\nY\nd\nZ\n",
    );
    expect(result).toEqual({ additions: 3, deletions: 3 });
  });

  it("handles empty content", () => {
    expect(countLineDiffs("", "")).toEqual({ additions: 0, deletions: 0 });
    expect(countLineDiffs("a", "")).toEqual({ additions: 0, deletions: 1 });
    expect(countLineDiffs("", "a")).toEqual({ additions: 1, deletions: 0 });
  });
});

// -----------------------------------------------------------------------
// findNearbyMatch — fuzzy matching
// -----------------------------------------------------------------------

describe("findNearbyMatch", () => {
  it("finds a matching line within ±10 window", () => {
    // Set up lines where line 5 has known content, then find it from nearby
    const lines = ["a", "b", "c", "target", "d", "e"];
    const targetLine = 3;
    const hash = computeLineHash("target", 3, 4);
    const match = findNearbyMatch(lines, targetLine, hash, 3);
    expect(match).toBe(4);
  });

  it("finds match one line below target", () => {
    const lines = ["a", "target", "b"];
    const hash = computeLineHash("target", 3, 2);
    const match = findNearbyMatch(lines, 1, hash, 3);
    expect(match).toBe(2);
  });

  it("finds match one line above target", () => {
    const lines = ["a", "target", "b"];
    const hash = computeLineHash("target", 3, 2);
    const match = findNearbyMatch(lines, 3, hash, 3);
    expect(match).toBe(2);
  });

  it("returns null when no match exists", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("nonexistent", 3, 99);
    const match = findNearbyMatch(lines, 2, hash, 3);
    expect(match).toBeNull();
  });

  it("returns null when target is beyond window", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    // The target content exists at line 30 but is 20 lines away
    const hash = computeLineHash("line30", 3, 30);
    const match = findNearbyMatch(lines, 5, hash, 3, 10);
    // Distance = 25, which is > 10
    expect(match).toBeNull();
  });

  it("handles target near beginning of file", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("a", 3, 1);
    // Search from line 1 — should find itself at distance 0
    // Actually, the search starts from dist=1, so looking below first
    const match = findNearbyMatch(lines, 1, hash, 3);
    // dist=1: below=1 -> hash of lines[1]="b" at line2. doesn't match
    // dist=1: above=-1 -> out of bounds
    // dist=2: below=2 -> hash of lines[2]="c" at line3. doesn't match
    // dist=2: above=-2 -> out of bounds
    // No more distances for these 3 lines... shouldn't find itself
    expect(match).toBeNull();
  });

  it("finds a nearby line that matches (searches outward from target)", () => {
    const lines = ["a", "target", "b", "c"];
    const hash = computeLineHash("target", 3, 2);
    // Target is at line 2, search from line 5 — should find it via dist=3 (above)
    const match = findNearbyMatch(lines, 5, hash, 3, 5);
    expect(match).toBe(2);
  });

  it("searches outward (below first, then above)", () => {
    const lines = ["aboveTarget", "target", "belowTarget"];
    const targetHash = computeLineHash("target", 3, 2);

    // Searching from line 4 (which doesn't exist in a 3-line file)
    const match = findNearbyMatch(lines, 4, targetHash, 3, 5);
    // dist=1: below=4 -> out of bounds
    // dist=1: above=2 -> lines[2]="target" -> match!
    expect(match).toBe(2);
  });

  it("respects custom maxDistance", () => {
    const lines = ["a", "b", "c", "d", "e", "target"];
    const hash = computeLineHash("target", 3, 6);
    // Target is 4 lines away, maxDistance=3 should not find it
    const match = findNearbyMatch(lines, 2, hash, 3, 3);
    expect(match).toBeNull();
  });

  it("finds match within custom maxDistance", () => {
    const lines = ["a", "b", "target", "d"];
    const hash = computeLineHash("target", 3, 3);
    const match = findNearbyMatch(lines, 1, hash, 3, 5);
    expect(match).toBe(3);
  });
});

// -----------------------------------------------------------------------
// suggestCorrectAnchor
// -----------------------------------------------------------------------

describe("suggestCorrectAnchor", () => {
  it("produces 'Did you mean line X#Y?' message when match found", () => {
    const lines = ["a", "b", "target", "d"];
    const mismatch: HashMismatch = {
      line: 5,
      expected: computeLineHash("target", 3, 3),
    };
    const suggestion = suggestCorrectAnchor(mismatch, lines, 3);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("not found");
    expect(suggestion).toContain("Did you mean line 3");
  });

  it("includes the offset in the suggestion", () => {
    const lines = ["a", "b", "target", "d"];
    const mismatch: HashMismatch = {
      line: 5,
      expected: computeLineHash("target", 3, 3),
    };
    const suggestion = suggestCorrectAnchor(mismatch, lines, 3);
    expect(suggestion).toContain("shifted by -2");
  });

  it("returns null when no match found", () => {
    const lines = ["a", "b", "c"];
    const mismatch: HashMismatch = {
      line: 10,
      expected: "XYZ",
    };
    const suggestion = suggestCorrectAnchor(mismatch, lines, 3);
    expect(suggestion).toBeNull();
  });

  it("works with positive offset", () => {
    const lines = ["a", "target", "b"];
    const mismatch: HashMismatch = {
      line: 1,
      expected: computeLineHash("target", 3, 2),
    };
    const suggestion = suggestCorrectAnchor(mismatch, lines, 3);
    expect(suggestion).toContain("shifted by +1");
  });

  it("includes the actual hash in the message", () => {
    const lines = ["target", "b", "c"];
    const expectedHash = computeLineHash("target", 3, 1);
    const mismatch: HashMismatch = {
      line: 5,
      expected: expectedHash,
    };
    const suggestion = suggestCorrectAnchor(mismatch, lines, 3);
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain(expectedHash);
  });
});

// -----------------------------------------------------------------------
// detectUniformOffset
// -----------------------------------------------------------------------

describe("detectUniformOffset", () => {
  it("detects uniform positive offset", () => {
    const lines = ["a", "b", "c", "d", "e"];
    // Simulate: lines 1-3 in old file shifted down by 2 (insertions above them)
    const mismatches: HashMismatch[] = [
      { line: 1, expected: computeLineHash("c", 3, 3) },
      { line: 2, expected: computeLineHash("d", 3, 4) },
      { line: 3, expected: computeLineHash("e", 3, 5) },
    ];
    const result = detectUniformOffset(mismatches, lines, 3);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
    // Each mapping should point to line+2
    expect(result!.get("1#"))  // hash prefix match
    // Actually check full keys
    const key1 = `1#${computeLineHash("c", 3, 3)}`;
    const val1 = `3#${computeLineHash("c", 3, 3)}`;
    expect(result!.get(key1)).toBe(val1);
  });

  it("detects uniform negative offset", () => {
    const lines = ["x", "a", "b"];
    // Simulate: lines 3-4 shifted up by 1 (deletion above them)
    const mismatches: HashMismatch[] = [
      { line: 3, expected: computeLineHash("a", 3, 2) },
      { line: 4, expected: computeLineHash("b", 3, 3) },
    ];
    const result = detectUniformOffset(mismatches, lines, 3);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(2);
  });

  it("returns null when offsets are not uniform", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const mismatches: HashMismatch[] = [
      { line: 1, expected: computeLineHash("c", 3, 3) },
      { line: 4, expected: computeLineHash("e", 3, 5) },
    ];
    // Offset for mismatch 1: line 3 found from line 1 -> offset +2
    // Offset for mismatch 2: line 5 found from line 4 -> offset +1
    const result = detectUniformOffset(mismatches, lines, 3);
    expect(result).toBeNull();
  });

  it("returns empty map for empty mismatches", () => {
    const result = detectUniformOffset([], ["a", "b", "c"], 3);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(0);
  });

  it("returns null when any mismatch has no nearby match", () => {
    const lines = ["a", "b", "c"];
    const mismatches: HashMismatch[] = [
      { line: 1, expected: computeLineHash("b", 3, 2) },
      { line: 10, expected: "NONEXISTENT" },
    ];
    const result = detectUniformOffset(mismatches, lines, 3);
    expect(result).toBeNull();
  });

  it("handles single mismatch correctly", () => {
    const lines = ["a", "target", "b"];
    const mismatches: HashMismatch[] = [
      { line: 5, expected: computeLineHash("target", 3, 2) },
    ];
    const result = detectUniformOffset(mismatches, lines, 3);
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
  });
});
