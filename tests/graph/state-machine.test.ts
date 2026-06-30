import { describe, it, expect, beforeEach } from "bun:test";
import { graphSessionState } from "../../src/graph/state";
import type { ResolvedGraph, FlowEdge } from "../../src/types";

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

/** Review-loop: parent→coder→reviewer→coder (loop), reviewer→parent (exit) */
function reviewLoop(maxIterations = 3): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "coder" },
    { from: "coder", to: "reviewer" },
    { from: "reviewer", to: "coder", label: "loop" },
    { from: "reviewer", to: "parent", label: "exit", exit: true },
  ];
  return makeGraph({
    edges,
    nodes: ["coder", "reviewer"],
    maxIterations,
    exitEdges: [{ from: "reviewer", to: "parent", exit: true, label: "exit" }],
  });
}

/** Pipeline: parent→A→B→C→...→parent(exit) */
function pipeline(agents: string[]): ResolvedGraph {
  const edges: FlowEdge[] = [];
  edges.push({ from: "parent", to: agents[0] });
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i], to: agents[i + 1] });
  }
  const last = agents[agents.length - 1];
  edges.push({ from: last, to: "parent", exit: true });
  return makeGraph({
    edges,
    nodes: agents,
    exitEdges: [{ from: last, to: "parent", exit: true }],
  });
}

/** Loop-only graph with no exit edge: parent→step1→step2→step1 */
function loopOnly(maxIterations = 0): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "step1" },
    { from: "step1", to: "step2" },
    { from: "step2", to: "step1" },
  ];
  return makeGraph({
    edges,
    nodes: ["step1", "step2"],
    maxIterations,
    exitEdges: [],
  });
}

/** Custom flow with explicit back-edge for test 6 */
function backEdgeFlow(): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "alice" },
    { from: "alice", to: "bob" },
    { from: "bob", to: "alice", label: "rework" },
    { from: "bob", to: "parent", exit: true },
  ];
  return makeGraph({
    edges,
    nodes: ["alice", "bob"],
    maxIterations: 3,
    exitEdges: [{ from: "bob", to: "parent", exit: true }],
  });
}

// ── Session ID (shared singleton, cleared per test) ───────────────────────

const SID = "sm-baseline";

