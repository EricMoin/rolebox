import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  computeLineHash,
  computeFileVersion,
  canonicalizeFileText,
  hashWidthForLineCount,
} from "../../src/hashline/hash.ts";
import {
  applyEditsWithReport,
} from "../../src/hashline/edit-primitives.ts";
import {
  HashlineMismatchError,
} from "../../src/hashline/validation.ts";
import { createHashlineEditTool } from "../../src/hashline/index.ts";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ════════════════════════════════════════════════════════════════════
// Adversarial edit-semantics tests — each assertion encodes the CORRECT
// contract; a failing assertion reproduces a defect in the current engine.
//
// Defect map (root causes verified against source):
//   D3  insert-inside-replaced-range is destroyed — sortEditsBottomUp orders
//       by DESCENDING line number (edit-ordering.ts:62-75), so an append/
//       prepend anchored INSIDE a replace range executes first; the range
//       replace then re-validates its end anchor against the shifted lines
//       (edit-primitives.ts:79-80) and aborts the batch (edit-primitives.ts:91-94
//       would otherwise splice over the inserted lines). Inserted content is
//       never preserved.
//   D4  echo stripping is content-blind — stripInsertAnchorEcho
//       (text-normalize.ts:52-62) and stripRangeBoundaryEcho
//       (text-normalize.ts:91-124) delete a leading/trailing new-line that
//       merely EQUALS the anchor/boundary line, even when it is legitimate
//       user content (e.g. consecutive "}" or a repeated boundary line).
//   D5  empty replace content does not delete — toNewLines maps [] and ""
//       to [""] (text-normalize.ts:12-19), so applyReplaceSingle/
//       applyReplaceRange (edit-primitives.ts:44/53, 82/93) replace the target
//       with one EMPTY line instead of removing it.
// ════════════════════════════════════════════════════════════════════

const HASH_WIDTH = 3;

// 5-line fixture shared by most cases: line N content is "a".."e".
const LINES_5 = ["a", "b", "c", "d", "e"];
const CONTENT_5 = LINES_5.join("\n");
const hash5 = (line: number) => computeLineHash(LINES_5[line - 1], HASH_WIDTH, line);

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adversarial-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Read file metadata the same way hashline_read computes it (for tool-level tests). */
async function readFileMeta(fp: string) {
  const raw = await readFile(fp, "utf-8");
  const envelope = canonicalizeFileText(raw);
  const version = computeFileVersion(envelope.content);
  const norm = envelope.content.endsWith("\n") ? envelope.content.slice(0, -1) : envelope.content;
  const lines = norm === "" ? [] : norm.split("\n");
  return { version, lines, hw: hashWidthForLineCount(lines.length) };
}

// ════════════════════════════════════════════════════════════════════
// D3 — insert anchored INSIDE a replaced range must be preserved
// (sortEditsBottomUp descending order runs the insert first; the range
//  replace then re-validates/overwrites. edit-ordering.ts:62-75 +
//  edit-primitives.ts:79-80, 91-94)
// ════════════════════════════════════════════════════════════════════

