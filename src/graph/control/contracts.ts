import type { ApprovalPolicy } from "../policy/approval-policy.ts";
import type { BudgetReport } from "../domain/budget.ts";
import type { AttemptCredentialSource } from "../outcome/attempt-credential.ts";
import type { CredentialIsolationCapability } from "../outcome/credential-isolation.ts";
import type {
  ApprovalRequestRecord, ControlCommandName, ControlDecisionRecord,
  PendingEffectRecord, RunControlRecord, RunReexecutionRecord,
} from "../ledger/types.ts";
import type { ApprovalRequestSpec } from "./approval.ts";

/** The trusted invocation asking, as the platform attributed it. */
export interface GraphControlPrincipal {
  /** The session the platform attributed to this call. Never caller content. */
  readonly sessionId: string;
  /** The agent the platform attributed, when it attributes one. */
  readonly agentId?: string;
}

/**
 * What a `retry` needs to mint its successor attempt's CREDENTIAL (P3 item 2).
 *
 * WHY THE CONTROL PATH NEEDS A HOST CAPABILITY AT ALL. A retry mints a new
 * attempt, and an attempt is only usable with the bearer credential its worker
 * will present. This build persists only the credential's DIGEST, so the VALUE
 * has to be adopted by the host's protected store INSIDE the same transaction
 * that records the digest — exactly as the run path's own dispatch does — or the
 * attempt could never be delivered after a restart. A process without a readable
 * version-3 store refuses the command by name rather than writing an attempt
 * nobody can settle.
 *
 * THE SOURCE IS INJECTABLE for the same reason the run path's is: a test pins
 * the credential value deterministically, while production uses the platform
 * CSPRNG. Omitting it is NOT "no credential" — it is the shipped source.
 */
export interface GraphControlRetryCapability {
  /** The protected store the value is adopted by, inside the caller's transaction. */
  readonly credentialIsolation: CredentialIsolationCapability;
  /** The minting source; defaults to the platform CSPRNG. */
  readonly mintCredential?: AttemptCredentialSource;
}

/** One control command a trusted principal asked for. */
export interface GraphControlRequest {
  /** Host-only authority, corroborated against the attempt's durable execution binding. */
  readonly hostFailure?: { readonly executionId: string; readonly taskId?: string };
  readonly approvalPolicy?: ApprovalPolicy;
  readonly graphId: string;
  /** The command, from the durable closed vocabulary. */
  readonly command: ControlCommandName;
  /** The node the command names, for a node-scoped command. */
  readonly nodeId?: string;
  /** The attempt the command names, when the caller knows it. */
  readonly attemptId?: string;
  readonly reason: string;
  /** The trusted invocation. A request without one is refused, never guessed. */
  readonly principal: GraphControlPrincipal | undefined;
  /** Epoch milliseconds. Time is an explicit input, like every protocol write. */
  readonly at: number;
  /**
   * What a `retry` needs to mint its successor attempt's credential. Absent
   * means this process cannot mint one, and a retry is refused
   * `credential-isolation-unavailable` — never applied without a usable
   * credential.
   */
  readonly retry?: GraphControlRetryCapability;
  /**
   * What an `approval-request` must carry: the ONLY session that may decide it
   * and the deadline it expires at (P3 item 3). Required for that command — a
   * request with no named approver would let the declaring principal's control
   * authority imply approval authority, and a request with no deadline would be
   * a pause nothing can end on its own. Ignored by every other command.
   */
  readonly approval?: ApprovalRequestSpec;
}

// ── The answer ──────────────────────────────────────────────────────────────

/**
 * Why a control command was refused.
 *
 * Refusals roll back the command's writes, including its deadline sweep. The
 * exception is `approval-expired`: the request's expiry commits before the
 * decision is refused. Store failures propagate as exceptions.
 */
