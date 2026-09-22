/**
 * Graph compiler (v3) — structural compilation contract.
 *
 * Covers the compiler core end to end: a valid declaration compiles to a
 * canonical, deeply frozen, content-addressed plan; every stable error code is
 * produced by a minimal declaration that triggers exactly it; the one warning
 * is non-blocking; contract resolution is delegated to the B4 resolver; and the
 * compiler is total and deterministic.
 *
 * The tests are self-contained: they create no files and mutate nothing.
 */

import { describe, expect, it } from "bun:test";

import {
  contractDigest,
  type ContractRef,
  type ContractSnapshot,
} from "../../src/graph/contracts/contract-definition.ts";
import { createContractRegistry } from "../../src/graph/contracts/resolve.ts";
import {
  compileGraph,
  type CompileErrorCode,
  type CompileIssue,
  type CompileOptions,
  type CompileResult,
} from "../../src/graph/compiler/compile.ts";
import type {
  EdgeDeclarationV3,
  GraphDeclarationV3,
  LoopGroupDeclarationV3,
  NodeDeclarationV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import {
  createPersistedCompiledPlan,
  inspectCompiledTopology,
  type CompiledPlan,
} from "../../src/graph/compiler/plan.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A minimal node that declares one outcome per id. */
function node(
  id: string,
  outcomeIds: readonly string[] = ["done"],
): NodeDeclarationV3 {
  return {
    id,
    agent: "agent." + id,
    prompt: "Run " + id + ".",
    outcomes: outcomeIds.map((outcomeId) => ({ id: outcomeId })),
  };
}

/** A minimal edge binding one outcome. */
function edge(from: string, to: string, outcome: string): EdgeDeclarationV3 {
  return { from, to, outcome };
}

/** A declaration around the given nodes, edges and optional loop groups. */
function declaration(
  nodes: NodeDeclarationV3[],
  edges: EdgeDeclarationV3[],
  loopGroups?: LoopGroupDeclarationV3[],
): GraphDeclarationV3 {
  return loopGroups === undefined
    ? { version: 3, name: "graph.test", nodes, edges }
    : { version: 3, name: "graph.test", nodes, edges, loop_groups: loopGroups };
}

/**
 * A declaration whose parts are deliberately UNTYPED. Three malformed shapes in
 * the error-code table are reachable only through the structural guard (an edge
 * with no outcome, an array-valued completion policy, a loop group with no
 * cap), so they cannot be written in the typed grammar at all — this builder is
 * how a test produces exactly what the guard lets through.
 */
function rawDeclaration(
  nodes: unknown[],
  edges: unknown[],
  loopGroups?: unknown[],
): unknown {
  return loopGroups === undefined
    ? { version: 3, name: "graph.test", nodes, edges }
    : { version: 3, name: "graph.test", nodes, edges, loop_groups: loopGroups };
}

/**
 * The canonical fixture: a four-node graph with one bounded revision loop.
 * Every outcome is either bound by an edge or the natural-completion outcome of
 * the terminal node, so a clean compile has zero errors AND zero warnings.
 */
function loopGraph(): GraphDeclarationV3 {
  return declaration(
    [
      node("plan", ["planned"]),
      node("build", ["revise", "finished"]),
      node("review", ["revise", "accepted"]),
      {
        id: "ship",
        agent: "agent.ship",
        prompt: "Ship it.",
        outcomes: [{ id: "shipped" }],
        completion: { mode: "natural", outcome: "shipped" },
      },
    ],
    [
      edge("plan", "build", "planned"),
      edge("build", "review", "revise"),
      edge("review", "build", "revise"),
      edge("build", "ship", "finished"),
      edge("review", "ship", "accepted"),
    ],
    [
      {
        id: "revision",
        nodes: ["review", "build"],
        max_traversals: 3,
        continuation_outcome: "revise",
        exit_outcome: "accepted",
      },
    ],
  );
}

/** The plan of a result that must have compiled, with a useful failure. */
function expectPlan(result: CompileResult): CompiledPlan {
  if (!result.ok) {
    throw new Error(
      "expected compilation to succeed, got: " +
        result.errors
          .map((error) => error.code + "@" + error.path)
          .join(", "),
    );
  }
  return result.plan;
}

/** The errors of a result that must have failed. */
function expectErrors(result: CompileResult): readonly CompileIssue[] {
  if (result.ok) throw new Error("expected compilation to fail, got a plan");
  return result.errors;
}

/**
 * Every reachable container that is not frozen, or that is a `Map` — the two
 * ways a plan could stop being deeply immutable.
 */
function immutabilityViolations(
  value: unknown,
  path: string,
  seen: Set<object>,
): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const violations: string[] = [];
  if (value instanceof Map) violations.push(path + " is a Map");
  if (!Object.isFrozen(value)) violations.push(path + " is not frozen");
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      violations.push(
        ...immutabilityViolations(item, path + "[" + index + "]", seen),
      );
    });
    return violations;
  }
  for (const key of Object.keys(value)) {
    violations.push(
      ...immutabilityViolations(
        (value as Record<string, unknown>)[key],
        path + "." + key,
        seen,
      ),
    );
  }
  return violations;
}

