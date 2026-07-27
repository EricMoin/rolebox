/**
 * Graph Execution Engine v2 — `graph_status` view flags (genuine data).
 *
 * Phase 4, Subtask 3. Exercises the three view flags added on top of subtask 2's
 * filter/query surface:
 *
 *   - `limit`    — caps the number of node rows emitted in summary and json.
 *   - `group_by` — buckets COMPLETED nodes over their `completedAt` by hour /
 *                  day / agent, returning the bucket list with counts. Uncompleted
 *                  nodes (pending/ready/running/blocked, or no `completedAt`) are
 *                  excluded honestly — never bucketed into an invented slot.
 *   - `depth`    — prunes the tree render at N levels (0 = roots only). The
 *                  DEFAULT is full depth.
 *
 * All assertions use REAL node data injected into the live engine state (the
 * same honest-data pattern as graph-status-filters.test.ts) — no fabricated
 * rows. A dedicated BACKWARD-COMPAT guard asserts that the existing
 * tree/summary/json output is BYTE-IDENTICAL when the new flags are unset.
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGraphToolSet,
  GraphToolSet,
} from "../../src/graph/tools/graph-tools";
import {
  limitNodes,
  groupCompletedNodes,
  type GroupByMode,
} from "../../src/graph/tools/status-queries";
import { NodeStatus } from "../../src/constants";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2";
import type { GraphStatusArgs } from "../../src/graph/tools/graph-tools";
import { EnginePersistence } from "../../src/graph/engine/engine-persistence";

// ── fixed timestamps across distinct hours / days (deterministic buckets) ────
const H10 = new Date("2026-07-25T10:15:30.000Z").getTime();
const H11 = new Date("2026-07-25T11:05:10.000Z").getTime();
const H12 = new Date("2026-07-25T12:45:00.000Z").getTime();

interface Fixture {
  ts: GraphToolSet;
  graph_id: string;
  state: EngineState;
}

/**
 * A 4-node graph:
 *   n1 agent-1 completed @ H10
 *   n2 agent-2 completed @ H10
 *   n3 agent-1 completed @ H11
 *   n4 agent-3 pending  (no completedAt — must be excluded from grouping)
 * Edges form a chain n1 -> n2 -> n3 -> n4 (real topology for tree depth tests).
 */
