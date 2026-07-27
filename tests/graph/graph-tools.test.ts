/**
 * Graph Execution Engine v2 — Imperative `graph_*` Tool Logic Tests
 *
 * Phase 4, Subtask 5. Exercises the imperative construction round-trip, status
 * lifecycle reflection, and cancellation via {@link GraphToolSet}.
 *
 * The tool set is constructed WITHOUT a dispatch manager, so these tests cover
 * the construction / status / cancel surface (provision + status + cancel work
 * manager-free). Non dry-run execution requires a DispatchManager and is
 * asserted via its error path; dry-run validation is covered in full.
 */

import { describe, it, expect } from "bun:test";
import {
  createGraphToolSet,
  GraphToolSet,
} from "../../src/graph/tools/graph-tools";
import type { GraphStatusArgs } from "../../src/graph/tools/graph-tools";

// ── helpers ───────────────────────────────────────────────────────────────

/** Build a review-team-plus style topology via the imperative tools. */
function buildReviewTeamPlus(ts: GraphToolSet, graphId: string): void {
  // Root planner.
  ts.graph_add_node({
    graph_id: graphId,
    id: "planner",
    agent: "emperor--chancellor",
    prompt: "Design the implementation plan.",
  });

  // Worker with a per-node budget + timeout + retries.
  ts.graph_add_node({
    graph_id: graphId,
    id: "implementer",
    agent: "emperor--jinyiwei--backend",
    prompt: "Implement the feature.",
    budget: { max_sessions: 3 },
    timeout_ms: 300000,
    max_retries: 2,
  });

  // Reviewer at a fan-in point.
  ts.graph_add_node({
    graph_id: graphId,
    id: "reviewer",
    agent: "emperor--validator",
    prompt: "Review the implementation. Signal answer or revise_needed.",
    join: { strategy: "all" },
  });

  // Human approval gate.
  ts.graph_add_node({
    graph_id: graphId,
    id: "approval-gate",
    agent: "emperor--jinyiwei",
    prompt: "Approve the final output.",
    needs_approval: true,
    join: { strategy: "all" },
  });

  // Edges.
  ts.graph_add_edge({ graph_id: graphId, from: "planner", to: "implementer", type: "always" });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "implementer",
    to: "reviewer",
    type: "on_signal",
    signal_filter: ["answer"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "implementer",
    type: "on_signal",
    signal_filter: ["revise_needed"],
  });
  ts.graph_add_edge({
    graph_id: graphId,
    from: "reviewer",
    to: "approval-gate",
    type: "on_signal",
    signal_filter: ["answer"],
  });

  // Loop group bounding the revision cycle.
  ts.graph_add_loop({
    graph_id: graphId,
    id: "review-cycle",
    nodes: ["implementer", "reviewer"],
    max_traversals: 5,
  });
}

// ── graph_create ──────────────────────────────────────────────────────────

describe("graph_create", () => {
  it("opens a registry slot and returns a graph id", () => {
    const ts = createGraphToolSet();
    const r = ts.graph_create({ name: "wf-1" });
    expect(r.graph_id).toBe("wf-1");
    expect(r.name).toBe("wf-1");
    expect(r.created_at).toBeTruthy();
  });

  it("assigns a unique id when the name collides", () => {
    const ts = createGraphToolSet();
    ts.graph_create({ name: "wf-2" });
    const second = ts.graph_create({ name: "wf-2" });
    expect(second.graph_id).toBe("wf-2-2");
  });

  it("rejects an empty name", () => {
    const ts = createGraphToolSet();
    expect(() => ts.graph_create({ name: "  " })).toThrow(/name/);
  });
});

// ── construction round-trip ───────────────────────────────────────────────