describe("D3 — insert inside replaced range", () => {
  it("(a) append at pos 3 inside replace [2..4] — inserted content must be preserved", () => {
    const edits = [
      { op: "replace" as const, pos: `2#${hash5(2)}`, end: `4#${hash5(4)}`, lines: "X" },
      { op: "append" as const, pos: `3#${hash5(3)}`, lines: "INSERTED" },
    ];
    let error: unknown = null;
    let content = "";
    try {
      content = applyEditsWithReport(CONTENT_5, edits, HASH_WIDTH).content;
    } catch (e) {
      error = e;
    }
    // Contract: the batch must not abort, and the inserted content must survive.
    expect(error).toBeNull();
    expect(content).toContain("INSERTED");
    // Documented placement: replace collapses [2..4] to "X"; the insert
    // anchored at original line 3 lands right after the replacement.
    expect(content).toBe("a\nX\nINSERTED\ne");
  });

  it("(b) prepend at pos 3 inside replace [2..4] — inserted content must be preserved", () => {
    const edits = [
      { op: "replace" as const, pos: `2#${hash5(2)}`, end: `4#${hash5(4)}`, lines: "X" },
      { op: "prepend" as const, pos: `3#${hash5(3)}`, lines: "PREP" },
    ];
    let error: unknown = null;
    let content = "";
    try {
      content = applyEditsWithReport(CONTENT_5, edits, HASH_WIDTH).content;
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(content).toContain("PREP");
    // Documented placement: insert anchored at original line 3 lands right
    // before the replacement.
    expect(content).toBe("a\nPREP\nX\ne");
  });

  it("(c) control — replace [1..5] + append at range END boundary 5: both take effect", () => {
    const edits = [
      { op: "replace" as const, pos: `1#${hash5(1)}`, end: `5#${hash5(5)}`, lines: "X" },
      { op: "append" as const, pos: `5#${hash5(5)}`, lines: "Z" },
    ];
    // Bottom-up: append (line 5) runs first, then the range replaces [1..5];
    // the appended line is OUTSIDE the replaced span, so both survive.
    const result = applyEditsWithReport(CONTENT_5, edits, HASH_WIDTH);
    expect(result.content).toBe("X\nZ");
  });
});

// ════════════════════════════════════════════════════════════════════
// Contract guards that must PASS — clean errors, never corruption
// ════════════════════════════════════════════════════════════════════

describe("contract guards (must pass)", () => {
  it("(d) inverted range end < pos throws a clean 'Invalid replace range' error", () => {
    expect(() => {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: `4#${hash5(4)}`, end: `2#${hash5(2)}`, lines: "X" },
      ], HASH_WIDTH);
    }).toThrow(/Invalid replace range/);
    // And it must NOT be a hash-mismatch error — the anchors themselves are valid.
    expect(() => {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: `4#${hash5(4)}`, end: `2#${hash5(2)}`, lines: "X" },
      ], HASH_WIDTH);
    }).not.toThrow(HashlineMismatchError);
  });

  it("(e) pos on a nonexistent line throws HashlineMismatchError (line does not exist)", () => {
    expect(() => {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: "99#AbC", lines: "X" },
      ], HASH_WIDTH);
    }).toThrow(HashlineMismatchError);
    try {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: "99#AbC", lines: "X" },
      ], HASH_WIDTH);
    } catch (e: any) {
      expect(e.message).toContain("line 99");
      expect(e.message).toContain("does not exist");
    }
  });

  it("(e) pos with a mismatched hash throws HashlineMismatchError", () => {
    expect(() => {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: "3#XxX", lines: "X" },
      ], HASH_WIDTH);
    }).toThrow(HashlineMismatchError);
    try {
      applyEditsWithReport(CONTENT_5, [
        { op: "replace", pos: "3#XxX", lines: "X" },
      ], HASH_WIDTH);
    } catch (e: any) {
      expect(e.message).toContain("Hashline mismatch");
      expect(e.message).toContain("line 3");
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// D5 — empty replace content (lines:[] / lines:"") must DELETE the target
// (toNewLines maps [] and "" to [""] — text-normalize.ts:12-19 — so the
//  splice in edit-primitives.ts:53/93 leaves an empty line behind)
// ════════════════════════════════════════════════════════════════════

describe("D5 — empty replace content should delete, not leave an empty line", () => {
  it("(f) replace single line with lines:[] removes the line", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `2#${hash5(2)}`, lines: [] },
    ], HASH_WIDTH);
    // Contract: line 2 ("b") is deleted; no empty line remains.
    expect(result.content).toBe("a\nc\nd\ne");
  });

  it("(f) replace single line with lines:\"\" removes the line", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `2#${hash5(2)}`, lines: "" },
    ], HASH_WIDTH);
    expect(result.content).toBe("a\nc\nd\ne");
  });

  it("(f) replace range [1..2] with lines:[] removes both lines", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `1#${hash5(1)}`, end: `2#${hash5(2)}`, lines: [] },
    ], HASH_WIDTH);
    expect(result.content).toBe("c\nd\ne");
  });

  it("(f) tool-level: replace lines:[] on a real file must not silently corrupt", async () => {
    const fp = join(tmpDir, "d5-tool.txt");
    await writeFile(fp, CONTENT_5 + "\n", "utf-8");
    const meta = await readFileMeta(fp);
    const h = (i: number) => computeLineHash(LINES_5[i - 1], meta.hw, i);
    const result = await createHashlineEditTool().execute({
      files: [{
        filePath: fp,
        version: meta.version,
        edits: [{ op: "replace", pos: `2#${h(2)}`, lines: [] }],
      }],
    });
    // Contract: no error, and the line is truly deleted.
    expect(result).not.toContain("Error:");
    const final = await readFile(fp, "utf-8");
    expect(final).toBe("a\nc\nd\ne\n");
  });
});