function buildFixture(): Fixture {
  const ts = createGraphToolSet();
  const { graph_id } = ts.graph_create({ name: "views-fixture" });
  ts.graph_add_node({ graph_id, id: "n1", agent: "agent-1", prompt: "one" });
  ts.graph_add_node({ graph_id, id: "n2", agent: "agent-2", prompt: "two" });
  ts.graph_add_node({ graph_id, id: "n3", agent: "agent-1", prompt: "three" });
  ts.graph_add_node({ graph_id, id: "n4", agent: "agent-3", prompt: "four" });
  ts.graph_add_edge({ graph_id, from: "n1", to: "n2", type: "always" });
  ts.graph_add_edge({ graph_id, from: "n2", to: "n3", type: "always" });
  ts.graph_add_edge({ graph_id, from: "n3", to: "n4", type: "always" });

  const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
  const nodes = live.state.nodes;
  setNode(nodes, "n1", { status: NodeStatus.Completed, completedAt: H10 });
  setNode(nodes, "n2", { status: NodeStatus.Completed, completedAt: H10 });
  setNode(nodes, "n3", { status: NodeStatus.Completed, completedAt: H11 });
  // n4 stays pending with no completedAt.
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

// ── pure module unit tests ──────────────────────────────────────────────────

describe("status-queries view helpers", () => {
  it("limitNodes caps rows and is a no-op (unbounded) when limit is unset", () => {
    const { state } = buildFixture();
    const all = [...state.nodes.values()];
    expect(limitNodes(all, 2)).toEqual([all[0], all[1]]);
    // Default: unset / <= 0 leaves the list untouched and in order.
    expect(limitNodes(all, undefined)).toEqual(all);
    expect(limitNodes(all, 0)).toEqual(all);
    expect(limitNodes(all, -3)).toEqual(all);
  });

  it("groupCompletedNodes buckets by agent (uncompleted excluded)", () => {
    const { state } = buildFixture();
    const buckets = groupCompletedNodes(state.nodes, "agent");
    expect(buckets).toEqual([
      { key: "agent-1", count: 2, nodes: ["n1", "n3"] },
      { key: "agent-2", count: 1, nodes: ["n2"] },
    ]);
    // n4 (pending, no completedAt) is absent — no invented bucket.
    expect(buckets.flatMap((b) => b.nodes)).not.toContain("n4");
  });

  it("groupCompletedNodes buckets by hour over completedAt", () => {
    const { state } = buildFixture();
    const buckets = groupCompletedNodes(state.nodes, "hour");
    expect(buckets).toEqual([
      { key: "2026-07-25T10:00:00.000Z", count: 2, nodes: ["n1", "n2"] },
      { key: "2026-07-25T11:00:00.000Z", count: 1, nodes: ["n3"] },
    ]);
  });

  it("groupCompletedNodes buckets by day over completedAt", () => {
    const { state } = buildFixture();
    const buckets = groupCompletedNodes(state.nodes, "day");
    expect(buckets).toEqual([
      { key: "2026-07-25", count: 3, nodes: ["n1", "n2", "n3"] },
    ]);
  });

  it("groupCompletedNodes returns an empty list (never fabricated) with no completions", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "no-completions" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    const state = ts["getEntry"](graph_id).runtime.status();
    const buckets = groupCompletedNodes(state.nodes, "agent");
    expect(buckets).toEqual([]);
  });

  it("groupCompletedNodes excludes completed-status nodes that lack a completedAt", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "no-ts" });
    ts.graph_add_node({ graph_id, id: "x", agent: "agent-x", prompt: "p" });
    const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
    setNode(live.state.nodes, "x", { status: NodeStatus.Completed }); // no completedAt
    expect(groupCompletedNodes(live.state.nodes, "agent")).toEqual([]);
  });
});

// ── limit through graph_status (json + summary) ─────────────────────────────

describe("graph_status limit view", () => {
  it("limit caps the json node array to the first N rows", () => {
    const { ts, graph_id } = buildFixture();
    const out = ts.graph_status({ graph_id, format: "json", limit: 2 });
    const parsed = JSON.parse(out);
    expect(parsed.nodes.map((n: { node_id: string }) => n.node_id)).toEqual(["n1", "n2"]);
  });

  it("limit caps the summary to the first N node rows", () => {
    const { ts, graph_id } = buildFixture();
    const out = ts.graph_status({ graph_id, limit: 2 });
    // All four node ids — but only the first two appear as rows.
    expect(out).toContain("n1");
    expect(out).toContain("n2");
    expect(out).not.toContain("n3");
    expect(out).not.toContain("n4");
  });

  it("limit unset leaves the full set (no cap)", () => {
    const { ts, graph_id } = buildFixture();
    const parsed = JSON.parse(ts.graph_status({ graph_id, format: "json" }));
    expect(parsed.nodes).toHaveLength(4);
  });
});

// ── group_by through graph_status (json + summary) ──────────────────────────

