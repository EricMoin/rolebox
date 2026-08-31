// Adversarial test: hashWidth boundaries (ROLEBOX_HASHLINE_WIDTH override +
// line-count escalation).
//
// These tests assert the CORRECT documented contract:
//   1. read anchors are directly usable in edit, for every width the schema
//      allows (edit schema: hashWidth min 2 max 8 — src/hashline/hashline-edit.ts:257);
//   2. after an edit, the reanchored anchors returned by edit are consistent
//      with a fresh read of the post-edit file;
//   3. read reports hashWidth consistent with the documented line-count thresholds.
//
// Today (a) and (b) FAIL — they reproduce two live defects:
//
//   D2 — HASHLINE_REF_PATTERN accepts only {2,4} hash chars
//        (src/hashline/constants.ts:18), while hashWidthForLineCount honors a
//        ROLEBOX_HASHLINE_WIDTH override of 2..8 (src/hashline/hash.ts:41-50,
//        specifically line 45). With the override ≥ 5, hashline_read emits
//        width-5..8 anchors (src/hashline/hashline-read.ts:108) that
//        parseLineRef rejects (src/hashline/validation.ts:33-38) with
//        "Invalid line reference" — so a read → edit round-trip fails.
//
//   D6c — after an edit pushes a file across a width threshold (999 → 1002
//        lines), edit computes the reanchored anchors with the PRE-EDIT
//        hashWidth (src/hashline/hashline-edit.ts:223 passes the pre-edit
//        hashWidth into reanchorChangedLines), while a fresh read escalates
//        the width (src/hashline/hash.ts:47-49). The width-2 reanchored
//        anchors can never equal the fresh width-3 anchors.
//
// (c) passes today — it pins the correct boundary contract.
//
// Reproduce:
//   bun test --isolate tests/hashline/adversarial-hashwidth.test.ts

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";
import { HASH_WIDTH_ENV_VAR } from "../../src/hashline/constants.ts";

// ── Environment guard ──────────────────────────────────────────────
// ROLEBOX_HASHLINE_WIDTH is process-global. Every test that touches it must
// leave the environment exactly as it found it (afterEach restore). The
// original value is captured at module load; each test starts with the var
// deleted so auto-escalation (test b, c) is deterministic.

const originalWidthEnv: string | undefined = process.env[HASH_WIDTH_ENV_VAR];

beforeEach(() => {
  delete process.env[HASH_WIDTH_ENV_VAR];
});

afterEach(() => {
  if (originalWidthEnv === undefined) {
    delete process.env[HASH_WIDTH_ENV_VAR];
  } else {
    process.env[HASH_WIDTH_ENV_VAR] = originalWidthEnv;
  }
});

// ── Fixtures ───────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adversarial-width-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

interface ReadEnvelope {
  version: string;
  hashWidth: number;
  totalLines: number;
  /** "LINE#HASH" reference for a line (no |content suffix). */
  anchor: (line: number) => string;
  /** Bare HASH for a line. */
  hash: (line: number) => string;
}

function parseReadOutput(output: string): ReadEnvelope {
  const lines = output.split("\n");
  const header = (key: string): string =>
    lines.find((l) => l.startsWith(`${key}: `))!.slice(`${key}: `.length);
  const annotated = new Map<number, string>();
  for (const line of lines) {
    const m = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (m) annotated.set(parseInt(m[1], 10), line);
  }
  return {
    version: header("version"),
    hashWidth: parseInt(header("hashWidth"), 10),
    totalLines: parseInt(header("totalLines"), 10),
    anchor: (line) => annotated.get(line)!.split("|")[0],
    hash: (line) => annotated.get(line)!.split("|")[0].split("#")[1],
  };
}

/** Extract "line N: oldHash → newHash" rows from an edit result. */
function parseReanchored(editOutput: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of editOutput.split("\n")) {
    const m = line.match(/^ {4}line (\d+): \S+ → (\S+)$/);
    if (m) map.set(parseInt(m[1], 10), m[2]);
  }
  return map;
}

// ── (a) D2: env override width ≥ 5 breaks the read→edit anchor contract ──

