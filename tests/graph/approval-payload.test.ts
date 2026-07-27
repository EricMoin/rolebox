import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import type { EngineState } from "../../src/types.engine-v2.ts";
import {
  createEngineState,
  provision,
} from "../../src/graph/engine/engine-state.ts";
import { buildApprovalPayload } from "../../src/graph/engine/approval-payload.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Two upstream producers (A, B) fan into a `needs_approval` gate P. The test
 * drives P's upstreamResults directly so the payload builder is exercised in
 * isolation (pure function — no dispatch, no signals).
 */
function approvalGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "approval-workflow",
    nodes: [
      { id: "A", agent: "agent-a", prompt: "produce A" },
      { id: "B", agent: "agent-b", prompt: "produce B" },
      { id: "P", agent: "agent-p", prompt: "Review the results and decide.", needs_approval: true },
    ],
    edges: [
      { from: "A", to: "P", type: "on_signal", signal_filter: ["answer"] },
      { from: "B", to: "P", type: "on_signal", signal_filter: ["answer"] },
    ],
  };
}

/** Provision the graph and drive the blocked approval node with upstream results. */
function setupBlockedNode(): { state: EngineState } {
  const state = createEngineState(approvalGraph(), "g-approve");
  provision(state);

  const a = state.nodes.get("A")!;
  const b = state.nodes.get("B")!;
  const p = state.nodes.get("P")!;

  // Upstreams completed with results; gate blocked awaiting the human.
  a.status = NodeStatus.Completed;
  b.status = NodeStatus.Completed;
  p.status = NodeStatus.Blocked;

  p.upstreamResults.set("A", {
    fromNode: "A",
    fromSignal: "answer",
    result: "a".repeat(400),
    artifacts: ["/work/artifact-a.ts"],
    budgetConsumed: { tokens: 100, cost: 0.4, sessions: 1 },
  });
  p.upstreamResults.set("B", {
    fromNode: "B",
    fromSignal: "answer",
    result: "result from B",
    artifacts: ["/work/artifact-b.ts", "/work/artifact-b.md"],
    budgetConsumed: { tokens: 200, cost: 0.8, sessions: 1 },
  });

  state.budget = {
    sessionsSpawned: 2,
    totalInputTokens: 50,
    totalOutputTokens: 60,
    totalCost: 1.2,
  };
  state.phase = EnginePhase.Executing;
  return { state };
}

// ── buildApprovalPayload ───────────────────────────────────────────────────

describe("buildApprovalPayload", () => {
  it("carries node identity and the node prompt as the decision prompt", () => {
    const { state } = setupBlockedNode();
    const p = state.nodes.get("P")!;
    const payload = buildApprovalPayload(state, p);

    expect(payload.node_id).toBe("P");
    expect(payload.node_prompt).toBe("Review the results and decide.");
    expect(typeof payload.timestamp).toBe("string");
  });

  it("carries graph-level context totals", () => {
    const { state } = setupBlockedNode();
    const payload = buildApprovalPayload(state, state.nodes.get("P")!);

    expect(payload.graph_name).toBe("approval-workflow");
    expect(payload.phase).toBe("executing");
    // A and B are completed, P is blocked — two completed nodes.
    expect(payload.total_nodes_completed).toBe(2);
    expect(payload.total_cost_usd).toBe(1.2);
    expect(payload.total_input_tokens).toBe(50);
    expect(payload.total_output_tokens).toBe(60);
  });

  it("renders one upstream result per incoming edge, in insertion order", () => {
    const { state } = setupBlockedNode();
    const payload = buildApprovalPayload(state, state.nodes.get("P")!);

    expect(payload.upstream_results).toHaveLength(2);
    const [first, second] = payload.upstream_results;
    expect(first.from_node_id).toBe("A");
    expect(first.from_agent).toBe("agent-a");
    expect(first.from_signal).toBe("answer");
    expect(second.from_node_id).toBe("B");
    expect(second.from_agent).toBe("agent-b");
  });

  it("truncates each result summary to the first 200 chars", () => {
    const { state } = setupBlockedNode();
    const payload = buildApprovalPayload(state, state.nodes.get("P")!);

    // A's result is 400 chars → truncated to exactly 200.
    expect(payload.upstream_results[0].summary).toHaveLength(200);
    // B's short result passes through unchanged.
    expect(payload.upstream_results[1].summary).toBe("result from B");
  });

  it("carries each upstream's artifacts and budget_consumed", () => {
    const { state } = setupBlockedNode();
    const payload = buildApprovalPayload(state, state.nodes.get("P")!);

    expect(payload.upstream_results[0].artifacts).toEqual(["/work/artifact-a.ts"]);
    expect(payload.upstream_results[0].budget_consumed).toEqual({
      tokens: 100,
      cost: 0.4,
      sessions: 1,
    });
    expect(payload.upstream_results[1].artifacts).toEqual([
      "/work/artifact-b.ts",
      "/work/artifact-b.md",
    ]);
    expect(payload.upstream_results[1].budget_consumed).toEqual({
      tokens: 200,
      cost: 0.8,
      sessions: 1,
    });
  });

  it("returns an empty upstream_results list for a gate with no collected results", () => {
    const state = createEngineState(approvalGraph(), "g-approve");
    provision(state);
    const p = state.nodes.get("P")!;
    p.status = NodeStatus.Blocked;

    const payload = buildApprovalPayload(state, p);
    expect(payload.upstream_results).toEqual([]);
    expect(payload.node_id).toBe("P");
  });
});
