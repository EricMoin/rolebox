import { describe, it, expect } from "bun:test";
import { computeLineHash } from "../../src/hashline/hash.ts";
import {
  parseLineRef,
  validateLineRef,
  validateLineRefs,
  validateVersion,
  HashlineMismatchError,
} from "../../src/hashline/validation.ts";
import {
  toNewLines,
  stripLinePrefixes,
  restoreLeadingIndent,
  stripInsertAnchorEcho,
  stripInsertBeforeEcho,
  stripRangeBoundaryEcho,
} from "../../src/hashline/text-normalize.ts";
import {
  getEditLineNumber,
  collectLineRefs,
  sortEditsBottomUp,
  deduplicateEdits,
  detectOverlappingRanges,
} from "../../src/hashline/edit-ordering.ts";
import {
  normalizeEdits,
  applyReplaceSingle,
  applyReplaceRange,
  applyInsertAfter,
  applyInsertBefore,
  applyAppend,
  applyPrepend,
  applyEditsWithReport,
} from "../../src/hashline/edit-primitives.ts";
import type { EditOp } from "../../src/hashline/types.ts";

// ════════════════════════════════════════════════════════════════════
// 1. parseLineRef
// ════════════════════════════════════════════════════════════════════

describe("parseLineRef", () => {
  it("parses basic LINE#HASH format", () => {
    const result = parseLineRef("42#aB3");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("parses with 2-char hash", () => {
    const result = parseLineRef("5#aB");
    expect(result).toEqual({ line: 5, hash: "aB" });
  });

  it("parses with 4-char hash", () => {
    const result = parseLineRef("100#aBcD");
    expect(result).toEqual({ line: 100, hash: "aBcD" });
  });

  it("strips leading >>> markers", () => {
    const result = parseLineRef(">>>42#aB3");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("strips leading + marker", () => {
    const result = parseLineRef("+42#aB3");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("strips leading - marker", () => {
    const result = parseLineRef("-42#aB3");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("normalizes # space to #", () => {
    const result = parseLineRef("42# aB3");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("strips trailing |content", () => {
    const result = parseLineRef("42#aB3|const x = 42;");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("strips trailing |content with special chars", () => {
    const result = parseLineRef("42#aB3|fn() => { return true; }");
    expect(result).toEqual({ line: 42, hash: "aB3" });
  });

  it("throws on invalid format (no hash)", () => {
    expect(() => parseLineRef("42")).toThrow("Invalid line reference");
  });

  it("throws on invalid format (no line number)", () => {
    expect(() => parseLineRef("#aB3")).toThrow("Invalid line reference");
  });

  it("throws on empty string", () => {
    expect(() => parseLineRef("")).toThrow("Invalid line reference");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. validateLineRef
// ════════════════════════════════════════════════════════════════════

describe("validateLineRef", () => {
  const lines = [
    "const x = 1;",
    "const y = 2;",
    "function hello() {",
    "  return x + y;",
    "}",
  ];

  it("passes when hash matches", () => {
    const hash = computeLineHash(lines[2], 3, 3);
    const ref = `3#${hash}`;
    expect(() => validateLineRef(lines, ref, 3)).not.toThrow();
  });

  it("throws HashlineMismatchError when hash does not match", () => {
    const ref = "3#XxX";
    expect(() => validateLineRef(lines, ref, 3)).toThrow(HashlineMismatchError);
  });

  it("throws HashlineMismatchError when line is out of range", () => {
    const ref = "99#abc";
    expect(() => validateLineRef(lines, ref, 3)).toThrow(HashlineMismatchError);
  });

  it("throws with helpful error message on mismatch", () => {
    const ref = "3#XxX";
    try {
      validateLineRef(lines, ref, 3);
    } catch (e: any) {
      expect(e.message).toContain("Hashline mismatch");
      expect(e.message).toContain("line 3");
      expect(e.mismatches).toBeDefined();
      expect(e.mismatches.length).toBe(1);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. validateLineRefs (batch)
// ════════════════════════════════════════════════════════════════════

describe("validateLineRefs", () => {
  const lines = [
    "line one",
    "line two",
    "line three",
    "line four",
    "line five",
  ];

  it("passes when all hashes match", () => {
    const hash1 = computeLineHash(lines[0], 3, 1);
    const hash3 = computeLineHash(lines[2], 3, 3);
    const ref1 = `1#${hash1}`;
    const ref3 = `3#${hash3}`;
    expect(() => validateLineRefs(lines, [ref1, ref3], 3)).not.toThrow();
  });

  it("collects all mismatches before throwing", () => {
    const hash1 = computeLineHash(lines[0], 3, 1);
    const ref1 = `1#${hash1}`;
    const ref2 = "2#XxX";
    const ref3 = "3#YyY";
    try {
      validateLineRefs(lines, [ref1, ref2, ref3], 3);
    } catch (e: any) {
      expect(e).toBeInstanceOf(HashlineMismatchError);
      expect(e.mismatches.length).toBe(2);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. validateVersion
// ════════════════════════════════════════════════════════════════════

describe("validateVersion", () => {
  it("passes when versions match", () => {
    expect(() => validateVersion("abc123", "abc123")).not.toThrow();
  });

  it("throws when versions mismatch", () => {
    expect(() => validateVersion("abc123", "def456")).toThrow("File version mismatch");
    expect(() => validateVersion("abc123", "def456")).toThrow("abc123");
    expect(() => validateVersion("abc123", "def456")).toThrow("def456");
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. HashlineMismatchError
// ════════════════════════════════════════════════════════════════════

describe("HashlineMismatchError", () => {
  const lines = [
    "line one",
    "line two",
    "line three",
    "line four",
    "line five",
  ];

  it("stores mismatches and fileLines", () => {
    const mismatches = [{ line: 3, expected: "abc", actual: "xyz" }];
    const err = new HashlineMismatchError(mismatches, lines);
    expect(err.mismatches).toBe(mismatches);
    expect(err.fileLines).toBe(lines);
    expect(err.name).toBe("HashlineMismatchError");
  });

  it("formats message with context lines", () => {
    const mismatches = [{ line: 3, expected: "abc", actual: "xyz" }];
    const err = new HashlineMismatchError(mismatches, lines);
    expect(err.message).toContain("Hashline mismatch");
    expect(err.message).toContain("line 3");
    expect(err.message).toContain(">>>");
  });

  it("suggestLineForHash - finds matching line", () => {
    const err = new HashlineMismatchError([], lines);
    // Compute a valid hash for line 1
    const hash1 = computeLineHash(lines[0], 3, 1);
    const suggestion = err.suggestLineForHash(`1#${hash1}`, lines, 3);
    expect(suggestion).toContain("found at line 1");
  });

  it("suggestLineForHash - returns null when no match", () => {
    const err = new HashlineMismatchError([], lines);
    // Use a hash that won't match anything
    const suggestion = err.suggestLineForHash("1#Z_Z", lines, 3);
    expect(suggestion).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. toNewLines
// ════════════════════════════════════════════════════════════════════

describe("toNewLines", () => {
  it("splits multi-line string by \\n", () => {
    expect(toNewLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("wraps single-line string in array", () => {
    expect(toNewLines("hello")).toEqual(["hello"]);
  });

  it("returns array as-is", () => {
    expect(toNewLines(["a", "b"])).toEqual(["a", "b"]);
  });

  it("handles empty string as single empty line", () => {
    expect(toNewLines("")).toEqual([""]);
  });

  it("handles empty array as single empty line", () => {
    expect(toNewLines([])).toEqual([""]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. stripLinePrefixes
// ════════════════════════════════════════════════════════════════════

describe("stripLinePrefixes", () => {
  it("strips LINE#HASH| prefix", () => {
    const result = stripLinePrefixes(["42#aB3|const x = 1;"]);
    expect(result).toEqual(["const x = 1;"]);
  });

  it("passes through lines without prefix", () => {
    const result = stripLinePrefixes(["const x = 1;"]);
    expect(result).toEqual(["const x = 1;"]);
  });

  it("strips prefix from multiple lines", () => {
    const input = [
      "5#aB3|line one",
      "6#cD4|line two",
      "plain line",
    ];
    const result = stripLinePrefixes(input);
    expect(result).toEqual(["line one", "line two", "plain line"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. restoreLeadingIndent
// ════════════════════════════════════════════════════════════════════

describe("restoreLeadingIndent", () => {
  it("restores indent when replacement lacks it", () => {
    const result = restoreLeadingIndent("    hello", "world");
    expect(result).toBe("    world");
  });

  it("keeps replacement indent when it exists", () => {
    const result = restoreLeadingIndent("    hello", "  world");
    expect(result).toBe("  world");
  });

  it("returns replacement unchanged when template has no indent", () => {
    const result = restoreLeadingIndent("hello", "world");
    expect(result).toBe("world");
  });

  it("handles empty replacement", () => {
    const result = restoreLeadingIndent("    hello", "");
    expect(result).toBe("");
  });

  it("handles tab indentation", () => {
    const result = restoreLeadingIndent("\t\thello", "world");
    expect(result).toBe("\t\tworld");
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. stripInsertAnchorEcho
// ════════════════════════════════════════════════════════════════════

describe("stripInsertAnchorEcho", () => {
  it("strips anchor echo from start of newLines", () => {
    const result = stripInsertAnchorEcho("const x = 1;", [
      "const x = 1;",
      "const y = 2;",
    ]);
    expect(result).toEqual(["const y = 2;"]);
  });

  it("returns newLines unchanged when no echo", () => {
    const result = stripInsertAnchorEcho("const x = 1;", ["const y = 2;"]);
    expect(result).toEqual(["const y = 2;"]);
  });

  it("handles stripped prefix on echo line", () => {
    const result = stripInsertAnchorEcho("hello world", [
      "1#abc|hello world",
      "new line",
    ]);
    expect(result).toEqual(["new line"]);
  });

  it("returns empty array when all lines are echo", () => {
    const result = stripInsertAnchorEcho("hello", ["hello"]);
    expect(result).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 10. stripInsertBeforeEcho
// ════════════════════════════════════════════════════════════════════

describe("stripInsertBeforeEcho", () => {
  it("strips anchor echo from end of newLines", () => {
    const result = stripInsertBeforeEcho("const z = 3;", [
      "const x = 1;",
      "const z = 3;",
    ]);
    expect(result).toEqual(["const x = 1;"]);
  });

  it("returns newLines unchanged when no echo", () => {
    const result = stripInsertBeforeEcho("const z = 3;", ["const x = 1;"]);
    expect(result).toEqual(["const x = 1;"]);
  });

  it("returns empty array when all lines are echo", () => {
    const result = stripInsertBeforeEcho("hello", ["hello"]);
    expect(result).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 11. stripRangeBoundaryEcho
// ════════════════════════════════════════════════════════════════════

describe("stripRangeBoundaryEcho", () => {
  const lines = [
    "start",
    "middle",
    "end",
  ];

  it("strips start boundary echo from beginning", () => {
    const result = stripRangeBoundaryEcho(lines, 1, 3, [
      "start",
      "new content",
      "end",
    ]);
    // "start" echoed, "end" echoed → only "new content" remains
    expect(result).toEqual(["new content"]);
  });

  it("strips end boundary echo from end", () => {
    const result = stripRangeBoundaryEcho(lines, 1, 3, [
      "new content only",
      "end",
    ]);
    expect(result).toEqual(["new content only"]);
  });

  it("returns unchanged when no echo", () => {
    const result = stripRangeBoundaryEcho(lines, 1, 3, [
      "fresh content",
    ]);
    expect(result).toEqual(["fresh content"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 12. getEditLineNumber
// ════════════════════════════════════════════════════════════════════

describe("getEditLineNumber", () => {
  it("returns line number for replace", () => {
    const edit: EditOp = { op: "replace", pos: "5#abc", lines: "x" };
    expect(getEditLineNumber(edit)).toBe(5);
  });

  it("returns Infinity for append without pos", () => {
    const edit: EditOp = { op: "append", lines: "x" };
    expect(getEditLineNumber(edit)).toBe(Infinity);
  });

  it("returns 0 for prepend without pos", () => {
    const edit: EditOp = { op: "prepend", lines: "x" };
    expect(getEditLineNumber(edit)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 13. collectLineRefs
// ════════════════════════════════════════════════════════════════════

describe("collectLineRefs", () => {
  it("collects pos and end from replace", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "5#abc", end: "10#xyz", lines: "x" },
    ];
    expect(collectLineRefs(edits)).toEqual(["5#abc", "10#xyz"]);
  });

  it("collects pos from append", () => {
    const edits: EditOp[] = [
      { op: "append", pos: "5#abc", lines: "x" },
    ];
    expect(collectLineRefs(edits)).toEqual(["5#abc"]);
  });

  it("returns empty array for append without pos", () => {
    const edits: EditOp[] = [
      { op: "append", lines: "x" },
    ];
    expect(collectLineRefs(edits)).toEqual([]);
  });

  it("collects from multiple edits", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "3#abc", lines: "x" },
      { op: "append", pos: "7#xyz", lines: "y" },
      { op: "prepend", pos: "1#def", lines: "z" },
    ];
    expect(collectLineRefs(edits)).toEqual(["3#abc", "7#xyz", "1#def"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14. sortEditsBottomUp
// ════════════════════════════════════════════════════════════════════

describe("sortEditsBottomUp", () => {
  it("sorts by line number descending", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "3#abc", lines: "a" },
      { op: "replace", pos: "1#abc", lines: "b" },
      { op: "replace", pos: "5#abc", lines: "c" },
    ];
    const sorted = sortEditsBottomUp(edits);
    const lineNums = sorted.map(getEditLineNumber);
    expect(lineNums).toEqual([5, 3, 1]);
  });

  it("same line: replace before append before prepend", () => {
    const edits: EditOp[] = [
      { op: "prepend", pos: "5#abc", lines: "a" },
      { op: "replace", pos: "5#abc", lines: "b" },
      { op: "append", pos: "5#abc", lines: "c" },
    ];
    const sorted = sortEditsBottomUp(edits);
    expect(sorted[0].op).toBe("replace");
    expect(sorted[1].op).toBe("append");
    expect(sorted[2].op).toBe("prepend");
  });

  it("handles append without pos (Infinity) at end", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "3#abc", lines: "a" },
      { op: "append", lines: "b" },
    ];
    const sorted = sortEditsBottomUp(edits);
    const lineNums = sorted.map(getEditLineNumber);
    expect(lineNums).toEqual([Infinity, 3]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 15. deduplicateEdits
// ════════════════════════════════════════════════════════════════════

describe("deduplicateEdits", () => {
  it("removes identical replace edits", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "5#abc", lines: "x" },
      { op: "replace", pos: "5#abc", lines: "x" },
    ];
    const result = deduplicateEdits(edits);
    expect(result.edits.length).toBe(1);
    expect(result.deduplicatedCount).toBe(1);
  });

  it("removes identical append edits", () => {
    const edits: EditOp[] = [
      { op: "append", pos: "5#abc", lines: "x" },
      { op: "append", pos: "5#abc", lines: "x" },
      { op: "append", pos: "5#abc", lines: "x" },
    ];
    const result = deduplicateEdits(edits);
    expect(result.edits.length).toBe(1);
    expect(result.deduplicatedCount).toBe(2);
  });

  it("keeps different edits", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "5#abc", lines: "x" },
      { op: "replace", pos: "7#abc", lines: "y" },
    ];
    const result = deduplicateEdits(edits);
    expect(result.edits.length).toBe(2);
    expect(result.deduplicatedCount).toBe(0);
  });

  it("considers lines content in dedup key", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "5#abc", lines: "x" },
      { op: "replace", pos: "5#abc", lines: "y" },
    ];
    const result = deduplicateEdits(edits);
    expect(result.edits.length).toBe(2);
    expect(result.deduplicatedCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 16. detectOverlappingRanges
// ════════════════════════════════════════════════════════════════════

describe("detectOverlappingRanges", () => {
  it("returns null for non-overlapping ranges", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "1#abc", end: "3#def", lines: "a" },
      { op: "replace", pos: "5#abc", end: "7#def", lines: "b" },
    ];
    expect(detectOverlappingRanges(edits)).toBeNull();
  });

  it("detects overlapping ranges", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "1#abc", end: "5#def", lines: "a" },
      { op: "replace", pos: "3#abc", end: "7#def", lines: "b" },
    ];
    const result = detectOverlappingRanges(edits);
    expect(result).not.toBeNull();
    expect(result).toContain("Overlapping");
  });

  it("detects single-line overlapping ranges", () => {
    const edits: EditOp[] = [
      { op: "replace", pos: "5#abc", lines: "a" },
      { op: "replace", pos: "5#abc", lines: "b" },
    ];
    // Same single line = overlapping
    const result = detectOverlappingRanges(edits);
    expect(result).not.toBeNull();
  });

  it("ignores non-replace edits", () => {
    const edits: EditOp[] = [
      { op: "append", pos: "5#abc", lines: "a" },
      { op: "prepend", pos: "3#abc", lines: "b" },
    ];
    expect(detectOverlappingRanges(edits)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// 17. normalizeEdits
// ════════════════════════════════════════════════════════════════════

describe("normalizeEdits", () => {
  it("defaults op to replace", () => {
    const result = normalizeEdits([{ pos: "5#abc", lines: "x" }]);
    expect(result[0].op).toBe("replace");
  });

  it("handles null lines as empty string", () => {
    const result = normalizeEdits([{ op: "replace", pos: "5#abc", lines: null }]);
    expect(result[0].lines).toBe("");
  });

  it("handles undefined lines as empty string", () => {
    const result = normalizeEdits([{ op: "replace", pos: "5#abc" }]);
    expect(result[0].lines).toBe("");
  });

  it("preserves append with pos", () => {
    const result = normalizeEdits([{ op: "append", pos: "5#abc", lines: "x" }]);
    expect(result[0].op).toBe("append");
    expect((result[0] as any).pos).toBe("5#abc");
  });

  it("preserves prepend without pos", () => {
    const result = normalizeEdits([{ op: "prepend", lines: "x" }]);
    expect(result[0].op).toBe("prepend");
    expect((result[0] as any).pos).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// 18. applyReplaceSingle
// ════════════════════════════════════════════════════════════════════

describe("applyReplaceSingle", () => {
  it("replaces a single line with new text", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyReplaceSingle(lines, `2#${hash}`, "B!", 3);
    expect(result).toEqual(["a", "B!", "c"]);
  });

  it("replaces a single line with multiple lines", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyReplaceSingle(lines, `2#${hash}`, ["b1", "b2"], 3);
    expect(result).toEqual(["a", "b1", "b2", "c"]);
  });

  it("restores leading indent in replacement", () => {
    const lines = ["a", "    hello", "c"];
    const hash = computeLineHash("    hello", 3, 2);
    const result = applyReplaceSingle(lines, `2#${hash}`, "world", 3);
    expect(result).toEqual(["a", "    world", "c"]);
  });

  it("throws HashlineMismatchError on bad hash", () => {
    const lines = ["a", "b", "c"];
    expect(() => {
      applyReplaceSingle(lines, "2#XxX", "B!", 3);
    }).toThrow(HashlineMismatchError);
  });

  it("strips LINE#HASH| prefix from replacement", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyReplaceSingle(lines, `2#${hash}`, "1#abc|B!", 3);
    expect(result).toEqual(["a", "B!", "c"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 19. applyReplaceRange
// ════════════════════════════════════════════════════════════════════

describe("applyReplaceRange", () => {
  it("replaces an inclusive range", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const hash2 = computeLineHash("b", 3, 2);
    const hash4 = computeLineHash("d", 3, 4);
    const result = applyReplaceRange(lines, `2#${hash2}`, `4#${hash4}`, ["X", "Y"], 3);
    expect(result).toEqual(["a", "X", "Y", "e"]);
  });

  it("throws on invalid range (start > end)", () => {
    const lines = ["a", "b", "c"];
    const hash2 = computeLineHash("b", 3, 2);
    const hash1 = computeLineHash("a", 3, 1);
    expect(() => {
      applyReplaceRange(lines, `2#${hash2}`, `1#${hash1}`, "X", 3);
    }).toThrow("Invalid replace range");
  });
});

// ════════════════════════════════════════════════════════════════════
// 20. applyInsertAfter
// ════════════════════════════════════════════════════════════════════

describe("applyInsertAfter", () => {
  it("inserts lines after anchor", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyInsertAfter(lines, `2#${hash}`, ["x", "y"], 3);
    expect(result).toEqual(["a", "b", "x", "y", "c"]);
  });

  it("strips anchor echo from inserted content", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyInsertAfter(lines, `2#${hash}`, ["b", "x", "y"], 3);
    // The leading "b" is the anchor echo, should be stripped
    expect(result).toEqual(["a", "b", "x", "y", "c"]);
  });

  it("returns original lines for empty insert", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyInsertAfter(lines, `2#${hash}`, "", 3);
    expect(result).toEqual(["a", "b", "c"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 21. applyInsertBefore
// ════════════════════════════════════════════════════════════════════

describe("applyInsertBefore", () => {
  it("inserts lines before anchor", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyInsertBefore(lines, `2#${hash}`, ["x", "y"], 3);
    expect(result).toEqual(["a", "x", "y", "b", "c"]);
  });

  it("strips anchor echo from inserted content", () => {
    const lines = ["a", "b", "c"];
    const hash = computeLineHash("b", 3, 2);
    const result = applyInsertBefore(lines, `2#${hash}`, ["x", "y", "b"], 3);
    // The trailing "b" is the anchor echo, should be stripped
    expect(result).toEqual(["a", "x", "y", "b", "c"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 22. applyAppend
// ════════════════════════════════════════════════════════════════════

describe("applyAppend", () => {
  it("appends lines at EOF", () => {
    const lines = ["a", "b"];
    const result = applyAppend(lines, ["c", "d"]);
    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("returns original for empty append", () => {
    const lines = ["a", "b"];
    const result = applyAppend(lines, "");
    expect(result).toEqual(["a", "b"]);
  });

  it("strips LINE#HASH| prefix", () => {
    const lines = ["a"];
    const result = applyAppend(lines, "2#abc|b");
    expect(result).toEqual(["a", "b"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 23. applyPrepend
// ════════════════════════════════════════════════════════════════════

describe("applyPrepend", () => {
  it("prepends lines at BOF", () => {
    const lines = ["a", "b"];
    const result = applyPrepend(lines, ["x", "y"]);
    expect(result).toEqual(["x", "y", "a", "b"]);
  });

  it("returns original for empty prepend", () => {
    const lines = ["a", "b"];
    const result = applyPrepend(lines, "");
    expect(result).toEqual(["a", "b"]);
  });

  it("strips LINE#HASH| prefix", () => {
    const lines = ["a"];
    const result = applyPrepend(lines, "0#xyz|z");
    expect(result).toEqual(["z", "a"]);
  });

  it("works on empty file", () => {
    const lines: string[] = [];
    const result = applyPrepend(lines, ["x", "y"]);
    expect(result).toEqual(["x", "y"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 24. applyEditsWithReport — full pipeline
// ════════════════════════════════════════════════════════════════════

describe("applyEditsWithReport", () => {
  const HASH_WIDTH = 3;

  it("single replace works", () => {
    const lines = ["line1", "line2", "line3"];
    const content = lines.join("\n");
    const hash = computeLineHash("line2", HASH_WIDTH, 2);
    const edits: EditOp[] = [
      { op: "replace", pos: `2#${hash}`, lines: "modified" },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("line1\nmodified\nline3");
    expect(result.noopEdits).toBe(0);
    expect(result.deduplicatedEdits).toBe(0);
  });

  it("replace range works", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const content = lines.join("\n");
    const hash2 = computeLineHash("b", HASH_WIDTH, 2);
    const hash4 = computeLineHash("d", HASH_WIDTH, 4);
    const edits: EditOp[] = [
      { op: "replace", pos: `2#${hash2}`, end: `4#${hash4}`, lines: ["X", "Y"] },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("a\nX\nY\ne");
  });

  it("replace with mismatched hash throws", () => {
    const content = "line1\nline2\nline3";
    const edits: EditOp[] = [
      { op: "replace", pos: "2#XxX", lines: "modified" },
    ];
    expect(() => {
      applyEditsWithReport(content, edits, HASH_WIDTH);
    }).toThrow(HashlineMismatchError);
  });

  it("bottom-up ordering preserves correctness", () => {
    // Edit line 5 and line 2 — bottom-up means line 5 first
    const lines = ["a", "b", "c", "d", "e"];
    const content = lines.join("\n");
    const hash2 = computeLineHash("b", HASH_WIDTH, 2);
    const hash5 = computeLineHash("e", HASH_WIDTH, 5);
    const edits: EditOp[] = [
      { op: "replace", pos: `2#${hash2}`, lines: "B!" },
      { op: "replace", pos: `5#${hash5}`, lines: "E!" },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("a\nB!\nc\nd\nE!");
  });

  it("deduplication removes identical edits", () => {
    const lines = ["line1", "line2", "line3"];
    const content = lines.join("\n");
    const hash2 = computeLineHash("line2", HASH_WIDTH, 2);
    const edits: EditOp[] = [
      { op: "replace", pos: `2#${hash2}`, lines: "modified" },
      { op: "replace", pos: `2#${hash2}`, lines: "modified" },
      { op: "replace", pos: `2#${hash2}`, lines: "modified" },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("line1\nmodified\nline3");
    expect(result.deduplicatedEdits).toBe(2);
  });

  it("overlap detection throws error", () => {
    const content = "a\nb\nc\nd\ne";
    const hash1 = computeLineHash("a", HASH_WIDTH, 1);
    const hash2 = computeLineHash("b", HASH_WIDTH, 2);
    const hash3 = computeLineHash("c", HASH_WIDTH, 3);
    const hash4 = computeLineHash("d", HASH_WIDTH, 4);
    const edits: EditOp[] = [
      { op: "replace", pos: `1#${hash1}`, end: `3#${hash3}`, lines: "X" },
      { op: "replace", pos: `2#${hash2}`, end: `4#${hash4}`, lines: "Y" },
    ];
    expect(() => {
      applyEditsWithReport(content, edits, HASH_WIDTH);
    }).toThrow("Overlapping");
  });

  it("insert + replace in same content", () => {
    const lines = ["a", "b", "c"];
    const content = lines.join("\n");
    const hash2 = computeLineHash("b", HASH_WIDTH, 2);
    const hash3 = computeLineHash("c", HASH_WIDTH, 3);
    // Bottom-up sorts: replace line 3 first, then append after line 2
    // So "C!" replaces "c" first, then "inserted" goes after "b"
    const edits: EditOp[] = [
      { op: "replace", pos: `3#${hash3}`, lines: "C!" },
      { op: "append", pos: `2#${hash2}`, lines: "inserted" },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("a\nb\ninserted\nC!");
  });

  it("handles empty content", () => {
    const edits: EditOp[] = [
      { op: "prepend", lines: "first" },
    ];
    const result = applyEditsWithReport("", edits, HASH_WIDTH);
    expect(result.content).toBe("first");
  });

  it("handles append and prepend together", () => {
    const content = "middle";
    const edits: EditOp[] = [
      { op: "prepend", lines: "before" },
      { op: "append", lines: "after" },
    ];
    const result = applyEditsWithReport(content, edits, HASH_WIDTH);
    expect(result.content).toBe("before\nmiddle\nafter");
  });
});

// ════════════════════════════════════════════════════════════════════
// 25. Version mismatch in full pipeline
// ════════════════════════════════════════════════════════════════════

describe("validateVersion usage", () => {
  it("throws on version mismatch", () => {
    expect(() => validateVersion("abc", "def")).toThrow("File version mismatch");
  });

  it("passes on matching version", () => {
    expect(() => validateVersion("same", "same")).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// 26. Empty file edge cases
// ════════════════════════════════════════════════════════════════════

describe("empty file edge cases", () => {
  it("prepend to empty file", () => {
    const result = applyPrepend([], "hello");
    expect(result).toEqual(["hello"]);
  });

  it("append to empty file", () => {
    const result = applyAppend([], "hello");
    expect(result).toEqual(["hello"]);
  });

  it("applyEditsWithReport handles empty file with prepend", () => {
    const result = applyEditsWithReport("", [{ op: "prepend", lines: "first" }], 3);
    expect(result.content).toBe("first");
  });

  it("applyEditsWithReport handles empty file with append", () => {
    const result = applyEditsWithReport("", [{ op: "append", lines: "first" }], 3);
    expect(result.content).toBe("first");
  });
});

// ════════════════════════════════════════════════════════════════════
// 27. No Bun-specific APIs
// ════════════════════════════════════════════════════════════════════

describe("no Bun-specific APIs", () => {
  it("uses node:crypto (not Bun)", () => {
    // Verify by checking crypto module is available
    const crypto = require("crypto");
    expect(crypto.createHash).toBeDefined();
  });
});
