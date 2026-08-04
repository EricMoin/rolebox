import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask, DispatchTaskStatus, MaterializedResultRef } from "../../src/dispatch/types.ts";
import type { DispatchParentContext, TaskTerminatedCallback } from "../../src/graph/engine/dispatch-bridge.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
  type NodeCompletionEvent,
  type GraphBudgetPort,
  type GraphTerminalEvent,
} from "../../src/graph/engine/engine-advance.ts";
import { mergeFanInContext } from "../../src/graph/engine/join-evaluator.ts";

// ── Controllable fake dispatch port ────────────────────────────────────────

/**
 * Fake dispatch seam: records dispatched nodes and can hold a specific node's
 * launch on a manually-released promise. This lets tests pause the advancement
 * critical section mid-flight to exercise the re-entrancy guard without ever
 * dispatching a real sub-agent.
 */
class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string; parentSession: string }[] = [];
  private held = new Set<string>();
  private releasers = new Map<string, Array<() => void>>();

  hold(nodeId: string): void {
    this.held.add(nodeId);
  }
  release(nodeId: string): void {
    this.held.delete(nodeId);
    const rs = this.releasers.get(nodeId) ?? [];
    this.releasers.delete(nodeId);
    for (const r of rs) r();
  }

  executeNode(
    node: NodeRuntimeState,
    parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({
      nodeId: node.nodeId,
      agent: node.agent,
      prompt: node.prompt,
      parentSession: parentContext.sessionID,
    });
    if (this.held.has(node.nodeId)) {
      return new Promise<DispatchTask>((resolve) => {
        const rs = this.releasers.get(node.nodeId) ?? [];
        rs.push(() => resolve(makeTask(node.nodeId)));
        this.releasers.set(node.nodeId, rs);
      });
    }
    return Promise.resolve(makeTask(node.nodeId));
  }
}

function makeTask(nodeId: string): DispatchTask {
  return {
    id: `task-${nodeId}`,
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

// ── Fixtures ───────────────────────────────────────────────────────────────

/** 2-node linear graph: A → B. */
function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "A", to: "B", type: "always" }],
  };
}

/** Root fans out into two independent chains (for concurrent-signal re-entrancy). */
function twoBranchesGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "two-branches",
    nodes: [
      { id: "R", agent: "a0", prompt: "r" },
      { id: "B", agent: "a1", prompt: "b" },
      { id: "C", agent: "a2", prompt: "c" },
      { id: "LB", agent: "a3", prompt: "lb" },
      { id: "LC", agent: "a4", prompt: "lc" },
    ],
    edges: [
      { from: "R", to: "B", type: "always" },
      { from: "R", to: "C", type: "always" },
      { from: "B", to: "LB", type: "always" },
      { from: "C", to: "LC", type: "always" },
    ],
  };
}

interface TestRig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
  bridge: SignalBridge;
}

function buildEngine(decl: GraphDeclaration, fake = new FakeDispatch()): TestRig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake, bridge };
}

// ── (a) Linear flow: signal → downstream ready → dispatch → complete ───────

describe("linear graph A→B", () => {
  it("dispatches B on A's answer, then completes on B's answer", async () => {
    const { state, engine, fake } = buildEngine(linearGraph());

    // Kickoff: dispatch the ready root A.
    await engine.dispatchReady();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);

    // A answers → engine transitions A, routes payload to B, marks B ready + dispatches it.
    await engine.onNodeSignalEmitted("A", "answer", "result-A");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A", "B"]);
    // B's join satisfied and the upstream payload recorded.
    expect(state.nodes.get("B")!.joinSatisfied).toBe(true);
    expect(state.nodes.get("B")!.upstreamResults.get("A")!.fromSignal).toBe("answer");
    expect(state.nodes.get("B")!.upstreamResults.get("A")!.result).toBe("result-A");

    // B (sink) answers → B completes, no active nodes remain → graph complete.
    await engine.onNodeSignalEmitted("B", "answer", "result-B");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Completed);
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
  });
});

// ── (b) Re-entrancy: only one critical section; deferred completion drained ─

describe("re-entrancy guard", () => {
  it("defers a concurrent signal and drains it in the finally block", async () => {
    const { state, engine, fake } = buildEngine(twoBranchesGraph());

    // Kickoff root, then dispatch both branches (B and C) by answering R.
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["R", "B", "C"]);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);

    // Hold LB's launch so B's advancement critical section stays open.
    fake.hold("LB");
    const pB = engine.onNodeSignalEmitted("B", "answer", "from-B");

    // While B's critical section is open (lock held, pB pending), C emits its
    // signal concurrently — it must be deferred, not processed.
    await engine.onNodeSignalEmitted("C", "answer", "from-C");
    expect(state.advancingLock).toBe(true); // exactly one critical section active
    expect(state.pendingCompletions).toEqual(["C"]);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running); // deferred, untouched
    expect(state.nodes.get("LC")!.status).toBe(NodeStatus.Pending); // not yet dispatched

    // Release the held launch → B's section exits, finally drains C's deferred signal.
    fake.release("LB");
    await pB;

    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Completed); // drained & processed
    expect(state.nodes.get("LB")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("LC")!.status).toBe(NodeStatus.Running);
    expect(state.phase).toBe(EnginePhase.Executing); // leaves still running → not complete
  });
});

