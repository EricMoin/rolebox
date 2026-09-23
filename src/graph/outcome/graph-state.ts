/**
 * Graph Execution Engine v2 — Outcome-protocol graph state (C3b)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The STATE half of the outcome run path (docs/graph-outcome-protocol.md
 * § "State, storage, and effects"): a deterministic model of an
 * outcome-protocol graph's progress, the strict reader that turns a persisted
 * `GraphStateRecord` back into it, and the PURE reducer that advances it from
 * one ACCEPTED outcome.
 *
 * THE STATE IS A VALUE, NOT A LOG. It answers exactly three questions — which
 * nodes have been dispatched, what attempt each is on, and which terminal
 * outcome settled the run — and nothing else. Business payloads, evidence and
 * validator results are deliberately NOT stored here: the receipt and the
 * accepted event are the durable record of what was accepted, and the protocol
 * bounds diagnostic retention rather than keeping sensitive raw data.
 *
 * THE CYCLE RULE. Every cycle in a compiled plan lies inside a declared loop
 * group (the compiler proves it). Re-entering a node that already settled is
 * therefore legal exactly when the edge stays inside one declared loop group:
 * an edge whose endpoints share a group is a loop path, and an edge that leaves
 * the group is the loop's exit. A settled target outside the source's group is
 * refused rather than silently reset, and the declared `continuationOutcome` is
 * what advances the group's bounded traversal counter — a cap that would be
 * exceeded is never run: the round is not taken, the counter does not move, and
 * the run STOPS with that cap recorded as the reason.
 * A node may belong to SEVERAL declared loop groups, so the groups a
 * continuation advances are selected by DECLARATION — the groups that declare
 * this outcome as their continuation and contain the emitting node — never by
 * position: selecting the first group that merely contains the node can select a
 * group this outcome is not the continuation of, leaving the loop that was
 * actually re-entered unbounded. Every selected group advances together, and
 * the continuation is refused as a whole when ANY of their caps would be
 * exceeded — a hard cap a node could route around is not hard.
 *
 * A HARD CAP ENDS THE RUN IN A PERSISTED STOP — NEVER IN A STUCK RUN. The
 * outcome that asked for the over-cap round is still a real, ACCEPTED result:
 * its node settles, its receipt and accepted event are committed, and the
 * reducer writes a {@link OutcomeStop} into the SAME state body and the SAME
 * acceptance transaction, so a crash can never separate "the continuation was
 * refused" from "the stop was recorded". The stop names a reason from the
 * CLOSED, machine-decidable vocabulary {@link OUTCOME_STOP_REASONS} — never a
 * judgement about the work — together with the loop group, the round it had
 * reached and the cap it hit. Nothing else is settled and nothing is dispatched:
 * the stop fabricates no accepted event and substitutes no outcome for the one
 * the worker reported.
 *
 * THE STOP IS THE WHOLE GRAPH'S, AND THAT IS A DECISION, NOT AN OVERSIGHT. A
 * capped loop could in principle be stopped on its own while other branches keep
 * running, but this protocol does not do that: the graph is a run whose limits
 * are declared per loop, an accepted outcome routes as ONE transition (arming
 * only part of its successors is a state the model cannot describe), and a
 * graph that continued past a capped loop would report `complete` — the same
 * phase a run that finished properly reports — for a run that was cut short.
 * So a capped loop stops the RUN: `phase` becomes `stopped`, every other node
 * stays exactly where it was (an in-flight branch is NOT settled, because no
 * outcome settled it), and {@link advanceOutcomeGraph} refuses to advance a
 * stopped state at all, so a stopped run never quietly becomes an executing one
 * again.
 *
 * ATTEMPT IDENTITY. Attempt ids are minted HERE, from a graph-wide counter the
 * state carries, never supplied by a worker: `<nodeId>#<seq>`. A settled node
 * keeps the attempt that settled it, so a repeated submission derives the SAME
 * execution identity and replays the persisted decision instead of settling a
 * second time.
 *
 * EVERY ATTEMPT IS ISSUED A CREDENTIAL, AND IT LIVES IN THE STATE ENTRY. The
 * nonce comes from the injected {@link AttemptCredentialSource} (the runtime
 * injects the platform CSPRNG; a test injects a deterministic source) and is
 * written into the attempt's own persisted entry, so the binding tuple —
 * `graphId` and `planRevision` from the body, `nodeId`, `attemptId` and the
 * nonce from the entry — is reconstructed from the STATE, never from a
 * submission. A settled node KEEPS the credential of the attempt that settled
 * it (exactly as it keeps the attempt id), which is what lets a repeated
 * submission resolve to the SAME attempt and replay its receipt. Reducer
 * purity is therefore "pure given its inputs": the minting source is one
 * explicit input, so a given source reproduces a given advance.
 *
 * THE JOIN GATE. An accepted non-terminal outcome arms the successors its edge
 * routes to — but only those whose declared JOIN is satisfied. A node's feeders
 * are the distinct sources of its incoming edges (the plan's own topology), and
 * an arrival is a feeder that has SETTLED on its current attempt with an outcome
 * some declared edge routes from it to the target. The arrival set is
 * materialized on the target's entry and persisted with the very acceptance that
 * produced it, so a restart decides the join from the state instead of
 * re-deriving it. Until the join is satisfied NOTHING is armed: the acceptance
 * commits (the outcome is a real, accepted result) and the only write is the
 * arrival record itself — no attempt id, no dispatched status, no effect. When
 * it is satisfied the node is armed EXACTLY ONCE, on a fresh attempt; an
 * already-dispatched target is never re-armed, so two feeders completing out of
 * order cannot overwrite the attempt that is in flight.
 *
 * ROUNDS DO NOT MIX. A feeder that has been re-armed is no longer settled, so
 * its earlier answer stops counting the moment its new attempt starts: the join
 * of round N+1 cannot be satisfied by round N's arrival from a feeder that is
 * running again. An arm set is computed for the WHOLE advance at once — a node
 * this advance arms is treated as in flight and is therefore not evidence for
 * another node armed in the same advance — so a convergence node cannot be
 * armed on the previous round's answer of a feeder that is being re-armed right
 * beside it.
 *
 * READING IS STRICT, VERSIONED AND TOTAL. Every persisted body declares the
 * state-body version it was written in, and `readOutcomeGraphState` accepts
 * exactly the shape that version defines — the plan's node set in plan order,
 * the closed status vocabulary, attempt ids and counters where they are
 * required, no unknown loop group, and NO field the version does not define at
 * either the body or the node level — and refuses anything else with an
 * {@link OutcomeStateError}. A version this build has no reader for is refused
 * with `unsupported-state-version` rather than read partially: the fields this
 * build does not know would be silently dropped by the next state write, so
 * the version gate comes first and a state this build cannot read is NEVER
 * reset to a clean start — the same "unknown is not fresh" discipline the
 * storage and protocol gates apply.
 *
 * VERSION 2 ADDS THE ATTEMPT CREDENTIAL, AND VERSION 1 STAYS READABLE. A
 * version-1 body records no credential, so this module can still READ it (a
 * completed graph reports cleanly), but an ATTEMPT it records can never be
 * settled: the run path refuses a submission for a credential-less attempt and
 * recovery refuses to launch one, rather than granting an attempt a credential
 * it was never issued. There is deliberately no migrator: an attempt's
 * credential is issued once, at dispatch, and inventing one on read would
 * fabricate the very binding the credential exists to prove.
 *
 * VERSION 7 ADDS THE OPTIONAL HOST INVOCATION IDENTITY. A `dispatched` or
 * `settled` entry records the host identity its dispatch ran under when the
 * runtime held a readable host identity capability (`host-identity.ts`, D9).
 * The field is OPTIONAL because a host that declares no identity capability
 * records none — absence is the complete statement "no host identity was in
 * effect", and no later process back-fills one onto an attempt that predates
 * the field. Versions 5 and 6 stay ADVANCEABLE (they carry everything version 7
 * needs except that optional binding); versions 1 to 4 stay readable only.
 *
 * Dependency leaf on the outcome side: the compiler's plan TYPES, the ledger's
 * record TYPE and the acceptance core's decision type, all type-only, so the
 * reducer can be tested without a ledger and the runtime can own the wiring.
 */

