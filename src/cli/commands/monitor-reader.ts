import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { normalizeWorkspaceDir, stateDirFor } from "../../state-paths.ts";
import { readResultSidecar, resultSidecarPath } from "../../dispatch/result-extractor.ts";
import type { MetricsSnapshot } from "../../dispatch/metrics.ts";

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

interface RawDispatchTask {
  id: string;
  sessionId: string;
  status: string;
  agent: string;
  description?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  depth?: number;
  mode?: string;
  result?: { sidecarPath: string; totalChars: number };
}

interface RawDispatchFile {
  version: number;
  tasks: RawDispatchTask[];
}

interface RawFnEntry {
  name: string;
  state: {
    phase: string;
    continuationCount: number;
    currentTurn?: number;
    activatedAtTurn?: number;
    gateSatisfied?: boolean;
    cooldownUntilTurn?: number;
    toolsObserved?: string[];
    evidenceObserved?: Record<string, unknown>;
    schemaVersion?: number;
  };
}

interface RawFnSession {
  sessionId: string;
  fns: RawFnEntry[];
}

interface RawFnStateFile {
  version: number;
  sessions: RawFnSession[];
}

interface RawGraphSession {
  sessionId: string;
  agentId: string;
}

interface RawGraphFile {
  version: number;
  sessions: RawGraphSession[];
}

// ── Loop file raw types ──────────────────────────────────────────────

interface RawLoopState {
  originSessionId: string;
  agent: string;
  phase: string;
  current: number;
  total: number;
  mode: string;
  startedAt: number;
  updatedAt: number;
  errorReason?: string;
  activeWorkerSessionId?: string;
  activeWorkerTaskId?: string;
}

interface RawLoopEntry {
  id: string;
  state: RawLoopState;
}

interface RawLoopFile {
  version: number;
  loops: RawLoopEntry[];
}

// ── Full graph session with execution state ──────────────────────────

interface RawGraphSessionFull {
  sessionId: string;
  agentId: string;
  state: {
    frontier: string[];
    completed: string[];
    iterationCount: number;
    status: string;
    loopCounters?: Record<string, number>;
    lastResults?: Record<string, { hash: string; text: string }>;
    loopStartTimeMs?: number;
    terminationReason?: string | null;
    correctionCount?: number;
    convergenceSignal?: string;
  };
}

interface RawGraphFileFull {
  version: number;
  sessions: RawGraphSessionFull[];
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function tryReadJson(filePath: string): unknown | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return null;
    const message =
      err instanceof SyntaxError
        ? `Malformed JSON in ${filePath}: ${err.message}`
        : `Failed to read ${filePath}: ${(err as Error).message}`;
    console.warn(`[monitor-reader] ${message}`);
    return null;
  }
}

function listStateFiles(stateDir: string, prefix: string): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => join(stateDir, f));
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return [];
    console.warn(`[monitor-reader] Failed to list ${stateDir}: ${(err as Error).message}`);
    return [];
  }
}

function computeDurationMs(startedAt: string | undefined, completedAt?: string): number {
  try {
    const start = startedAt ? new Date(startedAt).getTime() : NaN;
    if (isNaN(start)) return 0;
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    return Math.max(0, end - start);
  } catch {
    return 0;
  }
}

