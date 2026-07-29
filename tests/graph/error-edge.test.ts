/**
 * Error-path and boundary tests for the graph module.
 *
 * Covers: illegal transition graphs, malformed parse input,
 * termination deadlock scenarios — additive, no modifications
 * to existing tests.
 */
import { describe, it, expect } from "bun:test";
import { validateGraph } from "../../src/graph/collaboration-validator";
import { parseFlow, parseStringEdge, parseObjectEdge } from "../../src/graph/edge-parser";
import { isExitEdge, hasCycle } from "../../src/graph/graph-utils";
import type { FlowEdge, ResolvedGraph } from "../../src/types";

// ─── Helpers ────────────────────────────────────────────────────────

function edge(from: string, to: string, extras?: Partial<FlowEdge>): FlowEdge {
  return { from, to, ...extras };
}

function makeResolvedGraph(overrides: Partial<ResolvedGraph> = {}): ResolvedGraph {
  return {
    edges: [],
    nodes: [],
    exitEdges: [],
    loopGroups: [],
    maxIterations: 0,
    ...overrides,
  };
}

// ─── Illegal transition graphs ──────────────────────────────────────

describe("validateGraph — illegal transitions", () => {
  it("fails when graph has no exit edge (infinite loop with no escape)", () => {
    const graph: ResolvedGraph = makeResolvedGraph({
      edges: [
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "a"),
      ],
      nodes: ["a", "b"],
      maxIterations: 10,
    });

    const result = validateGraph(graph, ["a", "b"]);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.toLowerCase().includes("exit"))).toBe(true);
  });

  it("fails when graph has no entry point from parent", () => {
    // Edges form a valid subgraph but none originates from "parent".
    // Exit edge targets "parent" (known node) so validateNodesExist passes.
    const graph: ResolvedGraph = makeResolvedGraph({
      edges: [
        edge("a", "b"),
        edge("b", "parent", { exit: true }),
      ],
      nodes: ["a", "b"],
      maxIterations: 5,
    });

    const result = validateGraph(graph, ["a", "b"]);
    expect(result.valid).toBe(false);
    expect(result.warnings.some((w) => w.toLowerCase().includes("entry"))).toBe(true);
  });

  it("warns on orphan agents not referenced in edges", () => {
    const graph: ResolvedGraph = makeResolvedGraph({
      edges: [
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
      ],
      nodes: ["a"],
      maxIterations: 0,
    });

    const result = validateGraph(graph, ["a", "unused_b", "unused_c"]);
    expect(result.valid).toBe(true); // orphans are non-fatal
    const orphanWarnings = result.warnings.filter((w) =>
      w.toLowerCase().includes("orphan"),
    );
    expect(orphanWarnings.length).toBe(2);
  });

  it("detects disconnected subgraph (unreachable node)", () => {
    const graph: ResolvedGraph = makeResolvedGraph({
      edges: [
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
        edge("c", "d"),
        edge("d", "parent", { exit: true }),
      ],
      nodes: ["a", "c", "d"],
      maxIterations: 0,
    });

    const result = validateGraph(graph, ["a", "c", "d"]);
    expect(result.valid).toBe(true);
    const disconnectedWarnings = result.warnings.filter((w) =>
      w.toLowerCase().includes("disconnected"),
    );
    expect(disconnectedWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it("warns when cycle exists but maxIterations is not set", () => {
    const graph: ResolvedGraph = makeResolvedGraph({
      edges: [
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "a"),
        edge("b", "parent", { exit: true }),
      ],
      nodes: ["a", "b"],
      maxIterations: 0,
    });

    const result = validateGraph(graph, ["a", "b"]);
    expect(result.valid).toBe(true);
    const cycleWarnings = result.warnings.filter((w) =>
      w.toLowerCase().includes("cycle"),
    );
    expect(cycleWarnings.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Malformed parse input ──────────────────────────────────────────

describe("parseFlow — malformed input", () => {
  it("returns empty array for non-array input", () => {
    expect(parseFlow(null)).toEqual([]);
    expect(parseFlow(undefined)).toEqual([]);
    expect(parseFlow("not-an-array")).toEqual([]);
    expect(parseFlow(42)).toEqual([]);
  });

  it("skips items with unsupported types (numbers, booleans, null)", () => {
    const mixed = [
      "coder -> reviewer",
      42,
      true,
      null,
      "reviewer -> parent",
    ];
    const edges = parseFlow(mixed);
    expect(edges.length).toBe(2);
  });

  it("rejects malformed string edge syntax and returns null", () => {
    const result = parseStringEdge("this is not an edge");
    expect(result).toBeNull();
  });

  it("rejects edge with empty from/to fields", () => {
    const result = parseObjectEdge({ from: "", to: "a" });
    expect(result).toBeNull();
  });

  it("rejects object edge missing from field", () => {
    const result = parseObjectEdge({ to: "b" });
    expect(result).toBeNull();
  });

  it("rejects object edge missing to field", () => {
    const result = parseObjectEdge({ from: "a" });
    expect(result).toBeNull();
  });

  it("handles edge strings with only whitespace", () => {
    const result = parseStringEdge("   ");
    expect(result).toBeNull();
  });
});

// ─── Termination deadlock scenarios ────────────────────────────────

describe("graph termination — deadlock detection", () => {
  it("hasCycle returns false for a DAG (no deadlock)", () => {
    const edges = [
      edge("parent", "a"),
      edge("a", "b"),
      edge("b", "parent", { exit: true }),
    ];
    expect(hasCycle(edges)).toBe(false);
  });

  it("hasCycle returns true for self-loop (deadlock)", () => {
    const edges = [edge("a", "a")];
    expect(hasCycle(edges)).toBe(true);
  });

  it("isExitEdge returns true for edge to parent", () => {
    expect(isExitEdge(edge("a", "parent"))).toBe(true);
  });

  it("isExitEdge returns true for edge with explicit exit flag", () => {
    expect(isExitEdge(edge("a", "b", { exit: true }))).toBe(true);
  });

  it("isExitEdge returns false for non-exit edges", () => {
    expect(isExitEdge(edge("a", "b"))).toBe(false);
  });

  it("hasCycle detects three-node cycle (termination deadlock)", () => {
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ];
    expect(hasCycle(edges)).toBe(true);
  });

  it("hasCycle ignores parent edges (not part of deadlock analysis)", () => {
    const edges = [
      edge("parent", "a"),
      edge("a", "b"),
      edge("b", "parent", { exit: true }),
    ];
    expect(hasCycle(edges)).toBe(false);
  });
});
