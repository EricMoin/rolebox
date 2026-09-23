/**
 * Graph query surface — the stored-graph scanner
 *
 * Version: 3.0
 * Date: 2026-09-23
 *
 * A read-only, cross-session view over the workspace's ONE graph store. Whereas
 * `persistence/declared-record.ts` reads one graph's definition, this helper
 * scans the whole store and surfaces a summary of every declared graph it holds
 * — including graphs declared by earlier sessions that are no longer resident in
 * memory.
 *
 * P1 ITEM 5 REPOINTED THIS SCANNER. It used to list `.rolebox/state/engine-*.json`
 * and hydrate each through the v2 container loader. That container is no longer
 * written, so the scan now reads the `graph_definitions` table of
 * `graph-acceptance-ledger.sqlite` and derives each graph's operator view from
 * the stored definition plus the stored run-state body (the TEMPORARY pure
 * mapping in `declared-record.ts`, which P5 deletes with its consumers).
 *
 * Scope:
 * - `scanPersistedStates(storeDirectory)` — read every stored definition, decode
 *   it, project the recorded run position, and return the graphs this build can
 *   read. A definition — or a run state — that fails a gate is named in
 *   `skippedGraphs` (counted, never thrown, never fabricated: a graph whose
 *   recorded position is unreadable is NOT projected as an `idle` one). A store
 *   this build may not read at all is
 *   reported by its own verdict in `blocked` — never as "no graphs", which is
 *   the answer that would license a new run beside an unreadable one. A missing
 *   store yields an empty result, never an error.
 * - `buildPersistedSummary(state)` — a pure, JSON-primitive summary of one
 *   projected state (graphId, phase, node counts per status, per-node
 *   agent/status/timing, startedAt/updatedAt).
 * - `scanPersistedSummaries(storeDirectory)` — convenience combining the scan
 *   with the summary builder, ordered most-recently-updated first.
 * - Node / loop / budget accessors (`getNode`, `listNodes`, `getLoopGroup`,
 *   `listLoopGroups`, `getBudget`) so the graph_status query can read across
 *   sessions without owning the Map unwrapping.
 *
 * `storeDirectory` is the directory that HOLDS the store file — the root the
 * run path opens (`credentialIsolation.credentialStoreRoot` when the host
 * declares one, the workspace's `.rolebox/state` otherwise). It is no longer a
 * workspace directory the scanner appends `.rolebox/state` to: the store did not
 * move, the layout under a workspace did.
 *
 * All functions are total (never throw): every read, decode and projection
 * failure path is contained.
 */

