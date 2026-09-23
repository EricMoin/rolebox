/**
 * `graph_status` query surface — the pure `status-queries.ts` half.
 *
 * Ported from the deleted `graph-status-filters.test.ts` and
 * `graph-status-views.test.ts` after the legacy construction toolset
 * (`graph_create` / `graph_add_node` / `graph_add_edge`) was deleted with the
 * legacy runtime. Those files built their fixtures through that toolset; this
 * one builds the SAME real `EngineState` fixtures through the surviving
 * declared-state primitives (`createEngineState` + `registerNode`), so the
 * filter / view assertions below stay exercised instead of disappearing with
 * the harness. The tool-level `graph_status` rendering cases that drove the
 * legacy in-memory registry are not ported (that ingress is gone); the
 * surviving tool face is pinned by `graph-tools-registration.test.ts`.
 *
 * Honesty rule (unchanged): every case asserts REAL recorded node data or an
 * explicit honest-empty result — never a fabricated row.
 */

import { describe, it, expect } from "bun:test";

import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import { createEngineState, registerNode } from "../../src/graph/persistence/declared-state.ts";
import {
  filterByAgent,
  filterByDateWindow,
  filterByQuery,
  filterByStatus,
  filterNodes,
  groupCompletedNodes,
  limitNodes,
  type StatusQuery,
} from "../../src/graph/tools/status-queries.ts";

// ── fixed epoch timestamps for deterministic date-window assertions ─────────
const T0 = 1_700_000_000_000; // +0s
const T1 = 1_700_000_100_000; // +100s
const T2 = 1_700_000_200_000; // +200s
const iso = (ms: number) => new Date(ms).toISOString();

function emptyDeclaration(name: string): GraphDeclaration {
  return { version: 2, name, nodes: [], edges: [] };
}

function setNode(
  state: EngineState,
  id: string,
  patch: Partial<NodeRuntimeState>,
): void {
  const node = state.nodes.get(id);
  if (node === undefined) throw new Error(`fixture: no node ${id}`);
  Object.assign(node, patch);
}

/** Build a 4-node graph with distinct agent / status / timestamps. */
function buildFixture(): EngineState {
  const state = createEngineState(emptyDeclaration("filter-fixture"), "filter-fixture");
  registerNode(state, { id: "alpha", agent: "agent-a", prompt: "Plan the release." });
  registerNode(state, { id: "beta", agent: "agent-b", prompt: "Write the tests." });
  registerNode(state, { id: "gamma", agent: "agent-a", prompt: "Review the diff." });
  registerNode(state, { id: "delta", agent: "agent-c", prompt: "Ship it." });
  // alpha=ready(T0), beta=completed(T0→T1), gamma=pending(T1),
  // delta=blocked(T0, completedAt T2).
  setNode(state, "alpha", { status: NodeStatus.Ready, startedAt: T0 });
  setNode(state, "beta", { status: NodeStatus.Completed, startedAt: T0, completedAt: T1 });
  setNode(state, "gamma", { status: NodeStatus.Pending, startedAt: T1 });
  setNode(state, "delta", { status: NodeStatus.Blocked, startedAt: T0, completedAt: T2 });
  return state;
}

/** Build the agent/hour/day bucketing fixture used by the view helpers. */
function buildCompletionFixture(): EngineState {
  const state = createEngineState(emptyDeclaration("group-fixture"), "group-fixture");
  registerNode(state, { id: "n1", agent: "agent-1", prompt: "p1" });
  registerNode(state, { id: "n2", agent: "agent-2", prompt: "p2" });
  registerNode(state, { id: "n3", agent: "agent-1", prompt: "p3" });
  registerNode(state, { id: "n4", agent: "agent-1", prompt: "p4" });
  setNode(state, "n1", {
    status: NodeStatus.Completed,
    completedAt: Date.parse("2026-07-25T10:05:00.000Z"),
  });
  setNode(state, "n2", {
    status: NodeStatus.Completed,
    completedAt: Date.parse("2026-07-25T10:30:00.000Z"),
  });
  setNode(state, "n3", {
    status: NodeStatus.Completed,
    completedAt: Date.parse("2026-07-25T11:10:00.000Z"),
  });
  return state;
}

function ids(nodes: NodeRuntimeState[]): string[] {
  return nodes.map((n) => n.nodeId);
}

