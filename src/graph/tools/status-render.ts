/**
 * Graph Execution Engine v2 — Stateless `graph_status` Render Helpers
 *
 * Version: 2.0
 * Date: 2026-09-18
 *
 * The render / format half of the `graph_*` tool layer, extracted from the
 * 3333-line `GraphToolSet` god-module (FIX-PLAN Y30). Every function here is a
 * free function over explicitly-passed inputs — no registry, no engine wiring,
 * no `this` — so the toolset class keeps only the stateful surface (registry,
 * deps, engine assembly, the eight tool entry points) while these helpers stay
 * directly unit-testable. The public toolset contract is unchanged.
 *
 * Contract notes:
 * - Every reader returns REAL recorded engine state or an explicit
 *   honest-empty result; none fabricates rows (see `status-queries.ts`).
 * - Signatures take `(state, args, …)` in that order wherever both are
 *   needed, mirroring the `graph_status` entry point.
 * - {@link flagData} is the pure replacement for the old mutating
 *   `mergeFlagData(target, …)`: it returns the C-WIRE flag keys to spread onto
 *   a snapshot, so the `graph_status` JSON shape is carried by
 *   `GraphStatusSnapshot` / `GraphNodeSummary` / `GraphLoopSummary` instead of
 *   being assembled through a `Record<string, unknown>` (Y27).
 * - {@link checkpointEntries} reads `checkpointHistory` as the authoritative
 *   record and treats `checkpoints` as its derived latest-snapshot view; the
 *   legacy fallback is surfaced with a warning rather than passing silently
 *   (Y9).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { MaterializedResultRef } from "../../dispatch/types.ts";
import type {
  CheckpointRecord,
  EngineState,
  GraphBudgetState,
  NodeRuntimeState,
  RoundHistoryEntry,
  SignalLedgerEvent,
} from "../../types.engine-v2.ts";
import type { GraphDeclaration, LoopMode } from "../../types.graph-v2.ts";
import { createSubLogger } from "../../logger.ts";
import { getSignal, SIGNAL_KEY } from "./signal-payload.ts";
import type { PersistedStateScan } from "./persisted-state.ts";
import {
  filterNodes,
  isRecordedSignal,
  toEpochMs,
  type StatusQuery,
} from "./status-queries.ts";
import type { GraphStatusArgs } from "./graph-tools.ts";

const log = createSubLogger("graph:tools:status-render");

/** Default `graph_status` output cap (chars) when `max_chars` is unset. */
export const DEFAULT_MAX_CHARS = 16000;

// ── Extracted JSON entry shapes (Y27) ───────────────────────────────────────

/** One loop group's requested round history (see {@link loopRoundEntries}). */
export interface GraphRoundHistoryEntry {
  loop_id: string;
  rounds: RoundHistoryEntry[];
  requested_round?: number;
}

/** One node's recorded lifecycle checkpoints (see {@link checkpointEntries}). */
export interface GraphCheckpointEntry {
  node_id: string;
  checkpoints: CheckpointRecord[];
}

/** One node's recorded artifacts / evidence (see {@link artifactsEvidenceEntries}). */
export interface GraphArtifactsEvidenceEntry {
  node_id: string;
  artifacts?: string[];
  evidence?: string[];
}

/** One node's timestamped signal-event history (see {@link signalStreamEntries}). */
export interface GraphSignalStreamEntry {
  node_id: string;
  events: SignalLedgerEvent[];
}

/**
 * The C-WIRE observability keys {@link flagData} contributes to a
 * `graph_status` JSON snapshot, and onto the node- / loop-scoped summaries.
 * Every key is optional and present only for the flag that produced it, so
 * default output stays byte-identical.
 */
export interface GraphFlagData {
  round_history?: GraphRoundHistoryEntry[];
  checkpoints?: GraphCheckpointEntry[];
  artifacts_evidence?: GraphArtifactsEvidenceEntry[];
  signal_stream?: GraphSignalStreamEntry[];
}

