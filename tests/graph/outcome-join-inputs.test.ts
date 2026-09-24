/// <reference types="bun-types" />

/**
 * P4.3 (G1) — the arm set agrees with the dispatches it produces (R4).
 *
 * WHY THIS FILE EXISTS. A candidate whose join is satisfied can still be left
 * BLOCKED by its own declared input, and a blocked candidate keeps the settled
 * entry it had (the state says so: it is still settled, and its arrival is still
 * recorded). The arm set must therefore not go on suppressing that candidate as
 * if it were in flight: the case below reproduces the divergence the P4.3 gap
 * analysis confirmed (the state's own arrivals satisfied a convergence node's
 * join:all while the node was never armed) and pins the fix. The NEGATIVE
 * CONTROL lives beside it in the run-path suite: when the co-candidate really IS
 * re-entered, its stale arrival must NOT arm the join
 * (outcome-runtime.test.ts, "a loop join is decided per round").
 *
 * The case drives the REAL OutcomeGraphRuntime over a compiled plan that
 * declares successor INPUTS, so it also pins what the armed node was bound to:
 * the producing ATTEMPT of this advance, in the state entry AND in the delivered
 * OutcomeDispatchRequest, with the persisted arrivals naming the same attempts.
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
