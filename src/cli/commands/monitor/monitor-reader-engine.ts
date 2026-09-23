import { readFileSync } from "node:fs";

import { EnginePhase, NodeStatus } from "../../../constants.ts";
import { loadEngineStateForResume } from "../../../graph/persistence/engine-persistence.ts";
import type { EngineState } from "../../../types.engine-v2.ts";
import { listStateFiles } from "./monitor-reader-utils.ts";
import type {
  EngineBudgetSnapshot,
  EngineGraphSnapshot,
  EngineLoopGroupSnapshot,
  GraphNodeSnapshot,
} from "./monitor-reader-types.ts";

// ── Projection helpers ──────────────────────────────────────────────

/**
 * Convert an epoch-ms timestamp (as persisted by the engine) into an ISO-8601
 * string, consistent with the rest of the monitor snapshot surface. Returns
 * `undefined` for non-finite / non-positive values, which lets the reader
 * omit absent timestamps (e.g. a node that never started has `startedAt: 0`).
 */
function epochToIso(ms: number): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Project a hydrated {@link EngineState} into the rich, JSON-safe
 * {@link EngineGraphSnapshot} the monitor renders.
 *
 * Timestamps are converted to ISO strings. The engine is a multi-agent
 * primitive with no single owning agent, so `agentId` is left unset.
 */
function projectEngineGraph(state: EngineState): EngineGraphSnapshot {
  const nodes: GraphNodeSnapshot[] = [];
  const nodeStatusCounts: Record<string, number> = {};

  for (const n of state.nodes.values()) {
    const signalKeys = Object.keys(n.signalsObserved ?? {});
    const node: GraphNodeSnapshot = {
      nodeId: n.nodeId,
      agent: n.agent,
      status: n.status,
      signalType: signalKeys.length > 0 ? signalKeys[0] : undefined,
      startedAt: epochToIso(n.startedAt),
      completedAt: n.completedAt !== undefined ? epochToIso(n.completedAt) : undefined,
      retryCount: n.retryCount,
      // E6: the engine's recorded failure cause must reach the monitor — a
      // timed-out / escalated / exhausted node is otherwise indistinguishable
      // from a cleanly finished one at this projection layer.
      ...(n.errorReason ? { errorReason: n.errorReason } : {}),
      loopGroupId: n.loopGroupId,
      ...(n.dispatchTaskId ? { dispatchTaskId: n.dispatchTaskId } : {}),
      ...(n.dispatchSessionId ? { dispatchSessionId: n.dispatchSessionId } : {}),
    };
    nodes.push(node);
    nodeStatusCounts[n.status] = (nodeStatusCounts[n.status] ?? 0) + 1;
  }

  const loopGroups: EngineLoopGroupSnapshot[] = [];
  for (const g of state.loopGroups.values()) {
    loopGroups.push({
      id: g.id,
      traversalCount: g.traversalCount,
      maxTraversals: g.maxTraversals,
    });
  }

  const budget: EngineBudgetSnapshot = {
    sessionsSpawned: state.budget.sessionsSpawned,
    totalInputTokens: state.budget.totalInputTokens,
    totalOutputTokens: state.budget.totalOutputTokens,
    totalCost: state.budget.totalCost,
  };

  // Graph-level timestamps are required in the snapshot; valid files always
  // carry them, so this fallback is defensive-only.
  const startedIso = epochToIso(state.startedAt) ?? new Date(0).toISOString();
  const updatedIso = epochToIso(state.updatedAt) ?? new Date(0).toISOString();
  // Raw epoch-ms timestamp, carried alongside the ISO string so downstream
  // staleness gating (see readEngineGraphs) can compare against Date.now()
  // without re-parsing. `0` when the persisted file lacked the field — the
  // loader does not gate `updatedAt` presence, so this is a real possibility.
  const updatedAtMs = typeof state.updatedAt === "number" ? state.updatedAt : 0;

  // A graph with any node in `running` status is never surfaced as idle: a
  // node may be actively executing (e.g. running a shell command) while the
  // engine's persisted phase momentarily reads idle (no advancement in
  // flight). Derive the phase as `executing` so the monitor never presents a
  // false idle/running flicker while work is genuinely in progress.
  const effectivePhase: EnginePhase =
    (nodeStatusCounts[NodeStatus.Running] ?? 0) > 0
      ? EnginePhase.Executing
      : state.phase;

  return {
    graphId: state.graphId,
    phase: effectivePhase,
    nodeCount: state.nodes.size,
    nodeStatusCounts,
    nodes,
    budget,
    frontier: [...state.frontier],
    loopGroups,
    startedAt: startedIso,
    updatedAt: updatedIso,
    updatedAtMs,
    hasCheckpoints: state.checkpoints != null && Object.keys(state.checkpoints).length > 0,
  };
}

// ── Public reader ───────────────────────────────────────────────────

