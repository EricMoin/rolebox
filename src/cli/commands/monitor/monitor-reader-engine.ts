import { readFileSync } from "node:fs";

import { loadEngineStateFromJson } from "../../../graph/engine/engine-persistence.ts";
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

  return {
    graphId: state.graphId,
    phase: state.phase,
    nodeCount: state.nodes.size,
    nodeStatusCounts,
    nodes,
    budget,
    frontier: [...state.frontier],
    loopGroups,
    startedAt: startedIso,
    updatedAt: updatedIso,
    hasCheckpoints: state.checkpoints != null && Object.keys(state.checkpoints).length > 0,
  };
}

// ── Public reader ───────────────────────────────────────────────────

/**
 * Scan every `engine-*.json` file in `stateDir` and return a rich
 * {@link EngineGraphSnapshot} per persisted graph execution engine (v2).
 *
 * Each file is read and parsed via {@link loadEngineStateFromJson}, the same
 * version-gated loader the engine's own persistence layer uses. Files that are
 * corrupt JSON, not a version-`2` engine file, or unreadable are **skipped
 * honestly** — they never surface an error and never fabricate a snapshot.
 * Returns an empty array when no engine files exist.
 */
export function readEngineGraphs(stateDir: string): EngineGraphSnapshot[] {
  const files = listStateFiles(stateDir, "engine-");
  if (files.length === 0) return [];

  const snapshots: EngineGraphSnapshot[] = [];
  for (const filePath of files) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      // Unreadable (permissions / vanished between listing and read) — skip.
      continue;
    }
    // `null` → corrupt JSON, non-object, or schema-version mismatch.
    const state = loadEngineStateFromJson(raw, filePath);
    if (!state) continue;
    snapshots.push(projectEngineGraph(state));
  }

  return snapshots;
}
