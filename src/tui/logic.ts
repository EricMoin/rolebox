/**
 * Pure business logic for the TUI sidebar.
 *
 * All functions are deterministic, side-effect-free, and testable without
 * SolidJS, OpenTUI, or any UI framework. Only imports from type definition
 * modules and pure utility modules.
 *
 * @module
 */

import type {
  MonitorSnapshot,
  TaskSnapshot,
  ActiveFunction,
  LoopSnapshot,
  GraphSessionSnapshot,
  EngineGraphSnapshot,
} from "../cli/commands/monitor/monitor-reader-types";

// ── Types ────────────────────────────────────────────────────────────────

export type HealthState = "ACTIVE" | "IDLE" | "NO_STATE" | "STALE" | "ERROR";

export interface HealthParams {
  phase: "loading" | "ready" | "error";
  stateDirPresent: boolean;
  consecutiveFailures: number;
  snapshot: MonitorSnapshot | null;
  sessionScope: Set<string>;
  currentSessionId: string;
}

export interface FilteredActivityData {
  fns: ActiveFunction[];
  tasks: TaskSnapshot[];
  graphs: GraphSessionSnapshot[];
  loops: LoopSnapshot[];
  /** Engine-graph (v2) execution snapshots, session-scoped.
   *  Engine graphs carry no graph-level sessionId, so they are surfaced in the
   *  current session's activity view (matching the monitor reader's unfiltered
   *  projection); only the text filter applies. */
  engineGraphs: EngineGraphSnapshot[];
}

export interface FilterParams {
  snapshot: MonitorSnapshot | null;
  stateDirPresent: boolean;
  sessionScope: Set<string>;
  currentSessionId: string;
  filterText: string;
}

// ── Health computation ───────────────────────────────────────────────────

/**
 * Compute the health state from raw inputs.
 *
 * Mirrors the health memo in state.tsx but as a pure function.
 *
 * Returns `null` only when phase is "loading" (no determination possible yet).
 */
export function computeHealth(params: HealthParams): HealthState | null {
  const { phase, stateDirPresent, consecutiveFailures, snapshot, sessionScope, currentSessionId } = params;

  if (phase === "loading") return null;
  if (!stateDirPresent) return "NO_STATE";
  if (phase === "error" || consecutiveFailures > 0) return "STALE";
  if (!snapshot) return "IDLE";

  // Filter to current session scope
  const myTasks = snapshot.tasks.filter(
    (t) => t.sessionId && (sessionScope.has(t.sessionId) || t.sessionId === currentSessionId),
  );
  const myFns = snapshot.activeFunctions.filter((fn) => sessionScope.has(fn.sessionId));
  const myLoops = snapshot.loops.filter(
    (l) => sessionScope.has(l.originSessionId) || l.originSessionId === currentSessionId,
  );
  const myGraphs = snapshot.graphSessions.filter((g) => sessionScope.has(g.sessionId));

  // Check for errors first — ERROR takes priority over ACTIVE
  if (
    myTasks.some((t) => t.status === "error" || t.status === "timeout") ||
    myLoops.some((l) => l.errorReason)
  ) {
    return "ERROR";
  }

  // Check for ongoing activity
  if (
    snapshot.concurrency.active > 0 ||
    snapshot.dispatchSummary.pending > 0 ||
    snapshot.dispatchSummary.running > 0 ||
    myLoops.length > 0 ||
    myFns.length > 0 ||
    myGraphs.some((g) => g.status === "active")
  ) {
    return "ACTIVE";
  }

  return "IDLE";
}

// ── Active task filtering and sorting ────────────────────────────────────

/**
 * Status priority ranking for sort order:
 * error/timeout (0), running (1), pending (2), others (3).
 */
function statusRank(status: string): number {
  const rank: Record<string, number> = { error: 0, timeout: 0, running: 1, pending: 2 };
  return rank[status] ?? 3;
}

/**
 * Filter tasks to only active/pending/error/timeout ones within the session
 * scope, then sort by priority (errors first, then running, then pending).
 *
 * Within the same priority, sorts by startedAt (most recent first for errors,
 * earliest first for running/pending).
 */
export function getActiveTasks(
  snapshot: MonitorSnapshot | null,
  sessionScope: Set<string>,
  currentSessionId: string,
): TaskSnapshot[] {
  if (!snapshot) return [];

  return snapshot.tasks
    .filter((t) => {
      if (t.status !== "running" && t.status !== "pending" && t.status !== "error" && t.status !== "timeout") {
        return false;
      }
      const sid = t.sessionId;
      return sid && (sessionScope.has(sid) || sid === currentSessionId);
    })
    .sort((a, b) => {
      const ra = statusRank(a.status);
      const rb = statusRank(b.status);
      if (ra !== rb) return ra - rb;
      if (a.status === "error" || a.status === "timeout") {
        // Most recent errors first
        return b.startedAt.localeCompare(a.startedAt);
      }
      return a.startedAt.localeCompare(b.startedAt);
    });
}

// ── Filtered activity data ──────────────────────────────────────────────

/**
 * Compute the filtered activity data for the activity panel.
 *
 * Combines active functions, active tasks, graphs, and loops — all
 * scoped to the current session and optionally filtered by text.
 */
export function computeFilteredActivity(params: FilterParams): FilteredActivityData {
  const { snapshot, stateDirPresent, sessionScope, currentSessionId, filterText } = params;

  if (!snapshot || !stateDirPresent) {
    return { fns: [], tasks: [], graphs: [], loops: [], engineGraphs: [] };
  }

  const ft = filterText.toLowerCase();
  const filterMatch = (name: string | null | undefined): boolean =>
    ft === "" || (name?.toLowerCase().includes(ft) ?? false);

  const fns = [...snapshot.activeFunctions]
    .filter((fn) => sessionScope.has(fn.sessionId) && filterMatch(fn.name ?? fn.agentId ?? fn.sessionId))
    .sort((a, b) => {
      const aAgent = a.agentId !== null && a.agentId !== undefined;
      const bAgent = b.agentId !== null && b.agentId !== undefined;
      if (aAgent !== bAgent) return aAgent ? -1 : 1;
      const aGated = a.phase !== "active" && a.phase !== "complete";
      const bGated = b.phase !== "active" && b.phase !== "complete";
      if (aGated !== bGated) return aGated ? -1 : 1;
      if (b.continuationCount !== a.continuationCount) return b.continuationCount - a.continuationCount;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

  const tasks = getActiveTasks(snapshot, sessionScope, currentSessionId).filter(
    (t) => filterMatch(t.agent),
  );

  const graphs = snapshot.graphSessions.filter(
    (g) => sessionScope.has(g.sessionId) && filterMatch(g.sessionId),
  );

  const loops = snapshot.loops.filter(
    (l) =>
      (sessionScope.has(l.originSessionId) || l.originSessionId === currentSessionId) &&
      filterMatch((l as { fnName?: string }).fnName),
  );

  // Engine graphs carry no graph-level sessionId, so session scoping is
  // implicit (they are surfaced in this session's view); only the text filter
  // applies, matching on graphId / agentId provenance when present.
  const engineGraphs = snapshot.engineGraphs.filter((g) =>
    filterMatch(g.graphId ?? (g.agentId ? g.agentId : undefined)),
  );

  return { fns, tasks, graphs, loops, engineGraphs };
}
