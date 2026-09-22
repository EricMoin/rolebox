/**
 * Graph Execution Engine v2 — Outcome-protocol run path (C3b)
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The RUN PATH of a DECLARED (protocol 2) graph
 * (docs/graph-outcome-protocol.md § "Submission and acceptance" and
 * § "State, storage, and effects"). It dispatches the compiled plan's entry
 * nodes, binds every submission to a trusted execution identity of its own
 * making, hands the proposal to the acceptance core, and APPLIES the accepted
 * outcome to the graph state — all in the acceptance core's ONE transaction, so
 * the state snapshot, the receipt, the accepted event and the pending effects
 * commit together or not at all.
 *
 * THE LEGACY ENGINE IS NOT INVOLVED. This runtime never builds a v2 engine,
 * never imports `src/graph/engine/**` or `src/dispatch/**`, and never lets a
 * severity-ranked signal decide a node's completion: for a graph bound to the
 * outcome protocol the SUBMISSION INGRESS IS THE ONLY COMPLETION SOURCE, which
 * is exactly what the registered outcome handler declares. The legacy v2 run
 * path and its file persistence are untouched.
 *
 * EXECUTION IDENTITY IS DERIVED HERE, NEVER SUPPLIED. The graph id is the
 * compiled plan's own `graphId`; the attempt id is the one the STATE minted for
 * the node's current attempt; the submission id is content-addressed from the
 * proposal's canonical digest. A worker that puts `graphId`, `attemptId`,
 * `submissionId` or a plan revision in its proposal is refused by the shape
 * gate as an unknown key, and nothing it supplies can name — or overwrite — the
 * execution its claim belongs to.
 *
 * A DUPLICATE SUBMISSION IS A REPLAY, NOT A SECOND ADVANCE. The content-derived
 * submission id makes repeating the same proposal for the same attempt the SAME
 * logical submission, so the ledger replays the persisted receipt; the join
 * sees the node already settled, contributes no effects and no state write, and
 * the graph stays where the first acceptance put it.
 *
 * RESTART RECOVERY IS `resume()` (C3c). It reads the graph state from the
 * LEDGER, refuses a state bound to another plan revision, and continues the
 * graph from that state: every UNSETTLED dispatch effect is launched through
 * the seam (a pending effect is the crash-after-commit-before-launch window;
 * a `started` effect from a dead process is reported, never re-run and never
 * dropped), and every node the state records as in flight is reported as armed.
 * Running it twice dispatches nothing the second time, because a launched
 * effect is durably marked `started` BEFORE the seam runs. A graph with no
 * state at all is STARTED from this runtime's plan — the same SAVED plan a
 * later recovery continues (the review's D5), never a fresh reinterpretation.
 *
 * THE SUBMISSION INGRESS IS THE ONLY COMPLETION SOURCE. A graph bound to this
 * protocol has no legacy runtime instance anywhere: it is not an entry of the
 * toolset's legacy registry, every legacy tool entry point refuses it, and this
 * module never imports `src/graph/engine/**` or `src/dispatch/**`. No
 * severity-ranked signal and no synthesized answer can settle one of its nodes;
 * only an accepted outcome committed through this runtime can (see
 * `src/graph/tools/submit-outcome.ts`, which is the model-facing ingress into
 * this same `submit`).
 *
 * SCOPE, STATED PLAINLY. C3c delivers `resume` here, the model-facing
 * `graph_submit_outcome` ingress (`src/graph/tools/submit-outcome.ts`), and the
 * startup sweep's route onto this runtime. Still DEFERRED: the protocol-aware
 * dispatch COMPLETION BRIDGE (this runtime drives a synchronous scripted seam
 * instead), effect EXECUTION beyond calling that seam, storage format 3 with
 * its `2 -> 3` migrator, and the stage-D/E routing, loop and legacy-retirement
 * work. The legacy v2 run and recovery paths are untouched.
 */

import type { CompiledPlan } from "../compiler/plan.ts";
import type {
  AcceptanceLedger,
  AcceptanceLedgerTx,
  GraphStateRecord,
  PendingEffectRecord,
  ReceiptRecord,
} from "../ledger/types.ts";
import {
  DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
  OUTCOME_PROTOCOL,
  classifyExecutionProtocol,
  isOutcomeProtocolHandler,
  type ExecutionProtocolRegistry,
} from "../protocol/execution-protocol.ts";
import {
  submitOutcome,
  type AcceptanceDecision,
  type AcceptanceJoin,
  type AcceptanceJoinResult,
  type SubmissionRefusal,
  type SubmissionRefusalCode,
  type SubmissionResult,
} from "./acceptance.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  OutcomeAdvanceRefusedError,
  OutcomeStateError,
  advanceOutcomeGraph,
  entryNodesOf,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeAdvance,
  type OutcomeDispatchIntent,
  type OutcomeGraphState,
  type OutcomeNodeState,
} from "./graph-state.ts";
import { proposalDigest, readOutcomeProposal } from "./proposal.ts";
import type { ExecutionIdentity, ValidatorRegistry } from "./validators.ts";

// ── The dispatch seam ───────────────────────────────────────────────────────