describe("imperative construction round-trip", () => {
  it("builds a review-team-plus topology via the tools", () => {
    const ts = createGraphToolSet();
    const created = ts.graph_create({
      name: "review-team-plus",
      budget: { max_total_sessions: 20 },
    });
    const graphId = created.graph_id;

    buildReviewTeamPlus(ts, graphId);

    // Reflect the declaration through the provisioned engine state.
    const state = ts["getEntry"](graphId).runtime.status();
    expect(state.graphDeclaration.nodes.map((n) => n.id)).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "approval-gate",
    ]);
    expect(state.graphDeclaration.edges).toHaveLength(4);
    expect(state.graphDeclaration.loop_groups).toHaveLength(1);
    expect(state.graphDeclaration.loop_groups?.[0].nodes).toEqual([
      "implementer",
      "reviewer",
    ]);
    // Root provisions to ready; everything else pending.
    expect(state.nodes.get("planner")?.status).toBe("ready");
    expect(state.nodes.get("implementer")?.status).toBe("pending");
  });

  it("carries join, budget, timeout and retry into the declaration", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "carry" });
    ts.graph_add_node({
      graph_id,
      id: "a",
      agent: "agent-a",
      prompt: "p",
      join: { strategy: "quorum", quorum: 2 },
      budget: { max_sessions: 4, max_input_tokens: 1000 },
      timeout_ms: 60000,
      max_retries: 3,
    });
    const state = ts["getEntry"](graph_id).runtime.status();
    const cfg = state.graphDeclaration.nodes[0];
    expect(cfg.join).toEqual({ strategy: "quorum", quorum: 2 });
    expect(cfg.budget).toMatchObject({
      max_sessions: 4,
      max_input_tokens: 1000,
      timeout_ms: 60000,
      max_retries: 3,
    });
  });

  it("rejects duplicate node ids (atomic — no partial mutation)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dup" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    expect(() =>
      ts.graph_add_node({ graph_id, id: "a", agent: "agent-b", prompt: "p2" }),
    ).toThrow(/already exists/);
    expect(ts["getEntry"](graph_id).declaration.nodes).toHaveLength(1);
  });

  it("rejects an edge to an undeclared node", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "bad-edge" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    expect(() =>
      ts.graph_add_edge({ graph_id, from: "a", to: "ghost", type: "always" }),
    ).toThrow(/structural validation/);
  });

  it("rejects on_signal edges without a signal_filter", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "sig" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    expect(() =>
      ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "on_signal" }),
    ).toThrow(/signal_filter/);
  });

  it("stores all data_passthrough fields on the edge mapping", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dt" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    const r = ts.graph_add_edge({
      graph_id,
      from: "a",
      to: "b",
      type: "always",
      data_passthrough_include: ["result", "artifacts"],
      data_passthrough_exclude: ["internal"],
      data_passthrough_max_chars: 100,
    });
    const state = ts["getEntry"](graph_id).runtime.status();
    expect(state.graphDeclaration.edges[0].data_passthrough).toEqual({
      fields: ["result", "artifacts"],
      exclude: ["internal"],
      maxChars: 100,
    });
    // exclude / max_chars are now backed — the return carries no `ignored` field.
    expect(r).toEqual({
      edge_id: "a->b",
      from: "a",
      to: "b",
      type: "always",
    });
  });

  it("coerces a bare numeric edge retry to {max}", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "retry" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "always", retry: 3 });
    const state = ts["getEntry"](graph_id).runtime.status();
    expect(state.graphDeclaration.edges[0].retry).toEqual({ max: 3 });
  });

  it("rejects duplicate loop group ids", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dloop" });
    // Two-node cycle to satisfy structural cycle containment.
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "always" });
    ts.graph_add_edge({ graph_id, from: "b", to: "a", type: "always" });
    ts.graph_add_loop({ graph_id, id: "lg", nodes: ["a", "b"], max_traversals: 3 });
    expect(() =>
      ts.graph_add_loop({ graph_id, id: "lg", nodes: ["a", "b"], max_traversals: 3 }),
    ).toThrow(/already exists/);
  });
});

// ── graph_run (dry-run) ───────────────────────────────────────────────────

describe("graph_run", () => {
  it("validates structure in dry-run mode without executing", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dry" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.validation?.valid).toBe(true);
    expect(r.validation?.errors).toEqual([]);
    expect(r.phase).toBe("validating");
  });

  it("rejects an invalid graph in dry-run mode", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dry-bad" });
    // Construction is atomic, so an invalid graph cannot be built through the
    // tools. Inject one directly into the registry to exercise the dry-run
    // validation branch.
    const entry = ts["getEntry"](graph_id);
    const invalid = { ...entry.declaration };
    invalid.edges = [
      { from: "a", to: "missing", type: "always" },
    ];
    (ts["registry"] as Map<string, { declaration: typeof invalid; runtime: typeof entry["runtime"] }>).set(
      graph_id,
      { declaration: invalid, runtime: entry.runtime },
    );
    const r = await ts.graph_run({ graph_id, dry_run: true });
    expect(r.validation?.valid).toBe(false);
    expect(r.validation?.errors.length).toBeGreaterThan(0);
  });

  it("throws a descriptive error when executing without a manager", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "run-nomgr" });
    buildReviewTeamPlus(ts, graph_id);
    await expect(ts.graph_run({ graph_id })).rejects.toThrow(/no dispatch manager/);
  });
});

// ── graph_status ──────────────────────────────────────────────────────────

