/**
 * Graph Execution Engine v2 — `graph_status` filter/query tests (genuine data).
 *
 * Phase 4, Subtask 5 (filter + date-window). Builds a small real graph with
 * nodes of differing agent / status / timestamps and asserts that each filter
 * (query / status / agent / from_date / to_date) — wired through
 * `graph_status` → the pure `status-queries.ts` module — returns ONLY the
 * matching nodes, and that a no-match filter yields an honest EMPTY result
 * (never fabricated rows).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGraphToolSet,
  GraphToolSet,
} from "../../src/graph/tools/graph-tools";
import {
  filterNodes,
  filterByQuery,
  filterByStatus,
  filterByAgent,
  filterByDateWindow,
  type StatusQuery,
} from "../../src/graph/tools/status-queries";
import { NodeStatus } from "../../src/constants";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2";
import type { GraphStatusArgs } from "../../src/graph/tools/graph-tools";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence";

// ── fixed epoch timestamps for deterministic date-window assertions ─────────
const T0 = 1_700_000_000_000; // +0s
const T1 = 1_700_000_100_000; // +100s
const T2 = 1_700_000_200_000; // +200s
const iso = (ms: number) => new Date(ms).toISOString();

// ── fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  ts: GraphToolSet;
  graph_id: string;
  state: EngineState;
}

/** Build a 4-node graph with distinct agent / status / timestamps. */
function buildFixture(): Fixture {
  const ts = createGraphToolSet();
  const { graph_id } = ts.graph_create({ name: "filter-fixture" });
  ts.graph_add_node({ graph_id, id: "alpha", agent: "agent-a", prompt: "Plan the release." });
  ts.graph_add_node({ graph_id, id: "beta", agent: "agent-b", prompt: "Write the tests." });
  ts.graph_add_node({ graph_id, id: "gamma", agent: "agent-a", prompt: "Review the diff." });
  ts.graph_add_node({ graph_id, id: "delta", agent: "agent-c", prompt: "Ship it." });
  ts.graph_add_edge({ graph_id, from: "alpha", to: "beta", type: "always" });
  ts.graph_add_edge({ graph_id, from: "beta", to: "gamma", type: "always" });
  ts.graph_add_edge({ graph_id, from: "gamma", to: "delta", type: "always" });

  const live = ts["getEntry"](graph_id).runtime as unknown as {
    state: EngineState;
  };
  const nodes = live.state.nodes;
  // Node states: alpha=ready(started T0), beta=completed(started T0 done T1),
  // gamma=pending(started T1), delta=blocked(started T0 done T2).
  setNode(nodes, "alpha", { status: "ready", startedAt: T0 });
  setNode(nodes, "beta", { status: "completed", startedAt: T0, completedAt: T1 });
  setNode(nodes, "gamma", { status: "pending", startedAt: T1 });
  setNode(nodes, "delta", { status: "blocked", startedAt: T0, completedAt: T2 });
  return { ts, graph_id, state: live.state };
}

function setNode(
  map: Map<string, NodeRuntimeState>,
  id: string,
  patch: Partial<NodeRuntimeState>,
): void {
  const node = map.get(id)!;
  Object.assign(node, patch);
}

/** Query graph_status (json) with optional filters and return matching node ids. */
function statusNodeIds(
  ts: GraphToolSet,
  graph_id: string,
  filter: Partial<GraphStatusArgs>,
): string[] {
  const out = ts.graph_status({ graph_id, format: "json", ...filter });
  const parsed = JSON.parse(out);
  return parsed.nodes.map((n: { node_id: string }) => n.node_id);
}

// ── pure module unit tests ──────────────────────────────────────────────────

