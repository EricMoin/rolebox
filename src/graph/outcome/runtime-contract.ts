/** Public runtime requests, results and host capability ports. */
import type { CompiledPlan } from "../compiler/plan.ts";
import {
  buildBudgetReport, type BudgetReport,
  type BudgetReportNode,
  type BudgetUsageAmounts
} from "../domain/budget.ts";
import type {
  AcceptanceLedger, PendingEffectRecord,
  ReceiptRecord,
  RunControlRecord
} from "../ledger/types.ts";
import {
  type ExecutionProtocolRegistry
} from "../protocol/execution-protocol.ts";
import {
  type AcceptanceDecision, type SubmissionRefusalCode,
  type SubmissionResult
} from "./acceptance.ts";
import {
  type OutcomeGraphState, type OutcomeStop
} from "./graph-state.ts";
import {
  type ProgressReport
} from "./progress.ts";
import {
  RUNTIME_ATTEMPT_CREDENTIAL_SOURCE, type AttemptCredentialSource
} from "./attempt-credential.ts";
import {
  type CredentialIsolationCapability
} from "./credential-isolation.ts";
import {
  type HostIdentityCapability
} from "./host-identity.ts";
import {
  type OutcomeDispatchAdapter,
  type OutcomeDispatchEffectKey,
  type OutcomeDispatchRequest
} from "./dispatch-effects.ts";
import {
  type CompletionPolicyRegistry
} from "../policy/completion-policy.ts";
import {
  type NaturalCompletionSettlement
} from "./natural-completion.ts";
import type { ValidatorRegistry } from "./validators.ts";

// ── The create-right fence a credential re-issue runs under ─────────────────

/**
 * What one fence claim answered: this process now holds the create right for
 * the effect, or somebody else does.
 */
export type AttemptReissueClaim =
  | {
    readonly kind: "claimed";
    /** The owner to name when the claim is given back. */
    readonly ownerId: string;
  }
  | {
    readonly kind: "held";
    /** Host-authored: which claim holds it, never a credential. */
    readonly reason: string;
  };


/**
 * The host's CREATE-RIGHT fence for a lost attempt credential (plan §3.3).
 *
 * WHY A RE-ISSUE NEEDS ONE. "The effect row is `pending` and the host answered
 * `absent`" says nothing about whether another process is between its OWN
 * re-issue and its create. Without a fence, a second recoverer can replace the
 * recorded verifier after the first one has re-issued but before it has
 * delivered, so the worker the first process dispatches holds a credential that
 * no longer matches the recorded verifier — credential re-binding, the failure
 * §1 forbids. The create right is the one durable fact that changes at exactly
 * that boundary, so the re-issue is performed only while this process holds it
 * and a loser refuses by name instead of overwriting the winner's verifier.
 *
 * A HOST THAT CANNOT SUBSTANTIATE IT DOES NOT GET THE RE-ISSUE. Omitting the
 * capability leaves the re-issue refusing with `credential-reissue-forbidden`:
 * a check that is only declared and has no mechanism does not count, and the
 * path must not silently accept (plan §3.3).
 */
