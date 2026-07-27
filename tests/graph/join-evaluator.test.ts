import { describe, it, expect } from "bun:test";
import { JoinStrategy } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EdgePayload, FanInContext, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  joinSatisfied,
  evaluateJoin,
  collectUpstreamResults,
  mergeFanInContext,
  getUpstreamNodeIds,
  getJoinStrategy,
} from "../../src/graph/engine/join-evaluator.ts";

// ── Fixture builders ──────────────────────────────────────────────────────

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

/** A diamond sink declared with a specific join strategy. */
function diamondWithJoin(strategy: "all" | "any" | "quorum", quorum?: number): GraphDeclaration {
  const g = diamondGraph();
  const sink = g.nodes.find((n) => n.id === "sink")!;
  sink.join =
    strategy === "quorum"
      ? { strategy: "quorum", quorum }
      : { strategy };
  return g;
}

/** Build an answer EdgePayload from a source node. */
function answerPayload(fromNode: string, opts: Partial<EdgePayload> = {}): EdgePayload {
  return {
    fromNode,
    fromSignal: "answer",
    result: `result-${fromNode}`,
    artifacts: [`artifact-${fromNode}`],
    budgetConsumed: { tokens: 100, cost: 0.01, sessions: 1 },
    ...opts,
  };
}

/** Convenience: provision a declaration and return the requested node state. */
function provisionedNode(decl: GraphDeclaration, nodeId: string): NodeRuntimeState {
  const state = createEngineState(decl, "g-1");
  provision(state);
  return state.nodes.get(nodeId)!;
}

// ── getUpstreamNodeIds / getJoinStrategy ────────────────────────────────────

describe("getUpstreamNodeIds", () => {
  it("returns distinct upstream source ids for a convergence node", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    expect(getUpstreamNodeIds(state, state.nodes.get("sink")!)).toEqual(["b", "c"]);
  });

  it("returns an empty array for a root node with no upstream edges", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    expect(getUpstreamNodeIds(state, state.nodes.get("root")!)).toEqual([]);
  });
});

describe("getJoinStrategy", () => {
  it("defaults to 'all' when no join config is declared", () => {
    const sink = provisionedNode(diamondGraph(), "sink");
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    expect(getJoinStrategy(state, sink)).toBe(JoinStrategy.All);
  });

  it("resolves explicit 'all'", () => {
    const decl = diamondWithJoin("all");
    const state = createEngineState(decl, "g-1");
    provision(state);
    expect(getJoinStrategy(state, state.nodes.get("sink")!)).toBe(JoinStrategy.All);
  });

  it("resolves 'any' to its strategy value (types exist; evaluation is Phase 2)", () => {
    const decl = diamondWithJoin("any");
    const state = createEngineState(decl, "g-1");
    provision(state);
    expect(getJoinStrategy(state, state.nodes.get("sink")!)).toBe(JoinStrategy.Any);
  });

  it("resolves 'quorum' to { quorum: N }", () => {
    const decl = diamondWithJoin("quorum", 2);
    const state = createEngineState(decl, "g-1");
    provision(state);
    expect(getJoinStrategy(state, state.nodes.get("sink")!)).toEqual({ quorum: 2 });
  });
});

// ── joinSatisfied ──────────────────────────────────────────────────────────

describe("joinSatisfied (strategy: all)", () => {
  function sinkState() {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    return state;
  }

  it("is immediately satisfied for a node with no upstream edges", () => {
    const state = sinkState();
    const root = state.nodes.get("root")!;
    // root's upstreamResults is empty, yet it has no upstream edges → satisfied.
    expect(joinSatisfied(state, root)).toBe(true);
  });

  it("returns false with empty upstream results", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    expect(joinSatisfied(state, sink)).toBe(false);
  });

  it("returns false when only part of the upstream has arrived", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(false);
  });

  it("returns true when every upstream source has answered", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("c"));
    expect(joinSatisfied(state, sink)).toBe(true);
  });

  it("returns false when an upstream recorded a non-answer signal", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "escalate" }));
    expect(joinSatisfied(state, sink)).toBe(false);
  });

  it("is order-independent — arrival order does not affect the verdict", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("c"));
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(true);
  });

  it("always returns a consistent boolean (strict boolean, not truthy)", () => {
    const state = sinkState();
    const sink = state.nodes.get("sink")!;
    expect(typeof joinSatisfied(state, sink)).toBe("boolean");
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("c"));
    expect(typeof joinSatisfied(state, sink)).toBe("boolean");
  });
});

describe("joinSatisfied (strategy: any)", () => {
  function anyState() {
    const decl = diamondWithJoin("any");
    const state = createEngineState(decl, "g-1");
    provision(state);
    return state;
  }

  it("is satisfied as soon as one upstream answers, others still pending", () => {
    const state = anyState();
    const sink = state.nodes.get("sink")!;
    expect(joinSatisfied(state, sink)).toBe(false);
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(true);
  });

  it("is satisfied by the first answer even if a sibling already failed", () => {
    const state = anyState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "escalate" }));
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(true);
  });

  it("waits while some upstream failed and some remain pending (none answered)", () => {
    const state = anyState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b", { fromSignal: "escalate" }));
    // c still pending — it could still answer, so join is not yet decided.
    expect(joinSatisfied(state, sink)).toBe(false);
  });

  it("fails only when every upstream failed before any answer arrived", () => {
    const state = anyState();
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b", { fromSignal: "escalate" }));
    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "revise_needed" }));
    expect(joinSatisfied(state, sink)).toBe(false);
    expect(evaluateJoin(state, sink).kind).toBe("failed");
  });
});