import { JoinStrategy } from "../../constants.ts";
import type {
  CompiledEdge,
  CompiledNode,
  CompiledPlan,
  CompiledProgressPolicy,
} from "../compiler/plan.ts";
import { readQuorum, resolveJoinStrategy } from "../join-strategy.ts";
import type { GraphStateRecord } from "../ledger/types.ts";
import type { AcceptanceDecision } from "./acceptance.ts";
import {
  attemptCredentialBinding,
  attemptCredentialDigest,
  isAttemptCredentialDigest,
  mintAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";
import {
  PROGRESS_VALUE_MAX_LENGTH,
  compareProgress,
  type OutcomeLoopProgress,
  type ProgressProjection,
  type ProgressReport,
} from "./progress.ts";
import {
  readHostInvocationIdentity,
  type HostInvocationIdentity,
} from "./host-identity.ts";

// ── The state model ─────────────────────────────────────────────────────────

/**
 * One node's lifecycle in an outcome-protocol run.
 *
 * - `pending` — declared by the plan, never dispatched. A node on a branch the
 *   run never takes stays here, which is why `pending` does NOT block
 *   completion.
 * - `dispatched` — an attempt is in flight and its outcome may be submitted.
 * - `settled` — an accepted terminal outcome ended this node's participation.
 */
export type OutcomeNodeStatus = "pending" | "dispatched" | "settled";

/** One node's persisted progress. */
export interface OutcomeNodeState {
  /** The plan node this progress belongs to. */
  readonly nodeId: string;
  readonly status: OutcomeNodeStatus;
  /**
   * The attempt this node's current (or settling) execution belongs to.
   * Present exactly when the node has been dispatched at least once: a
   * `pending` node has no attempt, and a `settled` node keeps the attempt that
   * settled it so a repeated submission can be bound to the SAME execution
   * identity.
   */
  readonly attemptId?: string;
  /** The graph-wide sequence number that minted {@link attemptId}. */
  readonly attemptSeq?: number;
  /**
   * The DIGEST of the bearer credential the runtime issued to this attempt's
   * worker — what body version 8 records, and the only form of an attempt
   * credential this build writes down.
   *
   * WHY THE DIGEST, NOT THE CREDENTIAL. A credential is a bearer nonce: whatever
   * holds the value can be accepted for the attempt it was issued for, so a
   * durable record carrying the nonce is a second, unprotected copy of the
   * capability (the read-the-ledger-then-submit defect the credential-isolation
   * capability exists to close). The digest verifies possession without being
   * one: `submit` hashes what the worker presents and compares, and a reader of
   * the state learns nothing it can present.
   *
   * A settled node keeps the digest of the attempt that settled it, so a
   * repeated submission resolves back to that same attempt. An attempt the run
   * path cannot verify — a body version that records no credential at all, or
   * one whose legacy plaintext field this build never compares against a digest
   * — is refused rather than settled, and is never granted a fresh credential
   * (see `attempt-credential.ts`).
   */
  readonly attemptCredentialDigest?: string;
  /**
   * The PLAINTEXT credential a body version before 8 persisted on the attempt's
   * own entry, read ONLY so an older body is not silently trimmed.
   *
   * THIS BUILD NEVER USES IT. It is not compared against a submission (a digest
   * is what version 8 records, and a plaintext can never match one), it is never
   * re-delivered to a worker (re-delivery comes from the host's credential store
   * — `credential-isolation.ts`), and it is not carried into a body this build
   * writes (versions before 8 are readable and never advanced). It is exposed to
   * no report: the runtime's readings project the attempt and the node, never
   * this field.
   */
  readonly attemptCredential?: string;
  /**
   * The HOST INVOCATION IDENTITY this attempt was dispatched under (body
   * version 7 and later), present exactly when the runtime that dispatched it
   * held a readable host identity capability that named an invocation — see
   * `host-identity.ts` and the D9 section of the protocol.
   *
   * A submission that settles this attempt must come from the SAME host
   * attribution; the run path checks the host's current identity against this
   * record before it settles anything. Absence is a FACT, not a gap: an attempt
   * dispatched when the host supplied no identity has no binding, and neither a
   * reader nor a recovery ever fabricates one for it — the reference is what
   * the dispatch recorded, never what a later invocation happens to be.
   *
   * A settled node keeps the identity of the attempt that settled it, exactly
   * as it keeps that attempt's credential, so a repeated submission is checked
   * against the same attribution rather than a newer one.
   */
  readonly dispatchIdentity?: HostInvocationIdentity;
  /** The accepted outcome that settled this node; present only when settled. */
  readonly outcomeId?: string;
  /** Epoch milliseconds this attempt was dispatched at. */
  readonly dispatchedAt?: number;
  /** Epoch milliseconds the accepted outcome settled this node at. */
  readonly settledAt?: number;
  /**
   * The predecessors that have ARRIVED at this node's join, in plan node order
   * — the durable inbox the join is decided from (body version 3 and later).
   *
   * A version that does not define this field records nothing about arrivals,
   * which is why the reducer refuses to advance such a body instead of guessing
   * who had arrived (see {@link OutcomeAdvanceRefusedError}). The value is the
   * canonical materialization of the node entries: one arrival per feeder that
   * is SETTLED on its current attempt with an outcome a declared edge routes to
   * this node. A reader refuses a body whose list disagrees with its own node
   * entries, so the two representations cannot drift.
   */
  readonly arrivals?: readonly OutcomeArrival[];
}

/**
 * One predecessor arrival at a convergence node's join.
 *
 * The arrival is recorded on the TARGET's entry and names the feeder, the
 * outcome it settled with and the attempt that produced it. The attempt id is
 * what gives the arrival a ROUND: a feeder that has been re-armed is no longer
 * "the attempt that arrived", so its earlier answer stops counting and a new
 * round cannot be satisfied by the previous round's evidence.
 */
export interface OutcomeArrival {
  /** The predecessor node that arrived. */
  readonly from: string;
  /** The outcome it settled with — a declared edge routes it to this node. */
  readonly outcome: string;
  /** The attempt of {@link from} that produced the arrival. */
  readonly attemptId: string;
}

/**
 * The run phase of an outcome-protocol graph.
 *
 * `ready` — nothing dispatched and nothing settled. `executing` — at least one
 * attempt is in flight. `complete` — the run has started, nothing is in flight,
 * and every node that was ever dispatched has settled. A node the run never
 * reached stays `pending` and does not hold the graph open.
 *
 * `stopped` — the run ENDED without finishing: a declared hard limit refused a
 * continuation, so the graph will take no further step. It is deliberately NOT
 * `complete`: `complete` says the run has no work left, while `stopped` says
 * the run was cut short and why (see {@link OutcomeStop}). An in-flight branch
 * may still be recorded on a node entry — the stop settles nothing that no
 * outcome settled — and the run path refuses every submission such an attempt
 * makes.
 */
export type OutcomeGraphPhase =
  | "ready"
  | "executing"
  | "complete"
  | "stopped";

/**
 * Why an outcome-protocol run STOPPED. A CLOSED, MACHINE-DECIDABLE vocabulary.
 *
 * Every member names a condition the runtime decided from the plan and the
 * persisted state alone — `loop-exhausted` is "a declared loop group's hard
 * `max_traversals` cap refused the next continuation", and `progress-stalled`
 * is "the loop's declared progress policy observed its declared threshold of
 * consecutive unchanged revisions". No member is a judgement about the work
 * ("review passed", "failed") and no member is derived from a worker's prose: a
 * stop reasons about a DECLARED limit or a DECLARED stopping policy, never
 * about a result.
 *
 * The set is closed PER BUILD — {@link OUTCOME_STOP_REASONS} is the one source a
 * reader and a writer share, and a body carrying a reason this build does not
 * define is refused rather than read with an unknown reason. A further stopping
 * policy adds a member to the union, its shape and a case in the reader's switch
 * — it never widens a reason in place.
 */
export type OutcomeStopReason = "loop-exhausted" | "progress-stalled";

/** The stop reasons this build defines, in canonical order. */
export const OUTCOME_STOP_REASONS: readonly OutcomeStopReason[] = Object.freeze([
  "loop-exhausted",
  "progress-stalled",
]);

/**
 * The stop one declared loop group's hard cap produces.
 *
 * It records the DECISION, not a narrative: which group's cap bound, which
 * accepted outcome asked to continue past it, the round the group had reached
 * and the cap itself. `traversals` is the counter as it stands — the number of
 * continuations the group actually took — and it equals `maxTraversals`
 * precisely because the round that would have exceeded the cap was NOT taken and
 * the counter did not move. A reader refuses a stop whose numbers disagree with
 * the state it is stored in.
 */
export interface OutcomeLoopExhaustedStop {
  readonly reason: "loop-exhausted";
  /** The declared loop group whose hard cap binds this run. */
  readonly loopGroupId: string;
  /** The node whose accepted outcome could not continue. */
  readonly nodeId: string;
  /** The continuation outcome that asked for the refused round. */
  readonly outcomeId: string;
  /** The attempt of {@link nodeId} that was settled by that outcome. */
  readonly attemptId: string;
  /** Continuations this group has taken: equal to {@link maxTraversals}. */
  readonly traversals: number;
  /** The declared hard cap the refused continuation would have exceeded. */
  readonly maxTraversals: number;
  /** Epoch milliseconds the stop was committed at. */
  readonly stoppedAt: number;
}

/**
 * The stop a declared PROGRESS policy produces.
 *
 * It records the DECISION, not a narrative: which group's declared threshold was
 * reached, which accepted outcome carried the last unchanged comparison, how
 * many consecutive `unchanged` comparisons were observed, and the comparison
 * the run stood still on — the evaluator identity and version, the subject and
 * the baseline token itself (already persisted in the group's progress record,
 * never the worker's payload).
 *
 * `unchanged` equals `maxUnchanged` precisely because the comparison that
 * reached the threshold WAS made — the round it asked for is the one that is not
 * taken, exactly as a hard cap refuses the round that would have exceeded it. A
 * reader refuses a stop whose numbers disagree with the progress record it is
 * stored beside.
 */
export interface OutcomeProgressStalledStop {
  readonly reason: "progress-stalled";
  /** The declared loop group whose progress policy bound this run. */
  readonly loopGroupId: string;
  /** The node whose accepted outcome carried the last unchanged comparison. */
  readonly nodeId: string;
  /** The continuation outcome that asked for the refused round. */
  readonly outcomeId: string;
  /** The attempt of {@link nodeId} that was settled by that outcome. */
  readonly attemptId: string;
  /** Consecutive `unchanged` comparisons: equal to {@link maxUnchanged}. */
  readonly unchanged: number;
  /** The declared stagnation threshold the refused round would have exceeded. */
  readonly maxUnchanged: number;
  /** The evaluator identity the baseline was recorded under. */
  readonly evaluator: string;
  /** The exact evaluator version the baseline was recorded under. */
  readonly evaluatorVersion: number;
  /** The comparison object the baseline token was read from. */
  readonly subject: string;
  /** The baseline token the run stood still on. */
  readonly baseline: string;
  /** Epoch milliseconds the stop was committed at. */
  readonly stoppedAt: number;
}

/**
 * The persisted record of a stopped run: a closed union discriminated by
 * {@link OutcomeStopReason}. This build defines two members — a declared hard
 * cap and a declared progress threshold — and each has its own shape and reader
 * case.
 */
export type OutcomeStop = OutcomeLoopExhaustedStop | OutcomeProgressStalledStop;

/**
 * The persisted state of one outcome-protocol graph.
 *
 * `nodes` is in PLAN order, always one entry per compiled node, so a reader can
 * compare state against plan position by position instead of trusting a keyed
 * map to be complete.
 */
export interface OutcomeGraphState {
  /**
   * The state-body format this snapshot is written in. A reader dispatches on
   * this value: a version with no registered reader is refused, never read
   * partially and rewritten (see {@link classifyOutcomeStateBody}).
   */
  readonly bodyVersion: number;
  readonly graphId: string;
  /** The plan revision this snapshot is bound to. */
  readonly planRevision: string;
  readonly phase: OutcomeGraphPhase;
  /** Per-node progress, in plan node order. */
  readonly nodes: readonly OutcomeNodeState[];
  /** Loop-group traversal counters, keyed by declared loop group id. */
  readonly loopTraversals: Readonly<Record<string, number>>;
  /** The graph-wide attempt counter the last mint advanced. */
  readonly attemptSeq: number;
  /**
   * The durable stop this run ended on, present EXACTLY when
   * {@link phase} is `stopped` (body version 4 and later).
   *
   * A version that does not define this field cannot record a stop at all, which
   * is why such a body can never report one and a body of a version that does
   * define it must agree with its own phase: a reader refuses a `stopped` body
   * with no stop and a running body that carries one, instead of trusting one of
   * two representations over the other.
   */
  readonly stop?: OutcomeStop;
  /**
   * Each loop group's persisted PROGRESS, keyed by declared loop group id, with
   * exactly one entry per group whose plan declares a progress policy (body
   * version 5 and later).
   *
   * PROGRESS IS LAYOUT, NOT AN EXTRA. Version 4 records nothing about the
   * baselines a loop compared, so this build cannot continue a declared
   * stopping policy from one — advancing it would silently restart the counters
   * and re-baseline the comparison, which is exactly the accidental reset the
   * protocol forbids. The list is therefore verified against the plan (which
   * declares the policies) and against the stop, and a version that does not
   * define the field refuses one rather than dropping it.
   */
  readonly loopProgress?: Readonly<Record<string, OutcomeLoopProgress>>;
}

// ── The state-body format ───────────────────────────────────────────────────

/**
 * The first versioned state-body layout — what this module's writer produces
 * today and what a persisted body declares as `bodyVersion: 1`.
 */
export const OUTCOME_STATE_BODY_V1 = 1 as const;

/**
 * The second versioned state-body layout: every `dispatched` and `settled`
 * node entry carries the runtime-issued `attemptCredential` the attempt's
 * worker must present when it submits an outcome.
 *
 * This was the layout this build wrote before version 3 added join arrivals.
 * Version 1 stays readable (a reader is installed for it) but its attempts carry
 * no credential and therefore cannot be settled by this build; no migrator
 * exists, because a credential is issued at dispatch and a value invented on
 * read would not be the one the worker holds.
 */
export const OUTCOME_STATE_BODY_V2 = 2 as const;

/**
 * The third versioned state-body layout: every node entry carries the
 * `arrivals` list its join is decided from — the predecessors that have settled
 * on their current attempt with an outcome a declared edge routes to this node.
 *
 * JOIN INFORMATION IS LAYOUT, NOT AN EXTRA. Version 2 records no arrivals, so
 * this build cannot tell which feeders had arrived when it reads one; the
 * reducer therefore refuses to advance a version-2 body rather than arm a
 * successor on an unknown join state (exactly as it refuses version 1, whose
 * attempts carry no credential). Version 1 and version 2 stay READABLE — a
 * completed graph reports cleanly and recovery reports what it can and cannot
 * arm — but neither is advanced, and there is no migrator: a credential is
 * issued once at dispatch, and an arrival is a fact about an attempt that
 * already settled, so inventing either on read would fabricate a binding the
 * run never made.
 */
export const OUTCOME_STATE_BODY_V3 = 3 as const;

/**
 * The fourth versioned state-body layout: the body carries a `stop` record
 * exactly when the run ENDED on a declared hard limit, and `phase` gains
 * `stopped` (see {@link OutcomeStop}).
 *
 * WHY A STOP IS LAYOUT AND NOT AN EXTRA. Until this version a capped loop left
 * the graph `executing` forever: the refusal rolled back with the whole
 * acceptance, so nothing durable said the run could not continue, and no reader
 * could tell a run that was cut short from one that was still working. Version 3
 * cannot describe that state at all — it has no field for a reason and no phase
 * for it — so this is a new layout rather than a new meaning for an old one.
 * Versions 1 to 3 stay READABLE (their completed graphs report cleanly and their
 * in-flight attempts are still recoverable), are never advanced, and are not
 * migrated: a stop is a fact about a decision the run actually took, and
 * inventing one on read would fabricate the ending.
 *
 * This is the layout this build writes.
 */
export const OUTCOME_STATE_BODY_V4 = 4 as const;

/**
 * The fifth versioned state-body layout: the body carries one PROGRESS record
 * per loop group whose plan declares a progress policy — the comparison
 * baseline (a bounded revision token), the evaluator identity and version it was
 * recorded under, and the consecutive-unchanged counter — and `phase` gains the
 * `progress-stalled` stop (see {@link OutcomeProgressStalledStop}).
 *
 * WHY PROGRESS IS LAYOUT AND NOT AN EXTRA. Version 4 has no field for a
 * baseline, so this build cannot tell "the loop has not been compared yet" from
 * "the comparison was dropped": advancing such a body would restart the counters
 * and re-baseline the comparison, an accidental reset of the decision semantics
 * that recovery must not perform. Versions 1 to 4 stay READABLE (their completed
 * graphs report cleanly and their in-flight attempts are still recoverable), are
 * never advanced, and are not migrated: a baseline is a fact about comparisons
 * the run actually made, and inventing one on read would decide stagnation from
 * data the run never observed.
 *
 * ITS COUNTER IS NOT TRUSTWORTHY, AND THAT IS WHY VERSION 6 EXISTS. This version's
 * writer did NOT clear the consecutive-unchanged counter when a comparison could
 * not be made, so a persisted version-5 count may span a round nobody judged. The
 * SHAPE of the record is identical in version 6; what changed is the MEANING of
 * the counter (see {@link OUTCOME_STATE_BODY_V6}), and a version is the only place
 * a body attests that meaning.
 */
export const OUTCOME_STATE_BODY_V5 = 5 as const;

/**
 * The sixth versioned state-body layout: the SAME shape as version 5, written and
 * read for the CORRECTED meaning of the per-group unchanged counter — it counts
 * consecutive COMPARABLE unchanged comparisons only, and an unknown comparison
 * clears it to zero while keeping the baseline.
 *
 * WHY A NEW VERSION FOR AN UNCHANGED SHAPE. Until this version the counter
 * survived an unknown, so a persisted count could stand for a run of unchanged
 * rounds that an unjudged round interrupted. That number cannot be told apart
 * from one this build would produce, and continuing it would let a declared
 * stopping policy fire on repetitions nobody observed back to back. The counter
 * is not layout, but its MEANING is part of what the body records. A version-5
 * counter is therefore never trusted: a version-5 body stays READABLE (its
 * completed graphs report cleanly, and its stop is verified against its own
 * record), and is advanced only by RECOMPUTING every counter from zero — the
 * baseline, the evaluator identity and its version are kept exactly as they were
 * — in the same transaction that rewrites the body in version 6. The
 * recomputation is conservative in one direction only (it can delay a stop, never
 * fabricate one) and happens ONCE per body, because a version-6 counter is
 * produced by the comparison alone.
 *
 * This was the layout this build wrote before version 7 added the recorded host
 * invocation identity; it stays readable and is still advanced.
 */
export const OUTCOME_STATE_BODY_V6 = 6 as const;

/**
 * The seventh versioned state-body layout: a `dispatched` or `settled` node
 * entry MAY carry the `dispatchIdentity` the runtime recorded when it
 * dispatched that attempt — the host invocation identity a submission for that
 * attempt must come from (see `host-identity.ts`).
 *
 * WHY A DISPATCH IDENTITY IS LAYOUT AND NOT AN EXTRA. The identity is the
 * reference half of the binding: it is recorded by the process that dispatched
 * the attempt and checked by the process that settles it, which may be a
 * DIFFERENT process after a restart. A body version that has no field for it
 * cannot carry the reference across that restart, so a later process could
 * neither enforce the host's constraint nor tell "this attempt was dispatched
 * without a host identity" from "the field was dropped on the way" — and a
 * field silently dropped from a state that is written back is exactly the
 * defect the version gate exists to prevent.
 *
 * THE FIELD IS OPTIONAL WITHIN THE VERSION, unlike the credential: a host that
 * declares no identity capability records none, and an attempt dispatched by
 * such a host keeps no binding. Absence says "no host identity was in effect",
 * which is a complete and honest statement; it never means "unchecked".
 *
 * Versions 1 to 6 stay READABLE and versions 5 and 6 stay ADVANCEABLE: version
 * 6 carries every field version 7 requires except this optional one, so
 * advancing it invents nothing — the already-recorded attempts keep no identity
 * (which is what they were dispatched with) and only attempts armed from now on
 * record one. A body is never migrated in place, and no identity is ever
 * back-filled onto an attempt that predates the field.
 *
 * This was the layout this build wrote before version 8 stopped persisting the
 * credential itself. It stays READABLE — a completed graph reports cleanly and
 * an in-flight attempt is still reported by name — but it is NOT advanceable:
 * every entry of this version carries the credential as a plaintext nonce, and
 * this build writes only the digest, so carrying one into a version-8 body
 * would either store the nonce again (the defect version 8 exists to close) or
 * drop it (the silent loss the version gate exists to prevent).
 */
export const OUTCOME_STATE_BODY_V7 = 7 as const;

/**
 * The eighth versioned state-body layout: a dispatched or settled entry carries
 * `attemptCredentialDigest` — the digest of the attempt's bearer credential —
 * INSTEAD OF the credential itself.
 *
 * WHY THE PERSISTED FORM IS LAYOUT AND NOT AN EXTRA. A reader that received a
 * body whose entry still carried the plaintext (version 7 and earlier) could not
 * tell it from a digest by the field's name alone, and the run path would have
 * to guess whether a presented value must be compared directly or hashed first
 * — exactly the ambiguity that makes a stolen nonce usable. A version is the
 * only place a body attests what its credential field IS, so this is a new
 * layout rather than a reinterpretation of the old one. `isAttemptCredentialDigest`
 * is the shape rule the reader enforces, so a version-8 entry that carries
 * anything else is refused by name.
 *
 * THE CREDENTIAL ITSELF LIVES IN THE HOST'S STORE. Nothing recoverable is
 * written here: verification hashes what a submitter presents, and re-delivery
 * of a recovered attempt resolves the credential from the host capability that
 * holds it (`credential-isolation.ts`). A host that cannot produce it is
 * reported as an unsettled effect, never handed a fabricated credential.
 *
 * Versions 1 to 7 stay READABLE and are never advanced or migrated: version 7
 * carries the plaintext this build does not re-persist, versions 5 and 6 carry
 * it too, and the older ones cannot carry the credentials, arrivals, stop or
 * progress baselines this build writes.
 *
 * This is the layout this build writes.
 */
export const OUTCOME_STATE_BODY_V8 = 8 as const;

/**
 * The state-body format this build writes.
 *
 * The body version is its OWN axis, separate from the storage format
 * (`ENGINE_PERSISTENCE_VERSION`), the execution-protocol identity and the
 * contract revision: it identifies the LAYOUT of the state body, so adding a
 * field is declaring a new body version that a reader owns — never extending a
 * version in place.
 */
export const CURRENT_OUTCOME_STATE_BODY = OUTCOME_STATE_BODY_V8;

/**
 * What reading one state body with a registered reader produced.
 *
 * `ok` carries the hydrated state; `invalid` carries the
 * {@link OutcomeStateError} the reader's own shape check raised. TOTAL by
 * contract, like a `StorageFormatDecoder.decode`: the reader answers a DATA
 * verdict for every body and never throws, so a body it rejects is reported
 * instead of escaping as an exception the caller did not model. Only a
 * non-OutcomeStateError (a programming error) still propagates.
 */
export type OutcomeStateBodyReading =
  | { readonly kind: "ok"; readonly state: OutcomeGraphState }
  | { readonly kind: "invalid"; readonly error: OutcomeStateError };

/**
 * A registered reader for exactly ONE state-body format.
 *
 * `format` is the exact body version this reader owns and `read` hydrates
 * only that layout. A version is never support by itself: the registry stores
 * capabilities, not memberships.
 */
export interface OutcomeStateBodyReader {
  /** The exact state-body version this reader hydrates. */
  readonly format: number;
  /** Read one body of exactly this format — never throws. */
  read(body: Record<string, unknown>, plan: CompiledPlan): OutcomeStateBodyReading;
}

/**
 * Installable state-body support: the exact reading CAPABILITIES this build has.
 *
 * Capability — never a numeric comparison or a bare membership check — decides
 * support, so a build that reads `1` cannot accidentally accept `2` (or any
 * other number) under a "less than current" rule. No migration capability is
 * installed for state bodies: a version this build does not read is
 * `unsupported` and recovery is blocked, never converted. The
 * decodable/migratable exclusivity `storage-format.ts` enforces therefore has
 * no second capability kind to collide with here; a future state-body migrator
 * must be registered as its own capability, and a version must stay exactly one
 * of the two.
 */
export interface OutcomeStateBodyRegistry {
  /** The body version this build writes. */
  readonly current: number;
  /** The installed readers, one per exact body version. */
  readonly formats: readonly OutcomeStateBodyReader[];
}

/** Input accepted by {@link createOutcomeStateBodyRegistry}. */
export interface OutcomeStateBodyRegistryInput {
  /** The body version this build writes. */
  readonly current: number;
  /** The readers to install; at most one per body version. */
  readonly formats: readonly OutcomeStateBodyReader[];
}

/**
 * Build a deeply frozen state-body registry from explicit reading capabilities.
 *
 * Consistency is checked HERE rather than left to the reader, because each
 * violation is a programmer error with exactly one sensible owner:
 * - a version that is not a positive safe integer — a capability names an exact
 *   LEGAL version, and an illegal discriminator is never a capability;
 * - a duplicate reader format — one exact version has exactly one read owner,
 *   otherwise which body shape is accepted would depend on array order;
 * - a `current` version with no registered reader — a build cannot write a body
 *   it could not read back, so the format it writes must be one of its own
 *   capabilities.
 *
 * Deeply frozen: the outer object, both arrays (fresh copies, so the caller's
 * arrays cannot be mutated afterwards) and every capability object. An in-place
 * edit of a frozen registry throws in strict mode, so the accepted set a reader
 * sees cannot silently move after construction.
 *
 * Throws a descriptive `Error` on the first violation.
 */
export function createOutcomeStateBodyRegistry(
  input: OutcomeStateBodyRegistryInput,
): OutcomeStateBodyRegistry {
  const installed = new Set<number>();
  for (const format of input.formats) {
    if (!Number.isSafeInteger(format.format) || format.format <= 0) {
      throw new Error(
        "state-body-format: " + describeValue(format.format) +
          " is not a legal state-body version — a version identifier is a positive safe integer",
      );
    }
    if (installed.has(format.format)) {
      throw new Error(
        "state-body-format: duplicate reader for body version " + format.format +
          " — one exact version has exactly one read owner",
      );
    }
    installed.add(format.format);
  }
  if (!installed.has(input.current)) {
    throw new Error(
      "state-body-format: the current body version " + describeValue(input.current) +
        " has no registered reader — a build cannot write a body it cannot read back",
    );
  }
  for (const format of input.formats) Object.freeze(format);
  return Object.freeze({
    current: input.current,
    formats: Object.freeze([...input.formats]),
  });
}

/**
 * Verdict for one raw `bodyVersion` value.
 *
 * - `supported` — an exact registered reader hydrates this body version. The
 *   verdict CARRIES the reader, so the caller dispatches on a capability
 *   instead of re-deriving support from a number.
 * - `unsupported` — a LEGAL version identifier with no installed reader.
 *   `version` carries the number for diagnostics and the caller REFUSES: this
 *   build must not read the body partially and write the state back, because
 *   every field it does not know would be silently dropped.
 * - `invalid` — not a version identifier at all: missing, `null`, a string, a
 *   non-integer or non-positive number, `NaN` / `Infinity`, or an integer
 *   outside the safe range. `value` carries the RAW value because it may hold
 *   any type; the caller reports it as a malformed body, never as an
 *   unknown-but-well-formed version.
 */
export type OutcomeStateBodyVerdict =
  | {
      readonly kind: "supported";
      readonly version: number;
      readonly reader: OutcomeStateBodyReader;
    }
  | { readonly kind: "unsupported"; readonly version: number }
  | { readonly kind: "invalid"; readonly value: unknown };

/**
 * Classify one persisted body version against a registry of exact reading
 * capabilities.
 *
 * Rules (the first matching rule wins) — the same shape `classifyStorageFormat`
 * applies to the storage axis:
 * 1. a value that is not a positive safe integer — missing, `null`, a string,
 *    a non-integer, zero, negative, `NaN` / `Infinity`, or an integer outside
 *    the safe range — → `invalid`, carrying the raw value: an illegal
 *    discriminator names no body version at all, so the body is malformed
 *    rather than "a newer version";
 * 2. the version of a registered reader → `supported`, carrying that reader;
 * 3. anything else → `unsupported`: a legal version identifier this build has
 *    no reader for.
 *
 * PURE by contract: no I/O, no logging, never throws.
 */
export function classifyOutcomeStateBody(
  version: unknown,
  registry: OutcomeStateBodyRegistry,
): OutcomeStateBodyVerdict {
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0
  ) {
    return { kind: "invalid", value: version };
  }
  const reader = registry.formats.find((format) => format.format === version);
  if (reader !== undefined) {
    return { kind: "supported", version, reader };
  }
  return { kind: "unsupported", version };
}

