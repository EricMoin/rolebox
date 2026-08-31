import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { createRequire } from "node:module";
import {
  mkdtemp, writeFile, readFile, rm, mkdir, link, readdir, stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHashlineReadTool, createHashlineEditTool } from "../../src/hashline/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SUBTASK 4 — Batch partial-write & hardlink-ordering adversarial suite.
//
// Focus: what lands on disk when atomicWriteBatch fails, specifically around
// HARDLINKED files (nlink > 1). resolveWriteTarget (src/hashline/atomic-write.ts:
// 25-36) marks hardlinked files `inPlace`, and atomicWriteBatch writes them IN
// PLACE at :99-103 — during the TEMP-write phase, BEFORE later files' temp
// writes are validated. Hardlink aliases are NOT deduplicated: normalizeLockKey
// (src/hashline/path-lock.ts:32-42) uses realpathSync + case-folding, but
// hardlinks are peer directory entries — realpath does not fold them.
//
// Classification conventions:
//  - Documented behavior / control → assert the DOCUMENTED contract, PASS.
//  - Regression guard → assert the CORRECT (now-fixed) contract, log on-disk
//    evidence via console.log, PASS (guards against reintroduction of the defect).
//  - Every scenario logs a [CLASSIFY:] line for the triage report.
//
// Scenarios already asserted elsewhere (NOT re-tested here):
//  - Regular-file batch temp-write failure (zero writes, "Write failed"/ENOENT
//    message, temp cleanup): tests/hashline/adversarial-batch-concurrency.test.ts
//    (e). NOTE: that test even comments (:191-192) that "Write failed:" lacks
//    the "Error:" prefix but never asserts it — subtask 4 (d) is the assertion.
//  - Single hardlink edit write-through (in-place, both names observe the edit):
//    tests/hashline/adversarial-path-alias.test.ts (c). Subtask 4 (a)/(b) are
//    the BATCH variants (hardlink as first batch entry + later failure; hardlink
//    alias PAIR in one batch) — not covered there.
//  - Symlink-alias duplicate rejection: tests/hashline/adversarial-path-alias.
//    test.ts (a). Subtask 4 (b) is the HARDLINK variant — realpath folds symlink
//    chains but not hardlink aliases, so the outcome differs.
//  - Mid-flight fs-state via the beforeWrite seam (dir swap / chmod / symlink
//    swap / truncation): tests/hashline/adversarial-midflight-fsstate.test.ts.
//    Subtask 4 (e) uses the rename-interception seam (probe YES from subtask 1,
//    tests/hashline/adversarial-fs-seam-probe.test.ts) for the RENAME-phase
//    failure — a different window, not covered there.
// ─────────────────────────────────────────────────────────────────────────────

// ── Rename-interception seam (subtask 1 probe technique, PROBE RESULT: YES) ──
// mock.module is hoisted by bun above the static imports of this file, so when
// atomic-write.ts evaluates its `import { ... } from "node:fs/promises"` the
// bindings resolve to this mock. The factory spreads the GENUINE module via
// createRequire(import.meta.url)("node:fs/promises") — which bypasses the ESM
// mock registry (verified empirically on bun 1.3.14) — and overrides only
// `rename`. `intercept` defaults off, so scenarios (a)-(d) pass through the
// real rename; scenario (e) arms it to throw on the 2nd rename call.
const require = createRequire(import.meta.url);

const renameState = {
  intercept: false,
  failOnCall: 0,
  calls: 0,
  targets: [] as string[],
};

mock.module("node:fs/promises", () => {
  const real = require("node:fs/promises") as typeof import("node:fs/promises");
  const realRename = real.rename;
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renameState.calls += 1;
      renameState.targets.push(to);
      if (renameState.intercept && renameState.calls === renameState.failOnCall) {
        // Simulate a mid-batch rename failure: this rename NEVER lands.
        throw new Error(`EIO: simulated rename failure on ${to}`);
      }
      return realRename(from, to);
    },
  };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-adv-batch-partial-"));
});

afterAll(async () => {
  // Global temp discipline: no .tmp files may remain anywhere in the tree.
  const leftovers = await collectTmpFiles(tmpDir);
  expect(leftovers, `no .tmp leftovers after the run: ${JSON.stringify(leftovers)}`).toHaveLength(0);
  await rm(tmpDir, { recursive: true, force: true });
});

const readTool = createHashlineReadTool();
const editTool = createHashlineEditTool();

async function readVersion(filePath: string): Promise<string> {
  const out = String(await readTool.execute({ filePath }));
  const m = out.match(/^version: (\S+)$/m);
  if (!m) throw new Error(`no version in hashline_read output for ${filePath}:\n${out}`);
  return m[1];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Recursively collect every *.tmp file below `dir`. */
async function collectTmpFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // missing dir (never created) — nothing to scan
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".tmp")) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

