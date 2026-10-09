/**
 * THE MULTI-PROCESS CLAIM, AS A TEST RATHER THAN A PROMISE.
 *
 * Three REAL `bun` child processes write one channel into one directory at the
 * same time — through src/logger.ts's compatibility shell, through the kernel
 * API and through the JSON-lines sink itself — while a real `rolebox logs
 * --follow` process reads the live stream. The probe they all run in
 * (scripts/log-multiprocess-probe.ts) then checks, from the bytes on disk:
 *
 *   • every (writer, seq) appears EXACTLY once in the read layer's merged view;
 *   • every physical line is one complete record of this probe — no torn or
 *     interleaved line — and the raw scan agrees with the read layer;
 *   • rotation really happened (the run sets a 2 KB limit) and did not reorder
 *     any writer's own stream, and it happened AT the limit: every rotated copy
 *     is within `rotationBoundBytes` — ROLEBOX_LOG_MAX_BYTES plus one record per
 *     concurrent writer — which is what fails if the gate ever goes back to
 *     counting only the writing process's own bytes (that version produced
 *     copies at 2.26x the limit). The bound is in BYTES rather than a factor of
 *     the limit on purpose: the in-flight allowance is ~0.9x of a 1 KB limit and
 *     ~0.03x of a 32 KB one, so a factor check is not load-independent;
 *   • the merged view is ordered by `time`, ascending and its exact reverse;
 *   • the live follower delivered every one of those records exactly once, with
 *     no malformed line — and how much of the stream arrived out of `time`
 *     order is measured, because a file a rotation renamed past the follower's
 *     walk can be delivered one poll late.
 *
 * The `maxBytes`/`retain` pair is the point of the rotation part: retention is
 * set far above the volume, so the run's window cannot drop a record BY DESIGN —
 * anything missing is a genuine concurrent-rotation loss. That is exactly what
 * this suite caught before the sink coordinated rotation with a per-file lock:
 * the same probe configuration lost 70 of 1200 records then and none now.
 *
 * This case is slower than the rest of tests/log (it starts real processes and
 * waits for a poll), which is the price of testing processes instead of
 * pretending to.
 */

import { describe, expect, it } from "bun:test";

import { PROBE_WRITERS, runOnce } from "../../scripts/log-multiprocess-probe.ts";
import { removeDir, tempDir } from "../helpers/log.ts";

describe("multi-process log writes", () => {
  it("gives every record of three real processes exactly once, across rotations", async () => {
    const dir = tempDir("rolebox-multiprocess-");
    try {
      const run = await runOnce({ dir, records: 120, maxBytes: 2_048, retain: 4_096, delayMs: 0 });

      // Every check by name, so a failure says WHICH invariant broke — and the
      // second `expect` argument prints the probe's own follower counters beside
      // it. The name alone cannot separate a runner too slow to drain the stream
      // from a follower that really LOST records, and that distinction has to be
      // readable from the log: `followerRecords` against `expected` is HOW FAR
      // BEHIND the follower was when the case gave up (359-of-360 reads very
      // differently from 40-of-360), `followerMissing` is how many announced
      // records never arrived, `followerDuplicateRecords` is the repetition
      // counter, `followerLateRecords` reports cross-poll reordering, and
      // `elapsedMs` is what the case cost against the probe's catch-up bounds.
      expect(
        run.checks,
        `follower=${run.followerRecords}/${run.expected} missing=${run.followerMissing} ` +
          `duplicateRecords=${run.followerDuplicateRecords} late=${run.followerLateRecords} ` +
          `maxRotatedBytes=${run.maxRotatedBytes} rotationBoundBytes=${run.rotationBoundBytes} ` +
          `elapsedMs=${run.elapsedMs}`,
      ).toEqual({
        children: true,
        "exactly-once": true,
        "raw-lines": true,
        "writer-order": true,
        "merged-order": true,
        rotation: true,
        "rotation-bound": true,
        "follower-complete": true,
        "follower-missing": true,
        "follower-duplicates": true,
        "follower-malformed": true,
      });
      expect(run.expected).toBe(360);
      expect(run.observed).toBe(360);
      expect(run.missing).toBe(0);
      expect(run.duplicates).toBe(0);
      expect(run.parseFailures).toBe(0);
      expect(run.foreignLines).toBe(0);
      expect(run.skippedLines).toBe(0);
      // The run must have exercised rotation, or it proves nothing.
      expect(run.rotations).toBeGreaterThan(0);
      expect(run.followerRecords).toBeGreaterThan(0);
      // Rotation can delay a file past one poll, so the live stream is checked
      // for loss and duplication while reordering is reported separately.
      expect(run.followerMissing).toBe(0);
      expect(run.followerDuplicateRecords).toBe(0);
    } finally {
      removeDir(dir);
    }
  }, 60_000);

  it("holds the rotated-copy bound on a deep ladder, where the give-up used to blow it up", async () => {
    // review#8's R1 reproduction, as a test. A permanent give-up made ONE slow
    // rotation poison every later one: a rotation that outran ROTATE_WAIT_MS
    // latched "stop waiting" for the rest of the process's life, and every
    // record after it was appended into the file another process was renaming.
    // On this load (three real processes, one channel, a 4 KB limit, retention
    // 4096 far above the volume, writers back to back) that produced rotated
    // copies of 28,962-47,238 bytes — 7.1-11.5x the limit — in every run while
    // every record still arrived exactly once; without the permanent latch the
    // same load measures 4,598-4,606 bytes (1.123x).
    //
    // THE BOUND IS THE LIMIT PLUS ONE RECORD PER WRITER, and the bytes
    // assertion below states it: a fraction of the limit is not the invariant,
    // because the records already in flight when a rotation starts are part of
    // the copy. 512 bytes per writer is a margin over the probe's ~177-byte
    // records, and two orders of magnitude below the give-up's overshoot.
    const dir = tempDir("rolebox-multiprocess-deep-");
    try {
      const maxBytes = 4_096;
      const run = await runOnce({ dir, records: 1_000, maxBytes, retain: 4_096, delayMs: 0 });

      expect(run.expected).toBe(3_000);
      expect(run.observed).toBe(3_000);
      expect(run.missing).toBe(0);
      expect(run.duplicates).toBe(0);
      expect(run.parseFailures).toBe(0);
      expect(run.foreignLines).toBe(0);
      // The run must have rotated a ladder worth of copies, or it proves nothing.
      expect(run.rotations).toBeGreaterThan(10);
      // The load-independent bound: the limit plus one record per writer (512 B
      // each, over the probe's ~177-byte records). A writer appends after the
      // gate, so a record that passed the gate an instant before another process
      // rotated is IN the copy; anything beyond that allowance is a wait that
      // gave up and appended into a file being renamed.
      expect(run.maxRotatedBytes).toBeLessThanOrEqual(maxBytes + PROBE_WRITERS.length * 512);
      // The probe applies the same bound to its own check, in bytes: the limit
      // plus one measured record per writer (never below 512 B each). Pinning
      // both the number and the check keeps the probe honest if either drifts.
      expect(run.maxRecordBytes).toBeGreaterThan(0);
      expect(run.rotationBoundBytes).toBe(
        maxBytes + PROBE_WRITERS.length * Math.max(run.maxRecordBytes, 512),
      );
      expect(run.maxRotatedBytes).toBeLessThanOrEqual(run.rotationBoundBytes);
      expect(run.checks["rotation-bound"]).toBe(true);
    } finally {
      removeDir(dir);
    }
  }, 120_000);
});
