import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EdgePayload, NodeRuntimeState, EngineState } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  collectUpstreamResults,
  evaluateJoin,
  getJoinStrategy,
  type JoinVerdict,
} from "../../src/graph/engine/join-evaluator.ts";
import { markReady, markRunning } from "../../src/graph/engine/node-lifecycle.ts";
import { mergeFanInContext } from "../../src/graph/engine/join-evaluator.ts";
import {
  cancelPendingUpstreams,
  type CancelDispatchPort,
} from "../../src/graph/engine/cascade-canceller.ts";
import { cancelNodes, expandLoopMembers } from "../../src/graph/engine/cancellation.ts";

// ── Fake cancel seam ────────────────────────────────────────────────────────

/**
 * Records the dispatch-task cancellations issued by the cascade, and can be
 * told to reject (return `false`) to exercise the fire-and-forget path without
 * awaiting. The canceller never awaits the ack, so the promise resolution here
 * is only observable through the recorded calls.
 */
class FakeCancelPort implements CancelDispatchPort {
  calls: string[] = [];
  async cancelTask(taskId: string): Promise<boolean> {
    this.calls.push(taskId);
    return true;
  }
}

// ── Fixture builders ────────────────────────────────────────────────────────

/** A diamond: root → b → sink, root → c → sink. `sink` converges on {b, c}. */
function diamondGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "diamond",
    nodes: [
      { id: "root", agent: "a1", prompt: "p1" },
      { id: "b", agent: "a2", prompt: "p2" },
      { id: "c", agent: "a3", prompt: "p3" },
      { id: "sink", agent: "a4", prompt: "p4" },
    ],
    edges: [
      { from: "root", to: "b", type: "always" },
      { from: "root", to: "c", type: "always" },
      { from: "b", to: "sink", type: "always" },
      { from: "c", to: "sink", type: "always" },
    ],
  };
}

/** A diamond whose sink declares a specific join strategy. */
function diamondWithJoin(strategy: "all" | "any" | "quorum", quorum?: number): GraphDeclaration {
  const g = diamondGraph();
  const sink = g.nodes.find((n) => n.id === "sink")!;
  sink.join = strategy === "quorum" ? { strategy: "quorum", quorum } : { strategy };
  return g;
}

/** An EdgePayload recorded for a source node (defaults to `answer`). */
function payload(fromNode: string, fromSignal = "answer"): EdgePayload {
  return {
    fromNode,
    fromSignal,
    result: `result-${fromNode}`,
    artifacts: [`artifact-${fromNode}`],
    budgetConsumed: { tokens: 100, cost: 0.01, sessions: 1 },
  };
}

interface Rig {
  state: EngineState;
  sink: NodeRuntimeState;
  port: FakeCancelPort;
}

/**
 * Provision a declaration and force the sink's upstream nodes `b` and `c`
 * into `running` with dispatch task ids, so they are live, cancellable
 * upstreams that have not yet produced a payload.
 */
function buildRig(decl: GraphDeclaration): Rig {
  const state = createEngineState(decl, "g-1");
  provision(state);
  setRunning(state, "b", "task-b");
  setRunning(state, "c", "task-c");
  return {
    state,
    sink: state.nodes.get("sink")!,
    port: new FakeCancelPort(),
  };
}

/** Transition a node into `running`, assigning a dispatch task id. */
function setRunning(state: EngineState, id: string, taskId: string): void {
  const node = state.nodes.get(id)!;
  if (node.status === NodeStatus.Pending) markReady(state, node);
  markRunning(state, node, { dispatchTaskId: taskId, dispatchSessionId: `sess-${id}` });
}

// ── satisfied verdict: cancel the still-outstanding upstreams ───────────────

