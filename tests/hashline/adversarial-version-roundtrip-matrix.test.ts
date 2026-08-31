import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createHashlineReadTool,
  createHashlineEditTool,
} from "../../src/hashline/index.ts";

// ---------------------------------------------------------------------------
// Adversarial version round-trip MATRIX — EXTENDS (does not duplicate)
// tests/hashline/adversarial-version-roundtrip.test.ts.
//
// That suite already covers these shapes:
//   - single trailing newline (LF)
//   - uniform CRLF file
//   - BOM + LF
//   - multiple trailing newlines
//   - no trailing newline (control)
//
// This matrix covers content shapes NOT covered there, and for each asserts the
// same two D1 invariants:
//   (1) edit-returned version === a fresh hashline_read version of the
//       on-disk result;
//   (2) a chained second edit using the returned version succeeds WITHOUT a
//       re-read (the only gate is the version guard, hashline-edit.ts:132-141).
//
// D1 context: hashline-edit.ts:226-233 computes the returned version from the
// CANONICALIZED RESTORED content (canonicalizeFileText(finalContent).content),
// which must equal what hashline_read derives from the on-disk file
// (hashline-read.ts:64-65). This matrix probes that fix across shapes whose
// canonical/restored forms differ from the raw bytes:
//   - CR-only legacy files normalize to uniform CRLF on restore
//     (canonicalizeFileText hash.ts:159-165 + lineEols all-CRLF hash.ts:170-172);
//   - mixed CRLF+LF files keep PER-LINE terminators (buildLineEols hash.ts:118-131);
//   - BOM+CRLF files re-add the BOM on restore (restoreFileText hash.ts:209-211);
//   - empty / non-existent files are created by anchorless append
//     (applyAppend edit-primitives.ts:212-231);
//   - a 999→1002-line append crosses the width 2→3 threshold
//     (hashWidthForLineCount hash.ts:47-49);
//   - delete-all-lines (range replace with lines: []) yields a single blank
//     line ("\n") because the trailing newline is preserved (D5 splice
//     semantics edit-primitives.ts:116-125 + hashline-edit.ts:214-215);
//   - a "\n"-only file is one empty line (splitLines hash.ts:30-34) and an
//     anchorless append writes the new lines as the first lines
//     (degenerate-file rule, applyAppend edit-primitives.ts:226-228).
//
// All tests assert DOCUMENTED behavior and are expected to PASS with the D1 fix
// in place. A failure here means the fix does not generalize to that shape — a
// suspected residual defect, reported with the two mismatching version hashes.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adv-roundtrip-matrix-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---- hashline_read output parsing (same style as the base roundtrip suite) --

interface ParsedReadLine {
  line: number;
  hash: string;
  content: string;
}

interface ParsedRead {
  version: string;
  hashWidth: number;
  totalLines: number;
  lines: ParsedReadLine[];
}

function parseReadOutput(output: string): ParsedRead {
  const version = output.match(/^version: ([0-9a-f]{64})$/m)?.[1];
  const hashWidth = output.match(/^hashWidth: (\d+)$/m)?.[1];
  const totalLines = output.match(/^totalLines: (\d+)$/m)?.[1];
  if (!version || !hashWidth || !totalLines) {
    throw new Error(`unexpected hashline_read output:\n${output}`);
  }
  const lines: ParsedReadLine[] = [];
  const lineRe = /^(\d+)#([A-Za-z0-9_-]{2,8})\|(.*)$/gm;
  for (const m of output.matchAll(lineRe)) {
    lines.push({ line: Number(m[1]), hash: m[2], content: m[3] });
  }
  return {
    version,
    hashWidth: Number(hashWidth),
    totalLines: Number(totalLines),
    lines,
  };
}

function parseEditVersion(output: string): string {
  const m = output.match(/^version: ([0-9a-f]{64})$/m);
  if (!m) {
    throw new Error(`no top-level version line in hashline_edit output:\n${output}`);
  }
  return m[1];
}

function anchorFor(read: ParsedRead, lineNum: number): string {
  const entry = read.lines.find((l) => l.line === lineNum);
  if (!entry) throw new Error(`line ${lineNum} missing from read output`);
  return `${entry.line}#${entry.hash}`;
}

// ---- shared steps ----------------------------------------------------------

const readTool = createHashlineReadTool();

async function readVersion(fp: string): Promise<string> {
  return parseReadOutput(await readTool.execute({ filePath: fp })).version;
}

async function editLineTwo(fp: string, read1: ParsedRead, replacement: string): Promise<string> {
  return createHashlineEditTool().execute({
    files: [
      { filePath: fp, version: read1.version, edits: [{ pos: anchorFor(read1, 2), lines: replacement }] },
    ],
  });
}