// ── Reading a persisted record ──────────────────────────────────────────────

/** Why a persisted graph-state body was refused. Stable identifiers. */
export type OutcomeStateProblem =
  /** The record names a different graph or plan revision than the plan in hand. */
  | "state-plan-mismatch"
  /** The body declares a state-body version this build has no reader for. */
  | "unsupported-state-version"
  /**
   * The body is not the shape its declared state-body version defines —
   * including a field that version does not define, at the body or node level.
   */
  | "malformed-state";

/**
 * A persisted graph state that cannot be read as THIS build's state.
 *
 * Thrown instead of defaulting: a snapshot this build does not understand is
 * refused, never reset to a clean start and never overwritten blindly — the
 * state a later run would otherwise silently discard may be another build's
 * complete record.
 */
export class OutcomeStateError extends Error {
  readonly problem: OutcomeStateProblem;

  constructor(problem: OutcomeStateProblem, message: string) {
    super(message);
    this.name = "OutcomeStateError";
    this.problem = problem;
  }
}

/** Refuse a state body that is not the shape this module writes. */
function malformedState(detail: string): OutcomeStateError {
  return new OutcomeStateError(
    "malformed-state",
    "outcome-state: the persisted graph state is not the state this build writes: " +
      detail,
  );
}

/** Read one optional timestamp field, or refuse it. */
function readOptionalEpoch(
  raw: Record<string, unknown>,
  field: string,
  where: string,
): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not epoch milliseconds",
    );
  }
  return value;
}

/**
 * Read one optional `dispatchIdentity` field against the declared layout (v7).
 *
 * `defined` — the field may be ABSENT (an attempt dispatched by a host that
 * declared no identity records none), but a value that is present must be a
 * readable `{ sessionId, agentId }` identity: an unreadable binding is refused
 * rather than read partially, because the state it is written back from would
 * otherwise drop the reference a submission is checked against. `forbidden` —
 * a version that does not define the field refuses an entry that carries one.
 */
function readDispatchIdentity(
  raw: Record<string, unknown>,
  where: string,
  layout: OutcomeStateLayout,
): HostInvocationIdentity | undefined {
  const value = raw.dispatchIdentity;
  if (layout.dispatchIdentity === "defined") {
    if (value === undefined) return undefined;
    const identity = readHostInvocationIdentity(value);
    if (identity === undefined) {
      throw malformedState(
        where + ".dispatchIdentity is " + describeValue(value) +
          ", not a { sessionId, agentId } host invocation identity — the binding a " +
          "submission for this attempt is checked against is refused rather than read " +
          "partially",
      );
    }
    return identity;
  }
  if (value !== undefined) {
    throw malformedState(
      where + " carries a dispatchIdentity, which body version " + layout.version +
        " does not define — the host binding is refused rather than dropped",
    );
  }
  return undefined;
}

/**
 * One state-body layout: the NODE fields the version defines per status, the
 * BODY fields it defines, the phases its writer can produce, and whether it
 * requires the attempt credential the run path checks a submission against.
 */
interface OutcomeStateLayout {
  /** The exact body version this layout belongs to, for diagnostics. */
  readonly version: number;
  /** The fields the version defines, exactly, per status. */
  readonly keys: Readonly<Record<OutcomeNodeStatus, readonly string[]>>;
  /** The BODY-level fields the version defines, exactly. */
  readonly bodyKeys: readonly string[];
  /** The phases this version's writer can produce, in canonical order. */
  readonly phases: readonly OutcomeGraphPhase[];
  /**
   * `plaintext` — every dispatched/settled entry must carry the bearer
   * `attemptCredential` itself (versions 2 to 7); `digest` — every such entry
   * must carry `attemptCredentialDigest` instead (version 8); `forbidden` —
   * the version defines neither field (version 1).
   */
  readonly credential: "plaintext" | "digest" | "forbidden";
  /**
   * `required` — every entry must carry the `arrivals` list (version 3);
   * `forbidden` — the version does not define the field, so an entry that
   * carries one is refused rather than read with a field this version never
   * wrote.
   */
  readonly arrivals: "required" | "forbidden";
  /**
   * `defined` — the version defines the body-level `stop` field (version 4
   * and later), which its writer writes EXACTLY when the run stopped;
   * `forbidden` — the version does not define it, so a body that carries one
   * is refused rather than read with a field this version never wrote.
   */
  readonly stop: "defined" | "forbidden";
  /**
   * `required` — the version defines the body-level `loopProgress` record
   * (version 5 and later), which its writer writes EXACTLY one entry per loop
   * group whose plan declares a progress policy; `forbidden` — the version does
   * not define it, so a body that carries one is refused rather than read with a
   * field this version never wrote.
   */
  readonly loopProgress: "required" | "forbidden";
  /**
   * `defined` — the version defines the per-entry `dispatchIdentity` record
   * (version 7 and later), which its writer writes EXACTLY when the runtime
   * that dispatched the attempt held a host identity for that invocation; it is
   * OPTIONAL within the version, because a host that declares no identity
   * capability records none. `forbidden` — the version does not define the
   * field, so an entry that carries one is refused rather than read with a
   * field this version never wrote.
   */
  readonly dispatchIdentity: "defined" | "forbidden";
}

/**
 * The BODY-level fields versions 1 to 3 define, exactly. Versions 1 and 2 add a
 * NODE-level field only (the credential, then the arrival list), so the three
 * layouts share this list; version 4 adds the body-level `stop`.
 */
const OUTCOME_STATE_BODY_KEYS_THROUGH_V3: readonly string[] = Object.freeze([
  "bodyVersion",
  "graphId",
  "planRevision",
  "phase",
  "nodes",
  "loopTraversals",
  "attemptSeq",
]);

/** The phases versions 1 to 3 can produce: no version before 4 can stop. */
const OUTCOME_STATE_PHASES_THROUGH_V3: readonly OutcomeGraphPhase[] =
  Object.freeze(["ready", "executing", "complete"]);

/** The phases version 4 can produce: the three above, plus the stop. */
const OUTCOME_STATE_PHASES_V4: readonly OutcomeGraphPhase[] = Object.freeze([
  "ready",
  "executing",
  "complete",
  "stopped",
]);

/** The node fields body version 1 defines, exactly, per status. */
const OUTCOME_STATE_LAYOUT_V1: OutcomeStateLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V1,
  bodyKeys: OUTCOME_STATE_BODY_KEYS_THROUGH_V3,
  phases: OUTCOME_STATE_PHASES_THROUGH_V3,
  credential: "forbidden" as const,
  dispatchIdentity: "forbidden" as const,
  arrivals: "forbidden" as const,
  stop: "forbidden" as const,
  loopProgress: "forbidden" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "dispatchedAt",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
    ]),
  }),
});

/**
 * The node fields body version 2 defines: version 1's fields plus the
 * runtime-issued `attemptCredential`, which a dispatched or settled entry
 * MUST carry and a pending entry must not.
 */
const OUTCOME_STATE_LAYOUT_V2: OutcomeStateLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V2,
  bodyKeys: OUTCOME_STATE_BODY_KEYS_THROUGH_V3,
  phases: OUTCOME_STATE_PHASES_THROUGH_V3,
  credential: "plaintext" as const,
  dispatchIdentity: "forbidden" as const,
  arrivals: "forbidden" as const,
  stop: "forbidden" as const,
  loopProgress: "forbidden" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "dispatchedAt",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
    ]),
  }),
});

/**
 * The node fields body version 3 defines: version 2's fields plus the
 * `arrivals` list its join is decided from. Every status carries the list —
 * a never-dispatched node can already have arrivals waiting for its join, and a
 * dispatched or settled one keeps the arrivals that armed it, because they are
 * the record of what the join saw.
 */
const OUTCOME_STATE_LAYOUT_V3: OutcomeStateLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V3,
  bodyKeys: OUTCOME_STATE_BODY_KEYS_THROUGH_V3,
  phases: OUTCOME_STATE_PHASES_THROUGH_V3,
  credential: "plaintext" as const,
  dispatchIdentity: "forbidden" as const,
  arrivals: "required" as const,
  stop: "forbidden" as const,
  loopProgress: "forbidden" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status", "arrivals"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "dispatchedAt",
      "arrivals",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
      "arrivals",
    ]),
  }),
});

/**
 * The node fields body version 4 defines: version 3's fields, unchanged. The
 * new axis is at the BODY level — the `stop` record a capped run ends on — so
 * an entry of this version is exactly an entry of version 3.
 */
const OUTCOME_STATE_LAYOUT_V4: OutcomeStateLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V4,
  bodyKeys: Object.freeze([
    ...OUTCOME_STATE_BODY_KEYS_THROUGH_V3,
    "stop",
  ]),
  phases: OUTCOME_STATE_PHASES_V4,
  credential: "plaintext" as const,
  dispatchIdentity: "forbidden" as const,
  arrivals: "required" as const,
  stop: "defined" as const,
  loopProgress: "forbidden" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status", "arrivals"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "dispatchedAt",
      "arrivals",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
      "arrivals",
    ]),
  }),
});

/**
 * The node fields body version 5 defines: version 4's fields, unchanged. The new
 * axis is again at the BODY level — the per-group `loopProgress` record a
 * declared progress policy is compared against — so an entry of this version is
 * exactly an entry of version 4.
 */
const OUTCOME_STATE_LAYOUT_V5: OutcomeStateLayout = Object.freeze({
  version: OUTCOME_STATE_BODY_V5,
  bodyKeys: Object.freeze([
    ...OUTCOME_STATE_BODY_KEYS_THROUGH_V3,
    "stop",
    "loopProgress",
  ]),
  phases: OUTCOME_STATE_PHASES_V4,
  credential: "plaintext" as const,
  dispatchIdentity: "forbidden" as const,
  arrivals: "required" as const,
  stop: "defined" as const,
  loopProgress: "required" as const,
  keys: Object.freeze({
    pending: Object.freeze(["nodeId", "status", "arrivals"]),
    dispatched: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "dispatchedAt",
      "arrivals",
    ]),
    settled: Object.freeze([
      "nodeId",
      "status",
      "attemptId",
      "attemptSeq",
      "attemptCredential",
      "outcomeId",
      "dispatchedAt",
      "settledAt",
      "arrivals",
    ]),
  }),
});

/**
 * The node fields body version 6 defines: version 5's fields, unchanged. The new
 * axis is the MEANING of the per-group unchanged counter (see
 * {@link OUTCOME_STATE_BODY_V6}), so an entry of this version is exactly an entry
 * of version 5 — spread from it deliberately, so the two cannot drift apart in
 * shape while they differ in what a counter means.
 */
const OUTCOME_STATE_LAYOUT_V6: OutcomeStateLayout = Object.freeze({
  ...OUTCOME_STATE_LAYOUT_V5,
  version: OUTCOME_STATE_BODY_V6,
});

/**
 * The node fields body version 7 defines: version 6's fields plus the OPTIONAL
 * `dispatchIdentity` a dispatched or settled entry carries when the runtime
 * that dispatched it held a host identity for that invocation (see
 * {@link OUTCOME_STATE_BODY_V7}). The key lists are built FROM version 6's, so
 * the two layouts cannot drift apart in the fields they share.
 */
const OUTCOME_STATE_LAYOUT_V7: OutcomeStateLayout = Object.freeze({
  ...OUTCOME_STATE_LAYOUT_V6,
  version: OUTCOME_STATE_BODY_V7,
  dispatchIdentity: "defined" as const,
  keys: Object.freeze({
    pending: Object.freeze([...OUTCOME_STATE_LAYOUT_V6.keys.pending]),
    dispatched: Object.freeze([
      ...OUTCOME_STATE_LAYOUT_V6.keys.dispatched,
      "dispatchIdentity",
    ]),
    settled: Object.freeze([
      ...OUTCOME_STATE_LAYOUT_V6.keys.settled,
      "dispatchIdentity",
    ]),
  }),
});

/**
 * The node fields body version 8 defines: version 7's fields, with the
 * credential field RENAMED and narrowed to the digest — a dispatched or settled
 * entry carries `attemptCredentialDigest` and must NOT carry the plaintext
 * `attemptCredential` (see {@link OUTCOME_STATE_BODY_V8}). The key lists are
 * built FROM version 7's, so the layouts cannot drift apart in the fields they
 * share.
 */
const OUTCOME_STATE_LAYOUT_V8: OutcomeStateLayout = Object.freeze({
  ...OUTCOME_STATE_LAYOUT_V7,
  version: OUTCOME_STATE_BODY_V8,
  credential: "digest" as const,
  keys: Object.freeze({
    pending: Object.freeze([...OUTCOME_STATE_LAYOUT_V7.keys.pending]),
    dispatched: Object.freeze(
      OUTCOME_STATE_LAYOUT_V7.keys.dispatched.map((key) =>
        key === "attemptCredential" ? "attemptCredentialDigest" : key,
      ),
    ),
    settled: Object.freeze(
      OUTCOME_STATE_LAYOUT_V7.keys.settled.map((key) =>
        key === "attemptCredential" ? "attemptCredentialDigest" : key,
      ),
    ),
  }),
});

/**
 * Refuse every node field the declared body version does not define for this
 * status.
 *
 * An unknown field is a shape this build cannot read, not something to skip: a
 * reader that ignored it would drop it from the state it writes back. Adding a
 * field is declaring a new body version.
 */
function rejectUnknownNodeFields(
  raw: Record<string, unknown>,
  status: OutcomeNodeStatus,
  where: string,
  layout: OutcomeStateLayout,
): void {
  const defined = layout.keys[status];
  for (const key of Object.keys(raw)) {
    if (!defined.includes(key)) {
      throw malformedState(
        where + " carries field " + JSON.stringify(key) + ", which body version " +
          layout.version + " does not define for a " + status + " node — " +
          "an unknown field is refused rather than dropped",
      );
    }
  }
}

/**
 * Read one node's persisted progress against its plan declaration, in the
 * layout of the body version that declared it.
 *
 * The attempt credential is read exactly where the layout requires it: a
 * version-2 dispatched/settled entry without one is MALFORMED (the writer of
 * that version always writes it), while a version-1 entry that carries one is
 * malformed too (the version does not define the field).
 */
