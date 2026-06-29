import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateFileHash } from "../state-hash.ts";

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

export function readMonitorSnapshot(projectDir: string): MonitorSnapshot {
  const hash = stateFileHash(projectDir);
  const stateDir = join(projectDir, ".rolebox", "state");

  const tasks: TaskSnapshot[] = [];
  const sessionAgentMap = new Map<string, string>();

  const dispatchPath = join(stateDir, `dispatch-${hash}.json`);
  const dispatchRaw = tryReadJson(dispatchPath);
  if (dispatchRaw && typeof dispatchRaw === "object" && "tasks" in dispatchRaw) {
    const file = dispatchRaw as RawDispatchFile;
    for (const st of file.tasks) {
      if (st.sessionId && st.agent) {
        sessionAgentMap.set(st.sessionId, st.agent);
      }
      tasks.push({
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
      });
    }
  }

  const activeFunctions: ActiveFunction[] = [];
  const fnstatePath = join(stateDir, `fnstate-${hash}.json`);
  const fnstateRaw = tryReadJson(fnstatePath);
  if (fnstateRaw && typeof fnstateRaw === "object" && "sessions" in fnstateRaw) {
    const file = fnstateRaw as RawFnStateFile;
    for (const session of file.sessions) {
      if (!session.sessionId || !Array.isArray(session.fns)) continue;
      for (const fn of session.fns) {
        if (!fn.state || fn.state.phase !== "active") continue;
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
  const graphPath = join(stateDir, `graph-${hash}.json`);
  const graphRaw = tryReadJson(graphPath);
  if (graphRaw && typeof graphRaw === "object" && "sessions" in graphRaw) {
    const file = graphRaw as RawGraphFile;
    for (const gs of file.sessions) {
      if (gs.sessionId && gs.agentId) {
        graphAgentMap.set(gs.sessionId, gs.agentId);
      }
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
    tasks,
    activeFunctions,
  };
}
