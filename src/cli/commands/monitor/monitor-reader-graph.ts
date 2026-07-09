import { tryReadJson, listStateFiles } from "./monitor-reader-utils.ts";
import type {
  LoopSnapshot,
  GraphSessionSnapshot,
} from "./monitor-reader-types.ts";

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

const TERMINAL_LOOP_PHASES = new Set([
  "complete",
  "cancelled",
  "interrupted",
  "error",
]);

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
