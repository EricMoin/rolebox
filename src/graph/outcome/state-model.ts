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

export type OutcomeStopReason = "loop-exhausted" | "progress-stalled";

export const OUTCOME_STOP_REASONS: readonly OutcomeStopReason[] = Object.freeze([
  "loop-exhausted",
  "progress-stalled",
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

export type OutcomeStop = OutcomeLoopExhaustedStop | OutcomeProgressStalledStop;

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

export const CURRENT_OUTCOME_STATE_BODY = OUTCOME_STATE_BODY_V9;

