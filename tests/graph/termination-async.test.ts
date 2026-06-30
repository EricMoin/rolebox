import { describe, it, expect } from "bun:test";
import { evaluateAsync, type JudgeFn } from "../../src/graph/termination-async.ts";
import { hashResult, normalizeResult } from "../../src/graph/result-capture.ts";
import type {
  GraphExecutionState,
} from "../../src/graph/state.ts";
import type { ResolvedGraph, ResolvedTermination, TerminationConfig, FlowEdge } from "../../src/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeState(overrides?: Partial<GraphExecutionState>): GraphExecutionState {
  return {
    frontier: [],
    completed: [],
    iterationCount: 0,
    status: "active",
    ...overrides,
  };
}

function makeGraph(overrides?: Partial<ResolvedGraph>): ResolvedGraph {
  return {
    edges: [] as FlowEdge[],
    nodes: [],
    maxIterations: 3,
    exitEdges: [] as FlowEdge[],
    loopGroups: [],
    ...overrides,
  };
}

function makeTermination(config: TerminationConfig): ResolvedTermination {
  return { config, loopGroups: [] };
}

/** Judge that always returns the given value */
function fixedJudge(value: boolean): JudgeFn {
  return async () => value;
}

/** Judge that throws */
function throwingJudge(): JudgeFn {
  return async () => {
    throw new Error("judge unavailable");
  };
}

/** Judge that records calls */
function recordingJudge(
  results: boolean[],
): { judge: JudgeFn; calls: { prompt: string; context: string }[] } {
  const calls: { prompt: string; context: string }[] = [];
  let idx = 0;
  const judge: JudgeFn = async (prompt, context) => {
    calls.push({ prompt, context });
    const val = results[idx] ?? false;
    idx++;
    return val;
  };
  return { judge, calls };
}

