/// <reference types="bun-types" />

/**
 * P4.3 — the arm set agrees with the dispatches it produces, and every JOIN and
 * LOOP round binds its consumer to the attempt that triggered THAT round (R4).
 *
 * WHY THIS FILE EXISTS. The P4.3 gap analysis (.rolebox/evidence/p43-gaps.md)
 * confirmed one behaviour gap (G1) and one verification gap (G3): the join/loop
 * suites proved the ARRIVAL rules, but none of them combined a join or a loop
 * round with declared successor INPUTS, so nothing pinned that a consumer is
 * bound to the attempt of the round it was armed for. This file drives the REAL
 * OutcomeGraphRuntime over compiled plans that declare inputs, and asserts, per
 * round:
 *
 * - the consumer's inputs name the producing ATTEMPT of this round, never the
 *   previous round's attempt and never "the node's latest result";
 * - the same view reaches the DELIVERED OutcomeDispatchRequest, so a worker is
 *   handed the revision the arming decision resolved;
 * - the earlier round's accepted result still EXISTS while this happens (the
 *   binding moved on; the store did not);
 * - the persisted ARRIVALS of an armed node are exactly the inputs it was bound
 *   with, so a restart re-derives the same join decision.
 *
 * G1 — THE BEHAVIOUR FIX. A candidate whose join is satisfied can still be left
 * BLOCKED by its own declared input, and a blocked candidate keeps the settled
 * entry it had. The arm set must therefore not go on suppressing that candidate:
 * the first case below reproduces the divergence (the state's own arrivals
 * satisfied a convergence node's join:all while the node was never armed) and
 * pins the fix. The NEGATIVE CONTROL is the join:all round-2 case below: when the
 * co-candidate really IS re-entered, its stale arrival must NOT arm the join —
 * the sibling case in outcome-runtime.test.ts ("a loop join is decided per
 * round") covers the same rule without declared inputs.
 *
 * NOT DECIDED HERE: a join:any/quorum consumer that declares inputs from MORE
 * feeders than its threshold waits for the last declared producer (O1 in the gap
 * analysis). The any case below declares its input from exactly the feeder it is
 * armed on, so the open question is neither pinned nor changed by this file.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 *
 * @module
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { CompiledPlan } from "../../src/graph/compiler/plan.ts";
import { SqliteAcceptanceLedger } from "../../src/graph/ledger/sqlite-ledger.ts";
import type { AttemptCredentialSource } from "../../src/graph/outcome/attempt-credential.ts";
import {
  type OutcomeGraphState,
  type OutcomeNodeState,
} from "../../src/graph/outcome/graph-state.ts";
import {
  OutcomeGraphRuntime,
  type OutcomeDispatchRequest,
  type OutcomeSubmissionResult,
} from "../../src/graph/outcome/runtime.ts";
import { createValidatorRegistry } from "../../src/graph/outcome/validators.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { testHostCredentialIsolation } from "./helpers/credential-isolation.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const EMPTY_VALIDATORS = createValidatorRegistry([]);

/** A deterministic credential source: one value per attempt BINDING. */
const CREDENTIAL_SOURCE: AttemptCredentialSource = (binding) =>
  "join-input-credential:" + binding.nodeId + "#" + binding.attemptId;

/**
 * G1: the shape the gap analysis reproduced. d and s are the entries; the
 * rounds loop is [d, p, x, c] with "again" as its continuation.
 *
 *   d --boot--> p, x      p --ready--> x       x --again--> c, d
 *   d --again--> p, x, c  s --ready--> c
 *
 * x declares join:any and consumes p/ready; c joins ALL of {d, x, s} and
 * consumes all three. d/again therefore re-enters BOTH p and x, while x's own
 * input names p — so x is blocked and stays on its old attempt. c's join needs
 * that old attempt, and this is the advance that must arm it.
 */
function blockedCandidateDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.blocked-candidate",
    nodes: [
      { id: "d", agent: "agent.d", prompt: "Drive.", outcomes: [{ id: "boot" }, { id: "again" }] },
      { id: "p", agent: "agent.p", prompt: "Produce.", outcomes: [{ id: "ready" }] },
      {
        id: "x",
        agent: "agent.x",
        prompt: "Consume.",
        outcomes: [{ id: "again" }, { id: "halt" }],
        join: { strategy: "any" },
        inputs: [{ from: "p", outcome: "ready" }],
      },
      {
        id: "c",
        agent: "agent.c",
        prompt: "Converge.",
        outcomes: [{ id: "finish" }],
        join: { strategy: "all" },
        inputs: [
          { from: "d", outcome: "again" },
          { from: "x", outcome: "again" },
          { from: "s", outcome: "ready" },
        ],
      },
      { id: "s", agent: "agent.s", prompt: "Seed.", outcomes: [{ id: "ready" }] },
    ],
    edges: [
      { from: "d", to: "p", outcome: "boot" },
      { from: "d", to: "x", outcome: "boot" },
      { from: "p", to: "x", outcome: "ready" },
      { from: "x", to: "c", outcome: "again" },
      { from: "x", to: "d", outcome: "again" },
      { from: "d", to: "p", outcome: "again" },
      { from: "d", to: "x", outcome: "again" },
      { from: "d", to: "c", outcome: "again" },
      { from: "s", to: "c", outcome: "ready" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["d", "p", "x", "c"],
        max_traversals: 5,
        continuation_outcome: "again",
        exit_outcome: "halt",
      },
    ],
  };
}

/**
 * R4a: work -> review -> (revise) -> work, where REVIEW consumes work's accepted
 * "done" result. Every round re-enters work, so every round must re-bind the
 * consumer to the attempt that opened it.
 */
function guidedLoopDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.guided-loop",
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "revise-loop",
        nodes: ["work", "review"],
        max_traversals: 20,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

/**
 * R4b: the splitter s fans out to a and b, which converge on j with join:all;
 * j's continuation re-enters the loop at s. ALL THREE declare inputs, so every
 * round has to wait for BOTH branches again AND bind each new attempt to that
 * round's producing attempts.
 */
function loopJoinInputsDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.loop-join-inputs",
    nodes: [
      { id: "s", agent: "agent.s", prompt: "Open a round.", outcomes: [{ id: "next" }] },
      {
        id: "a",
        agent: "agent.a",
        prompt: "Branch A.",
        outcomes: [{ id: "done" }],
        inputs: [{ from: "s", outcome: "next" }],
      },
      {
        id: "b",
        agent: "agent.b",
        prompt: "Branch B.",
        outcomes: [{ id: "done" }],
        inputs: [{ from: "s", outcome: "next" }],
      },
      {
        id: "j",
        agent: "agent.j",
        prompt: "Join.",
        outcomes: [{ id: "again" }, { id: "exit" }],
        join: { strategy: "all" },
        inputs: [
          { from: "a", outcome: "done" },
          { from: "b", outcome: "done" },
        ],
      },
    ],
    edges: [
      { from: "s", to: "a", outcome: "next" },
      { from: "s", to: "b", outcome: "next" },
      { from: "a", to: "j", outcome: "done" },
      { from: "b", to: "j", outcome: "done" },
      { from: "j", to: "s", outcome: "again" },
    ],
    loop_groups: [
      {
        id: "rounds",
        nodes: ["s", "a", "b", "j"],
        max_traversals: maxTraversals,
        continuation_outcome: "again",
        exit_outcome: "exit",
      },
    ],
  };
}

/**
 * R4c2: the diamond with join:any, where the consumer's declared input names
 * ONLY the first branch. The join is satisfied by that branch, so the consumer is
 * armed on it; the second branch then arrives while the consumer is in flight and
 * must not re-bind or re-arm it.
 */
function diamondAnyDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.diamond-any-input",
    nodes: [
      { id: "arb", agent: "agent.arb", prompt: "Split.", outcomes: [{ id: "split" }] },
      { id: "brc", agent: "agent.brc", prompt: "Branch B.", outcomes: [{ id: "done" }] },
      { id: "crb", agent: "agent.crb", prompt: "Branch C.", outcomes: [{ id: "done" }] },
      {
        id: "djoin",
        agent: "agent.djoin",
        prompt: "Join.",
        outcomes: [{ id: "merged" }],
        join: { strategy: "any" },
        inputs: [{ from: "brc", outcome: "done" }],
      },
    ],
    edges: [
      { from: "arb", to: "brc", outcome: "split" },
      { from: "arb", to: "crb", outcome: "split" },
      { from: "brc", to: "djoin", outcome: "done" },
      { from: "crb", to: "djoin", outcome: "done" },
    ],
  };
}

/**
 * Quorum + successor inputs: three branches fan out and the consumer declares
 * quorum:2 over TWO declared inputs. It must wait for the second, then be bound
 * to exactly those two producers — and the third, unselected branch must leave
 * the running attempt alone.
 */
function quorumInputsDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.quorum-inputs",
    nodes: [
      { id: "arb", agent: "agent.arb", prompt: "Split.", outcomes: [{ id: "split" }] },
      { id: "b1", agent: "agent.b1", prompt: "Branch 1.", outcomes: [{ id: "done" }] },
      { id: "b2", agent: "agent.b2", prompt: "Branch 2.", outcomes: [{ id: "done" }] },
      { id: "b3", agent: "agent.b3", prompt: "Branch 3.", outcomes: [{ id: "done" }] },
      {
        id: "q",
        agent: "agent.q",
        prompt: "Quorum.",
        outcomes: [{ id: "merged" }],
        join: { strategy: "quorum", quorum: 2 },
        inputs: [
          { from: "b1", outcome: "done" },
          { from: "b2", outcome: "done" },
        ],
      },
    ],
    edges: [
      { from: "arb", to: "b1", outcome: "split" },
      { from: "arb", to: "b2", outcome: "split" },
      { from: "arb", to: "b3", outcome: "split" },
      { from: "b1", to: "q", outcome: "done" },
      { from: "b2", to: "q", outcome: "done" },
      { from: "b3", to: "q", outcome: "done" },
    ],
  };
}

/**
 * R4d: TWO declared loop groups that BOTH take "revise" as their continuation
 * over the same nodes, with the consumer declaring an input. One traversal
 * re-enters both loops, so both counters move AND the consumer's binding follows
 * the round.
 */
