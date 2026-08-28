// Adversarial test: hash-collision and fuzzy-misanchor suite.
//
// Width-2 anchors have only 4096 buckets (src/hashline/constants.ts:3,6 —
// BASE64_DICT is 64 chars, so 64^2 = 4096), so with a few thousand distinct
// content lines a hash collision is guaranteed (pigeonhole: 4097 distinct
// contents must share a bucket). No existing suite constructs such collisions;
// this one does, deterministically, and probes how the read → edit pipeline
// behaves when two DIFFERENT strings carry the same anchor hash.
//
// Content lines are unseeded (src/hashline/hash.ts:63-66 — any line containing
// a letter or digit gets seed ""), so computeLineHash(content, w) is
// position-independent for our "w2-collide-<n>" candidates — the collision is
// stable across line numbers.
//
// Scenarios:
//   helper — brute-force a width-2 collision pair within a bounded search
//            (4096 buckets ⇒ a pair is guaranteed well inside 10000 candidates).
//            PASS (control).
//   (a)    — fuzzy decoy: the caller's anchor is stale by +2 lines; a colliding
//            DECOY line sits at +1 (nearer). detectUniformOffset matches
//            candidates purely by hash equality within ±FUZZY_SEARCH_WINDOW
//            (src/hashline/fuzzy.ts:111-167, window at constants.ts:28). The
//            D5 guard (fuzzy.ts:192-209) detects that the uniform offsets map
//            the SAME anchor to content-DIFFERENT candidate lines (DECOY at +1
//            and TARGET at +2) and throws AmbiguousAnchorError rather than
//            guessing → the edit is rejected with an explicit error, nothing is
//            written, and the caller is told to re-read. Regression guard.
//   (b)    — collision accepted inside validateLineRefs (validation.ts:81-114):
//            an anchor whose line number points at a line whose content was
//            externally swapped for a colliding string validates cleanly (the
//            hash is unchanged), and the edit replaces that line. This
//            DOCUMENTS that anchors are position+hash — collisions at width 2
//            are accepted by design. Classified per observation (expected PASS).
//   (c)    — control at width 3 via ROLEBOX_HASHLINE_WIDTH=3 (env-guard
//            save/restore pattern from adversarial-hashwidth.test.ts:47-59):
//            the same layout, but the width-2 collision pair is re-verified
//            width-3 distinct, so the decoy no longer matches and the
//            correction lands on the TRUE target — width escalation mitigates.
//            PASS (control).
//
// Reproduce:
//   bun test tests/hashline/adversarial-hash-collision.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool, computeLineHash } from "../../src/hashline/index.ts";
import { HASH_WIDTH_ENV_VAR } from "../../src/hashline/constants.ts";

// ── Environment guard ──────────────────────────────────────────────
// ROLEBOX_HASHLINE_WIDTH is process-global (same pattern as
// tests/hashline/adversarial-hashwidth.test.ts:47-59). Every test that touches
// it must leave the environment exactly as it found it.

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
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adversarial-collision-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Brute-force a width-2 hash collision pair.
 *
 * Candidates are distinct content strings "w2-collide-<n>"; all are content
 * lines (letters/digits → unseeded, hash.ts:63-66), so their width-2 hashes
 * are position-independent. 4096 buckets (64^2, constants.ts:3,6) guarantee a
 * collision among the first 4097 distinct candidates (pigeonhole); the bound
 * of 10000 makes the search deterministic and quick.
 *
 * The returned pair additionally collides at width 2 but NOT at width 3 — the
 * (c) control needs a width-3-distinct pair (262144 buckets make a width-3
 * collision of any specific width-2 pair ~1/262144, so the first width-2
 * collision found is width-3 distinct with overwhelming probability; the
 * search simply keeps going if it ever isn't).
 *
 * @returns { a, b, hash, candidates } — two DIFFERENT strings whose width-2
 *   hash is `hash`, found after `candidates` strings were tried.
 */
function findWidth2CollisionPair(): { a: string; b: string; hash: string; candidates: number } {
  const seen = new Map<string, string>();
  const MAX_CANDIDATES = 10_000;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const content = `w2-collide-${n}`;
    const h2 = computeLineHash(content, 2);
    const prev = seen.get(h2);
    if (prev !== undefined) {
      // Prefer a pair that is also width-3 distinct (needed by control (c)).
      if (computeLineHash(prev, 3) !== computeLineHash(content, 3)) {
        return { a: prev, b: content, hash: h2, candidates: n + 1 };
      }
      // Width-3 collision too — astronomically unlikely; keep searching.
    }
    seen.set(h2, content);
  }
  throw new Error(
    `no width-2 collision pair found within bounded search (${MAX_CANDIDATES} candidates; 4096 buckets guarantee one by 4097)`,
  );
}

