/**
 * Graph Engine v2 — Join Declaration → Runtime Propagation (end-to-end)
 *
 * Phase: Subtask 1 (graph engine finishing round)
 *
 * Regression coverage for the declaration→runtime join-strategy link. The
 * older join-evaluator tests construct runtime state via `createEngineState` +
 * `provision`, which is exactly the path under test here, but they never
 * asserted that the *runtime field* `NodeRuntimeState.joinStrategy` is
 * populated from the node's declared `join`. This suite pins that contract:
 *
 * 1. registerNode (via provision) propagates the declared join strategy into
 *    `NodeRuntimeState.joinStrategy`, instead of the old hardcoded `"all"`.
 * 2. The runtime field is driven by `collectUpstreamResults` on a provisioned
 *    node so `joinSatisfied` flips false→true as answers arrive.
 *
 * Everything flows through the real factory path (createEngineState +
 * provision + registerNode) — no runtime state is constructed by hand.
 */

import { describe, it, expect } from "bun:test";
import { JoinStrategy } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EdgePayload } from "../../src/types.engine-v2.ts";
import { createEngineState, provision } from "../../src/graph/engine/engine-state.ts";
import { collectUpstreamResults } from "../../src/graph/engine/join-evaluator.ts";

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
function diamondWithJoin(
  strategy: "all" | "any" | "quorum",
  quorum?: number,
): GraphDeclaration {
  const g = diamondGraph();
  const sink = g.nodes.find((n) => n.id === "sink")!;
  sink.join =
    strategy === "quorum" ? { strategy: "quorum", quorum } : { strategy };
  return g;
}

/** Build an answer EdgePayload from a source node. */
function answerPayload(fromNode: string): EdgePayload {
  return {
    fromNode,
    fromSignal: "answer",
    result: `result-${fromNode}`,
    artifacts: [`artifact-${fromNode}`],
    budgetConsumed: { tokens: 100, cost: 0.01, sessions: 1 },
  };
}

/** Provision a declaration and return the requested node runtime state. */
function provisionedState(decl: GraphDeclaration) {
  const state = createEngineState(decl, "g-1");
  provision(state);
  return state;
}

// ── Declaration → runtime propagation (via registerNode) ───────────────────

describe("registerNode propagates the declared join into the runtime field", () => {
  it("defaults joinStrategy to 'all' when the node declares no join", () => {
    const state = provisionedState(diamondGraph());
    const sink = state.nodes.get("sink")!;
    expect(sink.joinStrategy).toBe(JoinStrategy.All);
  });

  it("propagates an explicit join:{ strategy: 'all' }", () => {
    const state = provisionedState(diamondWithJoin("all"));
    expect(state.nodes.get("sink")!.joinStrategy).toBe(JoinStrategy.All);
  });

  it("propagates join:{ strategy: 'any' } as 'any'", () => {
    const state = provisionedState(diamondWithJoin("any"));
    expect(state.nodes.get("sink")!.joinStrategy).toBe(JoinStrategy.Any);
  });

  it("propagates join:{ strategy: 'quorum', quorum: 2 } as { quorum: 2 }", () => {
    const state = provisionedState(diamondWithJoin("quorum", 2));
    expect(state.nodes.get("sink")!.joinStrategy).toEqual({ quorum: 2 });
  });

  it("propagates join:{ strategy: 'quorum' } (no quorum) with a default quorum of 1", () => {
    const state = provisionedState(diamondWithJoin("quorum"));
    expect(state.nodes.get("sink")!.joinStrategy).toEqual({ quorum: 1 });
  });

  it("every non-root node gets a propagated strategy (no hardcoded 'all')", () => {
    const state = provisionedState(diamondWithJoin("any"));
    const runtime = state.nodes.get("sink")!.joinStrategy;
    const declared = diamondWithJoin("any").nodes.find((n) => n.id === "sink")!.join;
    // Runtime field and declaration agree for the same node.
    expect(runtime).toBe(declared!.strategy);
    expect(runtime).not.toBe(JoinStrategy.All);
  });
});

// ── Runtime field drives collectUpstreamResults end-to-end ─────────────────

describe("provisioned quorum node: runtime joinStrategy drives satisfaction", () => {
  it("flips joinSatisfied false→true as N answers arrive, consuming the runtime field", () => {
    const decl = diamondWithJoin("quorum", 2);
    const state = provisionedState(decl);
    const sink = state.nodes.get("sink")!;

    // The runtime field must carry the propagated quorum shape (not 'all').
    expect(sink.joinStrategy).toEqual({ quorum: 2 });
    expect(sink.joinSatisfied).toBe(false); // 0/2

    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(sink.joinStrategy).toEqual({ quorum: 2 }); // unchanged
    expect(sink.joinSatisfied).toBe(false); // 1/2 → still waiting

    collectUpstreamResults(state, sink, answerPayload("c"));
    expect(sink.joinSatisfied).toBe(true); // 2/2 → satisfied
  });

  it("waits at quorum threshold without flipping on partial answers", () => {
    const state = provisionedState(diamondWithJoin("quorum", 2));
    const sink = state.nodes.get("sink")!;
    collectUpstreamResults(state, sink, answerPayload("b"));
    collectUpstreamResults(state, sink, answerPayload("b")); // duplicate source overwrite
    // Only {b, c} upstream — b overwritten, c still pending → not satisfied.
    expect(sink.joinSatisfied).toBe(false);
  });

  it("an 'any' node satisfies as soon as a single provisioned upstream answers", () => {
    const state = provisionedState(diamondWithJoin("any"));
    const sink = state.nodes.get("sink")!;
    expect(sink.joinStrategy).toBe(JoinStrategy.Any);
    expect(sink.joinSatisfied).toBe(false);
    collectUpstreamResults(state, sink, answerPayload("b"));
    expect(sink.joinSatisfied).toBe(true);
  });
});
