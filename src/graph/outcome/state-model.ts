import type { HostInvocationIdentity } from "./host-identity.ts";
import type { OutcomeLoopProgress } from "./progress.ts";
import type { DownstreamInputRefusal, ResolvedInput } from "./inputs.ts";

export type OutcomeNodeStatus = "pending" | "dispatched" | "settled";

/**
 * A node that was never dispatched. It carries no attempt identity, no
 * credential digest, no host binding, no outcome and no timestamp: the fields
 * body versions 9 and 10 define for a `pending` node, and none of the ones they
 * refuse for it. `arrivals` is required of EVERY node — `readNodeState` reads
 * the arrival list unconditionally and refuses a body that omits it
 * (`nodes[i].arrivals is undefined, not the predecessor arrival list …`), so a
 * pending node records the empty list too.
 *
 * The refused fields are declared `never` rather than omitted so that a read
 * through the union still type-checks — and answers `undefined`, exactly as an
 * absent field does today — while a value that CARRIES one is a compile error,
 * which is what the codec does at `rejectUnknownNodeFields`.
 */
export interface PendingNodeState {

  readonly nodeId: string;

  readonly status: "pending";

  readonly arrivals: readonly OutcomeArrival[];

  readonly inputRefusals?: readonly DownstreamInputRefusal[];

  readonly attemptId?: never;

  readonly attemptSeq?: never;

  readonly attemptCredentialDigest?: never;

  readonly dispatchIdentity?: never;

  readonly outcomeId?: never;

  readonly dispatchedAt?: never;

  readonly settledAt?: never;

  readonly inputs?: never;
}

/**
 * A node whose attempt is in flight. `attemptId`, `attemptSeq`,
 * `attemptCredentialDigest`, `dispatchedAt` and `arrivals` are the dispatch
 * facts `readNodeState` requires of every non-pending node — a dispatched body
 * that omits any of them is refused on the next read — so they are required
 * here too. The remaining fields are the ones a dispatched body may record
 * beside them. The outcome and settlement timestamp a settled body owns are
 * declared `never` here, because a dispatched node that carries either is
 * refused by the codec.
 */
export interface DispatchedNodeState {

  readonly nodeId: string;

  readonly status: "dispatched";

  readonly attemptId: string;

  readonly attemptSeq: number;

  readonly attemptCredentialDigest: string;

  readonly dispatchIdentity?: HostInvocationIdentity;

  readonly dispatchedAt: number;

  readonly arrivals: readonly OutcomeArrival[];

  readonly inputs?: readonly ResolvedInput[];

  readonly inputRefusals?: readonly DownstreamInputRefusal[];

  readonly outcomeId?: never;

  readonly settledAt?: never;
}

/**
 * A node whose attempt settled: it keeps every dispatch fact the reader
 * requires (`attemptId`, `attemptSeq`, `attemptCredentialDigest`,
 * `dispatchedAt`, `arrivals`) and adds the outcome that settled it and the
 * settlement timestamp.
 */
export interface SettledNodeState {

  readonly nodeId: string;

  readonly status: "settled";

  readonly attemptId: string;

  readonly attemptSeq: number;

  readonly attemptCredentialDigest: string;

  readonly dispatchIdentity?: HostInvocationIdentity;

  readonly outcomeId: string;

  readonly dispatchedAt: number;

  readonly settledAt: number;

  readonly arrivals: readonly OutcomeArrival[];

  readonly inputs?: readonly ResolvedInput[];

  readonly inputRefusals?: readonly DownstreamInputRefusal[];
}

/**
 * One node's progress, discriminated on `status`. The arms mirror the
 * per-status field sets body versions 9 and 10 define (`state-codec.ts`): the
 * fields a status requires are required, the ones it may carry beside them are
 * optional, and the ones the codec refuses for it are `never` — so a state the
 * reader would refuse is refused by the compiler first.
 */
export type OutcomeNodeState = PendingNodeState | DispatchedNodeState | SettledNodeState;

export interface OutcomeArrival {

  readonly from: string;

  readonly outcome: string;

  readonly attemptId: string;
}

export type OutcomeGraphPhase =
  | "ready"
  | "executing"
  | "complete"
  | "stopped";

/**
 * The stop reasons this build defines, in canonical order — the ONE source the
 * union and the reader share, so a reason cannot be declared without being
 * readable, nor readable without being declared.
 */
