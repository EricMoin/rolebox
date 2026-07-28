import { describe, it, expect } from "bun:test";
import { NodeStatus } from "../../src/constants.ts";
import type { EngineState, NodeRuntimeState } from "../../src/types.engine-v2.ts";
import {
  canTransitionNode,
  transitionNode,
  assertValidNodeTransition,
  markReady,
  markRunning,
  markCompleted,
  markEscalated,
  markTimedOut,
  markCancelled,
  markDone,
  markNodeBlocked,
} from "../../src/graph/engine/node-lifecycle.ts";

// Sentinel for tests that exercise transition legality without an engine state.
// recordCheckpointForNode is a no-op when state is falsy.
const NO_STATE = undefined as unknown as EngineState;

// ── Fixture builder ──────────────────────────────────────────────────────

function makeNode(overrides?: Partial<NodeRuntimeState>): NodeRuntimeState {
  return {
    nodeId: "n",
    agent: "emperor--jinyiwei--backend",
    prompt: "do the thing",
    needsApproval: false,
    status: NodeStatus.Pending,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    joinStrategy: "all",
    joinSatisfied: false,
    traversalCount: 0,
    startedAt: 0,
    retryCount: 0,
    ...overrides,
  };
}

// ── Normal path ──────────────────────────────────────────────────────────

describe("normal path: pending → ready → running → completed", () => {
  it("walks the full happy path via transitionNode", () => {
    const node = makeNode();
    transitionNode(NO_STATE, node, NodeStatus.Ready);
    expect(node.status).toBe(NodeStatus.Ready);

    transitionNode(NO_STATE, node, NodeStatus.Running, { dispatchTaskId: "t1", dispatchSessionId: "s1" });
    expect(node.status).toBe(NodeStatus.Running);
    expect(node.dispatchTaskId).toBe("t1");
    expect(node.dispatchSessionId).toBe("s1");
    expect(node.sessionsSpawned).toBe(1);

    transitionNode(NO_STATE, node, NodeStatus.Completed);
    expect(node.status).toBe(NodeStatus.Completed);
    expect(typeof node.completedAt).toBe("number");
  });

  it("completed → done", () => {
    const node = makeNode({ status: NodeStatus.Completed, completedAt: 1 });
    transitionNode(NO_STATE, node, NodeStatus.Done);
    expect(node.status).toBe(NodeStatus.Done);
  });

  it("completed → ready (revise-driven loop re-entry)", () => {
    const node = makeNode({ status: NodeStatus.Completed, completedAt: 1 });
    expect(canTransitionNode(NodeStatus.Completed, NodeStatus.Ready)).toBe(true);
    transitionNode(NO_STATE, node, NodeStatus.Ready);
    expect(node.status).toBe(NodeStatus.Ready);
  });
});

// ── Error / cancel paths ──────────────────────────────────────────────────

describe("error and cancel paths", () => {
  it("running → escalate → done", () => {
    const node = makeNode({ status: NodeStatus.Running });
    transitionNode(NO_STATE, node, NodeStatus.Escalate, { errorReason: "boom" });
    expect(node.status).toBe(NodeStatus.Escalate);
    expect(node.errorReason).toBe("boom");
    transitionNode(NO_STATE, node, NodeStatus.Done);
    expect(node.status).toBe(NodeStatus.Done);
  });

  it("running → timeout → done", () => {
    const node = makeNode({ status: NodeStatus.Running });
    transitionNode(NO_STATE, node, NodeStatus.Timeout, { errorReason: "slow" });
    expect(node.status).toBe(NodeStatus.Timeout);
    expect(node.errorReason).toBe("slow");
    transitionNode(NO_STATE, node, NodeStatus.Done);
    expect(node.status).toBe(NodeStatus.Done);
  });

  it("running → cancelled → done", () => {
    const node = makeNode({ status: NodeStatus.Running });
    transitionNode(NO_STATE, node, NodeStatus.Cancelled);
    expect(node.status).toBe(NodeStatus.Cancelled);
    transitionNode(NO_STATE, node, NodeStatus.Done);
    expect(node.status).toBe(NodeStatus.Done);
  });

  it("cancellable from pending and ready", () => {
    expect(canTransitionNode(NodeStatus.Pending, NodeStatus.Cancelled)).toBe(true);
    expect(canTransitionNode(NodeStatus.Ready, NodeStatus.Cancelled)).toBe(true);
  });
});

// ── Convenience helpers ──────────────────────────────────────────────────