function readNodeState(
  raw: unknown,
  expected: CompiledNode,
  index: number,
  layout: OutcomeStateLayout,
  plan: CompiledPlan,
): OutcomeNodeState {
  const where = "nodes[" + index + "]";
  if (!isRecord(raw)) {
    throw malformedState(where + " is " + describeValue(raw) + ", not a node state record");
  }
  if (raw.nodeId !== expected.id) {
    throw malformedState(
      where + ".nodeId is " + describeValue(raw.nodeId) + ", but the plan declares " +
        JSON.stringify(expected.id) + " at position " + index +
        " — node progress is read in plan order",
    );
  }
  const status = raw.status;
  if (status !== "pending" && status !== "dispatched" && status !== "settled") {
    throw malformedState(
      where + ".status is " + describeValue(status) + ", not pending, dispatched or settled",
    );
  }
  rejectUnknownNodeFields(raw, status, where, layout);
  const attemptId = raw.attemptId;
  const attemptSeq = raw.attemptSeq;
  const attemptCredential = raw.attemptCredential;
  const attemptCredentialDigest = raw.attemptCredentialDigest;
  const dispatchIdentity = readDispatchIdentity(raw, where, layout);
  const outcomeId = raw.outcomeId;
  const dispatchedAt = readOptionalEpoch(raw, "dispatchedAt", where);
  const settledAt = readOptionalEpoch(raw, "settledAt", where);
  let recordedArrivals: readonly OutcomeArrival[] | undefined;
  if (layout.arrivals === "required") {
    recordedArrivals = readArrivals(raw.arrivals, expected, where, plan);
  } else if (raw.arrivals !== undefined) {
    // Unreachable through rejectUnknownNodeFields; kept so the rule does not
    // depend on the key set alone.
    throw malformedState(
      where + " carries an arrivals list, which body version " + layout.version +
        " does not define — the list is refused rather than dropped",
    );
  }
  if (status === "pending") {
    if (
      attemptId !== undefined ||
      attemptSeq !== undefined ||
      attemptCredential !== undefined ||
      attemptCredentialDigest !== undefined ||
      dispatchIdentity !== undefined ||
      outcomeId !== undefined ||
      dispatchedAt !== undefined ||
      settledAt !== undefined
    ) {
      throw malformedState(
        where + " is pending but carries attempt, credential, host binding, outcome or " +
          "timestamp fields — a node that was never dispatched has no attempt identity",
      );
    }
    return Object.freeze({
      nodeId: expected.id,
      status: "pending" as const,
      ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
    });
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw malformedState(
      where + ".attemptId is " + describeValue(attemptId) + ", not a non-empty attempt id",
    );
  }
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq <= 0
  ) {
    throw malformedState(
      where + ".attemptSeq is " + describeValue(attemptSeq) + ", not a positive safe integer",
    );
  }
  // THE CREDENTIAL AXIS IS THE VERSION'S, AND IT IS EXCLUSIVE. A version that
  // records the bearer credential itself (2 to 7) must carry a non-empty
  // plaintext; version 8 must carry the DIGEST and must not carry the plaintext
  // (a plaintext is refused rather than compared as if it were a digest, which
  // is the ambiguity the version gate exists to remove); version 1 defines
  // neither field.
  let credential: string | undefined;
  let credentialDigest: string | undefined;
  if (layout.credential === "plaintext") {
    if (typeof attemptCredential !== "string" || attemptCredential.length === 0) {
      throw malformedState(
        where + ".attemptCredential is " + describeValue(attemptCredential) +
          ", not the non-empty attempt credential body version " + layout.version +
          " requires on a " + status + " node",
      );
    }
    credential = attemptCredential;
  } else if (layout.credential === "digest") {
    if (!isAttemptCredentialDigest(attemptCredentialDigest)) {
      throw malformedState(
        where + ".attemptCredentialDigest is " + describeValue(attemptCredentialDigest) +
          ", not the sha256 digest body version " + layout.version + " requires on a " +
          status + " node — this build persists only the digest of an attempt " +
          "credential, so a record that carries anything else is refused rather " +
          "than read as a verifier it is not",
      );
    }
    credentialDigest = attemptCredentialDigest;
  } else if (attemptCredential !== undefined || attemptCredentialDigest !== undefined) {
    // Unreachable through rejectUnknownNodeFields; kept so the rule does not
    // depend on the key set alone.
    throw malformedState(
      where + " carries an attempt credential, which body version " + layout.version +
        " does not define",
    );
  }
  if (dispatchedAt === undefined) {
    throw malformedState(where + " is " + status + " but carries no dispatchedAt timestamp");
  }
  if (status === "settled") {
    if (typeof outcomeId !== "string" || outcomeId.length === 0) {
      throw malformedState(
        where + ".outcomeId is " + describeValue(outcomeId) +
          ", not the non-empty outcome that settled the node",
      );
    }
    if (settledAt === undefined) {
      throw malformedState(where + " is settled but carries no settledAt timestamp");
    }
    return Object.freeze({
      nodeId: expected.id,
      status: "settled" as const,
      attemptId,
      attemptSeq,
      ...(credential === undefined ? {} : { attemptCredential: credential }),
      ...(credentialDigest === undefined
        ? {}
        : { attemptCredentialDigest: credentialDigest }),
      ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
      outcomeId,
      dispatchedAt,
      settledAt,
      ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
    });
  }
  if (outcomeId !== undefined || settledAt !== undefined) {
    throw malformedState(
      where + " is dispatched but carries a settled outcome or timestamp",
    );
  }
  return Object.freeze({
    nodeId: expected.id,
    status: "dispatched" as const,
    attemptId,
    attemptSeq,
    ...(credential === undefined ? {} : { attemptCredential: credential }),
    ...(credentialDigest === undefined
      ? {}
      : { attemptCredentialDigest: credentialDigest }),
    ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
    dispatchedAt,
    ...(recordedArrivals === undefined ? {} : { arrivals: recordedArrivals }),
  });
}

/** The fields one {@link OutcomeArrival} defines, exactly. */
const OUTCOME_ARRIVAL_KEYS: readonly string[] = Object.freeze([
  "from",
  "outcome",
  "attemptId",
]);

/**
 * Read one node's persisted arrival list against the plan's edges.
 *
 * STRUCTURE ONLY here: the list must be an array of `{ from, outcome,
 * attemptId }` records with non-empty string fields, no feeder twice, and every
 * arrival must be one a declared edge routes from `from` to this node — an
 * arrival no edge produces is refused rather than counted. Whether the list is
 * COMPLETE (and current) is checked once all node entries are read, against the
 * canonical materialization, so a body whose list disagrees with its own entries
 * is refused instead of being trusted or silently corrected.
 */
function readArrivals(
  raw: unknown,
  expected: CompiledNode,
  where: string,
  plan: CompiledPlan,
): readonly OutcomeArrival[] {
  if (!Array.isArray(raw)) {
    throw malformedState(
      where + ".arrivals is " + describeValue(raw) +
        ", not the predecessor arrival list body version " + OUTCOME_STATE_BODY_V3 +
        " defines for every node",
    );
  }
  const arrivals: OutcomeArrival[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const at = where + ".arrivals[" + index + "]";
    if (!isRecord(entry)) {
      throw malformedState(at + " is " + describeValue(entry) + ", not an arrival record");
    }
    for (const key of Object.keys(entry)) {
      if (!OUTCOME_ARRIVAL_KEYS.includes(key)) {
        throw malformedState(
          at + " carries field " + JSON.stringify(key) +
            ", which an arrival does not define — an unknown field is refused rather than dropped",
        );
      }
    }
    const from = entry.from;
    const outcome = entry.outcome;
    const attemptId = entry.attemptId;
    if (typeof from !== "string" || from.length === 0) {
      throw malformedState(
        at + ".from is " + describeValue(from) + ", not a non-empty predecessor node id",
      );
    }
    if (typeof outcome !== "string" || outcome.length === 0) {
      throw malformedState(
        at + ".outcome is " + describeValue(outcome) + ", not a non-empty outcome id",
      );
    }
    if (typeof attemptId !== "string" || attemptId.length === 0) {
      throw malformedState(
        at + ".attemptId is " + describeValue(attemptId) +
          ", not the non-empty attempt that produced the arrival",
      );
    }
    if (seen.has(from)) {
      throw malformedState(
        at + " names predecessor " + JSON.stringify(from) +
          " a second time — a feeder holds at most one arrival at a join",
      );
    }
    seen.add(from);
    if (
      !plan.edges.some(
        (edge) => edge.from === from && edge.to === expected.id && edge.outcome === outcome,
      )
    ) {
      throw malformedState(
        at + " records outcome " + JSON.stringify(outcome) + " of node " + JSON.stringify(from) +
          " arriving at " + JSON.stringify(expected.id) + ", but plan revision " +
          plan.planRevision +
          " declares no such edge — an arrival no edge routes is refused rather than counted",
      );
    }
    arrivals.push(Object.freeze({ from, outcome, attemptId }));
  });
  return Object.freeze(arrivals);
}

/** Read the loop traversal counters, refusing an undeclared group or a bad value. */
function readLoopTraversals(
  raw: unknown,
  plan: CompiledPlan,
): Readonly<Record<string, number>> {
  if (!isRecord(raw)) {
    throw malformedState("loopTraversals is " + describeValue(raw) + ", not a record of counters");
  }
  const declared = new Set(plan.loopGroups.map((group) => group.id));
  const counters: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) {
      throw malformedState(
        "loopTraversals names loop group " + JSON.stringify(key) +
          ", which plan revision " + plan.planRevision + " does not declare",
      );
    }
    const value = raw[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw malformedState(
        "loopTraversals[" + JSON.stringify(key) + "] is " + describeValue(value) +
          ", not a non-negative safe integer",
      );
    }
    counters[key] = value;
  }
  return Object.freeze(counters);
}

/** The fields one {@link OutcomeLoopProgress} defines, exactly. */
const OUTCOME_LOOP_PROGRESS_KEYS: readonly string[] = Object.freeze([
  "loopGroupId",
  "evaluator",
  "version",
  "subject",
  "unchanged",
  "baseline",
]);

/**
 * Read every loop group persisted progress, against the policies the plan
 * declares.
 *
 * The record is a MATERIALIZATION of the plan declarations plus the comparisons
 * the run actually made: exactly one entry per group whose plan declares a
 * progress policy, and no entry for a group that declares none — an entry no
 * declaration asks for is refused rather than read (it would be a baseline for a
 * comparison the plan never authorized), and a missing entry is refused too (the
 * writer materializes one per declared policy at start, so its absence cannot be
 * told from a lost baseline).
 *
 * The EVALUATOR VERSION is deliberately NOT compared with the plan here. A
 * version identifies the comparison SEMANTICS the baseline was recorded under,
 * and a difference is the compatibility fact the COMPARISON must judge: it
 * answers unknown and leaves the baseline alone, rather than the reader refusing
 * a whole body over a number, or a comparison silently re-baselining under
 * semantics the persisted data was never measured with. The evaluator IDENTITY
 * and the SUBJECT ARE compared, because those are what the plan declares the
 * comparison to be; a body recording different ones is a shape this writer could
 * not have produced.
 */
function readLoopProgress(
  raw: unknown,
  plan: CompiledPlan,
): Readonly<Record<string, OutcomeLoopProgress>> {
  if (!isRecord(raw)) {
    throw malformedState(
      "loopProgress is " + describeValue(raw) +
        ", not a record of per-loop-group progress (body version " +
        CURRENT_OUTCOME_STATE_BODY + " defines one entry per declared progress policy)",
    );
  }
  const policies = new Map<string, CompiledProgressPolicy>();
  for (const group of plan.loopGroups) {
    if (group.progress !== undefined) policies.set(group.id, group.progress);
  }
  const entries: Record<string, OutcomeLoopProgress> = {};
  for (const key of Object.keys(raw)) {
    const policy = policies.get(key);
    if (policy === undefined) {
      const declared = plan.loopGroups.some((group) => group.id === key);
      throw malformedState(
        "loopProgress names loop group " + JSON.stringify(key) +
          (declared
            ? ", which plan revision " + plan.planRevision +
              " declares WITHOUT a progress policy — a baseline no declaration asks for is " +
              "refused rather than read"
            : ", which plan revision " + plan.planRevision + " does not declare"),
      );
    }
    entries[key] = readLoopProgressEntry(raw[key], key, policy);
  }
  for (const group of plan.loopGroups) {
    if (group.progress === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(entries, group.id)) continue;
    throw malformedState(
      "loopProgress carries no entry for loop group " + JSON.stringify(group.id) +
        ", whose plan declares a progress policy — the writer records one progress entry per " +
        "declared policy, so a missing one cannot be told from a lost baseline",
    );
  }
  return Object.freeze(entries);
}

/** Read one loop group progress entry against its declared policy. */
function readLoopProgressEntry(
  raw: unknown,
  groupId: string,
  policy: CompiledProgressPolicy,
): OutcomeLoopProgress {
  const where = "loopProgress[" + JSON.stringify(groupId) + "]";
  if (!isRecord(raw)) {
    throw malformedState(where + " is " + describeValue(raw) + ", not a progress record");
  }
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_LOOP_PROGRESS_KEYS.includes(key)) {
      throw malformedState(
        where + " carries field " + JSON.stringify(key) +
          ", which a progress record does not define — an unknown field is refused rather than " +
          "dropped",
      );
    }
  }
  if (raw.loopGroupId !== groupId) {
    throw malformedState(
      where + ".loopGroupId is " + describeValue(raw.loopGroupId) +
        ", but the entry is keyed by " + JSON.stringify(groupId),
    );
  }
  const evaluator = readNonEmptyId(raw.evaluator, where, "evaluator");
  if (evaluator !== policy.evaluator) {
    throw malformedState(
      where + ".evaluator is " + JSON.stringify(evaluator) +
        ", but loop group " + JSON.stringify(groupId) + " declares the comparison semantics " +
        JSON.stringify(policy.evaluator) +
        " — a baseline recorded under another evaluator is refused rather than compared",
    );
  }
  const subject = readNonEmptyId(raw.subject, where, "subject");
  if (subject !== policy.subject) {
    throw malformedState(
      where + ".subject is " + JSON.stringify(subject) +
        ", but loop group " + JSON.stringify(groupId) + " declares " +
        JSON.stringify(policy.subject) + " as its comparison object",
    );
  }
  const version = readPositiveCount(raw.version, where, "version");
  const unchanged = raw.unchanged;
  if (typeof unchanged !== "number" || !Number.isSafeInteger(unchanged) || unchanged < 0) {
    throw malformedState(
      where + ".unchanged is " + describeValue(unchanged) + ", not a non-negative safe integer",
    );
  }
  const baseline = raw.baseline;
  if (baseline !== undefined) {
    if (
      typeof baseline !== "string" ||
      baseline.length === 0 ||
      baseline.length > PROGRESS_VALUE_MAX_LENGTH
    ) {
      throw malformedState(
        where + ".baseline is " +
          (typeof baseline === "string"
            ? baseline.length === 0
              ? "an empty string"
              : "a " + baseline.length + "-character string"
            : describeValue(baseline)) +
          ", not a revision token of 1 to " + PROGRESS_VALUE_MAX_LENGTH +
          " characters — a projection never records more than the bound, and prefixes are never " +
          "compared",
      );
    }
  }
  return Object.freeze({
    loopGroupId: groupId,
    evaluator,
    version,
    subject,
    unchanged,
    ...(baseline === undefined ? {} : { baseline }),
  });
}

/**
 * Refuse every body field the DECLARED body version does not define.
 *
 * An unknown field is a shape this build cannot read, not something to skip: a
 * reader that ignored it would drop it from the state it writes back. Adding a
 * field is declaring a new body version, and a version this build does not read
 * is refused before any field is examined. The check is per-layout rather than
 * version-independent because version 4 adds a BODY-level field: a version-3
 * body carrying `stop` is a shape version 3 never wrote, not a version-4 body.
 */
function rejectUnknownBodyFields(
  body: Record<string, unknown>,
  layout: OutcomeStateLayout,
): void {
  for (const key of Object.keys(body)) {
    if (!layout.bodyKeys.includes(key)) {
      throw malformedState(
        "the body carries field " + JSON.stringify(key) + ", which body version " +
          layout.version +
          " does not define — an unknown field is refused rather than dropped; adding a " +
          "field is a new body version",
      );
    }
  }
}

/**
 * Read one stop record, or refuse the body that carries it.
 *
 * The stop is present EXACTLY when the run stopped: a `stopped` body must carry
 * one (otherwise the state says the run ended and cannot say why), and a body
 * that is not stopped must not (otherwise the state claims an ending that never
 * happened). A version that does not define the field refuses one outright.
 *
 * The vocabulary is closed: `reason` is dispatched against
 * {@link OUTCOME_STOP_REASONS}, and a reason this build does not define is a
 * malformed body rather than a stop read with an unknown meaning.
 */
function readStop(
  raw: unknown,
  phase: OutcomeGraphPhase,
  layout: OutcomeStateLayout,
  where: string,
): OutcomeStop | undefined {
  if (layout.stop === "forbidden") {
    if (raw !== undefined) {
      throw malformedState(
        where + ".stop is present, but body version " + layout.version +
          " does not define a stop record — a version that cannot represent a stop never " +
          "recorded one, so the field is refused rather than read",
      );
    }
    return undefined;
  }
  if (phase !== "stopped") {
    if (raw !== undefined) {
      throw malformedState(
        where + ".stop is present, but phase is " + describeValue(phase) +
          " — a stop record and the phase of `stopped` are the same fact written twice, and " +
          "this body states them differently",
      );
    }
    return undefined;
  }
  if (!isRecord(raw)) {
    throw malformedState(
      where + ".stop is " + describeValue(raw) +
        ", not the stop record a stopped run carries — a body that ended cannot leave the " +
        "reason unrecorded",
    );
  }
  const reason = readStopReason(raw.reason, where);
  switch (reason) {
    case "loop-exhausted":
      return readLoopExhaustedStop(raw, where);
    case "progress-stalled":
      return readProgressStalledStop(raw, where);
    default: {
      // Unreachable while the vocabulary is what `readStopReason` admits; kept
      // so a member added to the union without a reader is a COMPILE error here
      // rather than a stop silently read as unknown.
      const unread: never = reason;
      throw malformedState(
        where + ".stop.reason is " + describeValue(unread) + ", which has no reader",
      );
    }
  }
}

