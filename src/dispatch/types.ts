/**
 * Lifecycle status of a dispatched sub-agent task.
 * Reflects current state from creation through completion or failure.
 */
export type DispatchTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "cancelled"
  | "timeout";

/**
 * Runtime progress snapshot for an in-flight task.
 * Tracks recency of activity and cumulative tool usage.
 */
export interface TaskProgress {
  /** Timestamp of the most recent status update or heartbeat */
  lastUpdate: Date;
  /** Total number of tool calls made by the sub-agent so far */
  toolCalls: number;
}

/**
 * Full state record for a dispatched task.
 * Created when a parent agent calls task() and updated throughout the
 * task lifecycle by the dispatch manager's polling loop.
 */
export interface DispatchTask {
  /** Unique identifier for this task instance */
  id: string;
  /** The opencode session ID where this sub-agent is running */
  sessionId: string;
  /** Session ID of the parent agent that dispatched this task */
  parentSessionId: string;
  /** Current lifecycle status */
  status: DispatchTaskStatus;
  /** Sub-agent name (matches the resolved sub-agent ID) */
  agent: string;
  /** Prompt text sent to the sub-agent */
  prompt: string;
  /** Optional human-readable description of the task's purpose */
  description?: string;
  /** ISO timestamp when the task was created */
  startedAt: Date;
  /** ISO timestamp when the task completed, errored, or was cancelled */
  completedAt?: Date;
  /** Error message when status is "error" */
  error?: string;
  /** Runtime progress metrics */
  progress: TaskProgress;
}

/**
 * Input parameters for the dispatch tool (task() call).
 * Maps directly to the tool's argument schema.
 */
export interface DispatchInput {
  /** Sub-agent identifier to dispatch to */
  subagent: string;
  /** Prompt text for the sub-agent to execute */
  prompt: string;
  /** Whether to run asynchronously in the background */
  run_in_background: boolean;
  /** Optional description surfaced in the UI or logs */
  description?: string;
  /** Optional session ID to reuse (creates a new session if omitted) */
  session_id?: string;
}

/**
 * Result returned by the dispatch tool after submitting a task.
 * Provides the caller with a handle for tracking progress.
 */
export interface DispatchResult {
  /** Task ID assigned by the dispatch manager */
  task_id: string;
  /** Session ID where the sub-agent is running */
  session_id: string;
  /** Final output text if the task completed synchronously */
  output?: string;
  /** Final or current task lifecycle status */
  status: DispatchTaskStatus;
}

/**
 * Configurable limits and intervals for the dispatch manager.
 * Re-exported from config.ts for backward compatibility.
 */
export type { DispatchManagerConfig } from "./config.js";

/**
 * Payload for task lifecycle notifications emitted to the parent agent.
 * Sent when a background task completes or fails.
 */
export interface NotificationPayload {
  /** Task ID that triggered this notification */
  taskId: string;
  /** Optional description from the original dispatch call */
  description?: string;
  /** Human-readable duration string (e.g., "2.3s", "1m 5s") */
  duration: string;
  /** Final task status */
  status: DispatchTaskStatus;
  /** Number of remaining in-flight or queued background tasks */
  remainingTasks: number;
}

// ─── Global Poller Internal Types ─────────────────────────────────────────

/** Signal emitted by the completion detector */
export type CompletionSignal =
  | { type: "completed" }
  | { type: "error"; message: string }
  | { type: "not_ready" }
  | { type: "stabilizing" };

/** Structured message data for completion detection */
export interface SessionMessageSnapshot {
  info: { role: string; id: string; finish?: string; error?: unknown };
  parts: Array<{ type: string; state?: string; text?: string }>;
}

/** Per-task polling metadata tracked by global poller */
export interface TaskPollState {
  consecutiveMissedPolls: number;
  stableIdlePolls: number;
  lastMessageCount: number;
  lastProgressUpdate: number;
  hasProducedOutput: boolean;
}