/** Extract "old -> new" rows from the edit result's corrections_applied section. */
function parseCorrections(out: string): string[] {
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => l.includes("corrections_applied:"));
  if (idx === -1) return [];
  const res: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{4}(\d+#\S+) -> (\d+#\S+)/);
    if (m) res.push(`${m[1]} -> ${m[2]}`);
    else if (lines[i].trim() !== "") break;
  }
  return res;
}

/** Read through the real tool; return version + hashWidth + line→content array. */
async function readState(filePath: string): Promise<{ version: string; hashWidth: number; diskLines: string[] }> {
  const out = String(await createHashlineReadTool().execute({ filePath }));
  const version = out.match(/^version: (\S+)$/m)?.[1] ?? "";
  const hashWidth = parseInt(out.match(/^hashWidth: (\d+)$/m)?.[1] ?? "0", 10);
  const diskLines = (await readFile(filePath, "utf-8")).split("\n");
  return { version, hashWidth, diskLines };
}

// ── helper test ────────────────────────────────────────────────────

describe("collision-finding helper — brute-force width-2 collision (control, PASS)", () => {
  it("finds a width-2 collision pair within a bounded search and prints it", () => {
    const pair = findWidth2CollisionPair();
    expect(pair.a).not.toBe(pair.b);
    expect(computeLineHash(pair.a, 2)).toBe(pair.hash);
    expect(computeLineHash(pair.b, 2)).toBe(pair.hash);
    // Width-3 distinct (control (c) needs this; re-verified here).
    expect(computeLineHash(pair.a, 3)).not.toBe(computeLineHash(pair.b, 3));
    console.log(
      `[helper] width-2 collision pair found after ${pair.candidates} candidates: ` +
        `"${pair.a}" and "${pair.b}" both hash to "${pair.hash}" ` +
        `(width-3 hashes: "${computeLineHash(pair.a, 3)}" vs "${computeLineHash(pair.b, 3)}" — distinct)`,
    );
  });
});

// ── (a) fuzzy decoy: colliding line nearer than the true target ────

// Layout (V2, the file the caller's stale anchor is applied to):
//   line 1: filler-1
//   line 2: filler-2        ← caller's anchor line (their V1 had the target here)
//   line 3: DECOY           ← offset +1 — hash2(DECOY) === hash2(TARGET)
//   line 4: TARGET          ← offset +2 — the caller's TRUE intended target
// The stale anchor `2#hash2(TARGET)` mismatches at line 2. detectUniformOffset
// collects every line within ±FUZZY_SEARCH_WINDOW whose width-2 hash equals
// the expected hash → candidates at +1 (decoy) and +2 (target). The smallest
// |offset| wins (fuzzy.ts:150-153) → +1 → the correction edits the DECOY.

