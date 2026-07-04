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
  state: { phase: string; continuationCount: number };
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

  for (const dispatchPath of listStateFiles(stateDir, "dispatch-")) {
    const dispatchRaw = tryReadJson(dispatchPath);
    if (!dispatchRaw || typeof dispatchRaw !== "object" || !("tasks" in dispatchRaw)) continue;
    const file = dispatchRaw as RawDispatchFile;
    if (!Array.isArray(file.tasks)) continue;
    for (const st of file.tasks) {
      if (st.sessionId && st.agent) sessionAgentMap.set(st.sessionId, st.agent);

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
        resultPreview,
        resultTotalChars,
      });
    }
  }

  const activeFunctions: ActiveFunction[] = [];
  const seenFn = new Set<string>();
  for (const fnstatePath of listStateFiles(stateDir, "fnstate-")) {
    const fnstateRaw = tryReadJson(fnstatePath);
    if (!fnstateRaw || typeof fnstateRaw !== "object" || !("sessions" in fnstateRaw)) continue;
    const file = fnstateRaw as RawFnStateFile;
    if (!Array.isArray(file.sessions)) continue;
    for (const session of file.sessions) {
      if (!session.sessionId || !Array.isArray(session.fns)) continue;
      for (const fn of session.fns) {
        if (!fn.state || fn.state.phase !== "active") continue;
        const key = `${session.sessionId}\u0000${fn.name}`;
        if (seenFn.has(key)) continue;
        seenFn.add(key);
        activeFunctions.push({
          sessionId: session.sessionId,
          agentId: null,
          name: fn.name,
          phase: fn.state.phase as ActiveFunction["phase"],
          continuationCount: fn.state.continuationCount ?? 0,
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

  // Read optional metrics, notifications, and recovery state
  const metrics = readMetricsSnapshot(stateDir);
  const metricsRecentEvents = readMetricsRecentEvents(stateDir);
  const notifications = readNotificationState(stateDir);
  const recovery = readRecoveryMetrics(stateDir);

  return {
    projectDir,
    timestamp: new Date().toISOString(),
    tasks: [...taskById.values()],
    activeFunctions,
    metrics: metrics ?? undefined,
    metricsRecentEvents: metricsRecentEvents.length > 0 ? metricsRecentEvents : undefined,
    notifications: notifications ?? undefined,
    recovery: recovery ?? undefined,
  };
}
