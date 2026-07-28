import { describe, it, expect } from "bun:test";
import { parseGraph } from "../../src/graph/parser-v2";
import {
  validateGraphDeclaration,
  hasCycle as hasCycleV2,
} from "../../src/graph/validator-v2";
import type { GraphDocument } from "../../src/graph/parser-v2";
import type { EdgeDeclaration } from "../../src/types.graph-v2";

// ── helpers ──────────────────────────────────────────────────────────────

function edge(from: string, to: string, type: EdgeDeclaration["type"] = "always"): EdgeDeclaration {
  return { from, to, type };
}

/** A valid, acyclic two-node graph used as the base for validator mutations. */
function baseGraph(): GraphDocument {
  return {
    version: 2,
    name: "test",
    nodes: [
      { id: "a", agent: "agent-a", prompt: "do a" },
      { id: "b", agent: "agent-b", prompt: "do b" },
    ],
    edges: [edge("a", "b")],
  };
}

function errorsFor(graph: GraphDocument): string[] {
  return validateGraphDeclaration(graph).errors;
}

// ─────────────────────────────────────────────────────────────────────────
// Canonical example (dag-yaml-schema.md Appendix B) round-trip
// ─────────────────────────────────────────────────────────────────────────

// Verbatim from .rolebox/design/dag-yaml-schema.md — Appendix B (v2.0 schema).
const CANONICAL_EXAMPLE = `graph:
  version: 2
  name: review-team-plus

  budget:
    max_total_sessions: 20
    max_total_cost_usd: 0.50

  nodes:
    - id: root-planner
      agent: "emperor--chancellor"
      prompt: |
        Design the implementation plan for the feature.
        Available agents: {{agents}}. Budget: {{budget}}.
      budget: { max_sessions: 1, max_cost_usd: 0.03 }

    - id: implementer
      agent: "emperor--jinyiwei--backend"
      prompt: |
        Implement the feature per the design.
        Design: {{upstream_results}}
      budget: { max_sessions: 3, max_cost_usd: 0.10 }

    - id: tester
      agent: "emperor--jinyiwei--test"
      prompt: |
        Write and run tests for the implementation.
        Implementation: {{upstream_results}}
      budget: { max_sessions: 2, max_cost_usd: 0.05 }

    - id: reviewer
      agent: "emperor--validator"
      prompt: |
        Review the implementation and test results.
        If issues found, emit revise_needed with findings.
      join: { strategy: all }
      budget: { max_sessions: 1, max_cost_usd: 0.02 }

    - id: final-gate
      agent: "emperor--jinyiwei"
      prompt: |
        Review the completed work below. Approve or request changes.
        {{upstream_results}}
      needs_approval: true
      join: { strategy: all }

  edges:
    - { from: root-planner, to: implementer, type: always }
    - { from: root-planner, to: tester, type: always }
    - { from: implementer, to: reviewer, type: on_signal, signal_filter: [answer] }
    - { from: tester, to: reviewer, type: on_signal, signal_filter: [answer] }
    - { from: reviewer, to: implementer, type: on_signal, signal_filter: [revise_needed] }
    - { from: reviewer, to: final-gate, type: on_signal, signal_filter: [answer] }
    - { from: final-gate, to: implementer, type: on_signal, signal_filter: [revise_needed] }

  loop_groups:
    - id: review-cycle
      nodes: [implementer, reviewer]
      max_traversals: 5
      termination:
        any_of:
          - converged: "reviewer"
          - stuck: { repeats: 3 }

  termination:
    any_of:
      - signal: answer
      - signal: escalate
      - budget_exhausted: true
`;