export interface AttemptCredentialReissueFence {
  /** Take the create right for one effect, or report it held elsewhere. */
  claim(effect: OutcomeDispatchEffectKey): AttemptReissueClaim;
  /**
   * Give back a claim this runtime took and did NOT hand to the platform. The
   * caller states the reason as the proof: no create was attempted, so nothing
   * was created and a later recovery may create exactly once.
   */
  abandon(effect: OutcomeDispatchEffectKey, ownerId: string, reason: string): void;
}


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
  /**
   * A dispatch was NOT created because the node's declared inputs could not be
   * resolved from the durable facts (D6). The attempt is not started with a hole
   * where its input should be: at a start the refusal names every offending
   * input and nothing is written, and at an arming the refusals are recorded on
   * the node's own state entry.
   */
  | "dispatch-input-unbound"
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
   * No dispatch adapter is installed, so a node cannot be started at all
   * (D8). Production entry points refuse with this BEFORE opening a ledger
   * rather than running the graph against a no-op that would record an
   * execution nobody started. The runtime itself refuses with it too, for a
   * caller that bypasses the typed option.
   */
  | "dispatch-unavailable"
  /**
   * The creation of a dispatch effect could not be established from host facts
   * (D8). The effect stays unsettled and is reported for host/manual
   * reconciliation: a process may have started the execution and died inside
   * the window, and this runtime has no query capability (or its host answered
   * `unknown`) — so it neither re-issues the create (which could duplicate a
   * started execution) nor reports success.
   */
  | "dispatch-unreconciled"
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
  | "completion-policy-digest-mismatch"
  /**
   * This process was given no readable HOST credential-isolation capability
   * (D7), so the credential itself has no store that can hold it and no
   * channel that can deliver it per attempt. The durable record now carries
   * only a digest, but a digest cannot be handed to a recovered worker, so the
   * outcome run path REFUSES to start, resume or settle anything without the
   * capability; nothing is written and no fallback is taken.
   */
  | "credential-isolation-unavailable"
  /**
   * The host identity capability this process holds is unreadable (D9): a value
   * was injected that is not a version-1 `{ version, id, current }` capability.
   * A declared identity constraint is never downgraded to an unconstrained run,
   * so the operation is refused rather than performed without the check.
   */
  | "host-identity-unavailable"
  /**
   * The host reports an invocation identity for this submission that differs
   * from the identity recorded when the attempt was dispatched (D9). The
   * attempt's own record is the reference, so nothing is written and no
   * rebinding to the current invocation is attempted.
   */
  | "host-identity-mismatch"
  /**
   * The attempt recorded a dispatch identity and the host reports NO identity
   * for this submission (D9), so the binding cannot be checked. Distinct from a
   * mismatch: there is nothing to compare, and settling anyway would drop the
   * constraint the host declared at dispatch.
   */
  | "host-identity-absent"
  /**
   * A natural-completion delivery is not the closed record this protocol
   * defines: it is missing `nodeId` or `attemptId`, names a credential that is
   * not a non-empty string, or carries a field the envelope does not define.
   * The last case is the NO-DATA-CHANNEL rule: an `outcomeId`, a payload or an
   * evidence list offered alongside a completion fact is refused by name, never
   * dropped, because a completion fact that could carry a result would be a
   * second submission channel.
   */
  | "malformed-natural-delivery"
  /**
   * The plan pins NO natural-completion authorization for the delivered node
   * (D6): either the node is not in the plan, or it is not declared with a
   * `natural` completion policy, or the mapping the plan pinned does not agree
   * with the node's own declared mapping. The delivery is refused — a completion
   * is NEVER re-interpreted as an explicit submission and the policy is never
   * ignored, because the outcome a natural completion settles is exactly the
   * mapping the plan was authorized for.
   */
  | "natural-completion-unauthorized"
  /**
   * A HOST-COMPLETION delivery is not the closed record this protocol defines:
   * it is missing `nodeId`, `attemptId` or `executionId`, one of them is not a
   * non-empty string, or it carries a key the envelope does not define. The
   * last case is the same no-data-channel rule the bearer envelope enforces: a
   * completion fact that could carry an outcome or a payload would be a second
   * submission channel.
   */
  | "malformed-host-completion"
  /**
   * A completion fact arrived through the HOST-COMPLETION channel
   * ({@link OutcomeGraphRuntime.settleHostCompletion}) but this runtime holds
   * no HOST COMPLETION AUTHORITY, so it cannot check the fact against the
   * host's own durable execution record. The channel is refused by name rather
   * than settled on the caller's word: "the host says so" is exactly the claim
   * that has to be substantiated (plan §3.3).
   */
  | "host-completion-unavailable"
  /**
   * The host completion authority does not corroborate the delivery: it holds
   * no confirmed execution for the attempt, or it names a DIFFERENT execution
   * than the one the delivery reports. Nothing was written, and the completion
   * is never re-bound to whichever execution happens to exist.
   */
  | "host-completion-unauthenticated"
  /**
   * A recovered attempt's credential is gone and the runtime refuses to
   * re-issue one, because the restart-authorization conditions of plan §3.3 are
   * not met: the effect is not an UNSTARTED one, or the host did not answer
   * `absent` for it (the answer was `unknown` or `created`). Re-issuing and
   * re-delivering under an unknown create outcome is forbidden — a blind retry
   * could run the attempt twice — so the effect stays unsettled and is reported.
   */
  | "credential-reissue-forbidden"
  /**
   * A TRUSTED CONTROL COMMAND stopped this run (P3 item 1): a failure, a
   * timeout or a cancellation is recorded on the run, so the run takes no
   * further step — it dispatches nothing, arms nothing and settles nothing.
   * The command, its reason and the principal that decided it are the durable
   * record this refusal reports; the attempt entries the stop left in flight
   * are reported, never settled and never dropped. It is deliberately NOT a
   * successful outcome: a stopped run can never be advanced by a submission,
   * and the same code is what a late worker submission and a late completion
   * fact both meet.
   */
  | "control-stopped"
  /**
   * The attempt was SUPERSEDED by a trusted `retry` (P3 item 2). The retry is a
   * successor command, not a stopping one: the run continues, but the attempt it
   * replaced accepts nothing — its result would belong to an execution the node
   * no longer holds. The successor attempt named in the refusal carries the node
   * forward, and the superseded attempt's own receipts, accepted event and
   * decisions (if it ever had any) stay exactly as they were.
   */
  | "attempt-superseded"
  /**
   * The attempt belongs to a run the graph has SUPERSEDED (P3 item 2). A
   * run-scoped `retry` closed that run and minted a successor, so the closed
   * run's attempts can never settle afterwards: their results would be new
   * terminal facts about a run whose receipts are already the record of what it
   * accepted. Nothing was accepted, and the successor run carries the graph
   * forward — the closed run's own receipts, accepted events, decisions, state
   * and effects stay exactly as they were.
   */
  | "run-superseded"
  /**
   * No trusted order to re-execute this run is recorded, so the runtime refuses
   * to mint a successor run on its own. A new run is a trusted decision (§3.2:
   * "终态图重新运行创建新 Run"), and the order is what makes it durable before
   * anything is minted; a caller that wants one applies the run-scoped `retry`
   * command through the control entry.
   */
  | "reexecution-not-authorized"
  /**
   * The run the order names is not TERMINAL: its state still records work in
   * flight, so re-executing the graph would run nodes the current run has not
   * finished. A node-scoped `retry` is the command for a live run.
   */
  | "reexecution-not-terminal"
  /**
   * The terminal run still owes external work whose fate is UNKNOWN — at least
   * one unsettled dispatch effect whose attempt the run never superseded and
   * which no platform-confirmed cancellation covers. Re-executing the graph
   * could run a side effect that is still live, which is exactly what §4's
   * "不能把已完成外部副作用自动重跑" forbids; the effects stay visible and the
   * caller resolves them (or waits) before re-executing.
   */
  | "reexecution-unsettled-effects"
  /**
   * Another process minted the successor run, or consumed the order, between
   * this call's read and its write. Nothing was written: the caller re-reads the
   * graph and sees the successor that stands.
   */
  | "reexecution-raced"
  /**
   * The attempt is PAUSED on a trusted approval request that is still `pending`
   * (P3 item 3). Approval is CONTROL, not an outcome (§3.4): the worker's
   * submission — including any `approved` field, any claim inside `data`, and
   * every other byte of it — is not read as an approval, and nothing was
   * accepted. The refusal names the request, the session that must decide it and
   * the deadline it expires at; the repair is that session's decision through
   * the trusted control entry.
   */
  | "approval-pending"
  /**
   * The attempt's approval request was REJECTED (P3 item 3): the pause was
   * answered with a no, so the attempt can never settle and nothing was accepted.
   * A rejection is terminal — no later approval rewrites it.
   */
  | "approval-rejected"
  /**
   * The attempt's approval request EXPIRED (P3 item 3): the deadline passed
   * before a decision was recorded, and the expiry is itself the durable
   * outcome. An expired request is never approved afterwards, so this attempt
   * cannot settle; the trusted repair is a retry or a cancellation of the run.
   */
  | "approval-expired"
  /**
   * This runtime was handed no BUDGET surface, and the plan declares at least
   * one per-node ceiling (P3 item 3). A ceiling a substrate cannot record a
   * claim against is a ceiling NOTHING enforces, so the operation is refused by
   * name rather than dispatched ungated. A plan that declares no ceiling needs
   * no claim and is not refused by this code.
   */
  | "budget-unavailable"
  /**
   * The node's declared ceiling leaves no headroom for the dispatch this call
   * would arm (P3 item 3, "超限停止新派发"). The claim is refused by the STORE's
   * conditional write — the refusal names the dimension, the committed amount
   * and the declared ceiling — so the attempt is NOT recorded and no external
   * execution is created for it. An attempt already in flight is not killed by
   * this: its own claim stands and it runs to its settlement.
   */
  | "budget-exhausted"
  /**
   * A node's declared per-node budget carries a key the v3 grammar never
   * authorizes (or a value that is not a finite non-negative number). This build
   * neither enforces the unknown limit nor defaults it away, so the operation is
   * refused before anything is read or written: a run must not execute with a
   * subset of the ceilings its declaration claims.
   */
  | "budget-limit-unauthorized"
  /**
   * A usage report is not the closed record this protocol defines: an attempt
   * reference is missing or empty, or an amount is not a finite non-negative
   * number. Nothing was recorded — a report that cannot be read exactly must not
   * move a recorded usage fact, because the number it would move is the one an
   * overrun is reported from.
   */
  | "budget-usage-malformed";


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