export const OUTCOME_STOP_REASONS = Object.freeze([
  "loop-exhausted",
  "progress-stalled",
  "unreachable-pending-node",
] as const);

/** One reason a run stopped, derived from {@link OUTCOME_STOP_REASONS}. */
export type OutcomeStopReason = (typeof OUTCOME_STOP_REASONS)[number];

export interface OutcomeLoopExhaustedStop {
  readonly reason: "loop-exhausted";

  readonly loopGroupId: string;

  readonly nodeId: string;

  readonly outcomeId: string;

  readonly attemptId: string;

  readonly traversals: number;

  readonly maxTraversals: number;

  readonly stoppedAt: number;
}

export interface OutcomeProgressStalledStop {
  readonly reason: "progress-stalled";

  readonly loopGroupId: string;

  readonly nodeId: string;

  readonly outcomeId: string;

  readonly attemptId: string;

  readonly unchanged: number;

  readonly maxUnchanged: number;

  readonly evaluator: string;

  readonly evaluatorVersion: number;

  readonly subject: string;

  readonly baseline: string;

  readonly stoppedAt: number;
}

/**
 * The run stopped because a node it still holds can NEVER be dispatched.
 *
 * This is the one stop that is not about a declared limit: nothing was
 * attempted and nothing is in flight, yet at least one node is still `pending`
 * and every feeder its join waits for has already settled without routing to
 * it — a feeder settled on an outcome that binds no edge to the node, or a
 * declared input whose producer never arrived. Waiting longer cannot change
 * that: no future advance can arm the node, so reporting the run complete would
 * announce work that was never done.
 *
 * `blockedNodes` names each stranded node and, for each, the feeder(s) that can
 * never arrive, so the abandonment is legible from the state itself rather than
 * re-derived by a reader.
 */
export interface OutcomeUnreachablePendingNodeStop {
  readonly reason: "unreachable-pending-node";

  /** Each stranded PENDING node, and the feeder(s) of it that can never arrive. */
  readonly blockedNodes: Readonly<Record<string, readonly string[]>>;

  readonly stoppedAt: number;
}

export type OutcomeStop =
  | OutcomeLoopExhaustedStop
  | OutcomeProgressStalledStop
  | OutcomeUnreachablePendingNodeStop;

/**
 * The list and the arms cannot drift: every listed reason must have an arm, and
 * every arm's reason must be listed. A member added to one side alone is a
 * compile error here rather than a persisted state the reader refuses.
 */
type AssertNever<T extends never> = T;
type _EveryStopReasonHasAnArm = AssertNever<
  Exclude<OutcomeStopReason, OutcomeStop["reason"]>
>;
type _EveryStopArmIsAStopReason = AssertNever<
  Exclude<OutcomeStop["reason"], OutcomeStopReason>
>;

export interface OutcomeGraphState {

  readonly bodyVersion: number;
  readonly graphId: string;

  readonly planRevision: string;
  readonly phase: OutcomeGraphPhase;

  readonly nodes: readonly OutcomeNodeState[];

  readonly loopTraversals: Readonly<Record<string, number>>;

  readonly attemptSeq: number;

  readonly stop?: OutcomeStop;

  readonly loopProgress: Readonly<Record<string, OutcomeLoopProgress>>;
}

export const OUTCOME_STATE_BODY_V1 = 1 as const;

export const OUTCOME_STATE_BODY_V2 = 2 as const;

export const OUTCOME_STATE_BODY_V3 = 3 as const;

export const OUTCOME_STATE_BODY_V4 = 4 as const;

export const OUTCOME_STATE_BODY_V5 = 5 as const;

export const OUTCOME_STATE_BODY_V6 = 6 as const;

export const OUTCOME_STATE_BODY_V7 = 7 as const;

export const OUTCOME_STATE_BODY_V8 = 8 as const;

export const OUTCOME_STATE_BODY_V9 = 9 as const;

/**
 * Version 10 adds the `unreachable-pending-node` stop record: a run that still
 * holds a node no advance can ever arm records WHY instead of announcing
 * completion over it. The node, phases and progress layouts are unchanged, so a
 * version-9 body is read by the version-9 reader installed beside this one; it
 * is not ADVANCED, because a body version names the vocabulary its writer could
 * produce and a version-9 writer could not produce this stop.
 */
export const OUTCOME_STATE_BODY_V10 = 10 as const;

export const CURRENT_OUTCOME_STATE_BODY = OUTCOME_STATE_BODY_V10;

