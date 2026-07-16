/**
 * An event emitted during task execution to signal incremental progress.
 * Designed for streaming progressive results — consumers can poll or
 * listen to these events to render live progress indicators.
 */
export interface ProgressEvent {
  /** Task ID this event belongs to */
  task_id: string;
  /** Optional completion percentage (0–100). Absent when unknown. */
  percentage?: number;
  /** Current stage label (e.g., "research", "implementing", "verifying") */
  stage: string;
  /** Human-readable progress message */
  message: string;
  /** ISO 8601 timestamp when this event was emitted */
  timestamp: string;
}

/**
 * Ordered collection of progress events for a single task.
 * Events are stored in chronological order (oldest first).
 */
export type ProgressStream = ProgressEvent[];

/**
 * In-memory store for task progress events.
 * Used by the dispatch manager to accumulate and serve progress data.
 */
export interface ProgressStore {
  /** Append a progress event to the task's stream */
  addProgressEvent(taskId: string, event: ProgressEvent): void;

  /** Retrieve all progress events for a task, optionally filtered to events after `since`.
   *  Returns events in chronological order. */
  getProgressStream(taskId: string, since?: string): ProgressEvent[];

  /** Remove all progress data for a specific task */
  clearProgress(taskId: string): void;

  /** Prune events for tasks that have not been updated within `ttlMs` milliseconds */
  cleanupExpired(ttlMs: number): void;
}