describe("cancelPendingUpstreams — satisfied verdict", () => {
  it("cancels the still-running upstreams to cancelled → done", () => {
    // `any` join: b answers (recorded, resolved) → satisfied while c is running.
    const { state, sink, port } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b"));

    const verdict = evaluateJoin(state, sink);
    expect(verdict.kind).toBe("satisfied");

    const report = cancelPendingUpstreams(state, sink, verdict, port);

    expect(report.cancelled).toEqual(["c"]);
    expect(report.alreadyResolved).toEqual(["b"]);
    // The resolved upstream (b) is untouched — still running.
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Running);
    // The cancelled upstream (c) reached the terminal `done` state.
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Done);
    // Its dispatch task was cancelled fire-and-forget.
    expect(port.calls).toEqual(["task-c"]);
  });

  it("cancels every outstanding upstream under a satisfied quorum", () => {
    // quorum:1 with 3 upstreams would be ideal, but the diamond has {b, c}.
    // Use a quorum:1 diamond where the first answer satisfies while the other
    // sibling is still running.
    const { state, sink, port } = buildRig(diamondWithJoin("quorum", 1));
    collectUpstreamResults(state, sink, payload("b"));

    expect(evaluateJoin(state, sink).kind).toBe("satisfied");

    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    expect(report.cancelled).toEqual(["c"]);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Done);
  });

  it("is a no-op on the convergence node's own upstream topology when all resolved", () => {
    // `all` satisfied — both b and c answered → nothing outstanding to cancel.
    const { state, sink, port } = buildRig(diamondGraph());
    collectUpstreamResults(state, sink, payload("b"));
    collectUpstreamResults(state, sink, payload("c"));

    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    expect(report.cancelled).toEqual([]);
    expect(report.alreadyResolved).toEqual(["b", "c"]);
    expect(port.calls).toEqual([]);
    // Both upstreams remain exactly as they were (running), untouched.
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Running);
  });

  it("does not require a cancel seam (lifecycle-only retirement)", () => {
    const { state, sink } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b"));

    // No dispatch port passed → still retires c to `done`, just no cancel call.
    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink));

    expect(report.cancelled).toEqual(["c"]);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Done);
  });
});

// ── failed verdict: cancel when the join can never resolve ──────────────────

describe("cancelPendingUpstreams — failed verdict", () => {
  it("cancels outstanding upstreams when 'all' aborts on a non-answer signal", () => {
    const { state, sink, port } = buildRig(diamondGraph()); // default join: all
    // b escalates → `all` fails immediately while c is still running.
    collectUpstreamResults(state, sink, payload("b", "escalate"));

    const verdict = evaluateJoin(state, sink);
    expect(verdict.kind).toBe("failed");

    const report = cancelPendingUpstreams(state, sink, verdict, port);

    expect(report.cancelled).toEqual(["c"]);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Done);
    expect(port.calls).toEqual(["task-c"]);
  });

  it("cancels outstanding upstreams when a quorum becomes impossible", () => {
    const { state, sink, port } = buildRig(diamondWithJoin("quorum", 2));
    // c escalates while b is still running → answer=0, pending=1 → 0+1 < 2
    // → quorum impossible, and b is still outstanding.
    collectUpstreamResults(state, sink, payload("c", "escalate"));

    const verdict = evaluateJoin(state, sink);
    expect(verdict.kind).toBe("failed");

    const report = cancelPendingUpstreams(state, sink, verdict, port);

    // The still-pending upstream (b) is retired; the failed one (c) is retained.
    expect(report.cancelled).toEqual(["b"]);
    expect(report.alreadyResolved).toEqual(["c"]);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Running); // retained
    expect(port.calls).toEqual(["task-b"]);
  });
});

// ── waiting verdict: strict no-op ───────────────────────────────────────────

describe("cancelPendingUpstreams — waiting verdict", () => {
  it("cancels nothing while the join is still pending", () => {
    const { state, sink, port } = buildRig(diamondGraph()); // all: nothing answered
    expect(evaluateJoin(state, sink).kind).toBe("waiting");

    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    expect(report).toEqual({ cancelled: [], alreadyResolved: [] });
    expect(port.calls).toEqual([]);
    // Neither upstream was touched — both still running.
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Running);
  });

  it("waits while a partial failure still leaves the join reachable", () => {
    // `any`: b escalated (recorded), c still running and could still answer.
    const { state, sink, port } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b", "escalate"));

    expect(evaluateJoin(state, sink).kind).toBe("waiting");

    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    expect(report.cancelled).toEqual([]);
    expect(port.calls).toEqual([]);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Running); // untouched
  });
});

// ── partial-failure retention: signals are not dropped ──────────────────────

describe("partial-failure retention", () => {
  it("retains escalate signals in upstreamResults when the join allows continuation", () => {
    // `any`: b escalated, c answers → satisfied despite the partial failure.
    const { state, sink, port } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b", "escalate"));
    collectUpstreamResults(state, sink, payload("c"));

    const before = sink.upstreamResults.size;
    const report = cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    // The cancelled cascade must not drop recorded partial-failure signals.
    expect(sink.upstreamResults.size).toBe(before);
    expect(sink.upstreamResults.get("b")!.fromSignal).toBe("escalate");
    // All upstreams resolved → nothing left to cancel.
    expect(report.cancelled).toEqual([]);
    expect(port.calls).toEqual([]);

    // The escalate entry survives into the fan-in context for diagnostics.
    const ctx = mergeFanInContext(sink.upstreamResults);
    const bSource = ctx.sources.find((s) => s.node === "b");
    expect(bSource?.signal).toBe("escalate");
    expect(bSource?.result).toBe("result-b");
  });
});

