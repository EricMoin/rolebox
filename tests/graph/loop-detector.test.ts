import { describe, it, expect } from "bun:test";
import { detectLoopGroups } from "../../src/graph/loop-detector";
import type { FlowEdge, LoopGroup } from "../../src/types";

// ── helpers ──────────────────────────────────────────────────────

/** Extract the sorted node array from a LoopGroup for easy assertions. */
function nodesOf(g: LoopGroup): string[] {
  return [...g.nodes].sort();
}

/** Shorthand for creating a FlowEdge with no label/exit. */
function e(from: string, to: string): FlowEdge {
  return { from, to };
}

// ── test suite ───────────────────────────────────────────────────

describe("detectLoopGroups", () => {
  // ── case 1: simple A→B→A (2-node cycle) ──────────────────────

  it("detects simple A→B→A cycle as one group [a,b]", () => {
    const edges: FlowEdge[] = [e("a", "b"), e("b", "a")];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a,b");
    expect(nodesOf(groups[0])).toEqual(["a", "b"]);
    // The back edge is b→a (closes the cycle back to the already-discovered root)
    expect(groups[0].backEdges).toEqual([e("b", "a")]);
  });

  // ── case 2: self-loop A→A ─────────────────────────────────────

  it("detects self-loop A→A as one group [a]", () => {
    const edges: FlowEdge[] = [e("a", "a")];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a");
    expect(nodesOf(groups[0])).toEqual(["a"]);
    expect(groups[0].backEdges).toEqual([e("a", "a")]);
  });

  // ── case 3: two independent loops ─────────────────────────────

  it("detects two independent cycles A↔B and C↔D as two groups", () => {
    const edges: FlowEdge[] = [
      e("a", "b"),
      e("b", "a"),
      e("c", "d"),
      e("d", "c"),
    ];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(2);

    const ids = groups.map((g) => g.id).sort();
    expect(ids).toEqual(["a,b", "c,d"]);

    // Both groups should have their respective back edges
    const abGroup = groups.find((g) => g.id === "a,b")!;
    const cdGroup = groups.find((g) => g.id === "c,d")!;

    expect(nodesOf(abGroup)).toEqual(["a", "b"]);
    expect(abGroup.backEdges).toEqual([e("b", "a")]);

    expect(nodesOf(cdGroup)).toEqual(["c", "d"]);
    expect(cdGroup.backEdges).toEqual([e("d", "c")]);
  });

  // ── case 4: overlapping/nested — A→B→C→B and B→A ────────────

  it("collapses A→B→C→B and B→A into one group [a,b,c]", () => {
    const edges: FlowEdge[] = [
      e("a", "b"),
      e("b", "c"),
      e("c", "b"),
      e("b", "a"),
    ];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a,b,c");
    expect(nodesOf(groups[0])).toEqual(["a", "b", "c"]);
    // Back edges: c→b (closes the B↔C sub-cycle), b→a (closes the overall cycle)
    expect(groups[0].backEdges).toEqual([e("c", "b"), e("b", "a")]);
  });

  // ── case 5: star (no cycles) ──────────────────────────────────

  it("returns zero groups for a star graph (no cycles)", () => {
    const edges: FlowEdge[] = [e("a", "b"), e("a", "c"), e("a", "d")];
    const groups = detectLoopGroups(edges);
    expect(groups).toEqual([]);
  });

  // ── case 6: pipeline (no cycles) ──────────────────────────────

  it("returns zero groups for a pipeline A→B→C (no cycles)", () => {
    const edges: FlowEdge[] = [e("a", "b"), e("b", "c")];
    const groups = detectLoopGroups(edges);
    expect(groups).toEqual([]);
  });

  // ── case 7: three-node cycle X→Y→Z→X ─────────────────────────

  it("detects three-node cycle X→Y→Z→X as one group [x,y,z]", () => {
    const edges: FlowEdge[] = [e("x", "y"), e("y", "z"), e("z", "x")];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("x,y,z");
    expect(nodesOf(groups[0])).toEqual(["x", "y", "z"]);
    // z→x is the back edge (closes the cycle back to the DFS root x)
    expect(groups[0].backEdges).toEqual([e("z", "x")]);
  });

  // ── edge cases ────────────────────────────────────────────────

  it("returns zero groups for empty edge list", () => {
    const groups = detectLoopGroups([]);
    expect(groups).toEqual([]);
  });

  it("ignores edges to/from PARENT_NODE (same as hasCycle)", () => {
    const edges: FlowEdge[] = [
      e("parent", "a"),
      e("a", "b"),
      e("b", "a"),
      e("b", "parent"),
    ];
    const groups = detectLoopGroups(edges);

    // Only a↔b forms a cycle; parent edges are excluded
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a,b");
    expect(groups[0].backEdges).toEqual([e("b", "a")]);
  });

  it("handles exit edges within loops (exit flag doesn't affect SCC)", () => {
    const edges: FlowEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "a", exit: true },
    ];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a,b");
    // The exit-flagged edge is still a back edge
    expect(groups[0].backEdges).toEqual([
      { from: "b", to: "a", exit: true },
    ]);
  });

  it("label and exit metadata are preserved in backEdges", () => {
    const edges: FlowEdge[] = [
      e("a", "b"),
      { from: "b", to: "a", label: "revise", exit: true },
    ];
    const groups = detectLoopGroups(edges);

    expect(groups).toHaveLength(1);
    expect(groups[0].backEdges[0].label).toBe("revise");
    expect(groups[0].backEdges[0].exit).toBe(true);
  });

  it("handles isolated nodes (nodes with no edges)", () => {
    // No edges → no nodes → no groups
    const groups = detectLoopGroups([]);
    expect(groups).toEqual([]);
  });

  it("handles duplicate edges (same from→to appears twice)", () => {
    const edges: FlowEdge[] = [e("a", "b"), e("b", "a"), e("a", "b")];
    const groups = detectLoopGroups(edges);

    // Duplicate forward edge doesn't create additional groups
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("a,b");
    // First back edge found is still b→a
    expect(groups[0].backEdges).toHaveLength(1);
    expect(groups[0].backEdges[0]).toEqual(e("b", "a"));
  });
});

// ── pure-function property tests ─────────────────────────────────

describe("detectLoopGroups — pure function contract", () => {
  it("returns same result for same input (idempotent)", () => {
    const edges: FlowEdge[] = [
      e("a", "b"),
      e("b", "c"),
      e("c", "a"),
    ];
    const a = detectLoopGroups(edges);
    const b = detectLoopGroups(edges);
    expect(a).toEqual(b);
  });

  it("does not mutate input array", () => {
    const edges: FlowEdge[] = [e("a", "b"), e("b", "a")];
    const snapshot = JSON.stringify(edges);
    detectLoopGroups(edges);
    expect(JSON.stringify(edges)).toBe(snapshot);
  });

  it("handles large DAG efficiently (stress test for O(V+E))", () => {
    const edges: FlowEdge[] = [];
    for (let i = 0; i < 1000; i++) {
      edges.push(e(`n${i}`, `n${i + 1}`));
    }
    const groups = detectLoopGroups(edges);
    expect(groups).toEqual([]);
  });
});
