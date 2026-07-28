import { describe, it, expect } from "bun:test";
import { validateGraphDeclaration } from "../../src/graph/validator-v2";
import type { GraphDocument } from "../../src/graph/parser-v2";

describe("validateGraphDeclaration — checkLoopGroupRoots", () => {
  it("rejects a pure-cycle deadlock when no node has in-degree zero after excluding revise back-edges", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "pure-cycle-deadlock",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "always" },
      ],
      loop_groups: [
        { id: "ab-loop", nodes: ["a", "b"], max_traversals: 3 },
      ],
    };

    const result = validateGraphDeclaration(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const rootError = result.errors.find(
      (msg) =>
        msg.includes("no entry node") ||
        msg.includes("pure cycle") ||
        msg.includes("deadlock"),
    );
    expect(rootError).toBeDefined();
  });

  it("accepts a review-loop graph where the revise back-edge is excluded from in-degree", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "valid-review-loop",
      nodes: [
        { id: "entry", agent: "test-agent", prompt: "test" },
        { id: "impl", agent: "test-agent", prompt: "test" },
        { id: "review", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "entry", to: "impl", type: "always" },
        { from: "impl", to: "review", type: "always" },
        {
          from: "review",
          to: "impl",
          type: "on_signal",
          signal_filter: ["revise_needed"],
        },
      ],
      loop_groups: [
        { id: "review-loop", nodes: ["impl", "review"], max_traversals: 3 },
      ],
    };

    const result = validateGraphDeclaration(graph);

    expect(result.valid).toBe(true);
  });
});