// ── contract details ────────────────────────────────────────────────────────

describe("cancelPendingUpstreams — contract", () => {
  it("retires cancelled nodes through the cancelled → done lifecycle", () => {
    const { state, sink, port } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b"));
    cancelPendingUpstreams(state, sink, evaluateJoin(state, sink), port);

    // The lifecycle is exercised: the node passed through `cancelled` and
    // landed on the terminal `done` state (design §3.3 step 2).
    const c = state.nodes.get("c")!;
    expect(c.status).toBe(NodeStatus.Done);
    // Cancellation reason is recorded for diagnostics.
    expect(c.errorReason).toContain("cancelled by join cascade");
  });

  it("never touches upstreams that already produced a payload", () => {
    const { state, sink, port } = buildRig(diamondWithJoin("any"));
    collectUpstreamResults(state, sink, payload("b"));
    collectUpstreamResults(state, sink, payload("c", "revise_needed"));

    const verdict = evaluateJoin(state, sink); // satisfied (b answered)
    const report = cancelPendingUpstreams(state, sink, verdict, port);

    expect(report.cancelled).toEqual([]);
    expect(report.alreadyResolved).toEqual(["b", "c"]);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("c")!.status).toBe(NodeStatus.Running);
    expect(port.calls).toEqual([]);
  });

  it("reports a clean empty result for a root node with no upstream edges", () => {
    const { state, port } = buildRig(diamondGraph());
    // The root has no upstream edges → immediately satisfied, nothing to cancel.
    const root = state.nodes.get("root")!;
    const verdict: JoinVerdict = { kind: "satisfied", reasons: ["no upstream"] };
    const report = cancelPendingUpstreams(state, root, verdict, port);
    expect(report).toEqual({ cancelled: [], alreadyResolved: [] });
    expect(port.calls).toEqual([]);
  });

  it("resolves getJoinStrategy as the same strategy the canceller acts on", () => {
    const { state, sink } = buildRig(diamondWithJoin("quorum", 1));
    expect(getJoinStrategy(state, sink)).toEqual({ quorum: 1 });
    // sanity: the quorum:1 verdict is satisfied on the first answer
    collectUpstreamResults(state, sink, payload("b"));
    expect(evaluateJoin(state, sink).kind).toBe("satisfied");
  });
});

// ── cancelNodes — scoped / cascade primitive ────────────────────────────────

/**
 * A 4-node linear chain A → B → C → D. Provision makes A the ready root and
 * B/C/D pending. Statuses are set directly for the fixtures below.
 */
function chainGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "chain",
    nodes: [
      { id: "A", agent: "a1", prompt: "p1" },
      { id: "B", agent: "a2", prompt: "p2" },
      { id: "C", agent: "a3", prompt: "p3" },
      { id: "D", agent: "a4", prompt: "p4" },
    ],
    edges: [
      { from: "A", to: "B", type: "always" },
      { from: "B", to: "C", type: "always" },
      { from: "C", to: "D", type: "always" },
    ],
  };
}

function chainRig(): { state: EngineState; port: FakeCancelPort } {
  const state = createEngineState(chainGraph(), "g-cancel");
  provision(state);
  return { state, port: new FakeCancelPort() };
}

/** Force every node in the chain to `running` with a dispatch task id. */
function runAllChain(state: EngineState): void {
  for (const id of ["A", "B", "C", "D"]) {
    setRunning(state, id, `task-${id}`);
  }
}

describe("cancelNodes — scoped (cascade=false)", () => {
  it("cancels ONLY the target; dependents keep their status", () => {
    const { state, port } = chainRig();
    runAllChain(state);

    const report = cancelNodes(state, ["B"], {}, port);

    // B retired; A (upstream) and C/D (downstream) untouched.
    expect(report.cancelled).toEqual(["B"]);
    expect(report.skipped).toEqual([]);
    expect(report.cancelCalls).toEqual(["task-B"]);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Running);
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Running);
  });

  it("reports the expanded target set and dedupes repeated ids", () => {
    const { state, port } = chainRig();
    runAllChain(state);

    const report = cancelNodes(state, ["C", "C"], {}, port);

    expect(report.target).toEqual(["C"]);
    expect(report.cancelled).toEqual(["C"]);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Done);
  });

  it("removes the cancelled node from the frontier", () => {
    const { state, port } = chainRig();
    // After provision, A is the ready root in the frontier.
    expect(state.frontier).toContain("A");

    const report = cancelNodes(state, ["A"], {}, port);

    expect(report.cancelled).toEqual(["A"]);
    expect(state.frontier).not.toContain("A");
  });
});

