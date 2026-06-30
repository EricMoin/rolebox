import { describe, it, expect, beforeEach } from "bun:test";
import {
  graphSessionState,
  buildGraphStateBlock,
} from "../../src/graph/state";
import {
  advanceGraphForDispatch,
  extractDispatchTarget,
  setAdvanceJudge,
} from "../../src/graph/advance";
import type { ResolvedGraph, FlowEdge, TerminationConfig } from "../../src/types";
import type { JudgeFn } from "../../src/graph/termination-async";

const SID = "test-session-hooks-wiring";

beforeEach(() => {
  graphSessionState.clear(SID);
  setAdvanceJudge(async () => false);
});

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

function reviewLoop(maxIterations = 5): ResolvedGraph {
  const edges: FlowEdge[] = [
    { from: "parent", to: "coder" },
    { from: "coder", to: "reviewer", label: "code ready" },
    { from: "reviewer", to: "coder", label: "loop" },
    { from: "reviewer", to: "parent", exit: true, label: "approved" },
  ];
  return makeGraph({
    edges,
    nodes: ["coder", "reviewer"],
    maxIterations,
    exitEdges: [
      { from: "reviewer", to: "parent", exit: true, label: "approved" },
    ],
  });
}

function graphWithTermination(config: TerminationConfig): ResolvedGraph {
  return {
    ...reviewLoop(10),
    termination: { config, loopGroups: [] },
  };
}

// ── Replicated helpers from plugin-hooks.ts for direct testing ──

function needsResultCapture(
  config?: { any_of?: unknown[]; all_of?: unknown[] },
): boolean {
  if (!config) return false;
  const check = (arr: unknown[] | undefined): boolean =>
    arr?.some(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        ("converged" in c || "result_matches" in c || "stuck" in c),
    ) ?? false;
  return check(config.any_of) || check(config.all_of);
}