/**
 * Read one stop reason against the CLOSED vocabulary, or refuse it.
 *
 * The membership test is the whole check: a reason the plan and the state did not
 * decide is malformed data, not a stop with a meaning this build does not know.
 */
function readStopReason(value: unknown, where: string): OutcomeStopReason {
  const declared = OUTCOME_STOP_REASONS.find((candidate) => candidate === value);
  if (declared === undefined) {
    throw malformedState(
      where + ".stop.reason is " + describeValue(value) + ", not a stop reason this build " +
        "defines — the vocabulary is closed and every member is a condition decided from the " +
        "plan and the state [" + OUTCOME_STOP_REASONS.join(", ") + "]",
    );
  }
  return declared;
}

/** The fields one {@link OutcomeLoopExhaustedStop} defines, exactly. */
const OUTCOME_LOOP_EXHAUSTED_STOP_KEYS: readonly string[] = Object.freeze([
  "reason",
  "loopGroupId",
  "nodeId",
  "outcomeId",
  "attemptId",
  "traversals",
  "maxTraversals",
  "stoppedAt",
]);

/** Read the one stop reason this build decides, field by field. */
function readLoopExhaustedStop(
  raw: Record<string, unknown>,
  where: string,
): OutcomeLoopExhaustedStop {
  const at = where + ".stop";
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_LOOP_EXHAUSTED_STOP_KEYS.includes(key)) {
      throw malformedState(
        at + " carries field " + JSON.stringify(key) +
          ", which a loop-exhausted stop does not define — an unknown field is refused rather " +
          "than dropped",
      );
    }
  }
  const loopGroupId = readNonEmptyId(raw.loopGroupId, at, "loopGroupId");
  const nodeId = readNonEmptyId(raw.nodeId, at, "nodeId");
  const outcomeId = readNonEmptyId(raw.outcomeId, at, "outcomeId");
  const attemptId = readNonEmptyId(raw.attemptId, at, "attemptId");
  const traversals = readPositiveCount(raw.traversals, at, "traversals");
  const maxTraversals = readPositiveCount(raw.maxTraversals, at, "maxTraversals");
  const stoppedAt = readOptionalEpoch(raw, "stoppedAt", at);
  if (stoppedAt === undefined) {
    throw malformedState(at + " carries no stoppedAt timestamp");
  }
  return Object.freeze({
    reason: "loop-exhausted" as const,
    loopGroupId,
    nodeId,
    outcomeId,
    attemptId,
    traversals,
    maxTraversals,
    stoppedAt,
  });
}

/** The fields one {@link OutcomeProgressStalledStop} defines, exactly. */
const OUTCOME_PROGRESS_STALLED_STOP_KEYS: readonly string[] = Object.freeze([
  "reason",
  "loopGroupId",
  "nodeId",
  "outcomeId",
  "attemptId",
  "unchanged",
  "maxUnchanged",
  "evaluator",
  "evaluatorVersion",
  "subject",
  "baseline",
  "stoppedAt",
]);

/** Read the progress-stalled stop this build decides, field by field. */
function readProgressStalledStop(
  raw: Record<string, unknown>,
  where: string,
): OutcomeProgressStalledStop {
  const at = where + ".stop";
  for (const key of Object.keys(raw)) {
    if (!OUTCOME_PROGRESS_STALLED_STOP_KEYS.includes(key)) {
      throw malformedState(
        at + " carries field " + JSON.stringify(key) +
          ", which a progress-stalled stop does not define — an unknown field is refused " +
          "rather than dropped",
      );
    }
  }
  const loopGroupId = readNonEmptyId(raw.loopGroupId, at, "loopGroupId");
  const nodeId = readNonEmptyId(raw.nodeId, at, "nodeId");
  const outcomeId = readNonEmptyId(raw.outcomeId, at, "outcomeId");
  const attemptId = readNonEmptyId(raw.attemptId, at, "attemptId");
  const unchanged = readPositiveCount(raw.unchanged, at, "unchanged");
  const maxUnchanged = readPositiveCount(raw.maxUnchanged, at, "maxUnchanged");
  const evaluator = readNonEmptyId(raw.evaluator, at, "evaluator");
  const evaluatorVersion = readPositiveCount(raw.evaluatorVersion, at, "evaluatorVersion");
  const subject = readNonEmptyId(raw.subject, at, "subject");
  const baseline = raw.baseline;
  if (
    typeof baseline !== "string" ||
    baseline.length === 0 ||
    baseline.length > PROGRESS_VALUE_MAX_LENGTH
  ) {
    throw malformedState(
      at + ".baseline is " + describeValue(baseline) +
        ", not the non-empty revision token the run stood still on",
    );
  }
  const stoppedAt = readOptionalEpoch(raw, "stoppedAt", at);
  if (stoppedAt === undefined) {
    throw malformedState(at + " carries no stoppedAt timestamp");
  }
  return Object.freeze({
    reason: "progress-stalled" as const,
    loopGroupId,
    nodeId,
    outcomeId,
    attemptId,
    unchanged,
    maxUnchanged,
    evaluator,
    evaluatorVersion,
    subject,
    baseline,
    stoppedAt,
  });
}

/** Read one required non-empty identifier field, or refuse it. */
function readNonEmptyId(value: unknown, where: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not a non-empty identifier",
    );
  }
  return value;
}

/** Read one required positive-safe-integer field, or refuse it. */
function readPositiveCount(value: unknown, where: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw malformedState(
      where + "." + field + " is " + describeValue(value) + ", not a positive safe integer",
    );
  }
  return value;
}

/**
 * Verify one stop against the plan and the entries it is stored beside.
 *
 * The stop is a MATERIALIZATION of a decision the run took, exactly as the
 * arrival list is. The rules that hold for EVERY reason are checked here — the
 * named group must be declared, the named node must be a member of it, the
 * outcome must be that group's declared continuation, and the node's own entry
 * must be SETTLED by that outcome on that attempt — and each reason then adds
 * its own numbers, because a stop whose numbers say otherwise is a body this
 * writer could not have produced: an invented stop would end a run that never
 * hit a limit, and it is refused rather than trusted or silently corrected.
 */
function verifyStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopTraversals: Readonly<Record<string, number>>,
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeStop,
): void {
  switch (stop.reason) {
    case "loop-exhausted":
      verifyLoopExhaustedStop(plan, nodes, loopTraversals, stop);
      return;
    case "progress-stalled":
      verifyProgressStalledStop(plan, nodes, loopProgress, stop);
      return;
    default: {
      // Unreachable while the vocabulary is what the reader admits; kept so a
      // member added to the union without a verifier is a COMPILE error here.
      const unread: never = stop;
      throw malformedState(
        "the stop reason " + describeValue(unread) + " has no verifier",
      );
    }
  }
}

/**
 * Verify a hard-cap stop: its cap, the round it stood on and the counter.
 *
 * The counter EQUALS the cap, because the round that would have exceeded it was
 * never taken.
 */
function verifyLoopExhaustedStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopTraversals: Readonly<Record<string, number>>,
  stop: OutcomeLoopExhaustedStop,
): void {
  const group = plan.loopGroups.find((entry) => entry.id === stop.loopGroupId);
  if (group === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
        ", which plan revision " + plan.planRevision + " does not declare",
    );
  }
  if (group.maxTraversals !== stop.maxTraversals) {
    throw malformedState(
      "the stop records a hard cap of " + stop.maxTraversals + " for loop group " +
        JSON.stringify(stop.loopGroupId) + ", but the plan declares " + group.maxTraversals,
    );
  }
  if (!group.nodes.includes(stop.nodeId)) {
    throw malformedState(
      "the stop names node " + JSON.stringify(stop.nodeId) + ", which is not a member of loop " +
        "group " + JSON.stringify(stop.loopGroupId),
    );
  }
  if (group.continuationOutcome !== stop.outcomeId) {
    throw malformedState(
      "the stop names outcome " + JSON.stringify(stop.outcomeId) + ", but loop group " +
        JSON.stringify(stop.loopGroupId) + " declares " +
        JSON.stringify(group.continuationOutcome) + " as its continuation",
    );
  }
  const entry = nodes.find((node) => node.nodeId === stop.nodeId);
  if (
    entry === undefined ||
    entry.status !== "settled" ||
    entry.outcomeId !== stop.outcomeId ||
    entry.attemptId !== stop.attemptId
  ) {
    throw malformedState(
      "the stop records attempt " + JSON.stringify(stop.attemptId) + " of node " +
        JSON.stringify(stop.nodeId) + " settling with outcome " +
        JSON.stringify(stop.outcomeId) + ", but the node entries do not " +
        "(entry: " + describeNodeEntry(entry) +
        ") — a stop no accepted outcome corroborates is refused rather than trusted",
    );
  }
  const recorded = loopTraversals[stop.loopGroupId] ?? 0;
  if (recorded !== stop.traversals) {
    throw malformedState(
      "the stop records " + stop.traversals + " traversal(s) of loop group " +
        JSON.stringify(stop.loopGroupId) + ", but loopTraversals records " + recorded,
    );
  }
  if (stop.traversals !== stop.maxTraversals) {
    throw malformedState(
      "the stop records traversal " + stop.traversals + " of a cap of " + stop.maxTraversals +
        " — a cap refused the round that would have EXCEEDED it, so the counter it stopped on " +
        "is the cap itself",
    );
  }
}

/**
 * Verify a progress-stalled stop: the declared policy, the observation and the
 * persisted baseline.
 *
 * A stalled stop is a materialization too. The group must declare a progress
 * policy, the numbers must be that policy numbers, and the group progress
 * record must corroborate every fact the stop claims: the same evaluator
 * identity and version, the same subject, the same unchanged count and the very
 * baseline token the run stood still on. The count EQUALS the declared
 * threshold, because the comparison that reached it WAS made and the round it
 * asked for is the one that is not taken. A stop no progress record
 * corroborates is refused rather than trusted: it would end a run on stagnation
 * nobody observed.
 */
function verifyProgressStalledStop(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeProgressStalledStop,
): void {
  const group = plan.loopGroups.find((entry) => entry.id === stop.loopGroupId);
  if (group === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
        ", which plan revision " + plan.planRevision + " does not declare",
    );
  }
  const policy = group.progress;
  if (policy === undefined) {
    throw malformedState(
      "the stop is a progress-stalled stop on loop group " +
        JSON.stringify(stop.loopGroupId) +
        ", but the plan declares no progress policy for that group — a stop no declared " +
        "stopping policy can produce is refused rather than trusted",
    );
  }
  if (policy.maxUnchanged !== stop.maxUnchanged) {
    throw malformedState(
      "the stop records a stagnation threshold of " + stop.maxUnchanged + " for loop group " +
        JSON.stringify(stop.loopGroupId) + ", but the plan declares " + policy.maxUnchanged,
    );
  }
  if (policy.evaluator !== stop.evaluator) {
    throw malformedState(
      "the stop names evaluator " + JSON.stringify(stop.evaluator) +
        ", but loop group " + JSON.stringify(stop.loopGroupId) + " declares " +
        JSON.stringify(policy.evaluator),
    );
  }
  if (policy.subject !== stop.subject) {
    throw malformedState(
      "the stop names comparison subject " + JSON.stringify(stop.subject) +
        ", but loop group " + JSON.stringify(stop.loopGroupId) + " declares " +
        JSON.stringify(policy.subject),
    );
  }
  if (!group.nodes.includes(stop.nodeId)) {
    throw malformedState(
      "the stop names node " + JSON.stringify(stop.nodeId) + ", which is not a member of loop " +
        "group " + JSON.stringify(stop.loopGroupId),
    );
  }
  if (group.continuationOutcome !== stop.outcomeId) {
    throw malformedState(
      "the stop names outcome " + JSON.stringify(stop.outcomeId) + ", but loop group " +
        JSON.stringify(stop.loopGroupId) + " declares " +
        JSON.stringify(group.continuationOutcome) + " as its continuation",
    );
  }
  const entry = nodes.find((node) => node.nodeId === stop.nodeId);
  if (
    entry === undefined ||
    entry.status !== "settled" ||
    entry.outcomeId !== stop.outcomeId ||
    entry.attemptId !== stop.attemptId
  ) {
    throw malformedState(
      "the stop records attempt " + JSON.stringify(stop.attemptId) + " of node " +
        JSON.stringify(stop.nodeId) + " settling with outcome " +
        JSON.stringify(stop.outcomeId) + ", but the node entries do not " +
        "(entry: " + describeNodeEntry(entry) +
        ") — a stop no accepted outcome corroborates is refused rather than trusted",
    );
  }
  const progress = loopProgress[stop.loopGroupId];
  if (progress === undefined) {
    throw malformedState(
      "the stop names loop group " + JSON.stringify(stop.loopGroupId) +
        ", but loopProgress records no progress for it",
    );
  }
  if (
    progress.evaluator !== stop.evaluator ||
    progress.version !== stop.evaluatorVersion ||
    progress.subject !== stop.subject
  ) {
    throw malformedState(
      "the stop records the comparison under evaluator " + JSON.stringify(stop.evaluator) +
        " version " + stop.evaluatorVersion + " on subject " + JSON.stringify(stop.subject) +
        ", but loopProgress records " + JSON.stringify(progress.evaluator) + " version " +
        progress.version + " on subject " + JSON.stringify(progress.subject),
    );
  }
  if (progress.unchanged !== stop.unchanged) {
    throw malformedState(
      "the stop records " + stop.unchanged + " consecutive unchanged comparison(s) of loop " +
        "group " + JSON.stringify(stop.loopGroupId) + ", but loopProgress records " +
        progress.unchanged,
    );
  }
  if (progress.baseline !== stop.baseline) {
    throw malformedState(
      "the stop records the baseline " + JSON.stringify(stop.baseline) + " of loop group " +
        JSON.stringify(stop.loopGroupId) + ", but loopProgress records " +
        (progress.baseline === undefined ? "none" : JSON.stringify(progress.baseline)),
    );
  }
  if (stop.unchanged !== stop.maxUnchanged) {
    throw malformedState(
      "the stop records " + stop.unchanged + " unchanged comparison(s) of a threshold of " +
        stop.maxUnchanged +
        " — the declared policy stops the run AT the threshold, so the counter it stopped on " +
        "is the threshold itself",
    );
  }
}

/**
 * Verify every progress counter against the declared policy and the stop.
 *
 * Two rules, both about what a WRITER could have left behind: a counter never
 * exceeds its declared threshold, and a body that is NOT stopped by the progress
 * policy cannot carry one AT the threshold — reaching it stops the run, so a
 * running body that stands on it is a state this writer never produced. When the
 * body IS stopped that way, an entry may stand on the threshold (more than one
 * group can measure the same unchanged outcome; the stop names the first in plan
 * order).
 */
function verifyProgress(
  plan: CompiledPlan,
  loopProgress: Readonly<Record<string, OutcomeLoopProgress>>,
  stop: OutcomeStop | undefined,
): void {
  const stalledBody = stop !== undefined && stop.reason === "progress-stalled";
  for (const group of plan.loopGroups) {
    const policy = group.progress;
    if (policy === undefined) continue;
    const entry = loopProgress[group.id];
    if (entry === undefined) {
      throw malformedState(
        "loopProgress carries no entry for loop group " + JSON.stringify(group.id) +
          ", whose plan declares a progress policy",
      );
    }
    if (entry.unchanged > policy.maxUnchanged) {
      throw malformedState(
        "loopProgress[" + JSON.stringify(group.id) + "].unchanged is " + entry.unchanged +
          ", above the declared stagnation threshold " + policy.maxUnchanged +
          " — the policy stops the run at the threshold, so no writer records more",
      );
    }
    if (!stalledBody && entry.unchanged === policy.maxUnchanged) {
      throw malformedState(
        "loopProgress[" + JSON.stringify(group.id) + "].unchanged stands on the declared " +
          "stagnation threshold " + policy.maxUnchanged +
          ", but the body carries no progress-stalled stop — a run that reached the threshold " +
          "stops there",
      );
    }
  }
}

/**
 * Describe one persisted stop in a sentence, for a report or a refusal message.
 *
 * ONE formatter for every consumer (the run path and the startup sweep), so a new
 * stop reason is described in one place and no caller has to narrow the union on
 * its own. Wording is not part of the contract; the numbers are the stop's own.
 */
