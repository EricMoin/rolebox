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
  type NodeCompletionEvent,
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
  private held = new Set<string>();
  private releasers = new Map<string, Array<() => void>>();

  /** Hold a node's next launch so the advancing critical section stays open. */
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
    _parentContext: DispatchParentContext,
  ): Promise<DispatchTask> {
    this.calls.push({ nodeId: node.nodeId, agent: node.agent, prompt: node.prompt });
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

/**
 * Pure always-cycle: A ⇄ B with both edges of type `always` inside a bounded
 * loop group.  This is the canonical "always-cycle bug" — before subtask 1
 * neither node had in-degree zero (both always-edges counted) and the graph
 * deadlocked at provision.  After subtask 1 intra-group always-edges are
 * excluded from in-degree, so both nodes become ready.
 */
function alwaysCycleGraph(maxTraversals: number): GraphDeclaration {
  return {
    version: 2,
    name: "always-cycle",
    nodes: [
      { id: "A", agent: "a0", prompt: "node A" },
      { id: "B", agent: "a1", prompt: "node B" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "A", type: "always" },
    ],
    loop_groups: [{ id: "lg", nodes: ["A", "B"], max_traversals: maxTraversals }],
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

  it("bounds canonicalization on deeply nested payloads instead of overflowing the stack", () => {
    // 10k-deep nested array — unbounded recursion produced a RangeError
    // (confirmed at ~20k depth pre-fix) and a giant string at 10k.
    let deep: unknown = [];
    for (let i = 0; i < 10_000; i++) deep = [deep];
    expect(() => fingerprintPayload(deep)).not.toThrow();
    const fp = fingerprintPayload(deep);
    expect(typeof fp).toBe("string");
    expect(fp.length).toBeLessThan(1000);

    // Same prefix depth → identical bounded fingerprint (stability at the bound).
    let deep2: unknown = [];
    for (let i = 0; i < 10_000; i++) deep2 = [deep2];
    expect(fingerprintPayload(deep2)).toBe(fp);

    // Deep object nesting is bounded too.
    let deepObj: unknown = { leaf: true };
    for (let i = 0; i < 10_000; i++) deepObj = { nested: deepObj };
    expect(() => fingerprintPayload(deepObj)).not.toThrow();
    expect(fingerprintPayload(deepObj).length).toBeLessThan(2000);

    // The truncation marker is a bare token — it can never be produced by
    // JSON.stringify of real content (strings are always quoted).
    expect(fp).toContain("...<truncated>");
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
      if (state.nodes.get("review")!.status === NodeStatus.Done) {
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
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Done);
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

  it("max_traversals exhaustion terminates node as done, not escalate", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(2));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Round 1: revise → traversal 0→1, impl re-entered and re-dispatched.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["fix 1"],
    });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    await engine.onNodeSignalEmitted("impl", "answer", "v2");

    // Round 2: revise → traversal 1→2, impl re-entered and re-dispatched.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["fix 2"],
    });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    await engine.onNodeSignalEmitted("impl", "answer", "v3");

    // Third revise exceeds cap (2 ≥ 2) → exhaustion, NOT escalate.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["fix 3"],
    });

    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("review")!.status).not.toBe(NodeStatus.Escalate);
    expect(state.nodes.get("review")!.errorReason).toBe(
      "max_traversals exhausted",
    );
    // Per-group traversal pinned at 2 — off-by-one in either direction fails.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    // impl was NOT re-entered a third time — traversalCount stays at 2.
    expect(state.nodes.get("impl")!.traversalCount).toBe(2);
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Completed);
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

    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Done);
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

