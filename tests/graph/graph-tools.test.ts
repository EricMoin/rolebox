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

import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGraphToolSet,
  GraphToolSet,
  type GraphToolSetDeps,
  log as graphToolsLog,
} from "../../src/graph/tools/graph-tools.ts";
import type { GraphStatusArgs } from "../../src/graph/tools/graph-tools.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import type { NodeRuntimeState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import type { NodeDispatchPort } from "../../src/graph/engine/engine-advance.ts";
import type { EngineRuntime } from "../../src/graph/engine/index.ts";
import type { ISessionClient } from "../../src/platform/ports/session-client.ts";
import { graphEventsPath } from "../../src/graph/engine/graph-events.ts";
import { GraphEventRecorder } from "../../src/graph/engine/graph-events.ts";
import { clearParentQueues, GRAPH_BLOCKED_MARKER } from "../../src/dispatch/notification.ts";
import {
  GraphDeclareRefusedError,
  OutcomeProtocolUnavailableError,
  type DeclareRefusalReason,
} from "../../src/graph/tools/declare-graph.ts";
import { engineStatePath } from "../../src/graph/engine/engine-persistence.ts";
import { OUTCOME_PROTOCOL } from "../../src/graph/protocol/execution-protocol.ts";
import { contractDigest, type ContractRef } from "../../src/graph/contracts/contract-definition.ts";
import { createContractRegistry } from "../../src/graph/contracts/resolve.ts";

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
    budget: { max_cost_usd: 3 },
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
      budget: { max_total_cost_usd: 20 },
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
      budget: { max_input_tokens: 1000 },
      timeout_ms: 60000,
      max_retries: 3,
    });
    const state = ts["getEntry"](graph_id).runtime.status();
    const cfg = state.graphDeclaration.nodes[0];
    expect(cfg.join).toEqual({ strategy: "quorum", quorum: 2 });
    expect(cfg.budget).toMatchObject({
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
    // Two-node cycle with external entry to satisfy structural validation.
    ts.graph_add_node({ graph_id, id: "entry", agent: "agent-entry", prompt: "seed" });
    ts.graph_add_node({ graph_id, id: "a", agent: "agent-a", prompt: "p" });
    ts.graph_add_node({ graph_id, id: "b", agent: "agent-b", prompt: "p" });
    ts.graph_add_edge({ graph_id, from: "entry", to: "a", type: "always" });
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

// ── graph_run — F2 staleness guard options (production defaults) ────────────

describe("graph_run — F2 stale-node watcher + stale-lock sweeper options", () => {
  /**
   * Dispatch seam that never completes tasks — the engine stays in phase
   * `executing` so the built runtime (with its started watcher/sweeper
   * intervals) remains the registry's live runtime for inspection.
   */
  class IdleDispatch implements NodeDispatchPort {
    executeNode(
      node: NodeRuntimeState,
      _ctx: DispatchParentContext,
    ): Promise<DispatchTask> {
      return Promise.resolve({
        id: `task-${node.nodeId}`,
        sessionId: `sess-${node.nodeId}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      });
    }
  }

  function openGraph(
    name: string,
    deps?: GraphToolSetDeps,
  ): { ts: GraphToolSet; graphId: string } {
    const ts = new GraphToolSet(deps ?? { dispatch: new IdleDispatch() });
    const { graph_id } = ts.graph_create({ name });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    return { ts, graphId: graph_id };
  }

  /** The runtime graph_run just built (registry entry replaced after run). */
  function builtRuntime(ts: GraphToolSet, graphId: string): EngineRuntime {
    return ts["getEntry"](graphId).runtime;
  }

  it("builds the graph_run runtime with the production staleness defaults", async () => {
    const { ts, graphId } = openGraph("f2-defaults");
    await ts.graph_run({ graph_id: graphId });

    // The runtime built by graph_run instantiated the opt-in staleness
    // watcher with the 15-min production deadline ticking at the 1-min
    // sweep interval.
    const runtime = builtRuntime(ts, graphId);
    const watcher = (runtime as unknown as {
      staleWatcher?: { nodeStaleTimeoutMs: number; intervalMs: number };
    }).staleWatcher;
    expect(watcher).toBeDefined();
    expect(watcher!.nodeStaleTimeoutMs).toBe(15 * 60_000);
    expect(watcher!.intervalMs).toBe(60_000);
    // ...and carries the periodic stale-lock sweep interval option.
    expect(
      (runtime as unknown as { sweeperIntervalMs?: number }).sweeperIntervalMs,
    ).toBe(60_000);

    runtime.dispose(); // stop the started watcher/sweeper intervals (no leak)
  });

  it("honors explicit caller overrides via the toolset deps", async () => {
    const { ts, graphId } = openGraph("f2-override", {
      dispatch: new IdleDispatch(),
      nodeStaleTimeoutMs: 5_000,
      sweeperIntervalMs: 2_000,
    });
    await ts.graph_run({ graph_id: graphId });

    const runtime = builtRuntime(ts, graphId);
    const watcher = (runtime as unknown as {
      staleWatcher?: { nodeStaleTimeoutMs: number; intervalMs: number };
    }).staleWatcher;
    expect(watcher!.nodeStaleTimeoutMs).toBe(5_000);
    expect(watcher!.intervalMs).toBe(2_000);
    expect(
      (runtime as unknown as { sweeperIntervalMs?: number }).sweeperIntervalMs,
    ).toBe(2_000);

    runtime.dispose();
  });

  it("allows opting out of both guards with non-positive overrides", async () => {
    const { ts, graphId } = openGraph("f2-optout", {
      dispatch: new IdleDispatch(),
      nodeStaleTimeoutMs: 0,
      sweeperIntervalMs: 0,
    });
    await ts.graph_run({ graph_id: graphId });

    const runtime = builtRuntime(ts, graphId);
    // A non-positive staleness deadline → no watcher instantiated.
    expect(
      (runtime as unknown as { staleWatcher?: unknown }).staleWatcher,
    ).toBeUndefined();
    // A non-positive sweep interval → run() starts no periodic sweep.
    expect(
      (runtime as unknown as { sweeperIntervalMs?: number }).sweeperIntervalMs,
    ).toBe(0);

    runtime.dispose();
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

  it("paginates output with max_chars / tail (truncation carries a marker)", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "page" });
    buildReviewTeamPlus(ts, graph_id);
    // Monitor L3: a truncated output is capped at max_chars PLUS an explicit
    // "…[truncated: N more chars]" marker appended at the tail.
    const short = status(ts, graph_id, { max_chars: 10 });
    expect(short).toMatch(/…\[truncated: \d+ more chars\]$/);
    // The untruncated content slice is exactly max_chars long; the marker
    // carries the count of chars dropped from the tail.
    const body = short.replace(/\n…\[truncated: \d+ more chars\]$/, "");
    expect(body.length).toBe(10);
    // tail:true keeps the LAST max_chars chars, marker reports the head dropped.
    const tail = status(ts, graph_id, { max_chars: 10, tail: true });
    expect(tail).toMatch(/…\[truncated: \d+ more chars\]$/);
    // No truncation when the output fits — byte-identical, no marker.
    const full = status(ts, graph_id, {});
    expect(full).not.toContain("…[truncated:");
  });

  it("JSON output surfaces dispatch_session_id / dispatch_task_id for a dispatched node", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dispatch" });
    buildReviewTeamPlus(ts, graph_id);

    // Stamp dispatch ids directly on the planner node's RUNTIME state (the raw
    // EngineState, not the snapshot clone that status() returns).
    const entry = ts["getEntry"](graph_id);
    const rawState = (entry.runtime as unknown as { state: EngineState }).state;
    const planner = rawState.nodes.get("planner")!;
    planner.dispatchSessionId = "sess-planner-1";
    planner.dispatchTaskId = "task-planner-1";

    // JSON format (session scope) — nodeSummary() path.
    const json = JSON.parse(ts.graph_status({ graph_id, format: "json" }));
    const plannerNode = (json.nodes as Array<Record<string, unknown>>).find(
      (n) => n.node_id === "planner",
    )!;
    expect(plannerNode.dispatch_session_id).toBe("sess-planner-1");
    expect(plannerNode.dispatch_task_id).toBe("task-planner-1");

    // Undispatched node (implementer) — keys must be absent.
    const implNode = (json.nodes as Array<Record<string, unknown>>).find(
      (n) => n.node_id === "implementer",
    )!;
    expect(implNode).not.toHaveProperty("dispatch_session_id");
    expect(implNode).not.toHaveProperty("dispatch_task_id");
  });

  it("text (single-node) output surfaces dispatch_session_id / dispatch_task_id labels", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "dispatch-txt" });
    buildReviewTeamPlus(ts, graph_id);

    // Stamp dispatch ids directly on the raw engine state (not the clone).
    const entry = ts["getEntry"](graph_id);
    const rawState = (entry.runtime as unknown as { state: EngineState }).state;
    const planner = rawState.nodes.get("planner")!;
    planner.dispatchSessionId = "sess-planner-1";
    planner.dispatchTaskId = "task-planner-1";

    const text = ts.graph_status({ node_id: "planner" });
    expect(text).toMatch(/dispatch_session_id: sess-planner-1/);
    expect(text).toMatch(/dispatch_task_id: task-planner-1/);

    // Undispatched node — no dispatch lines.
    const implText = ts.graph_status({ node_id: "implementer" });
    expect(implText).not.toMatch(/dispatch_session_id/);
    expect(implText).not.toMatch(/dispatch_task_id/);
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
    // A1: the FULL engine report reaches the tool answer — the expanded
    // target is every node, nothing was left alone, and no id was unknown.
    expect(r.target).toEqual(["approval-gate", "implementer", "planner", "reviewer"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.cancelCalls).toEqual([]);
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
    // A1: the engine's expansion / skip / unknown / hand-off lists are all
    // projected, not just the retired set.
    expect(r.target).toEqual(["planner"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.cancelCalls).toEqual([]);
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
    // The expanded target stays the requested node; the closure lives in
    // `cancelled` (A1).
    expect(r.target).toEqual(["planner"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
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
    // The loop-group expansion is the engine's own target set (A1).
    expect(r.target).toEqual(["implementer", "reviewer"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
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

  /**
   * Dispatch seam for the report tests: keeps every launch `running` (its task
   * never fires termination) so a cancel has a live `dispatchTaskId` to report,
   * and records the fire-and-forget `cancelTask` hand-offs. With
   * `complete = true` every launch completes on the next macrotask instead, so
   * a target can reach a non-cancellable terminal status through the real path.
   */
  class CancelProbeDispatch implements NodeDispatchPort {
    readonly cancelled: string[] = [];
    private readonly subs = new Map<string, TaskTerminatedCallback>();
    private seq = 0;

    constructor(private readonly complete: boolean = false) {}

    executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
      const id = `task-${node.nodeId}-${++this.seq}`;
      const task = {
        id,
        sessionId: `sess-${id}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      } as DispatchTask;
      if (this.complete) {
        setTimeout(() => this.subs.get(id)?.(id, "completed"), 0);
      }
      return Promise.resolve(task);
    }

    onTaskTerminated(
      taskId: string,
      cb: TaskTerminatedCallback,
    ): TaskTerminatedCallback {
      this.subs.set(taskId, cb);
      return cb;
    }

    cancelTask(taskId: string): Promise<boolean> {
      this.cancelled.push(taskId);
      return Promise.resolve(true);
    }
  }

  /** Let setTimeout(0) completions settle through the engine. */
  const settle = () => new Promise((r) => setTimeout(r, 25));

  it("reports a requested id that names no node in a dedicated unknown list", async () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "cancel-unknown" });
    buildReviewTeamPlus(ts, graph_id);

    const r = await ts.graph_cancel({ graph_id, node_id: "ghost" });

    expect(r.cancelled).toEqual([]);
    expect(r.target).toEqual(["ghost"]);
    expect(r.unknown).toEqual(["ghost"]);
    expect(r.cancelCalls).toEqual([]);
    // E4: the engine's split is in place, so the miss must NOT also appear in
    // `skipped` (whose meaning is "exists, but not cancellable").
    expect(r.skipped).toEqual([]);
  });

  it("reports a target that is no longer cancellable in skipped, not cancelled", async () => {
    const ts = new GraphToolSet({ dispatch: new CancelProbeDispatch(true) });
    const { graph_id } = ts.graph_create({ name: "cancel-skipped" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id });
    // A ends `completed` (not cancellable — only pending/ready/running are).
    await settle();
    expect(ts["getEntry"](graph_id).runtime.status().nodes.get("A")!.status).toBe("completed");

    const r = await ts.graph_cancel({ graph_id, node_id: "A" });

    expect(r.cancelled).toEqual([]);
    expect(r.skipped).toEqual(["A"]);
    expect(r.unknown).toEqual([]);
    expect(r.target).toEqual(["A"]);
    expect(r.cancelCalls).toEqual([]);
  });

  it("reports the best-effort cancelTask hand-offs for a running node", async () => {
    const fake = new CancelProbeDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const { graph_id } = ts.graph_create({ name: "cancel-calls" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id });
    const running = ts["getEntry"](graph_id).runtime.status().nodes.get("A")!;
    expect(running.status).toBe("running");
    expect(running.dispatchTaskId).toBe("task-A-1");

    const r = await ts.graph_cancel({ graph_id, node_id: "A" });

    expect(r.cancelled).toEqual(["A"]);
    // The task id is the running node's own dispatch task, handed to the seam
    // fire-and-forget — a teardown request, not an acknowledgement.
    expect(r.cancelCalls).toEqual(["task-A-1"]);
    expect(fake.cancelled).toEqual(["task-A-1"]);
    expect(r.target).toEqual(["A"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("sorts every projected list so the answer is iteration-order independent", async () => {
    const fake = new CancelProbeDispatch();
    const ts = new GraphToolSet({ dispatch: fake });
    const { graph_id } = ts.graph_create({ name: "cancel-sorted" });
    // Declared in non-alphabetical order: both A and B end up running with a
    // task, so both lists exercise the sort rather than declaration order.
    ts.graph_add_node({ graph_id, id: "B", agent: "b", prompt: "pB" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    await ts.graph_run({ graph_id });
    const before = ts["getEntry"](graph_id).runtime.status();
    const taskA = before.nodes.get("A")!.dispatchTaskId;
    const taskB = before.nodes.get("B")!.dispatchTaskId;
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();

    const r = await ts.graph_cancel({ graph_id });

    // The engine walks its node map in declaration order (B, A), so an
    // unsorted projection would answer ["B","A"]; every list is ascending.
    expect(r.target).toEqual(["A", "B"]);
    expect(r.cancelled).toEqual(["A", "B"]);
    expect(r.cancelCalls).toEqual([taskA!, taskB!].sort());
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});

// ── hasInflightGraphsForSession (session-level in-flight query) ────────────

describe("hasInflightGraphsForSession", () => {
  /**
   * Fake dispatch seam that executes nodes, optionally keeping selected nodes
   * running forever (their tasks never fire completion) so the engine stays in
   * phase `executing`. Mirrors the CompletingDispatch pattern from
   * graph-run-idempotent.test.ts.
   */
  class FakeDispatch implements NodeDispatchPort {
    calls: { nodeId: string; prompt: string }[] = [];
    private subs = new Map<string, TaskTerminatedCallback>();
    private tasks = new Map<string, DispatchTask>();
    private seq = 0;
    constructor(private stayRunning: Set<string> = new Set()) {}

    executeNode(
      node: NodeRuntimeState,
      _ctx: DispatchParentContext,
    ): Promise<DispatchTask> {
      this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
      const id = `task-${node.nodeId}-${++this.seq}`;
      const task: DispatchTask = {
        id,
        sessionId: `sess-${id}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      };
      this.tasks.set(id, task);
      if (!this.stayRunning.has(node.nodeId)) {
        setTimeout(() => {
          task.status = "completed";
          this.subs.get(id)?.(id, "completed");
        }, 0);
      }
      return Promise.resolve(task);
    }

    onTaskTerminated(
      taskId: string,
      cb: TaskTerminatedCallback,
    ): TaskTerminatedCallback {
      this.subs.set(taskId, cb);
      return cb;
    }

    getTask(taskId: string): DispatchTask | undefined {
      return this.tasks.get(taskId);
    }
  }

  /** Allow setTimeout(0) completions to settle through the engine. */
  const settle = () => new Promise((r) => setTimeout(r, 25));

  /** Open a single-root graph with one node on a fake-dispatch tool set. */
  function openSingleNode(
    name: string,
    stayRunning?: Set<string>,
  ): { ts: GraphToolSet; graphId: string } {
    const deps: GraphToolSetDeps = { dispatch: new FakeDispatch(stayRunning) };
    const ts = new GraphToolSet(deps);
    const { graph_id } = ts.graph_create({ name });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    return { ts, graphId: graph_id };
  }

  beforeEach(() => {
    clearParentQueues();
  });

  it("returns true while a node is running on a graph owned by the session", async () => {
    const { ts, graphId } = openSingleNode("inflight-true", new Set(["A"]));
    await ts.graph_run({ graph_id: graphId }, "sess-S");
    // Node A's task never completes → engine stays executing with A running.
    expect(ts.hasInflightGraphsForSession("sess-S")).toBe(true);
  });

  it("returns false once all nodes complete", async () => {
    const { ts, graphId } = openSingleNode("inflight-done");
    await ts.graph_run({ graph_id: graphId }, "sess-S");
    await settle();
    const state = ts["getEntry"](graphId).runtime.status();
    expect(state.phase).toBe("complete");
    expect(ts.hasInflightGraphsForSession("sess-S")).toBe(false);
  });

  it("returns false for an unrelated session id while the graph is running", async () => {
    const { ts, graphId } = openSingleNode("inflight-other", new Set(["A"]));
    await ts.graph_run({ graph_id: graphId }, "sess-S");
    expect(ts.hasInflightGraphsForSession("sess-OTHER")).toBe(false);
  });

  it("returns false for a graph the session owns but never ran (phase idle)", async () => {
    const ts = new GraphToolSet({ dispatch: new FakeDispatch() });
    const { graph_id } = ts.graph_create({ name: "inflight-idle" }, "sess-S");
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    expect(ts["getEntry"](graph_id).runtime.status().phase).toBe("idle");
    expect(ts.hasInflightGraphsForSession("sess-S")).toBe(false);
  });

  it("returns false when no graph carries the session id", () => {
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "no-session" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    expect(ts.hasInflightGraphsForSession("sess-S")).toBe(false);
  });
});

// ── Nested-graph liveness surface ──────────────────────────────────────────
//
// Backs the dsh dispatch adapter's nested-graph settlement guard: an outer
// node whose subagent launched a nested graph must not be reported complete
// until that graph settles, and a failed nested graph must propagate.

describe("hasExecutingGraphsForSession / subscribeGraphTerminal", () => {
  /** Controllable dispatch seam: completes nodes async, optionally failing. */
  class FakeDispatch implements NodeDispatchPort {
    private subs = new Map<string, TaskTerminatedCallback>();
    private tasks = new Map<string, DispatchTask>();
    private seq = 0;
    constructor(
      private stayRunning: Set<string> = new Set(),
      private failNodes: Set<string> = new Set(),
    ) {}

    executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
      const id = `task-${node.nodeId}-${++this.seq}`;
      const task: DispatchTask = {
        id,
        sessionId: `sess-${id}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      };
      this.tasks.set(id, task);
      if (!this.stayRunning.has(node.nodeId)) {
        setTimeout(() => {
          const status = this.failNodes.has(node.nodeId) ? "error" : "completed";
          task.status = status;
          if (status === "error") task.error = "boom";
          this.subs.get(id)?.(id, status);
        }, 0);
      }
      return Promise.resolve(task);
    }

    onTaskTerminated(
      taskId: string,
      cb: TaskTerminatedCallback,
    ): TaskTerminatedCallback {
      this.subs.set(taskId, cb);
      return cb;
    }

    getTask(taskId: string): DispatchTask | undefined {
      return this.tasks.get(taskId);
    }
  }

  const settle = () => new Promise((r) => setTimeout(r, 25));

  function openSingleNode(
    name: string,
    opts?: { stayRunning?: Set<string>; failNodes?: Set<string> },
  ): { ts: GraphToolSet; graphId: string } {
    const ts = new GraphToolSet({
      dispatch: new FakeDispatch(opts?.stayRunning, opts?.failNodes),
    });
    const { graph_id } = ts.graph_create({ name });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    return { ts, graphId: graph_id };
  }

  beforeEach(() => {
    clearParentQueues();
  });

  it("hasExecutingGraphsForSession is true while the engine is executing, false once complete", async () => {
    const { ts, graphId } = openSingleNode("exec-true", {
      stayRunning: new Set(["A"]),
    });
    await ts.graph_run({ graph_id: graphId }, "sess-S");
    expect(ts.hasExecutingGraphsForSession("sess-S")).toBe(true);
    expect(ts.hasExecutingGraphsForSession("sess-OTHER")).toBe(false);

    const done = openSingleNode("exec-done");
    await done.ts.graph_run({ graph_id: done.graphId }, "sess-S");
    await settle();
    expect(done.ts.hasExecutingGraphsForSession("sess-S")).toBe(false);
  });

  it("subscribeGraphTerminal fires a non-failed observation for a clean completion", async () => {
    const { ts, graphId } = openSingleNode("terminal-ok");
    const seen: Array<{ graphId: string; sessionId?: string; failed: boolean }> = [];
    const unsub = ts.subscribeGraphTerminal((info) => seen.push(info));

    await ts.graph_run({ graph_id: graphId }, "sess-S");
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].graphId).toBe(graphId);
    expect(seen[0].sessionId).toBe("sess-S");
    expect(seen[0].failed).toBe(false);

    unsub();
    const again = openSingleNode("terminal-after-unsub");
    await again.ts.graph_run({ graph_id: again.graphId }, "sess-S");
    await settle();
    expect(seen).toHaveLength(1); // no further observations after unsubscribe
  });

  it("subscribeGraphTerminal marks a graph with an escalated node as failed", async () => {
    const { ts, graphId } = openSingleNode("terminal-failed", {
      failNodes: new Set(["A"]),
    });
    const seen: Array<{ graphId: string; sessionId?: string; failed: boolean }> = [];
    ts.subscribeGraphTerminal((info) => seen.push(info));

    await ts.graph_run({ graph_id: graphId }, "sess-S");
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0].graphId).toBe(graphId);
    expect(seen[0].failed).toBe(true);
  });
});

// ── Nested blocked-gate approval propagation ──────────────────────────────
//
// A `needs_approval` gate inside a NESTED graph must surface its approval
// request at the OUTERMOST live session so the human can approve there — the
// subagent session that invoked the nested graph may already be dead. The
// toolset walks the session chain through the injected resolver (the dsh
// dispatch adapter's dispatch-parent index) and delivers a `[GRAPH BLOCKED]`
// reminder to the outermost session with `noReply:false` (wakes it). A
// single-level graph (no parent) must behave exactly as before.

describe("nested blocked-gate approval propagation", () => {
  /** Dispatch seam that leaves every node running so a gate can be paused. */
  class StayingDispatch implements NodeDispatchPort {
    async executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
      return {
        id: `task-${node.nodeId}`,
        sessionId: `sess-${node.nodeId}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      } as DispatchTask;
    }
  }

  class RecordingSessionClient implements ISessionClient {
    prompts: Array<{ id: string; text: string; noReply?: boolean }> = [];
    async prompt(
      id: string,
      options: { parts: Array<{ type: string; text: string }>; noReply?: boolean },
    ): Promise<{ id: string } | null> {
      this.prompts.push({
        id,
        text: options.parts.map((p) => p.text).join("\n"),
        noReply: options.noReply,
      });
      return { id };
    }
    async list(): Promise<never> { throw new Error("not implemented"); }
    async get(): Promise<never> { throw new Error("not implemented"); }
    async messages(): Promise<never> { throw new Error("not implemented"); }
    async children(): Promise<never> { throw new Error("not implemented"); }
    async todo(): Promise<never> { throw new Error("not implemented"); }
    async diff(): Promise<never> { throw new Error("not implemented"); }
    async fork(): Promise<never> { throw new Error("not implemented"); }
    async status(): Promise<never> { throw new Error("not implemented"); }
    async promptSync(): Promise<never> { throw new Error("not implemented"); }
    async create(): Promise<never> { throw new Error("not implemented"); }
    async abort(): Promise<never> { throw new Error("not implemented"); }
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  /** Reach the live engine runtime (private access — the in-repo test idiom). */
  function liveRuntime(
    ts: GraphToolSet,
    graphId: string,
  ): { advance: { onNodeSignalEmitted(n: string, t: string, p: unknown): Promise<void> } } {
    const entry = (ts as unknown as { getEntry(id: string): { runtime: unknown } })["getEntry"](
      graphId,
    );
    return entry.runtime as unknown as {
      advance: { onNodeSignalEmitted(n: string, t: string, p: unknown): Promise<void> };
    };
  }

  function gateSet(
    client: ISessionClient,
    resolveSessionChain?: (sessionId: string) => string[] | undefined,
  ): { ts: GraphToolSet; graphId: string } {
    const ts = new GraphToolSet({
      dispatch: new StayingDispatch(),
      // Mirror production: the emperor session IS the graph's invoking session.
      graphNotify: {
        sessionClient: client,
        emperorSessionId: (invokingSessionId) => invokingSessionId,
      },
      ...(resolveSessionChain ? { resolveSessionChain } : {}),
    });
    const { graph_id } = ts.graph_create({ name: "nested-gate" });
    ts.graph_add_node({ graph_id, id: "GATE", agent: "a", prompt: "Approve?", needs_approval: true });
    return { ts, graphId: graph_id };
  }

  it("propagates a nested blocked gate to the outermost session with node + graph_approve call", async () => {
    const client = new RecordingSessionClient();
    const { ts, graphId } = gateSet(client, (sid) =>
      sid === "child-session" ? ["child-session", "outer-session"] : [sid],
    );
    const seen: Array<{ isBlocked: boolean; blockedNodeIds: string[] }> = [];
    ts.subscribeGraphTerminal((info) => seen.push(info));

    await ts.graph_run({ graph_id: graphId }, "child-session");
    await liveRuntime(ts, graphId).advance.onNodeSignalEmitted("GATE", "need_approval", "review");
    await settle();

    // The invoking session keeps its own [GRAPH BLOCKED] reminder (unchanged).
    const toChild = client.prompts.filter((p) => p.id === "child-session");
    expect(toChild).toHaveLength(1);
    expect(toChild[0].text).toContain(GRAPH_BLOCKED_MARKER);

    // The propagated reminder targets the OUTERMOST live session and wakes it.
    const toOuter = client.prompts.filter((p) => p.id === "outer-session");
    expect(toOuter).toHaveLength(1);
    expect(toOuter[0].text).toContain(GRAPH_BLOCKED_MARKER);
    expect(toOuter[0].text).toContain(graphId);
    expect(toOuter[0].text).toContain("GATE");
    expect(toOuter[0].text).toContain(
      `graph_approve(graph_id="${graphId}", node_id="GATE", action="approve")`,
    );
    // The parent chain is carried so the human sees WHICH nested invocation.
    expect(toOuter[0].text).toContain("child-session -> outer-session");
    expect(toOuter[0].noReply).toBe(false);

    // The observation carries the blocked fact + blocked node ids.
    expect(seen[seen.length - 1]?.isBlocked).toBe(true);
    expect(seen[seen.length - 1]?.blockedNodeIds).toEqual(["GATE"]);
  });

  it("does not propagate when the invoking session is already the outermost (single-level)", async () => {
    const client = new RecordingSessionClient();
    const { ts, graphId } = gateSet(client, (sid) => [sid]);

    await ts.graph_run({ graph_id: graphId }, "only-session");
    await liveRuntime(ts, graphId).advance.onNodeSignalEmitted("GATE", "need_approval", "review");
    await settle();

    expect(client.prompts.map((p) => p.id)).toEqual(["only-session"]);
  });

  it("does not propagate when no chain resolver is wired (opencode/Pi unchanged)", async () => {
    const client = new RecordingSessionClient();
    const { ts, graphId } = gateSet(client, undefined);

    await ts.graph_run({ graph_id: graphId }, "child-session");
    await liveRuntime(ts, graphId).advance.onNodeSignalEmitted("GATE", "need_approval", "review");
    await settle();

    expect(client.prompts.map((p) => p.id)).toEqual(["child-session"]);
  });
});

// ── graph-notify degradation (F6) ─────────────────────────────────────────

describe("graph-notify degradation (F6)", () => {
  /**
   * Minimal ISessionClient — never dereferenced: when the emperor session
   * resolves to falsy the notifier is NOT constructed (the degraded path under
   * test), so the client is only present to satisfy the config shape.
   */
  class FakeSessionClient implements ISessionClient {
    async prompt(): Promise<{ id: string } | null> {
      return null;
    }
    async list(): Promise<never> {
      throw new Error("not implemented");
    }
    async get(): Promise<never> {
      throw new Error("not implemented");
    }
    async messages(): Promise<never> {
      throw new Error("not implemented");
    }
    async children(): Promise<never> {
      throw new Error("not implemented");
    }
    async todo(): Promise<never> {
      throw new Error("not implemented");
    }
    async diff(): Promise<never> {
      throw new Error("not implemented");
    }
    async fork(): Promise<never> {
      throw new Error("not implemented");
    }
    async status(): Promise<never> {
      throw new Error("not implemented");
    }
    async promptSync(): Promise<never> {
      throw new Error("not implemented");
    }
    async create(): Promise<never> {
      throw new Error("not implemented");
    }
    async abort(): Promise<never> {
      throw new Error("not implemented");
    }
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("warns (naming graph + seam) and writes a durable marker when a stateDir is configured", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "graph-tools-degraded-"));
    const ts = createGraphToolSet({
      stateDir,
      graphNotify: {
        sessionClient: new FakeSessionClient(),
        // Resolver always fails → both seams degrade (no notifier constructed).
        emperorSessionId: () => undefined,
      },
    });
    const warnSpy = jest.spyOn(graphToolsLog, "warn");

    const { graph_id } = ts.graph_create({ name: "degraded-graph" }, "invoking-1");

    // Both the node-completion and graph-terminal seams warn, naming the graph.
    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      messages.some(
        (m) =>
          m.includes("degraded-graph") &&
          m.includes("completion notification degraded"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes("degraded-graph") &&
          m.includes("terminal notification degraded"),
      ),
    ).toBe(true);

    // Durable `notification_degraded` markers landed in the graph event log
    // (`.rolebox/state/graph-events-{hash}.ndjson` under the stateDir).
    const eventsPath = graphEventsPath(stateDir, graph_id);
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const degraded = lines.filter((l) =>
      l.includes('"event":"notification_degraded"'),
    );
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.some((l) => l.includes('"status":"completion"'))).toBe(true);
    expect(degraded.some((l) => l.includes('"status":"terminal"'))).toBe(true);
  });

  it("warns without a durable marker when no stateDir is configured", () => {
    const ts = createGraphToolSet({
      graphNotify: {
        sessionClient: new FakeSessionClient(),
        emperorSessionId: () => undefined,
      },
    });
    const warnSpy = jest.spyOn(graphToolsLog, "warn");

    ts.graph_create({ name: "degraded-nostate" }, "invoking-1");

    // Warning surfaces the graph name; the marker path is skipped (no stateDir).
    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("degraded-nostate"))).toBe(true);
  });

  it("graph_status surfaces the degraded marker — summary hint + json field", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "graph-tools-degraded-status-"));
    const ts = createGraphToolSet({
      stateDir,
      graphNotify: {
        sessionClient: new FakeSessionClient(),
        // Resolver always fails → both seams degrade and write markers.
        emperorSessionId: () => undefined,
      },
    });
    const { graph_id } = ts.graph_create({ name: "degraded-status" }, "invoking-1");
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });

    // Summary render appends an explicit degraded hint naming each seam.
    const summary = ts.graph_status({ graph_id });
    expect(summary).toContain("⚠ notification degraded:");
    expect(summary).toContain(
      "completion notification could not reach the orchestrator (no emperor session resolved)",
    );
    expect(summary).toContain(
      "terminal notification could not reach the orchestrator (no emperor session resolved)",
    );

    // JSON render adds the degraded boolean + the status list.
    const json = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as Record<string, unknown>;
    expect(json.notification_degraded).toBe(true);
    expect(json.notification_degraded_statuses).toEqual(["completion", "terminal", "stall"]);
  });

  it("graph_status output is unchanged when no degraded marker exists", () => {
    // No stateDir and no graphNotify → no markers can ever be recorded, and the
    // read helper short-circuits, so the output stays byte-compatible.
    const ts = createGraphToolSet();
    const { graph_id } = ts.graph_create({ name: "no-degraded" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });

    const summary = ts.graph_status({ graph_id });
    expect(summary).not.toContain("notification degraded");

    const json = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty("notification_degraded");
    expect(json).not.toHaveProperty("notification_degraded_statuses");
  });

  it("graph_status surfaces a degraded marker written directly to the event log", () => {
    // Independent of the handler path: a `notification_degraded` line in the
    // graph's event log (any writer) is what the render layer reads.
    const stateDir = mkdtempSync(join(tmpdir(), "graph-tools-degraded-direct-"));
    const ts = createGraphToolSet({ stateDir });
    const { graph_id } = ts.graph_create({ name: "degraded-direct" });
    ts.graph_add_node({ graph_id, id: "A", agent: "agent-a", prompt: "pA" });
    new GraphEventRecorder(stateDir).notificationDegraded(graph_id, "terminal");

    const summary = ts.graph_status({ graph_id });
    expect(summary).toContain(
      "⚠ notification degraded: terminal notification could not reach the orchestrator (no emperor session resolved)",
    );

    const json = JSON.parse(
      ts.graph_status({ graph_id, format: "json" }),
    ) as Record<string, unknown>;
    expect(json.notification_degraded).toBe(true);
    expect(json.notification_degraded_statuses).toEqual(["terminal"]);
  });
});

// ── Subtask 2: commit-path adoptPrior containment ───────────────────────────

/**
 * Install a capturing `unhandledRejection` listener. Bun delivers unhandled
 * rejections to this listener (instead of crashing) so a test can assert none
 * were produced. `detach` removes it — ALWAYS detach in a finally.
 */
function captureUnhandledRejections(): { list: unknown[]; detach: () => void } {
  const list: unknown[] = [];
  const handler = (reason: unknown) => {
    list.push(reason);
  };
  process.on("unhandledRejection", handler);
  return {
    list,
    detach: () => {
      process.off("unhandledRejection", handler);
    },
  };
}

describe("subtask 2: commit-path adoptPrior containment", () => {
  /** Dispatch seam whose tasks stay running — establishes real progress. */
  class IdleDispatch implements NodeDispatchPort {
    executeNode(
      node: NodeRuntimeState,
      _ctx: DispatchParentContext,
    ): Promise<DispatchTask> {
      return Promise.resolve({
        id: `task-${node.nodeId}`,
        sessionId: `sess-${node.nodeId}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      });
    }
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("contains a throwing adoptPrior in the commit path (logged, no unhandled rejection)", async () => {
    const ts = new GraphToolSet({ dispatch: new IdleDispatch() });
    const { graph_id } = ts.graph_create({ name: "adopt-throw" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a1", prompt: "pA" });

    // Establish real progress: graph_run dispatches A → it stays `running`,
    // so the next construction commit sees `hasProgress` and calls the fresh
    // runtime's adoptPrior with the prior state.
    await ts.graph_run({ graph_id });

    // Force the freshly-built engine's adoptPrior to reject. The commit path
    // invokes it fire-and-forget (`void runtime.adoptPrior(...)`), so the
    // rejection must be contained there — never an unhandled rejection.
    const entry = ts["getEntry"](graph_id);
    const proto = Object.getPrototypeOf(entry.runtime) as {
      adoptPrior: (...args: unknown[]) => Promise<unknown>;
    };
    const original = proto.adoptPrior;
    proto.adoptPrior = async () => {
      throw new Error("adoptPrior boom");
    };

    const { list, detach } = captureUnhandledRejections();
    const warnSpy = jest.spyOn(graphToolsLog, "warn");
    warnSpy.mockClear();
    try {
      // Trigger commit: add_node rebuilds the engine and adopts prior progress.
      ts.graph_add_node({ graph_id, id: "B", agent: "a2", prompt: "pB" });
      await tick();
      await tick();

      // The throwing adoptPrior produced NO unhandled rejection...
      expect(list).toEqual([]);
      // ...and was logged (the failure is visible, not silently dropped).
      const messages = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("adoptPrior failed"))).toBe(true);
      // The commit itself completed despite the adoption failure: the new
      // declaration (with B) is live in the registry.
      const after = ts["getEntry"](graph_id).declaration;
      expect(after.nodes.some((n) => n.id === "B")).toBe(true);
    } finally {
      proto.adoptPrior = original;
      warnSpy.mockRestore();
      detach();
      // Stop any started watcher/sweeper intervals on the live runtime.
      ts["getEntry"](graph_id).runtime.dispose?.();
    }
  });
});

// ── graph_declare — the v3 authoring ingress (C1) ───────────────────────────

describe("graph_declare — v3 declaration ingress (C1)", () => {
  /** A valid v3 declaration: two nodes and one outcome-bound edge. */
  function v3Declaration(): Record<string, unknown> {
    return {
      version: 3,
      name: "declared-graph",
      nodes: [
        { id: "plan", agent: "agent.plan", prompt: "Plan.", outcomes: [{ id: "planned" }] },
        { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
      ],
      edges: [{ from: "plan", to: "ship", outcome: "planned" }],
    };
  }

  /** Dispatch seam that completes every node on the next tick (legacy runs). */
  class CompletingDispatch implements NodeDispatchPort {
    private subs = new Map<string, TaskTerminatedCallback>();
    private tasks = new Map<string, DispatchTask>();
    private seq = 0;

    executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
      const id = `task-${node.nodeId}-${++this.seq}`;
      const task: DispatchTask = {
        id,
        sessionId: `sess-${id}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      };
      this.tasks.set(id, task);
      setTimeout(() => {
        task.status = "completed";
        this.subs.get(id)?.(id, "completed");
      }, 0);
      return Promise.resolve(task);
    }

    onTaskTerminated(
      taskId: string,
      cb: TaskTerminatedCallback,
    ): TaskTerminatedCallback {
      this.subs.set(taskId, cb);
      return cb;
    }

    getTask(taskId: string): DispatchTask | undefined {
      return this.tasks.get(taskId);
    }
  }

  /** Dispatch seam that counts every dispatch attempt (and never completes). */
  class CountingDispatch implements NodeDispatchPort {
    calls = 0;
    executeNode(node: NodeRuntimeState): Promise<DispatchTask> {
      this.calls += 1;
      return Promise.resolve({
        id: `task-${node.nodeId}`,
        sessionId: `sess-${node.nodeId}`,
        parentSessionId: "g",
        depth: 1,
        status: "running",
        agent: node.agent,
        prompt: node.prompt,
        startedAt: new Date(),
        progress: { lastUpdate: new Date(), toolCalls: 0 },
        priority: 0,
      });
    }
  }

  const settle = () => new Promise((r) => setTimeout(r, 25));

  let tempDirs: string[] = [];
  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /** Declare and return the typed refusal (failing the test when none came). */
  function refusalFrom(
    action: () => unknown,
    expected: DeclareRefusalReason,
  ): GraphDeclareRefusedError {
    let caught: unknown;
    try {
      action();
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof GraphDeclareRefusedError)) {
      throw new Error("expected a GraphDeclareRefusedError, got: " + String(caught));
    }
    expect(caught.reason).toBe(expected);
    return caught;
  }

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it("declares, compiles and persists the plan with its binding and protocol identity", () => {
    const stateDir = tempDir("graph-declare-");
    const ts = createGraphToolSet({ stateDir });

    const result = ts.graph_declare({ declaration: v3Declaration() });

    expect(result.graph_id).toBe("declared-graph");
    expect(result.plan_revision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.executability).toBe("executable");
    expect(result.declaration_version).toBe(3);
    expect(result.execution_protocol).toBe(OUTCOME_PROTOCOL);
    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);
    expect(result.loop_groups).toBe(0);
    expect(result.terminal_outcomes).toBe(1);
    expect(result.contract_bindings).toBe(0);
    expect(result.persisted).toBe(true);
    expect(result.preserved).toBe(false);
    // The boundary is REPORTED, not merely enforced elsewhere.
    expect(result.runnable).toBe(false);
    expect(result.not_runnable_reason).toMatch(
      /no registered execution-protocol handler/,
    );

    // The REGISTERED runtime state carries the plan, binding and protocol...
    const registered = ts["declaredGraphs"].get("declared-graph");
    expect(registered?.graph.plan.planRevision).toBe(result.plan_revision);
    expect(registered?.graph.state.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(registered?.graph.state.compiledPlan?.planRevision).toBe(
      result.plan_revision,
    );
    expect(registered?.graph.state.planBinding?.planRevision).toBe(
      result.plan_revision,
    );

    // ...and so does the file the store wrote.
    const dto = JSON.parse(
      readFileSync(engineStatePath(stateDir, "declared-graph"), "utf-8"),
    ) as Record<string, unknown>;
    expect(dto.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    const plan = dto.compiledPlan as { planRevision?: string; declarationVersion?: number };
    const binding = dto.planBinding as { planRevision?: string };
    expect(plan.planRevision).toBe(result.plan_revision);
    expect(plan.declarationVersion).toBe(3);
    expect(binding.planRevision).toBe(result.plan_revision);
  });

  it("accepts JSON text as well as an already-parsed value", () => {
    const ts = createGraphToolSet();
    const fromText = ts.graph_declare({
      declaration: JSON.stringify(v3Declaration()),
    });
    const fromValue = ts.graph_declare({ declaration: v3Declaration() });
    // An unchanged re-declaration is preserved, so the revision is identical.
    expect(fromValue.preserved).toBe(true);
    expect(fromValue.plan_revision).toBe(fromText.plan_revision);
  });

  it("refuses a DRAFT, names every unresolved entry and persists nothing", () => {
    const stateDir = tempDir("graph-declare-draft-");
    const ts = createGraphToolSet({ stateDir });
    const draft = {
      version: 3,
      name: "draft-graph",
      nodes: [
        {
          id: "a",
          agent: "agent.a",
          prompt: "Do a.",
          outcomes: [
            { id: "done", acceptance: [{ validator: "schema.check", version: 1 }] },
          ],
        },
      ],
      edges: [],
    };

    const refusal = refusalFrom(
      () => ts.graph_declare({ declaration: draft }),
      "draft-plan",
    );
    expect(refusal.unresolved).toEqual([
      { nodeId: "a", outcomeId: "done", validator: "schema.check", version: 1 },
    ]);
    expect(refusal.message).toContain("nodes.a");
    expect(refusal.message).toContain("schema.check");
    expect(refusal.message).toContain("supported_validators");
    expect(refusal.message).toContain("NON-EXECUTABLE DRAFT");
    // Nothing was persisted and nothing was registered.
    expect(existsSync(engineStatePath(stateDir, "draft-graph"))).toBe(false);
    expect(ts["declaredGraphs"].has("draft-graph")).toBe(false);

    // The SAME declaration is executable once the capability is supplied.
    const declared = ts.graph_declare({
      declaration: draft,
      supported_validators: [{ validator: "schema.check", version: 1 }],
    });
    expect(declared.executability).toBe("executable");
    expect(declared.persisted).toBe(true);
  });

  it("refuses malformed declarations with stable codes and persists nothing", () => {
    const stateDir = tempDir("graph-declare-bad-");
    const ts = createGraphToolSet({ stateDir });

    const missingOutcome = v3Declaration();
    delete (missingOutcome.edges as Array<Record<string, unknown>>)[0]?.outcome;

    const cases: ReadonlyArray<{ input: unknown; code: string }> = [
      { input: "not json {", code: "not-json" },
      { input: 42, code: "not-an-object" },
      { input: { ...v3Declaration(), extra: 1 }, code: "unknown-key" },
      { input: { ...v3Declaration(), version: 2 }, code: "unsupported-version" },
      { input: missingOutcome, code: "missing-field" },
      {
        input: {
          ...v3Declaration(),
          edges: [{ from: "plan", to: "ship", outcome: "ghost" }],
        },
        code: "unknown-outcome-reference",
      },
      {
        input: {
          ...v3Declaration(),
          loop_groups: [
            {
              id: "L",
              nodes: ["plan"],
              max_traversals: 0,
              continuation_outcome: "planned",
              exit_outcome: "shipped",
            },
          ],
        },
        code: "invalid-value",
      },
    ];

    for (const { input, code } of cases) {
      const refusal = refusalFrom(
        () => ts.graph_declare({ declaration: input }),
        "invalid-declaration",
      );
      expect(refusal.diagnostics.some((entry) => entry.code === code)).toBe(true);
      expect(refusal.message).toContain("graph_declare refused");
    }
    // No partial graph was registered or persisted by any refusal.
    expect(ts["declaredGraphs"].size).toBe(0);
    expect(existsSync(engineStatePath(stateDir, "declared-graph"))).toBe(false);
  });

  it("refuses out-of-bound budgets and a blank graph name before persisting anything", () => {
    const stateDir = tempDir("graph-declare-bounds-");
    const ts = createGraphToolSet({ stateDir });

    const budgetCases: ReadonlyArray<{ field: string; value: unknown }> = [
      { field: "timeout_ms", value: -5 },
      { field: "max_retries", value: -1 },
      { field: "max_retries", value: 1.5 },
      { field: "max_input_tokens", value: -1 },
      { field: "max_output_tokens", value: -0.5 },
      { field: "max_cost_usd", value: -1 },
    ];
    for (const { field, value } of budgetCases) {
      const declaration = v3Declaration();
      declaration.nodes = [
        {
          id: "plan",
          agent: "agent.plan",
          prompt: "Plan.",
          outcomes: [{ id: "planned" }],
          budget: { [field]: value },
        },
        { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
      ];
      const refusal = refusalFrom(
        () => ts.graph_declare({ declaration }),
        "invalid-declaration",
      );
      expect(
        refusal.diagnostics.some(
          (entry) =>
            entry.code === "invalid-value" &&
            entry.path === `$.nodes[0].budget.${field}`,
        ),
      ).toBe(true);
    }

    // A blank name names no graph — graph_create refuses it too, so the
    // declared ingress must not mint an unaddressable id.
    const blankName = { ...v3Declaration(), name: "   " };
    const blankRefusal = refusalFrom(
      () => ts.graph_declare({ declaration: blankName }),
      "invalid-declaration",
    );
    expect(
      blankRefusal.diagnostics.some(
        (entry) => entry.code === "invalid-value" && entry.path === "$.name",
      ),
    ).toBe(true);

    // Nothing was registered or written by any of those refusals.
    expect(ts["declaredGraphs"].size).toBe(0);
    expect(existsSync(engineStatePath(stateDir, "declared-graph"))).toBe(false);

    // The boundary values the runtime documents stay executable: a 0 timeout
    // is the staleness-watchdog opt-out and 0 retries/ceilings are valid.
    const boundary = v3Declaration();
    boundary.nodes = [
      {
        id: "plan",
        agent: "agent.plan",
        prompt: "Plan.",
        outcomes: [{ id: "planned" }],
        budget: {
          timeout_ms: 0,
          max_retries: 0,
          max_input_tokens: 0,
          max_output_tokens: 0,
          max_cost_usd: 0,
        },
      },
      { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
    ];
    const accepted = createGraphToolSet({ stateDir }).graph_declare({
      declaration: boundary,
    });
    expect(accepted.executability).toBe("executable");
  });

  it("refuses a graph_id that disagrees with the declaration name", () => {
    const ts = createGraphToolSet();
    const refusal = refusalFrom(
      () => ts.graph_declare({ declaration: v3Declaration(), graph_id: "other" }),
      "graph-id-mismatch",
    );
    expect(refusal.message).toContain("other");
    expect(refusal.message).toContain("declared-graph");
  });

  it("refuses to declare over a legacy graph id (protocol is pinned, never switched)", () => {
    const ts = createGraphToolSet();
    ts.graph_create({ name: "taken" });
    const refusal = refusalFrom(
      () =>
        ts.graph_declare({
          declaration: { ...v3Declaration(), name: "taken" },
        }),
      "legacy-graph-conflict",
    );
    expect(refusal.message).toContain("LEGACY (v2) graph");
  });

  it("reserves a declared graph id against graph_create", () => {
    const ts = createGraphToolSet();
    ts.graph_declare({ declaration: v3Declaration() });
    const created = ts.graph_create({ name: "declared-graph" });
    expect(created.graph_id).toBe("declared-graph-2");
  });

  it("preserves an unchanged re-declaration and refuses a changed one", () => {
    const ts = createGraphToolSet();
    const first = ts.graph_declare({ declaration: v3Declaration() });

    const again = ts.graph_declare({ declaration: v3Declaration() });
    expect(again.preserved).toBe(true);
    expect(again.plan_revision).toBe(first.plan_revision);

    const changed = {
      ...v3Declaration(),
      nodes: [
        { id: "plan", agent: "agent.plan", prompt: "Plan DIFFERENTLY.", outcomes: [{ id: "planned" }] },
        { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
      ],
    };
    const refusal = refusalFrom(
      () => ts.graph_declare({ declaration: changed }),
      "declaration-changed",
    );
    expect(refusal.message).toContain(first.plan_revision);
    expect(refusal.message).toContain("DIFFERENT declaration");

    // The stored plan is untouched by the refused change.
    const after = ts.graph_declare({ declaration: v3Declaration() });
    expect(after.plan_revision).toBe(first.plan_revision);
  });

  it("preserves a persisted declared plan across a fresh toolset (same content)", () => {
    const stateDir = tempDir("graph-declare-restart-");
    const first = createGraphToolSet({ stateDir });
    const declared = first.graph_declare({ declaration: v3Declaration() });
    const path = engineStatePath(stateDir, "declared-graph");
    const before = readFileSync(path, "utf-8");

    // A NEW process has no in-memory entry: the persisted plan is the only
    // record, and identical content preserves it in place (no rewrite).
    const second = createGraphToolSet({ stateDir });
    const again = second.graph_declare({ declaration: v3Declaration() });
    expect(again.preserved).toBe(true);
    expect(again.persisted).toBe(true);
    expect(again.plan_revision).toBe(declared.plan_revision);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(second["declaredGraphs"].has("declared-graph")).toBe(true);
  });

  it("refuses a changed declaration over a persisted declared plan (fresh toolset)", () => {
    const stateDir = tempDir("graph-declare-changed-");
    const first = createGraphToolSet({ stateDir });
    const declared = first.graph_declare({ declaration: v3Declaration() });
    const path = engineStatePath(stateDir, "declared-graph");
    const before = readFileSync(path, "utf-8");

    const second = createGraphToolSet({ stateDir });
    const refusal = refusalFrom(
      () =>
        second.graph_declare({
          declaration: {
            ...v3Declaration(),
            nodes: [
              { id: "plan", agent: "agent.plan", prompt: "Plan DIFFERENTLY.", outcomes: [{ id: "planned" }] },
              { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
            ],
          },
        }),
      "declaration-changed",
    );
    expect(refusal.message).toContain(declared.plan_revision);
    expect(refusal.message).toContain("PERSISTED compiled");
    // The persisted plan was NOT overwritten by the refused declaration.
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(second["declaredGraphs"].has("declared-graph")).toBe(false);
  });

  it("refuses to declare over a persisted legacy graph id", async () => {
    const stateDir = tempDir("graph-declare-legacy-disk-");
    const legacy = new GraphToolSet({
      dispatch: new CompletingDispatch(),
      stateDir,
    });
    const { graph_id } = legacy.graph_create({ name: "legacy-on-disk" });
    legacy.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    await legacy.graph_run({ graph_id });
    await settle();
    expect(existsSync(engineStatePath(stateDir, "legacy-on-disk"))).toBe(true);

    // A fresh toolset has no registry entry, but the persisted legacy record
    // still pins the id to the legacy protocol.
    const fresh = createGraphToolSet({ stateDir });
    const refusal = refusalFrom(
      () =>
        fresh.graph_declare({
          declaration: { ...v3Declaration(), name: "legacy-on-disk" },
        }),
      "legacy-graph-conflict",
    );
    expect(refusal.message).toContain("LEGACY (v2) state file");
  });

  it("refuses to overwrite a state file it cannot read", () => {
    const stateDir = tempDir("graph-declare-unreadable-");
    mkdirSync(join(stateDir, ".rolebox", "state"), { recursive: true });
    writeFileSync(engineStatePath(stateDir, "declared-graph"), "{ not json", "utf-8");

    const ts = createGraphToolSet({ stateDir });
    const refusal = refusalFrom(
      () => ts.graph_declare({ declaration: v3Declaration() }),
      "persisted-state-unreadable",
    );
    expect(refusal.message).toContain("not valid JSON");
    // The file was left exactly as it was found.
    expect(readFileSync(engineStatePath(stateDir, "declared-graph"), "utf-8")).toBe(
      "{ not json",
    );
  });

  it("is content-addressed: the same content always yields the same plan revision", () => {
    const one = createGraphToolSet().graph_declare({ declaration: v3Declaration() });
    const two = createGraphToolSet().graph_declare({ declaration: v3Declaration() });
    expect(two.plan_revision).toBe(one.plan_revision);
  });

  it("reports persisted=false when no state directory is configured", () => {
    const ts = createGraphToolSet();
    const result = ts.graph_declare({ declaration: v3Declaration() });
    expect(result.persisted).toBe(false);
    expect(ts["declaredGraphs"].has("declared-graph")).toBe(true);
  });

  it("refuses a contractRef when no contract capability is installed", () => {
    const ts = createGraphToolSet();
    const refusal = refusalFrom(
      () =>
        ts.graph_declare({
          declaration: {
            ...v3Declaration(),
            nodes: [
              {
                id: "plan",
                agent: "agent.plan",
                prompt: "Plan.",
                outcomes: [{ id: "planned" }],
                contractRef: { id: "c", revision: "1", digest: "deadbeef" },
              },
              { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
            ],
          },
        }),
      "invalid-declaration",
    );
    expect(refusal.diagnostics.some((entry) => entry.code === "unresolved-contract")).toBe(true);
  });

  it("binds a resolved contract through the toolset's contract capability", () => {
    const body = { gates: ["schema"], policy: "strict" };
    const ref: ContractRef = {
      id: "contract.review",
      revision: "1",
      digest: contractDigest(body),
    };
    const contracts = createContractRegistry({ contracts: [{ ref, body }] });
    const ts = new GraphToolSet({ contracts });

    const result = ts.graph_declare({
      declaration: {
        ...v3Declaration(),
        nodes: [
          {
            id: "plan",
            agent: "agent.plan",
            prompt: "Plan.",
            outcomes: [{ id: "planned" }],
            contractRef: ref,
          },
          { id: "ship", agent: "agent.ship", prompt: "Ship.", outcomes: [{ id: "shipped" }] },
        ],
      },
    });
    expect(result.contract_bindings).toBe(1);
    const state = ts["declaredGraphs"].get("declared-graph")?.graph.state;
    expect(state?.compiledPlan?.contractIdentities["contract.review"]?.["1"]).toBe(
      ref.digest,
    );
    expect(state?.planBinding?.nodeBindings["plan"]).toEqual(ref);
  });

  it("refuses to run a declared graph: the missing-handler error, nothing dispatched", async () => {
    const dispatch = new CountingDispatch();
    const ts = new GraphToolSet({ dispatch });
    const declared = ts.graph_declare({ declaration: v3Declaration() });

    let caught: unknown;
    try {
      await ts.graph_run({ graph_id: "declared-graph" });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof OutcomeProtocolUnavailableError)) {
      throw new Error("expected OutcomeProtocolUnavailableError, got: " + String(caught));
    }
    expect(caught.graphId).toBe("declared-graph");
    expect(caught.planRevision).toBe(declared.plan_revision);
    expect(caught.message).toMatch(/no registered execution-protocol handler/);
    expect(caught.message).toMatch(/executionProtocolVersion 2/);
    // NO node was dispatched, and the legacy protocol was never substituted.
    expect(dispatch.calls).toBe(0);

    // dry_run refuses too (there is nothing this build can validate/run).
    await expect(
      ts.graph_run({ graph_id: "declared-graph", dry_run: true }),
    ).rejects.toThrow(/no registered execution-protocol handler/);
    expect(dispatch.calls).toBe(0);

    // The construction / observability surface refuses the same way.
    expect(() =>
      ts.graph_add_node({ graph_id: "declared-graph", id: "x", agent: "a", prompt: "p" }),
    ).toThrow(/no registered execution-protocol handler/);
    expect(() => ts.graph_status({ graph_id: "declared-graph" })).toThrow(
      /no registered execution-protocol handler/,
    );
    await expect(
      ts.graph_approve({
        graph_id: "declared-graph",
        node_id: "plan",
        action: "approve",
      }),
    ).rejects.toThrow(/no registered execution-protocol handler/);
    expect(dispatch.calls).toBe(0);
  });

  it("leaves a legacy v2 graph completely unaffected (its run still works)", async () => {
    const ts = new GraphToolSet({ dispatch: new CompletingDispatch() });
    const { graph_id } = ts.graph_create({ name: "legacy-graph" });
    ts.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });

    // A declared graph exists in the SAME toolset, and refuses to run.
    const declared = ts.graph_declare({ declaration: v3Declaration() });
    await expect(ts.graph_run({ graph_id: "declared-graph" })).rejects.toThrow(
      /no registered execution-protocol handler/,
    );

    // The legacy graph runs exactly as before: the node dispatches and completes.
    await ts.graph_run({ graph_id });
    await settle();
    const state = ts["getEntry"](graph_id).runtime.status();
    expect(state.phase).toBe("complete");
    expect(state.nodes.get("A")?.status).toBe("completed");

    // The declared graph is registered but still NOT runnable.
    expect(ts["declaredGraphs"].get("declared-graph")?.graph.plan.planRevision).toBe(
      declared.plan_revision,
    );
  });

  // ── C1-01: the id reservation must be DURABLE, not just in-memory ──────────

  it("reserves a PERSISTED declared id against graph_create in a fresh process", async () => {
    const stateDir = tempDir("graph-declare-reserve-");
    const first = createGraphToolSet({ stateDir });
    const declared = first.graph_declare({ declaration: v3Declaration() });
    const path = engineStatePath(stateDir, "declared-graph");
    const before = readFileSync(path, "utf-8");

    // A NEW process has an empty `declaredGraphs` map, so the reservation can
    // only come from the persisted record. Without it graph_create would return
    // the declared id and the first legacy save would replace the record
    // (execution protocol, compiled plan and plan binding all gone).
    const second = new GraphToolSet({
      dispatch: new CompletingDispatch(),
      stateDir,
    });
    const created = second.graph_create({ name: "declared-graph" });
    expect(created.graph_id).toBe("declared-graph-2");

    // Running the freshly created LEGACY graph writes its OWN file; the
    // declared record keeps its protocol, plan and binding byte for byte.
    second.graph_add_node({
      graph_id: created.graph_id,
      id: "A",
      agent: "a",
      prompt: "pA",
    });
    await second.graph_run({ graph_id: created.graph_id });
    await settle();

    expect(readFileSync(path, "utf-8")).toBe(before);
    const dto = JSON.parse(before) as {
      executionProtocolVersion?: number;
      compiledPlan?: { planRevision?: string };
      planBinding?: { planRevision?: string };
    };
    expect(dto.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(dto.compiledPlan?.planRevision).toBe(declared.plan_revision);
    expect(dto.planBinding?.planRevision).toBe(declared.plan_revision);
    expect(existsSync(engineStatePath(stateDir, "declared-graph-2"))).toBe(true);
  });

  it("reserves a declared id whose state-file slug collides with a legacy name", async () => {
    const stateDir = tempDir("graph-declare-slug-");
    const first = createGraphToolSet({ stateDir });
    const declared = first.graph_declare({
      declaration: { ...v3Declaration(), name: "a/b" },
    });
    const path = engineStatePath(stateDir, "a/b");
    const before = readFileSync(path, "utf-8");
    // "a b" slugs to the SAME file as "a/b", so the legacy id must not be
    // handed a name whose save would replace the declared record.
    expect(engineStatePath(stateDir, "a b")).toBe(path);

    const second = new GraphToolSet({
      dispatch: new CompletingDispatch(),
      stateDir,
    });
    const created = second.graph_create({ name: "a b" });
    expect(created.graph_id).toBe("a b-2");

    second.graph_add_node({
      graph_id: created.graph_id,
      id: "A",
      agent: "a",
      prompt: "pA",
    });
    await second.graph_run({ graph_id: created.graph_id });
    await settle();

    expect(readFileSync(path, "utf-8")).toBe(before);
    const dto = JSON.parse(before) as {
      executionProtocolVersion?: number;
      compiledPlan?: { planRevision?: string };
    };
    expect(dto.executionProtocolVersion).toBe(OUTCOME_PROTOCOL);
    expect(dto.compiledPlan?.planRevision).toBe(declared.plan_revision);
    expect(existsSync(engineStatePath(stateDir, "a b-2"))).toBe(true);
  });

  it("names the missing handler when a persisted declared graph is run after a restart", async () => {
    const stateDir = tempDir("graph-declare-restart-run-");
    const first = createGraphToolSet({ stateDir });
    const declared = first.graph_declare({ declaration: v3Declaration() });

    const dispatch = new CountingDispatch();
    const second = new GraphToolSet({ dispatch, stateDir });
    let caught: unknown;
    try {
      await second.graph_run({ graph_id: "declared-graph" });
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof OutcomeProtocolUnavailableError)) {
      throw new Error(
        "expected OutcomeProtocolUnavailableError, got: " + String(caught),
      );
    }
    expect(caught.planRevision).toBe(declared.plan_revision);
    expect(caught.message).toMatch(/no registered execution-protocol handler/);
    // The legacy signal protocol was never substituted: nothing dispatched.
    expect(dispatch.calls).toBe(0);
  });

  it("does NOT treat a persisted LEGACY record as a collision (same-id resume)", async () => {
    const stateDir = tempDir("graph-declare-legacy-resume-");
    const legacy = new GraphToolSet({
      dispatch: new CompletingDispatch(),
      stateDir,
    });
    const { graph_id } = legacy.graph_create({ name: "legacy-resume" });
    legacy.graph_add_node({ graph_id, id: "A", agent: "a", prompt: "pA" });
    await legacy.graph_run({ graph_id });
    await settle();
    expect(existsSync(engineStatePath(stateDir, "legacy-resume"))).toBe(true);

    // A legacy record this build can resume is NOT a reservation: a fresh
    // process re-creating the same name still resolves to the same id.
    const fresh = new GraphToolSet({
      dispatch: new CompletingDispatch(),
      stateDir,
    });
    expect(fresh.graph_create({ name: "legacy-resume" }).graph_id).toBe(
      "legacy-resume",
    );
  });
});