function sharedGroupsDeclaration(maxTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.shared-groups-inputs",
    nodes: [
      { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "a-tight",
        nodes: ["work", "review"],
        max_traversals: maxTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
      {
        id: "b-loose",
        nodes: ["work", "review"],
        max_traversals: 10,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

/**
 * OVERLAPPING loop groups with successor inputs: the consumer belongs to BOTH
 * groups, and each group takes a DIFFERENT continuation — a-outer re-enters on
 * "redo" (which work emits) and b-inner on "revise" (which review emits).
 * a-outer sorts first, so a positional "first group containing the emitter" rule
 * would advance the wrong counter. The consumer pins work/done.
 */
function overlappingGroupsDeclaration(maxInnerTraversals: number): GraphDeclarationV3 {
  return {
    version: 3,
    name: "p43.overlapping-groups-inputs",
    nodes: [
      {
        id: "work",
        agent: "agent.work",
        prompt: "Do the work.",
        outcomes: [{ id: "done" }, { id: "redo" }],
      },
      {
        id: "review",
        agent: "agent.review",
        prompt: "Review the work.",
        outcomes: [{ id: "revise" }, { id: "approve" }],
        inputs: [{ from: "work", outcome: "done" }],
      },
    ],
    edges: [
      { from: "work", to: "review", outcome: "done" },
      { from: "work", to: "review", outcome: "redo" },
      { from: "review", to: "work", outcome: "revise" },
    ],
    loop_groups: [
      {
        id: "a-outer",
        nodes: ["work", "review"],
        max_traversals: 3,
        continuation_outcome: "redo",
        exit_outcome: "approve",
      },
      {
        id: "b-inner",
        nodes: ["work", "review"],
        max_traversals: maxInnerTraversals,
        continuation_outcome: "revise",
        exit_outcome: "approve",
      },
    ],
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  readonly runtime: OutcomeGraphRuntime;
  readonly plan: CompiledPlan;
  readonly ledger: SqliteAcceptanceLedger;
  /** Every request the scripted dispatch seam received, in order. */
  readonly requests: OutcomeDispatchRequest[];
  readonly graphId: string;
  readonly dir: string;
  /** The credential the given attempt was dispatched with. */
  credentialOf(attemptId: string): string;
}

async function withHarness<T>(
  declaration: GraphDeclarationV3,
  fn: (harness: Harness) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "outcome-join-inputs-"));
  let ledger: SqliteAcceptanceLedger | undefined;
  try {
    ledger = await SqliteAcceptanceLedger.create(dir);
    const declared = buildDeclaredOutcomeGraph({ declaration });
    const requests: OutcomeDispatchRequest[] = [];
    const runtime = new OutcomeGraphRuntime({
      plan: declared.plan,
      ledger,
      dispatch: (request) => {
        requests.push(request);
      },
      validators: EMPTY_VALIDATORS,
      artifactRoot: dir,
      credentialIsolation: testHostCredentialIsolation(dir),
      clock: () => NOW,
      mintCredential: CREDENTIAL_SOURCE,
    });
    return await fn({
      runtime,
      plan: declared.plan,
      ledger,
      requests,
      graphId: declared.graphId,
      dir,
      credentialOf: (attemptId) => {
        const found = requests.find((request) => request.attemptId === attemptId);
        if (found === undefined) {
          throw new Error(
            "fixture: no dispatch request for attempt " +
              attemptId +
              " (dispatched: " +
              requests.map((request) => request.attemptId).join(", ") +
              ")",
          );
        }
        return found.credential;
      },
    });
  } finally {
    ledger?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One accepted settlement, as the run path reports it. */
type AcceptedSubmission = Extract<OutcomeSubmissionResult, { readonly kind: "accepted" }>;

/**
 * Submit one attempt's outcome and fail the test when the run refuses it: a
 * fixture whose premise did not hold must not look like a passing assertion.
 */
function accept(
  harness: Harness,
  nodeId: string,
  outcomeId: string,
  attemptId: string,
  at: number,
  data?: unknown,
): AcceptedSubmission {
  const proposal: Record<string, unknown> = {
    nodeId,
    outcomeId,
    credential: harness.credentialOf(attemptId),
  };
  if (data !== undefined) proposal.data = data;
  const result = harness.runtime.submit(proposal, at);
  if (result.kind !== "accepted") {
    throw new Error(
      "fixture: " + nodeId + "/" + outcomeId + " (attempt " + attemptId + ") was " + result.kind,
    );
  }
  return result;
}

/** One node's entry in a state, failing the test when it is missing. */
function nodeOf(state: OutcomeGraphState, nodeId: string): OutcomeNodeState {
  const found = state.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) throw new Error("no state for node " + nodeId);
  return found;
}

/** Attempt ids in dispatch order, for compact assertions. */
function attemptIds(requests: readonly OutcomeDispatchRequest[]): string[] {
  return requests.map((request) => request.attemptId);
}

/** The (producer, attempt) pairs one entry was ARMED with, in declared order. */
function boundRefs(entry: OutcomeNodeState): string[] {
  return (entry.inputs ?? []).map((input) => input.from + "@" + input.attemptId);
}

/** The accepted data of one entry's bound inputs, in declared order. */
function boundPayloads(entry: OutcomeNodeState): unknown[] {
  return (entry.inputs ?? []).map((input) => input.payload);
}

/** The named refusal codes recorded on one entry. */
function refusalCodes(state: OutcomeGraphState, nodeId: string): string[] {
  return (nodeOf(state, nodeId).inputRefusals ?? []).map((refusal) => refusal.code);
}

/** The attempts whose accepted results the store holds, for the "nothing moved" check. */
function acceptedAttempts(harness: Harness): string[] {
  return harness.ledger.acceptedEvents(harness.graphId).map((event) => event.attemptId);
}

/** The dispatch the run handed the platform for one attempt, if it was armed. */
function deliveredTo(harness: Harness, attemptId: string): OutcomeDispatchRequest | undefined {
  return harness.requests.find((request) => request.attemptId === attemptId);
}

// ── G1: the arm set agrees with the dispatches it produces ──────────────────

describe("the arm set agrees with the dispatches it produces (G1)", () => {
  it("arms a convergence node whose co-candidate was left blocked by its own declared input", async () => {
    await withHarness(blockedCandidateDeclaration(), (harness) => {
      harness.runtime.start(NOW);

      // d opens the loop: p is armed, x's input names p, and p is re-entered by
      // THIS advance — so x is BLOCKED (not armed, not re-entered) rather than
      // started against the attempt the same advance supersedes.
      const boot = accept(harness, "d", "boot", "d#1", NOW + 1, { phase: "boot" });
      expect(attemptIds(boot.dispatched)).toEqual(["p#3"]);
      expect(nodeOf(boot.state, "x")).toMatchObject({ status: "pending" });
      expect(refusalCodes(boot.state, "x")).toEqual(["input-producer-unsettled"]);

      accept(harness, "s", "ready", "s#2", NOW + 2, { seed: "s1" });
      const produced = accept(harness, "p", "ready", "p#3", NOW + 3, { part: "p1" });
      expect(attemptIds(produced.dispatched)).toEqual(["x#4"]);
      accept(harness, "x", "again", "x#4", NOW + 4, { round: "x1" });

      // THE REPRODUCED DIVERGENCE. d/again re-enters p AND x; x's dispatch is
      // blocked by its input (p is re-entered beside it), so x stays SETTLED on
      // x#4 — and that settled attempt is a real arrival for c, whose join:all
      // needs d, x and s. The arm set must be re-derived with x's settled state
      // visible, or the run records c as converged without ever arming it.
      const reentered = accept(harness, "d", "again", "d#5", NOW + 5, { drive: "d2" });
      expect(attemptIds(reentered.dispatched)).toEqual(["c#6", "p#7"]);

      const c = nodeOf(reentered.state, "c");
      expect(c).toMatchObject({ status: "dispatched", attemptId: "c#6" });
      // The binding is the attempt of THIS advance: p is being re-entered, so
      // c's producers are the settled d#5, x#4 and s#2.
      expect(boundRefs(c)).toEqual(["d@d#5", "x@x#4", "s@s#2"]);
      expect(boundPayloads(c)).toEqual([
        { kind: "value", value: { drive: "d2" } },
        { kind: "value", value: { round: "x1" } },
        { kind: "value", value: { seed: "s1" } },
      ]);
      // The PERSISTED arrival record names the same three attempts, in the
      // state's own canonical (plan node) order, so a restart re-derives the
      // same join decision from the state alone.
      expect(c.arrivals).toEqual([
        { from: "d", outcome: "again", attemptId: "d#5" },
        { from: "s", outcome: "ready", attemptId: "s#2" },
        { from: "x", outcome: "again", attemptId: "x#4" },
      ]);
      // x was NOT re-entered: it keeps its attempt and the named refusal that
      // says why it did not start.
      expect(nodeOf(reentered.state, "x")).toMatchObject({
        status: "settled",
        attemptId: "x#4",
      });
      expect(refusalCodes(reentered.state, "x")).toEqual(["input-producer-unsettled"]);
      // The delivered dispatch intent carries the same view the state records.
      expect(deliveredTo(harness, "c#6")?.inputs).toEqual(c.inputs);
      // p was armed too, in plan order behind c.
      expect(nodeOf(reentered.state, "p")).toMatchObject({
        status: "dispatched",
        attemptId: "p#7",
      });

      expect(attemptIds(harness.requests)).toEqual([
        "d#1",
        "s#2",
        "p#3",
        "x#4",
        "d#5",
        "c#6",
        "p#7",
      ]);
      console.log(
        "[probe:blocked-candidate] dispatched=" +
          JSON.stringify(attemptIds(reentered.dispatched)) +
          " c=" +
          JSON.stringify({
            status: c.status,
            attemptId: c.attemptId,
            inputs: boundRefs(c),
            arrivals: c.arrivals.map((arrival) => arrival.from + "@" + arrival.attemptId),
          }),
      );
    });
  });
});

// ── R4a: a loop consumer follows the round ──────────────────────────────────

describe("a loop consumer is bound to the attempt that opened THIS round (R4)", () => {
  it("re-binds the consumer on every round and keeps the earlier accepted result", async () => {
    await withHarness(guidedLoopDeclaration(), (harness) => {
      harness.runtime.start(NOW);

      const opened = accept(harness, "work", "done", "work#1", NOW + 1, { report: "W1" });
      expect(attemptIds(opened.dispatched)).toEqual(["review#2"]);
      const first = nodeOf(opened.state, "review");
      expect(boundRefs(first)).toEqual(["work@work#1"]);
      expect(boundPayloads(first)).toEqual([{ kind: "value", value: { report: "W1" } }]);
      expect(deliveredTo(harness, "review#2")?.inputs).toEqual(first.inputs);

      const revised = accept(harness, "review", "revise", "review#2", NOW + 2, {
        revision: "r1",
      });
      expect(attemptIds(revised.dispatched)).toEqual(["work#3"]);

      // ROUND 2 — the same node, a NEW producing attempt. The consumer must be
      // bound to work#3, never to work#1 (whose accepted result still exists).
      const second = accept(harness, "work", "done", "work#3", NOW + 3, { report: "W2" });
      expect(attemptIds(second.dispatched)).toEqual(["review#4"]);
      const rebound = nodeOf(second.state, "review");
      expect(rebound.attemptId).toBe("review#4");
      expect(boundRefs(rebound)).toEqual(["work@work#3"]);
      expect(boundPayloads(rebound)).toEqual([{ kind: "value", value: { report: "W2" } }]);
      expect(deliveredTo(harness, "review#4")?.inputs).toEqual(rebound.inputs);

      // The round-1 result is still readable; only the BINDING moved on.
      expect(acceptedAttempts(harness)).toEqual(["work#1", "review#2", "work#3"]);
      console.log(
        "[probe:loop-binding] bound=" +
          JSON.stringify(
            harness.requests.map(
              (request) =>
                request.attemptId +
                "<-" +
                (request.inputs ?? [])
                  .map((input) => input.from + "@" + input.attemptId)
                  .join(","),
            ),
          ),
      );
    });
  });
});

// ── R4b: a join across rounds, with inputs on every node ────────────────────

describe("a join binds the attempts of ITS round (R4)", () => {
  it("waits for both branches each round, and a stale branch never arms the next round", async () => {
    await withHarness(loopJoinInputsDeclaration(3), (harness) => {
      harness.runtime.start(NOW);

      const opened = accept(harness, "s", "next", "s#1", NOW + 1, { round: "one" });
      expect(attemptIds(opened.dispatched)).toEqual(["a#2", "b#3"]);
      expect(boundRefs(nodeOf(opened.state, "a"))).toEqual(["s@s#1"]);
      expect(boundRefs(nodeOf(opened.state, "b"))).toEqual(["s@s#1"]);
      const a1 = accept(harness, "a", "done", "a#2", NOW + 2, { branch: "a1" });
      expect(attemptIds(a1.dispatched)).toEqual([]);
      const b1 = accept(harness, "b", "done", "b#3", NOW + 3, { branch: "b1" });
      expect(attemptIds(b1.dispatched)).toEqual(["j#4"]);
      const j4 = nodeOf(b1.state, "j");
      expect(boundRefs(j4)).toEqual(["a@a#2", "b@b#3"]);
      expect(boundPayloads(j4)).toEqual([
        { kind: "value", value: { branch: "a1" } },
        { kind: "value", value: { branch: "b1" } },
      ]);
      expect(deliveredTo(harness, "j#4")?.inputs).toEqual(j4.inputs);

      const again = accept(harness, "j", "again", "j#4", NOW + 4, {});
      expect(attemptIds(again.dispatched)).toEqual(["s#5"]);

      // ROUND 2 — both branches are re-run, and the join is NOT satisfied by
      // round 1's arrival: a#6 alone leaves it waiting.
      const s2 = accept(harness, "s", "next", "s#5", NOW + 5, { round: "two" });
      expect(attemptIds(s2.dispatched)).toEqual(["a#6", "b#7"]);
      const a2 = accept(harness, "a", "done", "a#6", NOW + 6, { branch: "a2" });
      expect(attemptIds(a2.dispatched)).toEqual([]);
      expect(nodeOf(a2.state, "j")).toMatchObject({ status: "settled", attemptId: "j#4" });
      expect(nodeOf(a2.state, "j").arrivals).toEqual([
        { from: "a", outcome: "done", attemptId: "a#6" },
      ]);

      const b2 = accept(harness, "b", "done", "b#7", NOW + 7, { branch: "b2" });
      expect(attemptIds(b2.dispatched)).toEqual(["j#8"]);
      const j8 = nodeOf(b2.state, "j");
      expect(boundRefs(j8)).toEqual(["a@a#6", "b@b#7"]);
      expect(boundPayloads(j8)).toEqual([
        { kind: "value", value: { branch: "a2" } },
        { kind: "value", value: { branch: "b2" } },
      ]);
      expect(deliveredTo(harness, "j#8")?.inputs).toEqual(j8.inputs);
      // The branch attempts are themselves bound to the round's splitter.
      expect(boundRefs(nodeOf(b2.state, "a"))).toEqual(["s@s#5"]);
      expect(boundRefs(nodeOf(b2.state, "b"))).toEqual(["s@s#5"]);
      expect(b2.state.loopTraversals["rounds"]).toBe(1);
      // Round 1's results are all still in the store.
      expect(acceptedAttempts(harness)).toEqual([
        "s#1",
        "a#2",
        "b#3",
        "j#4",
        "s#5",
        "a#6",
        "b#7",
      ]);
      console.log(
        "[probe:loop-join-inputs] bindings=" +
          JSON.stringify(
            harness.requests
              .filter((request) => (request.inputs ?? []).length > 0)
              .map(
                (request) =>
                  request.attemptId +
                  "<-" +
                  (request.inputs ?? [])
                    .map((input) => input.from + "@" + input.attemptId)
                    .join(","),
              ),
          ),
      );
    });
  });
});

// ── The unselected branch of a join:any ─────────────────────────────────────

describe("an unselected branch leaves the armed consumer alone (R4)", () => {
  it("arms a join:any on the feeder its input names, and a later arrival neither re-arms nor re-binds it", async () => {
    await withHarness(diamondAnyDeclaration(), (harness) => {
      harness.runtime.start(NOW);
      accept(harness, "arb", "split", "arb#1", NOW + 1, {});

      const first = accept(harness, "brc", "done", "brc#2", NOW + 2, { branch: "B" });
      expect(attemptIds(first.dispatched)).toEqual(["djoin#4"]);
      const armed = nodeOf(first.state, "djoin");
      expect(boundRefs(armed)).toEqual(["brc@brc#2"]);
      expect(boundPayloads(armed)).toEqual([{ kind: "value", value: { branch: "B" } }]);
      expect(deliveredTo(harness, "djoin#4")?.inputs).toEqual(armed.inputs);

      const late = accept(harness, "crb", "done", "crb#3", NOW + 3, { branch: "C" });
      expect(attemptIds(late.dispatched)).toEqual([]);
      const after = nodeOf(late.state, "djoin");
      // The consumer keeps ITS attempt and ITS binding ...
      expect(after.attemptId).toBe("djoin#4");
      expect(after.inputs).toEqual(armed.inputs);
      // ... while the arrival itself is recorded (round 1's arrival must not
      // satisfy a LATER round's join, which is the loop-join case above).
      expect(after.arrivals).toEqual([
        { from: "brc", outcome: "done", attemptId: "brc#2" },
        { from: "crb", outcome: "done", attemptId: "crb#3" },
      ]);
      expect(attemptIds(harness.requests)).toEqual(["arb#1", "brc#2", "crb#3", "djoin#4"]);
    });
  });
});

// ── Quorum + successor inputs ───────────────────────────────────────────────

describe("a quorum waits for its threshold and binds exactly its declared producers (R4)", () => {
  it("arms on the second arrival with both attempts, and ignores the third branch", async () => {
    await withHarness(quorumInputsDeclaration(), (harness) => {
      harness.runtime.start(NOW);
      const split = accept(harness, "arb", "split", "arb#1", NOW + 1, {});
      expect(attemptIds(split.dispatched)).toEqual(["b1#2", "b2#3", "b3#4"]);

      const one = accept(harness, "b1", "done", "b1#2", NOW + 2, { part: "one" });
      expect(attemptIds(one.dispatched)).toEqual([]);
      expect(nodeOf(one.state, "q")).toMatchObject({ status: "pending" });

      const two = accept(harness, "b2", "done", "b2#3", NOW + 3, { part: "two" });
      expect(attemptIds(two.dispatched)).toEqual(["q#5"]);
      const armed = nodeOf(two.state, "q");
      expect(boundRefs(armed)).toEqual(["b1@b1#2", "b2@b2#3"]);
      expect(boundPayloads(armed)).toEqual([
        { kind: "value", value: { part: "one" } },
        { kind: "value", value: { part: "two" } },
      ]);
      expect(deliveredTo(harness, "q#5")?.inputs).toEqual(armed.inputs);

      const three = accept(harness, "b3", "done", "b3#4", NOW + 4, { part: "three" });
      expect(attemptIds(three.dispatched)).toEqual([]);
      const after = nodeOf(three.state, "q");
      expect(after.attemptId).toBe("q#5");
      expect(after.inputs).toEqual(armed.inputs);
      expect(after.arrivals).toEqual([
        { from: "b1", outcome: "done", attemptId: "b1#2" },
        { from: "b2", outcome: "done", attemptId: "b2#3" },
        { from: "b3", outcome: "done", attemptId: "b3#4" },
      ]);
    });
  });
});

// ── R4d: shared loop groups ─────────────────────────────────────────────────

describe("shared loop groups carry the round's binding (R4)", () => {
  it("moves both counters on one continuation and re-binds the consumer each round", async () => {
    await withHarness(sharedGroupsDeclaration(20), (harness) => {
      harness.runtime.start(NOW);

      const opened = accept(harness, "work", "done", "work#1", NOW + 1, { report: "W1" });
      const first = nodeOf(opened.state, "review");
      expect(boundRefs(first)).toEqual(["work@work#1"]);
      expect(boundPayloads(first)).toEqual([{ kind: "value", value: { report: "W1" } }]);

      const revised = accept(harness, "review", "revise", "review#2", NOW + 2, {});
      // One traversal re-enters BOTH declared loops, so both counters move.
      expect(revised.state.loopTraversals).toEqual({ "a-tight": 1, "b-loose": 1 });
      expect(attemptIds(revised.dispatched)).toEqual(["work#3"]);

      const second = accept(harness, "work", "done", "work#3", NOW + 3, { report: "W2" });
      const rebound = nodeOf(second.state, "review");
      expect(rebound.attemptId).toBe("review#4");
      expect(boundRefs(rebound)).toEqual(["work@work#3"]);
      expect(boundPayloads(rebound)).toEqual([{ kind: "value", value: { report: "W2" } }]);
      expect(deliveredTo(harness, "review#4")?.inputs).toEqual(rebound.inputs);

      const revisedAgain = accept(harness, "review", "revise", "review#4", NOW + 4, {});
      expect(revisedAgain.state.loopTraversals).toEqual({ "a-tight": 2, "b-loose": 2 });
      expect(attemptIds(revisedAgain.dispatched)).toEqual(["work#5"]);
    });
  });
});

// ── Overlapping loop groups ─────────────────────────────────────────────────

describe("overlapping loop groups advance the group that declares the continuation (R4)", () => {
  it("binds every round to its own producer and blocks the round whose outcome the input does not pin", async () => {
    await withHarness(overlappingGroupsDeclaration(5), (harness) => {
      harness.runtime.start(NOW);

      // Only work is an entry: the back edge review -> work is b-inner's
      // continuation, so it does not make work a target.
      const opened = accept(harness, "work", "done", "work#1", NOW + 1, { report: "W1" });
      expect(attemptIds(opened.dispatched)).toEqual(["review#2"]);
      expect(boundRefs(nodeOf(opened.state, "review"))).toEqual(["work@work#1"]);

      const revised = accept(harness, "review", "revise", "review#2", NOW + 2, {});
      // "revise" is b-inner's continuation, and a-outer is declared FIRST.
      expect(revised.state.loopTraversals["b-inner"]).toBe(1);
      expect(revised.state.loopTraversals["a-outer"]).toBeUndefined();
      expect(attemptIds(revised.dispatched)).toEqual(["work#3"]);

      const second = accept(harness, "work", "done", "work#3", NOW + 3, { report: "W2" });
      const rebound = nodeOf(second.state, "review");
      expect(rebound.attemptId).toBe("review#4");
      expect(boundRefs(rebound)).toEqual(["work@work#3"]);
      expect(boundPayloads(rebound)).toEqual([{ kind: "value", value: { report: "W2" } }]);
      expect(deliveredTo(harness, "review#4")?.inputs).toEqual(rebound.inputs);
      expect(second.state.loopTraversals["a-outer"]).toBeUndefined();

      const revisedAgain = accept(harness, "review", "revise", "review#4", NOW + 4, {});
      expect(attemptIds(revisedAgain.dispatched)).toEqual(["work#5"]);
      expect(revisedAgain.state.loopTraversals["b-inner"]).toBe(2);

      // a-outer's own continuation, emitted by work: the round moves a-outer's
      // counter, and the consumer's declared input pins work/DONE while work#5
      // settled on REDO — so the consumer is BLOCKED BY NAME, never started
      // against an outcome its producer did not produce.
      const redone = accept(harness, "work", "redo", "work#5", NOW + 5, { report: "W3" });
      expect(redone.state.loopTraversals).toEqual({ "a-outer": 1, "b-inner": 2 });
      expect(attemptIds(redone.dispatched)).toEqual([]);
      expect(nodeOf(redone.state, "review")).toMatchObject({
        status: "settled",
        attemptId: "review#4",
      });
      expect(refusalCodes(redone.state, "review")).toEqual(["input-outcome-mismatch"]);
      // The binding review#4 was armed with is untouched by the blocked round.
      expect(boundRefs(nodeOf(redone.state, "review"))).toEqual(["work@work#3"]);
      expect(acceptedAttempts(harness)).toEqual([
        "work#1",
        "review#2",
        "work#3",
        "review#4",
        "work#5",
      ]);
    });
  });
});
