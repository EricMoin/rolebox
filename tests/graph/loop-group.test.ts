import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import type { DispatchTask } from "../../src/dispatch/types.ts";
import type { DispatchParentContext } from "../../src/graph/engine/dispatch-bridge.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { SignalBridge } from "../../src/graph/engine/signal-bridge.ts";
import {
  AdvanceEngine,
  type NodeDispatchPort,
} from "../../src/graph/engine/engine-advance.ts";
import {
  executeLoopStep,
  fingerprintPayload,
  recordConvergenceOutput,
  resetConvergenceTracker,
  type LoopStepReport,
} from "../../src/graph/engine/loop-group-executor.ts";

// ── Controllable fake dispatch port (mirrors signal-propagation.test.ts) ────

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
 * worker → convergence review loop: entry seeds impl; impl feeds review; review
 * either revises back to impl (loop back-edge) or converges forward to sink.
 * `impl` and `review` are the loop-group members.
 */
function reviewLoopGraph(maxTraversals: number): GraphDeclaration {
  return {
    version: 2,
    name: "review-loop",
    nodes: [
      { id: "entry", agent: "a0", prompt: "seed" },
      // join: any so impl boots after entry without waiting on the review
      // back-edge (review is also an upstream of impl via the revise edge).
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
    loop_groups: [{ id: "lg", nodes: ["impl", "review"], max_traversals: maxTraversals }],
  };
}

/**
 * Fan-out then converge inside a loop group: R → A and R → B; A → C and
 * B → C (C is a `join: all` convergence node). All of A, B, C are loop members.
 */
function convergeLoopGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "converge-loop",
    nodes: [
      { id: "R", agent: "a0", prompt: "root" },
      { id: "A", agent: "a1", prompt: "a" },
      { id: "B", agent: "a2", prompt: "b" },
      { id: "C", agent: "a3", prompt: "c", join: { strategy: "all" } },
    ],
    edges: [
      { from: "R", to: "A", type: "always" },
      { from: "R", to: "B", type: "always" },
      { from: "A", to: "C", type: "on_signal", signal_filter: ["answer"] },
      { from: "B", to: "C", type: "on_signal", signal_filter: ["answer"] },
    ],
    loop_groups: [{ id: "lg", nodes: ["A", "B", "C"], max_traversals: 5 }],
  };
}

// ── Rig ─────────────────────────────────────────────────────────────────────

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

/** Snapshot the (nodeId → status) pairs for a running engine's live state. */
function statuses(state: EngineState): [string, NodeStatus][] {
  return [...state.nodes.entries()].map(([id, n]) => [id, n.status]);
}