describe("ROLEBOX_HASHLINE_WIDTH ≥ 5 — read anchors must be directly usable in edit (D2)", () => {
  for (const width of [5, 6, 8]) {
    it(`width ${width}: anchor returned by read validates in edit`, async () => {
      const filePath = join(tmpDir, `env-width-${width}.txt`);
      const content =
        Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      await writeFile(filePath, content, "utf-8");

      process.env[HASH_WIDTH_ENV_VAR] = String(width);

      const readTool = createHashlineReadTool();
      const readOutput = (await readTool.execute({ filePath })) as string;
      const read = parseReadOutput(readOutput);

      // Sanity — read honors the override and emits width-`width` anchors
      // (hashline-read.ts:73 + hash.ts:42-46). Must pass.
      expect(read.hashWidth).toBe(width);
      expect(read.totalLines).toBe(10);
      const anchor = read.anchor(5);
      expect(anchor.length).toBe("5#".length + width);

      // Contract: read output is the direct input to edit (forward the
      // hashWidth exactly as read declared it — schema allows up to 8).
      const editTool = createHashlineEditTool();
      const editResult = (await editTool.execute({
        files: [
          { filePath, version: read.version, hashWidth: width, edits: [{ pos: anchor, lines: "EDITED 5" }] },
        ],
      })) as string;

      // D2 reproduction: parseLineRef matches HASHLINE_REF_PATTERN
      // (src/hashline/constants.ts:18 — {2,4}) and rejects width-5..8 hashes
      // (src/hashline/validation.ts:33-38) → "Error: Edit failed: Invalid
      // line reference: ...". FAILS today.
      expect(editResult).not.toContain("Error:");

      const diskContent = await readFile(filePath, "utf-8");
      expect(diskContent.split("\n")[4]).toBe("EDITED 5");
    });
  }
});

// ── (b) D6c: width escalation after edit makes reanchored anchors unusable ──

describe("width escalation (999 → 1002 lines) — edit reanchor must match a fresh read (D6c)", () => {
  it("reanchored newAnchor after crossing the 1000-line threshold equals a fresh read's anchor", async () => {
    const filePath = join(tmpDir, "escalate-999-to-1002.txt");
    const content =
      Array.from({ length: 999 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    const readTool = createHashlineReadTool();
    const readOutput = (await readTool.execute({ filePath })) as string;
    const read = parseReadOutput(readOutput);

    // Sanity — 999 lines stay at width 2. Must pass.
    expect(read.totalLines).toBe(999);
    expect(read.hashWidth).toBe(2);

    const anchor999 = read.anchor(999);

    // Append 3 lines after line 999 → 1002 lines → width escalates to 3.
    const editTool = createHashlineEditTool();
    const editResult = (await editTool.execute({
      files: [
        {
          filePath,
          version: read.version,
          edits: [
            { op: "append", pos: anchor999, lines: ["added-1000", "added-1001", "added-1002"] },
          ],
        },
      ],
    })) as string;

    // Precondition — the append itself succeeds (width 2 is still valid for
    // the pre-edit 999-line file). Must pass.
    expect(editResult).not.toContain("Error:");

    // The edit's reanchored map for the first inserted line.
    const reanchored = parseReanchored(editResult);
    const newAnchor1000 = reanchored.get(1000);
    expect(newAnchor1000).toBeDefined();

    // Fresh read of the post-edit file.
    const freshOutput = (await readTool.execute({ filePath })) as string;
    const fresh = parseReadOutput(freshOutput);
    expect(fresh.totalLines).toBe(1002);
    expect(fresh.hashWidth).toBe(3); // width escalated — must pass
    const freshHash1000 = fresh.hash(1000);

    // Contract: the edit's reanchored anchor (what a follow-up edit would
    // use) must equal the anchor a fresh read returns for the same line.
    //
    // D6c reproduction: reanchorChangedLines is called with the PRE-EDIT
    // hashWidth (2) at src/hashline/hashline-edit.ts:223, so the reanchored
    // width-2 anchor can never match the fresh width-3 anchor
    // (hash.ts:47-49 escalates at >1000 lines). FAILS today.
    expect(newAnchor1000).toBe(freshHash1000);
  });
});

// ── (c) boundary reads — hashWidth contract (must pass today) ──

describe("hashWidth boundary reads — read reports the documented thresholds (contract)", () => {
  it("read of a 1000-line file reports hashWidth 2", async () => {
    const filePath = join(tmpDir, "boundary-1000.txt");
    const content =
      Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    const readTool = createHashlineReadTool();
    const output = (await readTool.execute({ filePath })) as string;
    const read = parseReadOutput(output);

    expect(read.totalLines).toBe(1000);
    expect(read.hashWidth).toBe(2);
  });

  it("read of a 10000-line file reports hashWidth 3", async () => {
    const filePath = join(tmpDir, "boundary-10000.txt");
    const content =
      Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    const readTool = createHashlineReadTool();
    const output = (await readTool.execute({ filePath })) as string;
    const read = parseReadOutput(output);

    expect(read.totalLines).toBe(10000);
    expect(read.hashWidth).toBe(3);
  });

  it("read of a 10001-line file reports hashWidth 4", async () => {
    const filePath = join(tmpDir, "boundary-10001.txt");
    const content =
      Array.from({ length: 10001 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");

    const readTool = createHashlineReadTool();
    const output = (await readTool.execute({ filePath })) as string;
    const read = parseReadOutput(output);

    expect(read.totalLines).toBe(10001);
    expect(read.hashWidth).toBe(4);
  });
});
