import { describe, it, expect } from "bun:test";
import { registerTopology, expandTemplate } from "../../src/graph/templates";
import { GRAPH_TEMPLATE_VALUES, addGraphTemplateValue } from "../../src/constants";
import type { FlowEdge } from "../../src/types";

describe("Graph Topologies Registry", () => {
  it("built-in topologies exist in GRAPH_TEMPLATE_VALUES", () => {
    expect(GRAPH_TEMPLATE_VALUES.has("pipeline")).toBe(true);
    expect(GRAPH_TEMPLATE_VALUES.has("review-loop")).toBe(true);
    expect(GRAPH_TEMPLATE_VALUES.has("star")).toBe(true);
  });

  it("built-in pipeline expands correctly", () => {
    const edges = expandTemplate("pipeline", ["a", "b", "c"]);
    expect(edges.length).toBe(4);
    expect(edges[0]).toEqual({ from: "parent", to: "a" });
    expect(edges[3]).toEqual({ from: "c", to: "parent", exit: true });
  });

  it("registerTopology adds a custom topology", () => {
    const diamondExpander = (agents: string[]): FlowEdge[] => {
      if (agents.length < 3) return [];
      const [entry, ...middle] = agents;
      const exit = middle.pop()!;
      const edges: FlowEdge[] = [{ from: "parent", to: entry }];
      for (const m of middle) {
        edges.push({ from: entry, to: m });
        edges.push({ from: m, to: exit });
      }
      edges.push({ from: exit, to: "parent", exit: true });
      return edges;
    };

    registerTopology("diamond", diamondExpander);
    addGraphTemplateValue("diamond");

    expect(GRAPH_TEMPLATE_VALUES.has("diamond")).toBe(true);

    const edges = expandTemplate("diamond", ["entry", "mid1", "mid2", "exit"]);
    expect(edges.length).toBe(6);
    expect(edges[0]).toEqual({ from: "parent", to: "entry" });
    expect(edges[1]).toEqual({ from: "entry", to: "mid1" });
    expect(edges[2]).toEqual({ from: "mid1", to: "exit" });
    expect(edges[5]).toEqual({ from: "exit", to: "parent", exit: true });
  });

  it("expandTemplate throws for truly unknown topology", () => {
    expect(() => expandTemplate("nonexistent", ["a"])).toThrow();
  });
});