export function describeOutcomeStop(stop: OutcomeStop): string {
  switch (stop.reason) {
    case "loop-exhausted":
      return (
        "loop group " + JSON.stringify(stop.loopGroupId) +
        " reached its hard cap (round " + stop.traversals + "/" + stop.maxTraversals +
        ") at attempt " + JSON.stringify(stop.attemptId)
      );
    case "progress-stalled":
      return (
        "loop group " + JSON.stringify(stop.loopGroupId) +
        " observed " + stop.unchanged + " consecutive unchanged revision(s) (threshold " +
        stop.maxUnchanged + ", evaluator " + JSON.stringify(stop.evaluator) + " version " +
        stop.evaluatorVersion + ", subject " + JSON.stringify(stop.subject) +
        ", baseline " + JSON.stringify(stop.baseline) + ") at attempt " +
        JSON.stringify(stop.attemptId)
      );
    default: {
      const unread: never = stop;
      return "unrecognized stop " + describeValue(unread);
    }
  }
}

/** Describe one node entry for a diagnostic, without inventing fields. */
function describeNodeEntry(entry: OutcomeNodeState | undefined): string {
  if (entry === undefined) return "none";
  return (
    entry.status +
    (entry.attemptId === undefined ? "" : " on " + entry.attemptId) +
    (entry.outcomeId === undefined ? "" : " by " + entry.outcomeId)
  );
}

/**
 * Read one body in the node layout its declared version owns — the shape that
 * version's writer produces.
 *
 * STRICT: every field must be the value that version's writer would have
 * written, at the body and the node level, and the plan's node list must match
 * position by position. Anything else throws an {@link OutcomeStateError} with
 * problem `malformed-state`. The total capability the registry installs turns
 * that throw into a reading, so this function is the RAW shape check.
 */
function readStateBody(
  body: Record<string, unknown>,
  plan: CompiledPlan,
  layout: OutcomeStateLayout,
): OutcomeGraphState {
  rejectUnknownBodyFields(body, layout);
  // The body carries the record's identity redundantly. A body that disagrees
  // with the plan is refused rather than read and rewritten with the plan's
  // value — silently correcting a field is the same class of loss as dropping
  // one.
  if (body.graphId !== plan.graphId) {
    throw malformedState(
      "the body names graph " + describeValue(body.graphId) + ", but the record and the plan " +
        "name " + JSON.stringify(plan.graphId),
    );
  }
  if (body.planRevision !== plan.planRevision) {
    throw malformedState(
      "the body names plan revision " + describeValue(body.planRevision) +
        ", but the record and the plan name " + JSON.stringify(plan.planRevision),
    );
  }
  const phase = layout.phases.find((declared) => declared === body.phase);
  if (phase === undefined) {
    throw malformedState(
      "phase is " + describeValue(body.phase) + ", not " + layout.phases.join(", ") +
        " — the phase vocabulary of body version " + layout.version + " is closed",
    );
  }
  // The stop is read before the entries so a `stopped` body that carries no
  // reason is refused as such, and it is cross-checked against the entries once
  // they are readable (below).
  const stop = readStop(body.stop, phase, layout, "the body");
  const attemptSeq = body.attemptSeq;
  if (
    typeof attemptSeq !== "number" ||
    !Number.isSafeInteger(attemptSeq) ||
    attemptSeq < 0
  ) {
    throw malformedState(
      "attemptSeq is " + describeValue(attemptSeq) + ", not a non-negative safe integer",
    );
  }
  const rawNodes = body.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length !== plan.nodes.length) {
    throw malformedState(
      "nodes is " + (Array.isArray(rawNodes) ? rawNodes.length + " entries" : describeValue(rawNodes)) +
        ", but plan revision " + plan.planRevision + " declares " + plan.nodes.length +
        " node(s) — the state carries one entry per compiled node",
    );
  }
  const nodes = plan.nodes.map((node, index) =>
    readNodeState(rawNodes[index], node, index, layout, plan),
  );
  // The arrival list is verified against the entries it was materialized from,
  // once every entry is readable: a list that omits an arrival its own entries
  // corroborate (a stalled join) or invents one they do not (an unearned arm)
  // is refused rather than trusted or silently corrected.
  if (layout.arrivals === "required") verifyArrivals(plan, nodes);
  const loopTraversals = readLoopTraversals(body.loopTraversals, plan);
  // The per-group progress record is layout: a version that defines it must
  // carry it, and a version that does not refuses one rather than dropping the
  // baselines it cannot represent.
  let loopProgress: Readonly<Record<string, OutcomeLoopProgress>> | undefined;
  if (layout.loopProgress === "required") {
    loopProgress = readLoopProgress(body.loopProgress, plan);
  } else if (body.loopProgress !== undefined) {
    throw malformedState(
      "the body carries a loopProgress record, which body version " + layout.version +
        " does not define — the record is refused rather than dropped",
    );
  }
  // The stop is a materialization of the decision it records, so it is checked
  // against the plan and the very entries it is stored beside — the progress
  // record included, which is what corroborates a progress-stalled stop.
  if (stop !== undefined) {
    verifyStop(plan, nodes, loopTraversals, loopProgress ?? Object.freeze({}), stop);
  }
  if (loopProgress !== undefined) verifyProgress(plan, loopProgress, stop);
  return Object.freeze({
    bodyVersion: layout.version,
    graphId: plan.graphId,
    planRevision: plan.planRevision,
    phase,
    nodes: Object.freeze(nodes),
    loopTraversals,
    attemptSeq,
    ...(stop === undefined ? {} : { stop }),
    ...(loopProgress === undefined ? {} : { loopProgress }),
  });
}

/**
 * One read capability per registered layout: one exact version and one TOTAL
 * reader.
 *
 * The shape check raises its own {@link OutcomeStateError}; this wrapper turns
 * that refusal into the reading the registry contract promises, so a body the
 * reader rejects is reported as data. Anything that is not an
 * OutcomeStateError is a programming error and still propagates.
 */
function stateBodyReader(
  layout: OutcomeStateLayout,
): OutcomeStateBodyReader {
  return Object.freeze({
    format: layout.version,
    read(
      body: Record<string, unknown>,
      plan: CompiledPlan,
    ): OutcomeStateBodyReading {
      try {
        return { kind: "ok", state: readStateBody(body, plan, layout) };
      } catch (error) {
        if (error instanceof OutcomeStateError) {
          return { kind: "invalid", error };
        }
        throw error;
      }
    },
  });
}

const OUTCOME_STATE_BODY_V1_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V1);
const OUTCOME_STATE_BODY_V2_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V2);
const OUTCOME_STATE_BODY_V3_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V3);
const OUTCOME_STATE_BODY_V4_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V4);
const OUTCOME_STATE_BODY_V5_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V5);
const OUTCOME_STATE_BODY_V6_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V6);
const OUTCOME_STATE_BODY_V7_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V7);
const OUTCOME_STATE_BODY_V8_READER = stateBodyReader(OUTCOME_STATE_LAYOUT_V8);

/**
 * The state-body capabilities this build installs: version 8 (what it writes,
 * version 7's fields with the credential persisted as a DIGEST instead of the
 * credential itself) as the only ADVANCEABLE layout, and versions 7 down to 1
 * as READ-ONLY older layouts — version 7 (and 6 and 5) record the credential
 * itself, which this build never re-persists, never compares against a digest
 * and never re-delivers, and the older ones cannot carry the credentials,
 * arrivals, stop or progress baselines this build writes. None of them is
 * migrated.
 */
export const DEFAULT_OUTCOME_STATE_BODY_REGISTRY: OutcomeStateBodyRegistry =
  createOutcomeStateBodyRegistry({
    current: CURRENT_OUTCOME_STATE_BODY,
    formats: [
      OUTCOME_STATE_BODY_V1_READER,
      OUTCOME_STATE_BODY_V2_READER,
      OUTCOME_STATE_BODY_V3_READER,
      OUTCOME_STATE_BODY_V4_READER,
      OUTCOME_STATE_BODY_V5_READER,
      OUTCOME_STATE_BODY_V6_READER,
      OUTCOME_STATE_BODY_V7_READER,
      OUTCOME_STATE_BODY_V8_READER,
    ],
  });

/**
 * Read one persisted record as this plan's state.
 *
 * STRICT, VERSIONED and TOTAL. The identity fields must agree with the plan in
 * hand; the body must declare a state-body version this build has a registered
 * reader for; and the body must be exactly the shape that version defines —
 * every field the value its writer would have written, at the body and the node
 * level, with no field the version does not define. Anything else throws an
 * {@link OutcomeStateError}: a version this build cannot read is refused with
 * `unsupported-state-version` rather than trimmed (the fields it does not know
 * would be lost on the next write), and a state this build cannot read is never
 * guessed at and never silently replaced. A version that DOES define the stop
 * field must agree with itself about it: `phase: stopped` and a stop record are
 * one fact written twice.
 */
export function readOutcomeGraphState(
  record: GraphStateRecord,
  plan: CompiledPlan,
  registry: OutcomeStateBodyRegistry = DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
): OutcomeGraphState {
  if (record.graphId !== plan.graphId) {
    throw new OutcomeStateError(
      "state-plan-mismatch",
      "outcome-state: the persisted state belongs to graph " + JSON.stringify(record.graphId) +
        ", but the plan in hand is the compiled plan of " + JSON.stringify(plan.graphId),
    );
  }
  if (record.planRevision !== plan.planRevision) {
    throw new OutcomeStateError(
      "state-plan-mismatch",
      "outcome-state: the persisted state is bound to plan revision " +
        JSON.stringify(record.planRevision) + ", but the plan in hand is revision " +
        JSON.stringify(plan.planRevision) +
        " — a state is never read as the state of another revision",
    );
  }
  if (!isRecord(record.body)) {
    throw malformedState("the body is " + describeValue(record.body) + ", not a state record");
  }
  const body = record.body;
  const verdict = classifyOutcomeStateBody(body.bodyVersion, registry);
  if (verdict.kind === "invalid") {
    throw malformedState(
      "bodyVersion is " + describeValue(verdict.value) +
        ", not a state-body version — a persisted state body declares the layout it was " +
        "written in, and this build writes body version " + registry.current,
    );
  }
  if (verdict.kind === "unsupported") {
    throw new OutcomeStateError(
      "unsupported-state-version",
      "outcome-state: the persisted graph state declares body version " + verdict.version +
        ", but this build has no reader for it (it reads body version " +
        registry.formats.map((format) => format.format).join(", ") +
        ") — the state is refused instead of being read partially and rewritten, so nothing " +
        "was resumed and no field was dropped",
    );
  }
  const reading = verdict.reader.read(body, plan);
  if (reading.kind === "invalid") throw reading.error;
  return reading.state;
}

/** Project one state into the durable record, timestamped by the caller. */
export function stateRecordOf(
  state: OutcomeGraphState,
  updatedAt: number,
): GraphStateRecord {
  return Object.freeze({
    graphId: state.graphId,
    planRevision: state.planRevision,
    body: state,
    updatedAt,
  });
}

// ── Entry nodes ─────────────────────────────────────────────────────────────

/**
 * The nodes a run may start from.
 *
 * An entry node is one no NON-LOOP edge targets. A loop's continuation edge is
 * excluded on purpose: a back edge can only fire after the loop started, so a
 * graph whose only inbound edge is its own continuation still has an entry
 * (otherwise a two-node loop would look unstartable). If the exclusion leaves
 * no entry at all, the graph declares no starting point and the runtime refuses
 * rather than picking one.
 */
export function entryNodesOf(plan: CompiledPlan): readonly CompiledNode[] {
  const loopEdges = new Set<string>();
  for (const group of plan.loopGroups) {
    const members = new Set(group.nodes);
    for (const edge of plan.edges) {
      if (
        edge.outcome === group.continuationOutcome &&
        members.has(edge.from) &&
        members.has(edge.to)
      ) {
        loopEdges.add(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome);
      }
    }
  }
  const targeted = new Set<string>();
  for (const edge of plan.edges) {
    if (loopEdges.has(edge.from + "\u0000" + edge.to + "\u0000" + edge.outcome)) continue;
    targeted.add(edge.to);
  }
  return Object.freeze(plan.nodes.filter((node) => !targeted.has(node.id)));
}

// ── Join arrivals ───────────────────────────────────────────────────────────

/**
 * The distinct predecessors a plan routes into one node, over ALL of its
 * incoming edges.
 *
 * This is the plan's own topology — the same fact the legacy evaluator's
 * `getUpstreamNodeIds` reads from a v2 declaration — restated for the compiled
 * plan. The order follows the edge list (deduplicated), which is stable for a
 * plan revision.
 */
function feederSourcesOf(plan: CompiledPlan, targetId: string): readonly string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const edge of plan.edges) {
    if (edge.to !== targetId || seen.has(edge.from)) continue;
    seen.add(edge.from);
    sources.push(edge.from);
  }
  return sources;
}

/**
 * The arrival set the node ENTRIES imply, in plan node order.
 *
 * A feeder has arrived at a target exactly when it is SETTLED on its current
 * attempt and settles with an outcome a declared edge routes from it to the
 * target. That single rule is what makes the join round-aware: a feeder that
 * has been re-armed is no longer settled, so the answer it gave before its new
 * attempt began stops counting the moment the new attempt starts.
 *
 * `suppressed` names nodes to treat as if they were already in flight. The
 * reducer uses it to compute an arm set for a whole advance at once: a node the
 * same advance arms must not be evidence for another node armed beside it.
 *
 * The result is a frozen list per plan node, so the state this module writes is
 * canonical by construction and the reader can verify it field by field.
 */
function materializeArrivals(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  suppressed?: ReadonlySet<string>,
): ReadonlyMap<string, readonly OutcomeArrival[]> {
  const entries = new Map<string, OutcomeNodeState>();
  for (const entry of nodes) entries.set(entry.nodeId, entry);
  const outgoing = new Map<string, CompiledEdge[]>();
  for (const edge of plan.edges) {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [edge]);
    else list.push(edge);
  }
  const arrivals = new Map<string, OutcomeArrival[]>();
  for (const node of plan.nodes) arrivals.set(node.id, []);
  // Sources are visited in PLAN order, so each target's list is in plan order
  // too — the canonical order the reader compares against.
  for (const source of plan.nodes) {
    if (suppressed?.has(source.id)) continue;
    const entry = entries.get(source.id);
    if (entry === undefined || entry.status !== "settled") continue;
    const outcomeId = entry.outcomeId;
    const attemptId = entry.attemptId;
    if (outcomeId === undefined || attemptId === undefined) continue;
    const arrival: OutcomeArrival = Object.freeze({
      from: source.id,
      outcome: outcomeId,
      attemptId,
    });
    for (const edge of outgoing.get(source.id) ?? []) {
      if (edge.outcome !== outcomeId) continue;
      const list = arrivals.get(edge.to);
      if (list === undefined) continue;
      // One source's edges are contiguous here, so a repeated declaration of
      // the same edge collapses to one arrival instead of two.
      if (list.length > 0 && list[list.length - 1]?.from === source.id) continue;
      list.push(arrival);
    }
  }
  const frozen = new Map<string, readonly OutcomeArrival[]>();
  for (const [nodeId, list] of arrivals) frozen.set(nodeId, Object.freeze(list));
  return frozen;
}

/**
 * Whether one node's declared join is satisfied by its arrivals.
 *
 * The strategy is resolved by the SAME resolver the legacy signal engine uses
 * (`src/graph/join-strategy.ts`), so a declaration cannot mean one thing to one
 * runtime and another to the other. The satisfaction rule is the outcome
 * protocol's reading of that strategy:
 *
 * - a node with no feeders is a graph root — satisfied immediately (it is armed
 *   by `start()`, not by this gate);
 * - `all` — every distinct feeder has arrived;
 * - `any` — at least one feeder has arrived;
 * - `quorum:N` — at least N distinct feeders have arrived.
 *
 * DIFFERENCE FROM THE LEGACY EVALUATOR, stated so the two cannot be confused:
 * the legacy evaluator counts per-source SIGNALS and can return `failed`
 * (a non-answer terminating signal aborts an `all`/`any` join). The outcome
 * protocol has no severity-ranked signal at all — an outcome either routes along
 * a declared edge or terminates its node — so there is no failure vocabulary to
 * mirror, and an unsatisfied join simply WAITS. A feeder that terminates without
 * routing to the target never arrives; it does not fail the join.
 */
function joinSatisfiedFor(
  plan: CompiledPlan,
  target: CompiledNode,
  arrivals: readonly OutcomeArrival[],
): boolean {
  const feeders = feederSourcesOf(plan, target.id);
  if (feeders.length === 0) return true;
  const arrived = new Set(arrivals.map((arrival) => arrival.from));
  let count = 0;
  for (const feeder of feeders) {
    if (arrived.has(feeder)) count += 1;
  }
  const strategy = resolveJoinStrategy(target.join);
  if (typeof strategy === "object") {
    // A resolved strategy always carries its count; an impossible value waits
    // (the legacy evaluator's own fail-safe) rather than arming on zero answers.
    const quorum = readQuorum(strategy);
    return quorum !== undefined && count >= quorum;
  }
  if (strategy === JoinStrategy.Any) return count >= 1;
  // `JoinStrategy.All` is the resolved default, so every remaining member of
  // the string union means "every feeder".
  return count === feeders.length;
}