// Anchorless append used for the chained second-edit probe: the ONLY gate is
// the version guard, so a stale anchor can never confound the attribution
// (version validation at hashline-edit.ts:132-141 runs before anchor
// validation at :167-168).
async function appendTail(fp: string, version: string): Promise<string> {
  return createHashlineEditTool().execute({
    files: [{ filePath: fp, version, edits: [{ op: "append", lines: "TAIL" }] }],
  });
}

/**
 * Assert both D1 invariants for one shape+edit:
 *  (1) edit-returned version === fresh-read version of the on-disk result;
 *  (2) a chained anchorless second edit using that version succeeds without
 *      re-read.
 * Logs the two version hashes per shape so the run output enumerates PASS/FAIL
 * with the evidence needed to diagnose a mismatch.
 */
async function assertVersionRoundtrip(
  shape: string,
  fp: string,
  edit1Out: string,
  expectedDiskAfterEdit1?: string,
  expectedDiskAfterEdit2?: string,
): Promise<string> {
  expect(edit1Out, `${shape}: first edit must succeed`).not.toContain("Error:");

  if (expectedDiskAfterEdit1 !== undefined) {
    expect(await readFile(fp, "utf-8"), `${shape}: on-disk result after edit 1`).toBe(expectedDiskAfterEdit1);
  }

  // Invariant (1): edit-returned version === fresh-read version.
  const v1 = parseEditVersion(edit1Out);
  const freshReadVersion = await readVersion(fp);
  console.log(
    `[matrix] ${shape} — invariant(1): editVersion=${v1} readVersion=${freshReadVersion} ` +
      `match=${v1 === freshReadVersion}`,
  );
  expect(v1, `${shape}: invariant(1) — edit-returned version must equal fresh-read version`).toBe(freshReadVersion);

  // Invariant (2): the returned version is directly usable for a second edit.
  const edit2 = await appendTail(fp, v1);
  console.log(`[matrix] ${shape} — invariant(2): second edit rejected=${edit2.includes("File version mismatch")}`);
  expect(edit2, `${shape}: invariant(2) — second edit must not error`).not.toContain("Error:");
  expect(edit2, `${shape}: invariant(2) — second edit must pass the version guard`).not.toContain("File version mismatch");

  if (expectedDiskAfterEdit2 !== undefined) {
    expect(await readFile(fp, "utf-8"), `${shape}: on-disk result after edit 2`).toBe(expectedDiskAfterEdit2);
  }

  return v1;
}

// ---------------------------------------------------------------------------

