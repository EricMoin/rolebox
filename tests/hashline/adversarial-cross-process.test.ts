import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createHashlineEditTool, createHashlineReadTool } from "../../src/hashline/index.ts";

// Adversarial CROSS-PROCESS race suite for hashline_edit.
//
// Why this suite exists: every existing concurrency test
// (concurrency.test.ts, adversarial-batch-concurrency.test.ts) uses
// Promise.all inside ONE process, where the per-path FIFO mutex
// (src/hashline/path-lock.ts:18-88) actually serializes same-file edits.
// Cross-process coverage is ZERO — the mutex is documented in-process-only
// (docs/limitations.md:30), and cross-process conflicts rely solely on the
// best-effort pre-write recheck (docs/limitations.md:33, a strict CAS it is
// not). This suite exercises REAL separate OS processes via
// `Bun.spawn([process.execPath, fixture, ...])` and a marker-file barrier
// protocol (no wall-clock sleeps — the worker's `beforeWrite` seam is the
// deterministic hold point, src/hashline/hashline-edit.ts:363-387).
//
// Classification convention:
//  - BEHAVIOR-AS-DOCUMENTED: the outcome matches the documented contract
//    (docs/limitations.md:30/33). Logged via console.log; test PASSES.
//  - SUSPECTED-DEFECT: the outcome violates the documented contract. Logged
//    and asserted by a [SUSPECTED-DEFECT]-titled test that is expected to fail
//    if (and only if) the anomaly is observed.
//
// POSIX-only: worker spawning + marker-file barriers are exercised on the
// POSIX platform; win32 is skipped (rule: it.skipIf(process.platform === "win32")).

const FIXTURE = fileURLToPath(new URL("./fixtures/cross-process-worker.ts", import.meta.url));
const WIN32 = process.platform === "win32";

