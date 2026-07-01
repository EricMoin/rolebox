import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { normalizeWorkspaceDir, stateDirFor } from "../../state-paths.ts";
import { readResultSidecar } from "../../dispatch/result-extractor.ts";

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

  return {
    projectDir,
    timestamp: new Date().toISOString(),
    tasks: [...taskById.values()],
    activeFunctions,
  };
}
