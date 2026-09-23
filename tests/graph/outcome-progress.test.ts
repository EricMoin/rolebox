/**
 * Outcome-protocol progress evaluator (D5) — the comparison semantics alone.
 *
 * The run-path integration is covered by tests/graph/outcome-runtime.test.ts;
 * this file pins the RULE the comparison applies to the persisted record. In
 * particular: an unknown comparison CLEARS the consecutive-unchanged streak (it
 * never increments it and it never triggers the soft stop), while the baseline
 * is kept for the next comparison.
 */

import { describe, expect, it } from "bun:test";

import type { CompiledProgressPolicy } from "../../src/graph/compiler/plan.ts";
import type { ValidationBinding } from "../../src/graph/outcome/acceptance.ts";
import {
  compareProgress,
  projectProgress,
  type OutcomeLoopProgress,
  type ProgressProjection,
} from "../../src/graph/outcome/progress.ts";

const BINDING: ValidationBinding = Object.freeze({
  graphId: "graph.progress",
  attemptId: "review#2",
  submissionId: "submission-1",
  planRevision: "revision-1",
  proposalDigest: "digest-1",
});

const POLICY: CompiledProgressPolicy = Object.freeze({
  evaluator: "revision-token",
  version: 1,
  subject: "revision",
  maxUnchanged: 2,
});

/** One measured submission, exactly as the run path produces it. */
function projectionOf(data: unknown): ProgressProjection {
  const reading = projectProgress({
    binding: BINDING,
    loopGroupId: "revise-loop",
    nodeId: "review",
    outcomeId: "revise",
    policy: POLICY,
    data,
  });
  if (reading.kind !== "projected") throw new Error("fixture: the projection was refused");
  return reading.projection;
}

/** The progress record a loop starts with: no baseline, no count. */
function emptyEntry(): OutcomeLoopProgress {
  return Object.freeze({
    loopGroupId: "revise-loop",
    evaluator: POLICY.evaluator,
    version: POLICY.version,
    subject: POLICY.subject,
    unchanged: 0,
  });
}

describe("progress comparison — an unknown clears the streak", () => {
  it("answers r1 then unchanged then unknown then unchanged with counters 0, 1, 0, 1", () => {
    const verdicts: string[] = [];
    const counters: number[] = [];

    // 1. A first comparable token establishes the baseline and counts zero.
    const first = compareProgress({
      policy: POLICY,
      entry: emptyEntry(),
      projection: projectionOf({ revision: "r1" }),
    });
    verdicts.push(first.report.verdict);
    counters.push(first.report.unchanged);
    expect(first.report.baseline).toBe("r1");

    // 2. The same token: unchanged, so the streak is one.
    const same = compareProgress({
      policy: POLICY,
      entry: first.entry,
      projection: projectionOf({ revision: "r1" }),
    });
    verdicts.push(same.report.verdict);
    counters.push(same.report.unchanged);
    expect(same.report.stalled).toBe(false);

    // 3. UNKNOWN: a round this evaluator cannot judge is NOT a round in which
    // the run was observed to stand still, so the streak it never observed back
    // to back is cleared. The baseline stays: it is the last comparable revision
    // the run saw, and the next comparison must still answer against it.
    const unknown = compareProgress({
      policy: POLICY,
      entry: same.entry,
      projection: projectionOf({ revision: ["not", "a", "token"] }),
    });
    verdicts.push(unknown.report.verdict);
    counters.push(unknown.report.unchanged);
    expect(unknown.report.unknownReason).toBe("incomparable-value");
    expect(unknown.report.baseline).toBe("r1");
    expect(unknown.report.stalled).toBe(false);
    expect(unknown.entry.baseline).toBe("r1");

    // 4. Comparable again, the same token as the baseline: the streak starts
    // over at ONE, never two. Had it spanned the unknown, the declared threshold
    // of two would have stopped the run on a repetition nobody observed twice.
    const restarted = compareProgress({
      policy: POLICY,
      entry: unknown.entry,
      projection: projectionOf({ revision: "r1" }),
    });
    verdicts.push(restarted.report.verdict);
    counters.push(restarted.report.unchanged);
    expect(restarted.report.stalled).toBe(false);

    expect(verdicts).toEqual(["progressed", "unchanged", "unknown", "unchanged"]);
    expect(counters).toEqual([0, 1, 0, 1]);
  });

  it("never stops on an unknown, even at a threshold of one", () => {
    const policy: CompiledProgressPolicy = Object.freeze({ ...POLICY, maxUnchanged: 1 });
    const first = compareProgress({
      policy,
      entry: emptyEntry(),
      projection: projectionOf({ revision: "r1" }),
    });
    const unknown = compareProgress({
      policy,
      entry: first.entry,
      projection: projectionOf({ revision: "r1".repeat(300) }),
    });
    expect(unknown.report.verdict).toBe("unknown");
    expect(unknown.report.unknownReason).toBe("truncated-value");
    expect(unknown.report.unchanged).toBe(0);
    expect(unknown.report.stalled).toBe(false);
    expect(unknown.entry.baseline).toBe("r1");
    expect(unknown.entry.unchanged).toBe(0);
  });

  it("clears the streak on an evaluator-identity mismatch, keeping the recorded identity and baseline", () => {
    const first = compareProgress({
      policy: POLICY,
      entry: emptyEntry(),
      projection: projectionOf({ revision: "r1" }),
    });
    const same = compareProgress({
      policy: POLICY,
      entry: first.entry,
      projection: projectionOf({ revision: "r1" }),
    });
    expect(same.entry.unchanged).toBe(1);

    // A persisted record written under another evaluator version: the
    // comparison answers unknown, and the same rule applies — the count is not
    // carried, the baseline and the recorded identity are.
    const recorded: OutcomeLoopProgress = Object.freeze({ ...same.entry, version: 2 });
    const changed = compareProgress({
      policy: POLICY,
      entry: recorded,
      projection: projectionOf({ revision: "r1" }),
    });
    expect(changed.report.verdict).toBe("unknown");
    expect(changed.report.unknownReason).toBe("evaluator-identity-mismatch");
    expect(changed.report.version).toBe(2);
    expect(changed.report.unchanged).toBe(0);
    expect(changed.report.baseline).toBe("r1");
    expect(changed.entry.unchanged).toBe(0);
    expect(changed.entry.baseline).toBe("r1");
  });
});
