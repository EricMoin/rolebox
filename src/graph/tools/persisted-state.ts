/**
 * Graph Execution Engine v2 — Persisted-State Scanner
 *
 * Version: 2.0
 * Date: 2026-07-26
 *
 * A read-only, cross-session view over the on-disk engine-state store. Whereas
 * `engine-persistence.ts` is the per-graph store (save one graph, load one
 * graph), this helper scans the whole store and surfaces a summary of every
 * graph that has been persisted — including graphs written by earlier
 * sessions that are no longer resident in memory.
 *
 * This is the backing store for the cross-session `graph_status` query (a
 * separate subtask wires the query in); this module deliberately contains no
 * graph_status integration of its own.
 *
 * Scope:
 * - `scanPersistedStates(stateDir)` — list `.rolebox/state/engine-*.json`,
 *   hydrate each via the exported `loadEngineStateFromJson`, and return the
 *   states that loaded. Corrupt-JSON, schema-version-mismatched, and
 *   unreadable files are skipped honestly (counted, never thrown, never
 *   fabricated). A missing store yields an empty result, never an error.
 * - `buildPersistedSummary(state)` — a pure, JSON-primitive summary of one
 *   hydrated state (graphId, phase, node counts per status, per-node
 *   agent/status/timing, startedAt/updatedAt, frontier).
 * - `scanPersistedSummaries(stateDir)` — convenience combining the scan with
 *   the summary builder, ordered most-recently-updated first.
 * - Node / loop / budget accessors (`getNode`, `listNodes`, `getLoopGroup`,
 *   `listLoopGroups`, `getBudget`) so the graph_status query can read across
 *   sessions without owning the Map unwrapping.
 *
 * All functions are total (never throw): every filesystem and parse failure
 * path is contained. Directory semantics match `engine-persistence.ts` —
 * `stateDir` is the workspace directory, and the state files live under
 * `.rolebox/state/` (see `engineStatePath`, engine-persistence.ts:281).
 *
 * Design reference: `.rolebox/design/engine-state-machine.md` §4 (persistence
 * model); scan pattern mirrored from `engine-startup.ts:129-167`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEngineStateFromJson } from "../engine/index.ts";
import type { EngineState } from "../../types.engine-v2.ts";
import type {
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Matches the per-graph engine-state filenames written by `engine-persistence`. */
const ENGINE_STATE_FILENAME = /^engine-.+\.json$/;

// ── Result types ────────────────────────────────────────────────────────────

/** Outcome of scanning the persisted-state store. Total — never throws. */
export interface PersistedStateScan {
  /** Workspace directory that was scanned. */
  directory: string;
  /** Engine-state directory actually read (`.rolebox/state`). */
  stateDirectory: string;
  /** Total `engine-*.json` files present in the store. */
  count: number;
  /** Successfully hydrated engine states (valid v2, read OK). */
  loaded: EngineState[];
  /** Number of files skipped (corrupt / version-mismatched / read error). */
  skipped: number;
  /** Names of the skipped files, in scan order. */
  skippedFiles: string[];
}

/** JSON-primitive per-node projection for a cross-session summary. */
export interface PersistedNodeSummary {
  nodeId: string;
  agent: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
  loopGroupId?: string;
}

/**
 * Cross-session, JSON-primitive summary of a single persisted engine state.
 * Everything here is safe to serialize and to diff across sessions.
 */
export interface PersistedStateSummary {
  graphId: string;
  phase: string;
  /** Total nodes in the graph. */
  nodeCount: number;
  /** Count of nodes per lifecycle status (status string → count). */
  nodeStatusCounts: Record<string, number>;
  /** Per-node agent + status (+ timing) for the owning graph. */
  nodes: PersistedNodeSummary[];
  startedAt: number;
  updatedAt: number;
  frontier: string[];
  /** Whether the state carries any recorded lifecycle checkpoints. */
  hasCheckpoints: boolean;
}

// ── Scanner ───────────────────────────────────────────────────────────────