const MARKER_WAIT_MS = 15_000; // bounded deadline for marker-file barriers
const WORKER_DEADLINE_MS = 30_000; // worker's own bounded hold deadline

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hashline-xproc-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Read a file with hashline_read and return version + per-line anchors. */
async function readInfo(filePath: string): Promise<{ version: string; anchors: Record<number, string> }> {
  const out = String(await createHashlineReadTool().execute({ filePath }));
  const m = out.match(/^version: (\S+)$/m);
  if (!m) throw new Error(`no version in hashline_read output for ${filePath}:\n${out}`);
  const anchors: Record<number, string> = {};
  for (const line of out.split("\n")) {
    const am = line.match(/^(\d+)#([A-Za-z0-9_-]+)\|/);
    if (am) anchors[Number(am[1])] = `${am[1]}#${am[2]}`;
  }
  return { version: m[1], anchors };
}

/** Busy-wait for a marker file to appear, bounded by a deadline. */
async function waitForMarker(markerPath: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await access(markerPath);
      return true;
    } catch {
      // not yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Write a marker file (release / gate signals). */
async function writeMarker(markerPath: string): Promise<void> {
  await writeFile(markerPath, "1", "utf-8");
}

/**
 * Spawn a REAL separate OS process running the cross-process worker fixture
 * and collect its JSON result ({ok, result, round}) from the result file
 * (primary) or stdout (fallback).
 */
async function runWorker(args: string[], markerId: string, markerDir: string): Promise<{ ok: boolean; result: string }> {
  const proc = Bun.spawn([process.execPath, FIXTURE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errOut] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const code = await proc.exited;

  const resultFile = join(markerDir, `result-${markerId}.json`);
  try {
    const parsed = JSON.parse(await readFile(resultFile, "utf-8")) as { ok: boolean; result: string };
    return parsed;
  } catch {
    // Fall back to the last parseable JSON line on stdout.
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as { ok: boolean; result: string };
      } catch {
        // keep scanning
      }
    }
    return {
      ok: false,
      result: `worker ${markerId} exited ${code} without a parseable result.\nstdout: ${out}\nstderr: ${errOut}`,
    };
  }
}

/** Common base file content for all race targets: 3 lines, no surprises. */
async function seedTarget(dir: string, name: string): Promise<string> {
  const fp = join(dir, name);
  await writeFile(fp, "alpha\nbeta\ngamma\n", "utf-8");
  return fp;
}

// ── Scenario (b) observation state ─────────────────────────────────────────
// Populated by the (b) control test, consumed by the [SUSPECTED-DEFECT] test.
// Tests in a file run sequentially, so ordering is guaranteed.
const raceState = {
  rounds: 20,
  bothSuccessCount: 0,
  bothSuccessRounds: [] as number[],
  neitherRounds: [] as Array<{ round: number; finalContent: string; aOk: boolean; bOk: boolean }>,
};

describe("hashline_edit adversarial cross-process races", () => {
  it.skipIf(WIN32)(
    "(a) deterministic interleave — worker holds at beforeWrite; a conflicting edit completes; the held worker fails the recheck and the completed edit survives (control, PASS)",
    async () => {
      const dir = join(tmpDir, "a");
      const markerDir = join(dir, "markers");
      await mkdir(markerDir, { recursive: true });
      const fp = await seedTarget(dir, "target.txt");
      const { version, anchors } = await readInfo(fp);

      // Worker A: edits line 2, holds at beforeWrite until released.
      const markerA = "a-worker";
      const workerA = runWorker(
        [
          "--target", fp,
          "--version", version,
          "--op", "replace",
          "--pos", anchors[2],
          "--line", "WORKER-A-EDIT",
          "--marker", markerA,
          "--marker-dir", markerDir,
          "--mode", "hold",
          "--deadline-ms", String(WORKER_DEADLINE_MS),
        ],
        markerA,
        markerDir,
      );

      // A must reach its critical section (beforeWrite) before we interleave.
      const heldA = await waitForMarker(join(markerDir, `held-${markerA}.marker`), MARKER_WAIT_MS);
      expect(heldA, "worker A never entered its critical section (held marker not seen)").toBe(true);

      // Parent (this process) completes a conflicting edit on the SAME base
      // version — a real cross-process change landing while A is paused.
      const parentResult = String(
        await createHashlineEditTool().execute({
          files: [{ filePath: fp, version, edits: [{ pos: anchors[1], lines: "PARENT-EDIT" }] }],
        }),
      );
      expect(parentResult).not.toContain("Error:");
      const afterParent = await readFile(fp, "utf-8");
      expect(afterParent).toContain("PARENT-EDIT");

      // Release A. Its pre-write recheck must now detect the change.
      await writeMarker(join(markerDir, `release-${markerA}.marker`));
      const resA = await workerA;

      // Documented contract (docs/limitations.md:33): the best-effort recheck
      // catches cross-process changes that land BEFORE the recheck. A must fail
      // with the recheck conflict and write nothing.
      expect(resA.ok, `worker A unexpectedly succeeded:\n${resA.result}`).toBe(false);
      expect(resA.result).toContain("File version mismatch");
      expect(resA.result).toContain("No files were written");

      // The completed (parent) edit survives; A's edit is absent.
      const finalContent = await readFile(fp, "utf-8");
      expect(finalContent).toContain("PARENT-EDIT");
      expect(finalContent).not.toContain("WORKER-A-EDIT");

      console.log(
        "[scenario (a)] BEHAVIOR-AS-DOCUMENTED: held worker's pre-write recheck caught the cross-process change that landed before the recheck; batch aborted with zero writes; parent edit survived (docs/limitations.md:33).",
      );
    },
    60_000,
  );

  it.skipIf(WIN32)(
    "(b) free-running race N=20 — final content always matches at least one claimed-success result; both-success (lost update) rounds are recorded, not failures (control, PASS)",
    async () => {
      const dir = join(tmpDir, "b");
      const markerDir = join(dir, "markers");
      await mkdir(markerDir, { recursive: true });

      for (let i = 1; i <= raceState.rounds; i++) {
        const fp = await seedTarget(dir, `race-${i}.txt`);
        const { version, anchors } = await readInfo(fp);
        const lineA = `RACE-A-${i}`;
        const lineB = `RACE-B-${i}`;
        const markerA = `b-${i}-a`;
        const markerB = `b-${i}-b`;
        const gateId = `g-${i}`;

        // Both workers share the SAME base version and race without holds.
        // Spawn both, then open the start gate so they begin ~simultaneously.
        const workerA = runWorker(
          ["--target", fp, "--version", version, "--op", "replace", "--pos", anchors[1], "--line", lineA, "--marker", markerA, "--marker-dir", markerDir, "--mode", "free", "--gate", gateId],
          markerA,
          markerDir,
        );
        const workerB = runWorker(
          ["--target", fp, "--version", version, "--op", "replace", "--pos", anchors[2], "--line", lineB, "--marker", markerB, "--marker-dir", markerDir, "--mode", "free", "--gate", gateId],
          markerB,
          markerDir,
        );
        await writeMarker(join(markerDir, `gate-${gateId}.marker`));

        const [resA, resB] = await Promise.all([workerA, workerB]);
        const finalContent = await readFile(fp, "utf-8");

        // Claimed-success contents, matched against what is on disk.
        const claimed: string[] = [];
        if (resA.ok) claimed.push(lineA);
        if (resB.ok) claimed.push(lineB);
        const matched = claimed.some((c) => finalContent.includes(c));

        if (resA.ok && resB.ok) {
          raceState.bothSuccessCount++;
          raceState.bothSuccessRounds.push(i);
          console.log(
            `[scenario (b)] round ${i}: BOTH workers reported success — lost update in the recheck→rename window (documented limitation, docs/limitations.md:33). Final content matches: "${claimed.find((c) => finalContent.includes(c))}".`,
          );
        }

        if (!matched) {
          raceState.neitherRounds.push({ round: i, finalContent, aOk: resA.ok, bOk: resB.ok });
          console.log(
            `[scenario (b)] SUSPECTED-DEFECT: round ${i} — final content matched NO claimed-success result. A ok=${resA.ok}, B ok=${resB.ok}. final=${JSON.stringify(finalContent)}`,
          );
          console.log(`  A result: ${resA.result.slice(0, 400)}`);
          console.log(`  B result: ${resB.result.slice(0, 400)}`);
        }
      }

      // Correct-contract invariant: every round's final content must match at
      // least one worker that claimed success. A violation here is a defect
      // (the atomic rename always leaves exactly one writer's full content).
      expect(raceState.neitherRounds).toHaveLength(0);
      expect(raceState.bothSuccessCount).toBeGreaterThanOrEqual(0); // observational, never a failure

      console.log(
        `[scenario (b)] cross-process free-running race: ${raceState.rounds} rounds. both-success (lost update in recheck→rename window, docs/limitations.md:33) count = ${raceState.bothSuccessCount}${raceState.bothSuccessRounds.length > 0 ? ` (rounds ${raceState.bothSuccessRounds.join(", ")})` : " (window never hit in this run)"}.`,
      );
      console.log(
        `[scenario (b)] BEHAVIOR-AS-DOCUMENTED: final content matched at least one claimed-success result in all ${raceState.rounds} rounds (no lost content, no unaccounted writes).`,
      );
    },
    240_000,
  );

  it("[SUSPECTED-DEFECT] cross-process free-running race produced final content matching no claimed-success result (runs only when the anomaly is observed)", () => {
    // The (b) control test above asserts the same invariant and will already
    // fail; this test exists so the defect carries the required
    // [SUSPECTED-DEFECT] title in the run output. When no anomaly is observed
    // (the expected outcome), the empty array trivially passes.
    expect(raceState.neitherRounds).toHaveLength(0);
  });

  it.skipIf(WIN32)(
    "(c) in-process-lock non-extension — two processes are NOT serialized by the path lock; both reach their critical sections concurrently (control, PASS)",
    async () => {
      const dir = join(tmpDir, "c");
      const markerDir = join(dir, "markers");
      await mkdir(markerDir, { recursive: true });
      const fp = await seedTarget(dir, "target.txt");
      const { version, anchors } = await readInfo(fp);

      // Both workers hold at beforeWrite. If the per-path mutex extended
      // across processes, the second worker would block at acquirePathLock and
      // never reach its critical section while the first still holds.
      const markerA = "c-worker-a";
      const markerB = "c-worker-b";
      const workerA = runWorker(
        ["--target", fp, "--version", version, "--op", "replace", "--pos", anchors[1], "--line", "C-EDIT-A", "--marker", markerA, "--marker-dir", markerDir, "--mode", "hold", "--deadline-ms", String(WORKER_DEADLINE_MS)],
        markerA,
        markerDir,
      );
      const workerB = runWorker(
        ["--target", fp, "--version", version, "--op", "replace", "--pos", anchors[2], "--line", "C-EDIT-B", "--marker", markerB, "--marker-dir", markerDir, "--mode", "hold", "--deadline-ms", String(WORKER_DEADLINE_MS)],
        markerB,
        markerDir,
      );

      const heldA = await waitForMarker(join(markerDir, `held-${markerA}.marker`), MARKER_WAIT_MS);
      expect(heldA, "worker A never entered its critical section").toBe(true);
      // B enters its critical section while A is still held → no cross-process
      // serialization. This is the documented in-process-only mutex
      // (docs/limitations.md:30).
      const heldB = await waitForMarker(join(markerDir, `held-${markerB}.marker`), MARKER_WAIT_MS);
      expect(heldB, "worker B was BLOCKED by worker A — the path lock appears to extend across processes (contradicts docs/limitations.md:30)").toBe(true);

      // Release both; collect outcomes.
      await writeMarker(join(markerDir, `release-${markerA}.marker`));
      await writeMarker(join(markerDir, `release-${markerB}.marker`));
      const [resA, resB] = await Promise.all([workerA, workerB]);

      // At least one edit must land (both started from the same valid version;
      // the loser fails the recheck, and a both-success round is the documented
      // recheck→rename window).
      const anySuccess = resA.ok || resB.ok;
      expect(anySuccess, `neither worker reported success:\nA: ${resA.result}\nB: ${resB.result}`).toBe(true);

      console.log(
        "[scenario (c)] BEHAVIOR-AS-DOCUMENTED: both worker processes were inside their critical sections (held markers observed) before any release — the per-path mutex serializes within one process only (docs/limitations.md:30).",
      );
      console.log(
        `[scenario (c)] outcomes after release: A ok=${resA.ok}, B ok=${resB.ok}${resA.ok && resB.ok ? " (both-success = documented recheck→rename window, docs/limitations.md:33)" : resA.ok ? " (A won, B failed the recheck)" : " (B won, A failed the recheck)"}.`,
      );
    },
    60_000,
  );
});
