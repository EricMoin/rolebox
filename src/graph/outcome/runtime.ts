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
 * compiled plan's own `graphId`; the attempt id is resolved from the ATTEMPT
 * CREDENTIAL the runtime issued when that attempt was dispatched, matched
 * against the binding the persisted state records; the submission id is
 * content-addressed from the proposal's canonical digest. A worker that puts
 * `graphId`, `attemptId`, `submissionId` or a plan revision in its proposal
 * is refused by the shape gate as an unknown key, and nothing it supplies can
 * name — or overwrite — the execution its claim belongs to.
 *
 * AN ATTEMPT IS NAMED BY ITS CREDENTIAL, NEVER BY ITS NODE. Every attempt is
 * issued a high-entropy nonce at dispatch (`attempt-credential.ts`) and that
 * nonce is persisted on the attempt's own state entry together with its
 * binding. `submit` resolves the attempt FROM the credential before it looks
 * at any execution state: an unknown, tampered, superseded or other node's
 * credential is refused without ever consulting "the node's current attempt".
 * A late submission that still carries the credential of an attempt a loop
 * round has since superseded therefore cannot be re-bound to the newer attempt
 * — which is exactly the defect this rule exists to remove — and a repeated
 * submission of a still-recorded (settled) attempt keeps resolving to that
 * attempt, so the ledger replays its original receipt instead of settling a
 * second time.
 *
 * A DUPLICATE SUBMISSION IS A REPLAY, NOT A SECOND ADVANCE. The content-derived
 * submission id makes repeating the same proposal for the same attempt the SAME
 * logical submission, so the ledger replays the persisted receipt; the join
 * sees the node already settled, contributes no effects and no state write, and
 * the graph stays where the first acceptance put it.
 *
 * A SUCCESSOR IS ARMED BY ITS JOIN, ONCE. The reducer applies the plan's
 * declared fan-in before it dispatches anything: a convergence node is armed
 * only when every feeder its strategy requires has arrived (the arrivals are
 * persisted on the target's entry in the same transaction, so a restart decides
 * the join from the state), an unsatisfied join arms nothing at all, and a node
 * already in flight is never armed a second time — two feeders completing out
 * of order can no longer overwrite the attempt that is running. A feeder that
 * has been re-armed stops counting, so a later round cannot be satisfied by an
 * earlier round's arrival.
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
 * A HARD LIMIT ENDS THE RUN IN A DURABLE STOP. When an accepted outcome asks to
 * continue a declared loop past its `max_traversals` cap, the round is NOT taken:
 * the outcome stays accepted, its node settles, no successor is armed, and the
 * reducer writes the stop into the state the SAME transaction commits — so the
 * receipt, the accepted event and the reason the run ended cannot come apart in a
 * crash window. `phase` becomes `stopped` and a `stop` report is carried by the
 * accepted result; `resume` reports the persisted stop and launches NOTHING (a
 * stopped run is never re-dispatched, and its stop is never cleared), and an
 * outcome from any branch still recorded in flight is refused with
 * `graph-stopped` rather than settled into a run that has ended.
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
 * THE PLAN'S COMPLETION AUTHORIZATION IS A RUN PRECONDITION (D6). A plan body
 * that pins natural-completion authorizations was compiled against exact policy
 * revisions; `start`, `resume` and `submit` all corroborate every pinned ref
 * against the HOST-INSTALLED completion-policy capability BEFORE they read or
 * write anything. A missing capability is `completion-policy-unavailable`, a
 * missing id or revision is reported by name, and a revision installed with
 * different content is `completion-policy-digest-mismatch` — the plan's pinned
 * digest is the authority and is never re-bound. A plan that pins no
 * authorization needs no capability, so this gate changes nothing for it. The
 * natural-completion SETTLEMENT path itself is still deferred (the dispatch
 * completion bridge); what this slice fixes is that a plan whose authorization
 * this process cannot support never runs at all.
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
  bindingOf,
  commitSubmission,
  validateSubmission,
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
  describeOutcomeStop,
  entryNodesOf,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeAdvance,
  type OutcomeDispatchIntent,
  type OutcomeGraphState,
  type OutcomeNodeState,
  type OutcomeStop,
} from "./graph-state.ts";
import {
  projectProgress,
  type OutcomeLoopProgress,
  type ProgressProjection,
  type ProgressReport,
} from "./progress.ts";
import {
  RUNTIME_ATTEMPT_CREDENTIAL_SOURCE,
  attemptCredentialBinding,
  mintAttemptCredential,
  type AttemptCredentialSource,
} from "./attempt-credential.ts";
import {
  verifyCompletionPolicy,
  type CompletionPolicyRegistry,
} from "../policy/completion-policy.ts";
import { proposalDigest, readOutcomeProposal } from "./proposal.ts";
import type { ExecutionIdentity, ValidatorRegistry } from "./validators.ts";