describe("adversarial version roundtrip matrix (D1 fix coverage across shapes)", () => {
  it("(1) CR-only legacy file 'a\\rb\\rc\\r' — normalized to CRLF on restore; invariants hold on the normalized result", async () => {
    const fp = join(tmpDir, "m1-cr-only.txt");
    await writeFile(fp, "a\rb\rc\r", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    // Documented normalization: CR-only canonicalizes to LF internally and is
    // restored as uniform CRLF (hash.ts:159-165, 170-172).
    const editOut = await editLineTwo(fp, read1, "B_EDITED");
    await assertVersionRoundtrip(
      "CR-only legacy",
      fp,
      editOut,
      "a\r\nB_EDITED\r\nc\r\n",
      "a\r\nB_EDITED\r\nc\r\nTAIL\r\n",
    );
  });

  it("(2) mixed CRLF+LF file — per-line terminators preserved; invariants hold", async () => {
    const fp = join(tmpDir, "m2-mixed-eol.txt");
    await writeFile(fp, "one\r\ntwo\nthree\r\nfour\n", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    const editOut = await editLineTwo(fp, read1, "TWO_EDITED");
    await assertVersionRoundtrip(
      "mixed CRLF+LF",
      fp,
      editOut,
      "one\r\nTWO_EDITED\nthree\r\nfour\n",
      "one\r\nTWO_EDITED\nthree\r\nfour\nTAIL\r\n",
    );
  });

  it("(3) BOM+CRLF combined file — BOM and CRLF re-added on restore; invariants hold", async () => {
    const fp = join(tmpDir, "m3-bom-crlf.txt");
    await writeFile(fp, "\uFEFFalpha\r\nbeta\r\ngamma\r\n", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    const editOut = await editLineTwo(fp, read1, "BETA_EDITED");
    await assertVersionRoundtrip(
      "BOM+CRLF",
      fp,
      editOut,
      "\uFEFFalpha\r\nBETA_EDITED\r\ngamma\r\n",
      "\uFEFFalpha\r\nBETA_EDITED\r\ngamma\r\nTAIL\r\n",
    );
  });

  it("(4) empty file + anchorless append — created content round-trips; invariants hold", async () => {
    const fp = join(tmpDir, "m4-empty-append.txt");
    await writeFile(fp, "", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    expect(read1.totalLines).toBe(0);
    const editOut = await createHashlineEditTool().execute({
      files: [{ filePath: fp, version: read1.version, edits: [{ op: "append", lines: "created-content" }] }],
    });
    await assertVersionRoundtrip(
      "empty file + anchorless append",
      fp,
      editOut,
      "created-content",
      "created-content\nTAIL",
    );
  });

  it("(5) non-existent file created via anchorless append; invariants hold", async () => {
    const fp = join(tmpDir, "m5-create-new.txt");
    // Version is not validated for to-be-created files (hashline-edit.ts:113-123,
    // 135-145); a dummy is supplied only to satisfy the schema.
    const editOut = await createHashlineEditTool().execute({
      files: [{ filePath: fp, version: "0".repeat(64), edits: [{ op: "append", lines: "brand new content" }] }],
    });
    await assertVersionRoundtrip(
      "non-existent file creation",
      fp,
      editOut,
      "brand new content",
      "brand new content\nTAIL",
    );
  });

  it("(6) 999-line file — append crosses the width 2→3 threshold; invariants hold", async () => {
    const fp = join(tmpDir, "m6-width-cross.txt");
    const content = Array.from({ length: 999 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(fp, content, "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    expect(read1.totalLines).toBe(999);
    expect(read1.hashWidth).toBe(2);

    const editOut = await createHashlineEditTool().execute({
      files: [{
        filePath: fp,
        version: read1.version,
        edits: [{ op: "append", lines: ["added-1000", "added-1001", "added-1002"] }],
      }],
    });
    expect(editOut).not.toContain("Error:");

    // The append pushes the file to 1002 lines → a fresh read escalates the
    // width to 3 (hash.ts:47-49). Invariant (1) must still hold: the edit's
    // returned version is computed from the canonicalized restored content
    // (hashline-edit.ts:226-233), independent of the width.
    const fresh = parseReadOutput(await readTool.execute({ filePath: fp }));
    expect(fresh.totalLines).toBe(1002);
    expect(fresh.hashWidth).toBe(3);
    const v1 = parseEditVersion(editOut);
    console.log(
      `[matrix] 999→1002 width-cross — invariant(1): editVersion=${v1} readVersion=${fresh.version} ` +
        `match=${v1 === fresh.version}`,
    );
    expect(v1).toBe(fresh.version);

    // Invariant (2): chained second edit with the returned version succeeds.
    const edit2 = await appendTail(fp, v1);
    console.log(`[matrix] 999→1002 width-cross — invariant(2): second edit rejected=${edit2.includes("File version mismatch")}`);
    expect(edit2).not.toContain("Error:");
    expect(edit2).not.toContain("File version mismatch");
    const fresh2 = parseReadOutput(await readTool.execute({ filePath: fp }));
    expect(fresh2.totalLines).toBe(1003);
    expect(fresh2.hashWidth).toBe(3);
  });

  it("(7) delete-all-lines (range replace with lines: []) — trailing newline preserved as one blank line; invariants hold", async () => {
    const fp = join(tmpDir, "m7-delete-all.txt");
    await writeFile(fp, "keep\nthis\nthat\n", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    const editOut = await createHashlineEditTool().execute({
      files: [{
        filePath: fp,
        version: read1.version,
        edits: [{ pos: anchorFor(read1, 1), end: anchorFor(read1, 3), lines: [] }],
      }],
    });
    // Documented: D5 zero-newLines splice deletes the whole range
    // (edit-primitives.ts:116-125) and the original trailing newline is
    // preserved (hashline-edit.ts:214-215) → on-disk result is "\n", a single
    // blank line that a fresh read reports as totalLines 1.
    await assertVersionRoundtrip("delete-all-lines", fp, editOut, "\n", "TAIL\n");
  });

  it("(8) single-blank-line file ('\\n') + append 'x' → 'x\\n'; invariants hold", async () => {
    const fp = join(tmpDir, "m8-blank-line.txt");
    await writeFile(fp, "\n", "utf-8");

    const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
    expect(read1.totalLines).toBe(1);
    const editOut = await createHashlineEditTool().execute({
      files: [{ filePath: fp, version: read1.version, edits: [{ op: "append", lines: "x" }] }],
    });
    // Documented degenerate-file rule: "\n" + append "x" → "x\n"
    // (applyAppend edit-primitives.ts:226-228).
    await assertVersionRoundtrip("single-blank-line file", fp, editOut, "x\n", "x\nTAIL\n");
  });
});
