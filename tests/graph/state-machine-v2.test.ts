import { describe, it, expect, beforeEach } from "bun:test";
import { graphSessionState } from "../../src/graph/state";
import type { ResolvedGraph, FlowEdge, LoopGroup } from "../../src/types";

// ── Fixture builders ──────────────────────────────────────────────────────

function makeGraph(overrides?: Partial<ResolvedGraph>): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    maxIterations: 3,
    exitEdges: [],
    loopGroups: [],
    ...overrides,
  };
}

/** Single review-loop with termination: coder↔reviewer back-edge, max_iterations */
function singleLoopWithTerm(maxIter: number): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "coder" },
    { from: "coder", to: "reviewer" },
    { from: "reviewer", to: "coder", label: "loop" },
    { from: "reviewer", to: "parent", label: "exit", exit: true },
  ];
  const lg: LoopGroup = {
    id: "coder,reviewer",
    nodes: ["coder", "reviewer"],
    backEdges: [{ from: "reviewer", to: "coder", label: "loop" }],
    maxIterations: maxIter,
  };
  return makeGraph({
    edges,
    nodes: ["coder", "reviewer"],
    maxIterations: 100,
    exitEdges: [{ from: "reviewer", to: "parent", exit: true, label: "exit" }],
    loopGroups: [lg],
    termination: {
      config: { any_of: [{ max_iterations: maxIter }] },
      loopGroups: [lg],
    },
  });
}

/** Two independent loops: alpha↔beta and gamma↔delta, both reachable from parent */
function twoIndependentLoops(): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "alpha" },
    { from: "parent", to: "gamma" },
    { from: "alpha", to: "beta" },
    { from: "beta", to: "alpha", label: "loop1" },
    { from: "beta", to: "parent", exit: true },
    { from: "gamma", to: "delta" },
    { from: "delta", to: "gamma", label: "loop2" },
    { from: "delta", to: "parent", exit: true },
  ];
  const loop1: LoopGroup = {
    id: "alpha,beta",
    nodes: ["alpha", "beta"],
    backEdges: [{ from: "beta", to: "alpha", label: "loop1" }],
  };
  const loop2: LoopGroup = {
    id: "gamma,delta",
    nodes: ["gamma", "delta"],
    backEdges: [{ from: "delta", to: "gamma", label: "loop2" }],
  };
  return makeGraph({
    edges,
    nodes: ["alpha", "beta", "gamma", "delta"],
    maxIterations: 100,
    exitEdges: [
      { from: "beta", to: "parent", exit: true },
      { from: "delta", to: "parent", exit: true },
    ],
    loopGroups: [loop1, loop2],
    termination: {
      config: { any_of: [{ max_iterations: 100 }] },
      loopGroups: [loop1, loop2],
    },
  });
}

/** Simple pipeline without termination (legacy-compatible) */
function simplePipeline(): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "step1" },
    { from: "step1", to: "step2" },
    { from: "step2", to: "parent", exit: true },
  ];
  return makeGraph({
    edges,
    nodes: ["step1", "step2"],
    exitEdges: [{ from: "step2", to: "parent", exit: true }],
  });
}

// ── Session ID ────────────────────────────────────────────────────────────

const SID = "v2-test";