describe("graph_status", () => {
  function status(ts: GraphToolSet, graphId: string, args: Partial<GraphStatusArgs>) {
    return ts.graph_status({ graph_id: graphId, ...args });
  }

  it("lists graphs when no target is given", () => {
    const ts = createGraphToolSet();
    ts.graph_create({ name: "listme" });
    expect(ts.graph_status({})).toMatch(/listme/);
    expect(ts.graph_status({})).toMatch(/1\):/);
  });

  it("reflects node lifecycle after provision", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "life" });
    buildReviewTeamPlus(ts, graph_id);
    const out = status(ts, graph_id, {});
    expect(out).toMatch(/phase: idle/);
    expect(out).toMatch(/planner\s+ready/);
    expect(out).toMatch(/reviewer\s+pending/);
  });

  it("scopes to a single node", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "scoped" });
    buildReviewTeamPlus(ts, graph_id);
    const out = ts.graph_status({ node_id: "approval-gate" });
    expect(out).toMatch(/Node "approval-gate"/);
    expect(out).toMatch(/needs_approval: true/);
  });

  it("reports loop group state", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "loop" });
    buildReviewTeamPlus(ts, graph_id);
    const out = ts.graph_status({ loop_id: "review-cycle" });
    expect(out).toMatch(/Loop "review-cycle"/);
    expect(out).toMatch(/0\/5/);
    expect(out).toMatch(/implementer/);
  });

  it("renders a dependency tree and json formats", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "fmt" });
    buildReviewTeamPlus(ts, graph_id);
    const tree = status(ts, graph_id, { format: "tree" });
    expect(tree).toMatch(/planner/);
    const json = status(ts, graph_id, { format: "json" });
    const parsed = JSON.parse(json);
    expect(parsed.phase).toBe("idle");
    expect(parsed.nodes).toHaveLength(4);
  });

  it("paginates output with max_chars / tail", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "page" });
    buildReviewTeamPlus(ts, graph_id);
    const short = status(ts, graph_id, { max_chars: 10 });
    expect(short.length).toBeLessThanOrEqual(10);
    const tail = status(ts, graph_id, { max_chars: 10, tail: true });
    expect(tail.length).toBeLessThanOrEqual(10);
  });
});

// ── graph_add_loop — loop mode (subtask 6) ───────────────────────────────

describe("graph_add_loop — loop mode", () => {
  /** Open a graph with two member nodes forming a directed cycle. */
  function openPair(name: string): { ts: GraphToolSet; graph_id: string } {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name });
    ts.graph_add_node({ graph_id, id: "a", agent: "x", prompt: "a" });
    ts.graph_add_node({ graph_id, id: "b", agent: "y", prompt: "b" });
    // a → b → a directed cycle so the loop-group structural check passes.
    ts.graph_add_edge({ graph_id, from: "a", to: "b", type: "always" });
    ts.graph_add_edge({
      graph_id,
      from: "b",
      to: "a",
      type: "on_signal",
      signal_filter: ["revise_needed"],
    });
    return { ts, graph_id };
  }

  it("accepts mode='inherit' and records it in the loop render, json, and summary", () => {
    const { ts, graph_id } = openPair("inherit-mode");
    ts.graph_add_loop({
      graph_id,
      id: "lg",
      nodes: ["a", "b"],
      max_traversals: 3,
      mode: "inherit",
    });

    // Loop render (declaration-backed) surfaces the recorded mode + the
    // same-engine-state note.
    const render = ts.graph_status({ loop_id: "lg" });
    expect(render).toMatch(/Loop "lg"/);
    expect(render).toMatch(/mode: inherit/);
    expect(render).toMatch(/same engine state/);

    // json with include_loops surfaces mode on the loop entry.
    const json = JSON.parse(
      ts.graph_status({ graph_id, format: "json", include_loops: true }),
    );
    expect(json.loops).toHaveLength(1);
    expect(json.loops[0]).toMatchObject({ loop_id: "lg", mode: "inherit" });

    // summary (include_loops) annotates the loop line with mode=inherit.
    expect(ts.graph_status({ graph_id, include_loops: true })).toMatch(/mode=inherit/);
  });

  it("rejects mode='fresh' with a documented-unsupported error naming the separate-graph alternative", () => {
    const { ts, graph_id } = openPair("fresh-mode");
    expect(() =>
      ts.graph_add_loop({
        graph_id,
        id: "lg",
        nodes: ["a", "b"],
        max_traversals: 3,
        mode: "fresh",
      }),
    ).toThrow(/not supported/);
    // The error names the alternative path, never a silent no-op.
    expect(() =>
      ts.graph_add_loop({
        graph_id,
        id: "lg",
        nodes: ["a", "b"],
        max_traversals: 3,
        mode: "fresh",
      }),
    ).toThrow(/SEPARATE GRAPH/);
    // No loop was recorded (no partial state left behind).
    expect(() => ts.graph_status({ loop_id: "lg" })).toThrow(/not found in any graph/);
  });

  it("keeps the default (no mode) output byte-identical — mode never surfaced", () => {
    const { ts, graph_id } = openPair("default-mode");
    ts.graph_add_loop({ graph_id, id: "lg", nodes: ["a", "b"], max_traversals: 3 });

    const render = ts.graph_status({ loop_id: "lg" });
    expect(render).toMatch(/Loop "lg"/);
    expect(render).toMatch(/0\/3/);
    expect(render).not.toMatch(/mode/);

    const json = JSON.parse(
      ts.graph_status({ graph_id, format: "json", include_loops: true }),
    );
    expect(json.loops).toHaveLength(1);
    expect(json.loops[0]).toMatchObject({ loop_id: "lg" });
    expect(json.loops[0]).not.toHaveProperty("mode");

    expect(ts.graph_status({ graph_id, include_loops: true })).not.toMatch(/mode=/);
  });
});

