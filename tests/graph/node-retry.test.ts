/**
 * Graph Execution Engine v2 — Node Retry (`retryNode` / `resetNodeForRetry`)
 *
 * Phase 4 finishing round. Exercises the retry surface that backs
 * `graph_run(node_id, retry=true, modify_prompt=...)` (tool-merge-map.md §2.2):
 *
 * - {@link resetNodeForRetry} (pure) — target + downstream reset to `pending`,
 *   `modify_prompt` prepended, target re-`ready`/frontier, terminal phase re-opened,
 *   counters preserved.
 * - M11 retry guard — retrying a `running` / `blocked` node (target or any
 *   downstream) is REJECTED before any mutation (no session leak); repeated
 *   `modify_prompt` is replace-style deduplicated (no unbounded prompt growth);
 *   superseded `onTaskTerminated` subscriptions are unregistered + dropped.
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
import {
  markCompleted,
  markEscalated,
  markNodeBlocked,
  markReady,
  markRunning,
} from "../../src/graph/engine/node-lifecycle.ts";
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
    /** nodeIds whose tasks stay running forever (never auto-fired). */
    private readonly hold: Set<string> = new Set(),
  ) {}

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, prompt: node.prompt });
    const id = `task-${node.nodeId}-${++this.seq}`;
    const task = makeTask(id, node);
    // Fire the terminal transition after subscribeTaskTermination registers the
    // listener (a macrotask guarantees ordering) — unless the node is held.
    setTimeout(() => {
      if (this.hold.has(node.nodeId)) return; // stays running
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

  it("drops the graph-level signal ledger entry for the target and every reset downstream node", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    const C = state.nodes.get("C")!;

    // Force a terminal graph: B escalated, C escalated, phase complete.
    markEscalated(state, B, "boom");
    markEscalated(state, C, "boom");
    state.phase = EnginePhase.Complete as EnginePhase;

    // Seed the graph-level ledger with pre-retry signal history / lastSignalAt
    // for B and C (the dual-write `signal-bridge.ts:record` path a real run uses).
    const bridge = new SignalBridge();
    bridge.record(state, "B", "progress", 0.5);
    bridge.record(state, "B", "answer", { note: "first run" });
    bridge.record(state, "C", "answer", { note: "first run" });
    expect(state.signalLedger.get("B")!.history!.length).toBe(2);
    expect(state.signalLedger.get("B")!.lastSignalAt).toBeGreaterThan(0);
    expect(state.signalLedger.get("C")!.history!.length).toBe(1);
    expect(state.signalLedger.get("C")!.lastSignalAt).toBeGreaterThan(0);

    resetNodeForRetry(state, "B", { modifyPrompt: "redo" });

    // The reset nodes no longer carry pre-retry stale history / lastSignalAt in
    // the graph-level ledger — consistent with their cleared signalsObserved.
    expect(state.signalLedger.has("B")).toBe(false);
    expect(state.signalLedger.has("C")).toBe(false);
    expect(B.signalsObserved).toEqual({});
    expect(C.signalsObserved).toEqual({});
    // A (untouched upstream) never emitted — still absent from the ledger.
    expect(state.signalLedger.has("A")).toBe(false);
  });

  it("rejects retry of a running target before mutating anything (M11 state guard)", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    // B is Running with a live dispatch task.
    markReady(state, B);
    markRunning(state, B, {
      dispatchTaskId: "task-B-1",
      dispatchSessionId: "sess-B-1",
    });
    expect(B.status).toBe(NodeStatus.Running);
    const phaseBefore = state.phase;

    expect(() =>
      resetNodeForRetry(state, "B", { modifyPrompt: "redo" }),
    ).toThrow(/live node\(s\) in the retry scope/);
    expect(() =>
      resetNodeForRetry(state, "B", { modifyPrompt: "redo" }),
    ).toThrow(/running/);

    // Nothing was mutated: still running with the same task, prompt and
    // counters untouched, phase unchanged — a rejected retry is a no-op.
    expect(B.status).toBe(NodeStatus.Running);
    expect(B.dispatchTaskId).toBe("task-B-1");
    expect(B.dispatchSessionId).toBe("sess-B-1");
    expect(B.prompt).toBe("pB");
    expect(B.retryCount).toBe(0);
    expect(B.signalsObserved).toEqual({});
    expect(state.phase).toBe(phaseBefore);
    // Downstream untouched too.
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Pending);
  });

  it("rejects retry when a downstream node is running (M11 scope guard)", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    const C = state.nodes.get("C")!;
    // B is terminal (completed) but its downstream C is still mid-execution.
    markReady(state, B);
    markRunning(state, B, { dispatchTaskId: "task-B-1" });
    markCompleted(state, B, {
      result: { sidecarPath: "/tmp/t", totalChars: 1, hadFence: false, materializedAt: 1 },
    });
    markReady(state, C);
    markRunning(state, C, {
      dispatchTaskId: "task-C-1",
      dispatchSessionId: "sess-C-1",
    });
    expect(B.status).toBe(NodeStatus.Completed);

    expect(() => resetNodeForRetry(state, "B")).toThrow(/"C" \(running\)/);

    // The terminal target and the running downstream are both untouched.
    expect(B.status).toBe(NodeStatus.Completed);
    expect(B.prompt).toBe("pB");
    expect(B.retryCount).toBe(0);
    expect(C.status).toBe(NodeStatus.Running);
    expect(C.dispatchTaskId).toBe("task-C-1");
  });

  it("rejects retry of a blocked (HITL) target (M11 state guard)", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    markReady(state, B);
    markRunning(state, B, { dispatchTaskId: "task-B-1" });
    markNodeBlocked(state, B);
    expect(B.status).toBe(NodeStatus.Blocked);

    expect(() => resetNodeForRetry(state, "B")).toThrow(/blocked/);
    expect(B.status).toBe(NodeStatus.Blocked);
    expect(B.prompt).toBe("pB");
    expect(B.retryCount).toBe(0);
  });

  it("re-applying the same modify_prompt does not accumulate (M11 replace-dedup)", () => {
    const { state } = buildAdvance(linearABC());
    const B = state.nodes.get("B")!;
    markEscalated(state, B, "boom");
    state.phase = EnginePhase.Complete as EnginePhase;

    // First retry prepends the block once.
    resetNodeForRetry(state, "B", { modifyPrompt: "redo" });
    expect(B.prompt).toBe("redo\n\npB");
    expect(B.retryCount).toBe(1);

    // Terminal again, retry with the SAME block — no second copy.
    markEscalated(state, B, "boom again");
    resetNodeForRetry(state, "B", { modifyPrompt: "redo" });
    expect(B.prompt).toBe("redo\n\npB"); // NOT "redo\n\nredo\n\npB"
    expect(B.retryCount).toBe(2);

    // A DIFFERENT modify_prompt prepends on top (the latest instruction wins),
    // but the previously-injected block is not duplicated by this call.
    resetNodeForRetry(state, "B", { modifyPrompt: "redo harder" });
    expect(B.prompt).toBe("redo harder\n\nredo\n\npB");
    expect(B.retryCount).toBe(3);
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

  it("rejects retryNode on a running node without re-dispatching it (M11 guard)", async () => {
    const { state, engine, fake } = buildAdvance(linearABC());
    // Dispatch the root A — FakeDispatch resolves the task but never fires a
    // terminal transition, so A stays Running with a live dispatch task.
    await engine.dispatchReady();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    const aDispatchesBefore = fake.calls.filter((c) => c.nodeId === "A").length;

    await expect(engine.retryNode("A", { modifyPrompt: "redo" })).rejects.toThrow(
      /running/,
    );

    // No re-dispatch, no state mutation, no session leak.
    expect(fake.calls.filter((c) => c.nodeId === "A").length).toBe(aDispatchesBefore);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("A")!.prompt).toBe("pA");
    expect(state.nodes.get("A")!.retryCount).toBe(0);
    expect(state.phase).toBe(EnginePhase.Executing);
  });
});