describe("cancelNodes — cascade (cascade=true)", () => {
  it("cancels the target AND every transitive downstream dependent", () => {
    const { state, port } = chainRig();
    runAllChain(state);

    const report = cancelNodes(state, ["A"], { cascade: true }, port);

    expect(new Set(report.cancelled)).toEqual(new Set(["A", "B", "C", "D"]));
    for (const id of ["A", "B", "C", "D"]) {
      expect(state.nodes.get(id)!.status).toBe(NodeStatus.Done);
    }
    // Every running dependent's dispatch task was handed to cancelTask.
    expect(new Set(report.cancelCalls)).toEqual(
      new Set(["task-A", "task-B", "task-C", "task-D"]),
    );
  });

  it("cascades only downstream — upstreams are left untouched", () => {
    const { state, port } = chainRig();
    runAllChain(state);

    const report = cancelNodes(state, ["B"], { cascade: true }, port);

    expect(new Set(report.cancelled)).toEqual(new Set(["B", "C", "D"]));
    // A is upstream of B — not in the forward closure — and survives.
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Running);
  });

  it("tears down dispatch tasks without awaiting (fire-and-forget)", () => {
    const { state, port } = chainRig();
    // A running with a task; C ready (no task yet); D pending.
    setRunning(state, "A", "task-A");
    // lifecycle: B stays pending.

    const report = cancelNodes(state, ["A"], { cascade: true }, port);

    // A had a task → cancelCalls; B/C/D had none → no cancel calls for them.
    expect(report.cancelCalls).toEqual(["task-A"]);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Done);
  });

  it("does not require a cancel seam (lifecycle-only retirement)", () => {
    const { state } = chainRig();
    runAllChain(state);

    const report = cancelNodes(state, ["A"], { cascade: true });

    // No dispatch port passed → still retires the whole downstream to `done`.
    expect(new Set(report.cancelled)).toEqual(new Set(["A", "B", "C", "D"]));
    expect(report.cancelCalls).toEqual([]);
  });
});

describe("cancelNodes — loop-target member expansion", () => {
  /** A loop group {R, X} (R → X back into R) with a downstream Y fed by X. */
  function loopGraph(): GraphDeclaration {
    return {
      version: 2,
      name: "loop",
      nodes: [
        { id: "R", agent: "a1", prompt: "p1" },
        { id: "X", agent: "a2", prompt: "p2" },
        { id: "Y", agent: "a3", prompt: "p3" },
      ],
      edges: [
        { from: "R", to: "X", type: "always" },
        { from: "X", to: "R", type: "on_signal", signal_filter: ["revise_needed"] },
        { from: "X", to: "Y", type: "always" },
      ],
      loop_groups: [{ id: "lg1", nodes: ["R", "X"], max_traversals: 3 }],
    };
  }

  function loopRig(): { state: EngineState; port: FakeCancelPort } {
    const state = createEngineState(loopGraph(), "g-loop");
    provision(state);
    return { state, port: new FakeCancelPort() };
  }

  it("expands a loop-member target to the full loop member set", () => {
    const { state, port } = loopRig();
    // R (root, ready) and X pending both tagged to lg1; Y pending downstream.
    setRunning(state, "R", "task-R");

    const report = cancelNodes(state, ["R"], {}, port);

    // R is a loop member → the whole member set {R, X} is cancelled.
    expect(report.target).toEqual(["R", "X"]);
    expect(new Set(report.cancelled)).toEqual(new Set(["R", "X"]));
    expect(state.nodes.get("R")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("X")!.status).toBe(NodeStatus.Done);
    // Y is NOT a loop member and NOT downstream of R directly — untouched
    // without cascade.
    expect(state.nodes.get("Y")!.status).toBe(NodeStatus.Pending);
  });

  it("expands the loop member set AND cascades to its downstream", () => {
    const { state, port } = loopRig();
    setRunning(state, "R", "task-R");

    const report = cancelNodes(state, ["R"], { cascade: true }, port);

    expect(new Set(report.cancelled)).toEqual(new Set(["R", "X", "Y"]));
    expect(state.nodes.get("Y")!.status).toBe(NodeStatus.Done);
  });
});