export type GraphControlRefusalCode =
  /** The call carried no platform attribution, so no principal can be checked. */
  | "control-principal-absent"
  /** The graph has no recorded declaring invocation, so no one may control it. */
  | "control-declarant-unknown"
  /** The caller is not the declaring principal of this graph. */
  | "control-not-authorized"
  /**
   * A node-scoped retry or approval request names a run that has stopped.
   * Neither can make its attempts settle; re-execute the graph as a new run
   * with a run-scoped retry.
   */
  | "run-stopped"
  /**
   * A RUN-SCOPED retry names a run that is still executing (or has never
   * started). A new run exists to REPLACE a finished one; a run with work in
   * flight is retried with the node-scoped form, which supersedes one attempt.
   */
  | "run-not-terminal"
  /**
   * A RUN-SCOPED retry names a terminal run whose external work is NOT accounted
   * for: at least one unsettled dispatch effect whose attempt the run never
   * superseded and which no platform-confirmed cancellation covers. Re-executing
   * the graph could re-run a side effect that is still live, which §4 forbids
   * outright; the effects are named, stay visible, and the caller resolves them
   * (or waits for the platform) before ordering the re-execution.
   */
  | "run-has-unsettled-effects"
  /**
   * A retry cannot mint the successor attempt's credential: this process holds
   * no readable version-3 credential-isolation capability, so the value could
   * not be adopted by the host's store inside the transaction that records its
   * digest — and an attempt whose credential the host never held could never be
   * delivered or settled. Nothing was written.
   */
  | "credential-isolation-unavailable"
  /** The store holds no definition for this graph. */
  | "graph-unknown"
  /** The workspace store is absent, foreign, damaged, or a format this build cannot read. */
  | "store-unavailable"
  /** The stored definition of this graph is not one this build can run. */
  | "definition-unreadable"
  /** The graph has no run identity: it never began an execution. */
  | "run-not-started"
  /** The run's state snapshot is missing or is not this build's state for this plan. */
  | "run-state-unreadable"
  /** The named node is not one the compiled plan declares. */
  | "unknown-node"
  /** The node records no attempt in flight, so there is no attempt to control. */
  | "attempt-absent"
  /** The named attempt is not the node's current in-flight attempt. */
  | "attempt-not-current"
  /** The attempt already settled through the acceptance core. */
  | "attempt-already-settled"
  /** The attempt already carries a DIFFERENT control decision. */
  | "control-already-decided"
  /**
   * An `approval-request` does not carry a recordable approver and deadline (or
   * names a deadline that has already passed). Nothing is recorded: a request
   * no decision could ever legitimately resolve is not a pause, it is a strand.
   */
  | "approval-request-malformed"
  /**
   * The caller is not the session the request NAMES as its approver. This is the
   * separation §P3 asks for: the declaring principal may RAISE and may stop a
   * run, and that authority deliberately does NOT imply the right to decide an
   * approval it named someone else for.
   */
  | "approval-not-authorized"
  /** The node's current attempt carries no approval request, so there is nothing to decide. */
  | "approval-absent"
  /**
   * The request already carries a DIFFERENT terminal status (or the opposite
   * decision): nothing was written and the decision that stands is reported.
   * One request, one answer.
   */
  | "approval-already-decided"
  /**
   * The request's deadline passed before this decision arrived. The expiry was
   * materialized durably BY THIS CALL (so the outcome is recorded even though the
   * decision was refused) and an expired request is never approved afterwards.
   */
  | "approval-expired"
  /** This substrate cannot hold approval records, so no approval command is applied. */
  | "approval-unavailable"
  /**
   * A retry mints a NEW attempt and therefore a new dispatch, and the node's
   * declared budget leaves no headroom for it (P3 item 3). The claim is refused
   * by the store's conditional write; nothing is written — no decision, no state,
   * no effect and no credential — and the superseded attempt keeps its own claim,
   * because its external execution may still be running.
   */
  | "budget-exhausted"
  /**
   * This substrate holds no budget surface, and the node a retry would re-arm
   * declares a ceiling. A ceiling nothing can record a claim against is not
   * enforced, so the retry is refused rather than minted ungated.
   */
  | "budget-unavailable"
  /**
   * The node's declared budget carries a key the v3 grammar never authorizes (or
   * a value that is not a finite non-negative number). The limit is neither
   * enforced nor defaulted away, so the retry is refused.
   */
  | "budget-limit-unauthorized"
  /**
   * The node DECLARES downstream inputs and the attempt a retry would supersede
   * was armed before this build bound an input view to the attempt — so there is
   * no binding to carry onto the successor, and minting one by resolving the
   * producing nodes again is exactly the re-derivation a retry must not perform
   * (D6). Nothing is written; the repair is a re-execution, which arms an
   * attempt that carries the binding.
   */
  | "input-binding-absent";

/** One structured control refusal. */
export interface GraphControlRefusal {
  readonly code: GraphControlRefusalCode;
  /** Where the condition lives, in the request's own path vocabulary. */
  readonly path: string;
  readonly message: string;
}

/** One decision this call recorded (or replayed) for one attempt. */
export interface GraphControlAttemptDecision {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly decision: ControlDecisionRecord;
  /** True when this exact command was already recorded: nothing new was written. */
  readonly replayed: boolean;
}

/** One in-flight attempt a run-wide command did NOT decide, and why. */
export interface GraphControlSkippedAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly code: GraphControlRefusalCode;
  readonly message: string;
}

/**
 * One execution row the host has NOT confirmed for an attempt of this run.
 *
 * `creating` is the one that matters: the request was handed to the platform and
 * the result is UNKNOWN, so an external task may exist. It is reported so a
 * control answer never reads as "nothing is running anywhere".
 */
export interface GraphControlUnconfirmedExecution {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly effectId: string;
  readonly state: "pending" | "creating";
  /** The platform's own id, when the row carries one (never invented). */
  readonly executionId?: string;
  readonly taskId?: string;
}

