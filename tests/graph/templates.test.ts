import { describe, it, expect } from "bun:test";
import { expandTemplate } from "../../src/graph/templates";
import { detectLoopGroups } from "../../src/graph/loop-detector";
import { hasCycle, isExitEdge } from "../../src/graph/graph-utils";
import type { FlowEdge } from "../../src/types";

function edge(from: string, to: string, extras?: Partial<FlowEdge>): FlowEdge {
  return { from, to, ...extras };
}

describe("expandTemplate", () => {
  describe("pipeline", () => {
    it("creates a sequential chain with three agents", () => {
      const result = expandTemplate("pipeline", ["a", "b", "c"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "parent", { exit: true }),
      ]);
    });

    it("handles two agents", () => {
      const result = expandTemplate("pipeline", ["x", "y"]);
      expect(result).toEqual([
        edge("parent", "x"),
        edge("x", "y"),
        edge("y", "parent", { exit: true }),
      ]);
    });

    it("handles a single agent", () => {
      const result = expandTemplate("pipeline", ["a"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
      ]);
    });
  });

  describe("review-loop", () => {
    it("creates a loop with exit for [coder, reviewer]", () => {
      const result = expandTemplate("review-loop", ["coder", "reviewer"]);
      expect(result).toEqual([
        edge("parent", "coder"),
        edge("coder", "reviewer"),
        edge("reviewer", "coder", { label: "loop" }),
        edge("reviewer", "parent", { label: "exit", exit: true }),
      ]);
    });

    it("handles three agents with loop back to first", () => {
      const result = expandTemplate("review-loop", ["a", "b", "c"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a", { label: "loop" }),
        edge("c", "parent", { label: "exit", exit: true }),
      ]);
    });

    it("handles a single agent (loop back to itself)", () => {
      const result = expandTemplate("review-loop", ["a"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "a", { label: "loop" }),
        edge("a", "parent", { label: "exit", exit: true }),
      ]);
    });
  });

  describe("star", () => {
    it("creates bidirectional edges for three agents", () => {
      const result = expandTemplate("star", ["a", "b", "c"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
        edge("parent", "b"),
        edge("b", "parent", { exit: true }),
        edge("parent", "c"),
        edge("c", "parent", { exit: true }),
      ]);
    });

    it("handles two agents", () => {
      const result = expandTemplate("star", ["x", "y"]);
      expect(result).toEqual([
        edge("parent", "x"),
        edge("x", "parent", { exit: true }),
        edge("parent", "y"),
        edge("y", "parent", { exit: true }),
      ]);
    });

    it("handles a single agent", () => {
      const result = expandTemplate("star", ["a"]);
      expect(result).toEqual([
        edge("parent", "a"),
        edge("a", "parent", { exit: true }),
      ]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array when agents is empty (pipeline)", () => {
      expect(expandTemplate("pipeline", [])).toEqual([]);
    });

    it("returns empty array when agents is empty (review-loop)", () => {
      expect(expandTemplate("review-loop", [])).toEqual([]);
    });

    it("returns empty array when agents is empty (star)", () => {
      expect(expandTemplate("star", [])).toEqual([]);
    });

    it("throws on unknown topology", () => {
      expect(() =>
        expandTemplate("unknown" as any, ["a"]),
      ).toThrow("Unknown template topology: unknown");
    });
  });

  // ── detectLoopGroups integration ───────────────────────────────────

  describe("detectLoopGroups with template edges", () => {
    it("recognizes review-loop back-edge as exactly one loop group", () => {
      const edges = expandTemplate("review-loop", ["a", "b"]);
      const groups = detectLoopGroups(edges);

      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe("a,b");
      expect([...groups[0].nodes].sort()).toEqual(["a", "b"]);
      expect(groups[0].backEdges).toEqual([
        { from: "b", to: "a", label: "loop" },
      ]);
    });

    it("returns 0 loop groups for pipeline (acyclic)", () => {
      const edges = expandTemplate("pipeline", ["a", "b", "c"]);
      const groups = detectLoopGroups(edges);
      expect(groups).toEqual([]);
    });

    it("returns 0 loop groups for star (acyclic, no agent-edges)", () => {
      const edges = expandTemplate("star", ["a", "b"]);
      const groups = detectLoopGroups(edges);
      expect(groups).toEqual([]);
    });
  });

  // ── hasCycle / isExitEdge contract verification ───────────────────

  describe("hasCycle and isExitEdge with template edges", () => {
    it("hasCycle detects review-loop back-edge as cycle", () => {
      const edges = expandTemplate("review-loop", ["a", "b"]);
      expect(hasCycle(edges)).toBe(true);
    });

    it("hasCycle returns false for pipeline (acyclic)", () => {
      const edges = expandTemplate("pipeline", ["a", "b", "c"]);
      expect(hasCycle(edges)).toBe(false);
    });

    it("hasCycle returns false for star (acyclic)", () => {
      const edges = expandTemplate("star", ["a", "b", "c"]);
      expect(hasCycle(edges)).toBe(false);
    });

    it("isExitEdge identifies pipe/parent exit as exit edge", () => {
      const [a1, a2, exit] = expandTemplate("pipeline", ["a", "b"]);
      // parent→a, a→b, b→parent(exit)
      expect(isExitEdge(a1)).toBe(false);
      expect(isExitEdge(a2)).toBe(false);
      expect(isExitEdge(exit)).toBe(true);
    });

    it("isExitEdge identifies review-loop exit as exit edge", () => {
      const [a1, a2, loop, exit] = expandTemplate("review-loop", ["a", "b"]);
      // parent→a, a→b, b→a(loop), b→parent(exit)
      expect(isExitEdge(a1)).toBe(false);
      expect(isExitEdge(a2)).toBe(false);
      expect(isExitEdge(loop)).toBe(false);
      expect(isExitEdge(exit)).toBe(true);
    });

    it("isExitEdge identifies star exits as exit edges", () => {
      const edges = expandTemplate("star", ["a", "b"]);
      // parent→a, a→parent(exit), parent→b, b→parent(exit)
      const exits = edges.filter((e) => isExitEdge(e));
      expect(exits).toHaveLength(2);
      expect(exits.map((e) => e.from)).toEqual(["a", "b"]);
    });
  });
});