describe("graph_status group_by view", () => {
  function buckets(ts: GraphToolSet, graph_id: string, group_by: GroupByMode) {
    const out = ts.graph_status({ graph_id, format: "json", group_by });
    const parsed = JSON.parse(out);
    return parsed.buckets as Array<{ key: string; count: number; nodes: string[] }>;
  }

  it("group_by=agent groups completed nodes by agent in json", () => {
    const { ts, graph_id } = buildFixture();
    expect(buckets(ts, graph_id, "agent")).toEqual([
      { key: "agent-1", count: 2, nodes: ["n1", "n3"] },
      { key: "agent-2", count: 1, nodes: ["n2"] },
    ]);
  });

  it("group_by=hour buckets completed nodes by hour in json", () => {
    const { ts, graph_id } = buildFixture();
    const b = buckets(ts, graph_id, "hour");
    expect(b[0]).toEqual({ key: "2026-07-25T10:00:00.000Z", count: 2, nodes: ["n1", "n2"] });
    expect(b[1]).toEqual({ key: "2026-07-25T11:00:00.000Z", count: 1, nodes: ["n3"] });
  });

  it("group_by=agent renders human-readable buckets in summary format", () => {
    const { ts, graph_id } = buildFixture();
    const out = ts.graph_status({ graph_id, group_by: "agent" });
    expect(out).toMatch(/grouped by agent/);
    expect(out).toMatch(/agent-1: 2 node\(s\)/);
    expect(out).toMatch(/agent-2: 1 node\(s\)/);
    // n4 (pending) is never rendered as a bucket member.
    expect(out).not.toContain("n4");
  });

  it("group_by reports an honest empty result when nothing completed", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "group-empty" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    const out = ts.graph_status({ graph_id, format: "json", group_by: "agent" });
    expect(JSON.parse(out).buckets).toEqual([]);
  });
});

// ── depth through graph_status (tree) ───────────────────────────────────────

describe("graph_status depth view", () => {
  it("depth prunes the tree at N levels (chain n1->n2->n3->n4)", () => {
    const { ts, graph_id } = buildFixture();
    // depth=1: render root (depth 0) and its direct child (depth 1) only.
    const pruned = ts.graph_status({ graph_id, format: "tree", depth: 1 });
    expect(pruned).toContain("n1");
    expect(pruned).toContain("n2");
    expect(pruned).not.toContain("n3");
    expect(pruned).not.toContain("n4");

    // depth=0: roots only.
    const rootsOnly = ts.graph_status({ graph_id, format: "tree", depth: 0 });
    expect(rootsOnly).toContain("n1");
    expect(rootsOnly).not.toContain("n2");
  });

  it("depth unset renders the FULL tree (all four levels)", () => {
    const { ts, graph_id } = buildFixture();
    const full = ts.graph_status({ graph_id, format: "tree" });
    expect(full).toContain("n1");
    expect(full).toContain("n2");
    expect(full).toContain("n3");
    expect(full).toContain("n4");
  });
});

// ── BACKWARD COMPAT: byte-identical output when the new flags are unset ─────

describe("graph_status backward-compat (new flags unset = byte-identical)", () => {
  it("tree is byte-identical when depth is unset vs explicitly undefined", () => {
    const { ts, graph_id } = buildFixture();
    const plain = ts.graph_status({ graph_id, format: "tree" });
    const explicit = ts.graph_status({ graph_id, format: "tree", depth: undefined });
    expect(explicit).toBe(plain);
    // And the unset default is genuinely the FULL tree (a depth cap would differ).
    expect(plain).toContain("n4");
  });

  it("json is byte-identical when limit / group_by are unset vs undefined", () => {
    const { ts, graph_id } = buildFixture();
    const plain = ts.graph_status({ graph_id, format: "json" });
    const explicit = ts.graph_status({
      graph_id,
      format: "json",
      limit: undefined,
      group_by: undefined,
    });
    expect(explicit).toBe(plain);
    expect(JSON.parse(plain).nodes).toHaveLength(4); // full, not capped/grouped
  });

  it("summary is byte-identical when limit is unset vs undefined", () => {
    const { ts, graph_id } = buildFixture();
    const plain = ts.graph_status({ graph_id });
    const explicit = ts.graph_status({ graph_id, limit: undefined });
    expect(explicit).toBe(plain);
    expect(plain).toContain("n4"); // all four rows present
  });

  it("new flags never alter the filter surface (group_by filters compose)", () => {
    const { ts, graph_id } = buildFixture();
    // group_by + status filter: only completed nodes of the matching status are
    // grouped — the filter still applies before the view.
    const out = ts.graph_status({
      graph_id,
      format: "json",
      group_by: "agent",
      agent: "agent-1",
    });
    const parsed = JSON.parse(out);
    expect(parsed.buckets).toEqual([
      { key: "agent-1", count: 2, nodes: ["n1", "n3"] },
    ]);
  });
});

