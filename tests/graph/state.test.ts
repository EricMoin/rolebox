import { describe, it, expect } from "bun:test";
import { GraphSessionState, graphSessionState } from "../../src/graph/state";
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

describe("GraphSessionState", () => {
  describe("initGraph", () => {
    it("initializes state as active with step 0, iteration 0, empty completedSteps", () => {
      const gs = fresh();
      const graph = makeGraph({
        edges: [{ from: "parent", to: "agent-a" }],
      });
      gs.initGraph("s1", graph);

      const state = gs.getState("s1")!;
      expect(state).toBeDefined();
      expect(state.currentStep).toBe(0);
      expect(state.completedSteps).toEqual([]);
      expect(state.iterationCount).toBe(0);
      expect(state.status).toBe("active");
    });

    it("re-initializes if called twice for same session", () => {
      const gs = fresh();
      const graph = makeGraph({
        edges: [{ from: "parent", to: "agent-a" }],
      });
      gs.initGraph("s1", graph);
      gs.getState("s1")!.completedSteps.push("agent-a");
      gs.getState("s1")!.iterationCount = 2;

      gs.initGraph("s1", graph);
      const state = gs.getState("s1")!;
      expect(state.currentStep).toBe(0);
      expect(state.completedSteps).toEqual([]);
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

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completedSteps).toEqual(["agent-a"]);
      expect(gs.getState("s1")!.currentStep).toBe(1);

      gs.advanceStep("s1", "agent-b");
      expect(gs.getState("s1")!.status).toBe("complete");
      expect(gs.getState("s1")!.completedSteps).toEqual(["agent-a", "agent-b"]);
    });

    it("completes on single-step pipeline (parent→a, a→parent)", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
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

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("active");

      gs.advanceStep("s1", "agent-b");
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

      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");

      expect(gs.getState("s1")!.iterationCount).toBe(1);
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.completedSteps).toEqual(["agent-a", "agent-b"]);
    });

    it("exhausts when iterationCount exceeds maxIterations", () => {
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

      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");
      expect(gs.getState("s1")!.status).toBe("active");
      expect(gs.getState("s1")!.iterationCount).toBe(1);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("exhausted");
      expect(gs.getState("s1")!.iterationCount).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("advanceStep on unknown session is a no-op", () => {
      const gs = fresh();
      expect(() => gs.advanceStep("nonexistent", "agent-a")).not.toThrow();
    });

    it("advanceStep when already complete is a no-op", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.status).toBe("complete");

      const frozen = { ...gs.getState("s1")! };
      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")).toEqual(frozen);
    });

    it("advanceStep when exhausted is a no-op", () => {
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

      const frozen = { ...gs.getState("s1")! };
      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")).toEqual(frozen);
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

  describe("getNextAction", () => {
    it("returns the edge at currentStep when active", () => {
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
      expect(next).toEqual(edges[0]);
    });

    it("returns the correct edge after advanceStep", () => {
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
      const next = gs.getNextAction(state, graph);
      expect(next).toEqual(edges[1]);
    });

    it("returns undefined when status is complete", () => {
      const gs = fresh();
      const edges: FlowEdge[] = [
        { from: "parent", to: "agent-a" },
        { from: "agent-a", to: "parent", exit: true },
      ];
      const graph = makeGraph({ edges, nodes: ["agent-a"] });
      gs.initGraph("s1", graph);
      gs.advanceStep("s1", "agent-a");

      const state = gs.getState("s1")!;
      expect(gs.getNextAction(state, graph)).toBeUndefined();
    });

    it("returns undefined when status is exhausted", () => {
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
      expect(gs.getNextAction(state, graph)).toBeUndefined();
    });
  });

  describe("singleton", () => {
    it("graphSessionState is an instance of GraphSessionState", () => {
      expect(graphSessionState).toBeInstanceOf(GraphSessionState);
    });
  });

  describe("completedSteps tracks order correctly", () => {
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

      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");
      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");
      gs.advanceStep("s1", "agent-a");
      gs.advanceStep("s1", "agent-b");

      expect(gs.getState("s1")!.completedSteps).toEqual([
        "agent-a", "agent-b",
        "agent-a", "agent-b",
        "agent-a", "agent-b",
      ]);
      expect(gs.getState("s1")!.iterationCount).toBe(5);

      gs.advanceStep("s1", "agent-a");
      expect(gs.getState("s1")!.iterationCount).toBe(6);
      expect(gs.getState("s1")!.status).toBe("exhausted");
    });
  });
});