// ── A valid declaration ─────────────────────────────────────────────────────

describe("compileGraph — a valid declaration", () => {
  it("compiles a multi-node graph with a loop group into a canonical plan", () => {
    const result = compileGraph(loopGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);

    const plan = result.plan;
    expect(plan.graphId).toBe("graph.test");
    expect(plan.declarationVersion).toBe(3);

    // Nodes and their outcomes are in id order, whatever the declaration wrote.
    expect(plan.nodes.map((item) => item.id)).toEqual([
      "build",
      "plan",
      "review",
      "ship",
    ]);
    expect(plan.nodes[0].outcomes.map((outcome) => outcome.id)).toEqual([
      "finished",
      "revise",
    ]);
    // Acceptance is always present, empty when the declaration declared none.
    expect(plan.nodes[0].outcomes[0].acceptance).toEqual([]);

    // Edges are in (from, to, outcome) order.
    expect(
      plan.edges.map(
        (item) => item.from + "->" + item.to + ":" + item.outcome,
      ),
    ).toEqual([
      "build->review:revise",
      "build->ship:finished",
      "plan->build:planned",
      "review->build:revise",
      "review->ship:accepted",
    ]);

    // Loop members are a set, so they are in id order; the cap and the two
    // routes are carried as declared.
    expect(plan.loopGroups).toEqual([
      {
        id: "revision",
        nodes: ["build", "review"],
        maxTraversals: 3,
        continuationOutcome: "revise",
        exitOutcome: "accepted",
      },
    ]);

    // The natural policy survives; an absent policy stays absent.
    const ship = plan.nodes.find((item) => item.id === "ship");
    expect(ship?.completion).toEqual({ mode: "natural", outcome: "shipped" });
    const review = plan.nodes.find((item) => item.id === "review");
    expect(review === undefined ? true : "completion" in review).toBe(false);

    // No contract was declared, so the plan pins none.
    expect(plan.contractSnapshots).toEqual({});
  });

  it("deeply freezes the plan and holds no Map", () => {
    const plan = expectPlan(compileGraph(loopGraph()));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(immutabilityViolations(plan, "plan", new Set())).toEqual([]);
    // Reflect reports the frozen write as refused instead of mutating it.
    expect(Reflect.set(plan.nodes, "0", plan.nodes[1])).toBe(false);
    expect(Reflect.deleteProperty(plan, "graphId")).toBe(false);
  });

  it("addresses the plan with the ONE contractDigest over the plan body", () => {
    const plan = expectPlan(compileGraph(loopGraph()));
    const { planRevision, ...body } = plan;
    expect(planRevision).toBe(contractDigest(body));
    expect(planRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a topology the plan-level invariant rules accept (B7)", () => {
    // The loader re-checks a PERSISTED plan with these rules; a plan the
    // compiler produced must satisfy them by construction, so the compiler and
    // the load gate cannot drift into disagreeing about what a plan is.
    const plan = expectPlan(compileGraph(loopGraph()));
    expect(
      inspectCompiledTopology(plan.nodes, plan.edges, plan.loopGroups),
    ).toEqual({
      issues: [],
      nodeIds: ["build", "plan", "review", "ship"],
    });

    // The durable record carries the compiler revision and projects the
    // node bindings from the plan's own nodes.
    const record = createPersistedCompiledPlan(plan);
    expect(record.planRevision).toBe(plan.planRevision);
    expect(record.nodeBindings).toEqual({});
    expect(Object.isFrozen(record)).toBe(true);
  });
});

// ── Content addressing ──────────────────────────────────────────────────────

describe("planRevision — content addressing", () => {
  it("is identical for the same declaration in a different order", () => {
    const forward = loopGraph();
    const reversed: GraphDeclarationV3 = {
      ...forward,
      nodes: [...forward.nodes]
        .reverse()
        .map((item) => ({ ...item, outcomes: [...item.outcomes].reverse() })),
      edges: [...forward.edges].reverse(),
      loop_groups: (forward.loop_groups ?? []).map((group) => ({
        ...group,
        nodes: [...group.nodes].reverse(),
      })),
    };

    const first = expectPlan(compileGraph(forward));
    const second = expectPlan(compileGraph(reversed));
    expect(second.planRevision).toBe(first.planRevision);
    expect(second).toEqual(first);
  });

  it("moves the revision for a content change anywhere in the body", () => {
    const base = expectPlan(compileGraph(loopGraph())).planRevision;
    const graph = loopGraph();

    const variants: GraphDeclarationV3[] = [
      // Graph identity.
      { ...graph, name: "graph.other" },
      // Node content.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "build" ? { ...item, prompt: "Build differently." } : item,
        ),
      },
      // Outcome content: a renamed outcome and the edge that binds it.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "build"
            ? {
                ...item,
                outcomes: item.outcomes.map((outcome) =>
                  outcome.id === "finished"
                    ? { ...outcome, id: "completed" }
                    : outcome,
                ),
              }
            : item,
        ),
        edges: graph.edges.map((item) =>
          item.outcome === "finished"
            ? { ...item, outcome: "completed" }
            : item,
        ),
      },
      // Acceptance requirements.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "build"
            ? {
                ...item,
                outcomes: item.outcomes.map((outcome) =>
                  outcome.id === "revise"
                    ? {
                        ...outcome,
                        acceptance: [{ validator: "schema.answer", version: 1 }],
                      }
                    : outcome,
                ),
              }
            : item,
        ),
      },
      // Outcome data contract.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "build"
            ? {
                ...item,
                outcomes: item.outcomes.map((outcome) =>
                  outcome.id === "revise"
                    ? { ...outcome, data: { schema: "answer/v1" } }
                    : outcome,
                ),
              }
            : item,
        ),
      },
      // Fan-in config.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "ship"
            ? { ...item, join: { strategy: "all" as const } }
            : item,
        ),
      },
      // Resource budget.
      {
        ...graph,
        nodes: graph.nodes.map((item) =>
          item.id === "ship"
            ? { ...item, budget: { max_output_tokens: 10 } }
            : item,
        ),
      },
      // Loop cap.
      {
        ...graph,
        loop_groups: (graph.loop_groups ?? []).map((group) => ({
          ...group,
          max_traversals: 4,
        })),
      },
    ];

    for (const variant of variants) {
      const revision = expectPlan(compileGraph(variant)).planRevision;
      expect(revision).not.toBe(base);
    }
  });
});