describe("parseGraph — canonical Appendix B round-trip", () => {
  it("parses the canonical example and validates cleanly with expected counts", () => {
    const parsed = parseGraph(CANONICAL_EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const graph = parsed.graph;
    expect(graph.version).toBe(2);
    expect(graph.name).toBe("review-team-plus");
    // node count = 5
    expect(graph.nodes).toHaveLength(5);
    // edge count = 7
    expect(graph.edges).toHaveLength(7);
    // loop group count = 1
    expect(graph.loop_groups).toHaveLength(1);
    expect(graph.loop_groups![0].id).toBe("review-cycle");

    // Graph-level budget mapped
    expect(graph.budget?.max_total_sessions).toBe(20);

    // needs_approval flag preserved
    const gate = graph.nodes.find((n) => n.id === "final-gate");
    expect(gate?.needs_approval).toBe(true);

    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // By design the canonical graph contains the final-gate->implementer
    // revise_needed back-edge, pulling final-gate into an SCC not declared in
    // any loop group — surfaced as a non-fatal warning, not an error.
    expect(result.warnings.some((w) => w.includes("final-gate"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Parser behavior
// ─────────────────────────────────────────────────────────────────────────

describe("parseGraph — deserialization", () => {
  it("accepts a plain JSON object input", () => {
    const result = parseGraph({
      graph: { version: 2, name: "x", nodes: [{ id: "a", agent: "ag", prompt: "p" }], edges: [] },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the legacy `dag:` alias for the `graph:` block", () => {
    const result = parseGraph({
      dag: { version: 2, nodes: [{ id: "a", agent: "ag", prompt: "p" }], edges: [] },
    });
    expect(result.ok).toBe(true);
  });

  it("expands `join.strategy: quorum:3` into { strategy: quorum, quorum: 3 }", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [{ id: "a", agent: "ag", prompt: "p", join: { strategy: "quorum:3" } }],
        edges: [],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes[0].join).toEqual({ strategy: "quorum", quorum: 3 });
  });

  it("maps a bare numeric `retry` into RetryConfig { max }", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [
          { id: "a", agent: "ag", prompt: "p" },
          { id: "b", agent: "ag", prompt: "p" },
        ],
        edges: [{ from: "a", to: "b", type: "always", retry: 3 }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges[0].retry).toEqual({ max: 3 });
  });

  it("maps `data_passthrough.include` into DataMapping.fields", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [
          { id: "a", agent: "ag", prompt: "p" },
          { id: "b", agent: "ag", prompt: "p" },
        ],
        edges: [
          {
            from: "a",
            to: "b",
            type: "on_signal",
            signal_filter: ["revise_needed"],
            data_passthrough: { include: ["verdict", "findings"] },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges[0].data_passthrough?.fields).toEqual(["verdict", "findings"]);
  });

  it("round-trips data_passthrough exclude and max_chars", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [
          { id: "a", agent: "ag", prompt: "p" },
          { id: "b", agent: "ag", prompt: "p" },
        ],
        edges: [
          {
            from: "a",
            to: "b",
            type: "always",
            data_passthrough: { exclude: ["internal", "tmp.json"], max_chars: 500 },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges[0].data_passthrough).toEqual({
      exclude: ["internal", "tmp.json"],
      maxChars: 500,
    });
  });

  it("accepts `fields` as an alias key for data_passthrough include", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [
          { id: "a", agent: "ag", prompt: "p" },
          { id: "b", agent: "ag", prompt: "p" },
        ],
        edges: [
          { from: "a", to: "b", type: "always", data_passthrough: { fields: ["x"] } },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges[0].data_passthrough?.fields).toEqual(["x"]);
  });

  it("reports deserialization errors for missing required fields", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [{ id: "", agent: "ag" }], // missing prompt
        edges: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('"prompt"'))).toBe(true);
  });

  it("reports an unknown edge type", () => {
    const result = parseGraph({
      graph: {
        version: 2,
        nodes: [
          { id: "a", agent: "ag", prompt: "p" },
          { id: "b", agent: "ag", prompt: "p" },
        ],
        edges: [{ from: "a", to: "b", type: "sometimes" }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('unknown type "sometimes"'))).toBe(true);
  });

  it("reports a missing top-level graph block", () => {
    const result = parseGraph({ something: true });
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Validator — six structural rules, each with an independent message
// ─────────────────────────────────────────────────────────────────────────

describe("validateGraphDeclaration — structural checks", () => {
  it("accepts a valid acyclic graph", () => {
    const result = validateGraphDeclaration(baseGraph());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rule 1 — reports a missing version", () => {
    const { version: _dropped, ...noVersion } = baseGraph();
    const errors = errorsFor(noVersion as GraphDocument);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("version");
  });

  it("rule 1 — reports an unsupported version", () => {
    const graph = baseGraph();
    graph.version = 1 as never;
    expect(errorsFor(graph).some((e) => e.includes("unsupported graph version"))).toBe(true);
  });

  it("rule 2 — reports duplicate node ids", () => {
    const graph = baseGraph();
    graph.nodes.push({ id: "a", agent: "agent-c", prompt: "dup" });
    const errors = errorsFor(graph);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicate node id "a"');
  });

  it("rule 3 — reports an edge endpoint referencing an undeclared node", () => {
    const graph = baseGraph();
    graph.edges.push(edge("a", "ghost"));
    const errors = errorsFor(graph);
    expect(errors.some((e) => e.includes('"to"' ) && e.includes("ghost"))).toBe(true);
  });

  it("rule 4a — reports a loop group that does not form a cycle", () => {
    const graph = baseGraph();
    graph.loop_groups = [
      { id: "not-a-loop", nodes: ["a", "b"], max_traversals: 5 },
    ];
    const errors = errorsFor(graph);
    expect(errors.some((e) => e.includes("not-a-loop") && e.includes("do not form"))).toBe(true);
  });

  it("rule 4b — warns (does not fail) on a cycle uncovered by any loop group", () => {
    const graph = baseGraph();
    // introduce a cycle a<->b with no loop group declared
    graph.edges.push(edge("b", "a", "on_signal"));
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("a, b"))).toBe(true);
  });

  it("rule 5 — reports a loop group referencing an undeclared node", () => {
    const graph = baseGraph();
    // a<->b cycle so the loop group also satisfies the cycle-containment rule
    graph.edges.push(edge("b", "a"));
    graph.loop_groups = [
      { id: "cycle", nodes: ["a", "b", "missing"], max_traversals: 5 },
    ];
    const errors = errorsFor(graph);
    expect(errors.some((e) => e.includes('loop group "cycle"') && e.includes("missing"))).toBe(true);
  });

  it("rule 6 — reports a needs_approval node with a type:always outgoing edge", () => {
    const graph = baseGraph();
    graph.nodes[0].needs_approval = true; // node "a" now needs approval
    graph.edges.push(edge("a", "b")); // duplicate a->b always edge -> a has an always out-edge
    const errors = errorsFor(graph);
    expect(errors.some((e) => e.includes('node "a"') && e.includes("always"))).toBe(true);
  });

  it("allows a needs_approval node with on_signal outgoing edges", () => {
    const graph = baseGraph();
    graph.nodes[0].needs_approval = true;
    graph.edges = [edge("a", "b", "on_signal")];
    expect(validateGraphDeclaration(graph).errors).toEqual([]);
  });

  it("rule 7 — accepts a valid data_passthrough mapping", () => {
    const graph = baseGraph();
    graph.edges = [
      { from: "a", to: "b", type: "always", data_passthrough: { exclude: ["x"], maxChars: 100 } },
    ];
    expect(validateGraphDeclaration(graph).errors).toEqual([]);
  });

  it("rule 7 — reports a negative data_passthrough.max_chars", () => {
    const graph = baseGraph();
    graph.edges = [
      { from: "a", to: "b", type: "always", data_passthrough: { maxChars: -5 } },
    ];
    const errors = errorsFor(graph);
    expect(errors.some((e) => e.includes("max_chars") && e.includes("non-negative"))).toBe(true);
  });

  // ── rule 8 — loop-group root detection ──────────────────────────────────

  it("rule 8 — warns when no node has in-degree zero after excluding revise back-edges", () => {
    const graph = baseGraph();
    // a↔b cycle with both edges type:"always" → neither is filtered
    graph.edges = [edge("a", "b"), edge("b", "a")];
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(true);
  });

  it("rule 8 — no warning when a revise back-edge is filtered, exposing a root", () => {
    const graph = baseGraph();
    // a→b (always) + b→a (revise_needed) → filter b→a, a has in-degree 0
    graph.edges = [
      edge("a", "b"),
      { from: "b", to: "a", type: "on_signal", signal_filter: ["revise_needed"] },
    ];
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(false);
  });

  it("rule 8 — no warning when there is a root node outside a mutual-always cycle", () => {
    // Three nodes: root→a→b, b→a (always). Root has in-degree 0.
    const graph = {
      version: 2 as const,
      name: "test",
      nodes: [
        { id: "root", agent: "ag", prompt: "p" },
        ...baseGraph().nodes,
      ],
      edges: [
        edge("root", "a"),
        edge("a", "b"),
        edge("b", "a"),
      ],
    };
    const result = validateGraphDeclaration(graph);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(false);
  });

  it("rule 8 — no warning on a simple acyclic graph", () => {
    const result = validateGraphDeclaration(baseGraph());
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(false);
  });

  it("validator warns when a back-edge-filtered graph has zero roots", () => {
    // All-always cycle: no edge is a revise back-edge → no root after filtering → warning.
    const alwaysCycle = {
      version: 2 as const,
      name: "always-cycle",
      nodes: [
        { id: "a", agent: "ag", prompt: "p" },
        { id: "b", agent: "ag", prompt: "p" },
      ],
      edges: [
        edge("a", "b"),
        edge("b", "a"),
      ],
    };
    const r1 = validateGraphDeclaration(alwaysCycle);
    expect(r1.valid).toBe(true);
    expect(r1.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(true);

    // Revise-back-edge cycle: b → a is filtered → a has in-degree 0 → no warning.
    const reviseCycle = {
      version: 2 as const,
      name: "revise-cycle",
      nodes: [
        { id: "a", agent: "ag", prompt: "p" },
        { id: "b", agent: "ag", prompt: "p" },
      ],
      edges: [
        edge("a", "b"),
        { from: "b", to: "a", type: "on_signal" as const, signal_filter: ["revise_needed"] },
      ],
    };
    const r2 = validateGraphDeclaration(reviseCycle);
    expect(r2.valid).toBe(true);
    expect(r2.warnings.some((w) => w.includes("no unblocked entry point"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// hasCycle helper (Tarjan over v2 edges)
// ─────────────────────────────────────────────────────────────────────────

describe("hasCycle (v2 Tarjan helper)", () => {
  it("detects a simple 2-node cycle", () => {
    expect(hasCycleV2([edge("a", "b"), edge("b", "a")])).toBe(true);
  });

  it("detects a self-loop", () => {
    expect(hasCycleV2([edge("a", "a")])).toBe(true);
  });

  it("is false for an acyclic chain", () => {
    expect(hasCycleV2([edge("a", "b"), edge("b", "c")])).toBe(false);
  });

  it("detects a cycle buried in a larger graph", () => {
    expect(
      hasCycleV2([
        edge("root", "a"),
        edge("a", "b"),
        edge("b", "a"), // cycle
        edge("a", "leaf"),
      ]),
    ).toBe(true);
  });
});
