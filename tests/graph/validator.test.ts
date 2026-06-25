import { describe, it, expect } from "bun:test";
import { validateGraph } from "../../src/graph/validator";
import type { ResolvedGraph, FlowEdge } from "../../src/types";

function makeGraph(overrides?: Partial<ResolvedGraph>): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    maxIterations: 0,
    exitEdges: [],
    ...overrides,
  };
}

describe("validateGraph", () => {
  it("returns valid for a simple pipeline graph", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "agent-b" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("returns invalid when edge references unknown agent in 'from' field", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "unknown-agent", to: "agent-b" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain("unknown-agent");
  });

  it("returns invalid when edge references unknown agent in 'to' field", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "unknown-agent" },
      { from: "agent-a", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, ["agent-a"]);
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain("unknown-agent");
  });

  it("considers 'parent' as always valid", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, ["agent-a"]);
    expect(result.valid).toBe(true);
  });

  // ─── Exit edge ─────────────────────────────────────────────────

  it("returns invalid when no exit edge exists", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "agent-b" },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain("exit edge");
  });

  it("accepts 'exit: true' flag as a valid exit", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "agent-b", exit: true },
      { from: "agent-b", to: "parent" },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(true);
  });

  it("accepts edge to 'parent' as a valid exit", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "parent" },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, ["agent-a"]);
    expect(result.valid).toBe(true);
  });

  // ─── Entry point ───────────────────────────────────────────────

  it("returns invalid when no entry point (edge from 'parent') exists", () => {
    const edges: FlowEdge[] = [
      { from: "agent-a", to: "agent-b" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain("entry point");
  });

  // ─── Orphan agents ─────────────────────────────────────────────

  it("warns about orphan agents but does not mark invalid", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, ["agent-a", "orphan-agent"]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      'Orphan agent "orphan-agent" is not referenced in any edge',
    );
  });

  it("warns about multiple orphan agents", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, [
      "agent-a",
      "orphan-1",
      "orphan-2",
    ]);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Cycle detection ───────────────────────────────────────────

  it("warns about cycle without maxIterations and defaults to 3", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "agent-b" },
      { from: "agent-b", to: "agent-a" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Cycle") && w.includes("defaulting to 3"))).toBe(
      true,
    );
  });

  it("does not warn about cycle when maxIterations is set", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "agent-b" },
      { from: "agent-b", to: "agent-a" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({
      edges,
      nodes: ["agent-a", "agent-b"],
      maxIterations: 5,
    });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(true);
    expect(result.warnings.filter((w) => w.includes("Cycle"))).toEqual([]);
  });

  it("does not flag edges through 'parent' as cycles", () => {
    const edges: FlowEdge[] = [
      { from: "parent", to: "agent-a" },
      { from: "agent-a", to: "parent" },
      { from: "parent", to: "agent-b" },
      { from: "agent-b", to: "parent", exit: true },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a", "agent-b"] });
    const result = validateGraph(graph, ["agent-a", "agent-b"]);
    expect(result.valid).toBe(true);
    expect(result.warnings.filter((w) => w.includes("Cycle"))).toEqual([]);
  });

  // ─── Combined scenarios ────────────────────────────────────────

  it("reports multiple validation failures", () => {
    const edges: FlowEdge[] = [
      { from: "unknown", to: "agent-a" },
    ];
    const graph = makeGraph({ edges, nodes: ["agent-a"] });
    const result = validateGraph(graph, ["agent-a"]);
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