/**
 * One node the runtime asks a dispatcher to run.
 *
 * Every field is runtime provenance: the graph and plan revision the node
 * belongs to, the attempt id the STATE minted, and the plan's own agent/prompt.
 * Nothing here comes from a worker.
 */
export interface OutcomeDispatchRequest {
  readonly graphId: string;
  readonly planRevision: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;
}

/**
 * The dispatch seam: how a node is actually started.
 *
 * Deliberately a plain synchronous function rather than the legacy dispatch
 * bridge. Selecting a protocol-aware completion bridge — one that would make an
 * accepted outcome the bridge's single authoritative completion source — is
 * DEFERRED; this slice proves the run path against a scripted seam, and the
 * seam performs no completion interpretation at all.
 */
export type OutcomeDispatchSeam = (request: OutcomeDispatchRequest) => void;

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why the runtime refused to act. Stable identifiers; wording is not API.
 *
 * The acceptance core's own repair codes ({@link SubmissionRefusalCode}) are
 * part of this vocabulary: a submission the core refuses is reported through
 * exactly the code the core chose, so a caller never has to translate it.
 */
export type OutcomeRuntimeRefusalCode =
  | SubmissionRefusalCode
  /** The registered handler does not own this protocol's semantics. */
  | "protocol-unavailable"
  /** The clock is not epoch milliseconds. */
  | "invalid-timestamp"
  /** The plan declares no node a run could start from. */
  | "no-entry-node"
  /** The graph has never written a state snapshot. */
  | "graph-not-started"
  /** A persisted state exists but is not this build's state for this plan. */
  | "unreadable-state"
  /**
   * The persisted state declares a state-body version this build has no reader
   * for. Reported separately from `unreadable-state`: the body is a legal,
   * well-formed snapshot of a LAYOUT this build does not know, so recovery is
   * blocked and the body is left exactly as it is.
   */
  | "unsupported-state-version"
  /** The proposal names a node the plan does not declare. */
  | "unknown-node"
  /** The node has no attempt in flight, so no outcome can settle one. */
  | "node-not-dispatched"
  /** The accepted outcome belongs to a different attempt than the state's. */
  | "attempt-mismatch"
  /** No edge routes a non-terminal outcome. */
  | "no-route"
  /** Applying this continuation would exceed the loop's hard cap. */
  | "loop-limit-exceeded"
  /** The route re-enters a settled node outside its declared loop group. */
  | "reentry-outside-loop"
  /** The state says an attempt settled and the ledger holds no such event. */
  | "state-ledger-disagreement"
  /**
   * The persisted record is bound to the outcome protocol but carries no
   * compiled plan (or no plan binding), so the run had nothing to resume FROM.
   * Recovery never guesses a plan: an absent one is reported, not recompiled.
   */
  | "missing-persisted-plan"
  /** A dispatch seam threw while launching an unsettled effect (C3c resume). */
  | "dispatch-failed";

/** One structured reason the runtime refused. */
export interface OutcomeRuntimeRefusal {
  readonly code: OutcomeRuntimeRefusalCode;
  readonly message: string;
  readonly path?: string;
}

/** What {@link OutcomeGraphRuntime.start} produced. */
export type OutcomeStartResult =
  | {
      readonly kind: "started";
      readonly state: OutcomeGraphState;
      readonly dispatched: readonly OutcomeDispatchRequest[];
    }
  /** The graph already has a state snapshot; start is idempotent. */
  | { readonly kind: "already-started"; readonly state: OutcomeGraphState }
  | {
      readonly kind: "refused";
      readonly refusals: readonly OutcomeRuntimeRefusal[];
    };

/** What {@link OutcomeGraphRuntime.submit} produced. */
export type OutcomeSubmissionResult =
  /** The submission was refused before anything was written. */
  | {
      readonly kind: "refused";
      readonly refusals: readonly OutcomeRuntimeRefusal[];
    }
  /**
   * An accepted outcome advanced the graph. `replayed` distinguishes the FIRST
   * settlement from a repeated submission of the same content: a replay returns
   * the persisted receipt, dispatches nothing and changes no state.
   */
  | {
      readonly kind: "accepted";
      readonly decision: AcceptanceDecision;
      readonly receipt: ReceiptRecord;
      readonly state: OutcomeGraphState;
      readonly dispatched: readonly OutcomeDispatchRequest[];
      readonly replayed: boolean;
    }
  /** A gate failed: the receipt records the rejection, the attempt stays open. */
  | {
      readonly kind: "rejected";
      readonly decision: AcceptanceDecision;
      readonly receipt: ReceiptRecord;
    }
  /** A conflict or a settlement: this submission's decision was not committed. */
  | {
      readonly kind: "not-committed";
      readonly decision: AcceptanceDecision;
      readonly verdict: Extract<SubmissionResult, { kind: "submitted" }>["verdict"];
    };

/** One node the persisted state records as in flight, awaiting an outcome. */
export interface OutcomeArmedNode {
  readonly nodeId: string;
  /** The attempt a submission for this node must settle (runtime-minted). */
  readonly attemptId: string;
}