/**
 * The successors one accepted outcome arms: the nodes whose join is satisfied
 * ONCE the advance is viewed as a whole.
 *
 * A single accepted outcome can route into several convergence nodes at once,
 * and those nodes can feed each other. Arming one of them starts a NEW attempt,
 * which supersedes the answer it gave in an earlier round — so it must not be
 * evidence for another node armed in the SAME advance, or a convergence node
 * would be armed on the previous round's answer of a feeder that is being
 * re-armed right beside it.
 *
 * The arm set is therefore SELF-CONSISTENT: a candidate is armed exactly when
 * its join is satisfied while the whole armed set is treated as already in
 * flight, so no armed candidate rests on an arrival the same advance supersedes.
 * It is computed by REMOVING failures from the largest candidate set: every
 * round marks the candidates that fail with the candidates still standing
 * suppressed. Removing a candidate makes its settle state available to the
 * candidates that remain, which can only ADD satisfaction, so the not-armed set
 * only grows and the iteration reaches its fixpoint in at most one round per
 * candidate. The result does not depend on the order the candidates are
 * examined in. A dependency cycle among candidates therefore arms NONE of its
 * members — each one's required arrival belongs to another member being re-armed
 * beside it — and the cycle waits for an arrival that is not itself superseded,
 * the same WAIT any unsatisfied join gets (see {@link joinSatisfiedFor}).
 */