describe("(a) fuzzy decoy — a colliding line nearer than the true target", () => {
  it("ambiguous collision correction is rejected with an explicit anchor error", async () => {
    const pair = findWidth2CollisionPair();
    const [decoy, target] = [pair.a, pair.b];
    const h = pair.hash; // hash2(decoy) === hash2(target) === h

    // Determinism guard — fillers must not collide with h, or the candidate
    // set changes and the scenario is no longer the one being probed.
    for (const f of ["filler-1", "filler-2", "filler-3", "filler-4"]) {
      expect(computeLineHash(f, 2)).not.toBe(h);
    }
    expect(computeLineHash(decoy, 2)).toBe(h);
    expect(computeLineHash(target, 2)).toBe(h);

    const filePath = join(tmpDir, "a-fuzzy-decoy.txt");
    await writeFile(filePath, ["filler-1", "filler-2", decoy, target, "filler-3", "filler-4"].join("\n") + "\n", "utf-8");

    const state = await readState(filePath);
    expect(state.hashWidth).toBe(2); // ≤ 1000 lines → width 2, no env override

    // Caller's stale anchor: their V1 snapshot had the true target at line 2;
    // in the current file the target sits at line 4 (+2) with the decoy at 3 (+1).
    const staleAnchor = `2#${h}`;
    console.log(`[a] stale anchor: ${staleAnchor} (true target '${target}' at line 4, decoy '${decoy}' at line 3, shared hash ${h})`);

    const out = String(
      await createHashlineEditTool().execute({
        files: [{ filePath, version: state.version, edits: [{ pos: staleAnchor, lines: "REPLACED" }] }],
      }),
    );
    const corrections = parseCorrections(out);
    console.log(`[a] edit success=${!out.includes("Error:")} corrections_applied=${JSON.stringify(corrections)}`);

    const disk = (await readFile(filePath, "utf-8")).split("\n");
    const editedLine = disk.indexOf("REPLACED") + 1;
    console.log(`[a] 'REPLACED' landed at line ${editedLine} (contract: true target at 4; decoy sits at 3)`);
    console.log(`[a] final file content: ${JSON.stringify(disk)}`);

    // CONTRACT (D5): the corrected anchor is ambiguous — the uniform offsets map
    // the SAME mismatch to content-different candidate lines (DECOY at +1,
    // TARGET at +2). fuzzy.ts:192-209 throws AmbiguousAnchorError instead of
    // guessing (silently preferring the smallest |offset| would edit the wrong
    // line). The edit is rejected with an explicit "Error:" + hash-collision
    // wording + hashline_read re-read guidance, and NOTHING is written.
    const originalContent = ["filler-1", "filler-2", decoy, target, "filler-3", "filler-4"].join("\n") + "\n";

    // Rejection: an explicit error, never a silent wrong-line edit.
    expect(out).toContain("Error:");
    expect(out).toContain("Ambiguous anchor"); // ambiguity + hash-collision wording
    expect(out).toContain("hash collision");
    expect(out).toContain("hashline_read"); // re-read guidance

    // File is byte-identical to the pre-edit fixture: neither the decoy (line 3)
    // nor the target (line 4) was replaced.
    expect(editedLine).toBe(0); // "REPLACED" landed on NO line
    expect(disk[2]).toBe(decoy); // line 3 untouched
    expect(disk[3]).toBe(target); // line 4 untouched
    expect((await readFile(filePath, "utf-8"))).toBe(originalContent);

    // No corrections_applied success output accompanies a rejected edit.
    expect(corrections).toHaveLength(0);
  });
});

// ── (b) collision accepted inside validateLineRefs (documented) ─────

// The caller captured `2#h` (hash of content T). The file is externally
// swapped so line 2 now holds the colliding string D (hash2(D) === h) — the
// colliding content is written BEFORE the read, so the version the caller
// passes to edit matches the current file (the whole-file version check is
// otherwise a blocker). validateLineRefs (validation.ts:81-114) computes
// hash2(D) === h → the anchor validates, and the edit replaces line 2 — the
// line the caller SAW at that position. Anchors are position+hash; the
// collision is accepted by design at width 2. Classified per observation.