describe("cancelNodes — untouched nodes (completed / blocked / terminal)", () => {
  it("reports completed, blocked, and terminal targets as skipped", () => {
    const { state, port } = chainRig();
    // A terminal (done), B blocked (needs_approval), C completed, D pending.
    const a = state.nodes.get("A")!;
    const b = state.nodes.get("B")!;
    const c = state.nodes.get("C")!;
    const d = state.nodes.get("D")!;
    a.status = NodeStatus.Done;
    b.status = NodeStatus.Blocked;
    c.status = NodeStatus.Completed;

    const report = cancelNodes(state, ["A", "B", "C"], { cascade: true }, port);

    // A/B/C are not cancellable → skipped; only D (a downstream dependent,
    // pending) is actually cancelled.
    expect(new Set(report.skipped)).toEqual(new Set(["A", "B", "C"]));
    expect(report.cancelled).toEqual(["D"]);
    expect(state.nodes.get("A")!.status).toBe(NodeStatus.Done);
    expect(state.nodes.get("B")!.status).toBe(NodeStatus.Blocked);
    expect(state.nodes.get("C")!.status).toBe(NodeStatus.Completed);
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Done);
    // No cancellable node carried a dispatch task → no cancel calls.
    expect(report.cancelCalls).toEqual([]);
  });

  it("retires running/ready/pending dependents but leaves terminal ones", () => {
    const { state, port } = chainRig();
    // A running, B ready, C pending, D terminal (done).
    setRunning(state, "A", "task-A");
    state.nodes.get("D")!.status = NodeStatus.Done;

    const report = cancelNodes(state, ["A"], { cascade: true }, port);

    expect(new Set(report.cancelled)).toEqual(new Set(["A", "B", "C"]));
    expect(report.skipped).toEqual(["D"]);
    expect(state.nodes.get("D")!.status).toBe(NodeStatus.Done); // untouched
    expect(report.cancelCalls).toEqual(["task-A"]);
  });

  it("records a cancellation reason for diagnostics", () => {
    const { state, port } = chainRig();
    runAllChain(state);

    cancelNodes(state, ["B"], { cascade: true }, port);

    expect(state.nodes.get("B")!.errorReason).toContain("cancelled by scoped cascade");
  });
});

describe("expandLoopMembers — unit tests", () => {
  function loopGraph(): GraphDeclaration {
    return {
      version: 2,
      name: "expand-test",
      nodes: [
        { id: "R", agent: "a1", prompt: "p1" },
        { id: "X", agent: "a2", prompt: "p2" },
        { id: "Z", agent: "a3", prompt: "p3" },
      ],
      edges: [
        { from: "R", to: "X", type: "always" },
      ],
      loop_groups: [{ id: "lg1", nodes: ["R", "X"], max_traversals: 3 }],
    };
  }

  it("expands a loop-member target to the full loop member set", () => {
    const state = createEngineState(loopGraph(), "g-exp");
    provision(state);

    const result = expandLoopMembers(state, ["R"]);
    expect(result).toEqual(["R", "X"]);
  });

  it("returns non-loop members as-is", () => {
    const state = createEngineState(loopGraph(), "g-exp2");
    provision(state);

    const result = expandLoopMembers(state, ["Z"]);
    expect(result).toEqual(["Z"]);
  });

  it("deduplicates when multiple loop members from the same group are requested", () => {
    const state = createEngineState(loopGraph(), "g-exp3");
    provision(state);

    const result = expandLoopMembers(state, ["R", "X"]);
    expect(result).toEqual(["R", "X"]);
  });

  it("handles missing loop declaration gracefully — treats as non-loop member", () => {
    const state = createEngineState(loopGraph(), "g-exp4");
    provision(state);
    // Remove the loop declaration from the graph while the node still
    // carries its loopGroupId (set during provision).
    state.graphDeclaration.loop_groups = undefined;

    const result = expandLoopMembers(state, ["R"]);
    // R has loopGroupId but no matching declaration → treated as non-loop member.
    expect(result).toEqual(["R"]);
  });

  it("handles unknown node IDs — returned as-is (no loopGroupId to expand)", () => {
    const state = createEngineState(loopGraph(), "g-exp5");
    provision(state);

    const result = expandLoopMembers(state, ["nonexistent"]);
    expect(result).toEqual(["nonexistent"]);
  });
});

