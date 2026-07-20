/**
 * Snapshot of a task's execution state, enabling mid-execution resume.
 * Saved at structured pause points during the task lifecycle.
 */
export interface CheckpointData {
  /** Task ID this checkpoint belongs to */
  task_id: string;
  /** Unique identifier for this checkpoint instance */
  checkpoint_id: string;
  /** Current phase label (e.g., "research", "implementation", "verification") */
  phase: string;
  /** Items that have been successfully completed so far */
  completed_items: string[];
  /** Items remaining to be processed */
  remaining_items: string[];
  /** Optional arbitrary metadata for extensibility */
  metadata?: Record<string, unknown>;
  /** ISO 8601 timestamp when this checkpoint was created */
  created_at: string;
  /** Time-to-live in milliseconds — the checkpoint may be garbage-collected after this duration */
  ttl_ms: number;
}

/**
 * Persistence contract for checkpoint operations.
 * Implementations may use an in-memory Map, SQLite, or any other backend.
 * All methods are async to support persistent backends without API changes.
 */
export interface CheckpointStore {
  /** Persist a checkpoint snapshot for the given task */
  saveCheckpoint(taskId: string, data: CheckpointData): Promise<void>;

  /** Retrieve the most recent checkpoint for a task, or null if none exist */
  getLatestCheckpoint(taskId: string): Promise<CheckpointData | null>;

  /** List all checkpoints for a task, newest first */
  listCheckpoints(taskId: string): Promise<CheckpointData[]>;

  /** Delete all checkpoints for a given task */
  deleteCheckpoint(taskId: string): Promise<void>;

  /** Remove expired checkpoints whose (created_at + ttl_ms) is in the past */
  cleanupExpired(ttlMs: number): Promise<void>;

  /** Build a human-readable retry context string from the latest checkpoint.
   *  Returns null when no checkpoint exists or the task is fully complete. */

  /** Check if at least one checkpoint exists for the given task.
   *  Cheaper than calling getLatestCheckpoint when only existence matters. */
  hasCheckpoint(taskId: string): Promise<boolean>;
}