describe("(b) collision inside validateLineRefs — anchors are position+hash (documented behavior)", () => {
  it("an anchor whose line holds a colliding string validates and the edit replaces that line (documented-limitation)", async () => {
    const pair = findWidth2CollisionPair();
    const [original, swapped] = [pair.a, pair.b];
    const h = pair.hash;

    for (const f of ["stable-line-1", "stable-line-2", "stable-line-3"]) {
      expect(computeLineHash(f, 2)).not.toBe(h);
    }

    const filePath = join(tmpDir, "b-validate-collision.txt");
    // Caller's V1: line 2 holds `original` (hash h).
    await writeFile(filePath, ["stable-line-1", original, "stable-line-2", "stable-line-3"].join("\n") + "\n", "utf-8");
    const v1Read = String(await createHashlineReadTool().execute({ filePath }));
    const v1Hash = v1Read.match(/^2#([A-Za-z0-9_-]+)\|/m)?.[1];
    expect(v1Hash).toBe(h);

    // External swap: line 2's content becomes the colliding string. Written
    // BEFORE the read so the caller's edit version matches the file.
    await writeFile(filePath, ["stable-line-1", swapped, "stable-line-2", "stable-line-3"].join("\n") + "\n", "utf-8");
    const v2Read = String(await createHashlineReadTool().execute({ filePath }));
    const v2Version = v2Read.match(/^version: (\S+)$/m)?.[1] ?? "";
    const v2Hash = v2Read.match(/^2#([A-Za-z0-9_-]+)\|/m)?.[1];
    console.log(`[b] v1 line-2 hash = ${v1Hash}, v2 line-2 hash = ${v2Hash}, unchanged across swap = ${v1Hash === v2Hash}`);

    // The caller edits with their V1 anchor + the CURRENT version.
    const out = String(
      await createHashlineEditTool().execute({
        files: [{ filePath, version: v2Version, edits: [{ pos: `2#${v1Hash}`, lines: "REPLACED" }] }],
      }),
    );
    console.log(`[b] edit success=${!out.includes("Error:")}`);
    const disk = (await readFile(filePath, "utf-8")).split("\n");
    console.log(`[b] final file content: ${JSON.stringify(disk)}`);

    // DOCUMENTED behavior: the anchor `2#h` resolves position+hash to line 2,
    // whose (colliding) content passes validation. The edit replaces the line
    // the caller saw at that position — the colliding string, not the content
    // they intended — because width-2 collisions are accepted by design.
    expect(out).not.toContain("Error:");
    expect(disk[1]).toBe("REPLACED"); // line 2 replaced
  });
});

// ── (c) control: width escalation to 3 defeats the collision ───────

// Identical layout to (a), but the whole pipeline runs at width 3
// (ROLEBOX_HASHLINE_WIDTH=3 honored by hash.ts:41-50). The width-2 collision
// pair is re-verified width-3 distinct, so the decoy at line 3 no longer
// matches the expected hash — the only fuzzy candidate is the true target at
// +2, and the correction lands there. Width escalation mitigates.

describe("(c) control — width escalation to 3 defeats the collision (control, PASS)", () => {
  it("same decoy layout at width 3: correction lands on the TRUE target, not the decoy", async () => {
    process.env[HASH_WIDTH_ENV_VAR] = "3";

    const pair = findWidth2CollisionPair();
    const [decoy, target] = [pair.a, pair.b];
    const h3 = computeLineHash(target, 3);
    expect(computeLineHash(decoy, 3)).not.toBe(h3); // width-3 distinct — re-verified
    for (const f of ["filler-1", "filler-2", "filler-3", "filler-4"]) {
      expect(computeLineHash(f, 3)).not.toBe(h3);
    }

    const filePath = join(tmpDir, "c-width3-decoy.txt");
    await writeFile(filePath, ["filler-1", "filler-2", decoy, target, "filler-3", "filler-4"].join("\n") + "\n", "utf-8");

    const state = await readState(filePath);
    expect(state.hashWidth).toBe(3); // env override honored

    const staleAnchor = `2#${h3}`;
    const out = String(
      await createHashlineEditTool().execute({
        files: [{ filePath, version: state.version, edits: [{ pos: staleAnchor, lines: "REPLACED" }] }],
      }),
    );
    const corrections = parseCorrections(out);
    console.log(`[c] stale anchor: ${staleAnchor}; edit success=${!out.includes("Error:")} corrections_applied=${JSON.stringify(corrections)}`);

    const disk = (await readFile(filePath, "utf-8")).split("\n");
    const editedLine = disk.indexOf("REPLACED") + 1;
    console.log(`[c] 'REPLACED' landed at line ${editedLine} (contract: true target at 4)`);

    // CONTROL: at width 3 the decoy's hash differs from the target's, so the
    // only fuzzy candidate is the true target at +2 → correction lands there.
    expect(editedLine).toBe(4);
  });
});
