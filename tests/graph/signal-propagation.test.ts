import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngineState,
  provision,
  isInFrontier,
} from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import {
  propagateRevise,
  propagateEscalate,
} from "../../src/graph/engine/signal-propagation.ts";
import { markEscalated, markRunning } from "../../src/graph/engine/node-lifecycle.ts";

// ── Controllable fake dispatch port (mirrors engine-advance.test.ts) ───────

class FakeDispatch implements NodeDispatchPort {
  calls: { nodeId: string; agent: string; prompt: string }[] = [];

  executeNode(
    node: NodeRuntimeState,
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, agent: node.agent, prompt: node.prompt });
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

/** 3-node review loop: entry → impl → review, with a revise back-edge. */
function loopGraph(maxTraversals: number): GraphDeclaration {
  return {
    version: 2,
    name: "review-loop",
    nodes: [
      { id: "entry", agent: "a0", prompt: "seed" },
      // join: any so impl boots after entry without waiting for the back-edge.
      { id: "impl", agent: "a1", prompt: "implement", join: { strategy: "any" } },
      { id: "review", agent: "a2", prompt: "review" },
      { id: "sink", agent: "a3", prompt: "sink" },
    ],
    edges: [
      { from: "entry", to: "impl", type: "always" },
      { from: "impl", to: "review", type: "on_signal", signal_filter: ["answer"] },
      { from: "review", to: "impl", type: "on_signal", signal_filter: ["revise_needed"] },
      { from: "review", to: "sink", type: "on_signal", signal_filter: ["answer"] },
    ],
    loop_groups: [{ id: "lg", nodes: ["impl", "review"], max_traversals: maxTraversals }],  };
}

/** Fan-out then converge: R → A, R → B → C (multi-input convergence). */
function convergeGraph(strategy: "all" | "any"): GraphDeclaration {
  return {
    version: 2,
    name: "converge",
    nodes: [
      { id: "R", agent: "a0", prompt: "root" },
      { id: "A", agent: "a1", prompt: "a" },
      { id: "B", agent: "a2", prompt: "b" },
      { id: "C", agent: "a3", prompt: "c", join: { strategy } },
    ],
    edges: [
      { from: "R", to: "A", type: "always" },
      { from: "R", to: "B", type: "always" },
      { from: "A", to: "C", type: "on_signal", signal_filter: ["answer"] },
      { from: "B", to: "C", type: "on_signal", signal_filter: ["answer"] },
    ],
  };
}

/** Linear A → B, optionally with a retry policy on the outbound edge. */
function linearGraph(retryMax = 0): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
    ],
    edges: retryMax > 0
      ? [{ from: "A", to: "B", type: "always", retry: { max: retryMax } }]
      : [{ from: "A", to: "B", type: "always" }],
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface TestRig {
  state: EngineState;
  engine: AdvanceEngine;
  fake: FakeDispatch;
}

function buildEngine(decl: GraphDeclaration, fake = new FakeDispatch()): TestRig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  const bridge = new SignalBridge();
  const engine = new AdvanceEngine({ state, signalBridge: bridge, dispatch: fake });
  return { state, engine, fake };
}

