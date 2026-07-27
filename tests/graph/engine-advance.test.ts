import { describe, it, expect } from "bun:test";
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
