/**
 * Graph Execution Engine v2 — Node Retry (`retryNode` / `resetNodeForRetry`)
 *
 * Phase 4 finishing round. Exercises the retry surface that backs
 * `graph_run(node_id, retry=true, modify_prompt=...)` (tool-merge-map.md §2.2):
 *
 * - {@link resetNodeForRetry} (pure) — target + downstream reset to `pending`,
 *   `modify_prompt` prepended, target re-`ready`/frontier, terminal phase re-opened,
 *   counters preserved.
 * - `AdvanceEngine.retryNode` — failed node re-dispatches on retry; downstream
 *   states reset; `modify_prompt` prepended.
 * - `EngineRuntime.retryNode` — the public method exists and drives a real
 *   re-dispatch end-to-end.
 * - `GraphToolSet.graph_run` — no longer returns `retry_pending`; returns a
 *   `retry` report and re-dispatches the target via an injected dispatch seam.
 */

import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type {
  EngineState,
  NodeRuntimeState,
} from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type {
  DispatchParentContext,
  TaskTerminatedCallback,
} from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngine,
  type EngineRuntime,
} from "../../src/graph/engine/index.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import { resetNodeForRetry } from "../../src/graph/engine/node-retry.ts";
import { markEscalated } from "../../src/graph/engine/node-lifecycle.ts";
import {
  GraphToolSet,
  type GraphToolSetDeps,
} from "../../src/graph/tools/graph-tools.ts";

// ── Fake dispatch seam ─────────────────────────────────────────────────────

/** Records dispatched nodes; never touches the dispatch subsystem. */
class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];
  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, agent: node.agent, prompt: node.prompt });
    return Promise.resolve(makeTask(`task-${node.nodeId}-${this.calls.length}`, node));
  }
}

/**
 * Fake dispatch that also closes the dispatch→signal delivery seam: after a
 * node's launch it fires a terminal status through `onTaskTerminated`, mapping to
 * `answer` (completed) or `escalate` (error) — driving the engine exactly like a
 * live DispatchBridge but deterministically.
 */
class FiringDispatch implements NodeDispatchPort {
  calls: { nodeId: string; prompt: string }[] = [];
  private subs = new Map<string, TaskTerminatedCallback>();
  private seq = 0;
  constructor(
    private behavior: (nodeId: string) => "completed" | "error" = () => "completed",
  ) {}

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task = makeTask(id, node);
    // Fire the terminal transition after subscribeTaskTermination registers the
    // listener (a macrotask guarantees ordering).
    setTimeout(() => {
      const cb = this.subs.get(id);
      if (cb) cb(id, this.behavior(node.nodeId));
    }, 0);
    return Promise.resolve(task);
  }

  onTaskTerminated(taskId: string, cb: TaskTerminatedCallback): TaskTerminatedCallback {
    this.subs.set(taskId, cb);
    return cb;
  }
}

function makeTask(id: string, node: NodeRuntimeState): DispatchTask {
  return {
    id,
    sessionId: `sess-${id}`,
    parentSessionId: "g-1",
    depth: 1,
    status: "running",
    agent: node.agent,
    prompt: node.prompt,
    startedAt: new Date(),
    progress: { lastUpdate: new Date(), toolCalls: 0 },
    priority: 0,
  };
}

/** Let async terminal transitions (setTimeout) settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A → B → C, every edge `always`. */
function linearABC(): GraphDeclaration {
  return {
    version: 2,
    name: "abc",
    nodes: [
      { id: "A", agent: "a", prompt: "pA" },
      { id: "B", agent: "b", prompt: "pB" },
      { id: "C", agent: "c", prompt: "pC" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "C", type: "always" },
    ],
  };
}