/**
 * What {@link OutcomeGraphRuntime.reexecute} produced.
 *
 * A re-execution is NOT a resume and NOT a second start: it mints a NEW RUN for
 * one TERMINAL run's graph, under a durable trusted order the control service
 * recorded, and keeps every fact of the run it supersedes exactly as it was —
 * its run row, its state snapshot, its receipts, its accepted events, its
 * effects and its control decisions.
 */
export type OutcomeReexecutionResult =
  | {
    readonly kind: "reexecuted";
    /** The NEW run's identity. */
    readonly runId: string;
    /** Its graph-local sequence; exactly one greater than the run it supersedes. */
    readonly runSeq: number;
    /** The plan revision THIS run executes (recorded on its row and its state). */
    readonly planRevision: string;
    /** The terminal run this one succeeds. */
    readonly fromRunId: string;
    readonly state: OutcomeGraphState;
    readonly dispatched: readonly OutcomeDispatchRequest[];
    /**
     * The attempts the new run records as in flight, CREDENTIAL-FREE, exactly as
     * `resume` reports them: a re-execution arms its entry nodes, so the caller
     * gets the same inventory a first execution does rather than an empty
     * "armed" list that would make the new run look idle.
     */
    readonly armed: readonly OutcomeArmedNode[];
    /** The new run's unsettled effects (the intents a host is to launch). */
    readonly unsettledEffects: readonly PendingEffectRecord[];
  }
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
   * the persisted receipt, dispatches nothing and changes no state. The
   * PERSISTED receipt's decision governs the answer: on a replay `decision.kind`
   * is the terminal kind the ledger recorded — never this call's re-evaluation,
   * whose `requirements` cannot overturn it — so a repeated submission answers
   * with the SAME persisted decision the receipt holds.
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
 * What {@link OutcomeGraphRuntime.settleNatural} produced.
 *
 * The variants mirror {@link OutcomeSubmissionResult} because a natural
 * completion IS a settlement through the same acceptance core and the same
 * atomic transaction — one attempt, the plan's pinned authorization, the
 * outcome's declared acceptance gates, one receipt, one accepted event. Each
 * non-refused variant adds the {@link NaturalCompletionSettlement} record: the
 * attempt, the outcome the PLAN authorized, the exact policy revision behind
 * it, and the namespaced submission key the receipt persists.
 */