// ── Contracts ───────────────────────────────────────────────────────────────

describe("compileGraph — contract bindings", () => {
  const body = { outcomes: ["revise", "accepted"], policy: "strict" };
  const snapshot: ContractSnapshot = {
    ref: {
      id: "contract.review",
      revision: "1",
      digest: contractDigest(body),
    },
    body,
  };
  const registry = createContractRegistry({ contracts: [snapshot] });

  /** The loop fixture with a contract bound to the review node. */
  function boundGraph(ref: ContractRef): GraphDeclarationV3 {
    const graph = loopGraph();
    return {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "review" ? { ...item, contractRef: ref } : item,
      ),
    };
  }

  it("resolves a binding into contractSnapshots keyed by digest", () => {
    const result = compileGraph(boundGraph(snapshot.ref), {
      contracts: registry,
    });
    const plan = expectPlan(result);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(plan.contractSnapshots)).toEqual([
      snapshot.ref.digest,
    ]);
    // The plan carries the registry's own proven snapshot, not a re-derived one.
    expect(plan.contractSnapshots[snapshot.ref.digest]).toBe(snapshot);
    const review = plan.nodes.find((item) => item.id === "review");
    expect(review?.contractRef).toEqual(snapshot.ref);
    // The frozen plan includes the resolved snapshot and its body.
    expect(immutabilityViolations(plan, "plan", new Set())).toEqual([]);
  });

  it("records one snapshot when two nodes bind the same contract", () => {
    const graph = loopGraph();
    const twoBindings: GraphDeclarationV3 = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "review" || item.id === "ship"
          ? { ...item, contractRef: snapshot.ref }
          : item,
      ),
    };
    const plan = expectPlan(compileGraph(twoBindings, { contracts: registry }));
    expect(Object.keys(plan.contractSnapshots)).toHaveLength(1);
    expect(plan.contractSnapshots[snapshot.ref.digest]).toBe(snapshot);
  });

  it("fails an uninstalled contract as unresolved-contract", () => {
    const ref: ContractRef = {
      id: "contract.missing",
      revision: "1",
      digest: contractDigest(body),
    };
    const errors = expectErrors(
      compileGraph(boundGraph(ref), { contracts: registry }),
    );
    expect(errors.map((error) => error.code)).toEqual(["unresolved-contract"]);
    expect(errors[0].path).toBe("nodes.review.contractRef");
  });

  it("fails an unknown revision as unresolved-contract, never a fallback", () => {
    const ref: ContractRef = { ...snapshot.ref, revision: "2" };
    const errors = expectErrors(
      compileGraph(boundGraph(ref), { contracts: registry }),
    );
    expect(errors.map((error) => error.code)).toEqual(["unresolved-contract"]);
  });

  it("fails a digest mismatch as contract-digest-mismatch with the actual digest", () => {
    const ref: ContractRef = { ...snapshot.ref, digest: "f".repeat(64) };
    const errors = expectErrors(
      compileGraph(boundGraph(ref), { contracts: registry }),
    );
    expect(errors.map((error) => error.code)).toEqual([
      "contract-digest-mismatch",
    ]);
    // The diagnostic names the digest the body really has, not just the claim.
    expect(errors[0].message).toContain(snapshot.ref.digest);
  });

  it("fails a declared ref with no registry supplied as unresolved-contract", () => {
    const errors = expectErrors(compileGraph(boundGraph(snapshot.ref)));
    expect(errors.map((error) => error.code)).toEqual(["unresolved-contract"]);
  });

  it("compiles a node without a contractRef — legal in this slice", () => {
    expect(expectPlan(compileGraph(loopGraph())).nodes).toHaveLength(4);
  });
});