/**
 * One attempt a `retry` MINTED, in the answer's own words.
 *
 * CREDENTIAL-FREE, like every other report: the successor attempt's credential
 * value was handed to the dispatch that will carry it and to nowhere else — this
 * answer names the attempt, its sequence and the effect a host launches it by.
 */
export interface GraphControlMintedAttempt {
  readonly nodeId: string;
  readonly attemptId: string;
  /** The graph-wide attempt sequence the successor minted. */
  readonly attemptSeq: number;
  /** The dispatch effect id a launch resolves it by. */
  readonly effectId: string;
}

/**
 * The re-execution a RUN-SCOPED `retry` recorded (P3 item 2).
 *
 * The order is durable whether or not the successor exists yet: a process that
 * dies between the order and the mint leaves it for the next window (the tool
 * call's own host follow-up, the boot sweep) to honour, exactly as a dispatch
 * intent outlives the create it authorizes.
 */
export interface GraphControlReexecution {
  /** The terminal run this order supersedes. */
  readonly fromRunId: string;
  readonly order: RunReexecutionRecord;
  /** The successor run, present exactly when the re-execution has committed. */
  readonly successorRunId?: string;
  /** The successor's graph-local sequence, with {@link successorRunId}. */
  readonly successorRunSeq?: number;
}

/**
 * One approval command's own report (P3 item 3).
 *
 * CREDENTIAL-FREE and payload-free, like every other answer here: it names the
 * request, the attempt it pauses, and whether this call actually recorded
 * anything. `request` is the row's state AFTER the command, so a caller reads
 * the fact that stands rather than what it asked for.
 */
export interface GraphControlApproval {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly request: ApprovalRequestRecord;
  /** True when this call recorded nothing new: the fact already stood. */
  readonly replayed: boolean;
}

/** What one control command did. */
export type GraphControlResult =
  | {
    readonly kind: "applied";
    readonly graphId: string;
    readonly runId: string;
    readonly command: ControlCommandName;
    /**
     * What the command acted on: `attempt` for a node-scoped command (it names
     * attempts of one node — including a `retry`, which supersedes one), `run`
     * for a command that acts on the run itself (a cancel, and a run-scoped
     * `retry`, which orders a new run).
     */
    readonly scope: "attempt" | "run";
    /**
     * The attempts a `retry` MINTED, in node order; empty for every other
     * command. A replay of an earlier retry reports the successor THAT decision
     * recorded — the same attempt, never a second one.
     */
    readonly minted: readonly GraphControlMintedAttempt[];
    /**
     * The run-level re-execution a RUN-SCOPED `retry` recorded, present exactly
     * for that command.
     */
    readonly reexecution?: GraphControlReexecution;
    /** The decisions THIS call recorded or replayed, in plan node order. */
    readonly decided: readonly GraphControlAttemptDecision[];
    /**
     * The run's control fact AFTER this call. It is the FIRST command recorded
     * for the run, so a later command reports the one that actually stopped
     * it — never this call's candidate. ABSENT when the run carries none and
     * this command did not claim one (a retry supersedes an attempt; it does
     * not stop the run).
     */
    readonly runControl?: RunControlRecord;
    /**
     * In-flight attempts this call did not decide, because they had already
     * settled through the acceptance core, or — for a run-wide command — because
     * they already carry another control command and are never re-labelled.
     */
    readonly skipped: readonly GraphControlSkippedAttempt[];
    /** Every effect of the run still pending or started. */
    readonly unsettledEffects: readonly PendingEffectRecord[];
    /** Every execution row of those attempts the host has not confirmed. */
    readonly unconfirmedExecutions: readonly GraphControlUnconfirmedExecution[];
    /**
     * Every approval request this call EXPIRED. A command issued under the
     * graph's DECLARING authority (a stop, a retry, an `approval-request`) runs
     * the graph-wide deadline sweep first and then, when it stops the run, the
     * pending requests of that run. A DECISION command sweeps nothing: it
     * materializes at most ITS OWN request's expiry, and reports that through
     * the `approval-expired` refusal instead. Present for EVERY applied command
     * and empty when nothing was due, so an expiry is never inferred from a
     * silence: the answer names the rows whose status changed (P3 item 3).
     */
    readonly expiredApprovals: readonly ApprovalRequestRecord[];
    /** The request directly raised or decided by an approval command. */
    readonly approval?: GraphControlApproval;
    /**
     * The run's BUDGET state, present exactly for an applied `budget-stop`
     * whose plan's ceilings could be read (P3 item 3): the declared limits, the
     * recorded usage, the outstanding reservations and — recomputed from the
     * rows — every ACTUAL overrun. It is the evidence the stop answers to, so
     * a delayed platform bill is visible in the very answer that stops the run
     * instead of being reported as "nothing was overspent".
     */
    readonly budget?: BudgetReport;
  }
  | {
    readonly kind: "refused";
    readonly graphId: string;
    readonly refusals: readonly GraphControlRefusal[];
  };