/** Graph-level budget breakdown (see {@link budgetSummary}). */
export interface GraphBudgetSummary {
  graph: GraphBudgetState;
  nodes: Array<{
    node_id: string;
    sessions: number;
    tokens: { input: number; output: number };
    cost: number;
  }>;
}

/** One loop group's summary rows (see `GraphToolSet.loopSummary`). */
export interface GraphLoopSummary {
  loop_id: string;
  traversals: string;
  nodes: string[];
  consecutive_stale: number;
  mode?: LoopMode;
}

/** A node's latest progress signal (see {@link progressForNode}). */
export interface NodeProgressSummary {
  /** Whether the node's ledger carries a `progress` entry at all. */
  recorded: boolean;
  /** The recorded progress payload (any JSON value), when present. */
  payload: unknown;
  /**
   * The node's LAST SIGNAL time of ANY type (`SignalLedgerEntry.lastSignalAt`),
   * not a progress-specific stamp — a recency anchor for the payload.
   */
  lastSignalAt: number | undefined;
}

// ── Declaration / file IO helpers ───────────────────────────────────────────

/**
 * Copy a declaration deeply enough that a later mutation of the caller's
 * object graph cannot reach the committed registry entry (Y31). One level per
 * collection: nodes / edges / loop groups / budget are fresh objects, and the
 * arrays that hang off an edge mapping are copied by their callers before the
 * declaration is built.
 */
export function shallowCloneDeclaration(d: GraphDeclaration): GraphDeclaration {
  return {
    ...d,
    nodes: d.nodes.map((n) => ({ ...n })),
    edges: d.edges.map((e) => ({ ...e })),
    loop_groups: d.loop_groups?.map((g) => ({ ...g })),
    budget: d.budget ? { ...d.budget } : undefined,
  };
}

/**
 * Atomically write `content` to `exportPath`: write to a sibling
 * `<path>.<pid>.tmp` file, then rename it into place. Renaming is atomic on
 * POSIX filesystems, so a reader never observes a partially-written target
 * and no `.tmp` artifact remains after a successful write.
 */
