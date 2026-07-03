/**
 * Controls whether a new loop session inherits the parent's conversation
 * history ("inherit") or starts with a clean slate ("fresh").
 */
export type LoopMode = "inherit" | "fresh";

/**
 * Orchestrator phase of a loop execution.
 *
 * The state machine flows: activating → dispatching → awaiting_worker → summarizing → dispatching → ...
 * Terminal phases: complete | cancelled | interrupted | error
 *
 * - `activating`: The loop is being initialized (first round setup).
 * - `dispatching`: The loop is dispatching a round to DispatchManager.
 * - `awaiting_worker`: Waiting for the dispatched worker task to complete.
 * - `summarizing`: Generating a summary of the completed round.
 * - `finalizing`: Wrapping up the loop after all rounds are done.
 * - `complete`: All iterations finished successfully.
 * - `cancelled`: The loop was explicitly cancelled by user or agent request.
 * - `interrupted`: The loop was interrupted (e.g., session timeout).
 * - `error`: The loop encountered an unrecoverable error.
 */
export type LoopPhase =
  | "activating"
  | "dispatching"
  | "awaiting_worker"
  | "summarizing"
  | "finalizing"
  | "complete"
  | "cancelled"
  | "interrupted"
  | "error";

/**
 * Record of a single completed (or failed/cancelled) loop round.
 * Persisted in LoopState.rounds for post-hoc session discovery.
 */
export interface RoundRecord {
  /** 1-based round number */
  round: number;
  /** Dispatch task ID for this round's worker */
  workerTaskId: string;
  /** Session ID of the worker (key for session_read/session_info) */
  workerSessionId: string;
  /** Unix timestamp (ms) when the round was dispatched */
  startedAt: number;
  /** Unix timestamp (ms) when the round completed (undefined if still running) */
  completedAt?: number;
  /** Duration in milliseconds (completedAt - startedAt) */
  durationMs?: number;
  /** Terminal status of this round */
  status: "running" | "completed" | "error" | "cancelled";
}

/**
 * Full runtime state for a single loop execution.
 * Persisted between rounds to enable recovery and monitoring.
 */
export interface LoopState {
  /** Session ID of the origin (first) loop round */
  originSessionId: string;
  /** Name of the agent running the loop */
  agent: string;
  /** Base prompt sent to the agent each round */
  basePrompt: string;
  /** Loop mode — inherit conversation history or start fresh each round */
  mode: LoopMode;
  /** Total number of rounds requested (may be less if cancelled early) */
  total: number;
  /** Current round number (1-based; 1 = first round) */
  current: number;
  /** Current orchestrator phase */
  phase: LoopPhase;
  /** DispatchManager task ID for the active worker round */
  activeWorkerTaskId?: string;
  /** Session ID of the active worker round */
  activeWorkerSessionId?: string;
  /** Summary text produced after the most recent round */
  lastSummary?: string;
  /**
   * Message ID in the origin session that marks the boundary before the
   * current summarizing phase. Only messages AFTER this ID are captured
   * by readOriginSummary. Prevents summary accumulation across rounds.
   */
  summaryBoundaryMessageId?: string;
  /** Whether cancellation has been requested */
  cancelRequested: boolean;
  /** Error description when phase is "error" */
  errorReason?: string;
  /** Unix timestamp (ms) when the loop started */
  startedAt: number;
  /** Unix timestamp (ms) of the most recent state update */
  updatedAt: number;
  /** Unix timestamp (ms) when the current round started */
  roundStartedAt: number;
  /** History of all dispatched rounds with their worker session IDs */
  rounds?: RoundRecord[];
  /** Schema version for forward-compatible persistence */
  schemaVersion: number;
}