// ── Validator capability ────────────────────────────────────────────────────

describe("compileGraph — validator capability", () => {
  /** The loop fixture with two acceptance requirements on review.revise. */
  function validatorGraph(): GraphDeclarationV3 {
    const graph = loopGraph();
    return {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "review"
          ? {
              ...item,
              outcomes: item.outcomes.map((outcome) =>
                outcome.id === "revise"
                  ? {
                      ...outcome,
                      acceptance: [
                        { validator: "schema.answer", version: 9 },
                        { validator: "artifact.exists" },
                      ],
                    }
                  : outcome,
              ),
            }
          : item,
      ),
    };
  }

  it("does not capability-check when supportedValidators is absent", () => {
    const result = compileGraph(validatorGraph());
    expect(result.ok).toBe(true);
  });

  it("fails every requirement no declared capability covers", () => {
    const result = compileGraph(validatorGraph(), { supportedValidators: [] });
    const errors = expectErrors(result);
    expect(errors.map((error) => error.code)).toEqual([
      "unsupported-validator",
      "unsupported-validator",
    ]);
    // Paths point at the DECLARATION slot: review declares "revise" first.
    expect(errors[0].path).toBe("nodes.review.outcomes[0].acceptance[0]");
  });

  it("covers a bare requirement with any installed version and an exact version by identity", () => {
    const bare = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer" },
        { validator: "artifact.exists" },
      ],
    });
    expect(bare.ok).toBe(true);

    const exact = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer", version: 9 },
        { validator: "artifact.exists", version: 3 },
      ],
    });
    expect(exact.ok).toBe(true);

    // Capability is identity: version 8 does not cover a requirement for 9.
    const wrongVersion = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer", version: 8 },
        { validator: "artifact.exists" },
      ],
    });
    expect(
      expectErrors(wrongVersion).map((error) => error.code),
    ).toEqual(["unsupported-validator"]);
  });
});

// ── Error codes ─────────────────────────────────────────────────────────────

