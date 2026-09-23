/**
 * Graph Execution Engine v2 — Pure `graph_status` Filter/Query Helpers
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * PURE, dependency-free filtering of an engine node set. These functions do
 * NOT read or mutate {@link EngineState} — they take a read-only node set
 * (`ReadonlyMap<string, NodeRuntimeState>`) and return a filtered array of
 * {@link NodeRuntimeState}. They are wired into the `graph_status` renderers
 * in `graph-tools.ts` (which calls this module) and are independently unit
 * tested in `tests/graph/graph-status-filters.test.ts`.
 *
 * ## Filters (AND-combined when more than one is supplied)
 *
 *   - `query`      — case-insensitive substring match on nodeId / prompt / agent.
 *   - `status`     — exact {@link NodeStatus} match (canonical lowercase values
 *                    from `src/constants.ts` `NodeStatus`).
 *   - `agent`      — exact agent match.
 *   - `from_date` / `to_date` — ISO-8601 window on node timestamps.
 *
 * ## Date-window semantics (honest, never fabricated)
 *
 *   - `from_date` (ISO) — include a node when `startedAt >= from` (epoch ms).
 *   - `to_date`   (ISO) — include a node ONLY when it has a `completedAt` and
 *                    `completedAt <= to`. A node with no `completedAt` (still
 *                    pending/ready/running) does NOT match a `to_date` bound —
 *                    there is no completion timestamp to compare, so claiming
 *                    it "completed within the window" would fabricate data.
 *   - When both bounds are given, a node matches only if it has BOTH a
 *     `startedAt >= from` AND a `completedAt <= to` (i.e. it completed within
 *     the window). Invalid ISO strings throw a descriptive {@link Error} — a
 *     garbage date can never silently broaden or narrow a result set.
 *
 * All filtering here is pure: `filterNodes` returns an honest subset of the
 * input; a no-match filter yields an empty array, never invented rows.
 *
 * ## View flags (subtask 3 — appended additively, nothing above is rewritten)
 *
 *   - `limitNodes`      — cap a node-row list at `limit` rows (summary/json).
 *   - `groupCompletedNodes` — bucket COMPLETED nodes over their `completedAt`
 *     by `hour` / `day` / `agent`. Uncompleted nodes (no `completedAt`, or a
 *     status other than completed) are excluded honestly — never bucketed into
 *     an invented slot. Each bucket carries a genuine `nodes` id list.
 *   - `depth`           — a pure tree concern (cutoff at N levels); the render
 *     wiring lives in `graph-tools.ts`. `limitNodes` returns the input array
 *     unchanged when `limit` is unset, and `groupCompletedNodes` is a distinct
 *     view mode — so default summary/json/tree output is byte-identical when
 *     the new flags are unset.
 *
 * Data source: {@link NodeRuntimeState} (`src/types.engine-v2.ts:72-132`)
 * carries nodeId / prompt / agent / status / startedAt / completedAt directly.
 */

import { NodeStatus } from "../../constants.ts";
import type { EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";

/**
 * The `graph_status` filter surface. Every field is optional — a filter is
 * active only when its value is supplied (`undefined` = not applied).
 */
export interface StatusQuery {
  /** Case-insensitive substring match on nodeId / prompt / agent. */
  query?: string;
  /** Exact {@link NodeStatus} match (canonical lowercase value). */
  status?: NodeStatus;
  /** Exact agent match. */
  agent?: string;
  /** ISO-8601 window lower bound (node.startedAt >= from). */
  from_date?: string;
  /** ISO-8601 window upper bound (node.completedAt <= to, when completed). */
  to_date?: string;
}

/**
 * A `signalsObserved` ledger entry that is present. The shared `getSignal`
 * seam (contract C2) takes a type predicate, and a stored `undefined` is
 * indistinguishable from an absent key — so this is exactly the "recorded at
 * all" test the ad-hoc `signalsObserved?.[key]` reads used to spell out (Y8),
 * now shared by every tools-layer ledger read.
 */
export function isRecordedSignal(value: unknown): value is unknown {
  return value !== undefined;
}

/** Parse an ISO-8601 string to epoch ms, or throw on an invalid value. */
export function toEpochMs(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`graph_status: invalid date "${iso}" — expected an ISO-8601 string.`);
  }
  return ms;
}

/**
 * Case-insensitive substring match on nodeId / prompt / agent.
 * A trimmed empty query matches nothing — never the whole set.
 */
function queryPredicate(query: string): (n: NodeRuntimeState) => boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return () => false;
  const hay = (s: string | undefined) => s?.toLowerCase() ?? "";
  return (n) =>
    hay(n.nodeId).includes(needle) ||
    hay(n.prompt).includes(needle) ||
    hay(n.agent).includes(needle);
}

/**
 * Date-window predicate. `from_date` / `to_date` are ISO strings; either may
 * be omitted. A node matches only when it has the data to answer the bound (see
 * the module header for the honest semantics). The bounds are parsed EAGERLY,
 * so an invalid ISO string throws when the predicate is built — matching the
 * exported {@link filterByDateWindow} contract even for an empty node set.
 */
