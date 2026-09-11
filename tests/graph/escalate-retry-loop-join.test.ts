/**
 * Graph Execution Engine v2 — escalate-retry budget: loop-group member,
 * complementary angles (subtask 5 of the escalate-retry-bypass fix).
 *
 * The core loop-member contract — an escalating loop-group member routed
 * through `executeLoopStep` (loop-group-executor.ts) is re-dispatched within
 * its effective retry budget, then escalates terminally on exhaustion with
 * loop `traversalCount` accounting unchanged, and without failing a
 * downstream join-all while budget remains — is pinned by the rig-level test
 * in loop-group.test.ts ("loop-group member escalate — retry budget
 * honored") and the public-surface join test in
 * graph-retry-cap-semantics.test.ts (case (d)). This file adds the two
 * angles those suites do not cover:
 *
 *  (c2) TRAVERSAL PINNING AFTER CONSUMPTION — when the loop has ALREADY
 *      consumed a traversal (traversalCount 1) before the member starts
 *      escalating, the absorbed retries and the terminal exhaustion must not
 *      move that accounting (retries are node-level, not loop traversals).
 *  (c3) PUBLIC SURFACE — the same budgeted retry chain driven through
 *      `graph_add_loop` + `graph_run` + `graph_status(include_loops)`, pinning
 *      the tool-facing contract: `max_retries` on a loop member is honored
 *      end-to-end and loop traversals stay "0/N".
 *
 * Harness: the shared `ScriptedDispatchScript` seam
 * (tests/graph/helpers/scripted-dispatch.ts) for the public-surface test, and
 * the AdvanceEngine rig pattern (loop-group.test.ts) for the fine-grained
 * traversalCount assertions.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import { GraphToolSet } from "../../src/graph/tools/graph-tools.ts";
import { clearParentQueues } from "../../src/dispatch/notification.ts";
import { ScriptedDispatchScript, settle } from "./helpers/scripted-dispatch.ts";

// ── Rig dispatch seam (no auto-complete; driven by manual signals) ─────────

class RigDispatch implements NodeDispatchPort {
  calls: string[] = [];

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push(node.nodeId);
    return Promise.resolve(makeTask(node.nodeId));
  }

  /** How many times `nodeId` was dispatched. */
  dispatches(nodeId: string): number {
    return this.calls.filter((c) => c === nodeId).length;
  }
}