/** A → B (B is a sink, fails on error). */
function linearAB(): GraphDeclaration {
  return {
    version: 2,
    name: "ab",
    nodes: [
      { id: "A", agent: "a", prompt: "pA" },
      { id: "B", agent: "b", prompt: "pB" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

interface AdvanceRig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
}

function buildAdvance(decl: GraphDeclaration, fake = new FakeDispatch()): AdvanceRig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const engine = new AdvanceEngine({ state, signalBridge: new SignalBridge(), dispatch: fake });
  return { state, engine, fake };
}

// ── Pure primitive: resetNodeForRetry ──────────────────────────────────────

describe("resetNodeForRetry (pure state mutation)", () => {
  it("resets the target + downstream to pending, prepends modify_prompt, re-opens phase, preserves counters", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    const C = state.nodes.get("C")!;

    // Force a terminal graph: B escalated, C escalated, phase complete.
    markEscalated(state, B, "boom");
    markEscalated(state, C, "boom");
    B.retryCount = 2;
    B.sessionsSpawned = 4;
    B.result = {
      sidecarPath: "/tmp/t",
      totalChars: 3,
      hadFence: false,
      materializedAt: Date.now(),
    };
    B.signalsObserved = { escalate: "boom" };
    state.phase = EnginePhase.Complete as EnginePhase;

    const report = resetNodeForRetry(state, "B", { modifyPrompt: "redo" });

    // Target reset → re-ready for dispatch, prompt prepended.
    expect(B.status).toBe(NodeStatus.Ready);
    expect(B.prompt).toBe("redo\n\npB");
    expect(B.signalsObserved).toEqual({});
    expect(B.result).toBeUndefined();
    expect(B.errorReason).toBeUndefined();
    // Counters survive the reset.
    expect(B.retryCount).toBe(3); // incremented
    expect(B.sessionsSpawned).toBe(4); // preserved
    // Downstream (C) reset to pending.
    expect(C.status).toBe(NodeStatus.Pending);
    expect(C.errorReason).toBeUndefined();
    // Report shape.
    expect(report.target).toBe("B");
    expect(report.reset).toContain("B");
    expect(report.reset).toContain("C");
    expect(report.ready).toEqual(["B"]);
    // Terminal phase re-opened to executing.
    expect((state.phase as EnginePhase)).toBe(EnginePhase.Executing as EnginePhase);
    // A (upstream of B, a root) is untouched by the retry — still ready from provision.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Ready);
  });

  it("throws for an unknown node id", () => {
    const { state } = buildAdvance(linearABC());
    expect(() => resetNodeForRetry(state, "NOPE")).toThrow(/Unknown node id/);
  });
});

// ── AdvanceEngine.retryNode: behavioral core ───────────────────────────────

describe("AdvanceEngine.retryNode", () => {
  it("re-dispatches a failed (escalated) node and resets its downstream", async () => {
    const { state, engine, fake } = buildAdvance(linearABC());
    // Run to completion: A → B → C all answer.
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "ra");
    await engine.onNodeSignalEmitted("B", "answer", "rb");
    await engine.onNodeSignalEmitted("C", "answer", "rc");
    expect(state.phase).toBe(EnginePhase.Complete);
    const bCallsBefore = fake.calls.filter((c) => c.nodeId === "B").length;

    // Retry B with a modified prompt.
    const report = await engine.retryNode("B", { modifyPrompt: "fix it" });

    const B = state.nodes.get("B")!;
    const C = state.nodes.get("C")!;
    // B re-dispatched (running) with the prepended prompt.
    expect(B.status).toBe(NodeStatus.Running);
    expect(B.prompt).toBe("fix it\n\npB");
    expect(B.signalsObserved).toEqual({});
    // B was re-dispatched exactly once more.
    const bCallsAfter = fake.calls.filter((c) => c.nodeId === "B").length;
    expect(bCallsAfter).toBe(bCallsBefore + 1);
    expect(report.reDispatched).toBe(1);
    // Downstream C reset to pending (was completed/done), stale run state cleared.
    expect(C.status).toBe(NodeStatus.Pending);
    expect(C.signalsObserved).toEqual({});
    expect(C.result).toBeUndefined();
    // Terminal phase re-opened to executing (B is now running again).
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("re-dispatches without modify_prompt when only retrying", async () => {
    const { state, engine, fake } = buildAdvance(linearAB());
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "ra");
    // B answers once → both terminal, graph complete.
    await engine.onNodeSignalEmitted("B", "answer", "rb");
    expect(state.phase).toBe(EnginePhase.Complete);
    const before = fake.calls.filter((c) => c.nodeId === "B").length;

    const report = await engine.retryNode("B");

    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.prompt).toBe("pB"); // unchanged (no modify_prompt)
    expect(fake.calls.filter((c) => c.nodeId === "B").length).toBe(before + 1);
    expect(report.reDispatched).toBe(1);
    expect(state.phase).toBe(EnginePhase.Executing);
  });
});