describe("status-queries pure filters", () => {
  it("filterByQuery matches nodeId / prompt / agent case-insensitively", () => {
    const state = buildFixture();
    expect(ids(filterByQuery(state.nodes, "alp"))).toEqual(["alpha"]);
    expect(ids(filterByQuery(state.nodes, "TESTS"))).toEqual(["beta"]);
    expect(ids(filterByQuery(state.nodes, "agent-a"))).toEqual(["alpha", "gamma"]);
  });

  it("filterByQuery with a blank/whitespace query matches nothing (honest empty)", () => {
    const state = buildFixture();
    expect(ids(filterByQuery(state.nodes, "   "))).toEqual([]);
  });

  it("filterByStatus is an exact NodeStatus match", () => {
    const state = buildFixture();
    expect(ids(filterByStatus(state.nodes, NodeStatus.Completed))).toEqual(["beta"]);
    expect(ids(filterByStatus(state.nodes, NodeStatus.Pending))).toEqual(["gamma"]);
    expect(ids(filterByStatus(state.nodes, NodeStatus.Timeout))).toEqual([]);
  });

  it("filterByAgent is an exact agent match", () => {
    const state = buildFixture();
    expect(ids(filterByAgent(state.nodes, "agent-a"))).toEqual(["alpha", "gamma"]);
    expect(ids(filterByAgent(state.nodes, "agent-c"))).toEqual(["delta"]);
  });

  it("filterByDateWindow honors from_date on startedAt", () => {
    const state = buildFixture();
    expect(ids(filterByDateWindow(state.nodes, iso(T1)))).toEqual(["gamma"]);
    expect(ids(filterByDateWindow(state.nodes, iso(T0)))).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("filterByDateWindow honors to_date on completedAt (no completedAt => no match)", () => {
    const state = buildFixture();
    expect(ids(filterByDateWindow(state.nodes, undefined, iso(T1)))).toEqual(["beta"]);
    expect(ids(filterByDateWindow(state.nodes, undefined, iso(T2)))).toEqual([
      "beta",
      "delta",
    ]);
  });

  it("filterByDateWindow requires BOTH bounds when both given", () => {
    const state = buildFixture();
    expect(ids(filterByDateWindow(state.nodes, iso(T0), iso(T1)))).toEqual(["beta"]);
  });

  it("filterByDateWindow throws a descriptive error on an invalid ISO string", () => {
    const state = buildFixture();
    expect(() => filterByDateWindow(state.nodes, "not-a-date")).toThrow(/invalid date/);
  });

  it("filterNodes AND-combines filters and never fabricates", () => {
    const state = buildFixture();
    const q: StatusQuery = { agent: "agent-a", status: NodeStatus.Ready };
    expect(ids(filterNodes(state.nodes, q))).toEqual(["alpha"]);
    expect(
      ids(filterNodes(state.nodes, { agent: "agent-c", status: NodeStatus.Completed })),
    ).toEqual([]);
    expect(filterNodes(state.nodes, {})).toHaveLength(4);
  });
});

describe("status-queries view helpers", () => {
  it("limitNodes caps rows and is a no-op (unbounded) when limit is unset", () => {
    const state = buildFixture();
    const all = [...state.nodes.values()];
    expect(limitNodes(all, 2)).toEqual([all[0], all[1]]);
    expect(limitNodes(all, undefined)).toEqual(all);
    expect(limitNodes(all, 0)).toEqual(all);
    expect(limitNodes(all, -3)).toEqual(all);
  });

  it("groupCompletedNodes buckets by agent (uncompleted excluded)", () => {
    const state = buildCompletionFixture();
    const buckets = groupCompletedNodes(state.nodes, "agent");
    expect(buckets).toEqual([
      { key: "agent-1", count: 2, nodes: ["n1", "n3"] },
      { key: "agent-2", count: 1, nodes: ["n2"] },
    ]);
    expect(buckets.flatMap((b) => b.nodes)).not.toContain("n4");
  });

  it("groupCompletedNodes buckets by hour over completedAt", () => {
    const state = buildCompletionFixture();
    expect(groupCompletedNodes(state.nodes, "hour")).toEqual([
      { key: "2026-07-25T10:00:00.000Z", count: 2, nodes: ["n1", "n2"] },
      { key: "2026-07-25T11:00:00.000Z", count: 1, nodes: ["n3"] },
    ]);
  });

  it("groupCompletedNodes buckets by day over completedAt", () => {
    const state = buildCompletionFixture();
    expect(groupCompletedNodes(state.nodes, "day")).toEqual([
      { key: "2026-07-25", count: 3, nodes: ["n1", "n2", "n3"] },
    ]);
  });

  it("groupCompletedNodes returns an empty list (never fabricated) with no completions", () => {
    const state = createEngineState(emptyDeclaration("no-completions"), "no-completions");
    registerNode(state, { id: "a", agent: "agent-a", prompt: "p" });
    expect(groupCompletedNodes(state.nodes, "agent")).toEqual([]);
  });

  it("groupCompletedNodes excludes completed-status nodes that lack a completedAt", () => {
    const state = createEngineState(emptyDeclaration("no-ts"), "no-ts");
    registerNode(state, { id: "x", agent: "agent-x", prompt: "p" });
    setNode(state, "x", { status: NodeStatus.Completed }); // no completedAt
    expect(groupCompletedNodes(state.nodes, "agent")).toEqual([]);
  });
});