export function writeAtomic(exportPath: string, content: string): void {
  const tmpPath = `${exportPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, exportPath);
}

/** Read a materialized node result from its sidecar file, best-effort. */
export function resultText(ref: MaterializedResultRef): string {
  if (ref.fetchError) return `[fetch error: ${ref.fetchError}]`;
  try {
    return existsSync(ref.sidecarPath) ? readFileSync(ref.sidecarPath, "utf8") : "";
  } catch {
    return "";
  }
}

// ── Declaration lookups ─────────────────────────────────────────────────────

/**
 * Resolve the member node ids of a loop group from the graph **declaration**.
 * The runtime `LoopGroupRuntimeState` does not carry the member list; it lives
 * on `graphDeclaration.loop_groups`.
 */
export function loopNodeIds(state: EngineState, loopId: string): string[] {
  const group = state.graphDeclaration.loop_groups?.find((g) => g.id === loopId);
  return group ? [...group.nodes] : [];
}

/**
 * Resolve a loop group's declared session-isolation `mode` from the graph
 * **declaration**. Like the member list, the mode lives on
 * `graphDeclaration.loop_groups` (the runtime `LoopGroupRuntimeState` does not
 * carry it). Returns `undefined` when unset — callers must omit it from output
 * to keep the default render byte-identical.
 */
export function loopDeclMode(state: EngineState, loopId: string): LoopMode | undefined {
  const group = state.graphDeclaration.loop_groups?.find((g) => g.id === loopId);
  return group?.mode;
}

/**
 * Materialize the node set narrowed to `nodeFilter` as a `Map<nodeId, node>`
 * (or the whole state node map when no filter is active). Used by the
 * `group_by` view, which needs a keyed node set rather than an id list.
 */
export function visibleNodeMap(
  state: EngineState,
  nodeFilter?: Set<string>,
): ReadonlyMap<string, NodeRuntimeState> {
  if (!nodeFilter) return state.nodes;
  const map = new Map<string, NodeRuntimeState>();
  for (const id of nodeFilter) {
    const node = state.nodes.get(id);
    if (node) map.set(id, node);
  }
  return map;
}

/**
 * Build the set of node ids matching the active filter/query args, or return
 * `undefined` when no filter is present (the renderer then shows all nodes).
 * The matching is delegated entirely to the pure `status-queries.ts` module.
 */
export function buildNodeFilter(
  state: EngineState,
  args: GraphStatusArgs,
): Set<string> | undefined {
  const query: StatusQuery = {
    query: args.query,
    status: args.status,
    agent: args.agent,
    from_date: args.from_date,
    to_date: args.to_date,
  };
  const hasFilter =
    query.query !== undefined ||
    query.status !== undefined ||
    query.agent !== undefined ||
    query.from_date !== undefined ||
    query.to_date !== undefined;
  if (!hasFilter) return undefined;
  const matched = filterNodes(state.nodes, query);
  return new Set(matched.map((n) => n.nodeId));
}

/** Sum the cumulative budget consumption across the graphs in scope. */
export function crossSessionBudget(states: EngineState[]): GraphBudgetState {
  const total: GraphBudgetState = {
    sessionsSpawned: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
  };
  for (const s of states) {
    total.sessionsSpawned += s.budget.sessionsSpawned;
    total.totalInputTokens += s.budget.totalInputTokens;
    total.totalOutputTokens += s.budget.totalOutputTokens;
    total.totalCost += s.budget.totalCost;
  }
  return total;
}

/** True when a filter/group_by/include_budget view is active (drives the
 * cross-session aggregate rather than the plain graph list). */
export function crossSessionViewRequested(args: GraphStatusArgs): boolean {
  return (
    args.query !== undefined ||
    args.status !== undefined ||
    args.agent !== undefined ||
    args.from_date !== undefined ||
    args.to_date !== undefined ||
    args.group_by !== undefined ||
    args.include_budget === true
  );
}

/** Honest-empty note for a store that yielded no readable graph. */
export function persistedEmptyNote(scan: PersistedStateScan): string {
  if (scan.blocked !== undefined) {
    return (
      `The graph store at ${scan.storeDirectory} cannot be read: ${scan.blocked}. ` +
      `No persisted query is answered from it — an unreadable store is never ` +
      `reported as an empty one.`
    );
  }
  if (scan.count === 0) {
    return (
      `No persisted graphs found in the graph store at ${scan.storeDirectory}. Run a ` +
      `graph to a persisted checkpoint to enable cross-session (scope=persisted) queries.`
    );
  }
  // Definitions present but none decoded — a gate refused each of them.
  return (
    `Persisted graphs: none readable — ${scan.skipped} stored definition(s) skipped ` +
    `(${scan.skippedGraphs.join(", ")}).`
  );
}

/**
 * Extract a node's recorded `progress` signal, if any, from the engine state.
 *
 * The DELETED legacy signal engine recorded every signal a node emitted into
 * both `node.signalsObserved[type]` and the graph-level
 * `state.signalLedger[nodeId]` (via `signal-bridge.ts:record`); the outcome run
 * path records no signals, so this reads whatever a persisted record carries.
 * `progress` is an INFO signal (one of `INFO_SIGNALS`), so — on a record the
 * legacy runtime wrote — its latest payload is genuinely available here. The
 * ledger read goes through the shared `getSignal` / `SIGNAL_KEY` seam
 * (contract C2 / Y8), so a missing or malformed ledger answers `undefined`
 * instead of throwing. Note this is the
 * **latest** payload per node, not a timestamped multi-event history (the
 * design's `dispatch_stream`-style `since`-based history is unbacked — see
 * `UNSUPPORTED_GRAPH_STATUS_FLAGS` `stream`/`since`).
 *
 * `lastSignalAt` is the node's LAST SIGNAL time of ANY type — the graph-level
 * `SignalLedgerEntry.lastSignalAt` (written by the deleted recorder on
 * every signal, progress or not), NOT a progress-specific stamp. It rides along
 * with the progress payload so a consumer gets a recency anchor, but it is
 * named for what it actually is.
 */
export function progressForNode(
  state: EngineState,
  node: NodeRuntimeState,
): NodeProgressSummary {
  const payload = getSignal(node, SIGNAL_KEY.progress, isRecordedSignal);
  const recorded = payload !== undefined;
  const lastSignalAt = state.signalLedger.get(node.nodeId)?.lastSignalAt;
  return { recorded, payload, lastSignalAt };
}

// ── C-WIRE entry extractors (JSON flag data) ────────────────────────────────

/**
 * Extract the per-loop round history from `LoopGroupRuntimeState.rounds[]`,
 * scoped to one loop (when `args.loop_id`) and optionally filtered to a single
 * `args.round`. Sorted ascending by round index. `rounds` is OPTIONAL-ADDITIVE
 * — absent (or empty) until a round is recorded; never fabricated.
 */
export function loopRoundEntries(
  state: EngineState,
  args: GraphStatusArgs,
): GraphRoundHistoryEntry[] {
  const groups = args.loop_id
    ? [...state.loopGroups.values()].filter((l) => l.id === args.loop_id)
    : [...state.loopGroups.values()];
  return groups.map((l) => {
    const rounds = [...(l.rounds ?? [])].sort((a, b) => a.round - b.round);
    const filtered =
      args.round !== undefined
        ? rounds.filter((r) => r.round === args.round)
        : rounds;
    return { loop_id: l.id, rounds: filtered, requested_round: args.round };
  });
}

/**
 * Extract per-node lifecycle checkpoints from `EngineState.checkpointHistory`
 * (`Record<nodeId, CheckpointRecord[]>` — the ordered, append-only list),
 * scoped to a node when `nodeId` is given.
 *
 * `checkpointHistory` is the authoritative record (every transition, earliest
 * first — `types.engine-v2.ts`); `EngineState.checkpoints` is its derived
 * latest-snapshot view, retained for backward compat with pre-history persisted
 * states. When a node has no history at all but does carry the derived snapshot,
 * this falls back to that single snapshot and emits an explicit degradation
 * warning naming the node (Y9) — the fallback is never silent. Absent until a
 * checkpoint is recorded.
 */
export function checkpointEntries(
  state: EngineState,
  nodeId?: string,
): GraphCheckpointEntry[] {
  const out: GraphCheckpointEntry[] = [];
  const ids = new Set([
    ...Object.keys(state.checkpoints ?? {}),
    ...Object.keys(state.checkpointHistory ?? {}),
  ]);
  for (const id of ids) {
    if (nodeId !== undefined && id !== nodeId) continue;
    const history = state.checkpointHistory?.[id];
    const cps =
      history && history.length > 0 ? [...history] : legacyLatestCheckpoint(state, id);
    if (cps.length === 0) continue;
    out.push({ node_id: id, checkpoints: cps });
  }
  return out;
}

/**
 * The derived latest-snapshot view, consulted only when a node has no recorded
 * history (a state persisted before `checkpointHistory` existed). The
 * degradation is logged so "history missing" is distinguishable from "history
 * empty" (Y9).
 */
function legacyLatestCheckpoint(
  state: EngineState,
  nodeId: string,
): CheckpointRecord[] {
  const latest = state.checkpoints?.[nodeId];
  if (latest === undefined) return [];
  log.warn(
    `graph-status: node "${nodeId}" has no checkpointHistory — falling back to the ` +
      `derived latest-snapshot checkpoint (pre-history persisted state).`,
  );
  return [latest];
}

/**
 * Extract per-node artifacts / evidence from `NodeRuntimeState.artifacts[]` /
 * `.evidence[]`, scoped to a node when `nodeId` is given. Nodes with no
 * recorded array for a requested flag are omitted from that entry (honest
 * absence — never invented values).
 */
export function artifactsEvidenceEntries(
  state: EngineState,
  args: GraphStatusArgs,
  nodeId?: string,
): GraphArtifactsEvidenceEntry[] {
  const out: GraphArtifactsEvidenceEntry[] = [];
  for (const n of state.nodes.values()) {
    if (nodeId !== undefined && n.nodeId !== nodeId) continue;
    const entry: GraphArtifactsEvidenceEntry = { node_id: n.nodeId };
    if (args.include_artifacts && n.artifacts && n.artifacts.length > 0) {
      entry.artifacts = [...n.artifacts];
    }
    if (args.include_evidence && n.evidence && n.evidence.length > 0) {
      entry.evidence = [...n.evidence];
    }
    // Honest omission: a node with no recorded data for any requested flag is
    // not invented into the list (mirrors the text renderer).
    if (entry.artifacts === undefined && entry.evidence === undefined) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Extract per-node timestamped signal-event histories from
 * `SignalLedgerEntry.history[]`, scoped to a node when `nodeId` is given.
 * When `args.since` is a valid ISO-8601 timestamp, events strictly before it
 * are filtered out; an INVALID `since` throws (aligned with the
 * from_date/to_date filter surface). Sorted ascending by `atMs`. An
 * absent/empty `history` yields an empty event list — the caller surfaces the
 * honest "no events" note.
 */
export function signalStreamEntries(
  state: EngineState,
  args: GraphStatusArgs,
  nodeId?: string,
): GraphSignalStreamEntry[] {
  // Monitor L2: an invalid `since` THROWS (via the shared toEpochMs, the same
  // throw pattern as from_date/to_date) instead of silently ignoring the bound
  // — a garbage timestamp must never silently broaden a stream.
  const sinceMs = args.since !== undefined ? toEpochMs(args.since) : undefined;
  const out: GraphSignalStreamEntry[] = [];
  for (const [id, ledger] of state.signalLedger) {
    if (nodeId !== undefined && id !== nodeId) continue;
    const events = [...(ledger.history ?? [])]
      .filter((e) => sinceMs === undefined || e.atMs >= sinceMs)
      .sort((a, b) => a.atMs - b.atMs);
    out.push({ node_id: id, events });
  }
  return out;
}

// ── C-WIRE flag data (pure merge) ───────────────────────────────────────────

/**
 * True when any of the seven C-WIRE observability flags is active. When none
 * are set, the flag sections / flag data are omitted and the base render is
 * returned byte-identical to legacy output.
 */
export function flagSectionsActive(args: GraphStatusArgs): boolean {
  return (
    args.include_history ||
    args.round !== undefined ||
    args.include_checkpoint ||
    args.include_artifacts ||
    args.include_evidence ||
    args.stream ||
    args.since !== undefined
  );
}

/**
 * Build the structured C-WIRE flag data for a JSON snapshot (json formats).
 * Returns an empty object when no flag is active, so spreading the result keeps
 * the snapshot byte-identical otherwise. Data is extracted from the same
 * genuine engine fields as the text renderers — the pure replacement for the
 * old mutating `mergeFlagData(target, …)` (Y27).
 */
export function flagData(state: EngineState, args: GraphStatusArgs): GraphFlagData {
  if (!flagSectionsActive(args)) return {};
  return {
    ...(args.include_history || args.round !== undefined
      ? { round_history: loopRoundEntries(state, args) }
      : {}),
    ...(args.include_checkpoint
      ? { checkpoints: checkpointEntries(state, args.node_id) }
      : {}),
    ...(args.include_artifacts || args.include_evidence
      ? {
          artifacts_evidence: artifactsEvidenceEntries(state, args, args.node_id),
        }
      : {}),
    ...(args.stream || args.since !== undefined
      ? { signal_stream: signalStreamEntries(state, args, args.node_id) }
      : {}),
  };
}

// ── Text renderers / summaries ──────────────────────────────────────────────

/**
 * Render the graph's node dependency tree, optionally narrowed to
 * `nodeFilter` and pruned at `depth` levels (0 = roots only; `undefined` =
 * full depth, byte-identical to legacy output). Children come from the
 * declaration's edges; loop back-edges are annotated and never recursed into.
 */
export function renderTree(
  state: EngineState,
  nodeFilter?: Set<string>,
  depth?: number,
): string {
  // Visible node ids: the filter set, or every node when no filter is active.
  const visible = nodeFilter
    ? new Set([...nodeFilter].filter((id) => state.nodes.has(id)))
    : new Set(state.nodes.keys());
  // Child adjacency from edges; render BFS from roots — restricted to visible nodes.
  const children = new Map<string, string[]>();
  for (const id of visible) children.set(id, []);
  for (const edge of state.graphDeclaration.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const roots = state.graphDeclaration.nodes
    .filter((n) => visible.has(n.id))
    .filter((n) => !state.graphDeclaration.edges.some((e) => e.to === n.id && visible.has(e.from)))
    .map((n) => n.id);

  // Depth cutoff: `undefined` means full depth (byte-identical to legacy).
  // `d > maxDepth` is always false when maxDepth is undefined, so the pruned
  // nodes are never marked visited and are simply absent from the output.
  const maxDepth = depth;
  const lines: string[] = [];
  lines.push(`Graph "${state.graphId}" [${state.phase}]`);
  const visited = new Set<string>();
  const render = (id: string, prefix: string, d: number): void => {
    if (maxDepth !== undefined && d > maxDepth) return;
    if (visited.has(id)) {
      // Back-edge within a loop group — already rendered upstream. Annotate
      // it and stop so tree rendering never recurses on the cycle.
      const n = state.nodes.get(id);
      lines.push(`${prefix}${id} ${n ? `[${n.status}] (back-edge)` : "(back-edge)"}`);
      return;
    }
    visited.add(id);
    const node = state.nodes.get(id);
    const label = node ? `${node.nodeId} [${node.status}]` : id;
    lines.push(`${prefix}${label}`);
    for (const child of children.get(id) ?? []) {
      render(child, `${prefix}  `, d + 1);
    }
  };
  for (const root of roots) {
    if (!visited.has(root)) render(root, "", 0);
  }
  return lines.join("\n");
}

/** Graph + per-node budget breakdown for the `include_budget` JSON view. */
export function budgetSummary(state: EngineState): GraphBudgetSummary {
  return {
    graph: state.budget,
    nodes: [...state.nodes.values()].map((n) => ({
      node_id: n.nodeId,
      sessions: n.sessionsSpawned,
      tokens: {
        input: n.tokensConsumed.inputTokens,
        output: n.tokensConsumed.outputTokens,
      },
      cost: n.tokensConsumed.cost,
    })),
  };
}

/** One-line phase + per-status node counts, e.g. `phase=executing running=2`. */
export function metricsSummary(state: EngineState): string {
  const counts = new Map<string, number>();
  for (const n of state.nodes.values()) {
    counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
  return `phase=${state.phase} ${parts}`;
}

/** Apply max_chars / offset / tail pagination to a string output.
 *
 * Monitor L3: when truncation actually drops content, a `…[truncated: N more
 * chars]` marker is APPENDED to the tail of the returned text (N = the number
 * of chars NOT included in the result), so a consumer can tell the output was
 * cut and by how much. The marker is emitted for both tail mode (head
 * dropped) and head mode (tail dropped) — the returned slice is always
 * `max_chars` chars, the marker rides after it. No truncation → no marker
 * (byte-identical to legacy output). */
export function paginate(text: string, args: GraphStatusArgs): string {
  const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
  if (maxChars <= 0 || text.length <= maxChars) {
    return args.offset ? text.slice(args.offset) : text;
  }
  const slice = args.tail
    ? text.slice(Math.max(0, text.length - maxChars))
    : text.slice(args.offset ?? 0, (args.offset ?? 0) + maxChars);
  const dropped = text.length - slice.length;
  return `${slice}\n…[truncated: ${dropped} more chars]`;
}