// ── The dispatch seam ───────────────────────────────────────────────────────

/**
 * The provenance of one dispatch, WITHOUT the attempt credential.
 *
 * Every field is runtime provenance: the graph and plan revision the node
 * belongs to, the attempt id the STATE minted, and the plan's own agent/prompt.
 * Nothing here comes from a worker. This is also the shape the ledger persists
 * as a dispatch effect's payload — deliberately credential-free, so the
 * credential lives in exactly one durable place (the attempt's state entry) and
 * is re-bound from there at launch.
 */
export interface OutcomeDispatchTarget {
  readonly graphId: string;
  readonly planRevision: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;
}

/**
 * One node the runtime asks a dispatcher to run: the target plus the attempt
 * credential this worker must present when it submits.
 *
 * THE CREDENTIAL TRAVELS ONLY OVER THIS CHANNEL. It is handed to the dispatch
 * seam (and to nobody else): it is not in `graph_status`, not in the shared
 * `<graph_state>` block, not in the startup sweep's report, not in a receipt,
 * an accepted event or a dispatch-effect payload, and not in any log line this
 * module writes. The worker receives it here and passes it back through the
 * submission ingress; the store it is checked against is the runtime's own.
 */
export interface OutcomeDispatchRequest extends OutcomeDispatchTarget {
  /**
   * The bearer credential issued for this attempt. A capability, not an
   * identity: possession proves the holder was handed this attempt's
   * credential (or copied it); it does not prove the original worker is asking.
   */
  readonly credential: string;
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
  /**
   * The submission carries no attempt credential. The runtime never derives
   * one: without the credential there is no attempt this submission may settle.
   */
  | "credential-missing"
  /**
   * The credential names no attempt the persisted state records — it was never
   * issued here (a guess or a tampered value), or the attempt it was issued for
   * has since been superseded and its entry replaced. Refused WITHOUT falling
   * back to the node's current attempt.
   */
  | "credential-unknown"
  /**
   * The credential was issued for another node's recorded attempt. A credential
   * is bound to one node, so this is never re-aimed at the node it names.
   */
  | "credential-node-mismatch"
  /** The accepted outcome belongs to a different attempt than the state's. */
  | "attempt-mismatch"
  /** No edge routes a non-terminal outcome. */
  | "no-route"
  /** The route re-enters a settled node outside its declared loop group. */
  | "reentry-outside-loop"
  /**
   * The run is already STOPPED by a declared hard limit (body version 4), so
   * a submission for a node that is still recorded in flight is refused and
   * no settlement is fabricated for it. The stop itself is reported by
   * resume() and by the persisted state; it is never cleared.
   */
  | "graph-stopped"
  /** The state says an attempt settled and the ledger holds no such event. */
  | "state-ledger-disagreement"
  /**
   * The persisted record is bound to the outcome protocol but carries no
   * compiled plan (or no plan binding), so the run had nothing to resume FROM.
   * Recovery never guesses a plan: an absent one is reported, not recompiled.
   */
  | "missing-persisted-plan"
  /** A dispatch seam threw while launching an unsettled effect (C3c resume). */
  | "dispatch-failed"
  /**
   * The advance reached a loop group whose plan declares a progress policy, but
   * the projection bound to this submission was missing or belonged to another
   * proposal, attempt or plan revision. A declared comparison is never skipped,
   * so the acceptance is refused and nothing is written.
   */
  | "progress-unbound"
  /**
   * A declared progress policy governs this outcome and the submission did not
   * carry the declared comparison object. The field is REQUIRED, so the
   * submission is refused for repair (nothing is written) rather than measured
   * as "unknown": a missing field is the worker's to fix, while an incomparable
   * value is the data's own answer.
   */
  | "progress-subject-missing"
  /**
   * The plan declares a comparison semantics this build does not implement.
   * Refused by name instead of running the comparison under different semantics.
   */
  | "progress-evaluator-unavailable"
  /**
   * The plan pins at least one natural-completion authorization (D6), but this
   * runtime was given no completion-policy capability at all, so it cannot
   * corroborate an authorization the plan depends on. Nothing is started,
   * resumed or settled, and no state is written.
   */
  | "completion-policy-unavailable"
  /**
   * The policy id a plan's authorization pins is not installed in this
   * process. Reported by name instead of running under another policy: the
   * authorization the plan was compiled with is part of its semantics.
   */
  | "completion-policy-unknown"
  /** The pinned policy id is installed, but not at the pinned exact revision. */
  | "completion-policy-unknown-revision"
  /**
   * The pinned revision is installed with DIFFERENT content than the plan
   * authorized — a republished declaration, or a host that authorized
   * something else. The plan's pinned digest is the authority, so this is
   * refused rather than re-bound to the installed body.
   */
  | "completion-policy-digest-mismatch";

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
      /**
       * Present exactly when this acceptance STOPPED the run: a declared hard
       * limit or progress policy refused the continuation the outcome asked for,
       * so no successor was armed and `state.phase` is `stopped`. The outcome
       * itself is a real, accepted result — the stop is the run's ending, not a
       * fabricated settlement — and a repeated submission of it still replays
       * this receipt.
       */
      readonly stop?: OutcomeStop;
      /**
       * Every progress comparison THIS call made, in plan loop-group order.
       * Present only on a committed first settlement: a replay re-runs no
       * comparison and writes nothing, so it reports none. The report is
       * evidence (which group was compared, against what, and what it answered),
       * never a second source of truth — the persisted state is.
       */
      readonly progress?: readonly ProgressReport[];
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

/**
 * One node the persisted state records as in flight, awaiting an outcome.
 *
 * Deliberately CREDENTIAL-FREE: this is a report, not a dispatch channel. The
 * credential reaches the worker through {@link OutcomeDispatchRequest} (at
 * launch) and nowhere else, so a resumed-but-not-relaunched attempt does not
 * hand its capability to whoever reads the recovery report.
 */
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
 * - `armed` — every node the state records as dispatched ON AN ATTEMPT THAT
 *   CARRIES A CREDENTIAL, with its attempt, so a caller can see what is awaiting
 *   a submission even when nothing was launched (an entry dispatch recorded by
 *   `start()`, or work a dead process began). An in-flight attempt whose
 *   persisted entry carries no credential cannot be settled by any submission,
 *   so it is reported in `refusals` instead of being offered as armed. The
 *   credential itself is never part of this report.
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
      /**
       * Present exactly when the run this call continued is STOPPED (body
       * version 4): the persisted stop, with its reason and the round it hit.
       * A stopped run launches NOTHING and arms NOTHING — a second resume
       * reports the same stop, clears nothing and dispatches nothing. A
       * `started` answer cannot carry one: a first execution has nothing to
       * have stopped.
       */
      readonly stop?: OutcomeStop;
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
  /**
   * Mints the attempt credential every attempt this runtime dispatches is
   * issued. Defaults to {@link RUNTIME_ATTEMPT_CREDENTIAL_SOURCE} (the platform
   * CSPRNG); a test injects a deterministic source.
   */
  readonly mintCredential?: AttemptCredentialSource;
  /**
   * The HOST-INSTALLED completion-policy capability (D6).
   *
   * A plan whose body pins natural-completion authorizations depends on the
   * policy revisions it authorized; this runtime corroborates each pinned ref
   * against this registry before it starts, resumes or settles anything.
   * OMITTED is legal only for a plan that pins none: a plan that pins one is
   * refused with `completion-policy-unavailable`, because the authorization is
   * part of the run's declared semantics and this process cannot check it.
   */
  readonly completionPolicies?: CompletionPolicyRegistry;
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
  private readonly mintCredential: AttemptCredentialSource;
  private readonly completionPolicies: CompletionPolicyRegistry | undefined;

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
    this.mintCredential =
      options.mintCredential ?? RUNTIME_ATTEMPT_CREDENTIAL_SOURCE;
    this.completionPolicies = options.completionPolicies;
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
    // The plan's completion authorization is checked before ANY state is read
    // or written (D6), so a run this process cannot support is blocked with the
    // state preserved rather than started under weaker semantics.
    const unsupportedCompletion = this.completionCapabilityRefusal();
    if (unsupportedCompletion !== undefined) {
      return refused([unsupportedCompletion]);
    }

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

