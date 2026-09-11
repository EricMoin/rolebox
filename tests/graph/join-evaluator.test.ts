import { describe, it, expect } from "bun:test";
import { JoinStrategy } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EdgePayload, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import {
  joinSatisfied,
  evaluateJoin,
  collectUpstreamResults,
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

  it("first-traversal join ignores revise back-edge upstream", () => {
    // Graph: external → sink (always), a → sink (revise_needed back-edge).
    // Loop group {a, sink} with traversalCount 0.
    const decl: GraphDeclaration = {
      version: 2,
      name: "revise-back-edge-join",
      nodes: [
        { id: "external", agent: "ext", prompt: "p-ext" },
        { id: "a", agent: "a1", prompt: "p-a" },
        { id: "sink", agent: "sink-agent", prompt: "p-sink" },
      ],
      edges: [
        { from: "external", to: "sink", type: "always" },
        { from: "a", to: "sink", type: "on_signal", signal_filter: ["revise_needed"] },
      ],
      loop_groups: [
        { id: "review-cycle", nodes: ["a", "sink"], max_traversals: 3 },
      ],
    };
    const state = createEngineState(decl, "g-join-revise");
    provision(state);

    const sink = state.nodes.get("sink")!;

    // Traversal 0: revise back-edge from a is excluded → only external is upstream.
    // Record answer only from the external source.
    collectUpstreamResults(state, sink, answerPayload("external"));
    expect(evaluateJoin(state, sink).kind).toBe("satisfied");

    // Bump traversalCount to 1 (simulate loop re-entry).
    // Both upstreams now count: external answered, a hasn't → waiting.
    const group = state.loopGroups.get("review-cycle")!;
    group.traversalCount = 1;
    expect(evaluateJoin(state, sink).kind).toBe("waiting");
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

// ── upstreamResults accumulation shape ──────────────────────────────────────

describe("upstreamResults accumulation", () => {
  function collected(): NodeRuntimeState {
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
    return sink;
  }

  it("exposes per-source provenance on node.upstreamResults", () => {
    const sink = collected();
    expect([...sink.upstreamResults.keys()]).toEqual(["b", "c"]);
    expect(sink.upstreamResults.get("b")).toMatchObject({
      fromNode: "b",
      fromSignal: "answer",
      result: "b-output",
    });
    expect(sink.upstreamResults.get("c")).toMatchObject({
      fromNode: "c",
      fromSignal: "answer",
      result: "c-output",
    });
  });

  it("preserves per-source artifacts and budget on the recorded payloads", () => {
    const sink = collected();
    expect(sink.upstreamResults.get("b")!.artifacts).toEqual(["f1.ts", "shared.ts"]);
    expect(sink.upstreamResults.get("c")!.artifacts).toEqual(["f2.ts", "shared.ts"]);
    expect(sink.upstreamResults.get("b")!.budgetConsumed.tokens).toBe(4000);
    expect(sink.upstreamResults.get("c")!.budgetConsumed.tokens).toBe(3000);
    expect(sink.upstreamResults.get("c")!.budgetConsumed.cost).toBeCloseTo(0.005, 10);
  });

  it("records nothing for a node with no upstream payloads", () => {
    const state = createEngineState(diamondGraph(), "g-1");
    provision(state);
    expect(state.nodes.get("sink")!.upstreamResults.size).toBe(0);
  });
});