// ── AdvanceEngine.retryNode — M11 dedup & subscription cleanup (dispatch-driven) ──

/** FiringDispatch + the optional `removeTaskTerminatedListener` removal surface. */
class RemovingFiringDispatch extends FiringDispatch {
  removals: Array<{ taskId: string; callback: TaskTerminatedCallback }> = [];
  removeTaskTerminatedListener(
    taskId: string,
    callback: TaskTerminatedCallback,
  ): void {
    this.removals.push({ taskId, callback });
  }
}

/** Build an AdvanceEngine over a dispatch seam that auto-completes tasks. */
function buildFiringAdvance(fake: FiringDispatch, name = "g-fire") {
  const state = createEngineState(linearABC(), name);
  provision(state);
  const engine = new AdvanceEngine({
    state,
    signalBridge: new SignalBridge(),
    dispatch: fake,
  });
  return { state, engine, fake };
}

describe("AdvanceEngine.retryNode — modify_prompt dedup & superseded-subscription cleanup", () => {
  it("repeated retries with the same modify_prompt keep a single injected block", async () => {
    const { state, engine } = buildFiringAdvance(new FiringDispatch());

    // Run the whole chain A → B → C to completion via the dispatch seam.
    await engine.dispatchReady();
    await settle();
    await settle();
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Completed);

    // Retry #1 prepends the block once.
    await engine.retryNode("B", { modifyPrompt: "fix it" });
    expect(state.nodes.get("B")!.prompt).toBe("fix it\n\npB");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // Let the retried B re-complete and C re-run to quiescence.
    await settle();
    await settle();
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Completed);

    // Retry #2 with the SAME block — no accumulation (M11 replace-dedup).
    await engine.retryNode("B", { modifyPrompt: "fix it" });
    expect(state.nodes.get("B")!.prompt).toBe("fix it\n\npB"); // NOT "fix it\n\nfix it\n\npB"
    expect(state.nodes.get("B")!.retryCount).toBe(2);
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("retry unregisters the superseded task's onTaskTerminated subscription (M11 zombie cleanup)", async () => {
    const fake = new RemovingFiringDispatch();
    const { state, engine } = buildFiringAdvance(fake);

    // Run the chain to completion — B and C each registered a subscription.
    await engine.dispatchReady();
    await settle();
    await settle();
    expect(state.phase).toBe(EnginePhase.Complete);
    const subsBefore = engine.getTerminationSubscriptions();
    const bSub = subsBefore.find((s) => s.taskId.startsWith("task-B-"));
    const cSub = subsBefore.find((s) => s.taskId.startsWith("task-C-"));
    expect(bSub).toBeDefined();
    expect(cSub).toBeDefined();

    await engine.retryNode("B", { modifyPrompt: "fix it" });

    // The superseded B + C subscriptions were unregistered from the port...
    expect(fake.removals.some((r) => r.taskId === bSub!.taskId)).toBe(true);
    expect(fake.removals.some((r) => r.taskId === cSub!.taskId)).toBe(true);
    // ...and dropped from the ledger; B's fresh re-dispatch task keeps its own.
    const subsAfter = engine.getTerminationSubscriptions();
    expect(subsAfter.some((s) => s.taskId === bSub!.taskId)).toBe(false);
    expect(subsAfter.some((s) => s.taskId === cSub!.taskId)).toBe(false);
    expect(subsAfter.some((s) => s.taskId.startsWith("task-B-"))).toBe(true);
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

function makeToolset(): { ts: GraphToolSet; fake: FiringDispatch } {
  // R is held running forever (never auto-completes) so `run()` only ever
  // dispatches R; the retried sink A auto-completes between retries, keeping
  // every retry target terminal (M11 guard: retry requires a quiescent node).
  const fake = new FiringDispatch(() => "completed", new Set(["R"]));
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
    // Let the retried A complete so the next retry sees a terminal target
    // (M11 guard refuses retrying a still-running node).
    await settle();

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