    // One progress entry per loop group whose plan declares a policy, so the
    // state's own record is complete from the first snapshot: a body that
    // carried entries only after the first continuation could not be told from
    // one whose baseline was lost. A group without a policy gets no entry.
    const loopProgress: Record<string, OutcomeLoopProgress> = {};
    for (const group of this.plan.loopGroups) {
      const policy = group.progress;
      if (policy === undefined) continue;
      loopProgress[group.id] = Object.freeze({
        loopGroupId: group.id,
        evaluator: policy.evaluator,
        version: policy.version,
        subject: policy.subject,
        unchanged: 0,
      });
    }

    const entryIds = new Set(entries.map((node) => node.id));
    const nodes: OutcomeNodeState[] = [];
    const dispatched: OutcomeDispatchRequest[] = [];
    let attemptSeq = 0;
    for (const node of this.plan.nodes) {
      if (!entryIds.has(node.id)) {
        // No node has settled yet, so every arrival list is empty — which is
        // exactly the canonical materialization of a state where nothing has
        // arrived, and what the reader verifies against.
        nodes.push(
          Object.freeze({
            nodeId: node.id,
            status: "pending" as const,
            arrivals: Object.freeze([]),
          }),
        );
        continue;
      }
      attemptSeq += 1;
      const attemptId = node.id + "#" + attemptSeq;
      // The credential is minted WITH the attempt and persisted on its entry in
      // the same transaction that records the dispatch: the binding a later
      // submission is checked against is the state's, not the submission's.
      const credential = mintAttemptCredential(
        this.mintCredential,
        attemptCredentialBinding({
          graphId: this.graphId,
          nodeId: node.id,
          attemptId,
          planRevision: this.planRevision,
        }),
      );
      nodes.push(
        Object.freeze({
          nodeId: node.id,
          status: "dispatched" as const,
          attemptId,
          attemptSeq,
          attemptCredential: credential,
          dispatchedAt: at,
          arrivals: Object.freeze([]),
        }),
      );
      dispatched.push(
        this.dispatchRequestOf(node.id, attemptId, node.agent, node.prompt, credential),
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
      loopProgress: Object.freeze(loopProgress),
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
    // The plan's completion authorization is checked before ANY state is read
    // or written (D6), so a run this process cannot support is blocked with the
    // state preserved rather than started under weaker semantics.
    const unsupportedCompletion = this.completionCapabilityRefusal();
    if (unsupportedCompletion !== undefined) {
      return refused([unsupportedCompletion]);
    }

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

    const submission = {
      plan: this.plan,
      ledger: this.ledger,
      submittedPlanRevision: this.planRevision,
      identity,
      proposal,
      validators: this.validators,
      artifactRoot: this.artifactRoot,
      effects: [],
      now: at,
    };

    // VALIDATION RUNS OUTSIDE THE TRANSACTION, and so does the progress
    // PROJECTION. The gates and the payload read happen here, before the
    // serialized commit opens; what the transaction does is recheck the binding,
    // compare the projection against the baseline it can see, and write the
    // counters with the acceptance. A rejected decision is reported as the
    // gate's own rejection: the projection gate applies to an accepted outcome,
    // so a worker repairs the failing gate first and is told about the declared
    // comparison object on the submission that would otherwise settle.
    const validation = validateSubmission(submission);
    let projections: readonly ProgressProjection[] = Object.freeze([]);
    if (validation.kind === "validated" && validation.decision.kind === "accepted") {
      const projected = this.progressProjections(proposal, identity);
      if ("refusal" in projected) return refused([projected.refusal]);
      projections = projected;
    }

    let planned: OutcomeAdvance | undefined;
    const join: AcceptanceJoin = (tx, decision) => {
      const joined = this.reduceInTransaction(tx, decision, at, projections);
      planned = joined.advance;
      return joined.result;
    };

    let result: SubmissionResult;
    try {
      result = commitSubmission({ ...submission, validation }, join);
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
    // The comparisons THIS call made. A replay re-runs none (the join is skipped
    // for an already-settled node) and writes nothing, so it reports none: the
    // persisted state is the authority, and a replay has already been reported.
    const progress = committed && planned !== undefined ? planned.progress : [];
    return {
      kind: "accepted",
      decision,
      receipt: verdict.receipt,
      state: persisted,
      dispatched: Object.freeze(dispatched),
      replayed: !committed,
      // The stop is reported from the state the transaction just committed (or,
      // for a replay, from the state it replayed against), never from a second
      // derivation: `state.stop` IS the durable stop.
      ...(persisted.stop === undefined ? {} : { stop: persisted.stop }),
      ...(progress.length === 0 ? {} : { progress }),
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
   * A STOPPED RUN IS REPORTED, NEVER CONTINUED. A state carrying a stop (body
   * version 4) short-circuits before any effect is read for launch: the call
   * reports the stop, dispatches nothing, arms nothing, and writes nothing at
   * all — so a second resume is idempotent by construction and the stop is never
   * cleared. The nodes still recorded in flight are reported as refused, with
   * the stop as the reason.
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
    // The plan's completion authorization is checked before ANY state is read
    // or written (D6), so a run this process cannot support is blocked with the
    // state preserved rather than started under weaker semantics.
    const unsupportedCompletion = this.completionCapabilityRefusal();
    if (unsupportedCompletion !== undefined) {
      return refused([unsupportedCompletion]);
    }

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
        const reading = armedReading(started.state);
        return {
          kind: "started",
          state: started.state,
          dispatched: started.dispatched,
          armed: reading.armed,
          unsettledEffects: effects,
          refusals: reading.refusals,
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

    // A STOPPED RUN IS REPORTED, NOT CONTINUED. Nothing is launched — not even a
    // `pending` effect the crash window left behind — and nothing is offered as
    // armed, because no submission can settle anything once the run has stopped.
    // Reading and reporting are the only things this call does, so a second
    // resume reports the same stop and dispatches nothing (the `started` effect
    // bookkeeping below is what would otherwise move a row).
    if (state.stop !== undefined) {
      const effects = this.unsettledEffectReading();
      if ("code" in effects) return refused([effects]);
      return {
        kind: "resumed",
        state,
        dispatched: Object.freeze([]),
        armed: Object.freeze([]),
        unsettledEffects: effects,
        refusals: stoppedInFlightRefusals(state),
        stop: state.stop,
      };
    }

    const launched = this.launchUnsettledDispatches(state);
    if ("refusal" in launched) return refused([launched.refusal]);
    const effects = this.unsettledEffectReading();
    if ("code" in effects) return refused([effects]);
    // The armed report is credential-free by construction; an in-flight attempt
    // the state cannot corroborate with a credential is reported as refused.
    const readable = armedReading(state);
    return {
      kind: "resumed",
      state,
      dispatched: Object.freeze(launched.launched),
      armed: readable.armed,
      unsettledEffects: effects,
      refusals: Object.freeze([...launched.refusals, ...readable.refusals]),
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
   * Check that this runtime can corroborate every completion authorization the
   * plan pins (D6).
   *
   * THE PLAN'S AUTHORIZATION IS PART OF THE RUN'S SEMANTICS. A plan whose body
   * pins natural-completion authorizations was compiled against exact,
   * content-addressed policy revisions; this runtime only runs it when the
   * HOST-INSTALLED capability still resolves each pinned ref to the SAME
   * content. The pinned digest is the authority — an installed revision with
   * different content is `completion-policy-digest-mismatch`, never a silent
   * re-binding — and a plan that pins none needs no capability at all.
   *
   * Refusing HERE, before any state is read or written, is what makes a
   * revocation or a missing policy an explicit BLOCK with the state preserved:
   * `start`, `resume` and `submit` all consult this first, so a run this
   * process cannot support does not advance one step under weaker semantics.
   */
  private completionCapabilityRefusal(): OutcomeRuntimeRefusal | undefined {
    const authorizations = this.plan.completionAuthorizations ?? [];
    if (authorizations.length === 0) return undefined;
    const registry = this.completionPolicies;
    if (registry === undefined) {
      return {
        code: "completion-policy-unavailable",
        path: "$.completionAuthorizations",
        message:
          "outcome-runtime: plan revision " +
          this.planRevision +
          " pins " +
          authorizations.length +
          " natural-completion authorization(s) (" +
          describeAuthorizations(authorizations) +
          "), but this runtime was given no completion-policy capability — the " +
          "authorization a plan was compiled with is part of its semantics, so nothing " +
          "was started, resumed or settled",
      };
    }
    for (const authorization of authorizations) {
      const verified = verifyCompletionPolicy(authorization.policy, registry);
      switch (verified.kind) {
        case "resolved":
          continue;
        case "unknown-policy":
          return {
            code: "completion-policy-unknown",
            path: "$.completionAuthorizations",
            message:
              "outcome-runtime: node " +
              JSON.stringify(authorization.nodeId) +
              " pins completion policy " +
              describePolicyRef(authorization.policy) +
              ", whose id is not installed in this process — the pinned revision is a " +
              "missing capability, never a hint to run under another policy",
          };
        case "unknown-revision":
          return {
            code: "completion-policy-unknown-revision",
            path: "$.completionAuthorizations",
            message:
              "outcome-runtime: node " +
              JSON.stringify(authorization.nodeId) +
              " pins completion policy " +
              describePolicyRef(authorization.policy) +
              ", whose exact revision is not installed in this process",
          };
        case "digest-mismatch":
          return {
            code: "completion-policy-digest-mismatch",
            path: "$.completionAuthorizations",
            message:
              "outcome-runtime: node " +
              JSON.stringify(authorization.nodeId) +
              " pins completion policy " +
              describePolicyRef(authorization.policy) +
              " at digest " +
              authorization.policy.digest +
              ", but the installed declaration hashes to " +
              verified.actual +
              " — the plan's pinned content is the authority and it is never re-bound " +
              "to a republished revision",
          };
      }
    }
    return undefined;
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
      const target = reading.target;
      const armed = dispatchedNodeOf(state, target.nodeId);
      if (armed === undefined || armed.attemptId !== target.attemptId) {
        refusals.push({
          code: "state-ledger-disagreement",
          path: "$.attemptId",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " names node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state does not record that attempt as in flight — " +
            "the effect was not launched and stays unsettled",
        });
        continue;
      }
      // THE BINDING IS READ FROM THE PERSISTED STATE, NOT FROM THE EFFECT. The
      // payload is credential-free on purpose, so the credential a recovered
      // worker receives is the one the attempt's own state entry records — and
      // an attempt whose entry carries none (a body version that predates
      // credentials) is REFUSED rather than launched without one or granted a
      // fresh credential for a new execution.
      const credential = armed.attemptCredential;
      if (credential === undefined) {
        refusals.push({
          code: "credential-missing",
          path: "$.attemptCredential",
          message:
            "outcome-runtime: dispatch effect " +
            JSON.stringify(effect.effectId) +
            " targets node " +
            JSON.stringify(target.nodeId) +
            " on attempt " +
            JSON.stringify(target.attemptId) +
            ", but the persisted state entry for that attempt carries no attempt credential — " +
            "an attempt the runtime cannot hand a credential to is never launched, and it " +
            "stays unsettled",
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
        this.dispatch(this.dispatchRequestOf(
          target.nodeId,
          target.attemptId,
          target.agent,
          target.prompt,
          credential,
        ));
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
      launched.push(
        this.dispatchRequestOf(
          target.nodeId,
          target.attemptId,
          target.agent,
          target.prompt,
          credential,
        ),
      );
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
   * THE ORDER IS THE RULE: the credential is resolved against the persisted
   * state FIRST, and only the attempt it names is then handed to the acceptance
   * core. The node's CURRENT attempt is never consulted as a fallback — a
   * credential that names nothing, or names another node's attempt, is refused
   * outright, so a late submission cannot be re-bound to a newer attempt and a
   * crafted credential cannot select one. A well-formed proposal whose
   * credential resolves is bound to that recorded attempt (dispatched or
   * settled — a settled one is the replay path); a malformed one carries a
   * placeholder identity so the acceptance core — the owner of the proposal
   * shape gate — refuses it with its own diagnostics.
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
    const credential = reading.proposal.credential;
    if (credential === undefined) {
      return {
        refusal: {
          code: "credential-missing",
          path: "$.credential",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " was submitted without the attempt credential it was dispatched with — an outcome " +
            "is settled BY the attempt that holds the credential, and this runtime never " +
            "derives one from the node id; nothing was written",
        },
      };
    }
    // Resolve the attempt the credential was ISSUED for. The scan is over the
    // persisted binding (the nonce written on one attempt's entry); it is never
    // an index into the node the proposal happens to name.
    let holder: OutcomeNodeState | undefined;
    for (const node of state.nodes) {
      if (node.attemptCredential === credential) {
        holder = node;
        break;
      }
    }
    if (holder === undefined) {
      return {
        refusal: {
          code: "credential-unknown",
          path: "$.credential",
          message:
            "outcome-runtime: the credential on this submission is not recorded by any attempt " +
            "of graph " +
            JSON.stringify(this.graphId) +
            " — it was never issued here, or the attempt it was issued for has since been " +
            "superseded (a body version that predates attempt credentials records none at " +
            "all); the node's CURRENT attempt is never substituted for it, so nothing was written",
        },
      };
    }
    if (holder.nodeId !== reading.proposal.nodeId) {
      return {
        refusal: {
          code: "credential-node-mismatch",
          path: "$.credential",
          message:
            "outcome-runtime: the credential was issued for node " +
            JSON.stringify(holder.nodeId) +
            ", but this submission claims node " +
            JSON.stringify(reading.proposal.nodeId) +
            " — a credential is bound to one node, and it is never re-aimed at another",
        },
      };
    }
    const attemptId = holder.attemptId;
    if (attemptId === undefined) {
      return {
        refusal: {
          code: "unreadable-state",
          path: "$.nodes[" + index + "].attemptId",
          message:
            "outcome-runtime: node " +
            JSON.stringify(reading.proposal.nodeId) +
            " records a credential on a " +
            holder.status +
            " entry but carries no attempt id — the binding cannot be resolved",
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
    progress: readonly ProgressProjection[],
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
      mintCredential: this.mintCredential,
      progress,
    });
    const effects = advance.dispatches.map((intent) => ({
      effectId: "dispatch:" + intent.attemptId,
      kind: "dispatch",
      // CREDENTIAL-FREE payload: the durable effect names the dispatch target
      // and nothing else, so the credential stays in exactly one durable place
      // (the attempt's state entry) and is re-bound from there at launch.
      payload: this.dispatchPayloadOf(intent),
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

  /**
   * Measure one submission against every declared progress policy that governs
   * it — OUTSIDE the acceptance transaction.
   *
   * The projection reads the worker payload exactly ONCE and reduces the declared
   * comparison object to a bounded token (or to a bounded marker saying why it
   * cannot be compared), bound to this proposal digest, attempt, plan revision and
   * the validation the submission is about to be judged by. The raw payload never
   * travels further: the transaction compares a token, and what it persists is the
   * baseline and the counters.
   *
   * A group is projected only when the DECLARED POLICY governs this submission —
   * the group declares this outcome as its continuation and this node as a member.
   * An outcome that exits the loop, or terminates its node, is never measured and
   * never refused for a missing subject. A projection refusal is returned as the
   * runtime refusal it is (nothing is written), and an unreadable or
   * unrepresentable proposal yields no projections because the acceptance core
   * refuses those by name.
   */
  private progressProjections(
    proposal: unknown,
    identity: ExecutionIdentity,
  ): readonly ProgressProjection[] | { readonly refusal: OutcomeRuntimeRefusal } {
    const reading = readOutcomeProposal(proposal);
    if (reading.kind !== "ok") return Object.freeze([]);
    const { nodeId, outcomeId, data } = reading.proposal;
    const groups = this.plan.loopGroups.filter(
      (group) =>
        group.progress !== undefined &&
        group.continuationOutcome === outcomeId &&
        group.nodes.includes(nodeId),
    );
    if (groups.length === 0) return Object.freeze([]);
    let digest: string;
    try {
      digest = proposalDigest(reading.proposal);
    } catch {
      // Unrepresentable payloads have no content address, so there is no binding
      // to measure against; the acceptance core refuses that submission by name.
      return Object.freeze([]);
    }
    const binding = bindingOf(identity, this.planRevision, digest);
    const projections: ProgressProjection[] = [];
    for (const group of groups) {
      const policy = group.progress;
      if (policy === undefined) continue;
      const projected = projectProgress({
        binding,
        loopGroupId: group.id,
        nodeId,
        outcomeId,
        policy,
        data,
      });
      if (projected.kind === "refused") {
        const first = projected.refusals[0];
        return {
          refusal: {
            code: first.code,
            message: first.message,
            ...(first.path === undefined ? {} : { path: first.path }),
          },
        };
      }
      projections.push(projected.projection);
    }
    return Object.freeze(projections);
  }

  /**
   * The dispatch request one reducer intent becomes: runtime provenance plus the
   * credential the reducer minted for this attempt.
   */
  private requestOf(intent: OutcomeDispatchIntent): OutcomeDispatchRequest {
    return this.dispatchRequestOf(
      intent.nodeId,
      intent.attemptId,
      intent.agent,
      intent.prompt,
      intent.credential,
    );
  }

  /** The credential-free payload one reducer intent is persisted as. */
  private dispatchPayloadOf(
    intent: OutcomeDispatchIntent,
  ): OutcomeDispatchTarget {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId: intent.nodeId,
      attemptId: intent.attemptId,
      agent: intent.agent,
      prompt: intent.prompt,
    });
  }

  /** Build one dispatch target/request from the plan and the minted attempt. */
  private dispatchRequestOf(
    nodeId: string,
    attemptId: string,
    agent: string,
    prompt: string,
    credential: string,
  ): OutcomeDispatchRequest {
    return Object.freeze({
      graphId: this.graphId,
      planRevision: this.planRevision,
      nodeId,
      attemptId,
      agent,
      prompt,
      credential,
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

/**
 * Every in-flight attempt a submission can actually settle, plus a per-attempt
 * refusal for each in-flight attempt it cannot.
 *
 * An attempt whose persisted entry carries no credential (a body version that
 * predates credentials) is NOT reported as armed: recovery must refuse it, not
 * offer it as a node awaiting an outcome, because no submission can ever settle
 * it. It is reported in `refusals` instead, with the field that is missing.
 *
 * The credential ITSELF is never part of either report — the armed entry names
 * the node and attempt only, so a recovery report never becomes a second
 * distribution channel for the capability.
 */
function armedReading(state: OutcomeGraphState): {
  readonly armed: readonly OutcomeArmedNode[];
  readonly refusals: readonly OutcomeRuntimeRefusal[];
} {
  const armed: OutcomeArmedNode[] = [];
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched" || node.attemptId === undefined) return;
    if (node.attemptCredential === undefined) {
      refusals.push({
        code: "credential-missing",
        path: "$.nodes[" + index + "].attemptCredential",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is recorded as in flight on attempt " +
          JSON.stringify(node.attemptId) +
          " but its persisted state entry carries no attempt credential — the attempt was " +
          "dispatched by a body version that issues none, so no submission can settle it and " +
          "it is reported as refused rather than armed",
      });
      return;
    }
    armed.push(Object.freeze({ nodeId: node.nodeId, attemptId: node.attemptId }));
  });
  return {
    armed: Object.freeze(armed),
    refusals: Object.freeze(refusals),
  };
}

/**
 * What a STOPPED run reports for the nodes still recorded in flight.
 *
 * Every one of them is a refusal, never an "armed" entry: `armed` promises that
 * a submission can settle the attempt, and on a stopped run no submission can —
 * the run path refuses it with the same `graph-stopped` code. The nodes are NOT
 * settled and NOT dropped: no outcome settled them, so fabricating a settlement
 * would invent a result, and the entries stay exactly as the stop left them.
 * Credential-free by construction, like every other report here.
 */
function stoppedInFlightRefusals(
  state: OutcomeGraphState,
): readonly OutcomeRuntimeRefusal[] {
  const stop = state.stop;
  if (stop === undefined) return Object.freeze([]);
  const refusals: OutcomeRuntimeRefusal[] = [];
  state.nodes.forEach((node, index) => {
    if (node.status !== "dispatched") return;
    refusals.push(
      Object.freeze({
        code: "graph-stopped" as const,
        path: "$.nodes[" + index + "].status",
        message:
          "outcome-runtime: node " +
          JSON.stringify(node.nodeId) +
          " is still recorded in flight" +
          (node.attemptId === undefined ? "" : " on attempt " + JSON.stringify(node.attemptId)) +
          ", but graph " +
          JSON.stringify(state.graphId) +
          " STOPPED (" +
          stop.reason + ": " + describeOutcomeStop(stop) +
          ") — a stopped run dispatches nothing and no submission can settle this attempt, " +
          "so it is reported as refused rather than armed",
      }),
    );
  });
  return Object.freeze(refusals);
}

/** The state's progress for one node, when that node is currently in flight. */
function dispatchedNodeOf(
  state: OutcomeGraphState,
  nodeId: string,
): OutcomeNodeState | undefined {
  for (const node of state.nodes) {
    if (node.nodeId !== nodeId) continue;
    return node.status === "dispatched" ? node : undefined;
  }
  return undefined;
}

/** What reading a persisted dispatch-effect payload produced. */
type DispatchPayloadReading =
  | { readonly kind: "ok"; readonly target: OutcomeDispatchTarget }
  | { readonly kind: "malformed"; readonly message: string };

/**
 * Read one dispatch effect's persisted payload as a dispatch TARGET.
 *
 * The payload is JSON the ledger stored verbatim, so it is UNTRUSTED here
 * even though this runtime wrote it: the graph and plan revision it names must
 * be this runtime's own, every field must be a non-empty string, and anything
 * else is a malformed effect that is REPORTED rather than launched at a
 * guessed target. A payload that carries a `credential` key is malformed too:
 * the credential is never persisted on an effect, so one there means the row
 * was written by something that is not this runtime.
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
  if (payload.credential !== undefined) {
    return {
      kind: "malformed",
      message:
        "a dispatch effect payload carries a credential — this runtime never persists one on an " +
        "effect, so the row was not written by this runtime and is not launched",
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
    target: Object.freeze({
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

/** A pinned completion-policy ref as a diagnostic token: `"id"@"revision"`. */
function describePolicyRef(ref: {
  readonly id: string;
  readonly revision: string;
}): string {
  return JSON.stringify(ref.id) + "@" + JSON.stringify(ref.revision);
}

/** The pinned authorizations of a plan, for a diagnostic that must not throw. */
function describeAuthorizations(
  authorizations: readonly {
    readonly nodeId: string;
    readonly outcome: string;
    readonly policy: { readonly id: string; readonly revision: string };
  }[],
): string {
  return authorizations
    .map(
      (entry) =>
        entry.nodeId +
        "->" +
        entry.outcome +
        " by " +
        describePolicyRef(entry.policy),
    )
    .join(", ");
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
