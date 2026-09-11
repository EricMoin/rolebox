import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createHashlineReadTool,
  createHashlineEditTool,
} from "../../src/hashline/index.ts";

// ---------------------------------------------------------------------------
// D1 (defect under test): version skew between hashline_edit's returned
// version and the version hashline_read computes after the edit lands.
//
// Root cause:
//   - src/hashline/hashline-read.ts:65  — version = computeFileVersion(content),
//     where `content` is the canonical file content, which RETAINS trailing
//     newlines (canonicalizeFileText only strips BOM and normalizes EOLs).
//   - src/hashline/hashline-edit.ts:218 — version = computeFileVersion(resultContent),
//     where `resultContent` is applyEditsWithReport's `currentLines.join("\n")`
//     (src/hashline/edit-primitives.ts:275) — a join has NO trailing newline
//     terminator. The trailing newlines are restored for the WRITE
//     (hashline-edit.ts:203-207, then restoreFileText at :217), but the
//     returned version is computed from the join WITHOUT them.
//
// Consequence: for any file whose canonical content ends in "\n" (single
// trailing newline, CRLF, BOM, multiple trailing newlines), the version
// returned by edit differs from the version a fresh read reports for the
// same file on disk, and a second edit trusting the edit-returned version is
// rejected by the version guard (hashline-edit.ts:132-141) with
// "File version mismatch". Files WITHOUT a trailing newline roundtrip
// consistently — that is the control boundary.
//
// These tests assert the CORRECT contract. A failing assertion is a defect
// reproduction (bun test exits non-zero — the expected outcome of this file).
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adv-roundtrip-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---- hashline_read output parsing ------------------------------------------

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

// ---- shared steps -----------------------------------------------------------

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

// Anchorless append used for the "second edit" probes: the ONLY gate is the
// version guard, so a stale anchor can never confound the attribution (version
// validation at hashline-edit.ts:132-141 runs before anchor validation at
// :167-168).
async function appendTail(fp: string, version: string): Promise<string> {
  return createHashlineEditTool().execute({
    files: [{ filePath: fp, version, edits: [{ op: "append", lines: "TAIL" }] }],
  });
}

// ---------------------------------------------------------------------------