export type OutcomeNaturalSettlementResult =
  /** The delivery was refused before anything was written. */
  | {
    readonly kind: "refused";
    readonly refusals: readonly OutcomeRuntimeRefusal[];
  }
  /**
   * The natural completion settled the attempt through the shared transaction.
   * Like a submission's replay, a repeated delivery answers with the PERSISTED
   * receipt's decision: the completion fact's gates are re-evaluated for the
   * record, but they can neither overturn a persisted rejection into an
   * acceptance nor a persisted acceptance into a rejection.
   */
  | {
    readonly kind: "accepted";
    readonly completion: NaturalCompletionSettlement;
    readonly decision: AcceptanceDecision;
    readonly receipt: ReceiptRecord;
    readonly state: OutcomeGraphState;
    readonly dispatched: readonly OutcomeDispatchRequest[];
    readonly replayed: boolean;
    readonly stop?: OutcomeStop;
    readonly progress?: readonly ProgressReport[];
  }
  /**
   * A declared acceptance gate did not pass, so the attempt is NOT settled: the
   * receipt records the rejection, no accepted event exists, and the attempt
   * stays open for the ordinary submission path.
   */
  | {
    readonly kind: "rejected";
    readonly completion: NaturalCompletionSettlement;
    readonly decision: AcceptanceDecision;
    readonly receipt: ReceiptRecord;
  }
  /**
   * The attempt was already settled by a DIFFERENT logical submission (the
   * worker's own claimed outcome, for example), so this delivery's decision was
   * not committed and the original settlement stands.
   */
  | {
    readonly kind: "not-committed";
    readonly completion: NaturalCompletionSettlement;
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


/** Why a resume resolved an unsettled effect without launching it (D8). */
export type OutcomeReconciledReason =
  /** The row already recorded a create that returned; nothing was re-created. */
  | "recorded-started"
  /** The host answered `created` for a pending row; it was marked, not re-created. */
  | "host-reported-created"
  /**
   * The state records the attempt as SETTLED, so its dispatch is complete: the
   * effect is marked `done` and nothing is launched. Reachable when a
   * settlement happened against a row the settle-time transition could not
   * cover — a create that returned inside the crash window, whose row was still
   * `pending` when the worker's outcome arrived.
   */
  | "attempt-settled";


/**
 * One unsettled dispatch effect a resume RESOLVED WITHOUT LAUNCHING (D8).
 *
 * This is the positive half of the reconciliation report: the runtime asked the
 * host whether an execution exists and got an answer of `created` (or found a
 * row that already recorded a returned create), so it neither re-issued the
 * create nor left the question open. The credential is never part of this
 * record — it names the effect and the attempt, nothing more.
 */
export interface OutcomeReconciledEffect {
  readonly effectId: string;
  readonly attemptId: string;
  readonly reason: OutcomeReconciledReason;
}


/**
 * One restart DIVERGENCE: the persisted local effect status and a host FACT
 * about the same stable effect id disagree (D9).
 *
 * The two reachable shapes are opposite directions of the same crash window:
 * `pending` locally while the host reports the execution `created` (the create
 * returned and the row was not marked, so the host is AHEAD), and `started`
 * locally while the host reports `absent` (the row records a returned create
 * the host cannot corroborate, so the record is AHEAD).
 *
 * A host that answers `unknown` is NOT a divergence: it stated no fact, so
 * there is nothing to disagree with — the effect is reported as unsettled work
 * (`dispatch-unreconciled`) instead.
 */
export interface OutcomeEffectDivergence {
  /** The stable effect id both records name. */
  readonly effectId: string;
  /** The attempt the effect belongs to. */
  readonly attemptId: string;
  /** The status the LEDGER recorded before this recovery. */
  readonly local: "pending" | "started";
  /** The fact the HOST reported for the same effect id. */
  readonly host: "created" | "absent";
  /**
   * What this recovery did about it — never a re-dispatch and never a silent
   * drop: `reconciled-started` marked the row started without creating (the
   * host is ahead), `reported-unreconciled` changed nothing and reported the
   * disagreement for host/manual reconciliation (the record is ahead).
   */
  readonly resolution: "reconciled-started" | "reported-unreconciled";
}


/**
 * What {@link OutcomeGraphRuntime.resume} produced.
 */
export type OutcomeResumeResult =
  | {
    readonly kind: "started";
    readonly state: OutcomeGraphState;
    readonly dispatched: readonly OutcomeDispatchRequest[];
    readonly reconciled: readonly OutcomeReconciledEffect[];
    readonly divergences: readonly OutcomeEffectDivergence[];
    readonly armed: readonly OutcomeArmedNode[];
    readonly unsettledEffects: readonly PendingEffectRecord[];
    readonly refusals: readonly OutcomeRuntimeRefusal[];
  }
  | {
    readonly kind: "resumed";
    readonly state: OutcomeGraphState;
    readonly dispatched: readonly OutcomeDispatchRequest[];
    readonly reconciled: readonly OutcomeReconciledEffect[];
    readonly divergences: readonly OutcomeEffectDivergence[];
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
    /**
     * Present exactly when the run this call found is STOPPED BY A TRUSTED
     * CONTROL COMMAND (P3 item 1): the failure, timeout or cancellation
     * recorded on the run, with its reason, its decision time and the
     * principal that decided it.
     *
     * A controlled run behaves exactly like a body-stopped one — nothing is
     * launched, nothing is armed, nothing is settled, and a second resume
     * reports the same fact — but the reason is a TRUSTED LIFECYCLE COMMAND,
     * not a declared limit, so it is carried as its own field instead of
     * being rounded into {@link OutcomeStop} (plan §3.4: control is not an
     * outcome). The attempts the stop left in flight are named in `refusals`
     * and their effects stay in `unsettledEffects`: an external execution
     * this process cannot confirm is REPORTED, never hidden.
     */
    readonly control?: RunControlRecord;
    /**
     * Present exactly when this call MINTED A NEW RUN in place of a terminal
     * one (P3 item 2): the successor's identity, its graph-local sequence, the
     * run it succeeds and the plan revision it executes. Every other field of
     * this answer then describes THE SUCCESSOR — its state, its armed attempts
     * and its unsettled effects — and the superseded run is untouched and still
     * addressable by its own id.
     */
    readonly reexecuted?: {
      readonly runId: string;
      readonly runSeq: number;
      readonly fromRunId: string;
      readonly planRevision: string;
    };
  }
  | {
    readonly kind: "refused";
    readonly refusals: readonly OutcomeRuntimeRefusal[];
  };


// ── The budget contract (P3 item 3) ─────────────────────────────────────────

/** One attempt's REAL usage, as the trusted host path reports it. */
export interface OutcomeAttemptUsage {
  /** The node whose attempt consumed this. */
  readonly nodeId: string;
  /** The attempt the usage belongs to. */
  readonly attemptId: string;
  /**
   * How many executions this report accounts for. Defaults to ONE — the armed
   * dispatch itself — which is also the count the reservation recorded.
   */
  readonly executions?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}


/**
 * One usage report: measured amounts for attempts that have ALREADY run.
 *
 * IT IS NOT A SUBMISSION PAYLOAD. Nothing in the acceptance path reads this
 * shape, and no field of a worker's proposal reaches it: a submitted payload
 * must not be able to forge usage or raise a ceiling (P3 hard constraint). The
 * report arrives through this runtime's own host-facing method, which the host
 * wiring calls with amounts the PLATFORM measured.
 */
export interface OutcomeBudgetUsageReport {
  readonly attempts: readonly OutcomeAttemptUsage[];
  /** Epoch milliseconds; defaults to the runtime's clock. */
  readonly now?: number;
}


/** What recording one usage report did, per attempt. */
export interface OutcomeBudgetUsageEntry {
  /**
   * The RUN whose claim this fact belongs to — the run that was CHARGED, not
   * necessarily the run the report addressed: a delayed bill for an attempt of a
   * superseded run settles THAT run's claim and names it here. For
   * `recorded-late` (an attempt that holds no claim at all) it is the run the
   * report addressed, the only run the store can know.
   */
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /**
   * `reconciled` — the outstanding claim was settled with these amounts;
   * `replayed` — the same amounts were already the standing fact;
   * `recorded-late` — the attempt was never reserved here and the usage was
   * APPENDED (delayed billing); `ignored` — the attempt already carries a
   * DIFFERENT usage fact, which stands and was not summed.
   */
  readonly outcome: "reconciled" | "replayed" | "recorded-late" | "ignored";
  /** The recorded fact after this call (never this call's numbers when ignored). */
  readonly used?: BudgetUsageAmounts;
  readonly reason?: string;
}


/**
 * One node's budget facts, as a report reads them.
 *
 * An ALIAS of the domain report node: the same shape is what a `budget-stop`
 * control answer carries, and a second declaration of it would be a second
 * place for the two surfaces to drift apart.
 */
export type OutcomeBudgetNodeReport = BudgetReportNode;


/**
 * The budget state of one RUN: the declared limits and the recorded usage, as
 * the durable rows answer them.
 *
 * THIS IS THE QUERY/REPORT SURFACE the plan's §4 P3 budget bullet asks for, and
 * it is a READ: nothing here writes, and an overrun shown here is the arithmetic
 * of recorded amounts against declared ceilings. `totals.executions` counts
 * every authorized dispatch; `used.executions`, `reserved.executions` and
 * `unknownUsageAttempts` account for them separately, so "no usage reported
 * yet" can never be misread as "used nothing".
 *
 * An ALIAS of the domain's {@link BudgetReport}, built by the one shared
 * {@link buildBudgetReport} — the same numbers a `budget-stop` answer reports.
 */
export type OutcomeBudgetReport = BudgetReport;


/** The verdict of reading one run's budget state. */
export type OutcomeBudgetReading =
  | { readonly kind: "report"; readonly report: OutcomeBudgetReport }
  | { readonly kind: "refused"; readonly refusal: OutcomeRuntimeRefusal };


/** The verdict of recording one usage report. */
export type OutcomeBudgetUsageOutcome =
  | {
    readonly kind: "recorded";
    readonly graphId: string;
    /**
     * The run the returned report describes: the run the FIRST entry's fact
     * belongs to, or the run this report addressed when it carried no attempts.
     * Every entry names its own run, so a report crossing a run boundary stays
     * fully attributable while the report itself is one run's state.
     */
    readonly runId: string;
    readonly at: number;
    /** What each attempt's report did, in report order. */
    readonly entries: readonly OutcomeBudgetUsageEntry[];
    /** The run's budget state AFTER the report, read from the rows. */
    readonly report: OutcomeBudgetReport;
  }
  | { readonly kind: "refused"; readonly refusals: readonly OutcomeRuntimeRefusal[] };


// ── The runtime ─────────────────────────────────────────────────────────────

/** Inputs to {@link OutcomeGraphRuntime}. */
export interface OutcomeGraphRuntimeOptions {
  /** The committed compiled plan this runtime executes. Its graphId IS the id. */
  readonly plan: CompiledPlan;
  /** The durable ledger the state and the acceptance share. */
  readonly ledger: AcceptanceLedger;
  /**
   * Where a dispatched node goes — the HOST dispatch adapter (D8), called only
   * after the effect and the state it belongs to have committed together.
   *
   * A bare seam is accepted and is the degenerate host: it can create an
   * execution but cannot answer whether one already exists, so a recovery that
   * needs that answer reports the effect instead of re-issuing the create.
   *
   * OMITTED IS NOT NEUTRAL: `start`, `resume` and `submit` all refuse with
   * `dispatch-unavailable` before they read or write anything, because a no-op
   * dispatcher would let this runtime record a dispatch it never performed.
   * The production entries check the same condition before opening a ledger.
   */
  readonly dispatch?: OutcomeDispatchAdapter;
  /**
   * The host's CREATE-RIGHT fence (plan §3.3) — the mechanism that makes a
   * credential re-issue single-winner.
   *
   * A lost credential is re-issued only while this process holds the create
   * right for the effect, so a second recoverer (another process, or a second
   * boot sweep over the same workspace) cannot replace the verifier between
   * the first process's re-issue and its create — the window in which the
   * worker it is about to dispatch would otherwise be handed a credential the
   * store no longer records.
   *
   * OMITTED IS NOT NEUTRAL: without it a lost credential is NOT re-issued.
   * `resume` reports `credential-reissue-forbidden` naming the missing fence,
   * because "the effect looks pending" is not proof that the old create right
   * has lapsed and a capability without an enforcing mechanism does not count.
   */
  readonly reissueFence?: AttemptCredentialReissueFence;
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
  /**
   * The HOST's credential-isolation capability (D7) — the production
   * enablement condition of this run path.
   *
   * An attempt credential is a bearer nonce: whatever holds the value can be
   * accepted for the attempt it was issued for. This build therefore persists
   * only its DIGEST, and the credential itself belongs to the host, which
   * declares and provides it here (`credential-isolation.ts`): a protected
   * store and per-attempt delivery — version 2 injects the store the runtime
   * adopts every minted credential into and resolves a recovery's re-delivery
   * from. Whether that store is readable by a same-account worker is a property
   * of the host's platform that no value here can attest.
   *
   * OMITTED IS NOT NEUTRAL: every entry — `start`, `resume` and `submit` —
   * refuses with `credential-isolation-unavailable` before it reads or writes
   * anything, because an unprotected run is exactly the defect this gate
   * exists to prevent. There is no default adapter and no test-only bypass in
   * this module.
   */
  readonly credentialIsolation?: CredentialIsolationCapability;
  /**
   * The HOST's invocation-identity capability (D9) — the ADDITIONAL constraint
   * a host may declare on top of the bearer credential.
   *
   * With a readable capability, every attempt this runtime dispatches records
   * the host identity of the invocation that dispatched it, and a submission
   * that settles that attempt must come from the SAME host attribution; a
   * mismatched, absent or unverifiable identity is refused by name and nothing
   * is written. A capability that is present but UNREADABLE refuses the
   * operation (`host-identity-unavailable`) rather than running unconstrained.
   *
   * OMITTED IS NOT A DOWNGRADE: without the capability nothing is recorded and
   * nothing is checked, which is exactly how every path behaved before this
   * slice — the core protocol depends on no host and works without one. The
   * constraint is additive: it binds attempts dispatched under a host identity
   * and leaves every other attempt exactly as it was.
   */
  readonly hostIdentity?: HostIdentityCapability;
  /**
   * The HOST-COMPLETION AUTHORITY (P2 items 6/7) — the host's own durable
   * record of the execution it created for one attempt.
   *
   * WHY A COMPLETION NEEDS A SECOND AUTHENTICATION CHANNEL. §3.3: a worker's
   * submission and a host's completion fact are authenticated SEPARATELY and
   * then enter the SAME acceptance core. The bearer credential above proves
   * that whoever presents it was handed the attempt's capability; it says
   * nothing about the host having created, or observed the end of, an
   * execution — and re-obtaining a lost bearer after a restart is exactly what
   * the plan forbids a trusted completion from depending on. This capability is
   * the other half: the host answers with the execution its OWN durable record
   * carries (the row its platform confirmation wrote, with the platform's real
   * execution id), and {@link OutcomeGraphRuntime.settleHostCompletion} settles
   * only a fact that capability corroborates.
   *
   * OMITTED IS NOT A DOWNGRADE FOR THE OTHER CHANNELS: without it the run path
   * behaves exactly as before, and only the host-completion entry refuses
   * (host-completion-unavailable) — the completion channel is the one thing the
   * capability enables. It carries no credential and never reads one.
   */
  readonly hostCompletions?: HostCompletionAuthority;
}


/**
 * One attempt's CONFIRMED host execution, as the host's own record holds it.
 *
 * Structural on purpose: the shipped record is the execution index's
 * HostExecutionIdentity (src/graph/host/execution-index.ts), and this module
 * must not import the host layer. The execution id is the platform's own id —
 * the token a recovery can ask the platform about — so a completion fact is
 * never authenticated against a locally invented identifier.
 */
export interface HostCompletionExecution {
  readonly executionId: string;
  readonly taskId?: string;
}


/** The attempt one host-completion question is about. */
export interface HostCompletionAttemptRef {
  readonly graphId: string;
  readonly attemptId: string;
}


/**
 * The HOST's completion authority: what the host can substantiate about the
 * execution it created for one attempt.
 *
 * ONE METHOD, ONE FACT, NO CREDENTIAL. It answers with the confirmed execution
 * the host's OWN durable record carries, or undefined when the host holds no
 * confirmed execution for that attempt — never a guess, never the node's
 * current attempt and never a value derived from one. A host that throws has
 * not answered, and the caller refuses rather than settling.
 */
export interface HostCompletionAuthority {
  executionFor(attempt: HostCompletionAttemptRef): HostCompletionExecution | undefined;
}


/**
 * One host completion fact as it crosses the settlement boundary.
 *
 * The closed shape the host-completion channel accepts: the attempt that
 * finished, the node it belongs to and the platform execution the host
 * recorded. No outcome and no payload — the outcome is the plan's pinned
 * natural-completion authorization, exactly as it is on the bearer channel, so
 * a completion can never choose what it settles.
 */
export interface HostCompletionFact {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly executionId: string;
}