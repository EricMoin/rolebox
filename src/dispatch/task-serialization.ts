import type { DispatchTask, DispatchTaskStatus, TaskEventState } from "./types.ts";

// ─── Serialization Interfaces ──────────────────────────────────────────────

/**
 * JSON-serializable mirror of TaskProgress.
 * Uses ISO strings instead of Date objects for round-trip safety.
 */
export interface SerializedTaskProgress {
  lastUpdate: string;
  toolCalls: number;
}

/**
 * JSON-serializable mirror of MaterializedResultRef.
 * Only JSON-safe primitives — no Date objects.
 */
export interface SerializedMaterializedResultRef {
  sidecarPath: string;
  totalChars: number;
  hadFence: boolean;
  fetchError?: string;
  materializedAt: string;
}

/**
 * JSON-serializable mirror of DispatchTask.
 * Date fields are stored as ISO strings and deserialized back on load.
 */
export interface SerializedDispatchTask {
  id: string;
  sessionId: string;
  parentSessionId: string;
  parentAgent?: string;
  status: DispatchTaskStatus;
  agent: string;
  prompt: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  progress: SerializedTaskProgress;
  concurrencyKey?: string;
  continuationOf?: string;
  messageCountAtStart?: number;
  timeoutMs?: number;
  mode?: string;
  depth?: number;
  result?: SerializedMaterializedResultRef;
}

/**
 * JSON-serializable mirror of TaskEventState.
 * All fields are already JSON-safe primitives.
 */
export interface SerializedTaskEventState {
  lastMessageCount: number;
  lastProgressUpdate: number;
  hasProducedOutput: boolean;
  messageCountAtStart: number;
  lastEventAt: number;
  pendingConfirm?: { messageCount: number; at: number };
  consecutiveFetchFailures: number;
}

/**
 * On-disk state file schema.
 * Version field enables future schema migrations.
 */
export interface DispatchStateFile {
  version: 1 | 2 | 3 | 4 | 5;
  tasks: SerializedDispatchTask[];
  outbox?: string[];
  /** Per-task event-tracking state keyed by task ID. Optional — v5+ only. */
  eventState?: Record<string, SerializedTaskEventState>;
}
