import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeWorkspaceDir, stateDirFor } from "../../../utils/state-paths.ts";
import { readResultSidecar, resultSidecarPath } from "../../../dispatch/completion/result-extractor.ts";
import { BACKGROUND_STALE_TIMEOUT_MS } from "../../../dispatch/config.ts";
import type { MetricsSnapshot } from "../../../dispatch/persistence/metrics.ts";
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
import { readNotificationState, readRecoveryMetrics } from "./monitor-reader-state.ts";
import { computeDurationMs, computeDispatchSummary, computeConcurrencyStatus } from "./monitor-reader-compute.ts";

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
export { readNotificationState, readRecoveryMetrics } from "./monitor-reader-state.ts";
export { computeDurationMs, computeDispatchSummary, computeConcurrencyStatus } from "./monitor-reader-compute.ts";

// ── Raw JSON types (internal to readMonitorSnapshot) ──────────────

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

interface RawTaskEventState {
  lastMessageCount: number;
  lastProgressUpdate: number;
  hasProducedOutput: boolean;
  messageCountAtStart: number;
  lastEventAt: number;
  pendingConfirm?: { messageCount: number; at: number };
  consecutiveFetchFailures: number;
}

interface RawDispatchFile {
  version: number;
  tasks: RawDispatchTask[];
  eventState?: Record<string, RawTaskEventState>;
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

// ── Raw progress / checkpoint types ─────────────────────────────

interface RawProgressEvent {
  task_id: string;
  percentage?: number;
  stage: string;
  message: string;
  timestamp: string;
}

interface RawCheckpointEntry {
  task_id: string;
  checkpoint_id: string;
  phase: string;
  completed_items: string[];
  remaining_items: string[];
  created_at: string;
}

// ── Task detail reader ────────────────────────────────────────────

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

// ── Project root resolution ───────────────────────────────────────

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

// ── Main snapshot reader ──────────────────────────────────────────

export function readMonitorSnapshot(projectDir: string, tailChars = 0): MonitorSnapshot {
  const stateDir = stateDirFor(projectDir);

  // Scan every state file rather than recomputing a single hashed name: the
  // monitor then surfaces activity even if the writer's directory hash differs
  // (symlinked/worktree paths, legacy files), which is the whole point here.
  const taskById = new Map<string, TaskSnapshot>();
  const sessionAgentMap = new Map<string, string>();
  const liveSessions = new Set<string>();
  const eventStateById = new Map<string, RawTaskEventState>();
  for (const dispatchPath of listStateFiles(stateDir, "dispatch-")) {
    const dispatchRaw = tryReadJson(dispatchPath);
    if (!dispatchRaw || typeof dispatchRaw !== "object" || !("tasks" in dispatchRaw)) continue;
    const file = dispatchRaw as RawDispatchFile;
    if (!Array.isArray(file.tasks)) continue;

    // Collect eventState if present
    if (file.eventState && typeof file.eventState === "object") {
      for (const [taskId, es] of Object.entries(file.eventState)) {
        eventStateById.set(taskId, es);
      }
    }

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

      const es = eventStateById.get(st.id);

      // Compute lastActivityAgoMs: the gap between now and the most recent
      // signal of life (progress update, event timestamp, or creation time).
      let lastActivityAgoMs: number | undefined;
      if (es) {
        const progressTime = es.lastProgressUpdate;
        const eventTime = es.lastEventAt;
        const createTime = new Date(st.startedAt).getTime();
        const latest = Math.max(progressTime, eventTime, createTime);
        lastActivityAgoMs = Date.now() - latest;
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

        // Liveness / event-tracking fields
        lastEventAt: es ? new Date(es.lastEventAt).toISOString() : undefined,
        lastProgressUpdate: es ? new Date(es.lastProgressUpdate).toISOString() : undefined,
        hasProducedOutput: es ? es.hasProducedOutput : undefined,
        toolCalls: es ? es.lastMessageCount : undefined,
        consecutiveFetchFailures: es ? es.consecutiveFetchFailures : undefined,
        staleTimeoutMs: undefined, // computed below in a second pass
        lastActivityAgoMs,
      });
    }
  }

  // Second pass: populate staleTimeoutMs for running/pending tasks.
  // All tasks share the same configured background default since per-task
  // overrides are not persisted in the dispatch file.
  for (const task of taskById.values()) {
    if (task.status === "running" || task.status === "pending") {
      task.staleTimeoutMs = BACKGROUND_STALE_TIMEOUT_MS;
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

  // ── Read progress data ─────────────────────────────────────────
  const progressDir = join(stateDir, "progress");
  let progress: MonitorSnapshot["progress"];
  try {
    const files = readdirSync(progressDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0) {
      progress = {};
      for (const file of files) {
        const taskId = file.replace(/\.json$/, "");
        const raw = tryReadJson(join(progressDir, file));
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const events = raw as RawProgressEvent[];
        const latest = events[events.length - 1];
        progress[taskId] = {
          latest_stage: latest.stage,
          percentage: latest.percentage,
          message: latest.message,
          event_count: events.length,
        };
      }
      if (Object.keys(progress).length === 0) progress = undefined;
    }
  } catch {
    // progress dir does not exist or is unreadable — skip
  }

  // ── Read checkpoint data ──────────────────────────────────────
  const checkpointDir = join(stateDir, "checkpoints");
  let checkpoints: MonitorSnapshot["checkpoints"];
  try {
    const files = readdirSync(checkpointDir).filter((f) => f.endsWith(".json"));
    if (files.length > 0) {
      checkpoints = {};
      for (const file of files) {
        const taskId = file.replace(/\.json$/, "");
        const raw = tryReadJson(join(checkpointDir, file));
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const entries = raw as RawCheckpointEntry[];
        // Sort by created_at descending, take latest
        entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const latest = entries[0];
        checkpoints[taskId] = {
          checkpoint_id: latest.checkpoint_id,
          phase: latest.phase,
          completed_count: latest.completed_items.length,
          remaining_count: latest.remaining_items.length,
          created_at: latest.created_at,
        };
      }
      if (Object.keys(checkpoints).length === 0) checkpoints = undefined;
    }
  } catch {
    // checkpoint dir does not exist or is unreadable — skip
  }

  return {
    projectDir,
    timestamp: new Date().toISOString(),
    tasks,
    activeFunctions,
    loops: filteredLoops,
    graphSessions: filteredGraphSessions,
    dispatchSummary,
    concurrency,
    progress,
    checkpoints,
    metrics: metrics ?? undefined,
    metricsRecentEvents: metricsRecentEvents.length > 0 ? metricsRecentEvents : undefined,
    notifications: notifications ?? undefined,
    recovery: recovery ?? undefined,
  };
}