describe("compileGraph — error codes", () => {
  /** One minimal declaration per stable code, each triggering exactly it. */
  const cases: {
    code: CompileErrorCode;
    input: unknown;
    options?: CompileOptions;
    path?: string;
  }[] = [
    {
      code: "malformed-declaration",
      input: { version: 3, name: "graph.test" },
      path: "$",
    },
    {
      code: "duplicate-node-id",
      input: declaration([node("a"), node("a")], []),
      path: "nodes.a",
    },
    {
      code: "missing-outcomes",
      input: declaration([node("a", [])], []),
      path: "nodes.a",
    },
    {
      code: "duplicate-outcome-id",
      input: declaration([node("a", ["dup", "dup"])], []),
      path: "nodes.a.outcomes[1]",
    },
    {
      code: "unknown-edge-endpoint",
      input: declaration(
        [node("a", ["x"]), node("b", ["y"])],
        [edge("a", "ghost", "x")],
      ),
      path: "edges[0]",
    },
    {
      code: "missing-edge-outcome",
      input: rawDeclaration([node("a", ["x"])], [{ from: "a", to: "a" }]),
      path: "edges[0]",
    },
    {
      code: "unknown-outcome-reference",
      input: declaration(
        [node("a", ["x"]), node("b", ["y"])],
        [edge("a", "b", "nope")],
      ),
      path: "edges[0]",
    },
    {
      code: "natural-completion-unknown-outcome",
      input: declaration(
        [
          {
            ...node("a", ["x"]),
            completion: { mode: "natural", outcome: "nope" },
          },
        ],
        [],
      ),
      path: "nodes.a.completion",
    },
    {
      code: "duplicate-natural-completion",
      input: rawDeclaration(
        [
          {
            ...node("a", ["x", "y"]),
            completion: [
              { mode: "natural", outcome: "x" },
              { mode: "natural", outcome: "y" },
            ],
          },
        ],
        [],
      ),
      path: "nodes.a.completion",
    },
    {
      code: "duplicate-loop-group-id",
      input: declaration(
        [node("a", ["x"])],
        [],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "x",
            exit_outcome: "x",
          },
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "x",
            exit_outcome: "x",
          },
        ],
      ),
      path: "loop_groups.L",
    },
    {
      code: "loop-group-missing-limits",
      input: rawDeclaration(
        [node("a", ["x"])],
        [],
        [
          {
            id: "L",
            nodes: ["a"],
            continuation_outcome: "x",
            exit_outcome: "x",
          },
        ],
      ),
      path: "loop_groups.L",
    },
    {
      code: "unknown-loop-member",
      input: declaration(
        [node("a", ["x"]), node("b", ["y"])],
        [],
        [
          {
            id: "L",
            nodes: ["a", "ghost"],
            max_traversals: 2,
            continuation_outcome: "x",
            exit_outcome: "x",
          },
        ],
      ),
      path: "loop_groups.L.nodes[1]",
    },
    {
      code: "unknown-loop-exit-outcome",
      input: declaration(
        [node("a", ["x"])],
        [],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "x",
            exit_outcome: "ghost",
          },
        ],
      ),
      path: "loop_groups.L.exit_outcome",
    },
    {
      code: "unknown-loop-continuation-outcome",
      input: declaration(
        [node("a", ["x"])],
        [],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "ghost",
            exit_outcome: "x",
          },
        ],
      ),
      path: "loop_groups.L.continuation_outcome",
    },
    {
      code: "loop-continuation-outside-group",
      input: declaration(
        [node("a", ["x"]), node("b", ["y"])],
        [edge("a", "b", "x")],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "x",
            exit_outcome: "x",
          },
        ],
      ),
      path: "edges[0]",
    },
    {
      code: "unresolved-contract",
      input: declaration(
        [
          {
            ...node("a", ["x"]),
            contractRef: {
              id: "contract.missing",
              revision: "1",
              digest: "0".repeat(64),
            },
          },
        ],
        [],
      ),
      options: { contracts: createContractRegistry({ contracts: [] }) },
      path: "nodes.a.contractRef",
    },
    {
      code: "contract-digest-mismatch",
      input: declaration(
        [
          {
            ...node("a", ["x"]),
            contractRef: {
              id: "contract.a",
              revision: "1",
              digest: "f".repeat(64),
            },
          },
        ],
        [],
      ),
      options: {
        contracts: createContractRegistry({
          contracts: [
            {
              ref: {
                id: "contract.a",
                revision: "1",
                digest: contractDigest({ policy: "strict" }),
              },
              body: { policy: "strict" },
            },
          ],
        }),
      },
      path: "nodes.a.contractRef",
    },
    {
      code: "unsupported-validator",
      input: declaration(
        [
          {
            ...node("a", ["x"]),
            outcomes: [
              {
                id: "x",
                acceptance: [{ validator: "schema.answer", version: 9 }],
              },
            ],
          },
        ],
        [],
      ),
      options: { supportedValidators: [] },
      path: "nodes.a.outcomes[0].acceptance[0]",
    },
  ];

  for (const testCase of cases) {
    it("reports exactly " + testCase.code, () => {
      const result = compileGraph(testCase.input, testCase.options);
      const errors = expectErrors(result);
      expect(errors.map((error) => error.code)).toEqual([testCase.code]);
      expect(errors[0].code).toBe(testCase.code);
      if (testCase.path !== undefined) {
        expect(errors[0].path).toBe(testCase.path);
      }
    });
  }

  it("covers every documented error code", () => {
    const documented: CompileErrorCode[] = [
      "malformed-declaration",
      "duplicate-node-id",
      "unknown-edge-endpoint",
      "missing-outcomes",
      "duplicate-outcome-id",
      "missing-edge-outcome",
      "unknown-outcome-reference",
      "natural-completion-unknown-outcome",
      "duplicate-natural-completion",
      "duplicate-loop-group-id",
      "loop-group-missing-limits",
      "unknown-loop-member",
      "unknown-loop-exit-outcome",
      "unknown-loop-continuation-outcome",
      "loop-continuation-outside-group",
      "unresolved-contract",
      "contract-digest-mismatch",
      "unsupported-validator",
    ];
    const covered = new Set(cases.map((testCase) => testCase.code));
    expect(documented.filter((code) => !covered.has(code))).toEqual([]);
  });
});

