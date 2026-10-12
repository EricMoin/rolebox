import type { ApprovalPolicy } from "../policy/approval-policy.ts";
import type { BudgetReport } from "../domain/budget.ts";
import type { AttemptCredentialSource } from "../outcome/attempt-credential.ts";
import type { CredentialIsolationCapability } from "../outcome/credential-isolation.ts";
import {
  CONTROL_COMMAND_NAMES,
  type ApprovalRequestRecord, type ControlCommandName, type ControlDecisionRecord,
  type PendingEffectRecord, type RunControlRecord, type RunReexecutionRecord,
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

/**
 * The fields every control request carries, whatever command it names.
 *
 * `retry` and `approval` live here as OPTIONAL fields because the runtime reads
 * each one only for the command that defines it and IGNORES it everywhere else:
 * `applyRetryCommand` reads `retry`, `applyApprovalCommand` reads `approval`,
 * and a value carried by any other command changes nothing. Each is made
 * REQUIRED by the one arm whose handler refuses its absence.
 */
export interface GraphControlRequestBase {
  readonly graphId: string;
  readonly reason: string;
  /** The trusted invocation. A request without one is refused, never guessed. */
  readonly principal: GraphControlPrincipal | undefined;
  /** Epoch milliseconds. Time is an explicit input, like every protocol write. */
  readonly at: number;
  readonly approvalPolicy?: ApprovalPolicy;
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
   *
   * REQUIRED by {@link GraphControlNodeRetryRequest}, whose handler refuses a
   * node-scoped retry that cannot adopt a credential
   * (`credential-isolation-unavailable`); a RUN-SCOPED retry never reads it.
   */
  readonly retry?: GraphControlRetryCapability;
  /**
   * What an `approval-request` must carry: the ONLY session that may decide it
   * and the deadline it expires at (P3 item 3). Required for that command — a
   * request with no named approver would let the declaring principal's control
   * authority imply approval authority, and a request with no deadline would be
   * a pause nothing can end on its own.
   *
   * REQUIRED by {@link GraphControlApprovalRequestCommand}, whose handler refuses
   * a raise that lacks either (`approval-request-malformed`). Every other
   * command's handler never reads it.
   */
  readonly approval?: ApprovalRequestSpec;
}

/**
 * A node-scoped stop: the attempt of ONE named node failed.
 *
 * `nodeId` is REQUIRED and `attemptId` optional because that is what the handler
 * resolves — `resolveNodeTarget` refuses a command that names no node
 * (`unknown-node`) and uses the run's current attempt when none is named.
 * `hostFailure` is the host-only corroboration a `failure` may carry;
 * `application.ts` refuses it on every command but `failure`.
 */
export interface GraphControlFailureRequest extends GraphControlRequestBase {
  readonly command: "failure";
  readonly nodeId: string;
  readonly attemptId?: string;
  /** Host-only authority, corroborated against the attempt's durable execution binding. */
  readonly hostFailure?: { readonly executionId: string; readonly taskId?: string };
}

/** A node-scoped stop: the attempt of ONE named node exceeded its declared time. */
export interface GraphControlTimeoutRequest extends GraphControlRequestBase {
  readonly command: "timeout";
  readonly nodeId: string;
  readonly attemptId?: string;
  /** `application.ts` refuses a host failure carried by any command but `failure`. */
  readonly hostFailure?: never;
}

/**
 * A run-wide stop: every attempt still in flight is cancelled.
 *
 * A run-wide command names no node and no attempt — `stop-command.ts` refuses a
 * `cancel` that carries either — so both fields are declared `never`: they stay
 * addressable (and `undefined`) across the union while a request that CARRIES
 * one is a compile error.
 */
export interface GraphControlCancelRequest extends GraphControlRequestBase {
  readonly command: "cancel";
  readonly nodeId?: never;
  readonly attemptId?: never;
  readonly hostFailure?: never;
}

/** A run-wide stop: the declared budget is spent, so the run ends. */
export interface GraphControlBudgetStopRequest extends GraphControlRequestBase {
  readonly command: "budget-stop";
  readonly nodeId?: never;
  readonly attemptId?: never;
  readonly hostFailure?: never;
}

/**
 * A RUN-SCOPED retry: re-execute a terminal run as a new one.
 *
 * The handler answers this form BEFORE it reads a credential capability
 * (`retry-command.ts`: a request that names no node orders a re-execution), so
 * `retry` stays optional here. `attemptId` does too: the handler refuses a
 * run-scoped retry that names an attempt, and that refusal is the one the tool
 * entry forwards.
 */
export interface GraphControlRunRetryRequest extends GraphControlRequestBase {
  readonly command: "retry";
  readonly nodeId?: never;
  readonly attemptId?: string;
  readonly hostFailure?: never;
}

/**
 * A NODE-SCOPED retry: supersede one node's attempt with a freshly minted one.
 *
 * `nodeId` is required and `retry` is required with it: only this process can
 * adopt the successor's credential into the host's protected store, and the
 * handler refuses `credential-isolation-unavailable` when no readable
 * capability is carried (`retry-command.ts`).
 */
export interface GraphControlNodeRetryRequest extends GraphControlRequestBase {
  readonly command: "retry";
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly hostFailure?: never;
  readonly retry: GraphControlRetryCapability;
}

/** A raise: pause ONE named attempt until the named approver decides it. */
export interface GraphControlApprovalRequestCommand extends GraphControlRequestBase {
  readonly command: "approval-request";
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly hostFailure?: never;
  readonly approval: ApprovalRequestSpec;
}

/** A decision: approve the pending request of ONE named attempt. */
export interface GraphControlApproveRequest extends GraphControlRequestBase {
  readonly command: "approve";
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly hostFailure?: never;
}

/** A decision: reject the pending request of ONE named attempt. */
export interface GraphControlRejectRequest extends GraphControlRequestBase {
  readonly command: "reject";
  readonly nodeId: string;
  readonly attemptId?: string;
  readonly hostFailure?: never;
}

/**
 * One control command a trusted principal asked for, discriminated on `command`.
 *
 * EVERY ARM MIRRORS A HANDLER'S OWN CHECKS, so a request the runtime refuses is
 * refused by the compiler first: `stop-command.ts` refuses a run-wide
 * `cancel`/`budget-stop` that names a node or an attempt; `resolveNodeTarget`
 * refuses a node-scoped command that names none; `approval-command.ts` refuses
 * an `approval-request` with no specification; `retry-command.ts` refuses a
 * `retry` with no credential-isolation capability; and `application.ts` refuses
 * a `hostFailure` carried by any command but `failure`. A field a command
 * merely IGNORES stays optional (see {@link GraphControlRequestBase}): the
 * runtime accepts it and does nothing with it.
 */
export type GraphControlRequest =
  | GraphControlFailureRequest
  | GraphControlTimeoutRequest
  | GraphControlCancelRequest
  | GraphControlBudgetStopRequest
  | GraphControlRunRetryRequest
  | GraphControlNodeRetryRequest
  | GraphControlApprovalRequestCommand
  | GraphControlApproveRequest
  | GraphControlRejectRequest;

type AssertNever<T extends never> = T;
/**
 * The union and the closed vocabulary cannot drift: every command must have an
 * arm, so a command added to {@link ControlCommandName} alone is a compile
 * error here rather than a request the runtime's switch cannot name.
 */
type _EveryControlCommandHasAnArm = AssertNever<
  Exclude<ControlCommandName, GraphControlRequest["command"]>
>;

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
   * The attempt names a STOPPING control decision (P3 item 1) and the command
   * would pause an execution that can never settle again: an approval request
   * on a stopped attempt is a strand, not a pause. The RUN itself is not
   * stopped — a node-scoped stop ends one attempt while its siblings keep
   * executing — so the repair is a node-scoped `retry` of that node (which
   * mints a successor attempt), never a new run.
   */
  | "attempt-stopped"
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

/**
 * The fields every APPLIED answer carries, whatever command it named.
 *
 * The command-specific fields are NOT here: `reexecution` belongs to a
 * run-scoped `retry`, `approval` to an approval command and `budget` to a
 * `budget-stop`. Each arm below carries exactly the one its command reports,
 * and declares the others `never`, so a consumer holding the arm for a command
 * cannot read a payload that command never produces and an answer carrying one
 * is a compile error. A `never` field stays addressable (and `undefined`)
 * across the union, exactly as the request arms' exclusions do.
 */
export interface GraphControlAppliedBase {
  readonly kind: "applied";
  readonly graphId: string;
  readonly runId: string;
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
}

/**
 * An applied `failure`, `timeout` or `cancel`.
 *
 * The command is the only thing this arm adds to the base: `stop-command.ts`
 * never reports a re-execution, an approval request or a budget for any of the
 * three, so each is declared `never`.
 */
export interface GraphControlStopApplied extends GraphControlAppliedBase {
  readonly command: "failure" | "timeout" | "cancel";
  readonly reexecution?: never;
  readonly approval?: never;
  readonly budget?: never;
}

/**
 * An applied `budget-stop`: the run's BUDGET state, present exactly for this
 * command (P3 item 3) — the declared limits, the recorded usage, the
 * outstanding reservations and, recomputed from the rows, every ACTUAL
 * overrun. It is the evidence the stop answers to, so a delayed platform bill
 * is visible in the very answer that stops the run instead of being reported
 * as "nothing was overspent".
 *
 * ABSENT when the plan's ceilings or the budget rows could not be read, which
 * is the one legitimate absence the contract documents (`budgetReportField`).
 * Holding THIS arm, that absence is the only thing an absent field can mean.
 */
export interface GraphControlBudgetStopApplied extends GraphControlAppliedBase {
  readonly command: "budget-stop";
  readonly reexecution?: never;
  readonly approval?: never;
  readonly budget?: BudgetReport;
}

/**
 * An applied `retry`: the RUN-SCOPED form records a re-execution, the
 * NODE-SCOPED form mints a successor attempt. `reexecution` is present exactly
 * for the run-scoped form (`retry-command.ts`).
 */
export interface GraphControlRetryApplied extends GraphControlAppliedBase {
  readonly command: "retry";
  readonly reexecution?: GraphControlReexecution;
  readonly approval?: never;
  readonly budget?: never;
}

/**
 * An applied approval command. `approval` is REQUIRED: every applied
 * `approval-request`, `approve` and `reject` names the request it raised or
 * decided (`approval-command.ts`).
 */
export interface GraphControlApprovalApplied extends GraphControlAppliedBase {
  readonly command: "approval-request" | "approve" | "reject";
  readonly approval: GraphControlApproval;
  readonly reexecution?: never;
  readonly budget?: never;
}

/** What one applied control command did, discriminated on the command it names. */
export type GraphControlAppliedResult =
  | GraphControlStopApplied
  | GraphControlBudgetStopApplied
  | GraphControlRetryApplied
  | GraphControlApprovalApplied;

/**
 * The union and the closed vocabulary cannot drift: every command must have an
 * applied arm, so a command added to {@link ControlCommandName} alone is a
 * compile error here rather than an answer no consumer can narrow.
 */
type _EveryControlCommandHasAnAppliedArm = AssertNever<
  Exclude<ControlCommandName, GraphControlAppliedResult["command"]>
>;

/** What one control command did. */
export type GraphControlResult =
  | GraphControlAppliedResult
  | {
    readonly kind: "refused";
    readonly graphId: string;
    readonly refusals: readonly GraphControlRefusal[];
  };

// ── Reading an applied answer ───────────────────────────────────────────────

/** Whether a value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether ONE value is a member of the control vocabulary
 * ({@link CONTROL_COMMAND_NAMES}).
 *
 * THE ONE RUNTIME NARROWING of a control command arriving as `unknown` — the
 * shape a serialized {@link GraphControlResult} comes back in. The list it reads
 * is the SAME closed vocabulary {@link ControlCommandName} is declared beside,
 * so a command this build does not define can never be read as one.
 */
export function isControlCommandName(value: unknown): value is ControlCommandName {
  return CONTROL_COMMAND_NAMES.some((name) => name === value);
}

/** What an APPLIED `graph_control` answer names. */
export interface AppliedControl {
  /** The graph the command was applied to. */
  readonly graphId: string;
  /** The command, from the CLOSED control vocabulary. */
  readonly command: ControlCommandName;
}

/**
 * Read one serialized `graph_control` answer as an APPLIED command, or
 * `undefined` when the value is not one this build may act on.
 *
 * WHY A READER AND NOT A CAST. The control tool renders the service's typed
 * {@link GraphControlResult} as JSON, so the host that post-processes a call
 * receives an `unknown` string and must decide — on the AUTHORIZATION path —
 * whether the answer authorizes handing a graph's cancel intents to a platform
 * and continuing a retried graph. Re-deriving `{graphId: string; command:
 * string | undefined}` there dropped the two facts the producer's own type
 * states: the discriminant literal and the command VOCABULARY. A renamed
 * discriminant, or a command added to the service without a matching wrapper
 * change, then compiled cleanly and silently stopped the hand-over. This reader
 * is the ONE place that serialized shape is understood.
 *
 * TOTAL AND FAIL-CLOSED. A value that is not a string, a string that is not
 * JSON, JSON that is not a plain record, a `kind` other than `"applied"`, a
 * `graphId` other than the graph THIS call named, and a `command` outside
 * {@link CONTROL_COMMAND_NAMES} all answer `undefined`: nothing is delivered and
 * nothing is continued.
 */
export function readAppliedControl(
  graphId: string,
  result: unknown,
): AppliedControl | undefined {
  if (graphId.length === 0) return undefined;
  if (typeof result !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed["kind"] !== "applied") return undefined;
  if (parsed["graphId"] !== graphId) return undefined;
  const command = parsed["command"];
  if (!isControlCommandName(command)) return undefined;
  return Object.freeze({ graphId, command });
}
