import { describe, it, expect } from "bun:test";
import { evaluateSync } from "../../src/graph/termination";
import type {
  GraphExecutionState,
  ResolvedGraph,
  ResolvedTermination,
} from "../../src/types";

function makeState(overrides: {
  loopCounters?: Record<string, number>;
  lastResults?: Record<string, { hash: string; text: string }>;
  loopStartTimeMs?: number;
} = {}): GraphExecutionState {
  return {
    frontier: [],
    completed: [],
    iterationCount: 0,
    status: "active",
    ...overrides,
  } as unknown as GraphExecutionState;
}

function makeTermination(
  config: ResolvedTermination["config"],
  loopGroups: ResolvedTermination["loopGroups"] = [],
): ResolvedTermination {
  return { config, loopGroups };
}

function makeGraph(
  termination?: ResolvedTermination,
): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    maxIterations: 5,
    exitEdges: [],
    loopGroups: termination?.loopGroups ?? [],
    termination,
  };
}

describe("per-loop-group max_iterations", () => {
  it("fires when any loop-group counter >= per-loop maxIterations", () => {
    const state = makeState({ loopCounters: { "a": 3, "b": 1 } });
    const graph = makeGraph(
      makeTermination(
        { any_of: [{ max_iterations: 3 }] },
        [
          { id: "a", nodes: ["a"], backEdges: [], maxIterations: 3 },
          { id: "b", nodes: ["b"], backEdges: [], maxIterations: 5 },
        ],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBe("max_iterations");
  });

  it("returns null when no loop-group has reached its cap", () => {
    const state = makeState({ loopCounters: { "a": 1, "b": 1 } });
    const graph = makeGraph(
      makeTermination(
        { any_of: [{ max_iterations: 3 }] },
        [
          { id: "a", nodes: ["a"], backEdges: [], maxIterations: 3 },
          { id: "b", nodes: ["b"], backEdges: [], maxIterations: 5 },
        ],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });

  it("skips loop groups without a per-loop maxIterations", () => {
    const state = makeState({ loopCounters: { "a": 3 } });
    const graph = makeGraph(
      makeTermination(
        { any_of: [{ max_iterations: 3 }] },
        [
          { id: "a", nodes: ["a"], backEdges: [], maxIterations: 3 },
          { id: "b", nodes: ["b"], backEdges: [] },
        ],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBe("max_iterations");
  });

  it("returns null when loopCounters is missing from state (v1 back-compat)", () => {
    const state = { frontier: [], completed: [], iterationCount: 0, status: "active" } as GraphExecutionState;
    const graph = makeGraph(
      makeTermination(
        { any_of: [{ max_iterations: 3 }] },
        [{ id: "a", nodes: ["a"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });
});

describe("timeout_ms", () => {
  it("fires when elapsed time >= threshold", () => {
    const state = makeState({ loopStartTimeMs: 1000 });
    const graph = makeGraph(
      makeTermination({ any_of: [{ timeout_ms: 500 }] }),
    );

    expect(evaluateSync(state, graph, 2000)).toBe("timeout");
  });

  it("returns null when elapsed time < threshold", () => {
    const state = makeState({ loopStartTimeMs: 1000 });
    const graph = makeGraph(
      makeTermination({ any_of: [{ timeout_ms: 5000 }] }),
    );

    expect(evaluateSync(state, graph, 2000)).toBeNull();
  });

  it("falls back to now when loopStartTimeMs is absent (elapsed=0)", () => {
    const state = makeState();
    const graph = makeGraph(
      makeTermination({ any_of: [{ timeout_ms: 0 }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBe("timeout");
  });
});

describe("stuck", () => {
  it("fires when any hash appears >= repeats times across lastResults", () => {
    const state = makeState({
      lastResults: {
        alice: { hash: "abc123", text: "same output" },
        bob: { hash: "abc123", text: "same output" },
        carol: { hash: "abc123", text: "same output" },
      },
    });
    const graph = makeGraph(
      makeTermination({ any_of: [{ stuck: { repeats: 3 } }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBe("stuck");
  });

  it("returns null when no hash repeats enough times", () => {
    const state = makeState({
      lastResults: {
        alice: { hash: "abc123", text: "a" },
        bob: { hash: "def456", text: "b" },
      },
    });
    const graph = makeGraph(
      makeTermination({ any_of: [{ stuck: { repeats: 2 } }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });

  it("returns null when lastResults is missing (v1 back-compat)", () => {
    const state = { frontier: [], completed: [], iterationCount: 0, status: "active" } as GraphExecutionState;
    const graph = makeGraph(
      makeTermination({ any_of: [{ stuck: { repeats: 2 } }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });
});

describe("any_of", () => {
  it("returns the first satisfied condition's reason", () => {
    const state = makeState({ loopCounters: { "grp": 5 } });
    const graph = makeGraph(
      makeTermination(
        {
          any_of: [
            { max_iterations: 3 },
            { timeout_ms: 1000 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBe("max_iterations");
  });

  it("skips non-satisfied conditions until one fires", () => {
    const state = makeState({ loopCounters: { "grp": 1 }, loopStartTimeMs: 0 });
    const graph = makeGraph(
      makeTermination(
        {
          any_of: [
            { max_iterations: 3 },
            { timeout_ms: 100 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 500)).toBe("timeout");
  });

  it("returns null when no any_of condition is satisfied", () => {
    const state = makeState();
    const graph = makeGraph(
      makeTermination({ any_of: [{ timeout_ms: 10000 }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });
});

describe("all_of", () => {
  it("returns highest-priority reason when ALL conditions are met", () => {
    const state = makeState({ loopCounters: { "grp": 5 }, loopStartTimeMs: 0 });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { max_iterations: 3 },
            { timeout_ms: 100 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 500)).toBe("max_iterations");
  });

  it("returns null when NOT all conditions are met", () => {
    const state = makeState({ loopCounters: { "grp": 5 } });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { max_iterations: 3 },
            { timeout_ms: 10000 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
  });
});

describe("all_of progressive", () => {
  it("returns null when only some conditions are met", () => {
    const state = makeState({
      loopCounters: { "grp": 3 },
      loopStartTimeMs: 1000,
    });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { max_iterations: 3 },
            { timeout_ms: 5000 },
            { stuck: { repeats: 2 } },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 1000)).toBeNull();
  });

  it("fires only when the last condition becomes satisfied", () => {
    const state = makeState({
      loopCounters: { "grp": 5 },
      loopStartTimeMs: 1000,
    });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { max_iterations: 3 },
            { timeout_ms: 500 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 3000)).toBe("max_iterations");
  });
});

describe("empty/undefined termination", () => {
  it("returns null when graph has no termination", () => {
    expect(evaluateSync(makeState(), makeGraph(undefined), 0)).toBeNull();
  });

  it("returns null when termination has no any_of or all_of", () => {
    expect(evaluateSync(makeState(), makeGraph(makeTermination({})), 0)).toBeNull();
  });

  it("returns null when termination has empty any_of and all_of", () => {
    expect(
      evaluateSync(makeState(), makeGraph(makeTermination({ any_of: [], all_of: [] })), 0),
    ).toBeNull();
  });
});

describe("asyncResults", () => {
  it("uses asyncResults.converged for converged condition", () => {
    const state = makeState();
    const graph = makeGraph(
      makeTermination({ any_of: [{ converged: "any" }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
    expect(evaluateSync(state, graph, 0, { converged: true })).toBe("converged");
  });

  it("uses asyncResults.resultMatch for result_matches condition", () => {
    const state = makeState();
    const graph = makeGraph(
      makeTermination({ any_of: [{ result_matches: { agent: "alice" } }] }),
    );

    expect(evaluateSync(state, graph, 0)).toBeNull();
    expect(evaluateSync(state, graph, 0, { resultMatch: true })).toBe("result_match");
  });

  it("asyncResults falsey values do NOT fire conditions", () => {
    const state = makeState();
    const graph = makeGraph(
      makeTermination({ any_of: [{ converged: "any" }] }),
    );

    expect(evaluateSync(state, graph, 0, { converged: false })).toBeNull();
  });
});

describe("priority ordering", () => {
  it("converged beats all others", () => {
    const state = makeState({
      loopCounters: { "grp": 5 },
      loopStartTimeMs: 0,
      lastResults: {
        alice: { hash: "abc", text: "x" },
        bob: { hash: "abc", text: "x" },
      },
    });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { converged: "any" },
            { result_matches: { agent: "alice" } },
            { stuck: { repeats: 2 } },
            { max_iterations: 3 },
            { timeout_ms: 100 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(
      evaluateSync(state, graph, 500, { converged: true, resultMatch: true }),
    ).toBe("converged");
  });

  it("result_match beats stuck", () => {
    const state = makeState({
      lastResults: {
        alice: { hash: "abc", text: "x" },
        bob: { hash: "abc", text: "x" },
      },
    });
    const graph = makeGraph(
      makeTermination({
        all_of: [
          { stuck: { repeats: 2 } },
          { result_matches: { agent: "alice" } },
        ],
      }),
    );

    expect(
      evaluateSync(state, graph, 0, { resultMatch: true }),
    ).toBe("result_match");
  });

  it("stuck beats max_iterations", () => {
    const state = makeState({
      loopCounters: { "grp": 5 },
      lastResults: {
        alice: { hash: "abc", text: "x" },
        bob: { hash: "abc", text: "x" },
      },
    });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { max_iterations: 3 },
            { stuck: { repeats: 2 } },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 0)).toBe("stuck");
  });

  it("max_iterations beats timeout", () => {
    const state = makeState({
      loopCounters: { "grp": 5 },
      loopStartTimeMs: 0,
    });
    const graph = makeGraph(
      makeTermination(
        {
          all_of: [
            { timeout_ms: 100 },
            { max_iterations: 3 },
          ],
        },
        [{ id: "grp", nodes: ["x"], backEdges: [], maxIterations: 3 }],
      ),
    );

    expect(evaluateSync(state, graph, 500)).toBe("max_iterations");
  });
});