// ═══════════════════════════════════════════════════════════════════════════
// always-cycle regression: intra-group always-edge exclusion (subtask 1 root
// discovery fix) prevents provision deadlock, and the loop group is traversed
// bounded by max_traversals.
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — always-cycle root discovery and bounded traversal", () => {
  it("always-cycle provisions without deadlock: both nodes ready after intra-group edge exclusion", () => {
    const { state } = buildEngine(alwaysCycleGraph(3));

    // Both edges A⇄B are intra-group always edges → excluded from in-degree.
    // Without the subtask 1 fix, both nodes would have in-degree 1 and stay
    // pending, deadlocking the graph. After the fix, both have in-degree 0 and
    // are marked ready.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Ready);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Ready);

    // The loop group is provisioned with the declared parameters.
    const lg = state.loopGroups.get("lg")!;
    expect(lg).toBeDefined();
    expect(lg.maxTraversals).toBe(3);
    expect(lg.traversalCount).toBe(0);

    // Both nodes are tagged as loop-group members.
    expect(state.nodes.get("A")!.loopGroupId).toBe("lg");
    expect(state.nodes.get("B")!.loopGroupId).toBe("lg");
  });

  it("always-cycle dispatches both ready nodes and the first re-entry consumes a traversal", async () => {
    const { state, engine, fake } = buildEngine(alwaysCycleGraph(3));

    // dispatchReady dispatches both ready frontier nodes.
    await engine.dispatchReady();
    expect(fake.calls).toHaveLength(2);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // A answers first → A completed. B is still running, so no re-entry
    // happens — always-edge A→B activates but B is already running.
    await engine.onNodeSignalEmitted("A", "answer", "done-A");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);
    // No traversal consumed yet — only a loop re-entry counts.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(0);

    // B answers → always edge B→A re-enters A because A is Completed in a
    // loop group (the loop re-entry edge: Completed + loopGroupId → Ready).
    // This is a real loop re-entry driven by an `always` edge: one traversal
    // is consumed and a round is recorded.
    await engine.onNodeSignalEmitted("B", "answer", "done-B");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    // Traversal counter now 1 — the re-entry consumed a traversal.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // A was re-dispatched (third dispatch call: A again).
    expect(fake.calls.length).toBeGreaterThanOrEqual(3);
    // A round was recorded for this traversal.
    const rounds = state.loopGroups.get("lg")!.rounds ?? [];
    expect(rounds.length).toBe(1);
    expect(rounds[0].traversalCount).toBe(1);
    expect(rounds[0].nodeIds).toContain("A");
  });

  it("always-cycle bounded by max_traversals: answer-driven re-entry increments each round and retires the re-entry target done at cap", async () => {
    const { state, engine, fake } = buildEngine(alwaysCycleGraph(3));

    // dispatchReady dispatches both frontier nodes → A and B both Running.
    await engine.dispatchReady();
    expect(fake.calls).toHaveLength(2);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // Signal 1: A answers (B is still running, no re-entry).
    await engine.onNodeSignalEmitted("A", "answer", "a1");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(0);

    // Signal 2: B answers → edge B→A re-enters A → traversal 0→1.
    await engine.onNodeSignalEmitted("B", "answer", "b1");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    // Signal 3: A answers → edge A→B re-enters B → traversal 1→2.
    await engine.onNodeSignalEmitted("A", "answer", "a2");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Running);

    // Signal 4: B answers → edge B→A re-enters A → traversal 2→3 (cap).
    await engine.onNodeSignalEmitted("B", "answer", "b2");
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(3);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    // Signal 5: A answers → tries to re-enter B → cap (3 ≥ 3) → B is retired
    // done (markDone) instead of being re-entered.
    await engine.onNodeSignalEmitted("A", "answer", "a3");
    // Traversal counter unchanged at cap — no traversal consumed.
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(3);
    // B capped instead of being re-entered; A remains completed.
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("B")!.errorReason).toBe("max_traversals exhausted");
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);

    // rounds[] has three entries (one per consumed traversal).
    const rounds = state.loopGroups.get("lg")!.rounds ?? [];
    expect(rounds.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(rounds[i].traversalCount).toBe(i + 1);
    }

    // Graph reaches complete — no active nodes remain.
    expect(state.phase).toBe(EnginePhase.Complete);
  });

  it("always-cycle cap exhaustion fires the completion seam exactly once for the retired target (no duplicate on replay)", async () => {
    // Recording seam (engine-node-completion.test.ts pattern).
    const events: NodeCompletionEvent[] = [];
    const state = createEngineState(alwaysCycleGraph(3), "g-1");
    provision(state);
    const bridge = new SignalBridge();
    const engine = new AdvanceEngine({
      state,
      signalBridge: bridge,
      dispatch: new FakeDispatch(),
      onNodeCompletion: (e) => events.push(e),
    });

    // Drive the always cycle to the cap, mirroring the retirement test above.
    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("A", "answer", "a1");
    await engine.onNodeSignalEmitted("B", "answer", "b1");
    await engine.onNodeSignalEmitted("A", "answer", "a2");
    await engine.onNodeSignalEmitted("B", "answer", "b2");

    // Cap exhausted: A's next answer tries to re-enter B but the cap (3 ≥ 3)
    // retires B `completed → done` — the completion seam must surface B's
    // retirement exactly once, escalate-signal-with-actual-status convention
    // (mirroring _notifyPropagatedEscalations: signalType "escalate" with the
    // post-transition NodeStatus.Done and the machine-readable reason).
    await engine.onNodeSignalEmitted("A", "answer", "a3");
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("B")!.errorReason).toBe("max_traversals exhausted");

    const retired = events.filter(
      (e) => e.nodeId === "B" && e.signalType === "escalate",
    );
    expect(retired).toHaveLength(1);
    expect(retired[0].signalType).toBe("escalate");
    expect(retired[0].nodeStatus).toBe(NodeStatus.Done);
    expect(retired[0].payload).toBe("max_traversals exhausted");
    expect(retired[0].nodeAgent).toBe("a1");
    expect(retired[0].graphId).toBe("g-1");

    // Re-advancing / replaying the same answer on the already-completed A is a
    // no-op transition → no duplicate retirement event for B.
    await engine.onNodeSignalEmitted("A", "answer", "a3");
    expect(
      events.filter((e) => e.nodeId === "B" && e.signalType === "escalate"),
    ).toHaveLength(1);
  });

  it("executeLoopStep on always-cycle revise surfaces the exhaustion payload", () => {
    const { state } = buildEngine(alwaysCycleGraph(1));
    const b = state.nodes.get("B")!;
    b.status = NodeStatus.Completed;
    // max_traversals=1, traversalCount already at cap.
    state.loopGroups.get("lg")!.traversalCount = 1;

    const report = executeLoopStep(state, b, "revise_needed", {
      findings: ["unfinished"],
    });

    // Hard cap should fire: outcome is max_traversals_exhausted.
    expect(report.outcome).toBe("max_traversals_exhausted");
    expect(report.escalated).toContain("B");
    expect(report.escalatePayload).toEqual({
      reason: "max_traversals exhausted",
      unresolved: ["unfinished"],
      traversals: 1,
    });
    expect(state.nodes.get("B")!.errorReason).toBe("max_traversals exhausted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// per-node traversal counting
// ═══════════════════════════════════════════════════════════════════════════

describe("per-node traversal counting", () => {
  it("per-node traversalCount increments on each loop re-entry", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(5));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Drive 3 revise cycles. Each revise re-enters impl and increments both
    // the per-group traversalCount and the per-node impl.traversalCount.
    // Round 1.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["round 1"],
    });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    expect(state.nodes.get("impl")!.traversalCount).toBe(1);
    await engine.onNodeSignalEmitted("impl", "answer", "r1");

    // Round 2.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["round 2"],
    });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(2);
    expect(state.nodes.get("impl")!.traversalCount).toBe(2);
    await engine.onNodeSignalEmitted("impl", "answer", "r2");

    // Round 3 — per-node and per-group counts must agree (the invariant that
    // subtask 3 restored).
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["round 3"],
    });
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(3);
    expect(state.nodes.get("impl")!.traversalCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D2 regression — a loop member's non-converged answer must NOT forward-
// activate downstream nodes (the loop step already handled propagation).
// ═══════════════════════════════════════════════════════════════════════════

describe("engine-advance — answer downgrade skips forward activation (D2)", () => {
  it("review answer {verdict:'revise'} re-enters impl but leaves sink Pending", async () => {
    const { state, engine } = buildEngine(reviewLoopGraph(3));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // review answers with an unresolved verdict → the loop executor downgrades
    // it to revise semantics (outcome "revising"), re-entering impl.
    await engine.onNodeSignalEmitted("review", "answer", {
      verdict: "revise",
      findings: ["still needs work"],
    });

    // Revise re-entry happened: impl was re-marked ready and re-dispatched.
    expect(state.nodes.get("impl")!.status).toBe(NodeStatus.Running);
    // One traversal consumed by the downgrade (revise semantics).
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // Forward activation must be skipped: sink is NOT activated (regression —
    // before the fix the review→sink on_signal(answer) edge wrongly fired).
    expect(state.nodes.get("sink")!.status).toBe(NodeStatus.Pending);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H1 regression — a duplicate / replayed `revise_needed` on an already-
// terminal loop member must NOT re-run the loop step. The double-delivery
// seams (worker signal() + subscribeTaskTermination callback, or the
// race-guard synthetic replay) can deliver the same terminating signal twice;
// the first advances the node, the second is queued while the critical section
// is held and replayed by the drain. The replay's lifecycle transition is a
// no-op (the reviewer is already Completed), and the propagation side effects
// — traversal counting, convergence tracking, upstream re-entry — must be
// skipped for it (engine-advance _advance's `migrated` gate).
// ═══════════════════════════════════════════════════════════════════════════

describe("engine-advance — duplicate revise counts only one traversal (H1)", () => {
  it("a replayed revise_needed drained after the first does not double-count the traversal", async () => {
    const { state, engine, fake } = buildEngine(reviewLoopGraph(3));

    await engine.dispatchReady();
    await engine.onNodeSignalEmitted("entry", "answer", "seed");
    await engine.onNodeSignalEmitted("impl", "answer", "v1");

    // Hold impl's re-entry dispatch so review's first revise critical section
    // stays open (the re-entered impl is dispatched inside it).
    fake.hold("impl");
    const first = engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["fix 1a"],
    });

    // While review's section is held, the SAME node double-delivers the same
    // signal type (the H1 double-delivery seam). The lock is held → the second
    // is queued to pendingCompletions and re-advanced by the section's drain.
    await engine.onNodeSignalEmitted("review", "revise_needed", {
      findings: ["fix 1b"],
    });
    expect(state.pendingCompletions).toEqual(["review"]);

    fake.release("impl");
    await first;

    // The first revise consumed exactly one traversal; the replayed duplicate
    // must NOT consume another (regression — before the H1 guard the replay
    // re-ran executeLoopStep → incrementLoopTraversal a second time, draining
    // max_traversals at double speed).
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(1);
    // Exactly one round was recorded for the single real revision.
    expect(state.loopGroups.get("lg")!.rounds?.length).toBe(1);
    // impl was re-entered exactly once (initial dispatch + one revise re-entry) —
    // the duplicate replay must not re-dispatch it.
    expect(state.nodes.get("impl")!.sessionsSpawned).toBe(2);
    // review stays Completed from the first revise — the replay was a no-op
    // transition and skipped the stuck / exhaustion early-exits too.
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Completed);
    // The graph is still executing (impl running from the single re-entry).
    expect(state.phase).toBe(EnginePhase.Executing);
    expect(state.pendingCompletions).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D7b regression — a single-point always self-loop must never self-re-enter.
// Built directly via createEngineState+provision (bypasses the validator).
// ═══════════════════════════════════════════════════════════════════════════

describe("engine-advance — single-node always self-loop does not self-re-enter (D7b)", () => {
  it("answers once, dispatch count stays 1, phase reaches Complete", async () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "self-loop",
      nodes: [{ id: "A", agent: "a0", prompt: "node A" }],
      edges: [{ from: "A", to: "A", type: "always" }],
      loop_groups: [{ id: "lg", nodes: ["A"], max_traversals: 3 }],
    };
    const { state, engine, fake } = buildEngine(decl);

    // A is a root: the intra-group always self-edge is excluded from in-degree.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Ready);

    await engine.dispatchReady();
    expect(fake.calls).toHaveLength(1);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);

    // A answers once.
    await engine.onNodeSignalEmitted("A", "answer", "done");

    // No self re-entry: dispatch count stays 1, A does not return to Running.
    expect(fake.calls).toHaveLength(1);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Completed);
    // No traversal consumed (the self-loop edge was skipped).
    expect(state.loopGroups.get("lg")!.traversalCount).toBe(0);
    // The graph completes — no active nodes remain.
    expect(state.phase).toBe(EnginePhase.Complete);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Subtask 5 — dangling loop-group guard: a node whose loopGroupId names a
// group the declaration dropped must NOT be fabricated into `converged`.
// ═══════════════════════════════════════════════════════════════════════════

describe("loop-group executor — dangling loopGroupId (subtask 5)", () => {
  it("a revise_needed on a node with a dangling loopGroupId escalates instead of being swallowed as converged", () => {
    const { state } = buildEngine(reviewLoopGraph(3));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;
    // The group is gone from the runtime map (declaration dropped it) but the
    // node still carries the stale tag.
    state.loopGroups.delete("lg");
    expect(review.loopGroupId).toBe("lg");

    const report = executeLoopStep(state, review, "revise_needed", {
      findings: ["still needs work"],
    });

    // NOT silently swallowed as a fabricated converged outcome.
    expect(report.outcome).not.toBe("converged");
    // The node escalated — a plain revision with nowhere to re-enter.
    expect(report.escalated).toContain("review");
    expect(state.nodes.get("review")!.status).toBe(NodeStatus.Escalate);
    // The dangling tag is demoted so later signals take the non-loop path.
    expect(state.nodes.get("review")!.loopGroupId).toBeUndefined();
  });

  it("an escalate on a node with a dangling loopGroupId propagates forward (non-loop path)", () => {
    const { state } = buildEngine(convergeLoopGraph());
    const a = state.nodes.get("A")!;
    a.status = NodeStatus.Completed;
    state.loopGroups.delete("lg");

    const report = executeLoopStep(state, a, "escalate", { reason: "boom" });

    // Not swallowed as converged — worst-signal forward propagation ran.
    expect(report.outcome).toBe("escalating");
    expect(report.escalated.length).toBeGreaterThan(0);
    expect(state.nodes.get("A")!.loopGroupId).toBeUndefined();
  });

  it("an answer on a node with a dangling loopGroupId converges without touching the missing tracker", () => {
    const { state } = buildEngine(reviewLoopGraph(3));
    const review = state.nodes.get("review")!;
    review.status = NodeStatus.Completed;
    // review has a revise back-edge — the old code path would call
    // resetConvergenceTracker("lg") and throw on the missing group.
    state.loopGroups.delete("lg");

    const report = executeLoopStep(state, review, "answer", { verdict: "ok" });

    // Forward flow only — no throw, no convergence-tracker touch, no traversal.
    expect(report.outcome).toBe("converged");
    expect(state.nodes.get("review")!.loopGroupId).toBeUndefined();
    expect(report.traversals).toBe(0);
  });
});