/** Build a provisioned state without an engine (for direct propagation unit tests). */
function buildState(decl: GraphDeclaration): EngineState {
  const state = createEngineState(decl, "g-1");
  provision(state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// propagateRevise — unit level
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateRevise (unit)", () => {
  it("consumes one traversal and re-marks the upstream back-edge target ready", () => {
    const state = buildState(loopGraph(5));
    const impl = state.nodes.get("impl")!;
    const review = state.nodes.get("review")!;

    // Simulate round-1 completion: impl ran+answered, review is about to revise.
    impl.status = NodeStatus.Completed;
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(0);

    const report = propagateRevise(state, review, { findings: ["fix the logic"] });

    // Traversal consumed once.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // impl re-entered ready and is in the frontier.
    expect(impl.status).toBe(NodeStatus.Ready);
    expect(isInFrontier(state, "impl")).toBe(true);
    // Revision feedback merged into impl's re-execution prompt.
    expect(impl.prompt).toContain("Revision feedback");
    expect(impl.prompt).toContain("fix the logic");
    // report reflects the re-entered upstream.
    expect(report.revisedUpstream).toEqual(["impl"]);
    expect(report.escalated).toEqual([]);
  });

  it("escalates when the loop group's max_traversals is exhausted", () => {
    // max_traversals: 0 → the very first revision is already at the cap.
    const state = buildState(loopGraph(0));
    const review = state.nodes.get("review")!;
    // The reviewer finished its pass (completed) before the cap forces escalate.
    review.status = NodeStatus.Completed;

    const report = propagateRevise(state, review, { findings: ["still broken"] });

    // The revise node flips completed → done with the exhaustion reason.
    expect(review.status).toBe(NodeStatus.Done);
    expect(review.errorReason).toBe("max_traversals exhausted");
    expect(report.escalated).toEqual(["review"]);
    expect(report.reason).toBe("max_traversals exhausted");
    // No upstream was re-entered.
    expect(report.revisedUpstream).toEqual([]);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Pending);
  });

  it("escalates when the node has no loop group", () => {
    const state = buildState(linearGraph());
    const node = state.nodes.get("A")!;
    expect(node.loopGroupId).toBeUndefined();
    // A just finished running and emits revise_needed with no loop to route into.
    markRunning(state, node);

    const report = propagateRevise(state, node, "revise me");

    expect(node.status).toBe(NodeStatus.Escalate);
    expect(node.errorReason).toBe("no loop group");
    expect(report.reason).toBe("no loop group");
    expect(report.escalated).toEqual(["A"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// propagateRevise — engine integration (revise-driven re-dispatch)
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateRevise (engine integration)", () => {
  it("revise consumes a traversal and re-dispatches the upstream node via the dispatch seam", async () => {
    const { state, engine, fake } = buildEngine(loopGraph(5));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["entry", "impl"]);

    // impl answers → review is dispatched.
    await engine.onNodeSignalEmitted("impl", "answer", "v1");
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Running);

    // review emits revise_needed → the loop back-edge re-activates impl.
    await engine.onNodeSignalEmitted("review", "revise_needed", "wrong approach");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Completed);
    // impl re-entered ready and was re-dispatched (second impl launch).
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("impl")!.sessionsSpawned).toBe(2);
    expect(state.nodes.get("impl")!.prompt).toContain("Revision feedback");
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["entry", "impl", "review", "impl"]);
    expect(state.phase).toBe(EnginePhase.Executing);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// propagateEscalate — unit level
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateEscalate (unit)", () => {
  it("re-marks the source ready for an automatic retry when an outbound edge allows it", () => {
    const state = buildState(linearGraph(2));
    const node = state.nodes.get("A")!;
    markRunning(state, node);
    markEscalated(state, node, "boom"); // _applySignalTransition already escalated A

    const report = propagateEscalate(state, node, { reason: "boom" });

    // escalate → ready retry within retryCount bounds.
    expect(node.status).toBe(NodeStatus.Ready);
    expect(node.retryCount).toBe(1);
    expect(isInFrontier(state, "A")).toBe(true);
    expect(node.prompt).toContain("boom");
    expect(report.retried).toEqual(["A"]);
    expect(report.escalated).toEqual([]);
    // Downstream B untouched — the escalation was absorbed by the retry.
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Pending);
  });

  it("stops retrying once retryCount reaches the edge retry max", () => {
    const state = buildState(linearGraph(1));
    const node = state.nodes.get("A")!;
    node.retryCount = 1; // already retried once against retry.max = 1
    markRunning(state, node);
    markEscalated(state, node, "boom");

    const report = propagateEscalate(state, node, { reason: "boom" });

    // No retry remains; A stays escalated and nothing is re-marked ready.
    expect(report.retried).toEqual([]);
    expect(node.status).toBe(NodeStatus.Escalate);
  });

  it("propagates the escalation to a failed join-all convergence node", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    markEscalated(state, node, "branch B failed");

    const report = propagateEscalate(state, node, { reason: "branch B failed" });

    // The escalation reached convergence node C; C's all-join failed → C escalated.
    expect(report.escalated).toContain("C");
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    // The escalation was recorded into C's upstream results for diagnostics.
    expect(state.nodes.get("C")!.upstreamResults.get("B")!.fromSignal).toBe("escalate");
  });

  it("absorbs the escalation when the convergence join is still satisfiable (no false complete)", () => {
    const state = buildState(convergeGraph("any"));
    const c = state.nodes.get("C")!;
    // A already answered → C's any-join is satisfied; B is still pending.
    const answerPayload = {
      fromNode: "A",
      fromSignal: "answer",
      result: "ok",
      artifacts: [],
      budgetConsumed: { tokens: 1, cost: 0, sessions: 1 },
    } as const;
    c.upstreamResults.set("A", answerPayload as never);
    c.joinSatisfied = true;

    const node = state.nodes.get("B")!;
    markEscalated(state, node, "B failed but not needed");

    const report = propagateEscalate(state, node, { reason: "B failed but not needed" });

    // The escalation is absorbed — C is NOT escalated (partial failure tolerated).
    expect(report.absorbed).toEqual(["C"]);
    expect(report.escalated).toEqual([]);
    expect(c.status).not.toBe(NodeStatus.Escalate);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// propagateEscalate — engine integration
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateEscalate (engine integration)", () => {
  it("propagates a leaf escalate to the convergence node and does not misjudge completion for a satisfiable join", async () => {
    const { state, engine } = buildEngine(convergeGraph("any"));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(fakeStatuses(state)).toContainEqual(["A", NodeStatus.Running]);
    expect(fakeStatuses(state)).toContainEqual(["B", NodeStatus.Running]);

    // A answers first → C (any join) is satisfied and dispatched → running.
    await engine.onNodeSignalEmitted("A", "answer", "from-A");
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);

    // B escalates → propagates to C, but C's any-join is already satisfied
    // (A answered) → the escalation is absorbed. C must NOT be escalated and
    // the graph must NOT spuriously complete while C is still running.
    await engine.onNodeSignalEmitted("B", "escalate", { reason: "B exploded" });
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);
    expect(state.phase).toBe(EnginePhase.Executing);
  });

  it("cascades a join-all failure through the convergence node and terminates the graph in error", async () => {
    const { state, engine } = buildEngine(convergeGraph("all"));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");

    // A answers, B escalates → C's all-join fails → C escalates → all terminal.
    await engine.onNodeSignalEmitted("A", "answer", "from-A");
    await engine.onNodeSignalEmitted("B", "escalate", { reason: "B exploded" });

    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.errorReason).toBe("B exploded");
    // No active (running/ready/pending/blocked) nodes remain → graph completes
    // with an error outcome (escalation propagated to the sink).
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("an escalate on an edge with retry re-dispatches the node instead of propagating", async () => {
    const { state, engine, fake } = buildEngine(linearGraph(2));

    // R absent — dispatch A directly: A is the root of the linear graph.
    await engine.dispatchReady();
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A"]);

    // A escalates; outbound edge A→B has retry {max:2} → A is re-dispatched.
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "transient" });
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("A")!.retryCount).toBe(1);
    expect(state.nodes.get("A")!.sessionsSpawned).toBe(2);
    expect(fake.calls.map((c) => c.nodeId)).toEqual(["A", "A"]);
    // B never dispatched — the escalation was absorbed by the retry.
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Pending);
    expect(state.phase).toBe(EnginePhase.Executing);
  });
});

/** Snapshot the (nodeId → status) pairs for a running engine's live state. */
function fakeStatuses(state: EngineState): [string, NodeStatus][] {
  return [...state.nodes.entries()].map(([id, n]) => [id, n.status]);
}