/**
 * What {@link OutcomeGraphRuntime.resume} produced.
 *
 * `started` and `resumed` carry the SAME three reports, because the first
 * execution and a restart recovery must be indistinguishable to the caller that
 * owns the effects:
 * - `dispatched` — the dispatch requests this call actually launched (every
 *   one a formerly `pending` effect, whose node the state already records as
 *   in flight). A `started` effect is NEVER re-launched.
 * - `armed` — every node the state records as dispatched, with its attempt, so
 *   a caller can see what is awaiting a submission even when nothing was
 *   launched (an entry dispatch recorded by `start()`, or work a dead process
 *   began).
 * - `unsettledEffects` — every effect still `pending` or `started` after this
 *   call, read from the ledger. Nothing in this set is dropped or silently
 *   rewound; a `started` row from a dead process is reported here.
 *
 * `refusals` on a started/resumed answer are per-effect diagnostics (an effect
 * whose payload is unreadable, or whose node the state does not corroborate).
 * They do not stop the rest of the resume; the effect they name stays unsettled
 * and therefore also appears in `unsettledEffects`.
 */
export type OutcomeResumeResult =
  | {
      readonly kind: "started";
      readonly state: OutcomeGraphState;
      readonly dispatched: readonly OutcomeDispatchRequest[];
      readonly armed: readonly OutcomeArmedNode[];
      readonly unsettledEffects: readonly PendingEffectRecord[];
      readonly refusals: readonly OutcomeRuntimeRefusal[];
    }
  | {
      readonly kind: "resumed";
      readonly state: OutcomeGraphState;
      readonly dispatched: readonly OutcomeDispatchRequest[];
      readonly armed: readonly OutcomeArmedNode[];
      readonly unsettledEffects: readonly PendingEffectRecord[];
      readonly refusals: readonly OutcomeRuntimeRefusal[];
    }
  | {
      readonly kind: "refused";
      readonly refusals: readonly OutcomeRuntimeRefusal[];
    };

/** What the join reduced inside the acceptance transaction. */
interface JoinedReduction {
  readonly result: AcceptanceJoinResult;
  readonly advance?: OutcomeAdvance;
}

// ── The runtime ─────────────────────────────────────────────────────────────

/** Inputs to {@link OutcomeGraphRuntime}. */
export interface OutcomeGraphRuntimeOptions {
  /** The committed compiled plan this runtime executes. Its graphId IS the id. */
  readonly plan: CompiledPlan;
  /** The durable ledger the state and the acceptance share. */
  readonly ledger: AcceptanceLedger;
  /** Where a dispatched node goes. The runtime calls it after a commit only. */
  readonly dispatch: OutcomeDispatchSeam;
  /** The installed validator implementations the plan's gates resolve against. */
  readonly validators: ValidatorRegistry;
  /** The root every evidence reference must resolve inside. */
  readonly artifactRoot: string;
  /** The clock. Time is an explicit input; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** The installed execution-protocol handlers; defaults to the shipped set. */
  readonly protocols?: ExecutionProtocolRegistry;
}

/**
 * The run path of one outcome-protocol graph.
 *
 * Construct it with the committed plan and the ledger, call {@link start} to
 * dispatch the plan's entry nodes, and hand each worker's outcome to
 * {@link submit}. The runtime is SYNCHRONOUS on purpose: the acceptance
 * transaction is a synchronous boundary, so the whole state transition happens
 * before the call returns, and the dispatch seam runs only after the commit.
 */
export class OutcomeGraphRuntime {
  /** The graph identity — the compiled plan's own `graphId`. */
  readonly graphId: string;
  /** The plan revision every receipt and state snapshot is bound to. */
  readonly planRevision: string;

  private readonly plan: CompiledPlan;
  private readonly ledger: AcceptanceLedger;
  private readonly dispatch: OutcomeDispatchSeam;
  private readonly validators: ValidatorRegistry;
  private readonly artifactRoot: string;
  private readonly clock: () => number;
  private readonly protocols: ExecutionProtocolRegistry | undefined;

  constructor(options: OutcomeGraphRuntimeOptions) {
    this.plan = options.plan;
    this.graphId = options.plan.graphId;
    this.planRevision = options.plan.planRevision;
    this.ledger = options.ledger;
    this.dispatch = options.dispatch;
    this.validators = options.validators;
    this.artifactRoot = options.artifactRoot;
    this.clock = options.clock ?? (() => Date.now());
    this.protocols = options.protocols;
  }