describe("adversarial version roundtrip (D1: trailing-newline version skew)", () => {
  describe("(a) edit-returned version must equal the fresh-read version after the edit lands", () => {
    it("single trailing newline — edit version skews from read version [DEFECT: D1]", async () => {
      const fp = join(tmpDir, "a-single-trailing-nl.txt");
      await writeFile(fp, "alpha\nbeta\ngamma\n", "utf-8");

      const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
      const editOut = await editLineTwo(fp, read1, "BETA_EDITED");

      // Sanity: the edit itself succeeded and wrote the file.
      expect(editOut).not.toContain("Error:");
      expect(await readFile(fp, "utf-8")).toBe("alpha\nBETA_EDITED\ngamma\n");

      const editVersion = parseEditVersion(editOut);
      const freshReadVersion = await readVersion(fp);

      // CORRECT CONTRACT: the version edit returns must be the version a fresh
      // read reports for the file it just wrote. edit computes it from
      // resultContent WITHOUT the trailing newline (hashline-edit.ts:218);
      // read computes it from canonical content WITH it (hashline-read.ts:65).
      expect(editVersion).toBe(freshReadVersion);
    });
  });

  describe("(b) edit-returned version must be directly usable for a second edit (no re-read)", () => {
    it("single trailing newline — second edit rejected with File version mismatch [DEFECT: D1]", async () => {
      const fp = join(tmpDir, "b-second-edit.txt");
      await writeFile(fp, "one\ntwo\nthree\n", "utf-8");

      const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
      const edit1 = await editLineTwo(fp, read1, "TWO_EDITED");
      expect(edit1).not.toContain("Error:");
      const v1 = parseEditVersion(edit1);

      // Second edit, no re-read: version = v1 (the version edit #1 returned).
      const edit2 = await appendTail(fp, v1);

      // CORRECT CONTRACT: a version returned by edit is a valid version for
      // the next edit. Under D1 the file on disk has a trailing newline the
      // returned version was not computed over → version guard rejects it.
      expect(edit2).not.toContain("Error:");
      expect(edit2).not.toContain("File version mismatch");
    });
  });

  describe("(c) same two assertions across CRLF / BOM / multiple-trailing-newline files", () => {
    const variants = [
      {
        name: "CRLF",
        content: "alpha\r\nbeta\r\ngamma\r\n",
        finalAfterEdit: "alpha\r\nBETA_EDITED\r\ngamma\r\n",
      },
      {
        name: "BOM",
        content: "\uFEFFalpha\nbeta\ngamma\n",
        finalAfterEdit: "\uFEFFalpha\nBETA_EDITED\ngamma\n",
      },
      {
        name: "multiple trailing newlines",
        content: "alpha\nbeta\ngamma\n\n\n",
        finalAfterEdit: "alpha\nBETA_EDITED\ngamma\n\n\n",
      },
    ];

    for (const v of variants) {
      const slug = v.name.replace(/\s+/g, "-");

      it(`(c) ${v.name}: edit version equals fresh-read version [DEFECT: D1]`, async () => {
        const fp = join(tmpDir, `c-${slug}-roundtrip.txt`);
        await writeFile(fp, v.content, "utf-8");

        const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
        const editOut = await editLineTwo(fp, read1, "BETA_EDITED");

        expect(editOut).not.toContain("Error:");
        expect(await readFile(fp, "utf-8")).toBe(v.finalAfterEdit);

        const editVersion = parseEditVersion(editOut);
        const freshReadVersion = await readVersion(fp);

        expect(editVersion).toBe(freshReadVersion);
      });

      it(`(c) ${v.name}: edit-returned version usable for a second edit [DEFECT: D1]`, async () => {
        const fp = join(tmpDir, `c-${slug}-second-edit.txt`);
        await writeFile(fp, v.content, "utf-8");

        const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
        const edit1 = await editLineTwo(fp, read1, "BETA_EDITED");
        expect(edit1).not.toContain("Error:");
        const v1 = parseEditVersion(edit1);

        const edit2 = await appendTail(fp, v1);

        expect(edit2).not.toContain("Error:");
        expect(edit2).not.toContain("File version mismatch");
      });
    }
  });

  describe("(d) control — no trailing newline: version roundtrip is consistent (PASS boundary)", () => {
    it("no trailing newline: edit version equals fresh-read version [CONTROL: PASS]", async () => {
      const fp = join(tmpDir, "d-no-trailing-nl-roundtrip.txt");
      await writeFile(fp, "alpha\nbeta\ngamma", "utf-8");

      const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
      const editOut = await editLineTwo(fp, read1, "BETA_EDITED");

      expect(editOut).not.toContain("Error:");
      expect(await readFile(fp, "utf-8")).toBe("alpha\nBETA_EDITED\ngamma");

      const editVersion = parseEditVersion(editOut);
      const freshReadVersion = await readVersion(fp);

      expect(editVersion).toBe(freshReadVersion);
    });

    it("no trailing newline: edit-returned version usable for a second edit [CONTROL: PASS]", async () => {
      const fp = join(tmpDir, "d-no-trailing-nl-second-edit.txt");
      await writeFile(fp, "one\ntwo\nthree", "utf-8");

      const read1 = parseReadOutput(await readTool.execute({ filePath: fp }));
      const edit1 = await editLineTwo(fp, read1, "TWO_EDITED");
      expect(edit1).not.toContain("Error:");
      const v1 = parseEditVersion(edit1);

      const edit2 = await appendTail(fp, v1);

      expect(edit2).not.toContain("Error:");
      expect(edit2).not.toContain("File version mismatch");
      expect(await readFile(fp, "utf-8")).toBe("one\nTWO_EDITED\nthree\nTAIL");
    });
  });
});
