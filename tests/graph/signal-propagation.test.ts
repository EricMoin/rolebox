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
import { clearDirty } from "../../src/graph/engine/engine-persistence.ts";

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

  it("marks the state dirty when recording an escalate onto a convergence node (Y11)", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    markEscalated(state, node, "branch B failed");
    // markEscalated already set the flag — reset it so this asserts that
    // propagateEscalate → recordEscalate itself marks the state dirty when it
    // mutates C's upstreamResults / joinSatisfied (Y11 choke-point contract).
    clearDirty(state);

    propagateEscalate(state, node, { reason: "branch B failed" });

    expect(state.isDirty).toBe(true);
    // The mutation that triggered the dirty-mark actually landed.
    expect(state.nodes.get("C")!.upstreamResults.get("B")!.fromSignal).toBe("escalate");
  });

  it("escalate-path EdgePayload carries the source node's recorded artifacts", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    node.artifacts = ["/work/artifact-b.ts"]; // e.g. a reviewer that escalated post-result
    markEscalated(state, node, "branch B failed");

    propagateEscalate(state, node, { reason: "branch B failed" });

    // The escalate EdgePayload routed into C's upstreamResults preserves the
    // source node's artifacts rather than hardcoding an empty list.
    const payload = state.nodes.get("C")!.upstreamResults.get("B")!;
    expect(payload.artifacts).toEqual(["/work/artifact-b.ts"]);
  });

  it("escalate-path EdgePayload leaves artifacts empty when the node has none", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    markEscalated(state, node, "branch B failed");

    propagateEscalate(state, node, { reason: "branch B failed" });

    const payload = state.nodes.get("C")!.upstreamResults.get("B")!;
    expect(payload.artifacts).toEqual([]);
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

  it("escalate-path EdgePayload carries the source node's tokensConsumed budget, not zeros (M1)", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    // A node that consumed real budget before escalating.
    node.tokensConsumed = { inputTokens: 120, outputTokens: 40, cost: 0.25 };
    node.sessionsSpawned = 3;
    markEscalated(state, node, "branch B failed");

    propagateEscalate(state, node, { reason: "branch B failed" });

    // Mirrors _buildEdgePayload / approval-handler: tokens = input+output,
    // cost and sessions read from the source node — no hardcoded zeros.
    const payload = state.nodes.get("C")!.upstreamResults.get("B")!;
    expect(payload.budgetConsumed).toEqual({
      tokens: 160,
      cost: 0.25,
      sessions: 3,
    });
  });

  it("reports a sink-side join failure via escalated/absorbed (rootReached removed, L8)", () => {
    const state = buildState(convergeGraph("all"));
    const node = state.nodes.get("B")!;
    markEscalated(state, node, "branch B failed");

    const report = propagateEscalate(state, node, { reason: "branch B failed" });

    // C is a fan-in convergence node AND the graph sink (no outbound edges).
    // Its all-join fails → C escalates and lands in report.escalated with
    // nothing absorbed — the "graph will terminate with error" observable the
    // removed `rootReached` field used to promise (forward propagation reaches
    // sinks, never graph roots). The report carries no rootReached field.
    expect(report.escalated).toEqual(["C"]);
    expect(report.absorbed).toEqual([]);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    expect(report).not.toHaveProperty("rootReached");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// propagateEscalate — engine integration
// ═══════════════════════════════════════════════════════════════════════════

describe("propagateEscalate (engine integration)", () => {
  it("absorbs a partial-failure escalate at a still-waiting any-join, then activates on the surviving answer", async () => {
    const { state, engine } = buildEngine(convergeGraph("any"));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(fakeStatuses(state)).toContainEqual(["A", NodeStatus.Running]);
    expect(fakeStatuses(state)).toContainEqual(["B", NodeStatus.Running]);

    // B escalates while C's any-join is still waiting (A pending, none answered)
    // → the partial failure is absorbed; C must NOT escalate or complete.
    await engine.onNodeSignalEmitted("B", "escalate", { reason: "B exploded" });
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Pending);

    // A answers → C activates on the surviving answer; partial failure absorbed,
    // and the graph must NOT spuriously complete while C is running.
    await engine.onNodeSignalEmitted("A", "answer", "from-A");
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

// ═══════════════════════════════════════════════════════════════════════════
// Non-loop fan-in cascade cancellation (D3 regression)
//
// cancelPendingUpstreams has its only automatic call in the loop escalate
// branch (loop-group-executor.ts). The NON-loop escalate and answer paths must
// ALSO retire still-pending sibling upstreams once a fan-in join resolves, so
// they stop consuming dispatch budget. These tests pin that behavior.
// ═══════════════════════════════════════════════════════════════════════════

/** Fake dispatch that also records cascade-cancel calls (cancelTask seam). */
class FakeDispatchWithCancel extends FakeDispatch {
  cancelCalls: string[] = [];
  cancelTask(taskId: string): Promise<boolean> {
    this.cancelCalls.push(taskId);
    return Promise.resolve(true);
  }
}

describe("non-loop fan-in cascade cancellation", () => {
  it("escalate path: cancels the still-pending sibling when a join-all convergence node escalates", async () => {
    const { state, engine, fake } = buildEngine(
      convergeGraph("all"),
      new FakeDispatchWithCancel(),
    );
    const fakeCancel = fake as unknown as FakeDispatchWithCancel;

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // A escalates while B is still running → C (all-join) fails and escalates;
    // B is no longer needed and must be retired by the cascade canceller.
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "A exploded" });

    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(fakeCancel.cancelCalls).toContain("task-B");
  });

  it("answer path: cancels the still-pending sibling when an any-join converges", async () => {
    const { state, engine, fake } = buildEngine(
      convergeGraph("any"),
      new FakeDispatchWithCancel(),
    );
    const fakeCancel = fake as unknown as FakeDispatchWithCancel;

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // A answers first → C's any-join is satisfied → C activates; B (still
    // running, never to be consumed) is retired by the cascade canceller.
    await engine.onNodeSignalEmitted("A", "answer", "from-A");

    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(fakeCancel.cancelCalls).toContain("task-B");
  });
});

/** Snapshot the (nodeId → status) pairs for a running engine's live state. */
function fakeStatuses(state: EngineState): [string, NodeStatus][] {
  return [...state.nodes.entries()].map(([id, n]) => [id, n.status]);
}

// ═══════════════════════════════════════════════════════════════════════════
// D3 shared-upstream guard regression
//
// A shared upstream that feeds BOTH a converging node and an independent
// downstream that still needs it must NOT be retired by the cascade canceller.
// Otherwise the downstream is starved. These tests pin the guard on both the
// answer path (join satisfied) and the escalate path (join failed).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * R fans out to X and S. Both X and S feed the convergence node C; S also feeds
 * an independent downstream D. D (fed only by S) still needs S, so the cascade
 * canceller must preserve S when C's join resolves.
 */
function sharedUpstreamGraph(strategy: "all" | "any"): GraphDeclaration {
  return {
    version: 2,
    name: "shared-upstream",
    nodes: [
      { id: "R", agent: "a0", prompt: "root" },
      { id: "X", agent: "a1", prompt: "x" },
      { id: "S", agent: "a2", prompt: "s" },
      { id: "C", agent: "a3", prompt: "c", join: { strategy } },
      { id: "D", agent: "a4", prompt: "d" },
    ],
    edges: [
      { from: "R", to: "X", type: "always" },
      { from: "R", to: "S", type: "always" },
      { from: "X", to: "C", type: "on_signal", signal_filter: ["answer"] },
      { from: "S", to: "C", type: "on_signal", signal_filter: ["answer"] },
      { from: "S", to: "D", type: "always" },
    ],
  };
}

describe("non-loop fan-in cascade cancellation — shared-upstream guard", () => {
  it("answer path: keeps a shared upstream still needed by another downstream", async () => {
    const { state, engine } = buildEngine(
      sharedUpstreamGraph("any"),
      new FakeDispatchWithCancel(),
    );

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(state.nodes.get("X")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("S")!.status).toBe(NodeStatus.Running);

    // X answers → C's any-join satisfied → the cascade runs, but S must be kept
    // because D (fed only by S) still needs it.
    await engine.onNodeSignalEmitted("X", "answer", "from-X");

    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running); // activated
    expect(state.nodes.get("S")!.status).toBe(NodeStatus.Running); // NOT cancelled
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Pending); // still waiting
  });

  it("escalate path: keeps a shared upstream still needed by another downstream", async () => {
    const { state, engine } = buildEngine(
      sharedUpstreamGraph("all"),
      new FakeDispatchWithCancel(),
    );

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(state.nodes.get("X")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("S")!.status).toBe(NodeStatus.Running);

    // X escalates → C's all-join fails → the cascade runs, but S must be kept
    // because D (fed only by S) still needs it.
    await engine.onNodeSignalEmitted("X", "escalate", { reason: "X exploded" });

    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("S")!.status).toBe(NodeStatus.Running); // NOT cancelled
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Pending); // still waiting
  });
});