// ── (c) Engine phase tracking: idle → executing → complete ─────────────────

describe("engine phase tracking", () => {
  it("walks idle → executing → complete across the signal flow", async () => {
    const { state, engine } = buildEngine(linearGraph());

    expect(state.phase).toBe(EnginePhase.Idle);

    await engine.dispatchReady();
    expect(state.phase).toBe(EnginePhase.Executing);

    await engine.onNodeSignalEmitted("A", "answer", "x");
    expect(state.phase).toBe(EnginePhase.Executing); // B still running

    await engine.onNodeSignalEmitted("B", "answer", "y");
    expect(state.phase).toBe(EnginePhase.Complete);
  });
});

// ── Supporting: signal semantics ───────────────────────────────────────────

describe("signal semantics", () => {
  it("ignores non-terminating progress signals (record only, no advancement)", async () => {
    const { state, engine, fake } = buildEngine(linearGraph());
    await engine.dispatchReady();

    await engine.onNodeSignalEmitted("A", "progress", "working...");
    // Recorded in the ledger but no state transition, no downstream dispatch.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("A")!.signalsObserved["progress"]).toBe("working...");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Pending);
    expect(fake.calls.length).toBe(1); // only the initial A dispatch
  });

  it("escalate transitions the node to escalated and never completes the graph", async () => {
    const { state, engine } = buildEngine(linearGraph());
    await engine.dispatchReady();

    await engine.onNodeSignalEmitted("A", "escalate", { reason: "boom" });
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("A")!.errorReason).toBe("boom");
    // A escalated, B still pending → an active node remains → not complete.
    expect(state.phase).toBe(EnginePhase.Executing);
  });
});

// ── Result capture: node.result populated from dispatch task ───────────────