// ── Warnings ────────────────────────────────────────────────────────────────

describe("compileGraph — warnings", () => {
  it("reports an unused outcome as a non-blocking warning", () => {
    const graph = declaration(
      [
        node("a", ["used", "spare"]),
        {
          ...node("b", ["done"]),
          completion: { mode: "natural", outcome: "done" },
        },
      ],
      [edge("a", "b", "used")],
    );
    const result = compileGraph(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unused-outcome",
    ]);
    expect(result.warnings[0].path).toBe("nodes.a.outcomes[1]");
    expect(result.warnings[0].message).toContain("spare");
  });

  it("does not warn for a bound outcome or the natural-completion outcome", () => {
    const result = compileGraph(loopGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

// ── Totality and determinism ────────────────────────────────────────────────

describe("compileGraph — totality", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    42,
    "declaration",
    [],
    true,
    // A v2-shaped declaration is NOT this grammar.
    { version: 2, name: "legacy", nodes: [], edges: [] },
    // Missing arrays, wrong array types, empty name, wrong element shapes.
    { version: 3, name: "graph.test" },
    { version: 3, name: "graph.test", nodes: "nope", edges: [] },
    { version: 3, name: "graph.test", nodes: [], edges: "nope" },
    { version: 3, name: "", nodes: [], edges: [] },
    { version: 3, name: "graph.test", nodes: [{}], edges: [] },
    { version: 3, name: "graph.test", nodes: [node("a")], edges: [{}] },
    { version: 3, name: "graph.test", nodes: [], edges: [], loop_groups: {} },
  ];

  it("answers malformed-declaration for every non-v3 input and never throws", () => {
    for (const input of malformed) {
      const result = compileGraph(input);
      const errors = expectErrors(result);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("malformed-declaration");
    }
  });

  it("reports a throwing property read as a compile error, not an exception", () => {
    const hostile = {
      get version(): number {
        throw new Error("hostile getter");
      },
    };
    const errors = expectErrors(compileGraph(hostile));
    expect(errors[0].code).toBe("malformed-declaration");
    expect(errors[0].message).toContain("hostile getter");
  });

  it("reports a hostile THROWN value without escaping", () => {
    // The value that escapes a declaration read can be as hostile as the read:
    // a Proxy raises from `getPrototypeOf` (so `instanceof` throws) or from
    // `get` (so reading `message` and coercing with `String` throw). The
    // boundary formatter must not become the exception it is reporting.
    const hostilePrototype = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          throw new Error("hostile getPrototypeOf");
        },
      },
    );
    const hostileGet = new Proxy(new Error("carrier"), {
      get(): unknown {
        throw new Error("hostile get");
      },
    });
    for (const thrown of [hostilePrototype, hostileGet]) {
      const input = {
        get version(): number {
          throw thrown;
        },
      };
      const errors = expectErrors(compileGraph(input));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("malformed-declaration");
      expect(errors[0].path).toBe("$");
    }
  });

  it("reports a deep malformation at its own path", () => {
    const malformedOutcome: unknown = {
      version: 3,
      name: "graph.test",
      nodes: [
        { id: "a", agent: "agent.a", prompt: "A.", outcomes: [null] },
      ],
      edges: [],
    };
    const errors = expectErrors(compileGraph(malformedOutcome));
    expect(errors.map((error) => error.code)).toEqual([
      "malformed-declaration",
    ]);
    expect(errors[0].path).toBe("nodes.a.outcomes[0]");

    const malformedRef: unknown = {
      version: 3,
      name: "graph.test",
      nodes: [
        {
          id: "a",
          agent: "agent.a",
          prompt: "A.",
          outcomes: [{ id: "x" }],
          contractRef: { id: "contract.a" },
        },
      ],
      edges: [],
    };
    const refErrors = expectErrors(compileGraph(malformedRef));
    expect(refErrors.map((error) => error.code)).toEqual([
      "malformed-declaration",
    ]);
    expect(refErrors[0].path).toBe("nodes.a.contractRef");
  });
});