// ════════════════════════════════════════════════════════════════════
// D4 — echo stripping must not delete legitimate content that merely
// equals the anchor/boundary line
// (stripInsertAnchorEcho text-normalize.ts:52-62;
//  stripRangeBoundaryEcho text-normalize.ts:91-124)
// ════════════════════════════════════════════════════════════════════

describe("D4 — echo stripping destroys legitimate content", () => {
  it("(g) append content whose first line equals the anchor line (consecutive '}') is fully preserved", () => {
    const content = "function f() {\n}";
    const anchorHash = computeLineHash("}", HASH_WIDTH, 2);
    const result = applyEditsWithReport(content, [
      { op: "append", pos: `2#${anchorHash}`, lines: "}\n}" },
    ], HASH_WIDTH);
    // Contract: both "}" lines are user content — neither is an echo.
    expect(result.content).toBe("function f() {\n}\n}\n}");
  });

  it("(h) range replace whose first new line equals the old start line keeps it", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `2#${hash5(2)}`, end: `4#${hash5(4)}`, lines: "b\nX" },
    ], HASH_WIDTH);
    // Contract: "b" is intended new content (re-using the boundary text);
    // it must survive as the first line of the replacement.
    expect(result.content).toBe("a\nb\nX\ne");
  });

  it("(h) range replace whose last new line equals the old end line keeps it", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `2#${hash5(2)}`, end: `4#${hash5(4)}`, lines: "X\nd" },
    ], HASH_WIDTH);
    expect(result.content).toBe("a\nX\nd\ne");
  });
});

// ════════════════════════════════════════════════════════════════════
// (i) documented ordering semantics
// ════════════════════════════════════════════════════════════════════

describe("(i) documented ordering semantics", () => {
  it("(i) adjacent ranges [1..2] + [3..4] both apply (no overlap, bottom-up)", () => {
    const result = applyEditsWithReport(CONTENT_5, [
      { op: "replace", pos: `1#${hash5(1)}`, end: `2#${hash5(2)}`, lines: "X" },
      { op: "replace", pos: `3#${hash5(3)}`, end: `4#${hash5(4)}`, lines: "Y" },
    ], HASH_WIDTH);
    // detectOverlappingRanges: [1..2] and [3..4] are disjoint → allowed.
    // Bottom-up applies [3..4] first, then [1..2].
    expect(result.content).toBe("X\nY\ne");
  });

  it("(i) same-line replace + append + prepend apply in documented order (replace → append → prepend)", () => {
    const edits = [
      { op: "replace" as const, pos: `3#${hash5(3)}`, lines: "R" },
      { op: "append" as const, pos: `3#${hash5(3)}`, lines: "A" },
      { op: "prepend" as const, pos: `3#${hash5(3)}`, lines: "P" },
    ];
    // Documented order (edit-ordering.ts:46-55, 62-75): replace(0) first, then
    // append(1), then prepend(2). Line 3 becomes: P, R, A (top to bottom).
    let error: unknown = null;
    let content = "";
    try {
      content = applyEditsWithReport(CONTENT_5, edits, HASH_WIDTH).content;
    } catch (e) {
      error = e;
    }
    // Contract: the three same-line edits must apply in the documented order.
    expect(error).toBeNull();
    expect(content).toBe("a\nb\nP\nR\nA\nd\ne");
  });
});
