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

describe("validateGraphDeclaration — cycle-containment mode split (construct vs execution)", () => {
  const alwaysCycle: GraphDocument = {
    version: 2,
    name: "always-cycle",
    nodes: [
      { id: "a", agent: "test-agent", prompt: "test" },
      { id: "b", agent: "test-agent", prompt: "test" },
    ],
    edges: [
      { from: "a", to: "b", type: "always" },
      { from: "b", to: "a", type: "always" },
    ],
  };

  const selfLoop: GraphDocument = {
    version: 2,
    name: "self-loop",
    nodes: [{ id: "a", agent: "test-agent", prompt: "test" }],
    edges: [{ from: "a", to: "a", type: "always" }],
  };

  it("(a) execution mode fails a 2-node always-cycle with no loop group", () => {
    const result = validateGraphDeclaration(alwaysCycle, { mode: "execution" });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    const cycleError = result.errors.find(
      (msg) => msg.includes("cycle detected") && msg.includes("deadlocks at runtime"),
    );
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain("[a, b]");
    expect(cycleError).toContain("no revise back-edge");
  });

  it("(a) execution mode fails a self-loop with no loop group", () => {
    const result = validateGraphDeclaration(selfLoop, { mode: "execution" });
    expect(result.valid).toBe(false);
    const cycleError = result.errors.find(
      (msg) => msg.includes("cycle detected") && msg.includes("deadlocks at runtime"),
    );
    expect(cycleError).toBeDefined();
    expect(cycleError).toContain("[a]");
  });

  it("(b) construct mode (default) keeps the same graphs valid with only the warning", () => {
    const r1 = validateGraphDeclaration(alwaysCycle); // default mode
    expect(r1.valid).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(
      r1.warnings.some((w) => w.includes("cycle detected") && w.includes("[a, b]")),
    ).toBe(true);

    const r2 = validateGraphDeclaration(selfLoop, { mode: "construct" });
    expect(r2.valid).toBe(true);
    expect(r2.errors).toEqual([]);
    expect(r2.warnings.some((w) => w.includes("cycle detected") && w.includes("[a]"))).toBe(true);
  });

  it("(c) a revise-back-edge cycle stays valid in BOTH modes", () => {
    const reviseCycle: GraphDocument = {
      version: 2,
      name: "revise-cycle",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        {
          from: "b",
          to: "a",
          type: "on_signal",
          signal_filter: ["revise_needed"],
        },
      ],
    };

    const construct = validateGraphDeclaration(reviseCycle);
    expect(construct.valid).toBe(true);
    expect(construct.errors).toEqual([]);
    expect(
      construct.warnings.some((w) => w.includes("cycle detected") && w.includes("[a, b]")),
    ).toBe(true);

    const execution = validateGraphDeclaration(reviseCycle, { mode: "execution" });
    expect(execution.valid).toBe(true);
    expect(execution.errors).toEqual([]);
    expect(
      execution.warnings.some((w) => w.includes("cycle detected") && w.includes("[a, b]")),
    ).toBe(true);
  });

  it("(d) a covered cycle (loop group over the always-cycle) stays valid in both modes", () => {
    const covered: GraphDocument = {
      version: 2,
      name: "covered-cycle",
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

    const construct = validateGraphDeclaration(covered);
    expect(construct.valid).toBe(true);
    expect(construct.errors).toEqual([]);

    const execution = validateGraphDeclaration(covered, { mode: "execution" });
    expect(execution.valid).toBe(true);
    expect(execution.errors).toEqual([]);
  });
});

describe("validateGraphDeclaration — edge condition vocabulary (rule 3b)", () => {
  it("(a) rejects an on_condition edge with an unknown condition name", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "unknown-condition",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "on_condition", condition: "totally_made_up_condition_xyz" },
      ],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (m) => m.includes('with unknown condition "totally_made_up_condition_xyz"'),
    );
    expect(err).toBeDefined();
    expect(err).toContain('edge from="a" -> "b" is type "on_condition"');
    expect(err).toContain("registered condition vocabulary");
  });

  it("(b) accepts vocabulary conditions signal_observed(answer) and artifact_exists(docs/report.md)", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "known-conditions",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
        { id: "c", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "on_condition", condition: "signal_observed(answer)" },
        { from: "b", to: "c", type: "on_condition", condition: "artifact_exists(docs/report.md)" },
      ],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("(c) never checks non-on_condition edges", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "non-condition-edges",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [
        { from: "a", to: "b", type: "always" },
        { from: "b", to: "a", type: "on_signal", signal_filter: ["revise_needed"] },
      ],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("(d) rejects a bare-word condition not in the vocabulary", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "bare-word-condition",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [{ from: "a", to: "b", type: "on_condition", condition: "frobnicate" }],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((m) => m.includes('with unknown condition "frobnicate"')),
    ).toBe(true);
  });

  it("rejects an on_condition edge with a missing/empty condition", () => {
    const graph: GraphDocument = {
      version: 2,
      name: "missing-condition",
      nodes: [
        { id: "a", agent: "test-agent", prompt: "test" },
        { id: "b", agent: "test-agent", prompt: "test" },
      ],
      edges: [{ from: "a", to: "b", type: "on_condition" }],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (m) => m.includes('edge from="a" -> "b" is type "on_condition"') && m.includes('no "condition"'),
      ),
    ).toBe(true);
  });
});
