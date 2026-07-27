import { describe, it, expect } from "bun:test";
import { EnginePhase, NodeStatus } from "../../src/constants.ts";
import type { GraphDeclaration } from "../../src/types.graph-v2.ts";
import {
  createEngineState,
  provision,
  transitionPhase,
  canTransitionPhase,
  addToFrontier,
  removeFromFrontier,
  isInFrontier,
  acquireAdvancingLock,
  releaseAdvancingLock,
  queuePendingCompletion,
  drainPendingCompletions,
  getRootNodeIds,
  applyBudgetDelta,
  incrementLoopTraversal,
  isLoopExhausted,
} from "../../src/graph/engine/engine-state.ts";

// ── Fixture builders ──────────────────────────────────────────────────────

/** A 2-node linear graph: root → leaf. */
function linearGraph(): GraphDeclaration {
  return {
    version: 2,
    name: "linear",
    nodes: [
      { id: "root", agent: "a1", prompt: "p1" },
      { id: "leaf", agent: "a2", prompt: "p2" },
    ],
    edges: [{ from: "root", to: "leaf", type: "always" }],
  };
}

/** A diamond with a single shared root and a fan-in leaf. */
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

// ── Engine state factory ──────────────────────────────────────────────────

describe("createEngineState", () => {
  it("starts in idle phase with empty collections", () => {
    const state = createEngineState(linearGraph(), "g-1");
    expect(state.phase).toBe(EnginePhase.Idle);
    expect(state.graphId).toBe("g-1");
    expect(state.nodes.size).toBe(0);
    expect(state.frontier).toEqual([]);
    expect(state.advancingLock).toBe(false);
    expect(state.pendingCompletions).toEqual([]);
    expect(state.budget).toEqual({
      sessionsSpawned: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    });
    expect(typeof state.startedAt).toBe("number");
    expect(typeof state.updatedAt).toBe("number");
  });
});

// ── Provision ─────────────────────────────────────────────────────────────

describe("provision", () => {
  it("produces correct initial state for a 2-node linear graph", () => {
    const state = createEngineState(linearGraph(), "g-1");
    provision(state);

    const root = state.nodes.get("root")!;
    const leaf = state.nodes.get("leaf")!;

    // root has no upstream edge → ready; leaf → pending
    expect(root.status).toBe(NodeStatus.Ready);
    expect(leaf.status).toBe(NodeStatus.Pending);

    // root carries over its declaration fields
    expect(root.nodeId).toBe("root");
    expect(root.agent).toBe("a1");
    expect(root.prompt).toBe("p1");

    // only the root is in the frontier
    expect(state.frontier).toEqual(["root"]);
    expect(isInFrontier(state, "root")).toBe(true);
    expect(isInFrontier(state, "leaf")).toBe(false);
  });

  it("roots every node with no upstream edges in a diamond", () => {
    const state = createEngineState(diamondGraph(), "g-2");
    provision(state);
    expect(getRootNodeIds(state)).toEqual(["root"]);
    expect(state.nodes.get("root")!.status).toBe(NodeStatus.Ready);
    for (const id of ["b", "c", "sink"]) {
      expect(state.nodes.get(id)!.status).toBe(NodeStatus.Pending);
    }
    expect(state.frontier).toEqual(["root"]);
  });

  it("roots all nodes in a graph with no edges", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "empty",
      nodes: [
        { id: "x", agent: "a", prompt: "p" },
        { id: "y", agent: "b", prompt: "q" },
      ],
      edges: [],
    };
    const state = createEngineState(decl, "g-3");
    provision(state);
    expect(state.nodes.get("x")!.status).toBe(NodeStatus.Ready);
    expect(state.nodes.get("y")!.status).toBe(NodeStatus.Ready);
    expect(state.frontier.sort()).toEqual(["x", "y"]);
  });

  it("rejects duplicate node ids", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "dup",
      nodes: [
        { id: "x", agent: "a", prompt: "p" },
        { id: "x", agent: "b", prompt: "q" },
      ],
      edges: [],
    };
    const state = createEngineState(decl, "g-4");
    expect(() => provision(state)).toThrow(/Duplicate node id/);
  });

  it("populates loopGroups with correct maxTraversals and tags member nodes", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "loopy",
      nodes: [
        { id: "a", agent: "a1", prompt: "p1" },
        { id: "b", agent: "a2", prompt: "p2" },
        { id: "sink", agent: "a3", prompt: "p3" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "on_signal", signal_filter: ["revise_needed"] },
        { from: "b", to: "sink", type: "on_signal", signal_filter: ["answer"] },
      ],
      loop_groups: [
        {
          id: "review-cycle",
          nodes: ["a", "b"],
          max_traversals: 3,
        },
      ],
    };
    const state = createEngineState(decl, "g-5");
    provision(state);

    const group = state.loopGroups.get("review-cycle");
    expect(group).toBeDefined();
    expect(group!.maxTraversals).toBe(3);
    expect(group!.traversalCount).toBe(0);
    expect(typeof group!.startTimeMs).toBe("number");
    expect(state.loopGroups.size).toBe(1);

    // member nodes are tagged; non-members are not
    expect(state.nodes.get("a")!.loopGroupId).toBe("review-cycle");
    expect(state.nodes.get("b")!.loopGroupId).toBe("review-cycle");
    expect(state.nodes.get("sink")!.loopGroupId).toBeUndefined();
  });

  it("leaves loopGroups empty when the graph declares none", () => {
    const state = createEngineState(linearGraph(), "g-6");
    provision(state);
    expect(state.loopGroups.size).toBe(0);
    expect(state.nodes.get("root")!.loopGroupId).toBeUndefined();
  });
});