function storedResult(agent: string, text: string): Record<string, { hash: string; text: string }> {
  return { [agent]: { hash: hashResult(text), text } };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("evaluateAsync", () => {
  // ─── converged ──────────────────────────────────────────────────────

  describe("converged", () => {
    it("judge returns true → converged=true", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ converged: "is the analysis complete?" }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(true),
      });

      expect(result.converged).toBe(true);
      expect(result.resultMatch).toBe(false);
    });

    it("judge returns false → converged=false", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ converged: "is analysis done?" }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.converged).toBe(false);
      expect(result.resultMatch).toBe(false);
    });

    it("judge throws → converged=false (no throw propagation)", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ converged: "check convergence" }],
        }),
      });

      // Must not throw
      const result = await evaluateAsync(state, graph, {
        judge: throwingJudge(),
      });

      expect(result.converged).toBe(false);
      expect(result.resultMatch).toBe(false);
    });

    it("passes nlCondition and context to judge", async () => {
      const state = makeState({
        completed: ["coder", "reviewer"],
        iterationCount: 2,
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ converged: "task complete?" }],
        }),
      });

      const { judge, calls } = recordingJudge([true]);
      await evaluateAsync(state, graph, { judge });

      expect(calls.length).toBe(1);
      expect(calls[0].prompt).toBe("task complete?");
      expect(calls[0].context).toContain("iterationCount: 2");
    });

    it("multiple converged conditions in any_of: any true wins", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [
            { converged: "cond A" },
            { converged: "cond B" },
            { converged: "cond C" },
          ],
        }),
      });

      // Second one returns true
      const { judge } = recordingJudge([false, true, false]);
      const result = await evaluateAsync(state, graph, { judge });

      expect(result.converged).toBe(true);
    });

    it("no converged conditions → converged=false", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", contains: "done" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(true),
      });

      expect(result.converged).toBe(false);
    });

    it("no termination config → both false", async () => {
      const state = makeState();
      const graph = makeGraph();

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(true),
      });

      expect(result.converged).toBe(false);
      expect(result.resultMatch).toBe(false);
    });
  });

  // ─── result_matches ─────────────────────────────────────────────────

  describe("result_matches", () => {
    it("contains matches → resultMatch=true", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "the task is done successfully"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", contains: "done" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
      expect(result.converged).toBe(false);
    });

    it("contains does not match → resultMatch=false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "the task failed"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", contains: "success" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("regex matches → resultMatch=true", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "build passed in 12.3s"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", regex: "passed in \\d+" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("regex does not match → resultMatch=false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "build failed"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", regex: "passed" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("invalid regex → resultMatch=false (no throw)", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "some output"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", regex: "[invalid" } }],
        }),
      });

      // Must not throw
      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("score_gte passes when score meets threshold", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "Code review score: 85"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", score_gte: 80 } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("score_gte fails when score below threshold", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "Code review score: 65"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", score_gte: 80 } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("score_gte parses 'score: 85' format from result", async () => {
      const state = makeState({
        lastResults: storedResult("reviewer", "Quality check complete. score: 92"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "reviewer", score_gte: 90 } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("score_gte: no score in text → resultMatch=false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "task completed, no score here"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", score_gte: 50 } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("score_gte: non-numeric score → resultMatch=false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "score: high"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", score_gte: 50 } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("no_changes true when hash matches text", async () => {
      const text = "consistent output";
      const state = makeState({
        lastResults: {
          coder: { hash: hashResult(text), text },
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", no_changes: true } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("no_changes false when hash differs from text hash", async () => {
      const state = makeState({
        lastResults: {
          coder: { hash: "abc123def456", text: "some output" },
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", no_changes: true } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("no_changes uses normalizeResult for comparison", async () => {
      const text = "  hello   world  \n  extra  ";
      const normalized = normalizeResult(text);
      const state = makeState({
        lastResults: {
          coder: { hash: hashResult(normalized), text },
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", no_changes: true } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("missing agent result → resultMatch=false", async () => {
      const state = makeState({
        lastResults: storedResult("other_agent", "some output"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [{ result_matches: { agent: "coder", contains: "test" } }],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("multiple result_matches conditions for different agents", async () => {
      const state = makeState({
        lastResults: {
          ...storedResult("coder", "code complete"),
          ...storedResult("reviewer", "review passed"),
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [
            { result_matches: { agent: "coder", contains: "complete" } },
            { result_matches: { agent: "reviewer", contains: "passed" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("all_of: all result_matches must pass", async () => {
      const state = makeState({
        lastResults: {
          ...storedResult("coder", "code done"),
          ...storedResult("reviewer", "review done"),
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          all_of: [
            { result_matches: { agent: "coder", contains: "done" } },
            { result_matches: { agent: "reviewer", contains: "done" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(true);
    });

    it("all_of: one fails → resultMatch=false", async () => {
      const state = makeState({
        lastResults: {
          ...storedResult("coder", "code done"),
          ...storedResult("reviewer", "review incomplete"),
        },
      });
      const graph = makeGraph({
        termination: makeTermination({
          all_of: [
            { result_matches: { agent: "coder", contains: "done" } },
            { result_matches: { agent: "reviewer", contains: "done" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.resultMatch).toBe(false);
    });

    it("combined: any_of result_matches true + converged false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "task complete"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [
            { converged: "is finalized?" },
            { result_matches: { agent: "coder", contains: "complete" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.converged).toBe(false);
      expect(result.resultMatch).toBe(true);
    });

    it("combined: converged true + result_matches false", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "in progress"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [
            { converged: "done?" },
            { result_matches: { agent: "coder", contains: "complete" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(true),
      });

      expect(result.converged).toBe(true);
      expect(result.resultMatch).toBe(false);
    });

    it("both converged and result_match true simultaneously", async () => {
      const state = makeState({
        lastResults: storedResult("coder", "task done"),
      });
      const graph = makeGraph({
        termination: makeTermination({
          any_of: [
            { converged: "done?" },
            { result_matches: { agent: "coder", contains: "done" } },
          ],
        }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(true),
      });

      expect(result.converged).toBe(true);
      expect(result.resultMatch).toBe(true);
    });

    it("empty any_of → both false", async () => {
      const state = makeState();
      const graph = makeGraph({
        termination: makeTermination({ any_of: [] }),
      });

      const result = await evaluateAsync(state, graph, {
        judge: fixedJudge(false),
      });

      expect(result.converged).toBe(false);
      expect(result.resultMatch).toBe(false);
    });
  });
});