describe("hashline adversarial batch partial-write & hardlink ordering", () => {
  // ── (a) Hardlink in-place ordering: in-place write lands BEFORE a later
  //        temp-write failure → partial batch visible, error omits the write ──
  it.skipIf(process.platform === "win32")(
    "(a) hardlinked batch member is NOT written in place before a later temp-write failure: batch-write failure leaves every file unmodified and the error names the affected files (regression guard)",
    async () => {
      const f1 = join(tmpDir, "a1-f1.txt");
      const f1Hard = join(tmpDir, "a1-f1-hard.txt");
      await writeFile(f1, "one\ntwo\n", "utf-8");
      await link(f1, f1Hard); // nlink > 1 → hardlinked
      const missingDir = join(tmpDir, "a1-missing");
      const f2 = join(missingDir, "a2-f2.txt"); // temp write will fail (ENOENT)
      const version = await readVersion(f1);
      const nlinkBefore = (await stat(f1)).nlink;

      const r = String(await editTool.execute({
        files: [
          { filePath: f1, version, edits: [{ op: "append" as const, lines: "AAA" }] },
          { filePath: f2, version: "whatever", edits: [{ op: "append" as const, lines: "BBB" }] },
        ],
      }));

      const f1After = await readFile(f1, "utf-8");
      const f1HardAfter = await readFile(f1Hard, "utf-8");
      const f2Exists = await exists(f2);
      console.log(`[CLASSIFY:(a)] nlink before: ${nlinkBefore} | f1 after: ${JSON.stringify(f1After)} | f1-hard after: ${JSON.stringify(f1HardAfter)} | f2 exists: ${f2Exists}`);
      console.log(`[CLASSIFY:(a)] tool output:\n${r}`);
      console.log(
        `[CLASSIFY:(a)] evidence: hardlinked file (nlink=${nlinkBefore}>1) resolves to inPlace=true (atomic-write.ts:25-36); atomicWriteBatch writes it IN PLACE at :99-103 during the temp phase, BEFORE the second entry's temp write fails with ENOENT — the two-phase "temps first, renames after" discipline is violated for hardlinks: a temp-phase failure leaves a user-visible partial batch, and the error message names neither the landed write (f1) nor the failed entry (f2)`,
      );

      // Documented contract: a failure while staging temp writes must leave
      // every file unmodified (nothing is renamed until ALL temps succeed).
      expect(f1After).toBe("one\ntwo\n");
      expect(f1HardAfter).toBe("one\ntwo\n");
      // Error honesty: the message must identify which files were/were not written.
      expect(r).toContain(f1);
      expect(r).toContain(f2);
      // The failed entry must not have been created.
      expect(f2Exists).toBe(false);
      // Temp discipline: no .tmp leftovers.
      expect(await collectTmpFiles(tmpDir)).toHaveLength(0);
    },
  );

  // ── (b) Hardlink-alias pair in one batch: must be rejected as duplicate ──
  it.skipIf(process.platform === "win32")(
    "(b) batch containing a file AND its hardlink alias is rejected as a duplicate (same file twice) (regression guard)",
    async () => {
      const target = join(tmpDir, "b-target.txt");
      const alias = join(tmpDir, "b-alias.txt");
      const original = "T1\nT2\n";
      await writeFile(target, original, "utf-8");
      await link(target, alias); // same inode, nlink = 2

      const r = String(await editTool.execute({
        files: [
          { filePath: target, version: await readVersion(target), edits: [{ op: "append" as const, lines: "TAIL-A" }] },
          { filePath: alias, version: await readVersion(alias), edits: [{ op: "append" as const, lines: "TAIL-B" }] },
        ],
      }));

      const targetContent = await readFile(target, "utf-8");
      const aliasContent = await readFile(alias, "utf-8");
      const nlink = (await stat(target)).nlink;
      console.log(`[CLASSIFY:(b)] tool output (head): ${r.split("\n").slice(0, 3).join(" | ")}`);
      console.log(`[CLASSIFY:(b)] nlink: ${nlink} | target: ${JSON.stringify(targetContent)} | alias: ${JSON.stringify(aliasContent)}`);
      console.log(
        `[CLASSIFY:(b)] evidence: normalizeLockKey (path-lock.ts:32-42) uses realpathSync + case-folding; hardlinks are peer directory entries so realpath does NOT fold them — both entries get distinct keys, duplicate detection (hashline-edit.ts:319-342) misses the alias, and the batch's SECOND in-place write (atomic-write.ts:99-103) truncates the shared inode, silently discarding the FIRST edit (TAIL-A absent)`,
      );

      // Correct contract (documented "Duplicate file paths in one batch are
      // rejected", hashline-edit.ts:319-342): both paths ARE the same file.
      expect(r).toContain("Error:");
      expect(r).toContain("Duplicate filePath");
      // No write may land.
      expect(targetContent).toBe(original);
      expect(aliasContent).toBe(original);
      expect(await collectTmpFiles(tmpDir)).toHaveLength(0);
    },
  );

  // ── (c) Trailing-slash duplicate spelling: "dir/f.txt" + "dir/f.txt/" ──
  it("(c) trailing-slash spelling of an existing batch member is rejected as a duplicate (same file) (regression guard)", async () => {
    const sub = join(tmpDir, "c-sub");
    await mkdir(sub, { recursive: true });
    const fp = join(sub, "f.txt");
    const slashAlias = join(sub, "f.txt/"); // trailing slash on a regular file
    const original = "C1\nC2\n";
    await writeFile(fp, original, "utf-8");
    const version = await readVersion(fp);

    const r = String(await editTool.execute({
      files: [
        { filePath: fp, version, edits: [{ op: "append" as const, lines: "CX" }] },
        { filePath: slashAlias, version, edits: [{ op: "append" as const, lines: "CY" }] },
      ],
    }));

    const after = await readFile(fp, "utf-8");
    console.log(`[CLASSIFY:(c)] tool output:\n${r}`);
    console.log(`[CLASSIFY:(c)] fp after: ${JSON.stringify(after)}`);
    console.log(
      `[CLASSIFY:(c)] evidence: realpathSync('f.txt/') throws ENOTDIR (trailing slash on a regular file) so normalizeLockKey falls back to path.resolve, which strips the slash but yields a DIFFERENT string than realpathSync('f.txt') when a parent segment is a symlink (/var -> /private/var on darwin) — the two spellings get distinct lock keys and bypass duplicate detection; the batch then fails with a misleading 'Error reading file ... ENOTDIR' instead of the documented duplicate rejection, and lists the OTHER entry under 'Succeeded files:' although nothing was written`,
    );

    // Correct contract: both spellings denote the same file → duplicate
    // rejection with zero side effects. (If the platform folds the keys, this
    // passes as a control; on darwin it reproduces the bypass — recorded below.)
    expect(r).toContain("Duplicate filePath");
    // Either way: no write may land, no temp may remain.
    expect(after).toBe(original);
    expect(await collectTmpFiles(tmpDir)).toHaveLength(0);
  });

  // ── (d) "Write failed" prefix inconsistency ──
  it("(d) write-failure error starts with the same 'Error:' prefix as every other failure path (regression guard)", async () => {
    const missingDir = join(tmpDir, "d-missing");
    const fp = join(missingDir, "d.txt");
    const r = String(await editTool.execute({
      files: [{ filePath: fp, version: "whatever", edits: [{ op: "append" as const, lines: "D" }] }],
    }));

    console.log(`[CLASSIFY:(d)] tool output:\n${r}`);
    console.log(
      `[CLASSIFY:(d)] evidence: hashline-edit.ts:418-420 returns 'Write failed: ...' while every other failure path returns 'Error: ...' (duplicate :336-341, per-file validation :363-377, recheck conflict :401-410, generic catch :458-462) — inconsistent prefix; a caller grepping for /^Error:/ misses this failure entirely`,
    );

    expect(r.startsWith("Error:")).toBe(true);
    expect(await collectTmpFiles(tmpDir)).toHaveLength(0);
  });

  // ── (e) Rename-phase failure (probe YES): first rename succeeds, second is
  //        intercepted to throw — documented limitations.md:34 semantics ──
  it.skipIf(process.platform === "win32")(
    "(e) mid-batch rename failure: earlier file updated, later untouched, temps cleaned (documented limitations.md:34 semantics, PASS)",
    async () => {
      const fa = join(tmpDir, "e-a.txt");
      const fb = join(tmpDir, "e-b.txt");
      const origA = "E1\nE2\n";
      const origB = "F1\nF2\n";
      await writeFile(fa, origA, "utf-8");
      await writeFile(fb, origB, "utf-8");
      const [va, vb] = await Promise.all([readVersion(fa), readVersion(fb)]);

      // Arm the seam: the 2nd rename of the NEXT batch throws (1st lands).
      renameState.intercept = true;
      renameState.failOnCall = renameState.calls + 2;
      let r: string;
      try {
        r = String(await editTool.execute({
          files: [
            { filePath: fa, version: va, edits: [{ op: "append" as const, lines: "EA" }] },
            { filePath: fb, version: vb, edits: [{ op: "append" as const, lines: "FB" }] },
          ],
        }));
      } finally {
        renameState.intercept = false;
      }

      const aAfter = await readFile(fa, "utf-8");
      const bAfter = await readFile(fb, "utf-8");
      console.log(`[CLASSIFY:(e)] tool output:\n${r}`);
      console.log(
        `[CLASSIFY:(e)] rename calls this run: ${renameState.targets.length} (${renameState.targets.join(" -> ")}) | fa: ${JSON.stringify(aAfter)} | fb: ${JSON.stringify(bAfter)}`,
      );
      console.log(
        `[CLASSIFY:(e)] semantics (docs/limitations.md:34): 'a write failure or crash mid-batch can leave earlier files updated and later files untouched' — fa (earlier) updated, fb (later) untouched, temp files cleaned`,
      );

      expect(r).toContain("Write failed");
      expect(aAfter).toBe("E1\nE2\nEA\n"); // earlier file updated
      expect(bAfter).toBe(origB); // later file untouched
      expect(await collectTmpFiles(tmpDir)).toHaveLength(0);
    },
  );
});
