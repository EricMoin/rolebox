import type { MetricsSnapshot } from "../../dispatch/metrics.ts";

// ── Public types ────────────────────────────────────────────────────

export interface TaskSnapshot {
  id: string;
  status: "pending" | "running" | "completed" | "error" | "cancelled" | "timeout";
  agent: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  error?: string;
  depth: number;
  mode: "background" | "sync";
  /** Session ID of the task (the worker session, not the parent) */
  sessionId?: string;
  /** Last N characters of the task's output (populated when tailChars > 0) */
  resultPreview?: string;
  /** Total character count of the full result */
  resultTotalChars?: number;
  /** Full result text (lazy-loaded, only populated by readTaskDetail) */
  resultFullText?: string;

  // ── Liveness / event-tracking fields ────────────────────────────
  /** ISO timestamp of the most recent event routed for this task */
  lastEventAt?: string;
  /** ISO timestamp of the most recent progress update */
  lastProgressUpdate?: string;
  /** Whether the sub-agent has produced any output so far */
  hasProducedOutput?: boolean;
  /** Total number of tool calls observed */
  toolCalls?: number;
  /** Consecutive fetch failures since last successful progress update */
  consecutiveFetchFailures?: number;
  /** Configured stale timeout in ms for this task */
  staleTimeoutMs?: number;
  /** Milliseconds since the last activity (progress update or event).
   *  Computed as Date.now() - max(lastProgressUpdate, lastEventAt, createdAt). */
  lastActivityAgoMs?: number;
}

export interface ActiveFunction {
  sessionId: string;
  agentId: string | null;
  name: string;
  phase: "active" | "gated" | "complete";
  continuationCount: number;
  /** Current turn number in the session */
  currentTurn?: number;
  /** Turn at which the function was activated */
  activatedAtTurn?: number;
  /** Whether the gate condition has been satisfied */
  gateSatisfied?: boolean;
  /** Turn until which the function is in cooldown */
  cooldownUntilTurn?: number;
  /** Tools observed being used during this function's activation */
  toolsObserved?: string[];
  /** Evidence types observed (keys of the evidenceObserved map) */
  evidenceObserved?: string[];
}

export interface MonitorSnapshot {
  projectDir: string;
  timestamp: string;
  tasks: TaskSnapshot[];
  activeFunctions: ActiveFunction[];
  metrics?: MetricsSnapshot;
  metricsRecentEvents?: NDJSONEvent[];
  notifications?: NotificationState;
  /** Recovery metrics snapshot, present when the persisted file has a `recovery` key. */
  recovery?: RecoveryMetrics;
  /** Non-terminal loop execution snapshots */
  loops: LoopSnapshot[];
  /** Full graph execution state snapshots (frontier, completed, status) */
  graphSessions: GraphSessionSnapshot[];
  /** Summary of task status counts computed from the tasks array */
  dispatchSummary: DispatchSummary;
  /** Aggregate concurrency status derived from metrics or dispatch state */
  concurrency: ConcurrencyStatus;
  }

export interface LoopSnapshot {
  /** Session ID of the origin loop session */
  originSessionId: string;
  /** Name of the agent running the loop */
  agent: string;
  /** Current orchestrator phase */
  phase: string;
  /** Current round number (1-based) */
  current: number;
  /** Total number of rounds requested */
  total: number;
  /** Loop mode (inherit conversation or fresh start) */
  mode: string;
  /** Elapsed milliseconds since the loop started */
  elapsedMs: number;
  /** Error description when the loop is in error phase */
  errorReason?: string;
  /** Session ID of the active worker round (if any) */
  activeWorkerSessionId?: string;
}

export interface GraphSessionSnapshot {
  /** Session ID of the graph session */
  sessionId: string;
  /** Agent ID assigned to this session */
  agentId: string;
  /** Execution status of the graph */
  status: "active" | "complete" | "exhausted";
  /** Current frontier nodes (nodes awaiting dispatch) */
  frontier: string[];
  /** Nodes that have completed execution */
  completed: string[];
  /** Number of iterations executed */
  iterationCount: number;
  /** Termination reason, null while active, absent when not-terminated */
  terminationReason?: string | null;
}

export interface DispatchSummary {
  /** Number of tasks with status pending */
  pending: number;
  /** Number of tasks with status running */
  running: number;
  /** Number of tasks with status completed */
  completed: number;
  /** Number of tasks with status error */
  error: number;
  /** Number of tasks with status cancelled */
  cancelled: number;
}

export interface ConcurrencyStatus {
  /** Total actively executing tasks across all concurrency slots */
  active: number;
  /** Total concurrency slot limit across all keys */
  limit: number;
  /** Total tasks queued waiting for concurrency slots */
  queued: number;
}

export interface NDJSONEvent {
  ts: string;
  counters: Record<string, unknown>;
  gauges: Record<string, unknown>;
  histograms?: Record<string, unknown>;
}

export interface NotificationState {
  enabled: boolean;
  quietHoursActive: boolean;
  recentEvents: Array<{ ts: string; type: string }>;
  throttleStats?: { recentCount: number; windowMs: number };
}

/**
 * Recovery metrics as persisted in the metrics-*.json file.
 * Mirrors the RecoveryMetricsSnapshot shape from the recovery subsystem.
 * Optional — only present when a recovery engine is wired and metrics are enabled.
 */
export interface RecoveryMetrics {
  totalAttempts: number;
  successfulRecoveries: number;
  abortedChains: number;
  exhaustedChains: number;
  byCategory: Record<string, { attempts: number; successes: number }>;
  byStrategy: Record<string, { attempts: number; successes: number }>;
  errorTypeFrequency: Record<string, number>;
}

export interface TaskDetail {
  task: TaskSnapshot;
  fullText: string;
  totalChars: number;
  offset: number;
  limit?: number;
  truncated: boolean;
}
