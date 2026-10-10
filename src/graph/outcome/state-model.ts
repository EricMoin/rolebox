import type { HostInvocationIdentity } from "./host-identity.ts";
import type { OutcomeLoopProgress } from "./progress.ts";
import type { DownstreamInputRefusal, ResolvedInput } from "./inputs.ts";

export type OutcomeNodeStatus = "pending" | "dispatched" | "settled";

export interface OutcomeNodeState {

  readonly nodeId: string;
  readonly status: OutcomeNodeStatus;

  readonly attemptId?: string;

  readonly attemptSeq?: number;

  readonly attemptCredentialDigest?: string;

  readonly dispatchIdentity?: HostInvocationIdentity;

  readonly outcomeId?: string;

  readonly dispatchedAt?: number;

  readonly settledAt?: number;

  readonly arrivals?: readonly OutcomeArrival[];

  readonly inputs?: readonly ResolvedInput[];

  readonly inputRefusals?: readonly DownstreamInputRefusal[];
}

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

export type OutcomeStopReason =
  | "loop-exhausted"
  | "progress-stalled"
  | "unreachable-pending-node";

export const OUTCOME_STOP_REASONS: readonly OutcomeStopReason[] = Object.freeze([
  "loop-exhausted",
  "progress-stalled",
  "unreachable-pending-node",
]);

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

export interface OutcomeGraphState {

  readonly bodyVersion: number;
  readonly graphId: string;

  readonly planRevision: string;
  readonly phase: OutcomeGraphPhase;

  readonly nodes: readonly OutcomeNodeState[];

  readonly loopTraversals: Readonly<Record<string, number>>;

  readonly attemptSeq: number;

  readonly stop?: OutcomeStop;

  readonly loopProgress?: Readonly<Record<string, OutcomeLoopProgress>>;
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