/** Fake dispatch that also stores a materialized result for `getTask`. */
class ResultCaptureFake implements NodeDispatchPort {
  private result?: MaterializedResultRef;
  /** Dispatch task status — defaults to "running" so the post-dispatch
   *  race-condition guard (getTask re-read) sees a live task.  Tests that
   *  simulate termination (e.g. via onNodeSignalEmitted) can set this to
   *  "completed" before result capture is checked. */
  status: DispatchTaskStatus = "running";
  setResult(ref: MaterializedResultRef): void {
    this.result = ref;
  }
  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    const task: DispatchTask = {
      id: `task-${node.nodeId}`,
      sessionId: `sess-${node.nodeId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
    if (this.result) {
      task.result = { ...this.result };
    }
    return Promise.resolve(task);
  }
  getTask(_taskId: string): DispatchTask | undefined {
    // Return a task snapshot whose `.result` mirrors the fake's state,
    // so _captureNodeResult can read it.
    if (!this.result) return undefined;
    return {
      id: _taskId,
      sessionId: "sess-x",
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: "fake",
      prompt: "fake",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
      result: { ...this.result },
    };
  }
}

function buildEngineWithCapture(
  decl: GraphDeclaration,
  result: MaterializedResultRef | null,
  onCompletion: (e: NodeCompletionEvent) => void = () => {},
): { state: EngineState; engine: AdvanceEngine; fake: ResultCaptureFake } {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const fake = new ResultCaptureFake();
  if (result) fake.setResult(result);
  const engine = new AdvanceEngine({
    state,
    signalBridge: bridge,
    dispatch: fake,
    onNodeCompletion: onCompletion,
  });
  engine.register();
  return { state, engine, fake };
}

/** Single-node graph (no edges) — minimal fixture for result-capture tests. */
function standaloneNode(id = "A", agent = "a1"): GraphDeclaration {
  return {
    version: 2,
    name: "standalone",
    nodes: [{ id, agent, prompt: "p1" }],
    edges: [],
  };
}

describe("result capture from dispatch task", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "graph-result-capture-"));
  const sidecar = join(tmpDir, "r.txt");
  const sampleResult: MaterializedResultRef = {
    sidecarPath: sidecar,
    totalChars: 42,
    hadFence: true,
    materializedAt: Date.now(),
  };

  beforeAll(() => {
    writeFileSync(sidecar, "Hello from the dispatched worker!", "utf8");
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("populates node.result from dispatch task when node completes via answer signal", async () => {
    const { state, engine, fake } = buildEngineWithCapture(
      standaloneNode("A", "a1"),
      sampleResult,
    );

    await engine.dispatchReady();
    const node = state.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.result).toBeUndefined(); // not yet captured

    // Simulate the worker emitting answer signal — this drives _applySignalTransition.
    await engine.onNodeSignalEmitted("A", "answer", { summary: "done" });

    expect(node.status).toBe(NodeStatus.Completed);
    // The materialized result ref is captured from the dispatch task.
    expect(node.result).toBeDefined();
    expect(node.result!.sidecarPath).toBe(sidecar);
    expect(node.result!.totalChars).toBe(42);
    expect(node.result!.hadFence).toBe(true);
  });

  it("does not populate node.result when dispatch task has no materialized result", async () => {
    const { state, engine } = buildEngineWithCapture(
      standaloneNode("A", "a1"),
      null, // no result set on the fake
    );

    await engine.dispatchReady();
    const node = state.nodes.get("A")!;

    await engine.onNodeSignalEmitted("A", "answer", "ok");

    expect(node.status).toBe(NodeStatus.Completed);
    // node.result stays undefined — no fake result, nothing to capture.
    expect(node.result).toBeUndefined();
  });

  it("does not overwrite node.result when already populated (idempotent)", async () => {
    const { state, engine } = buildEngineWithCapture(
      standaloneNode("A", "a1"),
      null,
    );

    await engine.dispatchReady();
    const node = state.nodes.get("A")!;

    // Pre-populate node.result (simulating a prior run's adoption)
    node.result = sampleResult;

    await engine.onNodeSignalEmitted("A", "answer", "ok");

    expect(node.status).toBe(NodeStatus.Completed);
    // node.result keeps the pre-populated ref (not overwritten).
    expect(node.result!.sidecarPath).toBe(sidecar);
  });

  it("carries the node's materialized sidecar path through EdgePayload.artifacts into merged_artifacts", async () => {
    const { state, engine, fake } = buildEngineWithCapture(
      linearGraph(),
      sampleResult,
    );

    await engine.dispatchReady();
    // A answers with a materialized result sidecar → recordNodeArtifactsAndEvidence
    // populates A.artifacts before _buildEdgePayload runs.
    await engine.onNodeSignalEmitted("A", "answer", { summary: "done" });

    const aNode = state.nodes.get("A")!;
    expect(aNode.status).toBe(NodeStatus.Completed);
    expect(aNode.artifacts).toEqual([sidecar]);

    // The downstream EdgePayload routed to B carries the sidecar path.
    const payload = state.nodes.get("B")!.upstreamResults.get("A")!;
    expect(payload.artifacts).toEqual([sidecar]);

    // mergeFanInContext accumulates payload.artifacts into merged_artifacts.
    const fanIn = mergeFanInContext(
      state.nodes.get("B")!.upstreamResults,
    );
    expect(fanIn.merged_artifacts).toEqual([sidecar]);
  });

  it("leaves EdgePayload.artifacts empty when the node has no materialized result", async () => {
    const { state, engine } = buildEngineWithCapture(
      linearGraph(),
      null, // no result set on the fake
    );

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "ok");

    const payload = state.nodes.get("B")!.upstreamResults.get("A")!;
    expect(payload.artifacts).toEqual([]);
    const fanIn = mergeFanInContext(
      state.nodes.get("B")!.upstreamResults,
    );
    expect(fanIn.merged_artifacts).toEqual([]);
  });

  it("fires onNodeCompletion seam even when dispatch task has no result", async () => {
    let captured: NodeCompletionEvent | undefined;
    const { state, engine } = buildEngineWithCapture(
      standaloneNode("A", "a1"),
      null,
      (e) => { captured = e; },
    );

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", { ok: true });

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(captured).toBeDefined();
    expect(captured!.nodeId).toBe("A");
    expect(captured!.signalType).toBe("answer");
    expect(captured!.payload).toEqual({ ok: true });
  });
});

// ── Budget pre-check: ready node escalated before dispatch ─────────────────

describe("budget pre-check escalates an undispatched ready node", () => {
  it("escalates the ready node without throwing and reaches terminal phase", async () => {
    const state = createEngineState(standaloneNode("A", "a1"), "g-budget");
    provision(state);
    const bridge = new SignalBridge();
    const fake = new FakeDispatch();
    const budget: GraphBudgetPort = {
      checkGraphBudget: () => ({ exceeded: true, reason: "graph budget exhausted" }),
    };
    const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake, budget });

    // Previously markEscalated on a ready node threw
    // "Invalid node transition: ready -> escalate", leaving the node stuck in
    // `ready` (neither dispatched nor escalated). Now it must not throw.
    await engine.dispatchReady();

    const node = state.nodes.get("A")!;
    expect(node.status).toBe(NodeStatus.Escalate);
    expect(node.errorReason).toBe("graph budget exhausted");
    // The node was dropped from the frontier (no lingering ready entry).
    expect(state.frontier.includes("A")).toBe(false);
    // No dispatch was attempted for the escalated node.
    expect(fake.calls.length).toBe(0);
    // Single-node graph with its only node escalated → no active nodes remain
    // → the graph reaches the terminal `complete` phase.
    expect(state.phase).toBe(EnginePhase.Complete);
    expect(state.advancingLock).toBe(false);
  });
});

// ── F1: dispatch-layer HITL termination bridges into the blocked transition ──

/**
 * Fake dispatch port that surfaces the `onTaskTerminated` seam (like the real
 * DispatchBridge) so a test can fire a dispatch termination with a HITL status
 * and observe the engine's running → blocked transition.
 */
class HITLDispatchFake implements NodeDispatchPort {
  private listeners = new Map<string, TaskTerminatedCallback>();
  status: DispatchTaskStatus = "running";

  executeNode(
    node: NodeRuntimeState,
    _ctx: DispatchParentContext,
  ): Promise<DispatchTask> {
    return Promise.resolve({
      id: `task-${node.nodeId}`,
      sessionId: `sess-${node.nodeId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: node.agent,
      prompt: node.prompt,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    });
  }
  onTaskTerminated(taskId: string, callback: TaskTerminatedCallback): void {
    this.listeners.set(taskId, callback);
  }
  getTask(taskId: string): DispatchTask | undefined {
    return {
      id: taskId,
      sessionId: `sess-${taskId}`,
      parentSessionId: "g-1",
      depth: 1,
      status: this.status,
      agent: "fake",
      prompt: "fake",
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
      priority: 0,
    };
  }
  /** Deliver a dispatch termination to the engine's subscribed listener. */
  fire(taskId: string, status: string): void {
    this.listeners.get(taskId)?.(taskId, status);
  }
}

