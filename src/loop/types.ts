/**
 * Controls whether a new loop session inherits the parent's conversation
 * history ("inherit") or starts with a clean slate ("fresh").
 */
export type LoopMode = "inherit" | "fresh";

/**
 * Lifecycle status of a loop execution.
 *
 * - `running`: The loop is actively executing a round.
 * - `summarizing`: The loop is generating a summary of the completed round.
 * - `spawning`: The loop is creating the next iteration's session.
 * - `waiting`: The loop is idle between rounds (INTER_ROUND_DELAY).
 * - `complete`: The loop finished all iterations successfully.
 * - `cancelled`: The loop was explicitly cancelled by user or agent request.
 * - `interrupted`: The loop was interrupted (e.g., session timeout).
 * - `error`: The loop encountered an unrecoverable error.
 */
export type LoopStatus =
  | "running"
  | "summarizing"
  | "spawning"
  | "waiting"
  | "complete"
  | "cancelled"
  | "interrupted"
  | "error";

/**
 * Full runtime state for a single loop execution.
 * Persisted between rounds to enable recovery and monitoring.
 */
export interface LoopState {
  /** Session ID of the origin (first) loop round */
  originSessionId: string;
  /** Name of the agent running the loop */
  agent: string;
  /** Loop prompt sent to the agent each round */
  prompt: string;
  /** Loop mode — inherit conversation history or start fresh each round */
  mode: LoopMode;
  /** Total number of rounds requested (may be less if cancelled early) */
  total: number;
  /** Current round number (1-based; 1 = origin round) */
  current: number;
  /** Current lifecycle status */
  status: LoopStatus;
  /** Session ID of the active round (origin for round 1, child session otherwise) */
  activeSessionId: string;
  /** Summary text produced after the most recent round */
  lastSummary?: string;
  /** Whether cancellation has been requested */
  cancelRequested: boolean;
  /** Error description when status is "error" */
  errorReason?: string;
  /** Unix timestamp (ms) when the loop started */
  startedAt: number;
  /** Unix timestamp (ms) of the most recent state update */
  updatedAt: number;
  /** Unix timestamp (ms) when the current round started */
  roundStartedAt: number;
  /** Schema version for forward-compatible persistence */
  schemaVersion: number;
}