describe("compileGraph — determinism", () => {
  /**
   * A declaration with at least one defect in every family, in a deliberately
   * mixed order: duplicate node, empty outcomes, an unbound edge, an unknown
   * outcome, an unknown endpoint, two loop groups with open routes and a cap.
   */
  function brokenGraph(): {
    version: 3;
    name: string;
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    loop_groups: Record<string, unknown>[];
  } {
    return {
      version: 3,
      name: "broken",
      nodes: [
        {
          id: "b",
          agent: "agent.b",
          prompt: "B.",
          outcomes: [{ id: "y" }, { id: "spare" }],
        },
        { id: "a", agent: "agent.a", prompt: "A.", outcomes: [] },
        {
          id: "b",
          agent: "agent.b",
          prompt: "B again.",
          outcomes: [{ id: "y" }, { id: "spare" }],
        },
      ],
      edges: [
        { from: "b", to: "ghost", outcome: "y" },
        { from: "a", to: "b" },
        { from: "a", to: "b", outcome: "missing" },
      ],
      loop_groups: [
        {
          id: "L2",
          nodes: ["ghost"],
          max_traversals: 0,
          continuation_outcome: "nope",
          exit_outcome: "nope",
        },
        {
          id: "L1",
          nodes: ["a"],
          max_traversals: 2,
          continuation_outcome: "nope",
          exit_outcome: "nope",
        },
      ],
    };
  }

  it("produces the same issue sequence for the same declaration", () => {
    const first = compileGraph(brokenGraph());
    const second = compileGraph(brokenGraph());
    const firstErrors = expectErrors(first);
    const secondErrors = expectErrors(second);
    expect(secondErrors).toEqual(firstErrors);
    expect(second.warnings).toEqual(first.warnings);
    expect(firstErrors.length).toBeGreaterThan(5);
  });

  it("produces the same code sequence when the declaration is reordered", () => {
    const forward = brokenGraph();
    const reordered = {
      ...forward,
      nodes: [...forward.nodes].reverse(),
      edges: [...forward.edges].reverse(),
      loop_groups: [...forward.loop_groups].reverse(),
    };
    const first = expectErrors(compileGraph(forward));
    const second = expectErrors(compileGraph(reordered));
    // The CODE sequence is canonical. Paths name the declaration slot a
    // diagnostic points at (edges[2] before edges[0] in canonical validation
    // order), so they are allowed to move with the declaration — the ordering
    // contract is about the sequence, not about the index inside a path.
    expect(second.map((error) => error.code)).toEqual(
      first.map((error) => error.code),
    );
  });

  it("orders warnings by canonical node and outcome id", () => {
    const graph = declaration(
      [node("b", ["bSpare"]), node("a", ["aSpare"])],
      [],
    );
    const result = compileGraph(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((warning) => warning.path)).toEqual([
      "nodes.a.outcomes[0]",
      "nodes.b.outcomes[0]",
    ]);
  });
});
