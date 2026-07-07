import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeWorkspaceDir, stateDirFor } from "../../state-paths.ts";
import { readResultSidecar, resultSidecarPath } from "../../dispatch/result-extractor.ts";
import type { MetricsSnapshot } from "../../dispatch/metrics.ts";
import type {
  TaskSnapshot,
  ActiveFunction,
  MonitorSnapshot,
  LoopSnapshot,
  GraphSessionSnapshot,
  DispatchSummary,
  ConcurrencyStatus,
  NDJSONEvent,
  NotificationState,
  RecoveryMetrics,
  TaskDetail,
} from "./monitor-reader-types.ts";
import { readMetricsSnapshot, readMetricsRecentEvents } from "./monitor-reader-metrics.ts";
import { readLoopSnapshots, readGraphSessions } from "./monitor-reader-graph.ts";
import { tryReadJson, listStateFiles } from "./monitor-reader-utils.ts";

export type {
  TaskSnapshot,
  ActiveFunction,
  MonitorSnapshot,
  LoopSnapshot,
  GraphSessionSnapshot,
  DispatchSummary,
  ConcurrencyStatus,
  NDJSONEvent,
  NotificationState,
  RecoveryMetrics,
  TaskDetail,
} from "./monitor-reader-types.ts";
export { readMetricsSnapshot, readMetricsRecentEvents } from "./monitor-reader-metrics.ts";
export { readLoopSnapshots, readGraphSessions } from "./monitor-reader-graph.ts";

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



const CONCURRENCY_GAUGE_ACTIVE = "concurrency_active";
const CONCURRENCY_GAUGE_QUEUED = "concurrency_queued";
const CONCURRENCY_GAUGE_LIMIT = "concurrency_limit";



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
      if (tailChars > 0) {
        // Try the stored sidecarPath first; fall back to the rebuilt path
        // (same approach as readTaskDetail). The stored path may be empty/stale
        // when materialization hasn't completed, failed, or the project moved.
        let full: string | null = null;
        if (st.result?.sidecarPath) {
          resultTotalChars = st.result.totalChars;
          full = readResultSidecar(st.result.sidecarPath);
        }
        if (full === null) {
          const rebuiltPath = resultSidecarPath(st.id, projectDir);
          full = readResultSidecar(rebuiltPath);
        }
        if (full !== null) {
          resultPreview = full.length > tailChars
            ? full.slice(-tailChars)
            : full;
          if (resultTotalChars === undefined) {
            resultTotalChars = full.length;
          }
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