// ── Loop-group traversal counters ─────────────────────────────────────────

describe("loop traversal counters", () => {
  function loopState(maxTraversals: number) {
    const decl: GraphDeclaration = {
      version: 2,
      name: "loopy",
      nodes: [
        { id: "a", agent: "a1", prompt: "p1" },
        { id: "b", agent: "a2", prompt: "p2" },
      ],
      edges: [{ from: "a", to: "b", type: "always" }],
      loop_groups: [{ id: "review-cycle", nodes: ["a", "b"], max_traversals: maxTraversals }],
    };
    const state = createEngineState(decl, "g-loop");
    provision(state);
    return state;
  }

  it("increments up to maxTraversals, then returns false", () => {
    const state = loopState(2);
    expect(incrementLoopTraversal(state, "review-cycle")).toBe(true);
    expect(state.loopGroups.get("review-cycle")!.traversalCount).toBe(1);
    expect(incrementLoopTraversal(state, "review-cycle")).toBe(true);
    expect(state.loopGroups.get("review-cycle")!.traversalCount).toBe(2);
    // cap reached — further increments are rejected
    expect(incrementLoopTraversal(state, "review-cycle")).toBe(false);
    expect(state.loopGroups.get("review-cycle")!.traversalCount).toBe(2);
  });

  it("isLoopExhausted flips once the cap is reached", () => {
    const state = loopState(1);
    expect(isLoopExhausted(state, "review-cycle")).toBe(false);
    incrementLoopTraversal(state, "review-cycle");
    expect(isLoopExhausted(state, "review-cycle")).toBe(true);
  });

  it("throws on an unknown loop group id", () => {
    const state = loopState(5);
    expect(() => incrementLoopTraversal(state, "nope")).toThrow(/Unknown loop group "nope"/);
    expect(() => isLoopExhausted(state, "nope")).toThrow(/Unknown loop group "nope"/);
  });
});

// ── Phase transitions ─────────────────────────────────────────────────────

describe("engine phase transitions", () => {
  function idleState() {
    const s = createEngineState(linearGraph(), "g-1");
    provision(s);
    return s;
  }

  it("walks idle → executing → complete", () => {
    const s = idleState();
    expect(s.phase).toBe(EnginePhase.Idle);
    transitionPhase(s, EnginePhase.Executing);
    expect(s.phase).toBe(EnginePhase.Executing);
    transitionPhase(s, EnginePhase.Complete);
    expect(s.phase).toBe(EnginePhase.Complete);
  });

  it("rejects executing → idle (non-linear) and complete → executing", () => {
    const s = idleState();
    transitionPhase(s, EnginePhase.Executing);
    expect(() => transitionPhase(s, EnginePhase.Idle)).toThrow(/Invalid engine phase/);
    transitionPhase(s, EnginePhase.Complete);
    expect(canTransitionPhase(s, EnginePhase.Executing)).toBe(false);
    expect(() => transitionPhase(s, EnginePhase.Executing)).toThrow(/Invalid engine phase/);
  });

  it("rejects idle → complete (skipping executing)", () => {
    const s = idleState();
    expect(() => transitionPhase(s, EnginePhase.Complete)).toThrow(/Invalid engine phase/);
    expect(s.phase).toBe(EnginePhase.Idle);
  });
});

// ── Frontier management ───────────────────────────────────────────────────

describe("frontier management", () => {
  it("add / remove / membership / dedupe", () => {
    const s = createEngineState(linearGraph(), "g-1");
    expect(addToFrontier(s, "root")).toBe(true);
    expect(addToFrontier(s, "root")).toBe(false); // dedupe
    expect(isInFrontier(s, "root")).toBe(true);
    expect(addToFrontier(s, "leaf")).toBe(true);
    expect(s.frontier).toEqual(["root", "leaf"]);
    expect(removeFromFrontier(s, "root")).toBe(true);
    expect(isInFrontier(s, "root")).toBe(false);
    expect(removeFromFrontier(s, "root")).toBe(false); // already gone
    expect(s.frontier).toEqual(["leaf"]);
  });
});

// ── Re-entrancy guard ─────────────────────────────────────────────────────

describe("advancing lock + pending completions", () => {
  it("acquire / release, and queue / drain completions", () => {
    const s = createEngineState(linearGraph(), "g-1");
    expect(acquireAdvancingLock(s)).toBe(true);
    expect(acquireAdvancingLock(s)).toBe(false); // already held
    expect(s.advancingLock).toBe(true);

    queuePendingCompletion(s, "leaf");
    queuePendingCompletion(s, "leaf"); // dedupe
    expect(s.pendingCompletions).toEqual(["leaf"]);

    releaseAdvancingLock(s);
    expect(s.advancingLock).toBe(false);

    expect(drainPendingCompletions(s)).toEqual(["leaf"]);
    expect(s.pendingCompletions).toEqual([]);
    expect(drainPendingCompletions(s)).toEqual([]);
  });
});

// ── Budget stub ───────────────────────────────────────────────────────────

describe("budget stub", () => {
  it("accumulates graph-level consumption", () => {
    const s = createEngineState(linearGraph(), "g-1");
    applyBudgetDelta(s, { sessions: 1, inputTokens: 100, outputTokens: 50, cost: 0.01 });
    expect(s.budget).toEqual({
      sessionsSpawned: 1,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCost: 0.01,
    });
  });
});
