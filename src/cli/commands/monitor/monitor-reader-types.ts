import type { MetricsSnapshot } from "../../../dispatch/persistence/metrics.ts";
import type { GraphEventType } from "../../../graph/engine/graph-events.ts";
import type { EnginePhase, NodeStatus } from "../../../constants.ts";

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
  /** Rich graph execution engine (v2) snapshots, read from engine-*.json files.
   *  Surfaced unfiltered: the engine is a multi-agent primitive with no
   *  graph-level sessionId to match against dispatch liveSessions, so a
   *  persisted engine graph appears even when no dispatch task sessionId
   *  equals its graphId (liveness is carried by the graph's own `phase`). */
  engineGraphs: EngineGraphSnapshot[];
  /** Recent durable graph events (graph-events-*.ndjson), chronological,
   *  limited to the most recent window. */
  graphEvents: GraphEvent[];
  /** Summary of task status counts computed from the tasks array */
  dispatchSummary: DispatchSummary;
  /** Aggregate concurrency status derived from metrics or dispatch state */
  concurrency: ConcurrencyStatus;

  /** Progress data per task (task_id -> latest progress summary).
   *  Populated from .rolebox/state/progress/ files.
   *  Optional — present when any progress files exist. */
  progress?: Record<string, {
    latest_stage: string;
    percentage?: number;
    message: string;
    event_count: number;
  }>;

  /** Checkpoint data per task (task_id -> latest checkpoint summary).
   *  Populated from .rolebox/state/checkpoints/ files.
   *  Optional — present when any checkpoint files exist. */
  checkpoints?: Record<string, {
    checkpoint_id: string;
    phase: string;
    completed_count: number;
    remaining_count: number;
    created_at: string;
  }>;
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

// ── Rich engine-graph snapshot (graph execution engine v2) ──────────

/**
 * Per-node projection of the graph engine v2 runtime state. Timestamps are
 * ISO-8601 strings (converted from the epoch-ms values the engine persists),
 * matching the rest of the monitor snapshot surface. Optional fields are
 * absent when the source data does not carry them.
 */
export interface GraphNodeSnapshot {
  /** Node ID from the graph declaration */
  nodeId: string;
  /** Agent identifier dispatched for this node */
  agent: string;
  /** Current node lifecycle status */
  status: NodeStatus;
  /** First signal the node observed (insertion order of `signalsObserved`), when any. */
  signalType?: string;
  /** ISO timestamp when the node started (absent for never-started nodes) */
  startedAt?: string;
  /** ISO timestamp when the node completed (absent while running) */
  completedAt?: string;
  /** Number of retries attempted */
  retryCount?: number;
  /** Loop group this node belongs to, if any */
  loopGroupId?: string;
  /** ID of the dispatch task spawned for this node (set when node enters running) */
  dispatchTaskId?: string;
  /** Session ID of the dispatch task spawned for this node */
  dispatchSessionId?: string;
}

/** Cumulative graph-level budget consumption projection. */
export interface EngineBudgetSnapshot {
  sessionsSpawned: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

/** Loop-group runtime projection. */
export interface EngineLoopGroupSnapshot {
  id: string;
  traversalCount: number;
  maxTraversals: number;
}

/**
 * Rich snapshot of a single graph execution engine (v2) persisted state file.
 *
 * Read from `engine-{slug}.json` via {@link readEngineGraphs}. The engine is a
 * multi-agent primitive, so there is no single owning `agentId` at graph level —
 * the field is reserved for provenance and is left unset by the reader.
 */
export interface EngineGraphSnapshot {
  /** Graph instance identifier */
  graphId: string;
  /** Engine lifecycle phase */
  phase: EnginePhase;
  /** Reserved graph-level agent provenance; not derivable from engine state. */
  agentId?: string;
  /** Total number of nodes in the graph */
  nodeCount: number;
  /** Per-status node counts, keyed by {@link NodeStatus} value */
  nodeStatusCounts: Record<string, number>;
  /** Per-node runtime snapshots */
  nodes: GraphNodeSnapshot[];
  /** Cumulative graph-level budget consumption */
  budget: EngineBudgetSnapshot;
  /** Node IDs awaiting dispatch (frontier set) */
  frontier: string[];
  /** Loop-group runtime snapshots */
  loopGroups: EngineLoopGroupSnapshot[];
  /** ISO timestamp when the graph started */
  startedAt: string;
  /** ISO timestamp of the last state update */
  updatedAt: string;
  /** Whether any per-node checkpoints have been recorded */
  hasCheckpoints: boolean;
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

/**
 * One graph event as read back from the durable event log
 * (`graph-events-{hash}.ndjson`). Mirrors the subset of {@link
 * GraphEventRecord} that the monitor surfaces: the write-side events
 * (`node_dispatched` / `node_completed` / `phase_change` / `budget_update`)
 * with their node-scoped and signal fields. Optional fields (`?`) are absent
 * when the serialized line omitted them — a `phase_change` line has no
 * `nodeId`, a `node_dispatched` line has no `signalType`, etc. The `budget`
 * snapshot of `budget_update` events is not projected onto this surface.
 */
export interface GraphEvent {
  /** Epoch-ms timestamp when the event was recorded. */
  ts: number;
  /** Owning graph id. */
  graphId: string;
  /** Node id — present for node-scoped events. */
  nodeId?: string;
  /** The event kind. */
  event: GraphEventType;
  /** Generic status: target `EnginePhase` / `NodeStatus` / `"running"`. */
  status?: string;
  /** Terminating signal for `node_completed` (`answer` / `revise_needed` / …). */
  signalType?: string;
  /** The node's bound agent id (node-scoped events). */
  agent?: string;
  /** When the node started (node-scoped events). */
  startedAt?: number;
  /** When the node completed (`node_completed`). */
  completedAt?: number;
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