import { loadGraphStoreSync } from "../store/load.ts";
import type { EngineState } from "../../types.engine-v2.ts";
import type {
  GraphBudgetState,
  LoopGroupRuntimeState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";
import type { RunControlRecord } from "../ledger/types.ts";
import {
  describeStoreVerdict,
  listStoredEngineStates,
} from "../persistence/declared-record.ts";

/** The empty control map a scan that read no store reports. */
const NO_CONTROLS: ReadonlyMap<string, RunControlRecord> = new Map();

// ── Result types ────────────────────────────────────────────────────────────

/** Outcome of scanning the stored-graph store. Total — never throws. */
export interface PersistedStateScan {
  /** The directory holding the authoritative store that was read. */
  storeDirectory: string;
  /**
   * How many graph definitions the store holds. Every stored definition is
   * counted exactly once: one that failed a gate is in `skipped`, never in both
   * `loaded` and `skipped` (the double count A19 caught).
   */
  count: number;
  /** Successfully decoded graphs, projected to the query-boundary shape. */
  loaded: EngineState[];
  /** Number of stored definitions skipped (failed a definition or run-state gate). */
  skipped: number;
  /** Graph ids of the skipped definitions, in scan order. */
  skippedGraphs: string[];
  /**
   * Set when the store itself could not be read (a damaged file, a retired
   * container beside it, a format this build has no decoder for). The scan is
   * then EMPTY and this names the verdict; a caller must not read it as
   * "no graphs".
   */
  blocked?: string;
  /**
   * The RUN-LEVEL control fact of every graph in {@link loaded}, by graph id
   * (P3 item 1). A graph absent from this map has no control fact — it was not
   * stopped by a trusted command — while a graph whose control row this build
   * cannot read is NOT in `loaded` at all: it is named in
   * {@link skippedGraphs}, exactly like a damaged run-state row, so no caller
   * can render it as an unchecked run.
   */
  controls: ReadonlyMap<string, RunControlRecord>;
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
 * Cross-session, JSON-primitive summary of a single stored graph.
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
  /** Whether the state carries any recorded lifecycle checkpoints. */
  hasCheckpoints: boolean;
}

// ── Scanner ───────────────────────────────────────────────────────────────

/**
 * Scan the workspace's graph store and read every declared graph it holds.
 *
 * A definition that fails a gate is skipped honestly: counted in `skipped` /
 * named in `skippedGraphs` and never included in `loaded` — and so is a stored
 * graph whose RUN STATE cannot be decoded, which must not be reported as an
 * `idle` graph, and one whose run-CONTROL row cannot be read, which must not be
 * reported as an unchecked one. A missing store is a clean empty result; a store
 * this build may not read is an empty result with `blocked` set.
 * `scanPersistedStates` never throws.
 *
 * @param storeDirectory - The directory holding
 *   `graph-acceptance-ledger.sqlite` (the root the run path opens).
 */
export function scanPersistedStates(storeDirectory: string): PersistedStateScan {
  const loaded = loadGraphStoreSync(storeDirectory);
  if (loaded.kind === "absent") {
    return {
      storeDirectory,
      count: 0,
      loaded: [],
      skipped: 0,
      skippedGraphs: [],
      controls: NO_CONTROLS,
    };
  }
  if (loaded.kind !== "valid") {
    return {
      storeDirectory,
      count: 0,
      loaded: [],
      skipped: 0,
      skippedGraphs: [],
      blocked: describeStoreVerdict(loaded),
      controls: NO_CONTROLS,
    };
  }
  const listing = listStoredEngineStates(storeDirectory);
  // THE RUN-LEVEL CONTROL FACT IS READ FROM THE SAME STORE (P3 item 1), on the
  // handle this scan borrowed, so a status render can say a run was STOPPED
  // instead of rendering its recorded phase as if it were still moving. A
  // control row this build cannot read is a SKIP, never an unchecked run: the
  // graph keeps none of its position in `loaded` and is named in
  // `skippedGraphs`, the same treatment a damaged run-state row gets.
  const controls = new Map<string, RunControlRecord>();
  const states: EngineState[] = [];
  const skipped = [...listing.skipped];
  try {
    for (const state of listing.states) {
      let control: RunControlRecord | undefined;
      try {
        control = loaded.value.readRunControl(state.graphId);
      } catch {
        skipped.push(state.graphId);
        continue;
      }
      if (control !== undefined) controls.set(state.graphId, control);
      states.push(state);
    }
  } finally {
    // The scan BORROWED this read-only handle; `listStoredEngineStates` opened
    // and closed its own. Returning the borrow keeps the process's shared
    // read-only connection refcount balanced across scans.
    loaded.value.close();
  }
  return {
    storeDirectory,
    // Each stored definition is in exactly one bucket, so this is the store's
    // definition count (see listStoredEngineStates).
    count: listing.states.length + listing.skipped.length,
    loaded: states,
    skipped: skipped.length,
    skippedGraphs: skipped.slice().sort(),
    controls,
  };
}

// ── Summary builder ────────────────────────────────────────────────────────

/**
 * Pure projection of one projected state into a JSON summary.
 *
 * @internal No production caller — `graph-tools.ts` imports only
 * {@link scanPersistedStates}. Retained as a published surface (this package
 * ships `dist/`, so the export is not removed) and exercised by
 * `tests/graph/persisted-state.test.ts`; see FIX-PLAN B19.
 */
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
    hasCheckpoints: state.checkpoints != null && Object.keys(state.checkpoints).length > 0,
  };
}

/**
 * Scan the store and return the cross-session summary of every graph that
 * decoded successfully, ordered most-recently-updated first. Total — never
 * throws (delegates to {@link scanPersistedStates}).
 *
 * @internal No production caller (see {@link buildPersistedSummary}); retained
 * as a published surface per FIX-PLAN B19.
 */
export function scanPersistedSummaries(storeDirectory: string): PersistedStateSummary[] {
  const { loaded } = scanPersistedStates(storeDirectory);
  return loaded
    .map((state) => buildPersistedSummary(state))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Node / loop / budget accessors ─────────────────────────────────────────

/**
 * Return a node's runtime state, or `undefined` if absent.
 *
 * @internal Convenience accessor over `state.nodes` with no production caller
 * (the tools layer reads the maps directly); retained as a published surface
 * per FIX-PLAN B19.
 */
export function getNode(
  state: EngineState,
  nodeId: string,
): NodeRuntimeState | undefined {
  return state.nodes.get(nodeId);
}

/**
 * List all node runtime states (stable iteration order).
 *
 * @internal No production caller — see {@link getNode} (FIX-PLAN B19).
 */
export function listNodes(state: EngineState): NodeRuntimeState[] {
  return [...state.nodes.values()];
}

/**
 * Return a loop group's runtime state, or `undefined` if absent.
 *
 * @internal No production caller — see {@link getNode} (FIX-PLAN B19).
 */
export function getLoopGroup(
  state: EngineState,
  loopId: string,
): LoopGroupRuntimeState | undefined {
  return state.loopGroups.get(loopId);
}

/**
 * List all loop group runtime states (stable iteration order).
 *
 * @internal No production caller — see {@link getNode} (FIX-PLAN B19).
 */
export function listLoopGroups(state: EngineState): LoopGroupRuntimeState[] {
  return [...state.loopGroups.values()];
}

/**
 * Return the graph's cumulative budget consumption.
 *
 * @internal No production caller — see {@link getNode} (FIX-PLAN B19).
 */
export function getBudget(state: EngineState): GraphBudgetState {
  return state.budget;
}