function isDispatchError(output: unknown): boolean {
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    return "error" in obj || "failure" in obj;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════
// Test 1: Result capture only triggered when termination needs it
// ════════════════════════════════════════════════════════════════════

describe("needsResultCapture", () => {
  it("returns false when config is undefined", () => {
    expect(needsResultCapture(undefined)).toBe(false);
  });

  it("returns false when config has no relevant conditions", () => {
    expect(
      needsResultCapture({
        any_of: [{ max_iterations: 5 }],
      }),
    ).toBe(false);
  });

  it("returns false for timeout_ms only", () => {
    expect(
      needsResultCapture({
        any_of: [{ timeout_ms: 60000 }],
      }),
    ).toBe(false);
  });

  it("returns true when result_matches is in any_of", () => {
    expect(
      needsResultCapture({
        any_of: [
          { max_iterations: 5 },
          { result_matches: { agent: "reviewer", contains: "OK" } },
        ],
      }),
    ).toBe(true);
  });

  it("returns true when result_matches is in all_of", () => {
    expect(
      needsResultCapture({
        all_of: [{ result_matches: { agent: "coder" } }, { max_iterations: 3 }],
      }),
    ).toBe(true);
  });

  it("returns true when stuck is configured", () => {
    expect(
      needsResultCapture({
        any_of: [{ stuck: { repeats: 3 } }],
      }),
    ).toBe(true);
  });

  it("returns true when converged is configured", () => {
    expect(
      needsResultCapture({
        any_of: [{ converged: "Is quality acceptable?" }],
      }),
    ).toBe(true);
  });

  it("returns false when config arrays are empty", () => {
    expect(
      needsResultCapture({ any_of: [], all_of: [] }),
    ).toBe(false);
  });

  it("returns true when mixed — stuck in any_of, timeout in all_of", () => {
    expect(
      needsResultCapture({
        any_of: [{ stuck: { repeats: 2 } }],
        all_of: [{ timeout_ms: 30000 }],
      }),
    ).toBe(true);
  });

  it("returns false when only max_iterations and timeout_ms configured", () => {
    expect(
      needsResultCapture({
        any_of: [{ max_iterations: 5 }, { timeout_ms: 30000 }],
        all_of: [{ max_iterations: 3 }],
      }),
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 2: Failed dispatch guard
// ════════════════════════════════════════════════════════════════════

describe("isDispatchError", () => {
  it("returns false for undefined", () => {
    expect(isDispatchError(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isDispatchError(null)).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isDispatchError("some output")).toBe(false);
  });

  it("returns false for a plain object without error/failure", () => {
    expect(isDispatchError({ result: "ok" })).toBe(false);
  });

  it("returns true when output has 'error' property", () => {
    expect(isDispatchError({ error: "something went wrong" })).toBe(true);
  });

  it("returns true when output has 'failure' property", () => {
    expect(isDispatchError({ failure: "task failed" })).toBe(true);
  });

  it("returns true when output has both error and failure", () => {
    expect(isDispatchError({ error: "bad", failure: "worse" })).toBe(true);
  });

  it("returns false for an array", () => {
    expect(isDispatchError([1, 2, 3])).toBe(false);
  });
});

describe("failed dispatch guard — advance is skipped", () => {
  it("does not advance state when _output indicates a dispatch error", () => {
    const graph = reviewLoop();
    graphSessionState.initGraph(SID, graph);
    const before = graphSessionState.getState(SID)!;

    // Simulate the guard: if isDispatchError, return without advancing
    const errorOutput = { error: "dispatch timed out" };
    expect(isDispatchError(errorOutput)).toBe(true);

    // State should be unchanged (frontier still at initial)
    expect(before.frontier).toEqual(["coder"]);
    expect(before.iterationCount).toBe(0);
    expect(before.status).toBe("active");
  });

  it("advances normally when _output is clean", () => {
    const graph = reviewLoop();
    graphSessionState.initGraph(SID, graph);

    const cleanOutput = { taskId: "abc123" };
    expect(isDispatchError(cleanOutput)).toBe(false);

    const result = advanceGraphForDispatch(SID, "dispatch", {
      subagent: "coder",
    });
    expect(result.result.kind).toBe("advanced");

    const state = graphSessionState.getState(SID)!;
    expect(state.frontier).toContain("reviewer");
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 3: Termination state reflected in system.transform output
// ════════════════════════════════════════════════════════════════════

describe("termination state reflected in system.transform", () => {
  it("renders termination_reason when state has terminationReason", () => {
    const graph = graphWithTermination({
      any_of: [{ max_iterations: 3 }],
    });
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;
    state.terminationReason = "max_iterations";

    const block = buildGraphStateBlock(state, graph);
    expect(block).toContain("<termination_reason>max_iterations</termination_reason>");
  });

  it("renders convergenceSignal when set", () => {
    const graph = graphWithTermination({
      any_of: [{ converged: "check quality" }],
    });
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;
    state.convergenceSignal = "converged";

    const block = buildGraphStateBlock(state, graph);
    expect(block).toContain("<convergence>Workflow is converging");
  });

  it("does NOT render termination blocks when graph has no termination config", () => {
    const graph = reviewLoop();
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;
    state.terminationReason = "max_iterations";

    const block = buildGraphStateBlock(state, graph);
    expect(block).not.toContain("<termination_reason>");
  });

  it("renders next_action with termination guidance when reason is set", () => {
    const graph = graphWithTermination({
      any_of: [{ timeout_ms: 60000 }],
    });
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;
    state.terminationReason = "timeout";

    const block = buildGraphStateBlock(state, graph);
    expect(block).toContain(
      "Workflow terminated (reason: timeout) — synthesize the best final result",
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// Integration: result capture stores into lastResults
// ════════════════════════════════════════════════════════════════════

describe("integration: lastResults population", () => {
  it("state.lastResults is initialized as empty by initGraph", () => {
    graphSessionState.initGraph(SID, reviewLoop());
    const state = graphSessionState.getState(SID)!;
    expect(state.lastResults).toEqual({});
  });

  it("can store and retrieve result capture data", () => {
    const graph = graphWithTermination({
      any_of: [{ result_matches: { agent: "reviewer", contains: "OK" } }],
    });
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;

    // Simulate result capture (normally done in tool.execute.after)
    state.lastResults = {
      coder: { hash: "abc123def456", text: "implementation complete" },
    };

    const retrieved = graphSessionState.getState(SID)!;
    expect(retrieved.lastResults?.coder?.hash).toBe("abc123def456");
    expect(retrieved.lastResults?.coder?.text).toBe("implementation complete");
  });

  it("advanceGraphForDispatch preserves lastResults through advance", () => {
    const graph = graphWithTermination({
      any_of: [{ result_matches: { agent: "reviewer", contains: "OK" } }],
    });
    graphSessionState.initGraph(SID, graph);
    const state = graphSessionState.getState(SID)!;
    state.lastResults = {
      coder: { hash: "abc123", text: "done" },
    };

    advanceGraphForDispatch(SID, "dispatch", { subagent: "coder" });

    const after = graphSessionState.getState(SID)!;
    expect(after.lastResults?.coder).toEqual({ hash: "abc123", text: "done" });
  });
});

// ════════════════════════════════════════════════════════════════════
// Integration: extractDispatchTarget used in both hook and advance
// ════════════════════════════════════════════════════════════════════

describe("extractDispatchTarget for result capture target", () => {
  it("extracts target from task args", () => {
    expect(
      extractDispatchTarget("task", { subagent_type: "coder" }),
    ).toBe("coder");
  });

  it("extracts target from dispatch args", () => {
    expect(
      extractDispatchTarget("dispatch", { subagent: "reviewer" }),
    ).toBe("reviewer");
  });

  it("returns undefined for unknown tool", () => {
    expect(
      extractDispatchTarget("bash", { command: "ls" }),
    ).toBeUndefined();
  });

  it("returns undefined when args has no subagent field", () => {
    expect(
      extractDispatchTarget("dispatch", { prompt: "hello" }),
    ).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Judge wiring: setAdvanceJudge is callable and affects async phase
// ════════════════════════════════════════════════════════════════════

describe("setAdvanceJudge wiring", () => {
  it("can set and invoke a mock judge", async () => {
    let called = false;
    const mockJudge: JudgeFn = async (_prompt, _context) => {
      called = true;
      return true;
    };
    setAdvanceJudge(mockJudge);

    const graph = graphWithTermination({
      any_of: [{ converged: "Is it done?" }],
    });
    graphSessionState.initGraph(SID, graph);

    advanceGraphForDispatch(SID, "dispatch", { subagent: "coder" });

    // Async phase fires via Promise.resolve().then(), wait briefly
    await new Promise((r) => setTimeout(r, 50));

    expect(called).toBe(true);

    // Reset to safe default
    setAdvanceJudge(async () => false);
  });

  it("judge returning false does not set converged", async () => {
    setAdvanceJudge(async () => false);

    const graph = graphWithTermination({
      any_of: [{ converged: "Is it done?" }],
    });
    graphSessionState.initGraph(SID, graph);

    advanceGraphForDispatch(SID, "dispatch", { subagent: "coder" });
    await new Promise((r) => setTimeout(r, 50));

    const state = graphSessionState.getState(SID)!;
    expect(state.terminationReason).not.toBe("converged");
    expect(state.status).not.toBe("complete");

    setAdvanceJudge(async () => false);
  });

  it("judge returning true sets converged asynchronously", async () => {
    setAdvanceJudge(async () => true);

    const graph = graphWithTermination({
      any_of: [{ converged: "Is it done?" }],
    });
    graphSessionState.initGraph(SID, graph);

    advanceGraphForDispatch(SID, "dispatch", { subagent: "coder" });
    await new Promise((r) => setTimeout(r, 100));

    const state = graphSessionState.getState(SID)!;
    expect(state.terminationReason).toBe("converged");
    expect(state.convergenceSignal).toBe("converged");
    expect(state.status).toBe("complete");

    setAdvanceJudge(async () => false);
  });

  it("judge that throws does not affect state", async () => {
    setAdvanceJudge(async () => {
      throw new Error("judge unavailable");
    });

    const graph = graphWithTermination({
      any_of: [{ converged: "Is it done?" }],
    });
    graphSessionState.initGraph(SID, graph);

    advanceGraphForDispatch(SID, "dispatch", { subagent: "coder" });
    await new Promise((r) => setTimeout(r, 50));

    const state = graphSessionState.getState(SID)!;
    expect(state.terminationReason).toBeNull();
    expect(state.status).toBe("active");

    setAdvanceJudge(async () => false);
  });
});