  /**
   * Dispatch the plan's entry nodes and persist the starting state.
   *
   * IDEMPOTENT: a graph that already has a state snapshot is reported as
   * `already-started` and NOT re-dispatched — re-running an entry node would
   * overwrite the attempt a settled node's replay identity depends on.
   */
  start(now?: number): OutcomeStartResult {
    const at = this.readClock(now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.protocolRefusal();
    if (unavailable !== undefined) return refused([unavailable]);

    let existing: OutcomeGraphState | undefined;
    try {
      existing = this.state();
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }
    if (existing !== undefined) return { kind: "already-started", state: existing };

    const entries = entryNodesOf(this.plan);
    if (entries.length === 0) {
      return refused([
        {
          code: "no-entry-node",
          message:
            "outcome-runtime: plan revision " +
            this.planRevision +
            " declares no entry node — every node is the target of a non-loop edge, so " +
            "there is no node a run could start from",
        },
      ]);
    }

    const entryIds = new Set(entries.map((node) => node.id));
    const nodes: OutcomeNodeState[] = [];
    const dispatched: OutcomeDispatchRequest[] = [];
    let attemptSeq = 0;
    for (const node of this.plan.nodes) {
      if (!entryIds.has(node.id)) {
        nodes.push(Object.freeze({ nodeId: node.id, status: "pending" as const }));
        continue;
      }
      attemptSeq += 1;
      const attemptId = node.id + "#" + attemptSeq;
      nodes.push(
        Object.freeze({
          nodeId: node.id,
          status: "dispatched" as const,
          attemptId,
          attemptSeq,
          dispatchedAt: at,
        }),
      );
      dispatched.push(
        this.dispatchRequestOf(node.id, attemptId, node.agent, node.prompt),
      );
    }
    const state: OutcomeGraphState = Object.freeze({
      bodyVersion: CURRENT_OUTCOME_STATE_BODY,
      graphId: this.graphId,
      planRevision: this.planRevision,
      phase: "executing" as const,
      nodes: Object.freeze(nodes),
      loopTraversals: Object.freeze({}),
      attemptSeq,
    });
    // ONE transaction for the starting snapshot. There is no acceptance to join
    // yet, and the entry dispatches are recorded in the state (attempt ids), so
    // `resume` reads them back as the armed set and reports each one; the seam
    // runs only after the commit.
    this.ledger.runInTransaction((tx) => {
      tx.writeGraphState(stateRecordOf(state, at));
    });
    for (const request of dispatched) this.dispatch(request);
    return { kind: "started", state, dispatched: Object.freeze(dispatched) };
  }

  /**
   * Submit one worker proposal and advance the graph on an accepted outcome.
   *
   * The execution identity is derived from the runtime's own context: the plan
   * names the graph, the state names the attempt, and the proposal's canonical
   * digest names the submission. A refusal or a rejected gate writes no state
   * change; an accepted outcome's state write, receipt, accepted event and
   * pending effects share ONE transaction.
   */
  submit(proposal: unknown, now?: number): OutcomeSubmissionResult {
    const at = this.readClock(now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.protocolRefusal();
    if (unavailable !== undefined) return refused([unavailable]);

    let record: GraphStateRecord | undefined;
    try {
      record = this.ledger.readGraphState(this.graphId);
    } catch (error) {
      return refused([this.ledgerRefusal(error)]);
    }
    if (record === undefined) {
      return refused([
        {
          code: "graph-not-started",
          path: "$.graphId",
          message:
            "outcome-runtime: graph " +
            JSON.stringify(this.graphId) +
            " has written no state snapshot, so it has no attempt for this submission to " +
            "belong to — call start() first",
        },
      ]);
    }
    let state: OutcomeGraphState;
    try {
      state = readOutcomeGraphState(record, this.plan);
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }

    const identity = this.identityFor(proposal, state);
    if ("refusal" in identity) return refused([identity.refusal]);

    let planned: OutcomeAdvance | undefined;
    const join: AcceptanceJoin = (tx, decision) => {
      const joined = this.reduceInTransaction(tx, decision, at);
      planned = joined.advance;
      return joined.result;
    };

    let result: SubmissionResult;
    try {
      result = submitOutcome(
        {
          plan: this.plan,
          ledger: this.ledger,
          submittedPlanRevision: this.planRevision,
          identity,
          proposal,
          validators: this.validators,
          artifactRoot: this.artifactRoot,
          effects: [],
          now: at,
        },
        join,
      );
    } catch (error) {
      // A reducer rule violation rolls the transaction back and is reported as
      // the structured refusal it is. A storage failure is NOT swallowed: the
      // transaction has already rolled back, and the caller must see that the
      // state could not be stored rather than a benign-looking refusal.
      if (error instanceof OutcomeAdvanceRefusedError) {
        return refused([{ code: error.code, message: error.message }]);
      }
      if (error instanceof OutcomeStateError) {
        return refused([this.stateRefusal(error)]);
      }
      throw error;
    }

    if (result.kind === "refused") {
      return {
        kind: "refused",
        refusals: result.refusals.map(toRuntimeRefusal),
      };
    }
    const { decision, verdict } = result;
    if (verdict.kind === "conflict" || verdict.kind === "settled") {
      return { kind: "not-committed", decision, verdict };
    }
    if (decision.kind === "rejected") {
      return { kind: "rejected", decision, receipt: verdict.receipt };
    }

    const committed = verdict.kind === "committed";
    const dispatched =
      committed && planned !== undefined
        ? planned.dispatches.map((intent) => this.requestOf(intent))
        : [];
    // After a commit the PERSISTED state is authoritative. A read failure here
    // must not turn a committed acceptance into a thrown error, so the advance
    // the join computed is the fallback.
    let persisted = planned === undefined ? state : planned.state;
    if (committed) {
      try {
        persisted = this.state() ?? persisted;
      } catch {
        // Keep the state the transaction just wrote.
      }
    }
    for (const request of dispatched) this.dispatch(request);
    return {
      kind: "accepted",
      decision,
      receipt: verdict.receipt,
      state: persisted,
      dispatched: Object.freeze(dispatched),
      replayed: !committed,
    };
  }

  /**
   * Continue this graph from its PERSISTED state — the restart-recovery entry
   * point (C3c).
   *
   * `start()` answers "begin this plan"; `submit()` answers "here is an
   * outcome"; this answers "this process died — pick the run up from what is
   * durably true", and it is the ONLY entry point that may do so. It:
   *
   * 1. reads the state from the LEDGER (never from a caller, never from a
   *    fresh plan-derived default) and refuses a record bound to another graph
   *    or another plan revision;
   * 2. LAUNCHES every `pending` dispatch effect whose node the state records
   *    as dispatched on exactly that attempt — the crash-after-commit-before-
   *    launch window — after durably marking it `started`;
   * 3. reports every effect still `pending` or `started` afterwards, so a
   *    `started` effect a dead process left behind is never dropped and never
   *    silently re-run;
   * 4. reports every node the state records as in flight ("armed") with the
   *    attempt a submission must settle.
   *
   * IDEMPOTENT. Nothing here re-applies a state: the only write is the effect
   * status transition, and it moves `pending -> started` before the seam runs,
   * so a second call finds the effect `started`, launches nothing, and reports
   * the same ledger rows.
   *
   * NEVER STARTS FROM SCRATCH WHEN A STATE EXISTS. A state that cannot be read,
   * or that is bound to another revision, is a REFUSAL — never a fresh run and
   * never a rewritten record. Only a graph with NO state at all is started, and
   * it is started from this runtime's plan (the saved one).
   */
  resume(now?: number): OutcomeResumeResult {
    const at = this.readClock(now);
    if (typeof at !== "number") return refused([at]);
    const unavailable = this.protocolRefusal();
    if (unavailable !== undefined) return refused([unavailable]);

    let record: GraphStateRecord | undefined;
    try {
      record = this.ledger.readGraphState(this.graphId);
    } catch (error) {
      return refused([this.ledgerRefusal(error)]);
    }

    if (record === undefined) {
      // FIRST EXECUTION. No state has ever been written for this graph, so the
      // run begins from the SAVED plan — the same plan a later recovery reads
      // back and continues (the review's D5), not a second interpretation of
      // it. A concurrent process that started the graph between the read above
      // and this write makes start() answer `already-started`; that state is
      // then resumed below instead of being reported as a fresh start.
      const started = this.start(at);
      if (started.kind === "refused") return started;
      if (started.kind === "started") {
        const effects = this.unsettledEffectReading();
        if ("code" in effects) return refused([effects]);
        return {
          kind: "started",
          state: started.state,
          dispatched: started.dispatched,
          armed: armedNodesOf(started.state),
          unsettledEffects: effects,
          refusals: Object.freeze([]),
        };
      }
      try {
        record = this.ledger.readGraphState(this.graphId);
      } catch (error) {
        return refused([this.ledgerRefusal(error)]);
      }
      if (record === undefined) {
        return refused([
          {
            code: "unreadable-state",
            message:
              "outcome-runtime: graph " +
              JSON.stringify(this.graphId) +
              " was reported already started, but the ledger holds no state snapshot for it — " +
              "refusing to guess which state to continue",
          },
        ]);
      }
    }

    // The state belongs to THIS graph before it is read as this plan's state:
    // a record for another graph is a different, nameable disagreement than a
    // record bound to another revision of this one.
    if (record.graphId !== this.graphId) {
      return refused([
        {
          code: "graph-mismatch",
          path: "$.graphId",
          message:
            "outcome-runtime: the persisted state of " +
            JSON.stringify(record.graphId) +
            " was read for graph " +
            JSON.stringify(this.graphId) +
            " — the state names a different graph, so nothing was resumed",
        },
      ]);
    }

    let state: OutcomeGraphState;
    try {
      state = readOutcomeGraphState(record, this.plan);
    } catch (error) {
      return refused([this.stateRefusal(error)]);
    }

    const launched = this.launchUnsettledDispatches(state);
    if ("refusal" in launched) return refused([launched.refusal]);
    const effects = this.unsettledEffectReading();
    if ("code" in effects) return refused([effects]);
    return {
      kind: "resumed",
      state,
      dispatched: Object.freeze(launched.launched),
      armed: armedNodesOf(state),
      unsettledEffects: effects,
      refusals: Object.freeze(launched.refusals),
    };
  }

  /**
   * The persisted state of this graph, or `undefined` when it never started.
   *
   * Throws an {@link OutcomeStateError} for a snapshot this build cannot read —
   * a state that cannot be read is never silently replaced by a fresh one.
   */
  state(): OutcomeGraphState | undefined {
    const record = this.ledger.readGraphState(this.graphId);
    if (record === undefined) return undefined;
    return readOutcomeGraphState(record, this.plan);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Resolve the clock input, refusing a value that is not epoch milliseconds. */
  private readClock(
    override: number | undefined,
  ): number | OutcomeRuntimeRefusal {
    const at = override ?? this.clock();
    if (!Number.isSafeInteger(at)) {
      return {
        code: "invalid-timestamp",
        path: "$.now",
        message:
          "outcome-runtime: now is " +
          describeValue(at) +
          ", not epoch milliseconds — time is an explicit input and the receipt records " +
          "exactly the value this call was given",
      };
    }
    return at;
  }

  /**
   * Check that the REGISTERED outcome handler really owns this protocol.
   *
   * The handler is read as a CAPABILITY, never as a number: it must be an
   * outcome handler whose completion source is the accepted-outcome submission
   * and whose legacy completion is unreachable. A build without that handler
   * refuses to run rather than fall back to signal semantics.
   */
  private protocolRefusal(): OutcomeRuntimeRefusal | undefined {
    const verdict = classifyExecutionProtocol(
      OUTCOME_PROTOCOL,
      this.protocols ?? DEFAULT_EXECUTION_PROTOCOL_REGISTRY,
    );
    if (verdict.kind === "invalid") {
      return {
        code: "protocol-unavailable",
        message:
          "outcome-runtime: protocol " +
          OUTCOME_PROTOCOL +
          " is not a legal execution-protocol identifier (" +
          describeValue(verdict.value) +
          ")",
      };
    }
    if (verdict.kind === "unsupported") {
      return {
        code: "protocol-unavailable",
        message:
          "outcome-runtime: no execution-protocol handler is registered for protocol " +
          OUTCOME_PROTOCOL +
          " — a declared graph is never run under legacy rules",
      };
    }
    if (!isOutcomeProtocolHandler(verdict.handler)) {
      return {
        code: "protocol-unavailable",
        message:
          "outcome-runtime: the handler registered for protocol " +
          OUTCOME_PROTOCOL +
          " is not an outcome-protocol handler — its capability surface is not the accepted " +
          "outcome submission, so this runtime refuses to run the graph",
      };
    }
    if (
      verdict.handler.completion !== "accepted-outcome-submission" ||
      verdict.handler.legacyCompletion !== "unreachable"
    ) {
      return {
        code: "protocol-unavailable",
        message:
          "outcome-runtime: the handler registered for protocol " +
          OUTCOME_PROTOCOL +
          " does not declare the accepted-outcome submission as its ONLY completion source " +
          "with legacy completion unreachable — refusing to run",
      };
    }
    return undefined;
  }

  /**
   * Launch the unsettled dispatch effects the STATE corroborates (C3c resume).
   *
   * Only a `pending` effect is a launch: the acceptance committed it and no
   * process has begun it. `started` is deliberately NOT launched — a dead
   * process began that work, and the protocol's answer to the
   * crash-after-launch window is reconciliation by the effect's stable id, not
   * a second launch; the row is reported as unsettled instead.
   *
   * The transition to `started` is written BEFORE the seam runs. That ordering
   * is what makes a resume idempotent: a crash between the write and the launch
   * leaves a `started` row the next recovery REPORTS rather than re-launches.
   * The STATE is the authority on the arm set — an effect the state does not
   * corroborate (wrong node, wrong attempt, node not dispatched) is never
   * launched and is reported as a refusal; it stays unsettled.
   */
  private launchUnsettledDispatches(state: OutcomeGraphState):
    | {
        readonly launched: readonly OutcomeDispatchRequest[];
        readonly refusals: readonly OutcomeRuntimeRefusal[];
      }
    | { readonly refusal: OutcomeRuntimeRefusal } {
    let effects: readonly PendingEffectRecord[];
    try {
      effects = this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return { refusal: this.ledgerRefusal(error) };
    }
    const launched: OutcomeDispatchRequest[] = [];
    const refusals: OutcomeRuntimeRefusal[] = [];
    for (const effect of effects) {
      if (effect.kind !== "dispatch" || effect.status !== "pending") continue;
      const reading = readDispatchRequest(
        effect.payload,
        this.graphId,
        this.planRevision,
      );
      if (reading.kind === "malformed") {
        refusals.push({
          code: "malformed-effect",
          path: "$.payload",
          message: reading.message,
        });
        continue;
      }
      const armed = armedNodeOf(state, reading.request.nodeId);
      if (armed === undefined || armed.attemptId !== reading.request.attemptId) {
        refusals.push({
          code: "state-ledger-disagreement",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " names node " +
            JSON.stringify(reading.request.nodeId) +
            " on attempt " +
            JSON.stringify(reading.request.attemptId) +
            ", but the persisted state does not record that attempt as in flight — " +
            "the effect was not launched and stays unsettled",
        });
        continue;
      }
      const transition = this.ledger.markEffectStarted(this.graphId, effect.effectId);
      if (transition.kind === "missing" || transition.kind === "refused") {
        refusals.push({
          code: "state-ledger-disagreement",
          path: "$.effectId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " could not be marked started (" +
            transition.reason +
            ") — it was not launched and stays unsettled",
        });
        continue;
      }
      try {
        this.dispatch(reading.request);
      } catch (error) {
        refusals.push({
          code: "dispatch-failed",
          path: "$.effectId",
          message:
            "outcome-runtime: the dispatch seam threw while launching effect " +
            JSON.stringify(effect.effectId) +
            " (" +
            errorText(error) +
            ") — the effect is durably 'started' and is reported as unsettled rather " +
            "than silently re-launched or dropped",
        });
        continue;
      }
      launched.push(reading.request);
    }
    return {
      launched: Object.freeze(launched),
      refusals: Object.freeze(refusals),
    };
  }

  /**
   * Every effect the ledger still holds UNSETTLED (`pending` or `started`), or
   * a refusal when the ledger cannot answer.
   *
   * This is the reporting half of recovery: a `started` row a dead process
   * left behind is surfaced here, exactly as a `pending` row that could not be
   * launched is. Neither is ever dropped, and neither is silently rewound.
   */
  private unsettledEffectReading():
    | readonly PendingEffectRecord[]
    | OutcomeRuntimeRefusal {
    try {
      return this.ledger.pendingEffects(this.graphId);
    } catch (error) {
      return this.ledgerRefusal(error);
    }
  }
  /**
   * Derive the trusted execution identity of one submission.
   *
   * A well-formed proposal is bound to the attempt the STATE holds for its node;
   * a malformed one carries a placeholder identity so the acceptance core — the
   * owner of the proposal shape gate — refuses it with its own diagnostics.
   */
  private identityFor(
    proposal: unknown,
    state: OutcomeGraphState,
  ): ExecutionIdentity | { readonly refusal: OutcomeRuntimeRefusal } {
    const reading = readOutcomeProposal(proposal);
    if (reading.kind === "malformed") {
      return {
        graphId: this.graphId,
        attemptId: "unclaimed-attempt",
        submissionId: "unclaimed-submission",
      };
    }
    const index = this.plan.nodes.findIndex(
      (node) => node.id === reading.proposal.nodeId,
    );
    if (index < 0) {
      return {
        refusal: {
          code: "unknown-node",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " is not declared by plan revision " +
            this.planRevision +
            " — an outcome can only be claimed on a node the compiled plan declares",
        },
      };
    }
    const nodeState = state.nodes[index];
    if (nodeState.status === "pending") {
      return {
        refusal: {
          code: "node-not-dispatched",
          path: "$.nodeId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " has no attempt in flight, so no outcome can settle one — nothing was written",
        },
      };
    }
    const attemptId = nodeState.attemptId;
    if (attemptId === undefined) {
      return {
        refusal: {
          code: "unreadable-state",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " is " +
            nodeState.status +
            " but carries no attempt id",
        },
      };
    }
    return {
      graphId: this.graphId,
      attemptId,
      submissionId: submissionIdOf(proposal),
    };
  }

  /**
   * Reduce one ACCEPTED decision inside the acceptance transaction.
   *
   * The state is re-read from the TRANSACTION (not from the runtime's earlier
   * read), so the transition is a function of the rows the acceptance is
   * actually committing against. An already-settled node means this submission
   * is a replay: the ledger re-decides it, and this join contributes nothing —
   * which is what keeps a repeated submission from advancing the state twice.
   */
  private reduceInTransaction(
    tx: AcceptanceLedgerTx,
    decision: AcceptanceDecision,
    now: number,
  ): JoinedReduction {
    const record = tx.readGraphState(this.graphId);
    if (record === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "state-ledger-disagreement",
        "outcome-runtime: the acceptance transaction sees no state snapshot for graph " +
          JSON.stringify(this.graphId) +
          " — nothing was applied",
      );
    }
    const current = readOutcomeGraphState(record, this.plan);
    const index = this.plan.nodes.findIndex(
      (node) => node.id === decision.nodeId,
    );
    const nodeState = index < 0 ? undefined : current.nodes[index];
    if (nodeState === undefined) {
      throw new OutcomeAdvanceRefusedError(
        "unknown-node",
        "outcome-runtime: the accepted decision names node " +
          JSON.stringify(decision.nodeId) +
          ", which the state does not carry — nothing was applied",
      );
    }
    if (nodeState.status === "settled") {
      const settled = tx
        .acceptedEvents(this.graphId)
        .some((event) => event.attemptId === decision.identity.attemptId);
      if (!settled) {
        throw new OutcomeAdvanceRefusedError(
          "state-ledger-disagreement",
          "outcome-runtime: node " +
            JSON.stringify(decision.nodeId) +
            " is settled in the state, but the ledger holds no accepted event for attempt " +
            JSON.stringify(decision.identity.attemptId) +
            " — refusing to advance on a state the ledger does not corroborate",
        );
      }
      return { result: {} };
    }
    const advance = advanceOutcomeGraph({
      plan: this.plan,
      state: current,
      decision,
      now,
    });
    const effects = advance.dispatches.map((intent) => ({
      effectId: "dispatch:" + intent.attemptId,
      kind: "dispatch",
      payload: this.requestOf(intent),
    }));
    return {
      result: {
        effects: Object.freeze(effects),
        settle: (writeTx) => {
          writeTx.writeGraphState(stateRecordOf(advance.state, now));
        },
      },
      advance,
    };
  }

  /** The dispatch request one reducer intent becomes, with runtime provenance. */
  private requestOf(intent: OutcomeDispatchIntent): OutcomeDispatchRequest {
    return this.dispatchRequestOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
    );
  }

  /** Build one dispatch request from the plan and the minted attempt. */
  private dispatchRequestOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
  ): OutcomeDispatchRequest {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
    });
  }

  /**
   * Map a state-reading failure onto the runtime's refusal vocabulary.
   *
   * A state the strict reader refuses for an IDENTITY disagreement (another
   * graph or another plan revision) is reported as exactly that — the message
   * names which one — while a body this build cannot read stays
   * `unreadable-state`. Collapsing both would hide the one recovery failure a
   * caller can actually act on (a state bound to a superseded plan revision).
   */
  private stateRefusal(error: unknown): OutcomeRuntimeRefusal {
    if (error instanceof OutcomeStateError) {
      if (error.problem === "state-plan-mismatch") {
        return { code: "plan-revision-mismatch", message: error.message };
      }
      if (error.problem === "unsupported-state-version") {
        return { code: "unsupported-state-version", message: error.message };
      }
      return { code: "unreadable-state", message: error.message };
    }
    return {
      code: "unreadable-state",
      message:
        "outcome-runtime: the persisted state of graph " +
        JSON.stringify(this.graphId) +
        " could not be read (" +
        errorText(error) +
        ")",
    };
  }

  /** Map a ledger read failure onto the runtime's refusal vocabulary. */
  private ledgerRefusal(error: unknown): OutcomeRuntimeRefusal {
    return {
      code: "unreadable-state",
      message:
        "outcome-runtime: the graph state of " +
        JSON.stringify(this.graphId) +
        " could not be read from the ledger (" +
        errorText(error) +
        ")",
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Every node the state records as in flight, with the attempt that must settle it. */
function armedNodesOf(state: OutcomeGraphState): readonly OutcomeArmedNode[] {
  const armed: OutcomeArmedNode[] = [];
  for (const node of state.nodes) {
    if (node.status !== "dispatched" || node.attemptId === undefined) continue;
    armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
  }
  return Object.freeze(armed);
}

/** The state's progress for one node, when that node is currently in flight. */
function armedNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeArmedNode | undefined {
  for (const node of state.nodes) {
    if (node.nodeId !== nodeId) continue;
    if (node.status !== "dispatched" || node.attemptId === undefined) return undefined;
    return Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId });
  }
  return undefined;
}

