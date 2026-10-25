
import { describe, expect, expectTypeOf, it } from "vitest";

import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { bindingsEqual } from "../../src/graph/outcome/acceptance.ts";
import type { ValidationBinding } from "../../src/graph/outcome/acceptance.ts";
import { readHostDerivedCompletionFact } from "../../src/graph/outcome/host-derived.ts";
import { readNaturalCompletionDelivery } from "../../src/graph/outcome/natural-completion.ts";
import {
  PROGRESS_EVALUATORS,
  PROGRESS_EVALUATOR_REVISION_TOKEN,
} from "../../src/graph/outcome/progress.ts";
import type { ProgressEvaluator } from "../../src/graph/outcome/progress.ts";
import { readOutcomeProposal } from "../../src/graph/outcome/proposal.ts";
import { DEFAULT_OUTCOME_STATE_BODY_REGISTRY } from "../../src/graph/outcome/state-codec.ts";
import type {
  OutcomeStateBodyReader,
  OutcomeStateBodyReading,
} from "../../src/graph/outcome/state-codec.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OUTCOME_STATE_BODY_V9,
  OUTCOME_STOP_REASONS,
} from "../../src/graph/outcome/state-model.ts";
import type { OutcomeStopReason } from "../../src/graph/outcome/state-model.ts";

// ── F-11: one read per field ────────────────────────────────────────────────

/**
 * One record whose `nodeId` is an ACCESSOR: the first read answers `first`,
 * every later read answers `second`. A reader that reads the field once stores
 * `first`; a reader that reads it for the check and again for the construction
 * stores `second`.
 */
function nodeIdAccessorRecord(
  first: unknown,
  second: unknown,
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...rest };
  let reads = 0;
  Object.defineProperty(record, "nodeId", {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? first : second;
    },
  });
  Object.defineProperty(record, "nodeIdReads", {
    enumerable: false,
    configurable: true,
    get: () => reads,
  });
  return record;
}

/** How many times the accessor above was asked for `nodeId`. */
function readsOf(record: Record<string, unknown>): number {
  const value = (record as { nodeIdReads?: unknown }).nodeIdReads;
  return typeof value === "number" ? value : -1;
}

describe("F-11: a closed reader reads each field exactly once", () => {
  it("keeps the proposal nodeId value it checked", () => {
    const record = nodeIdAccessorRecord("work", 42, { outcomeId: "done" });
    const reading = readOutcomeProposal(record);
    expect(readsOf(record)).toBe(1);
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") throw new Error("the proposal was refused");
    expect(reading.proposal.nodeId).toBe("work");
  });

  it("refuses a proposal whose nodeId answers a number on the first read", () => {
    const record = nodeIdAccessorRecord(42, "work", { outcomeId: "done" });
    const reading = readOutcomeProposal(record);
    expect(readsOf(record)).toBe(1);
    expect(reading.kind).toBe("malformed");
    if (reading.kind !== "malformed") throw new Error("the proposal was accepted");
    expect(reading.issues.map((issue) => issue.path)).toContain("$.nodeId");
    expect(
      reading.issues.some((issue) => issue.message.includes("not a non-empty node id")),
    ).toBe(true);
  });

  it("keeps the natural-completion nodeId value it checked", () => {
    const record = nodeIdAccessorRecord("work", 42, { attemptId: "work#1" });
    const reading = readNaturalCompletionDelivery(record);
    expect(readsOf(record)).toBe(1);
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") throw new Error("the delivery was refused");
    expect(reading.delivery.nodeId).toBe("work");
    expect(reading.delivery.attemptId).toBe("work#1");
  });

  it("keeps the host-derived nodeId value it checked", () => {
    const record = nodeIdAccessorRecord("work", 42, {
      attemptId: "work#1",
      executionId: "exec-1",
      outcomeId: "done",
    });
    const reading = readHostDerivedCompletionFact(record);
    expect(readsOf(record)).toBe(1);
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") throw new Error("the completion fact was refused");
    expect(reading.fact.nodeId).toBe("work");
  });
});