// ═══════════════════════════════════════════════════════════════════════════
// fingerprintPayload / extractUnresolved helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("convergence fingerprinting", () => {
  it("fingerprints payloads order-insensitively so identical content matches", () => {
    const a = fingerprintPayload({ b: 1, a: 2, list: ["x", "y"] });
    const b = fingerprintPayload({ a: 2, list: ["x", "y"], b: 1 });
    expect(a).toBe(b);
    // Different content differs.
    expect(fingerprintPayload({ a: 2 })).not.toBe(a);
  });

  it("trims string fingerprints", () => {
    expect(fingerprintPayload("  same issue  ")).toBe("same issue");
    expect(fingerprintPayload("same issue")).toBe("same issue");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (a) max_traversals exhaustion — structured escalate payload
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — max_traversals exhaustion", () => {
  it("max_traversals=3: loop traverses 3 times then escalates with traversalCount===3", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(3));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Drive the bounded cycle: review revises (non-exhausted) → impl re-runs →
    // impl answers → review re-runs. Stop when the review escalates.
    let guard = 0;
    let escalated = false;
    while (!escalated && guard < 10) {
      guard += 1;
      await engine.onNodeSignalEmitted(
        "review",
        "revise_needed",
        { findings: [`round ${guard}`], verdict: "fix more" },
      );
      if (state.nodes.get("review")!.status === NodeStatus.Escalate) {
        escalated = true;
        break;
      }
      // Non-exhausted revision: impl was re-entered; re-run it to wake review.
      await engine.onNodeSignalEmitted("impl", "answer", `impl round ${guard}`);
    }

    expect(escalated).toBe(true);
    // Three traversals consumed before the cap forced the escalation.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(3);
    // The convergence node escalated with the exhaustion reason.
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("review")!.errorReason).toBe("max_traversals exhausted");
    // impl was NOT re-entered after exhaustion — no further loop round.
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Completed);
  });

  it("executeLoopStep surfaces the structured exhaustion payload directly", () => {
    const { state } = buildEngine(reviewLoopGraph(1));
    const review = state.nodes.get("review")!;
    const impl = state.nodes.get("impl")!;
    // Simulate: impl already ran once; the group already consumed its single
    // traversal (max_traversals=1 → the cap is now reached).
    impl.status = NodeStatus.Completed;
    review.status = NodeStatus.Completed;
    state.loopGroups.get("lg")!.traversalCount = 1;

    const report = executeLoopStep(state, review, "revise_needed", {
      findings: ["still broken", "add tests"],
    });

    expect(report.outcome).toBe("max_traversals_exhausted");
    expect(report.escalated).toEqual(["review"]);
    expect(report.escalatePayload).toEqual({
      reason: "max_traversals exhausted",
      unresolved: ["still broken", "add tests"],
      traversals: 1,
    });
    expect(state.nodes.get("review")!.errorReason).toBe("max_traversals exhausted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) converged early-exit — loop ends on the happy path, graph completes
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — converged early-exit", () => {
  it("converges at traversal 2: answer flows forward only, graph completes", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(3));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Round 1: review revises → one traversal consumed, impl re-runs.
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["fix x"] });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    await engine.onNodeSignalEmitted("impl", "answer", "v2");

    // Round 2: review revises → traversal 2 consumed, impl re-runs.
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["fix y"] });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    await engine.onNodeSignalEmitted("impl", "answer", "v3");

    // Convergence: review answers → forward edge to sink activates, the back-
    // edge does NOT (it filters on revise_needed), no traversal consumed.
    await engine.onNodeSignalEmitted("review", "answer", "accepted");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    expect(state.nodes.get("sink")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Completed);

    // Sink answers → graph completes on the happy path.
    await engine.onNodeSignalEmitted("sink", "answer", "done");
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("executeLoopStep on a reviewer answer records converged and resets the tracker", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    // Pre-warm the stuck tracker with repeated identical findings...
    recordConvergenceOutput(state, "lg", "findings X");
    recordConvergenceOutput(state, "lg", "findings X");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(2);

    // ...then converge: the reviewer (it owns the revise back-edge) clears the
    // tracker, marking the happy-path exit.
    const report = executeLoopStep(state, review, "answer", "accepted");

    expect(report.outcome).toBe("converged");
    // No traversal was consumed by a converged exit.
    expect(report.traversals).toBe(0);
    // Converged resets the stuck tracker.
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(0);
    expect(state.loopGroups.get("lg")!.convergenceFingerprint).toBeUndefined();
  });

  it("a worker-member answer does not reset the reviewer's stuck tracker", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const impl = state.nodes.get("impl")!;
    // Review emitted one identical finding; impl is a worker member.
    recordConvergenceOutput(state, "lg", "findings X");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(1);
    impl.status = NodeStatus.Completed;

    // impl answers → no revise back-edge → the reviewer's staleness is intact.
    executeLoopStep(state, impl, "answer", "impl output");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) stuck detection — identical convergence output escalates with 'stuck'
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — stuck detection", () => {
  it("identical revision findings on consecutive traversals escalate with reason 'stuck'", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(5));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Round 1: identical findings — first occurrence, not yet stuck (1 < 2).
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["no progress"] });
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(1);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // impl re-entered and was re-dispatched (running, second session).
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("impl")!.sessionsSpawned).toBe(2);

    // Round 2: IDENTICAL findings → consecutiveStale hits CONSECUTIVE_STALE_THRESHOLD
    // → stuck → escalate 'stuck' BEFORE consuming another traversal.
    await engine.onNodeSignalEmitted("impl", "answer", "v2");
    await engine.onNodeSignalEmitted("review", "revise_needed", { findings: ["no progress"] });

    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("review")!.errorReason).toBe("stuck");
    // No additional traversal was consumed by the stuck exit (stayed at 1).
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(2);
    // impl was NOT re-entered for another doomed round.
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Completed);
  });

  it("executeLoopStep reports the stuck outcome with the structured payload", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    // First occurrence: not stuck, delegates to revise (consumes a traversal).
    const first = executeLoopStep(state, review, "revise_needed", { findings: ["same"] });
    expect(first.outcome).toBe("revising");
    expect(first.revisedUpstream).toEqual(["impl"]);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);

    // Second identical occurrence → stuck.
    const second = executeLoopStep(state, review, "revise_needed", { findings: ["same"] });
    expect(second.outcome).toBe("stuck");
    expect(second.escalated).toEqual(["review"]);
    expect(second.escalatePayload).toEqual({
      reason: "stuck",
      unresolved: ["same"],
      traversals: 1,
    });
    // No traversal consumed on the stuck exit.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
  });

  it("a changed finding resets the consecutive-stale counter (not stuck)", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    executeLoopStep(state, review, "revise_needed", { findings: ["issue A"] });
    // Changed finding → counter resets to 1, still not stuck.
    const report = executeLoopStep(state, review, "revise_needed", { findings: ["issue B"] });
    expect(report.outcome).toBe("revising");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (d) join:all partial escalation — A escalates, C propagates immediately, B
//     is cancelled by the cascade
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — join:all partial escalation + cascade cancel", () => {
  it("A escalate at a join:all convergence escalates C immediately and cancels running B", async () => {
    const { state, engine } = buildEngine(convergeLoopGraph());

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("R", "answer", "root");
    expect(statuses(state)).toContainEqual(["A", NodeStatus.Running]);
    expect(statuses(state)).toContainEqual(["B", NodeStatus.Running]);

    // A escalates first while B is still running. C (join:all) fails the join
    // immediately → C escalates, and the cascade canceller retires B.
    await engine.onNodeSignalEmitted("A", "escalate", { reason: "branch A exploded" });

    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
    expect(state.nodes.get("C")!.errorReason).toBe("branch A exploded");
    // B was cancelled → retired to done, so it can never answer into C.
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
  });

  it("executeLoopStep escalate surfaces cancelled upstreams in the report", () => {
    const { state } = buildEngine(convergeLoopGraph());
    const a = state.nodes.get("A")!;
    // A already escalated (running → escalate); B and C left in a runnable state.
    a.status = NodeStatus.Escalate;
    const b = state.nodes.get("B")!;
    b.status = NodeStatus.Running;
    const c = state.nodes.get("C")!;
    c.status = NodeStatus.Pending;

    const report = executeLoopStep(state, a, "escalate", { reason: "boom" });

    expect(report.outcome).toBe("escalating");
    // The escalation propagated to convergence node C (join failed).
    expect(report.escalated).toContain("C");
    // B was cancelled by the cascade; A is not an upstream of C so untouched.
    expect(report.cancelled).toContain("B");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Escalate);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resetConvergenceTracker
// ═══════════════════════════════════════════════════════════════════════════

describe("resetConvergenceTracker", () => {
  it("clears the fingerprint and consecutive-stale counter", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    recordConvergenceOutput(state, "lg", "findings X");
    recordConvergenceOutput(state, "lg", "findings X");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(2);

    resetConvergenceTracker(state, "lg");
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(0);
    expect(state.loopGroups.get("lg")!.convergenceFingerprint).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loop-group executor — answer payload downgrade (defensive validation)
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — answer payload downgrade (defensive validation)", () => {
  it("answer with {verdict:'revise', findings:[...]} downgrades to revise semantics (loop continues)", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    const report = executeLoopStep(state, review, "answer", {
      verdict: "revise",
      findings: ["still needs work", "missing tests"],
    });

    // Should NOT be converged — payload indicates unresolved work
    expect(report.outcome).not.toBe("converged");
    // Should behave like revise_needed: revise upstream nodes
    expect(report.outcome).toBe("revising");
    expect(report.revisedUpstream).toEqual(["impl"]);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // The convergence tracker should NOT have been reset
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(1);
    // Downgrade reason should be recorded
    expect(report.downgradeReason).toContain("verdict=revise");
  });

  it("answer with {verdict:'veto'} downgrades to revise semantics and triggers stuck on repeat", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    // First veto: should revise
    const first = executeLoopStep(state, review, "answer", {
      verdict: "veto",
      findings: ["blocking"],
    });
    expect(first.outcome).toBe("revising");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);

    // Second identical veto: should trigger stuck detection
    const second = executeLoopStep(state, review, "answer", {
      verdict: "veto",
      findings: ["blocking"],
    });
    expect(second.outcome).toBe("stuck");
    expect(second.escalated).toEqual(["review"]);
    // No additional traversal consumed by stuck exit
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
  });

  it("answer with null payload converges normally (backward compatible)", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    // Pre-warm tracker to verify it gets reset
    recordConvergenceOutput(state, "lg", "findings X");
    recordConvergenceOutput(state, "lg", "findings X");

    const report = executeLoopStep(state, review, "answer", null);

    expect(report.outcome).toBe("converged");
    expect(report.traversals).toBe(0);
    expect(state.loopGroups.get("lg")!.consecutiveStale).toBe(0);
  });

  it("answer with a plain string payload converges normally", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    const report = executeLoopStep(state, review, "answer", "all good");

    expect(report.outcome).toBe("converged");
  });

  it("answer with benign object payload (no unresolved fields) converges normally", () => {
    const { state } = buildEngine(reviewLoopGraph(5));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;

    const report = executeLoopStep(state, review, "answer", {
      summary: "done",
      score: 95,
    });

    expect(report.outcome).toBe("converged");
    expect(report.traversals).toBe(0);
  });
});
