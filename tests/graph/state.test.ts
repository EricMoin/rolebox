import { describe, it, expect } from "bun:test";
import {
  GraphSessionState,
  graphSessionState,
  buildGraphStateBlock,
} from "../../src/graph/state";
import type { ResolvedGraph, FlowEdge } from "../../src/types";

function makeGraph(overrides?: Partial<ResolvedGraph>): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    maxIterations: 3,
    exitEdges: [],
    ...overrides,
  };
}

function fresh(): GraphSessionState {
  return new GraphSessionState();
}

describe("GraphSessionState — frontier model", () => {
  describe("initGraph", () => {
    it("initializes state with frontier from parent edges, empty completed, iter 0, status active", () => {
      const gs = fresh();
      const graph = makeGraph({
        edges: [{ from: "parent", to: "agent-a" }],
      });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      expect(state).toBeDefined();
      expect(state.frontier).toEqual(["agent-a"]);
      expect(state.completed).toEqual([]);
      expect(state.iterationCount).toBe(0);
      expect(state.status).toBe("active");
    });

    it("sets frontier to all unique non-parent targets from parent edges", () => {
      const gs = fresh();
      const graph = makeGraph({
        edges: [
          { from: "parent", to: "agent-a" },
          { from: "parent", to: "agent-b" },
          { from: "agent-a", to: "agent-b" },
        ],
      });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      expect(state.frontier).toEqual(["agent-a", "agent-b"]);
    });

    it("re-initializes if called twice for same session", () => {
      const gs = fresh();
      const graph = makeGraph({
        edges: [{ from: "parent", to: "agent-a" }],
      });
      gs.initGraph("s1", graph);
      gs.getState("s1")!.completed.push("agent-a");
      gs.getState("s1")!.iterationCount = 2;

      gs.initGraph("s1", graph);
      const state = gs.getState("s1")!;
      expect(state.frontier).toEqual(["agent-a"]);
      expect(state.completed).toEqual([]);
      expect(state.iterationCount).toBe(0);
      expect(state.status).toBe("active");
    });
  });

  describe("advanceStep — pipeline", () => {
    it("advances through a simple pipeline to completion via exit edge", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      const r1 = gs.advanceStep("s1", "agent-a");
      expect(r1.kind).toBe("advanced");
      expect((r1 as { kind: "advanced"; frontier: string[] }).frontier).toEqual(["agent-b"]);
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completed).toEqual(["agent-a"]);

      const r2 = gs.advanceStep("s1", "agent-b");
      expect(r2.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
      expect(gs.getState("s1")!.completed).toEqual(["agent-a", "agent-b"]);
      expect(gs.getState("s1")!.frontier).toEqual([]);
    });

    it("completes on single-step pipeline (parent→a, a→parent)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
    });

    it("completes when no outgoing edges from completed agent", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      const r1 = gs.advanceStep("s1", "agent-a");
      expect(r1.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");

      const r2 = gs.advanceStep("s1", "agent-b");
      expect(r2.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
    });
  });

  describe("advanceStep — loop", () => {
    it("detects loop-back and increments iteration", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 3 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a"); // frontier=[b]
      const r = gs.advanceStep("s1", "agent-b"); // b→a loop detected, iter=1, frontier=[a]

      expect(r.kind).toBe("advanced");
      expect(gs.getState("s1")!.iterationCount).toBe(1);
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completed).toEqual(["agent-a", "agent-b"]);
    });

    it("exhausts when iterationCount exceeds maxIterations on forward-only graph", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a"); // frontier=[b]
      const r = gs.advanceStep("s1", "agent-b"); // loop detected, iter=1 > 0 → skip, no exit → exhausted

      expect(r.kind).toBe("exhausted");
      expect(gs.getState("s1")!.status).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(1);
    });

    it("stays active when iterationCount does not exceed maxIterations", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 1 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a"); // frontier=[b]
      const r1 = gs.advanceStep("s1", "agent-b"); // loop detected, iter=1, 1>1? no. frontier=[a]
      expect(r1.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.iterationCount).toBe(1);

      // a→b loop: b in completed, iter becomes 2 > 1 → skip, no exit edges from a → exhausted
      const r2 = gs.advanceStep("s1", "agent-a");
      expect(r2.kind).toBe("exhausted");
      expect(gs.getState("s1")!.status).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(2);
    });
  });

  describe("advanceStep — review-loop exit selection", () => {
    it("loops to exhaustion when exit edges exist but cap is reached on a forward-only path then exits", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "writer" },
        { from: "writer", to: "reviewer" },
        { from: "reviewer", to: "writer", label: "loop" },
        { from: "reviewer", to: "parent", label: "exit", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["writer", "reviewer"], maxIterations: 2 });
      gs.initGraph("s1", graph);

      // writer → reviewer
      const r1 = gs.advanceStep("s1", "writer");
      expect(r1.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completed).toEqual(["writer"]);

      // reviewer → writer (loop, iter=1)
      const r2 = gs.advanceStep("s1", "reviewer");
      expect(r2.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.iterationCount).toBe(1);
      expect(gs.getState("s1")!.completed).toEqual(["writer", "reviewer"]);

      // writer → reviewer (loop, iter=2 — NOT >2, so not skipped)
      const r3 = gs.advanceStep("s1", "writer");
      expect(r3.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.iterationCount).toBe(2);

      // reviewer: loop to writer, iter becomes 3 > 2 → skip. frontier empty but exit edges exist → completed
      const r4 = gs.advanceStep("s1", "reviewer");
      expect(r4.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
      expect(gs.getState("s1")!.iterationCount).toBe(3);
    });

    it("stays active when iterationCount < maxIterations (loops freely)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "writer" },
        { from: "writer", to: "reviewer" },
        { from: "reviewer", to: "writer", label: "loop" },
        { from: "reviewer", to: "parent", label: "exit", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["writer", "reviewer"], maxIterations: 3 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "writer"); // active
      const r = gs.advanceStep("s1", "reviewer"); // loop, iter=1, frontier=[writer]

      expect(r.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.iterationCount).toBe(1);
      expect(gs.getState("s1")!.completed).toEqual(["writer", "reviewer"]);
    });
  });

  describe("advanceStep — unknown / off_route / ignored", () => {
    it("returns ignored when session has no state", () => {
      const gs = fresh();
      const r = gs.advanceStep("nonexistent", "agent-a");
      expect(r.kind).toBe("ignored");
    });

    it("returns ignored when graph not found for session", () => {
      const gs = fresh();
      // init state directly without graph
      (gs as any).states.set("s1", {
        frontier: ["agent-a"],
        completed: [],
        iterationCount: 0,
        status: "active",
      });
      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("ignored");
    });

    it("returns ignored when state status is complete", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("complete");

      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("ignored");
    });

    it("returns ignored when state status is exhausted", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");
      expect(gs.getState("s1")!.status).toBe("exhausted");

      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("ignored");
    });

    it("returns unknown when agent is not in graph.nodes", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      const r = gs.advanceStep("s1", "unknown-agent");
      expect(r.kind).toBe("unknown");
      expect((r as { kind: "unknown"; got: string }).got).toBe("unknown-agent");

      // State should be unchanged
      expect(gs.getState("s1")!.completed).toEqual([]);
      expect(gs.getState("s1")!.frontier).toEqual(["agent-a"]);
      expect(gs.getState("s1")!.status).toBe("active");
    });

    it("returns off_route when agent is known but not in frontier", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      // agent-b is known but not in frontier yet (only agent-a is)
      const r = gs.advanceStep("s1", "agent-b");
      expect(r.kind).toBe("off_route");
      expect((r as { kind: "off_route"; expected: string[]; got: string }).expected).toEqual([
        "agent-a",
      ]);
      expect((r as { kind: "off_route"; expected: string[]; got: string }).got).toBe("agent-b");
    });
  });

  describe("getState", () => {
    it("returns undefined for unknown session", () => {
      const gs = fresh();
      expect(gs.getState("unknown")).toBeUndefined();
    });

    it("returns state for known session", () => {
      const gs = fresh();
      const graph = makeGraph();
      gs.initGraph("s1", graph);
      expect(gs.getState("s1")).toBeDefined();
    });
  });

  describe("isComplete", () => {
    it("returns false when active", () => {
      const gs = fresh();
      const graph = makeGraph({ edges: [{ from: "parent", to: "agent-a" }] });
      gs.initGraph("s1", graph);
      expect(gs.isComplete("s1")).toBe(false);
    });

    it("returns false for unknown session", () => {
      const gs = fresh();
      expect(gs.isComplete("unknown")).toBe(false);
    });

    it("returns true when status is complete", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");
      expect(gs.isComplete("s1")).toBe(true);
    });

    it("returns true when status is exhausted", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");
      expect(gs.isComplete("s1")).toBe(true);

      // Second session via exit completion
      const edges2: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph2 = makeGraph({ edges: edges2, nodes: ["agent-a"] });
      gs.initGraph("s2", graph2);
      gs.advanceStep("s2", "agent-a");
      expect(gs.isComplete("s2")).toBe(true);
    });
  });

  describe("clear", () => {
    it("removes session state", () => {
      const gs = fresh();
      const graph = makeGraph({ edges: [{ from: "parent", to: "agent-a" }] });
      gs.initGraph("s1", graph);
      gs.clear("s1");
      expect(gs.getState("s1")).toBeUndefined();
    });

    it("is a no-op for unknown session", () => {
      const gs = fresh();
      expect(() => gs.clear("unknown")).not.toThrow();
    });
  });

  describe("no setTimeout in state.ts", () => {
    it("state persists after completion (no auto-cleanup)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("complete");

      // State should still exist — no setTimeout cleanup
      expect(gs.getState("s1")).toBeDefined();
      expect(gs.getGraph("s1")).toBeDefined();
    });

    it("state persists after exhaustion (no auto-cleanup)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");

      expect(gs.getState("s1")!.status).toBe("exhausted");
      expect(gs.getState("s1")).toBeDefined();
      expect(gs.getGraph("s1")).toBeDefined();
    });

    it("active state persists after advanceStep", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")).toBeDefined();
      expect(gs.getState("s1")!.status).toBe("active");
    });
  });

  describe("getNextAction", () => {
    it("returns all edges targeting frontier agents when active", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      const next = gs.getNextAction(state, graph);
      expect(next.length).toBe(1);
      expect(next[0]).toEqual(edges[0]); // parent→agent-a
    });

    it("returns correct edges after advanceStep updates frontier", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a"); // frontier now [agent-b]

      const state = gs.getState("s1")!;
      const next = gs.getNextAction(state, graph);
      expect(next.length).toBe(1);
      expect(next[0]).toEqual(edges[1]); // agent-a→agent-b
    });

    it("returns multiple edges for parallel frontier (star topology)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "parent", to: "agent-b" },
        { from: "agent-a", to: "parent", exit: true },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      const next = gs.getNextAction(state, graph);
      expect(next.length).toBe(2);
      expect(next.map((e) => e.to).sort()).toEqual(["agent-a", "agent-b"]);
    });

    it("returns empty array when status is complete", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");

      const state = gs.getState("s1")!;
      expect(gs.getNextAction(state, graph)).toEqual([]);
    });

    it("returns empty array when status is exhausted", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");

      const state = gs.getState("s1")!;
      expect(gs.getNextAction(state, graph)).toEqual([]);
    });
  });

  describe("singleton", () => {
    it("graphSessionState is an instance of GraphSessionState", () => {
      expect(graphSessionState).toBeInstanceOf(GraphSessionState);
    });
  });

  describe("completed array tracks order correctly", () => {
    it("records completions in order including re-executions on loops", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 5 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a"); // iter stays 0
      gs.advanceStep("s1", "agent-b"); // iter→1
      gs.advanceStep("s1", "agent-a"); // iter→2
      gs.advanceStep("s1", "agent-b"); // iter→3
      gs.advanceStep("s1", "agent-a"); // iter→4
      gs.advanceStep("s1", "agent-b"); // iter→5

      expect(gs.getState("s1")!.completed).toEqual([
        "agent-a", "agent-b",
        "agent-a", "agent-b",
        "agent-a", "agent-b",
      ]);
      expect(gs.getState("s1")!.iterationCount).toBe(5);

      // Next advanceStep on agent-a: loop, iter 6 > 5 → skip, no exit from a → exhausted
      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(6);
      expect(gs.getState("s1")!.status).toBe("exhausted");
    });
  });

  describe("pipeline with single outgoing edge per agent", () => {
    it("advances through researcher→writer→editor→parent", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "researcher" },
        { from: "researcher", to: "writer" },
        { from: "writer", to: "editor" },
        { from: "editor", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["researcher", "writer", "editor"] });
      gs.initGraph("s1", graph);

      const r1 = gs.advanceStep("s1", "researcher");
      expect(r1.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completed).toEqual(["researcher"]);

      const r2 = gs.advanceStep("s1", "writer");
      expect(r2.kind).toBe("advanced");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completed).toEqual(["researcher", "writer"]);

      const r3 = gs.advanceStep("s1", "editor");
      expect(r3.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
      expect(gs.getState("s1")!.completed).toEqual(["researcher", "writer", "editor"]);
    });
  });

  // ── NEW TESTS ────────────────────────────────────────────────────

  describe("star parallel join", () => {
    it("advances each parallel agent and completes when all report", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "parent", to: "agent-b" },
        { from: "parent", to: "agent-c" },
        { from: "agent-a", to: "parent", exit: true },
        { from: "agent-b", to: "parent", exit: true },
        { from: "agent-c", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b", "agent-c"] });
      gs.initGraph("s1", graph);

      expect(gs.getState("s1")!.frontier).toEqual(["agent-a", "agent-b", "agent-c"]);

      // Advance a: still active (others remain)
      const r1 = gs.advanceStep("s1", "agent-a");
      expect(r1.kind).toBe("advanced");
      expect((r1 as { kind: "advanced"; frontier: string[] }).frontier).toEqual(["agent-b", "agent-c"]);
      expect(gs.getState("s1")!.status).toBe("active");

      // Advance b: still active
      const r2 = gs.advanceStep("s1", "agent-b");
      expect(r2.kind).toBe("advanced");
      expect((r2 as { kind: "advanced"; frontier: string[] }).frontier).toEqual(["agent-c"]);
      expect(gs.getState("s1")!.status).toBe("active");

      // Advance c: all exit edges → frontier empty → completed
      const r3 = gs.advanceStep("s1", "agent-c");
      expect(r3.kind).toBe("completed");
      expect(gs.getState("s1")!.status).toBe("complete");
      expect(gs.getState("s1")!.completed).toEqual(["agent-a", "agent-b", "agent-c"]);
    });
  });

  describe("off_route result when dispatching node not in frontier", () => {
    it("returns off_route with expected frontier when agent is in graph but not frontier", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "parent", to: "agent-b" },
        { from: "agent-a", to: "agent-c" },
        { from: "agent-b", to: "agent-c" },
        { from: "agent-c", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b", "agent-c"] });
      gs.initGraph("s1", graph);

      // Frontier is [a, b]. Dispatching c (a dependent) is off-route.
      const r = gs.advanceStep("s1", "agent-c");
      expect(r.kind).toBe("off_route");
      expect((r as { kind: "off_route"; expected: string[]; got: string }).expected).toEqual([
        "agent-a",
        "agent-b",
      ]);
    });
  });

  describe("legit consecutive re-prompt of looped agent", () => {
    it("allows agent to be dispatched again after loop puts it back in frontier", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 5 });
      gs.initGraph("s1", graph);

      // First round: a → b → a (loop)
      gs.advanceStep("s1", "agent-a"); // frontier=[b]
      gs.advanceStep("s1", "agent-b"); // frontier=[a] (loop), iter=1

      // Now agent-a is back in frontier. Re-prompt (re-dispatch) to agent-a: should advance, not be off_route.
      const r = gs.advanceStep("s1", "agent-a");
      expect(r.kind).toBe("advanced");
      expect(gs.getState("s1")!.iterationCount).toBe(2);
      expect(gs.getState("s1")!.completed.length).toBe(3);
    });
  });

  describe("review-loop exhaustion → exhausted", () => {
    it("exhausts when only loop edges exist and iteration cap is exceeded", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      const r = gs.advanceStep("s1", "agent-b");
      expect(r.kind).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(1);
      expect(gs.getState("s1")!.frontier).toEqual([]);
    });

    it("exhausts after second loop when maxIterations=1", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 1 });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a"); // frontier=[b]
      gs.advanceStep("s1", "agent-b"); // loop, iter=1 (not skipped), frontier=[a]
      const r = gs.advanceStep("s1", "agent-a"); // loop, iter=2 > 1 → skip, no exit → exhausted
      expect(r.kind).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(2);
      expect(gs.getState("s1")!.frontier).toEqual([]);
    });
  });

  describe("pipeline exit → completed", () => {
    it("completes when last agent in pipeline has exit edge", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "step1" },
        { from: "step1", to: "step2" },
        { from: "step2", to: "step3" },
        { from: "step3", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["step1", "step2", "step3"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "step1");
      gs.advanceStep("s1", "step2");
      const r = gs.advanceStep("s1", "step3");

      expect(r.kind).toBe("completed");
      expect(gs.getState("s1")!.completed).toEqual(["step1", "step2", "step3"]);
      expect(gs.getState("s1")!.frontier).toEqual([]);
    });
  });

  describe("persist and recover", () => {
    it("mutations mark dirty and persist via store", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "graph-persist-test-"));

      // Need to mock getDataDir — use a fresh module-scoped mock
      // Since we can't easily re-mock in bun, test via direct store usage
      const { GraphStore } = await import("../../src/graph/graph-store");
      const store = new GraphStore(tmpDir);

      const gs = new GraphSessionState();
      // Inject store directly via internal field
      (gs as any).store = store;

      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph, "orchestrator");

      // Flush immediately to persist
      gs.flushSync();

      // Verify the file was written via the store
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.has("s1")).toBe(true);
      expect(loaded!.get("s1")!.agentId).toBe("orchestrator");
      expect(loaded!.get("s1")!.state.frontier).toEqual(["agent-a"]);
      expect(loaded!.get("s1")!.state.status).toBe("active");

      // Advance a step
      gs.advanceStep("s1", "agent-a");
      gs.flushSync();

      const loaded2 = store.load();
      expect(loaded2!.get("s1")!.state.frontier).toEqual(["agent-b"]);
      expect(loaded2!.get("s1")!.state.completed).toEqual(["agent-a"]);

      // Clean up
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("recover restores state when reattach returns graph", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "graph-recover-test-"));

      const { GraphStore } = await import("../../src/graph/graph-store");
      const store = new GraphStore(tmpDir);

      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const savedGraph = makeGraph({ edges, nodes: ["agent-a"] });

      const sessions = new Map<string, { agentId: string; state: GraphExecutionState }>();
      sessions.set("s1", {
        agentId: "orch",
        state: {
          frontier: ["agent-a"],
          completed: [],
          iterationCount: 0,
          status: "active",
        },
      });
      sessions.set("s2", {
        agentId: "orch",
        state: {
          frontier: [],
          completed: ["agent-x"],
          iterationCount: 0,
          status: "complete",
        },
      });
      await store.save(sessions);

      const gs = new GraphSessionState();
      (gs as any).store = store;

      let reattachCalls: string[] = [];
      gs.recover((sessionID) => {
        reattachCalls.push(sessionID);
        if (sessionID === "s1") return savedGraph;
        return undefined;
      });

      expect(reattachCalls.sort()).toEqual(["s1", "s2"]);

      expect(gs.getState("s1")).toBeDefined();
      expect(gs.getGraph("s1")).toBeDefined();
      expect(gs.getState("s1")!.frontier).toEqual(["agent-a"]);

      // s2 should be dropped since reattach returned undefined
      expect(gs.getState("s2")).toBeUndefined();
      expect(gs.getGraph("s2")).toBeUndefined();

      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("flushSync clears dirty flag and debounce timer", async () => {
      const gs = new GraphSessionState();
      (gs as any)._dirty = true;
      const fakeTimer = setTimeout(() => {}, 99999);
      (gs as any)._persistTimer = fakeTimer;

      gs.flushSync();

      expect((gs as any)._dirty).toBe(false);
      expect((gs as any)._persistTimer).toBeUndefined();
      clearTimeout(fakeTimer);
    });

    it("setStoreDirectory creates a store", () => {
      const gs = new GraphSessionState();
      expect((gs as any).store).toBeUndefined();

      gs.setStoreDirectory("/some/dir");

      expect((gs as any).store).toBeDefined();
    });
  });

  // ── buildGraphStateBlock ────────────────────────────────────────

  describe("buildGraphStateBlock — frontier rendering", () => {
    it("renders active state with all frontier targets as next_action", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "parent", to: "agent-b" },
        { from: "agent-a", to: "parent", exit: true },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<collaboration_state>");
      expect(block).toContain("<status>active</status>");
      expect(block).toContain("<frontier>agent-a, agent-b</frontier>");
      expect(block).toContain("<completed>none</completed>");
      expect(block).toContain("<next_action>Dispatch to agent-a");
      expect(block).toContain("Dispatch to agent-b");
    });

    it("renders one frontier agent after advance in pipeline", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");

      const state = gs.getState("s1")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<frontier>agent-b</frontier>");
      expect(block).toContain("<completed>agent-a</completed>");
      expect(block).toContain("Dispatch to agent-b");
    });

    it("renders complete state with appropriate message", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");

      const state = gs.getState("s1")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<status>complete</status>");
      expect(block).toContain("<frontier>none</frontier>");
      expect(block).toContain("<completed>agent-a</completed>");
      expect(block).toContain("Workflow complete");
    });

    it("renders exhausted state with appropriate message", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "agent-b" },
        { from: "agent-b", to: "agent-a" },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"], maxIterations: 0 });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");

      const state = gs.getState("s1")!;
      const block = buildGraphStateBlock(state, graph);

      expect(block).toContain("<status>exhausted</status>");
      expect(block).toContain("Workflow exhausted");
    });
  });
});