// ── F-13: blockedNodes elements are validated ───────────────────────────────

const GUARD_PLAN: CompiledPlan = buildDeclaredOutcomeGraph({
  declaration: {
    version: 3,
    name: "outcome-state-type-guards",
    nodes: [{ id: "A", agent: "agent-a", prompt: "prompt-a", outcomes: [{ id: "done" }] }],
    edges: [],
  },
}).plan;

/**
 * A stopped body that reaches the `unreachable-pending-node` reader BEFORE its
 * node list is checked, so the element rule can be exercised on its own.
 */
function stoppedBodyWithBlockedNodes(blockedNodes: unknown): Record<string, unknown> {
  return {
    bodyVersion: CURRENT_OUTCOME_STATE_BODY,
    graphId: GUARD_PLAN.graphId,
    planRevision: GUARD_PLAN.planRevision,
    phase: "stopped",
    nodes: [],
    loopTraversals: {},
    attemptSeq: 0,
    stop: {
      reason: "unreachable-pending-node",
      blockedNodes,
      stoppedAt: 1,
    },
    loopProgress: {},
  };
}

/** Read one crafted body through the reader the registry installs for it. */
function readStopBody(blockedNodes: unknown): OutcomeStateBodyReading {
  const reader = DEFAULT_OUTCOME_STATE_BODY_REGISTRY.formats.find(
    (format) => format.format === CURRENT_OUTCOME_STATE_BODY,
  );
  if (reader === undefined) throw new Error("fixture: no reader for the current body");
  return reader.read(stoppedBodyWithBlockedNodes(blockedNodes), GUARD_PLAN);
}

describe("F-13: blockedNodes elements are read like every other scalar", () => {
  it("refuses a numeric feeder id", () => {
    const reading = readStopBody({ A: [42] });
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the body was accepted");
    expect(reading.error.message).toContain('blockedNodes["A"].0');
    expect(reading.error.message).toContain("not a non-empty identifier");
  });

  it("refuses a nested-array feeder id", () => {
    const reading = readStopBody({ A: [["A"]] });
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the body was accepted");
    expect(reading.error.message).toContain('blockedNodes["A"].0');
    expect(reading.error.message).toContain("not a non-empty identifier");
  });

  it("lets a non-empty string feeder id through to the next guard", () => {
    const reading = readStopBody({ A: ["A"] });
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the body was accepted");
    expect(reading.error.message).not.toContain("not a non-empty identifier");
  });
});

// ── F-02: one list per closed vocabulary ────────────────────────────────────

describe("F-02: closed vocabularies and field lists are derived from their lists", () => {
  it("derives OutcomeStopReason from OUTCOME_STOP_REASONS", () => {
    expect([...OUTCOME_STOP_REASONS]).toEqual([
      "loop-exhausted",
      "progress-stalled",
      "unreachable-pending-node",
    ]);
    expectTypeOf<OutcomeStopReason>().toEqualTypeOf<(typeof OUTCOME_STOP_REASONS)[number]>();
    expectTypeOf<(typeof OUTCOME_STOP_REASONS)[number]>().toEqualTypeOf<
      "loop-exhausted" | "progress-stalled" | "unreachable-pending-node"
    >();
  });

  it("derives ProgressEvaluator from PROGRESS_EVALUATORS", () => {
    expect([...PROGRESS_EVALUATORS]).toEqual([PROGRESS_EVALUATOR_REVISION_TOKEN]);
    expectTypeOf<ProgressEvaluator>().toEqualTypeOf<(typeof PROGRESS_EVALUATORS)[number]>();
    expectTypeOf<(typeof PROGRESS_EVALUATORS)[number]>().toEqualTypeOf<"revision-token">();
  });

  it("compares every field of a ValidationBinding", () => {
    const base: ValidationBinding = {
      graphId: "graph",
      attemptId: "attempt",
      submissionId: "submission",
      planRevision: "revision",
      proposalDigest: "digest",
    };
    // The mapped type carries every declared field, so a new binding field
    // cannot be added without failing to compile this fixture.
    const changed: { readonly [K in keyof ValidationBinding]: ValidationBinding } = {
      graphId: { ...base, graphId: "other" },
      attemptId: { ...base, attemptId: "other" },
      submissionId: { ...base, submissionId: "other" },
      planRevision: { ...base, planRevision: "other" },
      proposalDigest: { ...base, proposalDigest: "other" },
    };
    for (const field of Object.keys(changed) as (keyof ValidationBinding)[]) {
      expect(bindingsEqual(base, changed[field])).toBe(false);
    }
    expect(bindingsEqual(base, { ...base })).toBe(true);
    expectTypeOf<keyof ValidationBinding>().toEqualTypeOf<
      "graphId" | "attemptId" | "submissionId" | "planRevision" | "proposalDigest"
    >();
  });
});

