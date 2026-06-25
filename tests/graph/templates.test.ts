import { describe, it, expect } from "bun:test";
import { expandTemplate } from "../../src/graph/templates";
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
});
