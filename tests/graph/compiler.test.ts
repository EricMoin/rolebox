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
import {
  parseGraphDeclarationV3,
  type DeclarationV3Issue,
} from "../../src/graph/compiler/parse-declaration-v3.ts";

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

    // No contract was declared, so the plan pins no content and no identity.
    expect(plan.contractSnapshots).toEqual({});
    expect(plan.contractIdentities).toEqual({});

    // B9: the ONE outcome no edge binds is the plan's explicit terminal, and a
    // plan with no acceptance requirements is executable without a capability
    // set.
    expect(plan.terminalOutcomes).toEqual([
      { nodeId: "ship", outcome: "shipped" },
    ]);
    expect(plan.executability).toEqual({ kind: "executable" });
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
      inspectCompiledTopology(
        plan.nodes,
        plan.edges,
        plan.loopGroups,
        plan.terminalOutcomes,
        plan.executability,
      ),
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

  it("resolves a binding into contractSnapshots (content) and contractIdentities (identity)", () => {
    const result = compileGraph(boundGraph(snapshot.ref), {
      contracts: registry,
    });
    const plan = expectPlan(result);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(plan.contractSnapshots)).toEqual([
      snapshot.ref.digest,
    ]);
    // CONTENT: the plan carries the registry's own proven body, not a
    // re-derived one, and the entry has NO ref (B8).
    expect(plan.contractSnapshots[snapshot.ref.digest]).toEqual({
      body: snapshot.body,
    });
    expect(plan.contractIdentities).toEqual({
      [snapshot.ref.id]: { [snapshot.ref.revision]: snapshot.ref.digest },
    });
    const review = plan.nodes.find((item) => item.id === "review");
    expect(review?.contractRef).toEqual(snapshot.ref);
    // The frozen plan includes the resolved content and its body.
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
    expect(plan.contractSnapshots[snapshot.ref.digest]).toEqual({
      body: snapshot.body,
    });
  });

  it("deduplicates identical bodies while every identity keeps its own index entry", () => {
    // Two DISTINCT contract identities republishing byte-identical content.
    // Content is deduplicated by digest; identity is a separate index, so both
    // identities resolve to the one snapshot instead of the second overwriting
    // the first (the B8 regression).
    const alias: ContractRef = {
      id: "contract.alias",
      revision: "7",
      digest: snapshot.ref.digest,
    };
    const aliasSnapshot: ContractSnapshot = { ref: alias, body: snapshot.body };
    const aliasRegistry = createContractRegistry({
      contracts: [snapshot, aliasSnapshot],
    });
    const graph = loopGraph();
    const aliased: GraphDeclarationV3 = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "review"
          ? { ...item, contractRef: snapshot.ref }
          : item.id === "ship"
            ? { ...item, contractRef: alias }
            : item,
      ),
    };
    const plan = expectPlan(compileGraph(aliased, { contracts: aliasRegistry }));
    expect(Object.keys(plan.contractSnapshots)).toEqual([
      snapshot.ref.digest,
    ]);
    expect(plan.contractIdentities).toEqual({
      [snapshot.ref.id]: { [snapshot.ref.revision]: snapshot.ref.digest },
      [alias.id]: { [alias.revision]: alias.digest },
    });
    expect(
      plan.nodes.find((item) => item.id === "review")?.contractRef,
    ).toEqual(snapshot.ref);
    expect(plan.nodes.find((item) => item.id === "ship")?.contractRef).toEqual(
      alias,
    );
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

  it("answers a NON-EXECUTABLE DRAFT when supportedValidators is absent", () => {
    const result = compileGraph(validatorGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // B9: no capability set means the requirements cannot be resolved, so the
    // compilation answers a draft — never a plan that merely LOOKS executable.
    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    const executability = result.plan.executability;
    if (executability.kind !== "draft") {
      throw new Error("expected the plan body to record a draft");
    }
    expect(executability.unresolved).toEqual([
      {
        nodeId: "review",
        outcomeId: "revise",
        validator: "schema.answer",
        version: 9,
      },
      { nodeId: "review", outcomeId: "revise", validator: "artifact.exists" },
    ]);
    // The result carries the SAME frozen list the plan body records.
    expect(result.unresolved).toBe(executability.unresolved);
    expect(Object.isFrozen(result.unresolved)).toBe(true);
  });

  it("stays executable without a capability set when nothing needs resolving", () => {
    const result = compileGraph(loopGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("executable");
    expect("unresolved" in result).toBe(false);
    expect(result.plan.executability).toEqual({ kind: "executable" });
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

  it("refuses an unversioned capability as covered-but-not-version-pinned", () => {
    // The exact defect this rule exists for: an UNVERSIONED capability must not
    // satisfy a versioned requirement, and the reason is distinct from
    // "nothing covers it".
    const result = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer" },
        { validator: "artifact.exists" },
      ],
    });
    const errors = expectErrors(result);
    expect(errors.map((error) => error.code)).toEqual([
      "unpinned-validator-version",
      "unpinned-validator-version",
    ]);
  });

  it("resolves every requirement to an exact version and writes it into the plan", () => {
    const result = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer", version: 9 },
        { validator: "artifact.exists", version: 3 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("executable");
    const review = result.plan.nodes.find((item) => item.id === "review");
    const revise = review?.outcomes.find((outcome) => outcome.id === "revise");
    // The bare requirement is PINNED to the installed version, not left as
    // "any version".
    expect(revise?.acceptance).toEqual([
      { validator: "schema.answer", version: 9 },
      { validator: "artifact.exists", version: 3 },
    ]);
  });

  it("pins a bare requirement to the first matching versioned capability", () => {
    const graph = loopGraph();
    const bare = declaration(
      graph.nodes.map((item) =>
        item.id === "build"
          ? {
              ...item,
              outcomes: item.outcomes.map((outcome) =>
                outcome.id === "revise"
                  ? {
                      ...outcome,
                      acceptance: [{ validator: "schema.answer" }],
                    }
                  : outcome,
              ),
            }
          : item,
      ),
      graph.edges,
      graph.loop_groups,
    );
    const result = compileGraph(bare, {
      supportedValidators: [
        { validator: "schema.answer", version: 8 },
        { validator: "schema.answer", version: 4 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const build = result.plan.nodes.find((item) => item.id === "build");
    const revise = build?.outcomes.find((outcome) => outcome.id === "revise");
    // Declared order decides — identity, never a numeric range.
    expect(revise?.acceptance).toEqual([
      { validator: "schema.answer", version: 8 },
    ]);
  });

  it("is identity, not ordering: version 8 does not cover a requirement for 9", () => {
    const result = compileGraph(validatorGraph(), {
      supportedValidators: [
        { validator: "schema.answer", version: 8 },
        { validator: "artifact.exists", version: 3 },
      ],
    });
    expect(expectErrors(result).map((error) => error.code)).toEqual([
      "unsupported-validator",
    ]);
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
    {
      code: "unpinned-validator-version",
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
      options: { supportedValidators: [{ validator: "schema.answer" }] },
      path: "nodes.a.outcomes[0].acceptance[0]",
    },
    {
      code: "loop-continuation-without-edge",
      input: declaration(
        [node("a", ["again", "done"])],
        [],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "again",
            exit_outcome: "done",
          },
        ],
      ),
      path: "$plan",
    },
    {
      code: "cycle-not-in-loop-group",
      input: declaration(
        [node("a", ["x"]), node("b", ["y"]), node("c", ["z"])],
        [edge("a", "b", "x"), edge("b", "a", "y")],
      ),
      path: "$plan",
    },
    {
      code: "missing-terminal-outcome",
      input: declaration(
        [node("a", ["x"])],
        [edge("a", "a", "x")],
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
      path: "$plan",
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

  it("covers every error code a declaration can reach", () => {
    const documented: CompileErrorCode[] = [
      "malformed-declaration",
      "malformed-topology",
      "duplicate-node-id",
      "missing-outcomes",
      "unknown-edge-endpoint",
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
      "loop-continuation-without-edge",
      "cycle-not-in-loop-group",
      "missing-terminal-outcome",
      "terminal-outcomes-inconsistent",
      "unresolved-contract",
      "contract-digest-mismatch",
      "unsupported-validator",
      "unpinned-validator-version",
    ];
    const covered = new Set(cases.map((testCase) => testCase.code));
    // `malformed-topology` and `terminal-outcomes-inconsistent` are the two
    // DEFENSIVE members: the compiler assembles the plan body and derives the
    // terminal list itself, so no declaration reaches them. They are exercised
    // directly against the inspector in the B9 suite below, and they belong to
    // the SAME union the compiler reports from.
    expect(documented.filter((code) => !covered.has(code))).toEqual([
      "malformed-topology",
      "terminal-outcomes-inconsistent",
    ]);
  });
});

// ── Warnings ────────────────────────────────────────────────────────────────

describe("compileGraph — warnings (unused-outcome RETIRED)", () => {
  it("states an outcome with no outbound edge as a terminal instead of warning", () => {
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
    // B9: the old unused-outcome warning described exactly this case. It is
    // retired, not renamed — the plan states the exit positively.
    expect(result.warnings).toEqual([]);
    expect(result.plan.terminalOutcomes).toEqual([
      { nodeId: "a", outcome: "spare" },
      { nodeId: "b", outcome: "done" },
    ]);
  });

  it("has no warning at all for a fully bound graph", () => {
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

  it("orders terminal outcomes by canonical node and outcome id", () => {
    const graph = declaration(
      [node("b", ["bSpare"]), node("a", ["aSpare"])],
      [],
    );
    const result = compileGraph(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.terminalOutcomes).toEqual([
      { nodeId: "a", outcome: "aSpare" },
      { nodeId: "b", outcome: "bSpare" },
    ]);
  });
});

// ── B9: one plan-level inspector, one vocabulary ────────────────────────────

describe("compileGraph — the plan-level inspector owns the rules (B9)", () => {
  it("never returns a plan its own inspector rejects", () => {
    // The property the whole slice exists for: whatever the compiler RETURNS
    // must satisfy the same rules the load gate applies. Falsifying this means
    // the writer produced a plan its reader refuses.
    const inputs: unknown[] = [
      loopGraph(),
      declaration([node("a", ["x"]), node("b", ["y"])], [edge("a", "b", "x")]),
      declaration(
        [node("a", ["again", "done"])],
        [edge("a", "a", "again")],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "again",
            exit_outcome: "done",
          },
        ],
      ),
    ];
    for (const input of inputs) {
      const result = compileGraph(input);
      if (!result.ok) {
        throw new Error(
          "fixture must compile: " +
            result.errors.map((error) => error.code).join(", "),
        );
      }
      const plan = result.plan;
      expect(
        inspectCompiledTopology(
          plan.nodes,
          plan.edges,
          plan.loopGroups,
          plan.terminalOutcomes,
          plan.executability,
        ).issues,
      ).toEqual([]);
    }
  });

  it("reports the inspector's own code for a cycle with no loop group", () => {
    const result = compileGraph(
      declaration(
        [node("a", ["x"]), node("b", ["y"]), node("c", ["z"])],
        [edge("a", "b", "x"), edge("b", "a", "y")],
      ),
    );
    const errors = expectErrors(result);
    expect(errors.map((error) => error.code)).toEqual([
      "cycle-not-in-loop-group",
    ]);
    // The SAME code comes out of the inspector when the load gate calls it.
    const inspection = inspectCompiledTopology(
      [
        { id: "a", outcomes: [{ id: "x", acceptance: [] }] },
        { id: "b", outcomes: [{ id: "y", acceptance: [] }] },
        { id: "c", outcomes: [{ id: "z", acceptance: [] }] },
      ],
      [
        { from: "a", to: "b", outcome: "x" },
        { from: "b", to: "a", outcome: "y" },
      ],
      [],
      [{ nodeId: "c", outcome: "z" }],
      { kind: "executable" },
    );
    expect(inspection.issues.map((found) => found.code)).toEqual([
      "cycle-not-in-loop-group",
    ]);
  });

  it("accepts a cycle that IS contained in a declared loop group", () => {
    const result = compileGraph(
      declaration(
        [node("a", ["again", "done"])],
        [edge("a", "a", "again")],
        [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 2,
            continuation_outcome: "again",
            exit_outcome: "done",
          },
        ],
      ),
    );
    const plan = expectPlan(result);
    expect(plan.loopGroups).toHaveLength(1);
    expect(plan.terminalOutcomes).toEqual([{ nodeId: "a", outcome: "done" }]);
  });

  it("reports a node with no outcomes from the inspector's own rule", () => {
    // The load side refuses a persisted empty outcomes list with this code;
    // the inspector is what produces it, and missing-outcomes is also what the
    // compiler reports for the same defect at declaration level.
    const inspection = inspectCompiledTopology(
      [{ id: "a", outcomes: [] }],
      [],
      [],
      [],
      { kind: "executable" },
    );
    expect(inspection.issues.map((found) => found.code)).toEqual([
      "missing-outcomes",
      "missing-terminal-outcome",
    ]);
  });

  it("reports the two defensive codes a declaration cannot reach", () => {
    // malformed-topology: a body whose inputs are not the records the rules
    // read. terminal-outcomes-inconsistent: a terminal list that disagrees with
    // the edges. The compiler derives that list itself, so only a hostile
    // persisted record reaches the second — but it is the SAME union.
    const malformed = inspectCompiledTopology(
      [null],
      [],
      [],
      "not-an-array",
      { kind: "executable" },
    );
    expect(malformed.issues.map((found) => found.code)).toEqual([
      "malformed-topology",
      "missing-terminal-outcome",
      "terminal-outcomes-inconsistent",
    ]);

    const inconsistent = inspectCompiledTopology(
      [{ id: "a", outcomes: [{ id: "x", acceptance: [] }] }],
      [],
      [],
      [{ nodeId: "a", outcome: "ghost" }],
      { kind: "executable" },
    );
    expect(inconsistent.issues.map((found) => found.code)).toEqual([
      "terminal-outcomes-inconsistent",
    ]);
  });

  it("refuses an executable plan that leaves a requirement unpinned", () => {
    const inspection = inspectCompiledTopology(
      [
        {
          id: "a",
          outcomes: [
            { id: "x", acceptance: [{ validator: "schema.answer" }] },
          ],
        },
      ],
      [],
      [],
      [{ nodeId: "a", outcome: "x" }],
      { kind: "executable" },
    );
    expect(inspection.issues.map((found) => found.code)).toEqual([
      "unpinned-validator-version",
    ]);
  });
});

// ── C1: the strict v3 front-end ─────────────────────────────────────────────

describe("parseGraphDeclarationV3 — the strict v3 front-end (C1)", () => {
  /**
   * A minimal VALID declaration. It carries one node with a data contract, one
   * acceptance requirement and a budget, plus a second node whose completion
   * policy is natural — so the parser's optional branches all run.
   */
  function authoredValue(): GraphDeclarationV3 {
    return {
      version: 3,
      name: "graph.test",
      nodes: [
        {
          id: "plan",
          agent: "agent.plan",
          prompt: "Plan it.",
          outcomes: [
            {
              id: "planned",
              data: { schema: "plan.v1", version: 2 },
              acceptance: [{ validator: "schema.check", version: 1 }],
            },
          ],
          budget: { max_cost_usd: 1, timeout_ms: 1_000 },
        },
        {
          id: "build",
          agent: "agent.build",
          prompt: "Build it.",
          outcomes: [{ id: "done" }],
          completion: { mode: "natural", outcome: "done" },
          join: { strategy: "all" },
        },
      ],
      edges: [{ from: "plan", to: "build", outcome: "planned" }],
    };
  }

  /** A valid declaration as a MUTABLE record, for one-field mutations. */
  function authoredRecord(): Record<string, unknown> {
    return {
      version: 3,
      name: "graph.test",
      nodes: [
        { id: "a", agent: "agent.a", prompt: "Do a.", outcomes: [{ id: "done" }] },
      ],
      edges: [],
    };
  }

  /** The issues of a value that MUST be refused. */
  function expectParseErrors(input: unknown): readonly DeclarationV3Issue[] {
    const result = parseGraphDeclarationV3(input);
    if (result.ok) {
      throw new Error("expected the front-end to refuse the value");
    }
    return result.errors;
  }

  /** The declaration of a value that MUST be accepted. */
  function parseOk(input: unknown): GraphDeclarationV3 {
    const result = parseGraphDeclarationV3(input);
    if (!result.ok) {
      throw new Error(
        "expected the front-end to accept the value, got: " +
          result.errors.map((error) => error.code + "@" + error.path).join(", "),
      );
    }
    return result.declaration;
  }

  /** The codes of a refusal, in the order they were reported. */
  function codes(input: unknown): string[] {
    return expectParseErrors(input).map((error) => error.code);
  }

  it("parses JSON text and an already-parsed value into the same declaration", () => {
    const value = authoredValue();
    const fromValue = parseOk(value);
    const fromText = parseOk(JSON.stringify(value));

    expect(fromText).toEqual(fromValue);
    // The canonical digest is content-determined, so both routes address alike.
    expect(contractDigest(fromText)).toBe(contractDigest(fromValue));
  });

  it("keeps every optional grammar field it read", () => {
    expect(parseOk(authoredValue())).toEqual(authoredValue());
  });

  it("rejects an unknown key at every level with a stable code and its path", () => {
    const cases: ReadonlyArray<{ input: unknown; path: string }> = [
      { input: { ...authoredRecord(), extra: 1 }, path: "$.extra" },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o" }],
              typo: true,
            },
          ],
        },
        path: "$.nodes[0].typo",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o", oops: 1 }],
            },
          ],
        },
        path: "$.nodes[0].outcomes[0].oops",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o", data: { schema: "s", schemaVersion: 2 } }],
            },
          ],
        },
        path: "$.nodes[0].outcomes[0].data.schemaVersion",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [
                { id: "o", acceptance: [{ validator: "v", min: 1 }] },
              ],
            },
          ],
        },
        path: "$.nodes[0].outcomes[0].acceptance[0].min",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o" }],
              completion: { mode: "natural", outcome: "o", note: "x" },
            },
          ],
        },
        path: "$.nodes[0].completion.note",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o" }],
              contractRef: { id: "c", revision: "1", digest: "d", pinned: true },
            },
          ],
        },
        path: "$.nodes[0].contractRef.pinned",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o" }],
              join: { strategy: "all", other: 1 },
            },
          ],
        },
        path: "$.nodes[0].join.other",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o" }],
              budget: { cost_ceiling: 1 },
            },
          ],
        },
        path: "$.nodes[0].budget.cost_ceiling",
      },
      {
        input: { ...authoredRecord(), edges: [{ from: "a", to: "a", outcome: "done", type: "always" }] },
        path: "$.edges[0].type",
      },
      {
        input: {
          ...authoredRecord(),
          loop_groups: [
            {
              id: "L",
              nodes: ["a"],
              max_traversals: 1,
              continuation_outcome: "done",
              exit_outcome: "done",
              mode: "inherit",
            },
          ],
        },
        path: "$.loop_groups[0].mode",
      },
    ];

    for (const { input, path } of cases) {
      const errors = expectParseErrors(input);
      expect(
        errors.some((error) => error.code === "unknown-key" && error.path === path),
      ).toBe(true);
    }
  });

  it("rejects a wrong type naming the failing path", () => {
    const cases: ReadonlyArray<{ input: unknown; path: string }> = [
      { input: { ...authoredRecord(), version: "3" }, path: "$.version" },
      { input: { ...authoredRecord(), name: 7 }, path: "$.name" },
      { input: { ...authoredRecord(), nodes: {} }, path: "$.nodes" },
      { input: { ...authoredRecord(), edges: "none" }, path: "$.edges" },
      {
        input: {
          ...authoredRecord(),
          nodes: [{ id: "a", agent: "a", prompt: "p", outcomes: "done" }],
        },
        path: "$.nodes[0].outcomes",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [{ id: "a", agent: "a", prompt: 42, outcomes: [{ id: "o" }] }],
        },
        path: "$.nodes[0].prompt",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            { id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o", data: "schema" }] },
          ],
        },
        path: "$.nodes[0].outcomes[0].data",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            {
              id: "a",
              agent: "a",
              prompt: "p",
              outcomes: [{ id: "o", acceptance: { validator: "v" } }],
            },
          ],
        },
        path: "$.nodes[0].outcomes[0].acceptance",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [
            { id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o", data: { schema: "s", version: "2" } }] },
          ],
        },
        path: "$.nodes[0].outcomes[0].data.version",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [{ id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o" }], completion: ["natural"] }],
        },
        path: "$.nodes[0].completion",
      },
      {
        input: {
          ...authoredRecord(),
          nodes: [{ id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o" }], budget: { max_cost_usd: "1" } }],
        },
        path: "$.nodes[0].budget.max_cost_usd",
      },
      {
        input: { ...authoredRecord(), edges: [{ from: "a", to: "a", outcome: 3 }] },
        path: "$.edges[0].outcome",
      },
    ];

    for (const { input, path } of cases) {
      const errors = expectParseErrors(input);
      expect(
        errors.some((error) => error.code === "wrong-type" && error.path === path),
      ).toBe(true);
    }
  });

  it("rejects a missing required field with missing-field at its path", () => {
    const noVersion: Record<string, unknown> = { ...authoredRecord() };
    delete noVersion.version;
    expect(codes(noVersion)).toContain("missing-field");
    expect(expectParseErrors(noVersion).map((error) => error.path)).toContain(
      "$.version",
    );

    const noName: Record<string, unknown> = { ...authoredRecord() };
    delete noName.name;
    expect(expectParseErrors(noName).map((error) => error.path)).toContain(
      "$.name",
    );

    const noNodes: Record<string, unknown> = { ...authoredRecord() };
    delete noNodes.nodes;
    expect(expectParseErrors(noNodes).map((error) => error.path)).toContain(
      "$.nodes",
    );

    const noEdges: Record<string, unknown> = { ...authoredRecord() };
    delete noEdges.edges;
    expect(expectParseErrors(noEdges).map((error) => error.path)).toContain(
      "$.edges",
    );

    // The edge's outcome is REQUIRED by the v3 grammar (the compiler's own
    // missing-edge-outcome is unreachable through this front-end on purpose).
    const unboundEdge = {
      ...authoredRecord(),
      edges: [{ from: "a", to: "a" }],
    };
    expect(expectParseErrors(unboundEdge).map((error) => error.path)).toContain(
      "$.edges[0].outcome",
    );

    // A loop group's routes and cap are required too.
    const openLoop = {
      ...authoredRecord(),
      loop_groups: [{ id: "L", nodes: ["a"] }],
    };
    const openPaths = expectParseErrors(openLoop).map((error) => error.path);
    expect(openPaths).toContain("$.loop_groups[0].max_traversals");
    expect(openPaths).toContain("$.loop_groups[0].continuation_outcome");
    expect(openPaths).toContain("$.loop_groups[0].exit_outcome");
  });

  it("rejects a non-3 version as unsupported-version", () => {
    const errors = expectParseErrors({
      ...authoredRecord(),
      version: 2,
    });
    expect(errors.map((error) => error.code)).toEqual(["unsupported-version"]);
    expect(errors[0]?.path).toBe("$.version");
  });

  it("rejects bad loop limits: non-positive, fractional, unsafe and non-numeric", () => {
    for (const bad of [0, -1, 1.5, 2 ** 53, "3", Number.POSITIVE_INFINITY, null]) {
      const errors = expectParseErrors({
        ...authoredRecord(),
        loop_groups: [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: bad,
            continuation_outcome: "done",
            exit_outcome: "done",
          },
        ],
      });
      expect(errors.map((error) => error.path)).toContain(
        "$.loop_groups[0].max_traversals",
      );
      expect(errors.map((error) => error.code).some((code) =>
        code === "invalid-value" || code === "wrong-type",
      )).toBe(true);
    }
    // The valid boundary value still parses.
    expect(
      parseOk({
        ...authoredRecord(),
        loop_groups: [
          {
            id: "L",
            nodes: ["a"],
            max_traversals: 1,
            continuation_outcome: "done",
            exit_outcome: "done",
          },
        ],
      }).loop_groups?.[0]?.max_traversals,
    ).toBe(1);
  });

  it("rejects out-of-bound per-node budgets at their own paths", () => {
    const cases: ReadonlyArray<{ field: string; value: unknown }> = [
      { field: "timeout_ms", value: -5 },
      { field: "max_retries", value: -1 },
      { field: "max_retries", value: 1.5 },
      { field: "max_retries", value: 2 ** 53 },
      { field: "max_input_tokens", value: -1 },
      { field: "max_output_tokens", value: -0.5 },
      { field: "max_cost_usd", value: -1 },
    ];
    for (const { field, value } of cases) {
      const errors = expectParseErrors({
        ...authoredRecord(),
        nodes: [
          {
            id: "a",
            agent: "a",
            prompt: "p",
            outcomes: [{ id: "o" }],
            budget: { [field]: value },
          },
        ],
      });
      expect(
        errors.some(
          (error) =>
            error.code === "invalid-value" &&
            error.path === `$.nodes[0].budget.${field}`,
        ),
      ).toBe(true);
    }

    // The runtime's documented boundary values stay valid: 0 disables the
    // staleness watchdog, retries may be 0, and a ceiling may be 0.
    expect(
      parseOk({
        ...authoredRecord(),
        nodes: [
          {
            id: "a",
            agent: "a",
            prompt: "p",
            outcomes: [{ id: "o" }],
            budget: {
              max_input_tokens: 0,
              max_output_tokens: 0,
              max_cost_usd: 0,
              timeout_ms: 0,
              max_retries: 0,
            },
          },
        ],
      }).nodes[0]?.budget,
    ).toEqual({
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_cost_usd: 0,
      timeout_ms: 0,
      max_retries: 0,
    });
  });

  it("rejects a graph name that is blank after trimming", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const errors = expectParseErrors({ ...authoredRecord(), name: blank });
      expect(errors.map((error) => error.code)).toEqual(["invalid-value"]);
      expect(errors[0]?.path).toBe("$.name");
    }
    // A name with content around whitespace is still a name; the ingress does
    // not rewrite the authored spelling.
    expect(parseOk({ ...authoredRecord(), name: "  graph.test  " }).name).toBe(
      "  graph.test  ",
    );
  });

  it("rejects empty identifiers and malformed enum-like values", () => {
    expect(codes({ ...authoredRecord(), name: "" })).toEqual(["invalid-value"]);
    expect(
      codes({
        ...authoredRecord(),
        nodes: [{ id: "", agent: "a", prompt: "p", outcomes: [{ id: "o" }] }],
      }),
    ).toEqual(["invalid-value"]);
    expect(
      codes({
        ...authoredRecord(),
        nodes: [{ id: "a", agent: "a", prompt: "p", outcomes: [{ id: "" }] }],
      }),
    ).toEqual(["invalid-value"]);
    expect(
      codes({
        ...authoredRecord(),
        nodes: [
          { id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o" }], completion: { mode: "auto" } },
        ],
      }),
    ).toEqual(["invalid-value"]);
    expect(
      codes({
        ...authoredRecord(),
        nodes: [
          { id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o" }], join: { strategy: "quorum" } },
        ],
      }),
    ).toEqual(["missing-field"]);
    expect(
      codes({
        ...authoredRecord(),
        nodes: [
          { id: "a", agent: "a", prompt: "p", outcomes: [{ id: "o" }], join: { strategy: "all", quorum: 1 } },
        ],
      }),
    ).toEqual(["invalid-value"]);
  });

  it("is total: bad text and non-objects are refusals, not throws", () => {
    expect(codes("not json {")).toEqual(["not-json"]);
    for (const value of [42, true, null, [], undefined]) {
      const errors = expectParseErrors(value);
      expect(errors.map((error) => error.code)).toEqual(["not-an-object"]);
      expect(errors[0]?.path).toBe("$");
    }
  });

  it("contains a value that throws while being read (unreadable, never a throw)", () => {
    const hostile: Record<string, unknown> = { ...authoredRecord() };
    Object.defineProperty(hostile, "loop_groups", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(codes(hostile)).toEqual(["unreadable"]);

    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no keys for you");
        },
      },
    );
    expect(codes(proxy)).toEqual(["unreadable"]);
  });

  it("reports the same diagnostics whatever order the authored keys are in", () => {
    const first = { version: 3, name: "g", nodes: [], edges: [], zeta: 1, alpha: 2 };
    const second = { alpha: 2, edges: [], zeta: 1, nodes: [], name: "g", version: 3 };
    const firstIssues = expectParseErrors(first).map(
      (error) => error.code + "@" + error.path,
    );
    const secondIssues = expectParseErrors(second).map(
      (error) => error.code + "@" + error.path,
    );
    expect(secondIssues).toEqual(firstIssues);
    // Unknown keys are named in canonical (sorted) order.
    expect(firstIssues).toEqual([
      "unknown-key@$.alpha",
      "unknown-key@$.zeta",
    ]);
  });

  it("returns a fresh, deeply frozen declaration that never aliases the input", () => {
    const input = authoredValue();
    const declaration = parseOk(input);

    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.nodes)).toBe(true);
    expect(Object.isFrozen(declaration.nodes[0])).toBe(true);
    expect(Object.isFrozen(declaration.nodes[0]?.outcomes[0])).toBe(true);

    // Mutating the caller's containers afterwards cannot move the declaration.
    input.name = "mutated.graph";
    const firstNode = input.nodes[0];
    if (firstNode !== undefined) firstNode.id = "mutated";
    expect(declaration.name).toBe("graph.test");
    expect(declaration.nodes[0]?.id).toBe("plan");
  });

  it("produces a declaration the compiler accepts (front-end / compiler agreement)", () => {
    const declaration = parseOk(authoredValue());
    const result = compileGraph(declaration);
    if (!result.ok) {
      throw new Error(
        "the parsed declaration must compile: " +
          result.errors.map((error) => error.code + "@" + error.path).join(", "),
      );
    }
    expect(result.plan.graphId).toBe("graph.test");
    expect(result.plan.nodes.map((entry) => entry.id)).toEqual(["build", "plan"]);
  });

  it("parses a contract-bound node and preserves the exact ref identity", () => {
    const ref: ContractRef = {
      id: "contract.review",
      revision: "3",
      digest: contractDigest({ gates: ["schema"] }),
    };
    const declaration = parseOk({
      ...authoredRecord(),
      nodes: [
        {
          id: "a",
          agent: "agent.a",
          prompt: "Do a.",
          outcomes: [{ id: "done" }],
          contractRef: ref,
        },
      ],
    });
    expect(declaration.nodes[0]?.contractRef).toEqual(ref);
  });
});