function resolveArmSet(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
  armable: readonly CompiledNode[],
): ReadonlySet<string> {
  const entries = new Map<string, OutcomeNodeState>();
  for (const entry of nodes) entries.set(entry.nodeId, entry);
  // The not-armed set only GROWS: a candidate that fails while the current
  // candidates are suppressed is never reconsidered, because dropping it can
  // only add arrivals for the rest. Replacing the set instead of accumulating
  // into it makes the iteration oscillate on a dependency cycle among
  // candidates and stop on an arbitrary parity of the candidate count — arming
  // members of the cycle on each other's superseded attempts.
  const notArmed = new Set<string>();
  for (let round = 0; round <= armable.length; round += 1) {
    const suppressed = new Set<string>();
    for (const node of armable) {
      if (!notArmed.has(node.id)) suppressed.add(node.id);
    }
    const arrivals = materializeArrivals(plan, nodes, suppressed);
    let grew = false;
    for (const node of armable) {
      if (notArmed.has(node.id)) continue;
      const entry = entries.get(node.id);
      const arrived = arrivals.get(node.id) ?? [];
      // A candidate the state does not carry cannot be armed; refusing to arm
      // it is the safe reading of an unreadable entry.
      if (entry === undefined || !joinSatisfiedFor(plan, node, arrived)) {
        notArmed.add(node.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const armed = new Set<string>();
  for (const node of armable) {
    if (!notArmed.has(node.id)) armed.add(node.id);
  }
  return armed;
}

/** Whether two arrival lists are field-for-field identical, in order. */
function sameArrivals(
  a: readonly OutcomeArrival[],
  b: readonly OutcomeArrival[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((arrival, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      arrival.from === other.from &&
      arrival.outcome === other.outcome &&
      arrival.attemptId === other.attemptId
    );
  });
}

/** Render an arrival list for a diagnostic, without inventing fields. */
function describeArrivals(arrivals: readonly OutcomeArrival[]): string {
  return (
    "[" +
    arrivals
      .map(
        (arrival) =>
          JSON.stringify(arrival.from + ":" + arrival.outcome + "@" + arrival.attemptId),
      )
      .join(", ") +
    "]"
  );
}

/**
 * Verify that every node's recorded arrivals are exactly what its own entry and
 * the plan's edges corroborate.
 *
 * This is the anti-drift rule: the list is a materialization of the entries, so
 * a snapshot where the two disagree is not a state this writer could have
 * produced, and it is refused rather than trusted (an invented arrival would arm
 * a join on evidence that does not exist) or silently corrected (an omitted one
 * would stall a join the state itself already satisfies).
 */
function verifyArrivals(
  plan: CompiledPlan,
  nodes: readonly OutcomeNodeState[],
): void {
  const canonical = materializeArrivals(plan, nodes);
  nodes.forEach((entry, index) => {
    const expected = canonical.get(entry.nodeId) ?? [];
    const recorded = entry.arrivals ?? [];
    if (!sameArrivals(recorded, expected)) {
      throw malformedState(
        "nodes[" + index + "].arrivals is " + describeArrivals(recorded) +
          ", but the node entries and the plan's edges corroborate " +
          describeArrivals(expected) +
          " — the arrival list is refused rather than trusted or silently corrected",
      );
    }
  });
}

// ── The reducer ─────────────────────────────────────────────────────────────

/**
 * The state-body versions this build ADVANCES: exactly the layout it writes.
 *
 * A body written by an older layout is advanced only when advancing it invents
 * nothing and drops nothing. Version 7 and earlier carry the attempt credential
 * as a PLAINTEXT nonce on every dispatched and settled entry, and this build
 * writes only the digest — carrying such an entry forward would either persist
 * the nonce again (the defect version 8 exists to close) or drop it (the silent
 * loss the version gate exists to prevent), and re-encoding it is a migration
 * this build deliberately does not perform (a credential is issued once, at
 * dispatch). Versions 6 down to 1 share that reason or cannot carry the
 * arrivals, stop and progress baselines this build writes. They stay READABLE
 * and are refused by name rather than advanced into a newer layout.
 */
const ADVANCEABLE_STATE_BODY_VERSIONS: readonly number[] = Object.freeze([
  OUTCOME_STATE_BODY_V8,
]);

/** Why an accepted outcome could not be applied to the state. */
export type OutcomeAdvanceRefusalCode =
  /** The decision names a node the plan does not declare. */
  | "unknown-node"
  /** The node is not currently dispatched, so it has no attempt to settle. */
  | "node-not-dispatched"
  /** The decision's attempt is not the node's current attempt. */
  | "attempt-mismatch"
  /** The outcome is not terminal and no edge routes it. */
  | "no-route"
  /**
   * The route re-enters a settled node outside its declared loop group.
   */
  | "reentry-outside-loop"
  /**
   * The run is STOPPED: a declared hard limit or progress policy already ended
   * it, so no further outcome advances this state — not on the node that hit the
   * limit (which is settled and replays its receipt instead) and not on any
   * branch that is still recorded in flight. A stopped run is never quietly
   * resumed by a submission; the stop is reported and left exactly as it is.
   */
  | "graph-stopped"
  /**
   * The advance reached a loop group whose plan declares a progress policy, but
   * the projection this submission was measured into is missing, or it is bound
   * to another proposal, attempt or plan revision. A declared comparison is
   * never skipped silently: skipping it would decide the run's stopping policy
   * from data it never measured, so the whole acceptance is refused.
   */
  | "progress-unbound"
  /**
   * The state says an attempt settled and the ledger holds no accepted event
   * for it. Thrown by the run path's join, not by {@link advanceOutcomeGraph}:
   * it is the one disagreement the reducer cannot see on its own.
   */
  | "state-ledger-disagreement"
  /**
   * The state was written in a body layout that cannot carry what this build
   * writes on every attempt: version 1 records no attempt credential, version 2
   * records no join arrivals and version 4 records no progress baseline. The
   * advance is refused rather than converting the state into a newer layout —
   * an attempt with no credential can never be settled, a body with no arrivals
   * cannot say which feeders had reached a join, and a body with no baseline
   * cannot say what the loop already compared, so advancing on one would guess
   * (and would silently reset the progress counters).
   */
  | "unsupported-state-version";

/**
 * An accepted outcome that must NOT advance the state.
 *
 * Thrown from inside the acceptance transaction, so the refusal rolls back the
 * receipt, the accepted event and every pending effect with it: a state that
 * cannot legally advance leaves the graph exactly where it was.
 *
 * A HARD CAP IS NOT ONE OF THESE. Running one round past a declared limit is
 * refused, but the outcome that asked for it is still ACCEPTED and the run ends
 * on a persisted {@link OutcomeStop} instead — see {@link advanceOutcomeGraph}.
 */
export class OutcomeAdvanceRefusedError extends Error {
  readonly code: OutcomeAdvanceRefusalCode;

  constructor(code: OutcomeAdvanceRefusalCode, message: string) {
    super(message);
    this.name = "OutcomeAdvanceRefusedError";
    this.code = code;
  }
}

/** One successor the advance arms, ready to become a dispatch. */
export interface OutcomeDispatchIntent {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;
  /** The credential minted for this fresh attempt (see {@link OutcomeAdvanceInput}). */
  readonly credential: string;
}

/** What one accepted outcome produced: the next state and what to dispatch. */
export interface OutcomeAdvance {
  readonly state: OutcomeGraphState;
  readonly dispatches: readonly OutcomeDispatchIntent[];
  /**
   * Every progress comparison this advance made, in plan loop-group order. Empty
   * when the outcome is not a loop continuation or its group declares no policy
   * — a successful outcome never enters this path.
   */
  readonly progress: readonly ProgressReport[];
}

/** Inputs to {@link advanceOutcomeGraph}. */
export interface OutcomeAdvanceInput {
  readonly plan: CompiledPlan;
  readonly state: OutcomeGraphState;
  /** The accepted decision; its identity is the attempt being settled. */
  readonly decision: AcceptanceDecision;
  /** The clock, in epoch milliseconds. */
  readonly now: number;
  /**
   * Mints the attempt credential for every attempt this advance arms. It is an
   * explicit input because minting is not derivable from the plan or the state:
   * the runtime injects its CSPRNG-backed source, a test injects a deterministic
   * one, and an advance is reproducible for a given source.
   */
  readonly mintCredential: AttemptCredentialSource;
  /**
   * The progress projections this submission was measured into, produced OUTSIDE
   * the acceptance transaction and bound to this proposal, attempt and plan
   * revision (see `progress.ts`). One per loop group whose declared policy
   * governs the submitted continuation; a group with a declared policy and no
   * projection is REFUSED (`progress-unbound`) rather than skipped.
   */
  readonly progress?: readonly ProgressProjection[];
  /**
   * The HOST invocation identity in effect for this advance (D9), recorded on
   * every attempt it arms. Absent — no readable host identity capability, or an
   * invocation the host supplies no identity for — arms attempts with NO
   * binding, which is a complete statement: the runtime never invents one, and
   * the absence is exactly what a later submission's check reads.
   */
  readonly dispatchIdentity?: HostInvocationIdentity;
}

/**
 * The loop group both endpoints of an edge belong to, if any.
 *
 * EXISTENCE, not selection: the re-entry rule asks whether the two nodes share
 * SOME declared loop group, so the first such group is a complete answer (see
 * {@link continuationGroups} for the selection a continuation counter needs).
 */
function sharedLoopGroup(
  plan: CompiledPlan,
  from: string,
  to: string,
): CompiledPlan["loopGroups"][number] | undefined {
  for (const group of plan.loopGroups) {
    if (group.nodes.includes(from) && group.nodes.includes(to)) return group;
  }
  return undefined;
}

/**
 * The loop groups one continuation outcome re-enters.
 *
 * A node may belong to more than one declared loop group, so "the group that
 * contains the emitting node" does not identify a single group. A group only
 * bounds THIS continuation when it declares this outcome as its
 * `continuationOutcome` AND contains the node that emitted it; every matching
 * group's counter advances, so no declared hard cap can be stepped over by
 * picking a different group that happens to share the node. The groups are
 * returned in the plan's own (id) order, so the refusal a caller sees for an
 * over-cap continuation is deterministic.
 */
function continuationGroups(
  plan: CompiledPlan,
  nodeId: string,
  outcomeId: string,
): readonly CompiledPlan["loopGroups"][number][] {
  return plan.loopGroups.filter(
    (group) =>
      group.continuationOutcome === outcomeId && group.nodes.includes(nodeId),
  );
}

/**
 * Compare every declared progress policy this continuation is measured by.
 *
 * Runs INSIDE the acceptance transaction, against the record that transaction is
 * committing: the entries it returns are written in the same batch that carries
 * the receipt, the accepted event and the stop, so a crash cannot commit an
 * acceptance without the progress it implied (or the progress without it). The
 * record is the caller's TRUSTED one — this build writes only the current layout,
 * whose counters it measured itself, and every older body is read-only precisely
 * because a counter of another meaning could not be told apart from one of its
 * own.
 *
 * Every group with a declared policy is compared — the comparison is a fact
 * about the accepted outcome, so a group that ran the comparison records it even
 * when ANOTHER group is the one that stops the run. A group whose projection is
 * missing, or is bound to another proposal, attempt or plan revision, is refused
 * (`progress-unbound`) instead of being skipped: skipping it would silently
 * disable the declared stopping policy.
 *
 * The stop is the FIRST group, in plan id order, that reaches its threshold —
 * deterministic, exactly as the binding hard cap is the first over-cap group.
 */
function measureProgress(
  plan: CompiledPlan,
  groups: readonly CompiledPlan["loopGroups"][number][],
  recorded: Readonly<Record<string, OutcomeLoopProgress>>,
  decision: AcceptanceDecision,
  projections: readonly ProgressProjection[] | undefined,
  now: number,
): {
  readonly entries: Readonly<Record<string, OutcomeLoopProgress>>;
  readonly reports: readonly ProgressReport[];
  readonly stop?: OutcomeProgressStalledStop;
} {
  const entries: Record<string, OutcomeLoopProgress> = { ...recorded };
  const reports: ProgressReport[] = [];
  let stop: OutcomeProgressStalledStop | undefined;
  for (const group of groups) {
    const policy = group.progress;
    if (policy === undefined) continue;
    const entry = recorded[group.id];
    const projection = projections?.find((candidate) => candidate.loopGroupId === group.id);
    if (entry === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
          " declares a progress policy, but the persisted state carries no progress record " +
          "for it — the declared comparison is refused rather than skipped",
      );
    }
    if (projection === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
          " declares a progress policy, but this submission was measured into no projection " +
          "for it — a declared comparison is never skipped",
      );
    }
    if (!projectionMatchesDecision(plan, decision, projection)) {
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: the progress projection of loop group " + JSON.stringify(group.id) +
          " is bound to " + describeProjectionBinding(projection) +
          ", not to this submission (attempt " +
          JSON.stringify(decision.identity.attemptId) + " of plan revision " +
          JSON.stringify(plan.planRevision) + ", proposal " +
          JSON.stringify(decision.proposalDigest) +
          ") — a projection measures exactly the proposal it was produced for, so it is " +
          "refused rather than compared",
      );
    }
    const comparison = compareProgress({ policy, entry, projection });
    entries[group.id] = comparison.entry;
    reports.push(comparison.report);
    if (!comparison.report.stalled || stop !== undefined) continue;
    const baseline = comparison.entry.baseline;
    if (baseline === undefined) {
      // Unreachable: a stall is only reported by the token branch, which always
      // records the token it stalled on. Kept so the stop cannot be built from a
      // baseline this build never wrote.
      throw new OutcomeAdvanceRefusedError(
        "progress-unbound",
        "outcome-advance: loop group " + JSON.stringify(group.id) +
          " reported a stall without a recorded baseline — this build produces no such " +
          "comparison, so the stop is refused rather than invented",
      );
    }
    stop = Object.freeze({
      reason: "progress-stalled" as const,
      loopGroupId: group.id,
      nodeId: decision.nodeId,
      outcomeId: decision.outcomeId,
      attemptId: decision.identity.attemptId,
      unchanged: comparison.entry.unchanged,
      maxUnchanged: policy.maxUnchanged,
      evaluator: comparison.entry.evaluator,
      evaluatorVersion: comparison.entry.version,
      subject: comparison.entry.subject,
      baseline,
      stoppedAt: now,
    });
  }
  return {
    entries: Object.freeze(entries),
    reports: Object.freeze(reports),
    ...(stop === undefined ? {} : { stop }),
  };
}

/**
 * Whether one projection measures exactly the decision being committed.
 *
 * The binding is the acceptance core own validation binding, so the check is the
 * same one the commit applies to its validation: this proposal (digest), this
 * attempt, this plan revision and this graph. A projection that fails it was
 * produced for something else and must not decide this run.
 */
function projectionMatchesDecision(
  plan: CompiledPlan,
  decision: AcceptanceDecision,
  projection: ProgressProjection,
): boolean {
  const binding = projection.binding;
  return (
    binding.graphId === plan.graphId &&
    binding.planRevision === plan.planRevision &&
    binding.attemptId === decision.identity.attemptId &&
    binding.submissionId === decision.identity.submissionId &&
    binding.proposalDigest === decision.proposalDigest
  );
}

/** Describe a projection binding for a diagnostic, without inventing fields. */
function describeProjectionBinding(projection: ProgressProjection): string {
  const binding = projection.binding;
  return (
    "graph " + JSON.stringify(binding.graphId) +
    ", plan revision " + JSON.stringify(binding.planRevision) +
    ", attempt " + JSON.stringify(binding.attemptId) +
    ", proposal " + JSON.stringify(binding.proposalDigest)
  );
}

/**
 * Apply one ACCEPTED outcome to the state.
 *
 * PURE GIVEN ITS INPUTS: it reads the plan, the state, the decision and the
 * injected credential source, and returns the next state plus the successors to
 * arm. It never writes, never reads a clock of its own and never re-validates
 * the outcome (the acceptance core owns that). Reproducibility is stated
 * against the source: the same inputs and the same source produce the same
 * advance.
 *
 * The rules, in order:
 * 0. the state must be written in a body layout this build ADVANCES (version 5
 *    with its counters recomputed, version 6, or the current version 7) — a
 *    version that cannot carry attempt credentials, join arrivals or progress
 *    baselines is refused instead of being advanced and rewritten in a newer
 *    one — and it must not already be STOPPED: a stopped run takes no further
 *    step, so the advance is refused with the reason the run ended rather than
 *    quietly clearing it;
 * 1. the decision's node must be a plan node, currently dispatched, on the
 *    attempt the decision names — otherwise the acceptance does not describe
 *    the state in hand and the advance is refused;
 * 2. a terminal outcome settles the node and arms nothing;
 * 3. any other outcome must route somewhere (the plan's terminal list is the
 *    complement of its edges, so a non-terminal with no edge is a defect);
 * 4. a declared loop continuation advances that group's counter — and when the
 *    hard cap would be exceeded the round is NOT taken, the counter does not
 *    move, and the run STOPS: the outcome is still accepted, its node settles,
 *    no successor of that outcome is armed, and the stop is written into the
 *    returned state so the same transaction that accepted the outcome records
 *    why the run can go no further (one round past the cap is never run, and a
 *    capped run is never left `executing` with nothing able to move it);
 * 5. a successor is armed only when its declared JOIN is satisfied by the
 *    arrivals its feeders have produced, and only when it is not already in
 *    flight: an unsatisfied join arms NOTHING (it waits — see
 *    {@link joinSatisfiedFor} for why waiting, not refusal, is the outcome
 *    protocol's answer), and a satisfied one arms EXACTLY ONCE, so two feeders
 *    completing out of order cannot overwrite the attempt in flight;
 * 6. an armed successor gets a FRESH attempt minted from the graph-wide counter,
 *    a fresh credential from the injected source, and — when this advance was
 *    given one — the host invocation identity the attempt is bound to; a settled
 *    successor is re-armed only when source and target share a declared loop
 *    group;
 * 7. the arrival list is re-materialized for every node once the advance is
 *    applied, so the state carries the durable, canonical record of who has
 *    arrived at every join.
 */
export function advanceOutcomeGraph(input: OutcomeAdvanceInput): OutcomeAdvance {
  const { plan, state, decision, now } = input;
  if (!ADVANCEABLE_STATE_BODY_VERSIONS.includes(state.bodyVersion)) {
    throw new OutcomeAdvanceRefusedError(
      "unsupported-state-version",
      "outcome-advance: the state was written in body version " + state.bodyVersion +
        ", which this build does not advance (it advances body versions " +
        ADVANCEABLE_STATE_BODY_VERSIONS.join(", ") +
        ") — only body version " + CURRENT_OUTCOME_STATE_BODY +
        " records the attempt credential as the DIGEST this build verifies against, while " +
        "every earlier version persists the credential itself (never re-persisted, never " +
        "compared against a presentation and never re-delivered) or cannot carry the join " +
        "arrivals and progress baselines this build writes on every attempt, and a newer " +
        "one is not read by this build — the state is refused rather than advanced and " +
        "rewritten in body version " + CURRENT_OUTCOME_STATE_BODY,
    );
  }
  if (state.loopProgress === undefined) {
    throw new OutcomeAdvanceRefusedError(
      "unsupported-state-version",
      "outcome-advance: the state declares body version " + state.bodyVersion +
        " but carries no loopProgress record — a body of this version records one progress " +
        "entry per declared policy, so the state is refused rather than advanced into a shape " +
        "this build could not read back",
    );
  }
  // THE COUNTERS ARE THIS BUILD'S OWN. The advance guard above admitted only the
  // current layout, and this build writes a counter only after a comparison it
  // performed, so the record is carried forward exactly as it stands — no counter
  // is recomputed, re-based or invented here.
  const recordedProgress: Readonly<Record<string, OutcomeLoopProgress>> =
    state.loopProgress;
  // A STOPPED RUN TAKES NO FURTHER STEP. The stop is a decision the run already
  // committed to, so a later acceptance on ANY branch — the branch that hit the
  // limit included — is refused rather than applied, and the refusal names the
  // reason instead of silently clearing it. (A repeat of the very submission
  // that stopped the run does not reach here: the run path's join settles an
  // already-settled node by replaying its receipt.)
  if (state.stop !== undefined) {
    throw new OutcomeAdvanceRefusedError(
      "graph-stopped",
      "outcome-advance: graph " + JSON.stringify(plan.graphId) + " STOPPED (" +
        state.stop.reason + ": " + describeOutcomeStop(state.stop) +
        ") — a stopped run advances no further, so this " +
        "outcome was not applied and the stop is left exactly as it is",
    );
  }
  const position = plan.nodes.findIndex((node) => node.id === decision.nodeId);
  if (position < 0) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the accepted decision names node " + JSON.stringify(decision.nodeId) +
        ", which plan revision " + plan.planRevision + " does not declare — nothing was applied",
    );
  }
  const current = state.nodes[position];
  if (current === undefined || current.nodeId !== decision.nodeId) {
    throw new OutcomeAdvanceRefusedError(
      "unknown-node",
      "outcome-advance: the state carries no progress for node " + JSON.stringify(decision.nodeId) +
        " — nothing was applied",
    );
  }
  if (current.status === "pending") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
        " was never dispatched, so its outcome cannot settle an attempt — nothing was applied",
    );
  }
  if (current.status === "settled") {
    throw new OutcomeAdvanceRefusedError(
      "node-not-dispatched",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) +
        " is already settled by outcome " + JSON.stringify(current.outcomeId ?? "") +
        " — a settled node is never advanced twice",
    );
  }
  if (current.attemptId !== decision.identity.attemptId) {
    throw new OutcomeAdvanceRefusedError(
      "attempt-mismatch",
      "outcome-advance: node " + JSON.stringify(decision.nodeId) + " is on attempt " +
        JSON.stringify(current.attemptId ?? "") + ", but the accepted decision belongs to attempt " +
        JSON.stringify(decision.identity.attemptId) +
        " — a stale acceptance is refused rather than applied to a newer attempt",
    );
  }

  const node = plan.nodes[position];
  const nodes: OutcomeNodeState[] = state.nodes.map((entry) => ({ ...entry }));
  nodes[position] = Object.freeze({
    nodeId: current.nodeId,
    status: "settled" as const,
    ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
    ...(current.attemptSeq === undefined ? {} : { attemptSeq: current.attemptSeq }),
    // The credential DIGEST of the attempt that SETTLED the node is kept,
    // exactly as its attempt id is: a repeated submission must resolve back to
    // this same attempt (and its receipt), never to a newer one.
    ...(current.attemptCredentialDigest === undefined
      ? {}
      : { attemptCredentialDigest: current.attemptCredentialDigest }),
    // The host identity the attempt was DISPATCHED under is kept for the same
    // reason its credential is: a repeated submission resolves back to this
    // attempt (and its receipt) and must still be checked against the binding
    // that attempt was made under, never against a newer invocation.
    ...(current.dispatchIdentity === undefined
      ? {}
      : { dispatchIdentity: current.dispatchIdentity }),
    outcomeId: decision.outcomeId,
    ...(current.dispatchedAt === undefined ? {} : { dispatchedAt: current.dispatchedAt }),
    settledAt: now,
  });

  let loopTraversals = state.loopTraversals;
  let loopProgress: Readonly<Record<string, OutcomeLoopProgress>> = recordedProgress;
  let attemptSeq = state.attemptSeq;
  const dispatches: OutcomeDispatchIntent[] = [];
  /** Every comparison this advance made, in plan loop-group order. */
  const progressReports: ProgressReport[] = [];
  /**
   * The stop this advance produces, if it hits a declared hard cap. Set BEFORE
   * any successor is armed, and the successor block below is skipped entirely
   * once it is set: a capped conversion routes NOTHING, so no part of the
   * outcome is applied and no effect is written.
   */
  let stop: OutcomeStop | undefined;

  const terminal = plan.terminalOutcomes.some(
    (entry) => entry.nodeId === decision.nodeId && entry.outcome === decision.outcomeId,
  );
  if (!terminal) {
    const successors = plan.edges.filter(
      (edge) => edge.from === decision.nodeId && edge.outcome === decision.outcomeId,
    );
    if (successors.length === 0) {
      throw new OutcomeAdvanceRefusedError(
        "no-route",
        "outcome-advance: outcome " + JSON.stringify(decision.outcomeId) + " of node " +
          JSON.stringify(decision.nodeId) + " is not a declared terminal and binds no edge — " +
          "the plan is inconsistent and nothing was applied",
      );
    }
    // Which loop this continuation re-enters is decided by the DECLARATION
    // (the groups that declare this outcome as their continuation), not by the
    // first group that happens to contain the emitting node. Every matching
    // group advances TOGETHER and the continuation is refused as a whole when
    // ANY of their caps would be exceeded — a hard cap that a shared node could
    // route around is not hard. The counters are staged and assigned only once
    // every cap has been checked, so a refusal leaves the counters exactly as it
    // found them; the group that binds is the FIRST over-cap group in the plan's
    // own (id) order, so the stop a caller sees is deterministic.
    const groups = continuationGroups(plan, decision.nodeId, decision.outcomeId);
    if (groups.length > 0) {
      const next: Record<string, number> = { ...loopTraversals };
      let bound: CompiledPlan["loopGroups"][number] | undefined;
      for (const group of groups) {
        const traversals = (next[group.id] ?? 0) + 1;
        if (traversals > group.maxTraversals) {
          bound = group;
          break;
        }
        next[group.id] = traversals;
      }
      if (bound === undefined) {
        loopTraversals = Object.freeze(next);
      } else {
        // THE HARD CAP ENDS THE RUN. The round is NOT taken (the counters stay
        // exactly where they were), NOTHING this outcome routes is armed — and
        // the stop is carried out of this function in the state, so the very
        // transaction that accepted the outcome also records why the run can go
        // no further. The emitting node is already settled above: its outcome is
        // a real, accepted result, and the stop fabricates no outcome and no
        // accepted event of its own.
        stop = Object.freeze({
          reason: "loop-exhausted" as const,
          loopGroupId: bound.id,
          nodeId: decision.nodeId,
          outcomeId: decision.outcomeId,
          attemptId: decision.identity.attemptId,
          // The counter the group stopped on: the cap itself, because the round
          // that would have exceeded it was never taken.
          traversals: loopTraversals[bound.id] ?? 0,
          maxTraversals: bound.maxTraversals,
          stoppedAt: now,
        });
      }
    }
    // THE PROGRESS GATE, and only when the round is actually taken. A hard cap
    // that already bound leaves the run ended, so nothing is compared: the
    // comparisons record what the loop OBSERVED, and a run that cannot continue
    // has no stopping policy left to decide. Otherwise every declared policy
    // whose continuation this outcome is compares its projection against the
    // persisted baseline — in the acceptance transaction, against the record the
    // same commit writes — and the FIRST group (plan id order) to reach its
    // declared threshold stops the run exactly as the hard cap does.
    if (stop === undefined) {
      const measured = measureProgress(
        plan,
        groups,
        recordedProgress,
        decision,
        input.progress,
        now,
      );
      loopProgress = measured.entries;
      for (const report of measured.reports) progressReports.push(report);
      stop = measured.stop;
    }
    // A STOPPED ADVANCE ROUTES NOTHING. When the hard cap or the progress
    // threshold above bound, this outcome arms NO successor — not even one whose
    // join its arrival would satisfy — because a stop is the whole run's ending
    // and a partially routed outcome is a state the model cannot describe. The
    // candidate set is therefore empty, so no re-entry check, no join gate and
    // no arm runs and no effect is written; the emitting node's arrival record
    // is still materialized below, because it IS settled and an arrival is a
    // fact about the entries, not about the arming.
    const routed = stop === undefined ? successors : [];
    // The candidates this outcome routes to, as PLAN nodes in plan order. The
    // order is the state's own node order, so the same advance always mints the
    // same attempt ids; a target the plan does not declare is refused with the
    // vocabulary the single-successor rule used.
    const candidateIds = new Set(routed.map((edge) => edge.to));
    for (const targetId of candidateIds) {
      if (!plan.nodes.some((entry) => entry.id === targetId)) {
        throw new OutcomeAdvanceRefusedError(
          "no-route",
          "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
            JSON.stringify(targetId) + " names a node the plan does not declare",
        );
      }
    }
    const candidates = plan.nodes
      .map((entry, index) => ({ node: entry, index }))
      .filter((candidate) => candidateIds.has(candidate.node.id));

    // Re-entry legality, checked once per candidate BEFORE anything is applied:
    // a settled target the emitting node shares no declared loop group with is
    // refused for the whole acceptance, exactly as it was when one outcome could
    // arm only one successor.
    for (const candidate of candidates) {
      if (nodes[candidate.index].status !== "settled") continue;
      const shared = sharedLoopGroup(plan, decision.nodeId, candidate.node.id);
      if (shared === undefined) {
        throw new OutcomeAdvanceRefusedError(
          "reentry-outside-loop",
          "outcome-advance: edge " + JSON.stringify(decision.nodeId) + " -> " +
            JSON.stringify(candidate.node.id) + " re-enters a settled node, but the two do not " +
            "share a declared loop group — re-entry outside a declared loop is refused",
        );
      }
    }

    // THE JOIN GATE. A node is armed only when its declared join is satisfied,
    // and a node already in flight is never armed a second time — the two rules
    // together make an attempt exactly-once per satisfaction. A candidate whose
    // join is NOT satisfied is left exactly where it was (pending or settled)
    // apart from its arrival record, which is the durable evidence this
    // acceptance contributed; no attempt id, no dispatched status and no effect
    // are written for it.
    const armable = candidates.filter(
      (candidate) => nodes[candidate.index].status !== "dispatched",
    );
    const armSet = resolveArmSet(
      plan,
      nodes,
      armable.map((candidate) => candidate.node),
    );
    for (const candidate of candidates) {
      if (!armSet.has(candidate.node.id)) continue;
      attemptSeq += 1;
      const attemptId = candidate.node.id + "#" + attemptSeq;
      const targetNode = candidate.node;
      // The credential is issued WITH the attempt and its DIGEST is persisted on
      // the entry, so the binding a submission is checked against comes from the
      // state — never from the submission, and never re-derived from the attempt
      // id. The credential itself is returned in this advance's dispatch intent
      // (below), which is the one channel that hands it to the host that
      // delivers it; nothing durable records it.
      const credential = mintAttemptCredential(
        input.mintCredential,
        attemptCredentialBinding({
          graphId: plan.graphId,
          nodeId: targetNode.id,
          attemptId,
          planRevision: plan.planRevision,
        }),
      );
      nodes[candidate.index] = Object.freeze({
        nodeId: targetNode.id,
        status: "dispatched" as const,
        attemptId,
        attemptSeq,
        attemptCredentialDigest: attemptCredentialDigest(credential),
        // The invocation identity IN EFFECT for this advance, recorded with the
        // attempt so a later process can require the submission to come from the
        // same host attribution (D9). Absent when the host declared none: the
        // absence is the record, and no later process back-fills one.
        ...(input.dispatchIdentity === undefined
          ? {}
          : { dispatchIdentity: input.dispatchIdentity }),
        dispatchedAt: now,
        // The canonical arrival list is materialized once the whole advance is
        // applied (below); an armed node's list is the arrivals that armed it.
        arrivals: Object.freeze([]),
      });
      dispatches.push(
        Object.freeze({
          nodeId: targetNode.id,
          attemptId,
          agent: targetNode.agent,
          prompt: targetNode.prompt,
          credential,
        }),
      );
    }
  }

  // THE ARRIVAL RECORD IS MATERIALIZED LAST, once every entry this advance
  // changed is final (the settled node and every node it armed). It is ONE
  // function of the entries, so the persisted list is canonical by construction
  // and the reader's cross-check cannot disagree with the writer. A node the run
  // never reached keeps its empty list; a node waiting at an unsatisfied join
  // keeps the arrivals that are its reason to wait.
  const canonicalArrivals = materializeArrivals(plan, nodes);
  for (let index = 0; index < nodes.length; index += 1) {
    const entry = nodes[index];
    if (entry === undefined) continue;
    nodes[index] = Object.freeze({
      ...entry,
      arrivals: canonicalArrivals.get(entry.nodeId) ?? Object.freeze([]),
    });
  }

  const dispatched = nodes.some((entry) => entry.status === "dispatched");
  const attempted = nodes.some((entry) => entry.status !== "pending");
  // A STOP takes precedence over the derived phase: `complete` says the run has
  // no work left, while `stopped` says it was cut short — a graph that hit a
  // declared cap must never report the phase a run that finished properly
  // reports, even when nothing is in flight any more.
  const phase: OutcomeGraphPhase =
    stop !== undefined
      ? "stopped"
      : dispatched
        ? "executing"
        : attempted
          ? "complete"
          : "ready";
  return Object.freeze({
    state: Object.freeze({
      // The guard above admitted only the current layout, so the advanced state
      // is written in it (a new attempt always carries a credential).
      bodyVersion: CURRENT_OUTCOME_STATE_BODY,
      graphId: state.graphId,
      planRevision: state.planRevision,
      phase,
      nodes: Object.freeze(nodes),
      loopTraversals,
      attemptSeq,
      ...(stop === undefined ? {} : { stop }),
      loopProgress,
    }),
    dispatches: Object.freeze(dispatches),
    progress: Object.freeze(progressReports),
  });
}

// ── Descriptions ────────────────────────────────────────────────────────────

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}