// ── graph_cancel ──────────────────────────────────────────────────────────

describe("graph_cancel", () => {
  it("cancels the whole graph and advances phase to complete", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({ graph_id });
    // All nodes transition cancelled→done; the tool picks up the done set.
    expect(r.cancelled).toHaveLength(4);
    expect(r.graph_id).toBe(graph_id);
    const state = ts["getEntry"](graph_id).runtime.status();
    for (const node of state.nodes.values()) {
      expect(node.status).toBe("done");
    }
    expect(state.phase).toBe("complete");
  });

  /** Read the ids of nodes actually retired by a scoped cancellation. The
   *  EngineRuntime.cancelNodes primitive advances each cancellable node through
   *  cancelled → done, so the real terminal state is `done` (not `cancelled`). */
  function liveCancelled(ts: GraphToolSet, graphId: string): string[] {
    const state = ts["getEntry"](graphId).runtime.status();
    return [...state.nodes.values()]
      .filter((n) => n.status === "done")
      .map((n) => n.nodeId)
      .sort();
  }

  it("scopes the reported cancelled set to a node id (cascade=false default)", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-node" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({ graph_id, node_id: "planner" });
    // A bare node_id defaults to cascade=false: dependents stay pending.
    expect(r.cancelled).toEqual(["planner"]);
    // Reported set matches real engine state — the old filter hack is gone.
    expect(r.cancelled).toEqual(liveCancelled(ts, graph_id));
    expect(
      ts["getEntry"](graph_id).runtime.status().nodes.get("implementer")?.status,
    ).toBe("pending");
  });

  it("cancels a node plus its downstream closure when cascade=true", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-node-cascade" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({ graph_id, node_id: "planner", cascade: true });
    // planner + transitive downstream: implementer, reviewer, approval-gate.
    expect(r.cancelled.sort()).toEqual([
      "approval-gate",
      "implementer",
      "planner",
      "reviewer",
    ]);
    expect(r.cancelled.sort()).toEqual(liveCancelled(ts, graph_id));
  });

  it("cancels a loop group plus its dependents (cascade=true default)", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-loop" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({ graph_id, loop_id: "review-cycle" });
    // Loop members (implementer, reviewer) + downstream (approval-gate).
    expect(r.cancelled.sort()).toEqual([
      "approval-gate",
      "implementer",
      "reviewer",
    ]);
    expect(r.cancelled.sort()).toEqual(liveCancelled(ts, graph_id));
  });

  it("honors an explicit cascade=false on a loop target", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-loop-nocascade" });
    buildReviewTeamPlus(ts, graph_id);
    const r = await ts.graph_cancel({
      graph_id,
      loop_id: "review-cycle",
      cascade: false,
    });
    // Members only — approval-gate (dependent) stays pending.
    expect(r.cancelled.sort()).toEqual(["implementer", "reviewer"]);
    expect(r.cancelled.sort()).toEqual(liveCancelled(ts, graph_id));
    expect(
      ts["getEntry"](graph_id).runtime.status().nodes.get("approval-gate")?.status,
    ).toBe("pending");
  });

  it("throws for an unknown graph", () => {
    const ts = createGraphToolSet();
    expect(() => ts.graph_cancel({ graph_id: "nope" })).toThrow(/does not exist/);
  });
});