function dateWindowPredicate(
  from_date?: string,
  to_date?: string,
): (n: NodeRuntimeState) => boolean {
  const from = from_date !== undefined ? toEpochMs(from_date) : undefined;
  const to = to_date !== undefined ? toEpochMs(to_date) : undefined;
  return (n) => {
    if (from !== undefined && n.startedAt < from) return false;
    if (to !== undefined) {
      // A node with no completion timestamp cannot satisfy an upper bound.
      if (n.completedAt === undefined) return false;
      if (n.completedAt > to) return false;
    }
    return true;
  };
}

/** Case-insensitive substring match on nodeId / prompt / agent. */
export function filterByQuery(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  query: string,
): NodeRuntimeState[] {
  return [...nodes.values()].filter(queryPredicate(query));
}

/** Exact {@link NodeStatus} match. */
export function filterByStatus(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  status: NodeStatus,
): NodeRuntimeState[] {
  return [...nodes.values()].filter((n) => n.status === status);
}

/** Exact agent match. */
export function filterByAgent(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  agent: string,
): NodeRuntimeState[] {
  const target = agent.trim();
  return [...nodes.values()].filter((n) => n.agent === target);
}

/**
 * Date-window filter. `from_date` / `to_date` are ISO strings; either may be
 * omitted. A node matches only when it has the data to answer the bound (see
 * the module header for the honest semantics).
 */
export function filterByDateWindow(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  from_date?: string,
  to_date?: string,
): NodeRuntimeState[] {
  return [...nodes.values()].filter(dateWindowPredicate(from_date, to_date));
}

/**
 * Apply every supplied filter to the node set (AND-combined). Returns an
 * honest subset of the input — an empty array when nothing matches, never
 * fabricated rows. When no filter field is present, returns all nodes.
 *
 * Each active predicate is evaluated exactly once per node and the working set
 * is narrowed in place; the cheapest predicate (the substring query) is
 * composed first so `every` short-circuits on it. The old implementation
 * recomputed every enabled filter over the FULL node set, built an id `Set`
 * per filter, and intersected — semantically identical, needlessly quadratic.
 */
export function filterNodes(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  query: StatusQuery,
): NodeRuntimeState[] {
  const predicates: Array<(n: NodeRuntimeState) => boolean> = [];
  if (query.query !== undefined) {
    predicates.push(queryPredicate(query.query));
  }
  if (query.status !== undefined) {
    const status = query.status;
    predicates.push((n) => n.status === status);
  }
  if (query.agent !== undefined) {
    const target = query.agent.trim();
    predicates.push((n) => n.agent === target);
  }
  if (query.from_date !== undefined || query.to_date !== undefined) {
    predicates.push(dateWindowPredicate(query.from_date, query.to_date));
  }
  if (predicates.length === 0) return [...nodes.values()];
  return [...nodes.values()].filter((n) => predicates.every((p) => p(n)));
}

// ── View flags (subtask 3 — additive, do not rewrite the filters above) ─────

/** The `group_by` aggregation mode for completed-node bucketing. */
export type GroupByMode = "hour" | "day" | "agent";

/** A completed-node bucket produced by {@link groupCompletedNodes}. */
export interface GroupBucket {
  /** Bucket key: an ISO hour (`YYYY-MM-DDTHH:00:00.000Z`), an ISO date
   *  (`YYYY-MM-DD`), or the agent id for the `agent` mode. */
  key: string;
  /** Number of completed nodes in this bucket. */
  count: number;
  /** Node ids in this bucket — genuine, derived from real `completedAt` data. */
  nodes: string[];
}

/**
 * Cap a node-row list at `limit` rows for summary/json rendering. A `limit` of
 * `undefined` or `<= 0` leaves the list untouched (unbounded — the default), so
 * existing output is byte-identical when `limit` is unset. Never reorders.
 */
export function limitNodes(
  nodes: ReadonlyArray<NodeRuntimeState>,
  limit?: number,
): NodeRuntimeState[] {
  if (limit === undefined || limit <= 0) return [...nodes];
  return nodes.slice(0, limit);
}

/** ISO-UTC bucket key for a completed node under the given grouping mode. */
function completedBucketKey(mode: GroupByMode, node: NodeRuntimeState): string {
  const iso = new Date(node.completedAt as number).toISOString();
  if (mode === "hour") return `${iso.slice(0, 13)}:00:00.000Z`;
  if (mode === "day") return iso.slice(0, 10);
  return node.agent;
}

/**
 * Bucket COMPLETED nodes by `hour` / `day` / `agent` over their `completedAt`
 * timestamp, returning the bucket list with counts. Honesty contract:
 *
 *   - Only nodes with `status === Completed` **and** a `completedAt` timestamp
 *     are included — an uncompleted node (pending/ready/running/blocked, or any
 *     node with no completion timestamp) is excluded, never bucketed into an
 *     invented slot.
 *   - Buckets are sorted by key (ISO strings sort lexicographically in UTC; the
 *     `agent` mode sorts by agent id). When no completed node exists, an empty
 *     bucket list is returned — never a fabricated row.
 */
export function groupCompletedNodes(
  nodes: ReadonlyMap<string, NodeRuntimeState>,
  mode: GroupByMode,
): GroupBucket[] {
  const buckets = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.status !== NodeStatus.Completed) continue;
    if (node.completedAt === undefined) continue;
    const key = completedBucketKey(mode, node);
    const list = buckets.get(key) ?? [];
    list.push(node.nodeId);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, ids]) => ({ key, count: ids.length, nodes: ids }));
}