/** Single declared needs_approval gate node (no downstream). */
function gateGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "gate",
    nodes: [{ id: "P", agent: "a1", prompt: "p1", needs_approval: true }],
    edges: [],
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("dispatch HITL termination (F1 bridge)", () => {
  it("transitions a declared needs_approval node running → blocked and fires the blocked terminal event", async () => {
    const state = createEngineState(gateGraph(), "g-hitl");
    provision(state);
    const bridge = new SignalBridge();
    const fake = new HITLDispatchFake();
    let terminal: GraphTerminalEvent | undefined;
    const engine = new AdvanceEngine({
      state,
      signalBridge: bridge,
      dispatch: fake,
      onGraphTerminal: (e) => {
        terminal = e;
      },
    });

    await engine.dispatchReady();
    expect(state.nodes.get("P")!.status).toBe(NodeStatus.Running);

    // The dispatch completion evaluator pauses the task for a human decision
    // and delivers the HITL status to the engine's onTaskTerminated listener
    // (completion-evaluator.ts:99 → lifecycle-shared.ts:235-249 → the
    // subscribeTaskTermination callback registered by _dispatchNode).
    fake.fire("task-P", "need_approval");
    await tick();

    // The pausing need_approval signal drove running → blocked (not dropped).
    expect(state.nodes.get("P")!.status).toBe(NodeStatus.Blocked);
    expect(state.nodes.get("P")!.signalsObserved["need_approval"]).toEqual({
      hitl: "need_approval",
      taskId: "task-P",
    });
    // No active nodes remain (only the blocked gate) → the blocked terminal
    // event fires exactly once with isBlocked=true; the graph stays executing,
    // waiting on the human's approve/reject.
    expect(terminal).toBeDefined();
    expect(terminal!.isBlocked).toBe(true);
    expect(terminal!.nodeStatusSummaries.blocked).toBe(1);
    expect(state.phase).toBe(EnginePhase.Executing);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
  });

  it("keeps a NON-declared node running (record-only) on a stray HITL termination — guard NOT relaxed", async () => {
    // (d): _pauseForApproval's `if (!node.needsApproval) return;` is
    // intentionally untouched. A node that did not declare needs_approval keeps
    // today's semantics: the signal is recorded but the node stays running and
    // no blocked terminal event fires (resumes via approve/reject on the
    // dispatch side).
    const state = createEngineState(standaloneNode("A", "a1"), "g-hitl-stray");
    provision(state);
    const bridge = new SignalBridge();
    const fake = new HITLDispatchFake();
    let terminal: GraphTerminalEvent | undefined;
    const engine = new AdvanceEngine({
      state,
      signalBridge: bridge,
      dispatch: fake,
      onGraphTerminal: (e) => {
        terminal = e;
      },
    });

    await engine.dispatchReady();
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    fake.fire("task-A", "need_approval");
    await tick();

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("A")!.signalsObserved["need_approval"]).toBeDefined();
    expect(terminal).toBeUndefined();
  });
});