describe("joinSatisfied (strategy: quorum:N)", () => {
  function quorumState(n: number) {
    const decl = diamondWithJoin("quorum", n);
    const state = createEngineState(decl, "g-1");
    provision(state);
    return state;
  }

  it("quorum:1 behaves like any — satisfied on the first answer", () => {
    const state = quorumState(1);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(true);
  });

  it("quorum:2 waits until the second answer arrives", () => {
    const state = quorumState(2);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(joinSatisfied(state, sink)).toBe(false); // 1/2, c pending → waiting
    collectUpstreamResults(state, sink, answerPayload("c"));
    expect(joinSatisfied(state, sink)).toBe(true); // 2/2
  });

  it("quorum:2 fails when a sibling failure makes quorum impossible", () => {
    const state = quorumState(2);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "escalate" }));
    // answer=1, pending=0 → 1+0 < 2 → impossible → failed.
    expect(joinSatisfied(state, sink)).toBe(false);
    expect(evaluateJoin(state, sink).kind).toBe("failed");
  });

  it("quorum:2 keeps waiting when one answered and one is still pending", () => {
    const state = quorumState(2);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    // answer=1, pending=1 → 1+1 = 2, not < 2 → still reachable → waiting.
    expect(evaluateJoin(state, sink).kind).toBe("waiting");
    expect(joinSatisfied(state, sink)).toBe(false);
  });

  it("fails immediately when the declared quorum exceeds total upstream count", () => {
    const state = quorumState(3); // only {b, c} = 2 upstream sources
    const sink = state.nodes.get("sink")!;
    expect(evaluateJoin(state, sink).kind).toBe("failed");
    expect(joinSatisfied(state, sink)).toBe(false);
  });
});

describe("evaluateJoin (discriminated verdict)", () => {
  it("reports satisfied immediately for a root node with no upstream edges", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    const root = state.nodes.get("root")!;
    expect(evaluateJoin(state, root)).toEqual({
      kind: "satisfied",
      reasons: expect.any(Array),
    });
  });

  it("reports waiting for 'all' when partially answered, failed when any fails", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    const sink = state.nodes.get("sink")!;

    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(evaluateJoin(state, sink).kind).toBe("waiting");

    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "escalate" }));
    // 'all' aborts on the first non-answer signal → failed (worst signal).
    const verdict = evaluateJoin(state, sink);
    expect(verdict.kind).toBe("failed");
    expect(verdict.reasons.join(" ")).toContain("escalate/revise");
  });

  it("returns human-readable reasons on the failed verdict", () => {
    const decl = diamondWithJoin("quorum", 2);
    const state = createEngineState(decl, "g-1");
    provision(state);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("c", { fromSignal: "escalate" }));
    const verdict = evaluateJoin(state, sink);
    expect(verdict.kind).toBe("failed");
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("tracks collectUpstreamResults-driven recomputation via the boolean projection", () => {
    const decl = diamondWithJoin("any");
    const state = createEngineState(decl, "g-1");
    provision(state);
    const sink = state.nodes.get("sink")!;
    expect(sink.joinSatisfied).toBe(false);
    collectUpstreamResults(state, sink, answerPayload("b"));
    // cached flag stays in sync with joinSatisfied
    expect(sink.joinSatisfied).toBe(true);
    expect(evaluateJoin(state, sink).kind).toBe("satisfied");
  });
});

// ── collectUpstreamResults ──────────────────────────────────────────────────

describe("collectUpstreamResults", () => {
  it("records the payload and keeps joinSatisfied in sync", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    const sink = state.nodes.get("sink")!;

    expect(sink.joinSatisfied).toBe(false);

    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(sink.upstreamResults.get("b")?.result).toBe("result-b");
    expect(sink.joinSatisfied).toBe(false);

    collectUpstreamResults(state, sink, answerPayload("c"));
    expect(sink.upstreamResults.get("c")?.result).toBe("result-c");
    expect(sink.joinSatisfied).toBe(true);
  });
});

// ── mergeFanInContext ───────────────────────────────────────────────────────

describe("mergeFanInContext", () => {
  function merged(): FanInContext {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(
      state,
      sink,
      answerPayload("b", {
        result: "b-output",
        artifacts: ["f1.ts", "shared.ts"],
        budgetConsumed: { tokens: 4000, cost: 0.008, sessions: 1 },
      }),
    );
    collectUpstreamResults(
      state,
      sink,
      answerPayload("c", {
        result: "c-output",
        artifacts: ["f2.ts", "shared.ts"], // shared.ts appears in both sources
        budgetConsumed: { tokens: 3000, cost: 0.005, sessions: 1 },
      }),
    );
    return mergeFanInContext(sink.upstreamResults);
  }

  it("produces the correct sources array with per-node provenance", () => {
    const ctx = merged();
    expect(ctx.sources).toEqual([
      { node: "b", signal: "answer", result: "b-output" },
      { node: "c", signal: "answer", result: "c-output" },
    ]);
  });

  it("deduplicates merged_artifacts while preserving first-appearance order", () => {
    const ctx = merged();
    expect(ctx.merged_artifacts).toEqual(["f1.ts", "shared.ts", "f2.ts"]);
  });

  it("sums budget_consumed_total across sources", () => {
    const ctx = merged();
    expect(ctx.budget_consumed_total.tokens).toBe(7000);
    expect(ctx.budget_consumed_total.sessions).toBe(2);
    expect(ctx.budget_consumed_total.cost).toBeCloseTo(0.013, 10);
  });

  it("returns empty aggregates for an empty result map", () => {
    const ctx = mergeFanInContext(new Map());
    expect(ctx).toEqual({
      sources: [],
      merged_artifacts: [],
      budget_consumed_total: { tokens: 0, cost: 0, sessions: 0 },
    });
  });
});
