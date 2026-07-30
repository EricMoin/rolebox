import { describe, it, expect } from "bun:test";
import { validateGraphDeclaration } from "../../src/graph/validator-v2";
import type { GraphDocument } from "../../src/graph/parser-v2";

describe("validateGraphDeclaration — checkLoopGroupRoots", () => {
  it("accepts an always-cycle declared inside a loop group (intra-group always-edges excluded from in-degree)", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "always-cycle-in-loop",
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

    // Both a→b and b→a are intra-loop-group always-edges, so neither counts
    // toward in-degree; both nodes become roots and the graph is not a deadlock.
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a node that appears in more than one loop group (fatal overlap)", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "overlapping-loop-groups",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "always" },
      ],
      loop_groups: [
        { id: "lg1", nodes: ["a", "b"], max_traversals: 3 },
        { id: "lg2", nodes: ["a", "b"], max_traversals: 3 },
      ],
    };

    const result = validateGraphDeclaration(graph);

    expect(result.valid).toBe(false);
    const overlapError = result.errors.find(
      (msg) => msg.includes("multiple loop groups") && msg.includes('node "a"'),
    );
    expect(overlapError).toBeDefined();
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