/**
 * Scan the persisted-state store under `stateDir/.rolebox/state` and hydrate
 * every `engine-*.json` file present.
 *
 * Corrupt JSON, schema-version-mismatched files, and unreadable files are
 * skipped honestly: they are counted in `skipped` / named in `skippedFiles`
 * and never included in `loaded`. A missing or unreadable store is a clean
 * empty result — `scanPersistedStates` never throws.
 *
 * @param stateDir - Workspace directory (the same `directory` argument
 *                   `EnginePersistence` / `engineStatePath` expect). The
 *                   engine-state files live under `.rolebox/state/`.
 */
export function scanPersistedStates(stateDir: string): PersistedStateScan {
  const stateDirectory = join(stateDir, ".rolebox", "state");

  let files: string[];
  try {
    files = readdirSync(stateDirectory, { encoding: "utf-8" }).filter((f) =>
      ENGINE_STATE_FILENAME.test(f),
    );
  } catch {
    // No `.rolebox/state` yet — clean start. Empty result, no error.
    return {
      directory: stateDir,
      stateDirectory,
      count: 0,
      loaded: [],
      skipped: 0,
      skippedFiles: [],
    };
  }

  // Deterministic scan order so cross-session output is stable for a given store.
  files.sort();

  const loaded: EngineState[] = [];
  const skippedFiles: string[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(stateDirectory, file), "utf-8");
      const state = loadEngineStateFromJson(raw, file);
      if (state) {
        loaded.push(state);
      } else {
        // Valid read, but corrupt / version-mismatched / not a v2 engine file.
        skippedFiles.push(file);
      }
    } catch {
      // Read error (e.g. permission, path churn mid-scan). Skip, never throw.
      skippedFiles.push(file);
    }
  }

  return {
    directory: stateDir,
    stateDirectory,
    count: files.length,
    loaded,
    skipped: skippedFiles.length,
    skippedFiles,
  };
}

// ── Summary builder ────────────────────────────────────────────────────────

/** Pure projection of one hydrated {@link EngineState} into a JSON summary. */
export function buildPersistedSummary(state: EngineState): PersistedStateSummary {
  const nodeStatusCounts: Record<string, number> = {};
  const nodes: PersistedNodeSummary[] = [];

  for (const n of state.nodes.values()) {
    nodeStatusCounts[n.status] = (nodeStatusCounts[n.status] ?? 0) + 1;
    nodes.push({
      nodeId: n.nodeId,
      agent: n.agent,
      status: n.status,
      startedAt: n.startedAt,
      completedAt: n.completedAt,
      retryCount: n.retryCount,
      loopGroupId: n.loopGroupId,
    });
  }

  return {
    graphId: state.graphId,
    phase: state.phase,
    nodeCount: state.nodes.size,
    nodeStatusCounts,
    nodes,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    frontier: [...state.frontier],
    hasCheckpoints: state.checkpoints != null && Object.keys(state.checkpoints).length > 0,
  };
}

/**
 * Scan the store and return the cross-session summary of every graph that
 * loaded successfully, ordered most-recently-updated first. Total — never
 * throws (delegates to {@link scanPersistedStates}).
 */
export function scanPersistedSummaries(stateDir: string): PersistedStateSummary[] {
  const { loaded } = scanPersistedStates(stateDir);
  return loaded
    .map((state) => buildPersistedSummary(state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Node / loop / budget accessors ─────────────────────────────────────────

/** Return a node's runtime state, or `undefined` if absent. */
export function getNode(
  state: EngineState,
  nodeId: string,
): NodeRuntimeState | undefined {
  return state.nodes.get(nodeId);
}

/** List all node runtime states (stable iteration order). */
export function listNodes(state: EngineState): NodeRuntimeState[] {
  return [...state.nodes.values()];
}

/** Return a loop group's runtime state, or `undefined` if absent. */
export function getLoopGroup(
  state: EngineState,
  loopId: string,
): LoopGroupRuntimeState | undefined {
  return state.loopGroups.get(loopId);
}

/** List all loop group runtime states (stable iteration order). */
export function listLoopGroups(state: EngineState): LoopGroupRuntimeState[] {
  return [...state.loopGroups.values()];
}

/** Return the graph's cumulative budget consumption. */
export function getBudget(state: EngineState): GraphBudgetState {
  return state.budget;
}