// ── export_path: mode-dependent export ─────────────────────────────────────

/**
 * A fixture with a completed node whose materialized result lives in a real
 * sidecar file (the genuine data source for the node-result export mode).
 */
function buildResultFixture(): { ts: GraphToolSet; graph_id: string; sidecar: string } {
  const dir = mkdtempSync(join(tmpdir(), "graph-status-export-"));
  const sidecar = join(dir, "n1-result.txt");
  writeFileSync(sidecar, "materialized result for n1\nsecond line", "utf8");

  const ts = createGraphToolSet();
  const { graph_id } = ts.graph_create({ name: "export-fixture" });
  ts.graph_add_node({ graph_id, id: "n1", agent: "agent-1", prompt: "one" });
  ts.graph_add_node({ graph_id, id: "n2", agent: "agent-2", prompt: "two" });
  ts.graph_add_edge({ graph_id, from: "n1", to: "n2", type: "always" });

  const live = ts["getEntry"](graph_id).runtime as unknown as { state: EngineState };
  const n1 = live.state.nodes.get("n1")!;
  n1.status = NodeStatus.Completed;
  n1.result = {
    sidecarPath: sidecar,
    totalChars: readFileSync(sidecar, "utf8").length,
    hadFence: false,
    materializedAt: new Date().toISOString(),
  };
  return { ts, graph_id, sidecar };
}