describe("GraphSessionState.initGraph + advanceStep baseline", () => {
  beforeEach(() => {
    graphSessionState.clear(SID);
  });

  // ── 1. Initial frontier from parent edges ───────────────────────────────

  it("initial frontier from parent edges (review-loop: parent→coder → frontier=[coder])", () => {
    graphSessionState.initGraph(SID, reviewLoop());

    const state = graphSessionState.getState(SID)!;
    expect(state.frontier).toEqual(["coder"]);
    expect(state.completed).toEqual([]);
    expect(state.iterationCount).toBe(0);
    expect(state.status).toBe("active");
  });

  // ── 2. Advance moves frontier→completed ────────────────────────────────

  it("advance moves coder→completed, frontier→[reviewer]", () => {
    graphSessionState.initGraph(SID, reviewLoop());

    const result = graphSessionState.advanceStep(SID, "coder");

    expect(result.kind).toBe("advanced");
    if (result.kind === "advanced") {
      expect(result.frontier).toEqual(["reviewer"]);
    }

    const state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["coder"]);
    expect(state.frontier).toEqual(["reviewer"]);
    expect(state.status).toBe("active");
  });

  // ── 3. off_route when agent not in frontier ─────────────────────────────

  it("returns off_route when dispatching agent not in frontier", () => {
    graphSessionState.initGraph(SID, reviewLoop());

    // Advance coder → frontier now [reviewer]
    graphSessionState.advanceStep(SID, "coder");

    // Second dispatch of coder — no longer in frontier
    const result = graphSessionState.advanceStep(SID, "coder");

    expect(result.kind).toBe("off_route");
    if (result.kind === "off_route") {
      expect(result.expected).toEqual(["reviewer"]);
      expect(result.got).toBe("coder");
    }

    // State must be unchanged
    const state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["coder"]);
    expect(state.frontier).toEqual(["reviewer"]);
  });

  // ── 4. unknown when agent not in graph nodes ────────────────────────────

  it("returns unknown when dispatching agent not in graph nodes", () => {
    graphSessionState.initGraph(SID, reviewLoop());

    const result = graphSessionState.advanceStep(SID, "nonexistent-agent");

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.got).toBe("nonexistent-agent");
    }

    // State unchanged
    const state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual([]);
    expect(state.frontier).toEqual(["coder"]);
    expect(state.status).toBe("active");
  });

  // ── 5. ignored when status is complete or exhausted ─────────────────────

  it("returns ignored when state status is complete", () => {
    graphSessionState.initGraph(SID, pipeline(["coder", "reviewer"]));

    // Walk the pipeline fully
    graphSessionState.advanceStep(SID, "coder");
    graphSessionState.advanceStep(SID, "reviewer");

    expect(graphSessionState.getState(SID)!.status).toBe("complete");

    const result = graphSessionState.advanceStep(SID, "coder");
    expect(result.kind).toBe("ignored");
  });

  it("returns ignored when state status is exhausted", () => {
    graphSessionState.initGraph(SID, loopOnly(0));

    // Exhaust by hitting the iteration cap
    graphSessionState.advanceStep(SID, "step1");
    graphSessionState.advanceStep(SID, "step2");

    expect(graphSessionState.getState(SID)!.status).toBe("exhausted");

    const result = graphSessionState.advanceStep(SID, "step1");
    expect(result.kind).toBe("ignored");
  });

  // ── 6. iterationCount on back-edge to completed node ────────────────────

  it("increments iterationCount on back-edge to completed node", () => {
    graphSessionState.initGraph(SID, backEdgeFlow());

    // alice→bob: alice is frontier
    graphSessionState.advanceStep(SID, "alice"); // frontier=[bob]

    // bob has a back-edge to alice (already completed) → iterationCount++
    const result = graphSessionState.advanceStep(SID, "bob");

    expect(result.kind).toBe("advanced");
    if (result.kind === "advanced") {
      expect(result.frontier).toContain("alice");
    }

    const state = graphSessionState.getState(SID)!;
    expect(state.iterationCount).toBe(1);
    expect(state.completed).toEqual(["alice", "bob"]);
    expect(state.frontier).toContain("alice");
    expect(state.status).toBe("active");
  });

  // ── 7. exhausted when iteration cap hit with no exit edge ───────────────

  it("returns exhausted when iteration cap hit with no exit edge", () => {
    graphSessionState.initGraph(SID, loopOnly(0));

    graphSessionState.advanceStep(SID, "step1"); // frontier=[step2]
    const result = graphSessionState.advanceStep(SID, "step2");

    // step2→step1: step1 in completed → iterCount=1 > 0 → cap hit
    // No exit edges → exhausted
    expect(result.kind).toBe("exhausted");

    const state = graphSessionState.getState(SID)!;
    expect(state.status).toBe("exhausted");
    expect(state.iterationCount).toBe(1);
    expect(state.frontier).toEqual([]);
  });

  // ── 8. complete when frontier empties via exit edge ─────────────────────

  it("returns completed when frontier empties via exit edge", () => {
    graphSessionState.initGraph(SID, pipeline(["coder", "reviewer"]));

    graphSessionState.advanceStep(SID, "coder"); // frontier=[reviewer]
    const result = graphSessionState.advanceStep(SID, "reviewer");

    // reviewer→parent(exit): frontier becomes empty → complete
    expect(result.kind).toBe("completed");

    const state = graphSessionState.getState(SID)!;
    expect(state.status).toBe("complete");
    expect(state.completed).toEqual(["coder", "reviewer"]);
    expect(state.frontier).toEqual([]);
  });

  // ── 9. Multiple steps through pipeline topology ─────────────────────────

  it("advances through 3-agent pipeline to completion", () => {
    graphSessionState.initGraph(SID, pipeline(["researcher", "writer", "editor"]));

    // Step 1: researcher
    const r1 = graphSessionState.advanceStep(SID, "researcher");
    expect(r1.kind).toBe("advanced");
    let state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["researcher"]);
    expect(state.frontier).toEqual(["writer"]);
    expect(state.status).toBe("active");

    // Step 2: writer
    const r2 = graphSessionState.advanceStep(SID, "writer");
    expect(r2.kind).toBe("advanced");
    state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["researcher", "writer"]);
    expect(state.frontier).toEqual(["editor"]);
    expect(state.status).toBe("active");

    // Step 3: editor → exit edge → complete
    const r3 = graphSessionState.advanceStep(SID, "editor");
    expect(r3.kind).toBe("completed");
    state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["researcher", "writer", "editor"]);
    expect(state.frontier).toEqual([]);
    expect(state.status).toBe("complete");
  });

  // ── 10. completed.includes dedup behavior ───────────────────────────────

  it("second dispatch of same agent returns off_route (dedup via frontier filter)", () => {
    graphSessionState.initGraph(SID, reviewLoop());

    // First dispatch of coder succeeds
    const r1 = graphSessionState.advanceStep(SID, "coder");
    expect(r1.kind).toBe("advanced");

    let state = graphSessionState.getState(SID)!;
    expect(state.completed).toEqual(["coder"]);
    expect(state.completed.filter((s) => s === "coder")).toHaveLength(1);

    // Second dispatch of coder is filtered out by off_route check
    // (coder was removed from frontier after first advance)
    const r2 = graphSessionState.advanceStep(SID, "coder");
    expect(r2.kind).toBe("off_route");
    if (r2.kind === "off_route") {
      expect(r2.expected).toEqual(["reviewer"]);
      expect(r2.got).toBe("coder");
    }

    // completed must still have exactly one "coder" entry
    state = graphSessionState.getState(SID)!;
    expect(state.completed.filter((s) => s === "coder")).toHaveLength(1);
    expect(state.completed).toEqual(["coder"]);
    expect(state.frontier).toEqual(["reviewer"]);
  });
});