/** What reading a persisted dispatch-effect payload produced. */
type DispatchPayloadReading =
  | { readonly kind: "ok"; readonly request: OutcomeDispatchRequest }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read one dispatch effect's persisted payload as a dispatch request.
 *
 * The payload is JSON the ledger stored verbatim, so it is UNTRUSTED here
 * even though this runtime wrote it: the graph and plan revision it names must
 * be this runtime's own, every field must be a non-empty string, and anything
 * else is a malformed effect that is REPORTED rather than launched at a
 * guessed target.
 */
function readDispatchRequest(
  payload: unknown,
  graphId: string,
  planRevision: string,
): DispatchPayloadReading {
  if (!isRecord(payload)) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload is " +
        describeValue(payload) +
        ", not a dispatch request record",
    };
  }
  const namedGraph = nonEmptyString(payload.graphId);
  if (namedGraph !== graphId) {
    return {
      kind: "malformed",
      message:
        "dispatch request names graph " +
        describeValue(payload.graphId) +
        ", not " +
        JSON.stringify(graphId),
    };
  }
  const namedRevision = nonEmptyString(payload.planRevision);
  if (namedRevision !== planRevision) {
    return {
      kind: "malformed",
      message:
        "dispatch request names plan revision " +
        describeValue(payload.planRevision) +
        ", not " +
        JSON.stringify(planRevision),
    };
  }
  const nodeId = nonEmptyString(payload.nodeId);
  const attemptId = nonEmptyString(payload.attemptId);
  const agent = nonEmptyString(payload.agent);
  const prompt = nonEmptyString(payload.prompt);
  if (
    nodeId === undefined ||
    attemptId === undefined ||
    agent === undefined ||
    prompt === undefined
  ) {
    return {
      kind: "malformed",
      message:
        "a dispatch request carries a node, attempt, agent and prompt that are not all " +
        "non-empty strings",
    };
  }
  return {
    kind: "ok",
    request: Object.freeze({
      graphId,
      planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
    }),
  };
}