// ── EngineRuntime.retryNode (public method) ────────────────────────────────

describe("EngineRuntime.retryNode", () => {
  it("exposes retryNode and re-dispatches a failed node end-to-end", async () => {
    const fake = new FiringDispatch((id) => (id === "B" ? "error" : "completed"));
    const runtime = createEngine(linearAB(), { dispatch: fake, graphId: "g-rt" });

    await runtime.run();
    await settle(); // A completes → B dispatched & escalates → phase complete

    const beforeRun = runtime.status();
    expect(beforeRun.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(beforeRun.phase).toBe(EnginePhase.Complete);

    const bDispatchesBefore = fake.calls.filter((c) => c.nodeId === "B").length;
    const report = await runtime.retryNode("B", { modifyPrompt: "retry harder" });
    // Synchronously after retryNode resolves, B is re-dispatched into `running`
    // (its error re-fire is scheduled async via setTimeout).
    const mid = runtime.status();
    expect(report.reDispatched).toBeGreaterThanOrEqual(1);
    expect(report.target).toBe("B");
    expect(fake.calls.filter((c) => c.nodeId === "B").length).toBe(bDispatchesBefore + 1);
    expect(mid.nodes.get("B")!.prompt).toBe("retry harder\n\npB");
    expect(mid.nodes.get("B")!.status).toBe(NodeStatus.Running);
    // Terminal phase re-opened to executing.
    expect((mid.phase as EnginePhase)).toBe(EnginePhase.Executing as EnginePhase);
  });
});

// ── GraphToolSet.graph_run wiring ──────────────────────────────────────────

function makeToolset(): { ts: GraphToolSet; fake: FakeDispatch } {
  const fake = new FakeDispatch();
  const deps: GraphToolSetDeps = { dispatch: fake };
  return { ts: new GraphToolSet(deps), fake };
}

describe("graph_run retry wiring", () => {
  it("does not return retry_pending and re-dispatches a handled node retry", async () => {
    const { ts, fake } = makeToolset();
    const g = ts.graph_create({ name: "rt" });
    // R → A. A is a non-root sink, so `run()` only ever dispatches R; retrying A
    // dispatches A exactly once (no double dispatch with the run() kickoff).
    ts.graph_add_node({ graph_id: g.graph_id, id: "R", agent: "r", prompt: "pR" });
    ts.graph_add_node({ graph_id: g.graph_id, id: "A", agent: "a", prompt: "pA" });
    ts.graph_add_edge({ graph_id: g.graph_id, from: "R", to: "A", type: "always" });

    const r1 = await ts.graph_run({ graph_id: g.graph_id });
    // retry_pending is gone from the result (field removed).
    expect(r1).not.toHaveProperty("retry_pending");
    expect(r1.active_nodes).toContain("R");

    // Handled retry: node_id + retry → re-dispatch, report present, no pending flag.
    const before = fake.calls.filter((c) => c.nodeId === "A").length;
    expect(before).toBe(0); // A never dispatched by run() (waiting on R)
    const r2 = await ts.graph_run({ graph_id: g.graph_id, node_id: "A", retry: true });
    expect(r2).not.toHaveProperty("retry_pending");
    expect(r2.retry).toBeDefined();
    expect(r2.retry!.node_id).toBe("A");
    expect(r2.retry!.re_dispatched).toBeGreaterThan(0);
    expect(fake.calls.filter((c) => c.nodeId === "A").length).toBe(before + 1);

    // modify_prompt alone also triggers the retry path and prepends the prompt.
    const r3 = await ts.graph_run({
      graph_id: g.graph_id,
      node_id: "A",
      modify_prompt: "redo",
    });
    expect(r3).not.toHaveProperty("retry_pending");
    expect(r3.retry!.node_id).toBe("A");
    expect(r3.retry!.re_dispatched).toBeGreaterThan(0);
    expect(fake.calls.at(-1)!.prompt.startsWith("redo")).toBe(true);

    // A plain run (no node_id) stays retry-free.
    const r4 = await ts.graph_run({ graph_id: g.graph_id });
    expect(r4).not.toHaveProperty("retry_pending");
    expect(r4.retry).toBeUndefined();
  });
});