/** Does any `.tmp` artifact linger beside `exportPath` after a write? */
function tmpArtifacts(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

describe("graph_status export_path modes", () => {
  it("node_id + export_path writes the node's materialized result text", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-export-node-"));
    const exportPath = join(dir, "n1-out.txt");
    try {
      const { ts, graph_id } = buildResultFixture();
      const confirmation = ts.graph_status({ graph_id, node_id: "n1", export_path: exportPath });
      expect(confirmation).toContain(`Exported node "n1" result`);
      expect(confirmation).toContain(exportPath);
      // The target file contains exactly the node's materialized result text.
      const written = readFileSync(exportPath, "utf8");
      expect(written).toBe("materialized result for n1\nsecond line");
      // Atomic write leaves no .tmp artifact.
      expect(tmpArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("node_id + export_path throws when the node has no materialized result", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-export-nonode-"));
    const exportPath = join(dir, "n2-out.txt");
    try {
      const { ts, graph_id } = buildResultFixture();
      // n2 never completed — no result to export.
      expect(() =>
        ts.graph_status({ graph_id, node_id: "n2", export_path: exportPath }),
      ).toThrow(/no materialized result/);
      expect(existsSync(exportPath)).toBe(false);
      expect(tmpArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("include_metrics + export_path writes a parseable metrics JSON snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-export-metrics-"));
    const exportPath = join(dir, "metrics.json");
    try {
      const { ts, graph_id } = buildResultFixture();
      const confirmation = ts.graph_status({
        graph_id,
        include_metrics: true,
        export_path: exportPath,
      });
      expect(confirmation).toContain("Exported graph metrics snapshot");
      // The file parses as a metrics JSON snapshot reusing summary + budget.
      const parsed = JSON.parse(readFileSync(exportPath, "utf8"));
      expect(parsed.graph_id).toBe(graph_id);
      expect(parsed.phase).toBe("idle");
      expect(typeof parsed.summary).toBe("string");
      expect(parsed.summary).toContain("completed=1");
      // node_counts mirrors the genuine per-status breakdown (n1 completed,
      // n2 downstream-pending).
      expect(parsed.node_counts.completed).toBe(1);
      expect(parsed.node_counts.pending).toBe(1);
      expect(Object.values(parsed.node_counts).reduce((a: number, b) => a + (b as number), 0)).toBe(2);
      // budget reuses budgetSummary data (graph + per-node entries).
      expect(parsed.budget.graph).toBeDefined();
      expect(parsed.budget.nodes).toHaveLength(2);
      // Atomic write leaves no .tmp artifact.
      expect(tmpArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("graph-only export_path still writes the declaration YAML (no regression)", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-export-yaml-"));
    const exportPath = join(dir, "decl.yaml");
    try {
      const { ts, graph_id } = buildFixture();
      const confirmation = ts.graph_status({ graph_id, export_path: exportPath });
      expect(confirmation).toContain("Exported graph declaration");
      const yaml = readFileSync(exportPath, "utf8");
      expect(yaml.trimStart().startsWith("graph:")).toBe(true);
      expect(yaml).toContain("n1"); // real node ids present in the declaration
      // Atomic write leaves no .tmp artifact.
      expect(tmpArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── cross-session scope (persisted / all) ───────────────────────────────────

/**
 * Build a real engine state (via a builder toolset) whose nodes carry the given
 * status / completedAt, ready to be persisted to disk by a separate
 * EnginePersistence. `name` doubles as the graph_id (matching graph_create).
 */
function buildPersistedState(
  name: string,
  nodes: Array<{
    id: string;
    agent: string;
    status: NodeStatus;
    completedAt?: number;
  }>,
  budget?: {
    sessionsSpawned: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
  },
): EngineState {
  const builder = createGraphToolSet();
  builder.graph_create({ name });
  for (const n of nodes) {
    builder.graph_add_node({ graph_id: name, id: n.id, agent: n.agent, prompt: "p" });
  }
  const live = builder["getEntry"](name).runtime as unknown as { state: EngineState };
  for (const n of nodes) {
    const node = live.state.nodes.get(n.id)!;
    node.status = n.status;
    node.startedAt = H10;
    if (n.completedAt !== undefined) node.completedAt = n.completedAt;
  }
  if (budget) live.state.budget = { ...budget };
  return live.state;
}

interface PersistedFixture {
  dir: string;
  ts: GraphToolSet;
}

/**
 * A temp state store with two persisted graphs ("persisted-graph",
 * "persisted-graph2" — written to disk as if by another session) plus one live
 * in-registry graph ("session-graph" that was never persisted).
 */
function buildPersistedFixture(): PersistedFixture {
  const dir = mkdtempSync(join(tmpdir(), "graph-status-persisted-"));
  const store = new EnginePersistence(dir);
  store.save(
    buildPersistedState(
      "persisted-graph",
      [
        { id: "p1", agent: "pagent", status: NodeStatus.Completed, completedAt: H10 },
        { id: "p2", agent: "pagent", status: NodeStatus.Completed, completedAt: H11 },
      ],
      { sessionsSpawned: 2, totalInputTokens: 10, totalOutputTokens: 5, totalCost: 0.3 },
    ),
  );
  store.save(
    buildPersistedState(
      "persisted-graph2",
      [
        { id: "q1", agent: "qagent", status: NodeStatus.Completed, completedAt: H10 },
      ],
      { sessionsSpawned: 1, totalInputTokens: 4, totalOutputTokens: 2, totalCost: 0.1 },
    ),
  );
  const ts = createGraphToolSet({ stateDir: dir });
  ts.graph_create({ name: "session-graph" });
  ts.graph_add_node({ graph_id: "session-graph", id: "s1", agent: "sagent", prompt: "p" });
  return { dir, ts };
}

describe("graph_status cross-session scope (persisted / all)", () => {
  it("no-target list shows persisted graphs (scope=persisted), excluding the live session graph", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ scope: "persisted" });
      expect(out).toMatch(/^Persisted graphs \(2\):/);
      expect(out).toContain("persisted-graph");
      expect(out).toContain("persisted-graph2");
      // The live registry graph was never persisted — not shown in persisted scope.
      expect(out).not.toContain("session-graph");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-target list merges persisted + registry (scope=all)", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ scope: "all" });
      expect(out).toMatch(/^Graphs \(3\):/);
      expect(out).toContain("persisted-graph");
      expect(out).toContain("persisted-graph2");
      expect(out).toContain("session-graph");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session scope (default) does NOT read persisted graphs — byte-identical legacy list", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({});
      expect(out).toMatch(/^Graphs \(1\):/);
      expect(out).toContain("session-graph");
      expect(out).not.toContain("persisted-graph");
      expect(out).not.toContain("persisted-graph2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("group_by buckets completed nodes across sessions (scope=all)", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ scope: "all", format: "json", group_by: "agent" });
      const parsed = JSON.parse(out);
      const buckets = parsed.buckets as Array<{
        key: string;
        count: number;
        nodes: Array<{ graph_id: string; node_id: string }>;
      }>;
      // pagent: p1 + p2 across one persisted graph; qagent: q1; s1 (session, pending)
      // is excluded honestly (never completed).
      const pagent = buckets.find((b) => b.key === "pagent")!;
      expect(pagent.count).toBe(2);
      expect(pagent.nodes.map((n) => n.node_id).sort()).toEqual(["p1", "p2"]);
      expect(pagent.nodes.every((n) => n.graph_id === "persisted-graph")).toBe(true);
      expect(buckets.find((b) => b.key === "qagent")!.count).toBe(1);
      // The pending session node is never bucketed into an invented slot.
      expect(buckets.some((b) => b.nodes.some((n) => n.node_id === "s1"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("include_budget aggregates persisted graphs across sessions (scope=persisted)", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ scope: "persisted", format: "json", include_budget: true });
      const parsed = JSON.parse(out);
      expect(parsed.budget).toEqual({
        sessionsSpawned: 3,
        totalInputTokens: 14,
        totalOutputTokens: 7,
        totalCost: 0.4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cross-session aggregate renders the summed budget in summary text too", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ scope: "persisted", include_budget: true });
      expect(out).toMatch(/Budget \(2 graphs\)/);
      expect(out).toContain("tokens: 14/7");
      expect(out).toContain("cost: 0.4000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scope=persisted with an empty store yields an explicit honest-empty note, never rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-status-persisted-empty-"));
    try {
      const ts = createGraphToolSet({ stateDir: dir });
      const list = ts.graph_status({ scope: "persisted" });
      expect(list).toMatch(/No persisted graphs found/);
      expect(list).toContain(".rolebox/state");
      // A grouped / filtered view on the empty store is honest-empty too.
      const grouped = ts.graph_status({ scope: "persisted", format: "json", group_by: "agent" });
      expect(grouped).toMatch(/No persisted graphs found/);
      const budgeted = ts.graph_status({ scope: "persisted", include_budget: true });
      expect(budgeted).toMatch(/No persisted graphs found/);
      expect(list).not.toMatch(/p1|q1|pagent/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a targeted persisted graph renders its own summary (scope=persisted)", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      const out = ts.graph_status({ graph_id: "persisted-graph", scope: "persisted" });
      expect(out).toMatch(/Graph "persisted-graph"/);
      expect(out).toContain("p1");
      expect(out).toContain("p2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scoping a query to a missing persisted graph is an honest not-found error", () => {
    const { dir, ts } = buildPersistedFixture();
    try {
      expect(() =>
        ts.graph_status({ graph_id: "never-persisted", scope: "persisted" }),
      ).toThrow(/not found in persisted scope/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


