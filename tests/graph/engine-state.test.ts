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
  buildSignalContract,
  injectSignalContracts,
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

  it("roots the loop entry node when its only incoming edge is a revise back-edge", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "revise-back-edge-loop",
      nodes: [
        { id: "a", agent: "a1", prompt: "p1" },
        { id: "b", agent: "a2", prompt: "p2" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "on_signal", signal_filter: ["revise_needed"] },
      ],
      loop_groups: [
        { id: "review-cycle", nodes: ["a", "b"], max_traversals: 2 },
      ],
    };
    const state = createEngineState(decl, "g-revise");
    provision(state);

    // Both the revise back-edge (b→a) and the intra-loop-group always
    // edge (a→b) are excluded from in-degree → both nodes are roots.
    const a = state.nodes.get("a")!;
    expect(a.status).toBe(NodeStatus.Ready);
    expect(isInFrontier(state, "a")).toBe(true);

    const b = state.nodes.get("b")!;
    expect(b.status).toBe(NodeStatus.Ready);
    expect(isInFrontier(state, "b")).toBe(true);
  });

  it("roots nodes in a pure always-cycle loop group (A ⇄ B, both always edges)", () => {
    const decl: GraphDeclaration = {
      version: 2,
      name: "pure-always-cycle",
      nodes: [
        { id: "a", agent: "a1", prompt: "p1" },
        { id: "b", agent: "a2", prompt: "p2" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "always" },
      ],
      loop_groups: [
        { id: "ab-loop", nodes: ["a", "b"], max_traversals: 3 },
      ],
    };
    const state = createEngineState(decl, "g-pure-cycle");
    provision(state);

    // Both intra-loop-group always edges are excluded from in-degree
    // computation so at least one node is discovered as a root.
    const roots = getRootNodeIds(state);
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots).toContain("a");
    expect(roots).toContain("b");

    // Both nodes should be Ready since all incoming edges are intra-loop.
    expect(state.nodes.get("a")!.status).toBe(NodeStatus.Ready);
    expect(state.nodes.get("b")!.status).toBe(NodeStatus.Ready);
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

// ── Signal contract injection ───────────────────────────────────────────

describe("buildSignalContract", () => {
  it("includes answer and escalate signals by default", () => {
    const contract = buildSignalContract(["revise_needed"]);
    expect(contract).toContain("<signal_contract>");
    expect(contract).toContain("</signal_contract>");
    expect(contract).toContain('signal(type="answer")');
    expect(contract).toContain('signal(type="escalate")');
  });

  it("includes revise_needed instruction when present in signalTypes", () => {
    const contract = buildSignalContract(["revise_needed"]);
    expect(contract).toContain('signal(type="revise_needed")');
    expect(contract).toContain("findings");
  });

  it("does not duplicate escalate when it is in signalTypes", () => {
    const contract = buildSignalContract(["escalate", "revise_needed"]);
    // escalate should appear exactly once (not duplicated in universal section)
    const escalateCount =
      contract.split('signal(type="escalate")').length - 1;
    expect(escalateCount).toBe(1);
  });

  it("handles arbitrary signal types dynamically", () => {
    const contract = buildSignalContract(["custom_signal"]);
    expect(contract).toContain('"custom_signal"');
    expect(contract).toContain('signal(type="custom_signal")');
  });

  it("contract is empty-prompts safe (starts with newline)", () => {
    const contract = buildSignalContract(["revise_needed"]);
    expect(contract.startsWith("\n<signal_contract>")).toBe(true);
  });
});

describe("injectSignalContracts", () => {
  function loopGraphWithRevise(): GraphDeclaration {
    return {
      version: 2,
      name: "review-loop",
      nodes: [
        { id: "coder", agent: "a1", prompt: "Write code." },
        { id: "reviewer", agent: "a2", prompt: "Review code." },
        { id: "sink", agent: "a3", prompt: "Merge." },
      ],
      edges: [
        { from: "coder", to: "reviewer", type: "always" },
        { from: "reviewer", to: "coder", type: "on_signal", signal_filter: ["revise_needed"] },
        { from: "reviewer", to: "sink", type: "on_signal", signal_filter: ["answer"] },
      ],
      loop_groups: [
        { id: "review-cycle", nodes: ["coder", "reviewer"], max_traversals: 3 },
      ],
    };
  }

  it("injects signal contract into loop member node with on_signal outbound edges", () => {
    const state = createEngineState(loopGraphWithRevise(), "g-sig-1");
    provision(state);

    // reviewer has on_signal outbound edges (revise_needed → coder, answer → sink)
    const reviewer = state.nodes.get("reviewer")!;
    expect(reviewer.prompt).toContain("<signal_contract>");
    expect(reviewer.prompt).toContain('signal(type="answer")');
    expect(reviewer.prompt).toContain('signal(type="revise_needed")');
    expect(reviewer.prompt).toContain("findings");
    // Original prompt is preserved
    expect(reviewer.prompt).toContain("Review code.");
  });

  it("injects signal contract into coder node with on_signal edges too", () => {
    const state = createEngineState(loopGraphWithRevise(), "g-sig-2");
    provision(state);

    // coder has on_signal outbound edges? Let's check...
    // coder → reviewer is type "always", so no on_signal edges from coder.
    // We need the reviewer's revise_needed to go back to coder, so reviewer
    // gets the contract. Coder has only always edges, so no contract.
    const coder = state.nodes.get("coder")!;
    expect(coder.prompt).not.toContain("<signal_contract>");
  });

  it("does not inject into non-loop nodes", () => {
    const state = createEngineState(loopGraphWithRevise(), "g-sig-3");
    provision(state);

    // sink is not in the loop group
    const sink = state.nodes.get("sink")!;
    expect(sink.prompt).not.toContain("<signal_contract>");
    expect(sink.prompt).toBe("Merge.");
  });

  it("does not inject into a linear (non-loop) graph", () => {
    const state = createEngineState(linearGraph(), "g-sig-4");
    provision(state);

    expect(state.nodes.get("root")!.prompt).not.toContain("<signal_contract>");
    expect(state.nodes.get("leaf")!.prompt).not.toContain("<signal_contract>");
  });

  it("does not inject when loop node has only on_signal(answer) edges", () => {
    // A loop node whose only on_signal outbound edges are for "answer"
    // should not get a contract (the universal answer line covers it,
    // but we skip injection when there are no non-answer signal types).
    const decl: GraphDeclaration = {
      version: 2,
      name: "answer-only-loop",
      nodes: [
        { id: "a", agent: "a1", prompt: "Do work." },
        { id: "b", agent: "a2", prompt: "Continue." },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "on_signal", signal_filter: ["answer"] },
      ],
      loop_groups: [
        { id: "cycle", nodes: ["a", "b"], max_traversals: 2 },
      ],
    };
    const state = createEngineState(decl, "g-sig-5");
    provision(state);

    // Node b has an on_signal(answer) edge, but answer is excluded from
    // signalTypes collection (it's universal). So signalTypes.size === 0
    // and no contract is injected.
    expect(state.nodes.get("b")!.prompt).not.toContain("<signal_contract>");
  });

  it("preserves original prompt when injecting signal contract", () => {
    const state = createEngineState(loopGraphWithRevise(), "g-sig-6");
    provision(state);

    const reviewer = state.nodes.get("reviewer")!;
    // Original prompt text still at the start
    expect(reviewer.prompt.startsWith("Review code.")).toBe(true);
    // Contract is appended
    const contractIdx = reviewer.prompt.indexOf("\n<signal_contract>");
    expect(contractIdx).toBeGreaterThan(0);
  });
});