describe("status-queries pure filters", () => {
  function ids(nodes: NodeRuntimeState[]): string[] {
    return nodes.map((n) => n.nodeId);
  }

  it("filterByQuery matches nodeId / prompt / agent case-insensitively", () => {
    const { state } = buildFixture();
    expect(ids(filterByQuery(state.nodes, "alp"))).toEqual(["alpha"]);
    // prompt substring, case-insensitive
    expect(ids(filterByQuery(state.nodes, "TESTS"))).toEqual(["beta"]);
    // agent substring
    expect(ids(filterByQuery(state.nodes, "agent-a"))).toEqual(["alpha", "gamma"]);
  });

  it("filterByQuery with a blank/whitespace query matches nothing (honest empty)", () => {
    const { state } = buildFixture();
    expect(ids(filterByQuery(state.nodes, "   "))).toEqual([]);
  });

  it("filterByStatus is an exact NodeStatus match", () => {
    const { state } = buildFixture();
    expect(ids(filterByStatus(state.nodes, NodeStatus.Completed))).toEqual(["beta"]);
    expect(ids(filterByStatus(state.nodes, NodeStatus.Pending))).toEqual(["gamma"]);
    expect(ids(filterByStatus(state.nodes, NodeStatus.Timeout))).toEqual([]);
  });

  it("filterByAgent is an exact agent match", () => {
    const { state } = buildFixture();
    expect(ids(filterByAgent(state.nodes, "agent-a"))).toEqual(["alpha", "gamma"]);
    expect(ids(filterByAgent(state.nodes, "agent-c"))).toEqual(["delta"]);
  });

  it("filterByDateWindow honors from_date on startedAt", () => {
    const { state } = buildFixture();
    expect(ids(filterByDateWindow(state.nodes, iso(T1)))).toEqual(["gamma"]); // only gamma started at T1
    expect(ids(filterByDateWindow(state.nodes, iso(T0)))).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("filterByDateWindow honors to_date on completedAt (no completedAt => no match)", () => {
    const { state } = buildFixture();
    // Only beta completed <= T1; alpha/gamma never completed, delta completed at T2.
    expect(ids(filterByDateWindow(state.nodes, undefined, iso(T1)))).toEqual(["beta"]);
    expect(ids(filterByDateWindow(state.nodes, undefined, iso(T2)))).toEqual([
      "beta",
      "delta",
    ]);
  });

  it("filterByDateWindow requires BOTH bounds when both given", () => {
    const { state } = buildFixture();
    // beta: started T0, completed T1 — inside [T0, T1].
    expect(ids(filterByDateWindow(state.nodes, iso(T0), iso(T1)))).toEqual(["beta"]);
  });

  it("filterByDateWindow throws a descriptive error on an invalid ISO string", () => {
    const { state } = buildFixture();
    expect(() => filterByDateWindow(state.nodes, "not-a-date")).toThrow(/invalid date/);
  });

  it("filterNodes AND-combines filters and never fabricates", () => {
    const { state } = buildFixture();
    const q: StatusQuery = { agent: "agent-a", status: NodeStatus.Ready };
    expect(ids(filterNodes(state.nodes, q))).toEqual(["alpha"]);
    // A conjunction with no satisfying node => honest empty.
    expect(ids(filterNodes(state.nodes, { agent: "agent-c", status: NodeStatus.Completed }))).toEqual([]);
    // No filter fields => whole set.
    expect(ids(filterNodes(state.nodes, {}))).toHaveLength(4);
  });
});

// ── integration through graph_status (genuine data) ─────────────────────────

describe("graph_status filter integration", () => {
  it("query filters the json node list to matching nodes only", () => {
    const { ts, graph_id } = buildFixture();
    expect(statusNodeIds(ts, graph_id, { query: "alp" })).toEqual(["alpha"]);
    expect(statusNodeIds(ts, graph_id, { query: "agent-b" })).toEqual(["beta"]);
  });

  it("status filters to exact NodeStatus matches", () => {
    const { ts, graph_id } = buildFixture();
    expect(statusNodeIds(ts, graph_id, { status: "completed" })).toEqual(["beta"]);
    expect(statusNodeIds(ts, graph_id, { status: "blocked" })).toEqual(["delta"]);
  });

  it("agent filters to the exact agent's nodes", () => {
    const { ts, graph_id } = buildFixture();
    expect(statusNodeIds(ts, graph_id, { agent: "agent-a" })).toEqual(["alpha", "gamma"]);
  });

  it("from_date filters to nodes started at or after the bound", () => {
    const { ts, graph_id } = buildFixture();
    expect(statusNodeIds(ts, graph_id, { from_date: iso(T1) })).toEqual(["gamma"]);
  });

  it("to_date filters to completed nodes within the bound", () => {
    const { ts, graph_id } = buildFixture();
    expect(statusNodeIds(ts, graph_id, { to_date: iso(T1) })).toEqual(["beta"]);
  });

  it("combined status+agent returns only the intersection", () => {
    const { ts, graph_id } = buildFixture();
    expect(
      statusNodeIds(ts, graph_id, { status: "ready", agent: "agent-a" }),
    ).toEqual(["alpha"]);
    expect(
      statusNodeIds(ts, graph_id, { status: "completed", agent: "agent-a" }),
    ).toEqual([]);
  });

  it("a no-match filter yields an honest EMPTY result, never fabricated rows", () => {
    const { ts, graph_id } = buildFixture();
    // json: empty nodes array.
    expect(statusNodeIds(ts, graph_id, { status: "timeout" })).toEqual([]);
    // summary: header only, no node rows referencing any real id.
    const summary = ts.graph_status({ graph_id, status: "timeout" });
    expect(summary).toMatch(/Graph "filter-fixture"/);
    expect(summary).not.toContain("alpha");
    expect(summary).not.toContain("beta");
    expect(summary).not.toContain("gamma");
    expect(summary).not.toContain("delta");
    // tree: no node rendered.
    const tree = ts.graph_status({ graph_id, format: "tree", status: "timeout" });
    expect(tree).toMatch(/Graph "filter-fixture"/);
    expect(tree).not.toContain("alpha");
    expect(tree).not.toContain("delta");
  });

  it("an invalid from_date surfaces a descriptive error, not a fabricated set", () => {
    const { ts, graph_id } = buildFixture();
    expect(() => ts.graph_status({ graph_id, from_date: "garbage" })).toThrow(
      /invalid date/,
    );
  });
});

// ── cross-session filter scope (persisted / all) ────────────────────────────

/**
 * Build a real engine state (via a builder toolset) whose node carries the given
 * status / completedAt, ready to be persisted to disk by an EnginePersistence.
 * `name` doubles as the graph_id (matching graph_create).
 */
function buildXState(
  name: string,
  node: { id: string; agent: string; status: NodeStatus; completedAt?: number },
): EngineState {
  const builder = createGraphToolSet();
  builder.graph_create({ name });
  builder.graph_add_node({ graph_id: name, id: node.id, agent: node.agent, prompt: "p" });
  const live = builder["getEntry"](name).runtime as unknown as { state: EngineState };
  const n = live.state.nodes.get(node.id)!;
  n.status = node.status;
  n.startedAt = T0;
  if (node.completedAt !== undefined) n.completedAt = node.completedAt;
  return live.state;
}

describe("graph_status cross-session filter scope (persisted / all)", () => {
  it("query across sessions returns a persisted node from another session (scope=all)", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-query-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildXState("other-session", {
          id: "persisted-alpha",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T1,
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });
      ts.graph_create({ name: "current-session" });
      ts.graph_add_node({ graph_id: "current-session", id: "session-alpha", agent: "agent-y", prompt: "local" });

      // scope=all: the query finds the node persisted by another session.
      const out = ts.graph_status({ scope: "all", format: "json", query: "persisted-alpha" });
      expect(JSON.parse(out).nodes).toEqual([
        { graph_id: "other-session", node_id: "persisted-alpha", status: "completed", agent: "agent-x" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session scope (default) does not surface persisted nodes — the scope gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-gate-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildXState("other-session", {
          id: "persisted-alpha",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T1,
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });
      ts.graph_create({ name: "current-session" });
      ts.graph_add_node({ graph_id: "current-session", id: "session-alpha", agent: "agent-y", prompt: "local" });

      // Default session scope lists only the registry graph — the persisted node
      // is never surfaced, regardless of the (otherwise ignored) query arg.
      const out = ts.graph_status({ query: "persisted-alpha" });
      expect(out).toMatch(/^Graphs \(1\):/);
      expect(out).not.toContain("persisted-alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status filter matches persisted nodes across sessions (scope=all)", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-status-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildXState("other-session", {
          id: "persisted-alpha",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T1,
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });
      ts.graph_create({ name: "current-session" });
      ts.graph_add_node({ graph_id: "current-session", id: "session-beta", agent: "agent-y", prompt: "local" });

      const out = ts.graph_status({ scope: "all", format: "json", status: "completed" });
      const ids = (JSON.parse(out).nodes as Array<{ graph_id: string; node_id: string }>).map(
        (n) => n.node_id,
      );
      // The completed persisted node is included; the pending session node is not.
      expect(ids).toEqual(["persisted-alpha"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent filter matches persisted nodes in persisted scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-agent-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildXState("other-session", {
          id: "persisted-alpha",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T1,
        }),
      );
      store.save(
        buildXState("another-session", {
          id: "persisted-beta",
          agent: "agent-z",
          status: NodeStatus.Completed,
          completedAt: T2,
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });

      const out = ts.graph_status({ scope: "persisted", format: "json", agent: "agent-x" });
      expect(JSON.parse(out).nodes).toEqual([
        { graph_id: "other-session", node_id: "persisted-alpha", status: "completed", agent: "agent-x" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("to_date filters completed persisted nodes across sessions (scope=persisted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-date-"));
    try {
      const store = new EnginePersistence(dir);
      store.save(
        buildXState("session-a", {
          id: "cross-a",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T1,
        }),
      );
      store.save(
        buildXState("session-b", {
          id: "cross-b",
          agent: "agent-x",
          status: NodeStatus.Completed,
          completedAt: T2,
        }),
      );
      const ts = createGraphToolSet({ stateDir: dir });

      const out = ts.graph_status({ scope: "persisted", format: "json", to_date: iso(T1) });
      const ids = (JSON.parse(out).nodes as Array<{ node_id: string }>).map((n) => n.node_id);
      // cross-a completed <= T1; cross-b completed at T2 is honestly excluded.
      expect(ids).toEqual(["cross-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope=persisted with an empty store yields an explicit honest-empty note", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-xsession-empty-"));
    try {
      const ts = createGraphToolSet({ stateDir: dir });
      const out = ts.graph_status({ scope: "persisted", format: "json", query: "anything" });
      expect(out).toMatch(/No persisted graphs found/);
      expect(out).not.toMatch(/"nodes"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