function listNDJSONFiles(stateDir: string, prefix: string): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".ndjson"))
      .map((f) => join(stateDir, f));
  } catch (err: unknown) {
    if (isErrno(err) && err.code === "ENOENT") return [];
    console.warn(`[monitor-reader] Failed to list ${stateDir}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Parse the metrics sidecar JSON file and NDJSON event log from the state
 * directory. Returns the MetricsSnapshot (the `metrics` field from the sidecar
 * file) or null if no valid metrics file exists.
 *
 * Also populates `recentEvents` with the last N lines of the NDJSON event log.
 * Handles missing files, malformed JSON, and partial data gracefully (returns
 * null, never throws).
 */
export function readMetricsSnapshot(
  stateDir: string,
  opts?: { maxEventLines?: number },
): MetricsSnapshot | null {
  const maxEventLines = opts?.maxEventLines ?? 20;

  // Read the metrics JSON sidecar
  const metricsFiles = listStateFiles(stateDir, "metrics-");
  if (metricsFiles.length === 0) return null;

  for (const filePath of metricsFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.metrics !== "object" || obj.metrics === null) continue;
    const metrics = obj.metrics as MetricsSnapshot;
    if (typeof metrics.counters !== "object" || typeof metrics.gauges !== "object") continue;
    return metrics;
  }

  return null;
}

/**
 * Read the last N lines of the NDJSON event log (metrics-events-*.ndjson) and
 * return them as parsed NDJSONEvent objects. Returns an empty array when the
 * log file does not exist or cannot be read.
 */
export function readMetricsRecentEvents(
  stateDir: string,
  maxLines = 20,
): NDJSONEvent[] {
  const eventFiles = listNDJSONFiles(stateDir, "metrics-events-");
  if (eventFiles.length === 0) return [];

  for (const filePath of eventFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const lastLines = lines.slice(-maxLines);
      const events: NDJSONEvent[] = [];

      for (const line of lastLines) {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.ts === "string"
          ) {
            events.push({
              ts: parsed.ts,
              counters: parsed.counters ?? {},
              gauges: parsed.gauges ?? {},
              histograms: parsed.histograms,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (events.length > 0) return events;
    } catch {
      // Skip unreadable files
    }
  }

  return [];
}

/**
 * Scan the state directory for notification sidecar files (notifications-*.json)
 * and return a best-effort NotificationState. Returns null when no notification
 * state file exists (notifications subsystem may be disabled).
 *
 * The notification subsystem does not persist runtime state to disk by default,
 * so this reader returns null gracefully when no data is found.
 */
export function readNotificationState(stateDir: string): NotificationState | null {
  const notifFiles = listStateFiles(stateDir, "notifications-");
  if (notifFiles.length === 0) return null;

  for (const filePath of notifFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
    let quietHoursActive = false;

    // Compute quietHoursActive from quietHours config if present
    if (typeof obj.quietHours === "object" && obj.quietHours !== null) {
      const qh = obj.quietHours as Record<string, unknown>;
      if (qh.enabled === true) {
        // Best-effort: if quiet hours are configured as enabled, report active
        // A full evaluation would require time-of-day checking
        quietHoursActive = true;
      }
    }

    // Throttle stats if available
    let throttleStats: { recentCount: number; windowMs: number } | undefined;
    if (typeof obj.throttle === "object" && obj.throttle !== null) {
      const th = obj.throttle as Record<string, unknown>;
      if (typeof th.windowMs === "number" && typeof th.maxPerWindow === "number") {
        throttleStats = {
          recentCount: th.maxPerWindow as number,
          windowMs: th.windowMs as number,
        };
      }
    }

    // Recent notification events if stored
    const recentEvents: Array<{ ts: string; type: string }> = [];
    if (Array.isArray(obj.recentEvents)) {
      for (const evt of obj.recentEvents) {
        if (
          evt &&
          typeof evt === "object" &&
          typeof (evt as Record<string, unknown>).ts === "string" &&
          typeof (evt as Record<string, unknown>).type === "string"
        ) {
          recentEvents.push({
            ts: (evt as Record<string, unknown>).ts as string,
            type: (evt as Record<string, unknown>).type as string,
          });
        }
      }
    }

    return { enabled, quietHoursActive, recentEvents, throttleStats };
  }

  return null;
}

/**
 * Parse the `recovery` key from the metrics-*.json sidecar file.
 * Returns a RecoveryMetrics object when the key is present and valid,
 * or null when absent, malformed, or the metrics file doesn't exist.
 *
 * The `recovery` key is optional in the persisted file — absent when no
 * recovery engine is wired or when ROLEBOX_METRICS is disabled.
 */
export function readRecoveryMetrics(stateDir: string): RecoveryMetrics | null {
  const metricsFiles = listStateFiles(stateDir, "metrics-");
  if (metricsFiles.length === 0) return null;

  for (const filePath of metricsFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const recovery = obj.recovery;
    if (!recovery || typeof recovery !== "object") continue;
    const r = recovery as Record<string, unknown>;
    if (
      typeof r.totalAttempts === "number" &&
      typeof r.successfulRecoveries === "number" &&
      typeof r.abortedChains === "number" &&
      typeof r.exhaustedChains === "number"
    ) {
      return r as unknown as RecoveryMetrics;
    }
  }

  return null;
}

const TERMINAL_LOOP_PHASES = new Set([
  "complete",
  "cancelled",
  "interrupted",
  "error",
]);

const CONCURRENCY_GAUGE_ACTIVE = "concurrency_active";
const CONCURRENCY_GAUGE_QUEUED = "concurrency_queued";
const CONCURRENCY_GAUGE_LIMIT = "concurrency_limit";

/**
 * Parse all `loops-{hash}.json` files in the state directory and return
 * LoopSnapshot entries for non-terminal loops only.
 *
 * The loop coordinator persists the full LoopState map via LoopStore.
 * Terminal phases (complete, cancelled, interrupted, error) are excluded.
 * Returns an empty array when no loop files exist.
 */
export function readLoopSnapshots(stateDir: string): LoopSnapshot[] {
  const loopFiles = listStateFiles(stateDir, "loops-");
  if (loopFiles.length === 0) return [];

  const snapshots: LoopSnapshot[] = [];

  for (const filePath of loopFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object" || !("loops" in raw)) continue;
    const file = raw as RawLoopFile;
    if (!Array.isArray(file.loops)) continue;

    for (const entry of file.loops) {
      if (!entry.state || typeof entry.state !== "object") continue;
      const st = entry.state;

      // Skip terminal phases
      if (typeof st.phase === "string" && TERMINAL_LOOP_PHASES.has(st.phase)) continue;

      const startedAt =
        typeof st.startedAt === "number" ? st.startedAt : 0;
      const elapsedMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;

      snapshots.push({
        originSessionId: st.originSessionId ?? entry.id,
        agent: st.agent ?? "",
        phase: st.phase ?? "unknown",
        current: typeof st.current === "number" ? st.current : 0,
        total: typeof st.total === "number" ? st.total : 0,
        mode: st.mode ?? "inherit",
        elapsedMs,
        errorReason: st.errorReason,
        activeWorkerSessionId: st.activeWorkerSessionId,
      });
    }
  }

  return snapshots;
}

/**
 * Parse all `graph-{hash}.json` files in the state directory and return
 * the full GraphSessionSnapshot array including execution state (frontier,
 * completed, iterationCount, status, terminationReason).
 *
 * Unlike the existing session-id-to-agent mapping that only extracts
 * sessionId/agentId, this reader also extracts the GraphExecutionState
 * that the graph state machine persists for each session.
 * Returns an empty array when no graph files exist.
 */
export function readGraphSessions(stateDir: string): GraphSessionSnapshot[] {
  const graphFiles = listStateFiles(stateDir, "graph-");
  if (graphFiles.length === 0) return [];

  const snapshots: GraphSessionSnapshot[] = [];

  for (const filePath of graphFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object" || !("sessions" in raw)) continue;
    const file = raw as RawGraphFileFull;
    if (!Array.isArray(file.sessions)) continue;

    for (const gs of file.sessions) {
      if (!gs.state || typeof gs.state !== "object") continue;
      const state = gs.state;

      // Map any status-like string to the union; fallback to "active"
      let status: GraphSessionSnapshot["status"] = "active";
      if (state.status === "complete") status = "complete";
      else if (state.status === "exhausted") status = "exhausted";

      snapshots.push({
        sessionId: gs.sessionId ?? "",
        agentId: gs.agentId ?? "",
        status,
        frontier: Array.isArray(state.frontier) ? state.frontier : [],
        completed: Array.isArray(state.completed) ? state.completed : [],
        iterationCount:
          typeof state.iterationCount === "number" ? state.iterationCount : 0,
        terminationReason: state.terminationReason,
      });
    }
  }

  return snapshots;
}

/**
 * Compute a DispatchSummary from an array of TaskSnapshot objects.
 * Counts tasks by their status field.
 */
export function computeDispatchSummary(tasks: TaskSnapshot[]): DispatchSummary {
  let pending = 0;
  let running = 0;
  let completed = 0;
  let error = 0;
  let cancelled = 0;

  for (const t of tasks) {
    switch (t.status) {
      case "pending":
        pending++;
        break;
      case "running":
        running++;
        break;
      case "completed":
        completed++;
        break;
      case "error":
        error++;
        break;
      case "cancelled":
        cancelled++;
        break;
      // "timeout" is counted as error for summary purposes
      default:
        break;
    }
  }

  return { pending, running, completed, error, cancelled };
}

/**
 * Compute an aggregate ConcurrencyStatus from a MetricsSnapshot.
 *
 * Scans the metrics gauges for keys matching known concurrency gauge
 * patterns (concurrency_active, concurrency_queued, concurrency_limit)
 * and aggregates their values across all model keys.
 *
 * Returns a zeroed ConcurrencyStatus when no metrics or no concurrency
 * gauges are present.
 */
export function computeConcurrencyStatus(
  metrics: MetricsSnapshot | null | undefined,
): ConcurrencyStatus {
  const result: ConcurrencyStatus = { active: 0, limit: 0, queued: 0 };

  if (!metrics) return result;

  // Aggregate across all model keys by matching gauge name prefix
  for (const [key, gs] of Object.entries(metrics.gauges)) {
    if (key.startsWith(CONCURRENCY_GAUGE_ACTIVE + "{") || key === CONCURRENCY_GAUGE_ACTIVE) {
      result.active += gs.value;
    } else if (key.startsWith(CONCURRENCY_GAUGE_QUEUED + "{") || key === CONCURRENCY_GAUGE_QUEUED) {
      result.queued += gs.value;
    } else if (key.startsWith(CONCURRENCY_GAUGE_LIMIT + "{") || key === CONCURRENCY_GAUGE_LIMIT) {
      result.limit += gs.value;
    }
  }

  return result;
}


/**
 * Read the full result sidecar for a specific task.
 *
 * Uses `resultSidecarPath` + `readResultSidecar` from the result-extractor
 * module. Returns a TaskDetail with the task snapshot, full text (or windowed
 * via offset/limit), total character count, and truncation info.
 *
 * Returns null when the sidecar file does not exist.
 */
export function readTaskDetail(
  projectDir: string,
  taskId: string,
  offset = 0,
  limit?: number,
): TaskDetail | null {
  const sidecarPath = resultSidecarPath(taskId, projectDir);
  const fullText = readResultSidecar(sidecarPath);
  if (fullText === null) return null;

  const totalChars = fullText.length;
  const effectiveLimit = limit ?? totalChars;

  // Apply offset/limit window
  let windowText: string;
  let truncated: boolean;

  if (offset >= totalChars) {
    windowText = "";
    truncated = false;
  } else {
    windowText = fullText.slice(offset, offset + effectiveLimit);
    truncated = windowText.length < totalChars - offset;
  }

  // Build a minimal TaskSnapshot for the detail
  const task: TaskSnapshot = {
    id: taskId,
    status: "pending",
    agent: "",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    depth: 0,
    mode: "sync",
    resultFullText: fullText,
    resultTotalChars: totalChars,
  };

  return {
    task,
    fullText: windowText,
    totalChars,
    offset,
    limit: effectiveLimit,
    truncated,
  };
}

/**
 * Walk up from `start` to the nearest ancestor that already has a
 * `.rolebox/state` directory, so `monitor` works from any sub-directory of the
 * project (opencode keys state by the project root, not the shell's cwd).
 * Normalized so the result matches the directory the plugin wrote under.
 */
export function resolveProjectRoot(start: string): string {
  const normalizedStart = normalizeWorkspaceDir(start);
  let dir = normalizedStart;
  for (let i = 0; i < 64; i++) {
    if (existsSync(stateDirFor(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return normalizedStart;
}

export function readMonitorSnapshot(projectDir: string, tailChars = 0): MonitorSnapshot {
  const stateDir = stateDirFor(projectDir);

  // Scan every state file rather than recomputing a single hashed name: the
  // monitor then surfaces activity even if the writer's directory hash differs
  // (symlinked/worktree paths, legacy files), which is the whole point here.
  const taskById = new Map<string, TaskSnapshot>();
  const sessionAgentMap = new Map<string, string>();
  const liveSessions = new Set<string>();
  for (const dispatchPath of listStateFiles(stateDir, "dispatch-")) {
    const dispatchRaw = tryReadJson(dispatchPath);
    if (!dispatchRaw || typeof dispatchRaw !== "object" || !("tasks" in dispatchRaw)) continue;
    const file = dispatchRaw as RawDispatchFile;
    if (!Array.isArray(file.tasks)) continue;
    for (const st of file.tasks) {
      if (st.sessionId && st.agent) sessionAgentMap.set(st.sessionId, st.agent);
      if (st.sessionId && (st.status === "running" || st.status === "pending")) {
        liveSessions.add(st.sessionId);
      }

      let resultPreview: string | undefined;
      let resultTotalChars: number | undefined;
      if (tailChars > 0 && st.result?.sidecarPath) {
        resultTotalChars = st.result.totalChars;
        const full = readResultSidecar(st.result.sidecarPath);
        if (full !== null) {
          resultPreview = full.length > tailChars
            ? full.slice(-tailChars)
            : full;
        }
      }

      taskById.set(st.id, {
        id: st.id,
        status: st.status as TaskSnapshot["status"],
        agent: st.agent,
        description: st.description,
        startedAt: st.startedAt,
        completedAt: st.completedAt,
        durationMs: computeDurationMs(st.startedAt, st.completedAt),
        error: st.error,
        depth: st.depth ?? 0,
        mode: (st.mode as "background" | "sync") ?? "background",
        sessionId: st.sessionId,
        resultPreview,
        resultTotalChars,
      });
    }
  }

  let activeFunctions: ActiveFunction[] = [];
  const seenFn = new Set<string>();
  for (const fnstatePath of listStateFiles(stateDir, "fnstate-")) {
    const fnstateRaw = tryReadJson(fnstatePath);
    if (!fnstateRaw || typeof fnstateRaw !== "object" || !("sessions" in fnstateRaw)) continue;
    const file = fnstateRaw as RawFnStateFile;
    if (!Array.isArray(file.sessions)) continue;
    for (const session of file.sessions) {
      if (!session.sessionId || !Array.isArray(session.fns)) continue;
      for (const fn of session.fns) {
        if (!fn.state || fn.state.phase === "complete") continue;
        const key = `${session.sessionId}\u0000${fn.name}`;
        if (seenFn.has(key)) continue;
        seenFn.add(key);
        activeFunctions.push({
          sessionId: session.sessionId,
          agentId: null,
          name: fn.name,
          phase: fn.state.phase as ActiveFunction["phase"],
          continuationCount: fn.state.continuationCount ?? 0,
          currentTurn: fn.state.currentTurn,
          activatedAtTurn: fn.state.activatedAtTurn,
          gateSatisfied: fn.state.gateSatisfied,
          cooldownUntilTurn: fn.state.cooldownUntilTurn,
          toolsObserved: fn.state.toolsObserved,
          evidenceObserved: Object.keys(fn.state.evidenceObserved ?? {}),
        });
      }
    }
  }

  const graphAgentMap = new Map<string, string>();
  for (const graphPath of listStateFiles(stateDir, "graph-")) {
    const graphRaw = tryReadJson(graphPath);
    if (!graphRaw || typeof graphRaw !== "object" || !("sessions" in graphRaw)) continue;
    const file = graphRaw as RawGraphFile;
    if (!Array.isArray(file.sessions)) continue;
    for (const gs of file.sessions) {
      if (gs.sessionId && gs.agentId) graphAgentMap.set(gs.sessionId, gs.agentId);
    }
  }
  for (const af of activeFunctions) {
    af.agentId =
      graphAgentMap.get(af.sessionId) ??
      sessionAgentMap.get(af.sessionId) ??
      null;
  }

  // Filter activeFunctions, loops, and graphSessions to only those with live dispatch tasks
  activeFunctions = activeFunctions.filter((af) => liveSessions.has(af.sessionId));

  // Read optional metrics, notifications, and recovery state
  const metrics = readMetricsSnapshot(stateDir);
  const metricsRecentEvents = readMetricsRecentEvents(stateDir);
  const notifications = readNotificationState(stateDir);
  const recovery = readRecoveryMetrics(stateDir);

  const loops = readLoopSnapshots(stateDir);

  const graphSessions = readGraphSessions(stateDir);
  // Cross-filter loops and graphSessions by live sessions
  const filteredLoops = loops.filter(
    (l) =>
      liveSessions.has(l.originSessionId) ||
      (l.activeWorkerSessionId ? liveSessions.has(l.activeWorkerSessionId) : false),
  );
  const filteredGraphSessions = graphSessions.filter((gs) => liveSessions.has(gs.sessionId));

  // Compute dispatch summary from collected tasks
  const tasks = [...taskById.values()];
  const dispatchSummary = computeDispatchSummary(tasks);

  // Aggregate concurrency status from metrics gauges
  const concurrency = computeConcurrencyStatus(metrics);

  return {
    projectDir,
    timestamp: new Date().toISOString(),
    tasks,
    activeFunctions,
    loops: filteredLoops,
    graphSessions: filteredGraphSessions,
    dispatchSummary,
    concurrency,
    metrics: metrics ?? undefined,
    metricsRecentEvents: metricsRecentEvents.length > 0 ? metricsRecentEvents : undefined,
    notifications: notifications ?? undefined,
    recovery: recovery ?? undefined,
  };
}