function makeTask(nodeId: string): DispatchTask {
  return {
    id: `task-${nodeId}-${Date.now()}-${Math.random()}`,
    sessionId: `sess-${nodeId}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: nodeId,
    prompt: nodeId,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * worker → convergence review loop (entry seeds impl; impl feeds review; review
 * either revises back to impl via the back-edge or converges forward to sink).
 * `impl` and `review` are the loop-group members. `maxRetries` (when given)
 * lands on impl's per-node budget — the effective escalate-retry budget.
 */
function reviewLoopGraph(maxTraversals: number, maxRetries?: number): GraphDeclaration {
  return {
    version: 2,
    name: "review-loop-retry",
    nodes: [
      { id: "entry", agent: "a0", prompt: "seed" },
      {
        id: "impl",
        agent: "a1",
        prompt: "implement",
        join: { strategy: "any" },
        ...(maxRetries !== undefined ? { budget: { max_retries: maxRetries } } : {}),
      },
      { id: "review", agent: "a2", prompt: "review" },
      { id: "sink", agent: "a3", prompt: "sink" },
    ],
    edges: [
      { from: "entry", to: "impl", type: "always" },
      { from: "impl", to: "review", type: "on_signal", signal_filter: ["answer"] },
      { from: "review", to: "impl", type: "on_signal", signal_filter: ["revise_needed"] },
      { from: "review", to: "sink", type: "on_signal", signal_filter: ["answer"] },
    ],
    loop_groups: [{ id: "lg", nodes: ["impl", "review"], max_traversals: maxTraversals }],
  };
}

// ── Rig ─────────────────────────────────────────────────────────────────────

interface Rig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: RigDispatch;
}

function buildRig(decl: GraphDeclaration): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const fake = new RigDispatch();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake };
}

// ── graph_status JSON helpers (public-surface test) ────────────────────────

interface StatusJson {
  phase: string;
  nodes: Array<{
    node_id: string;
    status: string;
    retry_count: number;
  }>;
}

function statusJson(ts: GraphToolSet, graphId: string): StatusJson {
  return JSON.parse(ts.graph_status({ graph_id: graphId, format: "json" })) as StatusJson;
}

function nodeStatus(
  ts: GraphToolSet,
  graphId: string,
  nodeId: string,
): StatusJson["nodes"][number] {
  const node = statusJson(ts, graphId).nodes.find((n) => n.node_id === nodeId);
  if (!node) throw new Error(`graph_status: node "${nodeId}" missing`);
  return node;
}

// ═══════════════════════════════════════════════════════════════════════════
// (c2) Traversal pinning — retries must not move already-consumed accounting
// ═══════════════════════════════════════════════════════════════════════════

describe("escalate-retry budget — loop-member traversal accounting", () => {
  it("escalating retries after a consumed traversal keep traversalCount pinned at 1; exhaustion leaves it unchanged", async () => {
    const { state, engine, fake } = buildRig(reviewLoopGraph(5, 2));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1"); // forward to review
    // review revises → traversal 0→1; impl re-entered and re-dispatched.
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["fix 1"] });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    expect(fake.dispatches("impl")).toBe(2); // initial + revise re-entry

    // impl now escalates: retries are node-level — the group's traversal
    // accounting must NOT move while the retry budget is consumed.
    await engine.onNodeSignalEmitted("impl", "escalate", { reason: "boom-1" });
    expect(state.nodes.get("impl")!.retryCount).toBe(1);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    await engine.onNodeSignalEmitted("impl", "escalate", { reason: "boom-2" });
    expect(state.nodes.get("impl")!.retryCount).toBe(2);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    await engine.onNodeSignalEmitted("impl", "escalate", { reason: "boom-3" });
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("impl")!.retryCount).toBe(2);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1); // still pinned
    expect(fake.dispatches("impl")).toBe(4); // initial + revise re-entry + 2 retries
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c3) Public surface — graph_add_loop + graph_run + graph_status(include_loops)
// ═══════════════════════════════════════════════════════════════════════════

describe("escalate-retry budget — loop member, public tool surface", () => {
  beforeEach(() => {
    clearParentQueues();
  });

  it("a loop member with max_retries 2 escalates 3× total (initial + 2 retries) then terminally; loop traversals stay 0/5", async () => {
    const fake = new ScriptedDispatchScript((nodeId) =>
      nodeId === "impl" ? "error" : "completed",
    );
    const ts = new GraphToolSet({ dispatch: fake });
    const g = ts.graph_create({ name: "loop-member-retry-e2e" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "entry", agent: "e", prompt: "seed" });
    ts.graph_add_node({
      graph_id: g.graph_id,
      id: "impl",
      agent: "i",
      prompt: "implement",
      join: { strategy: "any" },
      max_retries: 2,
    });
    ts.graph_add_node({ graph_id: g.graph_id, id: "review", agent: "r", prompt: "review" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "sink", agent: "s", prompt: "sink" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "entry", to: "impl", type: "always" });
    ts.graph_add_edge({
      graph_id: g.graph_id,
      from: "impl",
      to: "review",
      type: "on_signal",
      signal_filter: ["answer"],
    });
    ts.graph_add_edge({
      graph_id: g.graph_id,
      from: "review",
      to: "impl",
      type: "on_signal",
      signal_filter: ["revise_needed"],
    });
    ts.graph_add_edge({
      graph_id: g.graph_id,
      from: "review",
      to: "sink",
      type: "on_signal",
      signal_filter: ["answer"],
    });
    ts.graph_add_loop({
      graph_id: g.graph_id,
      id: "lg",
      nodes: ["impl", "review"],
      max_traversals: 5,
    });

    await ts.graph_run({ graph_id: g.graph_id });
    await settle();
    await settle();
    await settle(); // let the automatic retry chain (impl ×3) drain

    // Effective budget 2 → exactly 3 dispatches (initial + 2 automatic retries),
    // then the 3rd escalate is terminal — no 4th dispatch.
    expect(fake.dispatches("impl")).toBe(3);
    const impl = nodeStatus(ts, g.graph_id, "impl");
    expect(impl.retry_count).toBe(2);
    expect(impl.status).toBe(NodeStatus.Escalate);
    // The loop partner was never activated (impl never answered) and the
    // escalating retries consumed ZERO loop traversals.
    expect(nodeStatus(ts, g.graph_id, "entry").status).toBe(NodeStatus.Completed);
    expect(nodeStatus(ts, g.graph_id, "review").status).toBe(NodeStatus.Pending);
    const out = JSON.parse(
      ts.graph_status({ graph_id: g.graph_id, format: "json", include_loops: true }),
    ) as { phase: string; loops: Array<{ loop_id: string; traversals: string }> };
    const lg = out.loops.find((l) => l.loop_id === "lg");
    expect(lg?.traversals).toBe("0/5");
    // entry completed + impl escalated, review/sink never activated → executing.
    expect(out.phase).toBe(EnginePhase.Executing);
  });
});
