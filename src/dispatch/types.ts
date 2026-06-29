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
 * Reference to materialized (persisted) task output.
 * Carries path + metadata so readers can decide whether to fetch the
 * sidecar without loading the full text into memory.
 *
 * The persisted schema (state file) will also carry an `outbox: string[]`
 * field alongside this ref — see T5.
 */
export interface MaterializedResultRef {
  /** Absolute path to state/results/{taskId}.txt sidecar file */
  sidecarPath: string;
  /** Total character count of the materialized full text */
  totalChars: number;
  /** Whether the output contained a ```result fence */
  hadFence: boolean;
  /** Set when materialization failed (timeout/SDK error); sidecar may be empty */
  fetchError?: string;
  /** ISO timestamp of when materialization completed */
  materializedAt: string;
}

/**
 * Full state record for a dispatched task.
 * Created when a parent agent calls task() and updated throughout the
 * task lifecycle by the dispatch manager's polling loop.
 *
 * NOTE: The persisted schema will later gain a top-level `outbox: string[]`
 * field (not per-task) — see T5.
 */
export interface DispatchTask {
  /** Unique identifier for this task instance */
  id: string;
  /** The opencode session ID where this sub-agent is running */
  sessionId: string;
  /** Session ID of the parent agent that dispatched this task */
  parentSessionId: string;
  /** Nesting depth: 0 for direct dispatch, 1 for sub-sub-agent, etc. */
  depth: number;
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
  /** Optional concurrency key, set during launch for recovered tasks */
  concurrencyKey?: string;
  /** Task ID this continues from (set on re-prompt continuation) */
  continuationOf?: string;
  /** Message count at continuation time — used as lower bound for output detection */
  messageCountAtStart?: number;
  /** Per-task timeout in ms. Overrides background default. Set from DispatchInput.timeout_ms. */
  timeoutMs?: number;
  /** Execution mode: "background" (async, default) or "sync" (blocks caller). */
  mode?: "background" | "sync";
  /** Reference to materialized output once the task completes.
   *  Populated by the completion/harvest pipeline after `result` signal
   *  is emitted.  Absent until then. */
  result?: MaterializedResultRef;
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
  /** Optional per-task timeout in milliseconds (overrides background default). Only applies to background tasks. */
  timeout_ms?: number;
  /** Timeout for the prompt phase of sync dispatch. Overrides syncPromptTimeoutMs config. */
  sync_timeout_ms?: number;
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
export type { DispatchManagerConfig } from "./config.ts";

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

// ─── Dispatch Event-Tracking Types ─────────────────────────────────────────

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

/** Per-task event-tracking metadata (replaces poll-era TaskPollState). */
export interface TaskEventState {
  lastMessageCount: number;
  lastProgressUpdate: number;
  hasProducedOutput: boolean;
  /** Lower bound for completion detection — only messages after this count are from the current run */
  messageCountAtStart: number;
  /** Timestamp of the last routed event for this task (liveness). */
  lastEventAt: number;
  /** One-shot re-confirmation guard: set when idle-debounce first signals completion.
   *  Cleared on re-check if message count changed (model continued).
   *  Capped at exactly one re-check — no livelock. */
  pendingConfirm?: { messageCount: number; at: number };
}