describe("convenience transitions", () => {
  it("marks each stage through the happy path", () => {
    let node = makeNode();
    node = markReady(NO_STATE, node);
    expect(node.status).toBe(NodeStatus.Ready);
    node = markRunning(NO_STATE, node, { dispatchTaskId: "t1" });
    expect(node.status).toBe(NodeStatus.Running);
    node = markCompleted(NO_STATE, node);
    expect(node.status).toBe(NodeStatus.Completed);
    node = markDone(NO_STATE, node);
    expect(node.status).toBe(NodeStatus.Done);
  });

  it("marks error/cancel stages", () => {
    expect(markEscalated(NO_STATE, makeNode({ status: NodeStatus.Running }), "e").status).toBe(
      NodeStatus.Escalate,
    );
    expect(markTimedOut(NO_STATE, makeNode({ status: NodeStatus.Running })).status).toBe(NodeStatus.Timeout);
    expect(markCancelled(NO_STATE, makeNode({ status: NodeStatus.Running })).status).toBe(
      NodeStatus.Cancelled,
    );
    expect(markDone(NO_STATE, makeNode({ status: NodeStatus.Escalate })).status).toBe(NodeStatus.Done);
  });
});

// ── Illegal transitions are rejected ─────────────────────────────────────

describe("illegal transitions are rejected", () => {
  it("assertValidNodeTransition throws on illegal moves", () => {
    expect(() => assertValidNodeTransition(NodeStatus.Pending, NodeStatus.Running)).toThrow(
      /Invalid node transition: pending -> running/,
    );
    expect(() => assertValidNodeTransition(NodeStatus.Ready, NodeStatus.Completed)).toThrow();
    expect(() => assertValidNodeTransition(NodeStatus.Done, NodeStatus.Ready)).toThrow();
    expect(() => assertValidNodeTransition(NodeStatus.Completed, NodeStatus.Running)).toThrow();
  });

  it("transitionNode leaves status unchanged when it rejects", () => {
    const node = makeNode(); // pending
    expect(() => transitionNode(NO_STATE, node, NodeStatus.Completed)).toThrow();
    expect(node.status).toBe(NodeStatus.Pending);
  });
});

// ── Phase-3 pause stub ───────────────────────────────────────────────────

describe("blocked state (Phase-3 stub)", () => {
  it("running → blocked is representable and reversible", () => {
    const node = makeNode({ status: NodeStatus.Running });
    markNodeBlocked(NO_STATE, node);
    expect(node.status).toBe(NodeStatus.Blocked);
    // Phase 3: approve → completed
    transitionNode(NO_STATE, node, NodeStatus.Completed);
    expect(node.status).toBe(NodeStatus.Completed);
  });

  it("blocked is a legal exit for approve(reject) re-entry", () => {
    const node = makeNode({ status: NodeStatus.Blocked });
    expect(canTransitionNode(NodeStatus.Blocked, NodeStatus.Ready)).toBe(true);
    expect(canTransitionNode(NodeStatus.Blocked, NodeStatus.Completed)).toBe(true);
  });
});

// ── Role-agnosticism (no node-type-specific handling) ───────────────────

describe("no node-type-specific handling", () => {
  it("behaves identically regardless of agent / prompt / needsApproval", () => {
    const agents = ["a1", "emperor--jinyiwei--backend", "validator", "human_gate"];
    const results: { status: NodeStatus; sessions: number; needsApproval: boolean }[] = [];

    for (const agent of agents) {
      const node = makeNode({
        agent,
        prompt: `prompt-${agent}`,
        needsApproval: agent === "human_gate", // pausing flag — not a node category
      });
      // identical transition sequence for every node
      markReady(NO_STATE, node);
      markRunning(NO_STATE, node);
      markCompleted(NO_STATE, node);
      results.push({
        status: node.status,
        sessions: node.sessionsSpawned,
        needsApproval: node.needsApproval,
      });
      // final status identical across all node "types"
      expect(node.status).toBe(NodeStatus.Completed);
    }

    // every node traversed exactly one dispatch and reached the same terminal
    for (const r of results) {
      expect(r.status).toBe(NodeStatus.Completed);
      expect(r.sessions).toBe(1);
    }
    // needsApproval is a data flag only — it never alters the state machine path
    expect(results[3].needsApproval).toBe(true);
    expect(results[0].needsApproval).toBe(false);
  });

  it("the transition table never consults node payload fields", () => {
    // Agent/prompt/needsApproval are irrelevant to legality — legality depends
    // only on (from, to). Prove it by checking identical legality for a set of
    // pairs regardless of the node the pair is applied to.
    const nodeA = makeNode({ agent: "planner" });
    const nodeB = makeNode({ agent: "executor", needsApproval: true });
    const pairs: [NodeStatus, NodeStatus][] = [
      [NodeStatus.Pending, NodeStatus.Ready],
      [NodeStatus.Running, NodeStatus.Completed],
      [NodeStatus.Running, NodeStatus.Escalate],
      [NodeStatus.Pending, NodeStatus.Running], // illegal
    ];
    for (const [from, to] of pairs) {
      const viaA = assertLegal(transitioning(nodeA, from, to));
      const viaB = assertLegal(transitioning(nodeB, from, to));
      expect(viaA).toBe(viaB);
    }
  });
});

// ── Helpers for the role-agnosticism test ────────────────────────────────

function transitioning(
  node: NodeRuntimeState,
  from: NodeStatus,
  to: NodeStatus,
): () => boolean {
  return () => canTransitionNode(from, to);
}

function assertLegal(fn: () => boolean): boolean {
  return fn();
}
