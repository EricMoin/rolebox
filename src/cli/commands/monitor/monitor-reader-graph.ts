import { readFileSync } from "node:fs";
import { tryReadJson, listStateFiles, listNDJSONFiles } from "./monitor-reader-utils.ts";
import type {
  LoopSnapshot,
  GraphSessionSnapshot,
  GraphEvent,
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

/**
 * Parse the durable graph event log (`graph-events-{hash}.ndjson`) files in
 * the state directory and return the most recent {@link GraphEvent}s as typed
 * events, in chronological order.
 *
 * Files are matched with the `graph-events-` prefix (see
 * {@link listNDJSONFiles}). Each line is a standalone JSON record (the writer
 * appends one complete line per event), so the reader treats every line
 * independently: a malformed or incomplete line is skipped without aborting
 * the file or the reader. Events are coalesced across all matched files,
 * ordered by `ts` (ascending), and only the last `maxLines` events are
 * returned (fewer when fewer valid lines exist).
 *
 * Returns an empty array when no files exist or no valid lines are present.
 */
export function readGraphEvents(stateDir: string, maxLines = 20): GraphEvent[] {
  const files = listNDJSONFiles(stateDir, "graph-events-");
  if (files.length === 0 || maxLines <= 0) return [];

  const events: GraphEvent[] = [];

  for (const filePath of files) {
    const raw = tryReadNDJSON(filePath);
    for (const line of raw) {
      const parsed = parseGraphEventLine(line);
      if (parsed) events.push(parsed);
    }
  }

  if (events.length === 0) return [];

  // Chronological order across all graphs; a stable tie-break keeps same-`ts`
  // events in their original (file / line) order.
  events.sort((a, b) => a.ts - b.ts || 0);

  return events.length <= maxLines ? events : events.slice(events.length - maxLines);
}

/**
 * Read an `.ndjson` file and split it into its lines. Never throws: a missing
 * or unreadable file degrades to an empty array (the same discipline as
 * {@link tryReadJson}).
 */
function tryReadNDJSON(filePath: string): string[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return raw.split("\n");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    console.warn(
      `[monitor-reader] Failed to read ${filePath}: ${(err as Error).message}`,
    );
    return [];
  }
}

/**
 * Parse a single NDJSON line into a {@link GraphEvent}, or return null when
 * the line is malformed (not valid JSON, or missing the required `ts` /
 * `graphId` / `event` fields). Optional fields are carried through only when
 * present and correctly typed.
 */
function parseGraphEventLine(line: string): GraphEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null; // malformed line — skip
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const rec = record as Record<string, unknown>;
  if (typeof rec.ts !== "number") return null;
  if (typeof rec.graphId !== "string") return null;
  if (typeof rec.event !== "string") return null;

  const event: GraphEvent = {
    ts: rec.ts,
    graphId: rec.graphId,
    event: rec.event as GraphEvent["event"],
  };

  if (typeof rec.nodeId === "string") event.nodeId = rec.nodeId;
  if (typeof rec.status === "string") event.status = rec.status;
  if (typeof rec.signalType === "string") event.signalType = rec.signalType;
  if (typeof rec.agent === "string") event.agent = rec.agent;
  if (typeof rec.startedAt === "number") event.startedAt = rec.startedAt;
  if (typeof rec.completedAt === "number") event.completedAt = rec.completedAt;

  return event;
}