/**
 * Staleness threshold for terminal graphs. A graph whose projected phase is
 * terminal (`complete` — graph cancellation also ends in `complete`, see
 * `engine.cancel()`) and whose last state update is older than this window is
 * dead: it renders no live activity and only clutters the TUI as a phantom
 * live graph (the primary false-activity cause — persisted complete graphs
 * surfaced unfiltered). Kept visible are terminal graphs that updated within
 * the window and any graph with a running/blocked node.
 */
const TERMINAL_GRAPH_STALE_MS = 60_000;

/**
 * Staleness gate for a projected engine-graph snapshot.
 *
 * A graph is hidden only when all three hold: its **projected** phase is
 * terminal (`complete`), it has no running or blocked node, and its last
 * state update is older than {@link TERMINAL_GRAPH_STALE_MS}. A running node
 * already flips the projected phase to `executing` (see projectEngineGraph),
 * so the explicit count check is belt-and-braces; a blocked node does NOT
 * flip the projected phase and needs the exemption so a human-in-the-loop
 * approval pause is never hidden as dead.
 */
function isStaleTerminalGraph(snapshot: EngineGraphSnapshot, now: number): boolean {
  if (snapshot.phase !== EnginePhase.Complete) return false;
  const running = snapshot.nodeStatusCounts[NodeStatus.Running] ?? 0;
  const blocked = snapshot.nodeStatusCounts[NodeStatus.Blocked] ?? 0;
  if (running > 0 || blocked > 0) return false;
  // An absent/zero `updatedAtMs` (defensive fallback) reads as maximally stale.
  return now - snapshot.updatedAtMs > TERMINAL_GRAPH_STALE_MS;
}

/**
 * Scan every `engine-*.json` file in `stateDir` and return a rich
 * {@link EngineGraphSnapshot} per persisted graph execution engine (v2).
 *
 * Each file is read and parsed via {@link loadEngineStateForResume}, the same
 * version-gated loader every other consumer uses. Files that are corrupt JSON,
 * not a version-`2` engine file, pinned to a protocol this build does not run
 * (the deleted legacy signal protocol included), or unreadable are **skipped
 * honestly** — they never surface an error and never fabricate a snapshot.
 * Terminal graphs whose last update predates {@link TERMINAL_GRAPH_STALE_MS}
 * are gated out (unless a node is running/blocked) so dead persisted graphs
 * are not rendered as live activity. Returns an empty array when no engine
 * files exist.
 */
export function readEngineGraphs(stateDir: string): EngineGraphSnapshot[] {
  const files = listStateFiles(stateDir, "engine-");
  if (files.length === 0) return [];

  const snapshots: EngineGraphSnapshot[] = [];
  const now = Date.now();
  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      // Unreadable (permissions / vanished between listing and read) — skip.
      continue;
    }
    // A non-valid result covers corrupt JSON, a schema-version mismatch, an
    // unregistered protocol and a failed plan gate — all skipped honestly.
    const loaded = loadEngineStateForResume(raw, filePath);
    if (loaded.kind !== "valid") continue;
    const snapshot = projectEngineGraph(loaded.state);
    if (isStaleTerminalGraph(snapshot, now)) continue;
    snapshots.push(snapshot);
  }

  return snapshots;
}

// ── Live-state reader (monitor S10) ─────────────────────────────────────────

/**
 * Read engine-graph snapshots for the monitor.
 *
 * A declared (outcome-protocol) graph is PERSISTED at declaration time, so the
 * store under `stateDir` (default `process.cwd()`) is the single authority
 * for every graph this process or an earlier one declared. The deleted legacy
 * runtime's in-memory registry is gone: there is no separate live source to
 * prefer or merge over the disk view.
 */
export function readLiveEngineGraphs(stateDir?: string): EngineGraphSnapshot[] {
  return readEngineGraphs(stateDir ?? process.cwd());
}

// ── Live-source merge (monitor S10 / TUI refresh) ──────────────────────────

/**
 * Merge the disk-persisted engine-graph snapshots with the live registry
 * snapshots for display, **live winning by graphId**.
 *
 * The live registry is the freshest source of truth (opencode runs the engine
 * fully in-memory; disk `engine-*.json` may be absent, stale, or from an
 * abandoned prior run). Every graph the live registry holds therefore replaces
 * any disk snapshot with the same graphId. The **disk-only remainder** —
 * graphs the live registry does not hold (e.g. completed graphs still within
 * the staleness window) — survives only if it passes the subtask-2 stale
 * terminal gate ({@link isStaleTerminalGraph}), so a dead persisted complete
 * graph is never resurrected by the merge.
 *
 * Live graphs are ordered first so actively executing graphs are never pushed
 * below the fold by the disk remainder. Pure and total — never throws.
 */
export function mergeLiveEngineGraphs(
  diskGraphs: readonly EngineGraphSnapshot[],
  liveGraphs: readonly EngineGraphSnapshot[],
  now: number = Date.now(),
): EngineGraphSnapshot[] {
  const liveById = new Map(liveGraphs.map((g) => [g.graphId, g]));
  const diskRemainder = diskGraphs.filter(
    (g) => !liveById.has(g.graphId) && !isStaleTerminalGraph(g, now),
  );
  return [...liveGraphs, ...diskRemainder];
}