/** A non-empty string, or `undefined` — the dispatch payload's field rule. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * The submission id of one proposal: its canonical content digest.
 *
 * CONTENT-ADDRESSED on purpose. One logical submission is one proposal content
 * for one attempt, so a retried submission derives the SAME key and the ledger
 * replays the persisted decision instead of writing a second receipt. A
 * proposal that cannot be digested at all gets a placeholder key: the digest
 * failure is the acceptance core's refusal to report, and nothing is written
 * under either key.
 */
function submissionIdOf(proposal: unknown): string {
  const reading = readOutcomeProposal(proposal);
  if (reading.kind !== "ok") return "unclaimed-submission";
  try {
    return "submission:" + proposalDigest(reading.proposal);
  } catch {
    return "unrepresentable-submission";
  }
}

/** Build the refusal result for a list of refusals. */
function refused(refusals: readonly OutcomeRuntimeRefusal[]): {
  readonly kind: "refused";
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  return { kind: "refused", refusals };
}

/** Map an acceptance-core refusal onto the runtime's vocabulary verbatim. */
function toRuntimeRefusal(refusal: SubmissionRefusal): OutcomeRuntimeRefusal {
  return {
    code: refusal.code,
    message: refusal.message,
    ...(refusal.path === undefined ? {} : { path: refusal.path }),
  };
}

/** Describe a rejected value for a diagnostic without ever throwing. */
function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** The message of a caught value, without assuming it is an Error. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