describe("GraphSessionState v2 — per-loop counters + sync termination", () => {
  beforeEach(() => {
    graphSessionState.clear(SID);
  });

  // ── 1. Per-loop counter increments on back-edge ─────────────────────────

  it("increments per-loop counter on back-edge while keeping global iterationCount", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(3));

    // coder → reviewer (no back-edge)
    graphSessionState.advanceStep(SID, "coder");

    // reviewer → coder (back-edge: reviewer→coder is in loopGroup backEdges)
    graphSessionState.advanceStep(SID, "reviewer");

    const state = graphSessionState.getState(SID)!;
    expect(state.loopCounters).toBeDefined();
    expect(state.loopCounters!["coder,reviewer"]).toBe(1);
    expect(state.iterationCount).toBe(1);
    expect(state.status).toBe("active");
  });

  // ── 2. loopStartTimeMs on first back-edge ──────────────────────────────

  it("sets loopStartTimeMs on first back-edge iteration", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(3));

    // First advance (coder): no back-edge → no loopStartTimeMs yet
    graphSessionState.advanceStep(SID, "coder");
    let state = graphSessionState.getState(SID)!;
    expect(state.loopStartTimeMs).toBeUndefined();

    // Second advance (reviewer): back-edge detected → set loopStartTimeMs
    graphSessionState.advanceStep(SID, "reviewer");
    state = graphSessionState.getState(SID)!;
    expect(state.loopStartTimeMs).toBeDefined();
    expect(state.loopStartTimeMs!).toBeGreaterThan(0);
    expect(typeof state.loopStartTimeMs).toBe("number");
  });

  // ── 3. Sync termination sets reason + status (exhausted) ───────────────

  it("sets terminationReason and status=exhausted when max_iterations per-loop cap is hit", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(1));

    // First loop iteration
    graphSessionState.advanceStep(SID, "coder");

    // reviewer→coder back-edge: loop counter becomes 1 >= maxIterations=1
    const result = graphSessionState.advanceStep(SID, "reviewer");

    const state = graphSessionState.getState(SID)!;
    expect(state.terminationReason).toBe("max_iterations");
    expect(state.status).toBe("exhausted");
    expect(result.kind).toBe("exhausted");
  });

  // ── 4. Termination fires before frontier-empty check ───────────────────

  it("returns exhausted from termination even when frontier is non-empty", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(1));

    graphSessionState.advanceStep(SID, "coder");
    const result = graphSessionState.advanceStep(SID, "reviewer");

    // frontier may still have "coder" from the back-edge, but termination wins
    expect(result.kind).toBe("exhausted");

    const state = graphSessionState.getState(SID)!;
    expect(state.status).toBe("exhausted");
    expect(state.terminationReason).toBe("max_iterations");
  });

  // ── 5. Two independent loops have separate counters ────────────────────

  it("tracks per-loop counters independently across two separate loop groups", () => {
    graphSessionState.initGraph(SID, twoIndependentLoops());

    // Advance alpha → beta
    graphSessionState.advanceStep(SID, "alpha");
    let state = graphSessionState.getState(SID)!;
    expect(state.frontier).toContain("gamma");
    expect(state.frontier).toContain("beta");

    // Advance beta (back-edge beta→alpha fires for loop1)
    graphSessionState.advanceStep(SID, "beta");
    state = graphSessionState.getState(SID)!;
    expect(state.loopCounters!["alpha,beta"]).toBe(1);
    expect(state.loopCounters!["gamma,delta"] ?? 0).toBe(0);
    expect(state.frontier).toContain("alpha");  // re-entered via back-edge

    // Advance gamma → delta
    graphSessionState.advanceStep(SID, "gamma");
    state = graphSessionState.getState(SID)!;
    expect(state.frontier).toContain("delta");

    // Advance delta (back-edge delta→gamma fires for loop2)
    graphSessionState.advanceStep(SID, "delta");
    state = graphSessionState.getState(SID)!;
    expect(state.loopCounters!["alpha,beta"]).toBe(1); // unchanged
    expect(state.loopCounters!["gamma,delta"]).toBe(1); // now incremented
  });

  // ── 6. isComplete returns true when terminationReason is set ───────────

  it("isComplete returns true when terminationReason is set", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(1));

    graphSessionState.advanceStep(SID, "coder");
    graphSessionState.advanceStep(SID, "reviewer");

    const state = graphSessionState.getState(SID)!;
    expect(state.terminationReason).toBe("max_iterations");
    expect(graphSessionState.isComplete(SID)).toBe(true);
  });

  // ── 7. Legacy semantics unchanged without termination config ───────────

  it("preserves legacy behavior when graph has no termination config", () => {
    graphSessionState.initGraph(SID, simplePipeline());

    // Walk the pipeline normally
    const r1 = graphSessionState.advanceStep(SID, "step1");
    expect(r1.kind).toBe("advanced");

    const r2 = graphSessionState.advanceStep(SID, "step2");
    expect(r2.kind).toBe("completed");

    const state = graphSessionState.getState(SID)!;
    expect(state.status).toBe("complete");
    expect(state.terminationReason).toBeNull();
    expect(state.iterationCount).toBe(0); // no loops, no iteration counter
    expect(state.loopCounters).toEqual({});
  });

  // ── 8. No await/Promise in advanceStep (synchronous) ───────────────────

  it("advanceStep result is not a Promise", () => {
    graphSessionState.initGraph(SID, simplePipeline());
    const result = graphSessionState.advanceStep(SID, "step1");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.kind).toBe("advanced");
  });

  // ── 9. initiates v2 fields in initGraph ────────────────────────────────

  it("initializes v2 fields with safe defaults in initGraph", () => {
    graphSessionState.initGraph(SID, singleLoopWithTerm(3));

    const state = graphSessionState.getState(SID)!;
    expect(state.loopCounters).toEqual({});
    expect(state.lastResults).toEqual({});
    expect(state.terminationReason).toBeNull();
    expect(state.correctionCount).toBe(0);
    expect(state.status).toBe("active");
  });

  // ── 10. correctionCount field is present ───────────────────────────────

  it("exposes correctionCount as a number on the state", () => {
    graphSessionState.initGraph(SID, simplePipeline());

    const state = graphSessionState.getState(SID)!;
    expect(typeof state.correctionCount).toBe("number");
    expect(state.correctionCount).toBe(0);
  });
});