// ── F-20: the stop-reason vocabulary belongs to the body version ────────────

/** The reader the registry installs for one body version, if it reads it. */
function readerFor(version: number): OutcomeStateBodyReader | undefined {
  return DEFAULT_OUTCOME_STATE_BODY_REGISTRY.formats.find(
    (format) => format.format === version,
  );
}

/**
 * A stopped body at `version` whose node list is empty. The stop record is
 * read BEFORE the node list, so a body whose reason the version refuses is
 * refused for the REASON, while a body whose reason the version accepts gets
 * past that check and fails later on the node count.
 */
function versionedStoppedBody(
  version: number,
  stop: Record<string, unknown>,
): Record<string, unknown> {
  return {
    bodyVersion: version,
    graphId: GUARD_PLAN.graphId,
    planRevision: GUARD_PLAN.planRevision,
    phase: "stopped",
    nodes: [],
    loopTraversals: {},
    attemptSeq: 0,
    stop,
    loopProgress: {},
  };
}

/** Read one crafted body through the reader the registry installs for it. */
function readVersionedStopBody(
  version: number,
  stop: Record<string, unknown>,
): OutcomeStateBodyReading {
  const reader = readerFor(version);
  if (reader === undefined) throw new Error("fixture: no reader for body version " + version);
  return reader.read(versionedStoppedBody(version, stop), GUARD_PLAN);
}

const V10_ONLY_STOP: Record<string, unknown> = {
  reason: "unreachable-pending-node",
  blockedNodes: {},
  stoppedAt: 1,
};

describe("F-20: the stop-reason vocabulary is the version's, not the build's", () => {
  it("refuses a version-10 stop reason in a version-9 body", () => {
    const reading = readVersionedStopBody(OUTCOME_STATE_BODY_V9, V10_ONLY_STOP);
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the version-9 body was accepted");
    expect(reading.error.message).toContain("not a stop reason body version 9 defines");
    expect(reading.error.message).not.toContain("declares 1 node(s)");
  });

  it("reads the same stop through the version-10 reader, so the version is the only difference", () => {
    const reading = readVersionedStopBody(CURRENT_OUTCOME_STATE_BODY, V10_ONLY_STOP);
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the version-10 body was accepted");
    expect(reading.error.message).not.toContain("not a stop reason");
    expect(reading.error.message).toContain("declares 1 node(s)");
  });

  it("still reads the version-9 vocabulary through the version-9 reader", () => {
    const reading = readVersionedStopBody(OUTCOME_STATE_BODY_V9, {
      reason: "loop-exhausted",
      loopGroupId: "group",
      nodeId: "A",
      outcomeId: "done",
      attemptId: "A#1",
      traversals: 1,
      maxTraversals: 1,
      stoppedAt: 1,
    });
    expect(reading.kind).toBe("invalid");
    if (reading.kind !== "invalid") throw new Error("the version-9 body was accepted");
    expect(reading.error.message).not.toContain("not a stop reason");
  });
});
