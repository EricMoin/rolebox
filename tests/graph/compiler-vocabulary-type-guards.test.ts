/**
 * The compiler/policy/domain vocabulary guards (audit F-02) and the two
 * exhaustiveness fixes beside them (F-15, F-18).
 *
 * WHY A TYPE-LEVEL FILE. `bun test` is transpile-only, so a closed vocabulary
 * that drifts from the type it mirrors keeps every runtime suite green. Each
 * key list below is imported from its source and pinned to the model it
 * guards, so `bun run typecheck:tests` — this file's authority — fails the
 * moment a key is added to, or removed from, one side only.
 *
 * The runtime cases pin the BEHAVIOUR the type-level rewrites had to preserve:
 * every `CompletionReading` member still maps the same way through the real
 * compiler (F-15), and the join-satisfiability rule answers identically whether
 * it is handed a whole plan or the three-field topology it actually reads
 * (F-18).
 *
 * @module
 */

import { describe, expect, expectTypeOf, it } from "bun:test";

import type { ContractRef } from "../../src/graph/contracts/contract-definition.ts";
import {
  compileGraph,
  unsatisfiableJoinsOf,
} from "../../src/graph/compiler/compile.ts";
import type {
  AcceptanceRequirementV3,
  CompletionPolicyRequestV3,
  EdgeDeclarationV3,
  GraphDeclarationV3,
  InputDeclarationV3,
  LoopGroupDeclarationV3,
  NodeDeclarationV3,
  OutcomeDataV3,
  OutcomeDeclarationV3,
  ProgressPolicyV3,
} from "../../src/graph/compiler/declaration-v3.ts";
import {
  ACCEPTANCE_KEYS,
  BUDGET_KEYS,
  COMPLETION_POLICY_REQUEST_KEYS,
  CONTRACT_REF_KEYS,
  EDGE_KEYS,
  INPUT_KEYS,
  JOIN_KEYS,
  LOOP_GROUP_KEYS,
  NODE_KEYS,
  OUTCOME_DATA_KEYS,
  OUTCOME_KEYS,
  PROGRESS_KEYS,
  ROOT_KEYS,
} from "../../src/graph/compiler/parse-declaration-v3.ts";
import type {
  CompiledPlanBody,
  JoinTopology,
} from "../../src/graph/compiler/plan.ts";
import { BODY_KEYS } from "../../src/graph/compiler/verify-plan.ts";
import {
  BUDGET_KEY_DIMENSIONS,
  BUDGET_LIMIT_FIELDS,
  BUDGET_LIMIT_KINDS,
  budgetOverrunsOf,
  nodeBudgetLimitsOf,
  type BudgetLimitKind,
  type BudgetUsageAmounts,
  type NodeBudgetLimits,
  type NodeBudgetSpec,
} from "../../src/graph/domain/budget.ts";
import type { JoinConfig } from "../../src/graph/domain/join.ts";
import {
  COMPLETION_AUTHORIZATION_ISSUE_CODES,
  type CompletionAuthorizationIssueCode,
} from "../../src/graph/policy/completion-policy.ts";
import {
  entryNodesOf,
  feederSourcesOf,
} from "../../src/graph/outcome/join-state.ts";

/**
 * Compile-time completeness assertion: the type argument is the set of keys the
 * list it is paired with omits, so anything but `never` fails to compile at the
 * alias that instantiates this.
 */
type MissingKeysAreNever<Missing extends never> = Missing;

/**
 * Every key ANY member of a discriminated declaration union declares:
 * `keyof (A | B)` is only the keys the members share.
 */
type DeclaredKeys<T> = T extends unknown ? keyof T : never;

// ── F-02: every grammar level's key tuple is linked to its type ─────────────
//
// One alias per level. A key the level declares and its tuple omits (or the
// reverse) is a compile error here, in the source file, and in the pin below.

type _RootKeysComplete = MissingKeysAreNever<Exclude<keyof GraphDeclarationV3, (typeof ROOT_KEYS)[number]>>;
type _NodeKeysComplete = MissingKeysAreNever<Exclude<keyof NodeDeclarationV3, (typeof NODE_KEYS)[number]>>;
type _InputKeysComplete = MissingKeysAreNever<Exclude<keyof InputDeclarationV3, (typeof INPUT_KEYS)[number]>>;
type _OutcomeKeysComplete = MissingKeysAreNever<Exclude<keyof OutcomeDeclarationV3, (typeof OUTCOME_KEYS)[number]>>;
type _OutcomeDataKeysComplete = MissingKeysAreNever<Exclude<keyof OutcomeDataV3, (typeof OUTCOME_DATA_KEYS)[number]>>;
type _AcceptanceKeysComplete = MissingKeysAreNever<Exclude<keyof AcceptanceRequirementV3, (typeof ACCEPTANCE_KEYS)[number]>>;
type _EdgeKeysComplete = MissingKeysAreNever<Exclude<keyof EdgeDeclarationV3, (typeof EDGE_KEYS)[number]>>;
type _LoopGroupKeysComplete = MissingKeysAreNever<Exclude<keyof LoopGroupDeclarationV3, (typeof LOOP_GROUP_KEYS)[number]>>;
type _ProgressKeysComplete = MissingKeysAreNever<Exclude<keyof ProgressPolicyV3, (typeof PROGRESS_KEYS)[number]>>;
type _ContractRefKeysComplete = MissingKeysAreNever<Exclude<keyof ContractRef, (typeof CONTRACT_REF_KEYS)[number]>>;
type _CompletionPolicyRequestKeysComplete = MissingKeysAreNever<Exclude<keyof CompletionPolicyRequestV3, (typeof COMPLETION_POLICY_REQUEST_KEYS)[number]>>;
type _JoinKeysComplete = MissingKeysAreNever<Exclude<DeclaredKeys<JoinConfig>, (typeof JOIN_KEYS)[number]>>;
type _BudgetKeysComplete = MissingKeysAreNever<Exclude<keyof NodeBudgetSpec, (typeof BUDGET_KEYS)[number]>>;

// The persisted-plan verifier's restatement of the plan body, and the three
// other closed vocabularies the same wave linked to their owning types.
type _BodyKeysComplete = MissingKeysAreNever<Exclude<keyof CompiledPlanBody, (typeof BODY_KEYS)[number]>>;
type _BudgetDimensionKeysComplete = MissingKeysAreNever<
  Exclude<keyof Omit<NodeBudgetSpec, "max_retries">, (typeof BUDGET_KEY_DIMENSIONS)[number][0]>
>;
type _BudgetLimitKindsComplete = MissingKeysAreNever<Exclude<BudgetLimitKind, (typeof BUDGET_LIMIT_KINDS)[number]>>;
type _BudgetLimitFieldsComplete = MissingKeysAreNever<
  Exclude<BudgetLimitKind, (typeof BUDGET_LIMIT_FIELDS)[number][0]>
>;
type _CompletionIssueCodesComplete = MissingKeysAreNever<
  Exclude<CompletionAuthorizationIssueCode, (typeof COMPLETION_AUTHORIZATION_ISSUE_CODES)[number]>
>;

describe("F-02 — a closed vocabulary names exactly the keys of the type it mirrors", () => {
  it("pins every grammar level's key tuple", () => {
    expectTypeOf<(typeof ROOT_KEYS)[number]>().toEqualTypeOf<keyof GraphDeclarationV3>();
    expectTypeOf<(typeof NODE_KEYS)[number]>().toEqualTypeOf<keyof NodeDeclarationV3>();
    expectTypeOf<(typeof INPUT_KEYS)[number]>().toEqualTypeOf<keyof InputDeclarationV3>();
    expectTypeOf<(typeof OUTCOME_KEYS)[number]>().toEqualTypeOf<keyof OutcomeDeclarationV3>();
    expectTypeOf<(typeof OUTCOME_DATA_KEYS)[number]>().toEqualTypeOf<keyof OutcomeDataV3>();
    expectTypeOf<(typeof ACCEPTANCE_KEYS)[number]>().toEqualTypeOf<keyof AcceptanceRequirementV3>();
    expectTypeOf<(typeof EDGE_KEYS)[number]>().toEqualTypeOf<keyof EdgeDeclarationV3>();
    expectTypeOf<(typeof LOOP_GROUP_KEYS)[number]>().toEqualTypeOf<keyof LoopGroupDeclarationV3>();
    expectTypeOf<(typeof PROGRESS_KEYS)[number]>().toEqualTypeOf<keyof ProgressPolicyV3>();
    expectTypeOf<(typeof CONTRACT_REF_KEYS)[number]>().toEqualTypeOf<keyof ContractRef>();
    expectTypeOf<(typeof COMPLETION_POLICY_REQUEST_KEYS)[number]>().toEqualTypeOf<keyof CompletionPolicyRequestV3>();
    expectTypeOf<(typeof JOIN_KEYS)[number]>().toEqualTypeOf<DeclaredKeys<JoinConfig>>();
    expectTypeOf<(typeof BUDGET_KEYS)[number]>().toEqualTypeOf<keyof NodeBudgetSpec>();
  });

  it("pins the verifier's plan-body field list to the model", () => {
    expectTypeOf<(typeof BODY_KEYS)[number]>().toEqualTypeOf<keyof CompiledPlanBody>();
  });

  it("pins the budget key sets to the model and the dimension union", () => {
    expectTypeOf<(typeof BUDGET_KEY_DIMENSIONS)[number][0]>().toEqualTypeOf<
      keyof Omit<NodeBudgetSpec, "max_retries">
    >();
    expectTypeOf<(typeof BUDGET_LIMIT_KINDS)[number]>().toEqualTypeOf<BudgetLimitKind>();
    expect(BUDGET_KEY_DIMENSIONS.length).toBe(4);
    for (const [, dimension] of BUDGET_KEY_DIMENSIONS) {
      expect(BUDGET_LIMIT_KINDS).toContain(dimension);
    }
  });

  it("pins the completion draft-reason vocabulary to its union", () => {
    expectTypeOf<(typeof COMPLETION_AUTHORIZATION_ISSUE_CODES)[number]>().toEqualTypeOf<
      CompletionAuthorizationIssueCode
    >();
  });

  it("authorizes every key in the single budget list, and refuses an unmodelled one", () => {
    for (const [key] of BUDGET_KEY_DIMENSIONS) {
      expect(nodeBudgetLimitsOf({ [key]: 1 }).kind).toBe("ok");
    }
    const unmodelled: Record<string, unknown> = { max_wall_ms: 1 };
    expect(nodeBudgetLimitsOf(unmodelled).kind).toBe("refused");
  });
});

// ── F-02 / C-05: the dimension → field list is the one source for both readers
//
// The completeness alias above fails to compile the moment a `BudgetLimitKind`
// is added without a field here; the runtime cases then pin that BOTH readers
// actually consume the list — every dimension is compared, and each ceiling is
// written into its own field rather than into the last `else` branch.

describe("F-02 / C-05 — one dimension → field list drives ceiling reads and overruns", () => {
  it("pins the dimension list to both sides it maps", () => {
    expectTypeOf<(typeof BUDGET_LIMIT_FIELDS)[number][0]>().toEqualTypeOf<BudgetLimitKind>();
    expectTypeOf<(typeof BUDGET_LIMIT_FIELDS)[number][1]>().toEqualTypeOf<
      keyof NodeBudgetLimits & keyof BudgetUsageAmounts
    >();
    expect(BUDGET_LIMIT_FIELDS.length).toBe(BUDGET_LIMIT_KINDS.length);
  });

  it("reports every over-limit dimension, in canonical order", () => {
    const limits: NodeBudgetLimits = {
      durationMs: 10,
      inputTokens: 20,
      outputTokens: 30,
      costUsd: 40,
    };
    const exact: BudgetUsageAmounts = {
      executions: 0,
      durationMs: 10,
      inputTokens: 20,
      outputTokens: 30,
      costUsd: 40,
    };
    const over: BudgetUsageAmounts = {
      executions: 0,
      durationMs: 11,
      inputTokens: 22,
      outputTokens: 33,
      costUsd: 44,
    };
    // `>` not `>=`: usage exactly at the ceiling is not an overrun.
    expect(budgetOverrunsOf("node", limits, exact)).toEqual([]);
    expect(budgetOverrunsOf("node", limits, over).map((entry) => entry.kind)).toEqual([
      "duration_ms",
      "input_tokens",
      "output_tokens",
      "cost_usd",
    ]);
    expect(budgetOverrunsOf("node", limits, over).map((entry) => entry.overBy)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("reads each authorized key into the field its own dimension owns", () => {
    const reading = nodeBudgetLimitsOf({
      max_input_tokens: 7,
      max_output_tokens: 8,
      max_cost_usd: 9,
      timeout_ms: 10,
    });
    expect(reading).toEqual({
      kind: "ok",
      limits: { durationMs: 10, inputTokens: 7, outputTokens: 8, costUsd: 9 },
    });
  });
});

// ── F-15: every CompletionReading member maps as before ─────────────────────

function nodeOf(overrides: Partial<NodeDeclarationV3> = {}): NodeDeclarationV3 {
  return {
    id: "a",
    agent: "agent",
    prompt: "prompt",
    outcomes: [{ id: "done" }],
    ...overrides,
  };
}

function declarationOf(node: NodeDeclarationV3): GraphDeclarationV3 {
  return { version: 3, name: "vocabulary-guards", nodes: [node], edges: [] };
}

/**
 * A raw declaration carrying whatever `completion` the case needs.
 * `compileGraph` takes `unknown`, so a malformed policy reaches the compiler
 * without a cast.
 */
function rawDeclaration(completion: unknown): unknown {
  return {
    version: 3,
    name: "vocabulary-guards",
    nodes: [
      { id: "a", agent: "agent", prompt: "prompt", outcomes: [{ id: "done" }], completion },
    ],
    edges: [],
  };
}

describe("F-15 — the completion mapping stays total over CompletionReading", () => {
  it("maps an ABSENT reading to no plan policy", () => {
    const compiled = compileGraph(declarationOf(nodeOf()));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("the absent-policy declaration was refused");
    expect(compiled.plan.nodes[0]?.completion).toBeUndefined();
  });

  it("maps an EXPLICIT reading to { mode: explicit }", () => {
    const compiled = compileGraph(
      declarationOf(nodeOf({ completion: { mode: "explicit" } })),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("the explicit-policy declaration was refused");
    expect(compiled.plan.nodes[0]?.completion).toEqual({ mode: "explicit" });
  });

  it("maps a well-formed NATURAL reading to { mode: natural, outcome }", () => {
    // No completion policy is installed, so the mapping is a DRAFT — but the
    // plan still carries exactly the policy the declaration asked for.
    const compiled = compileGraph(
      declarationOf(nodeOf({ completion: { mode: "natural", outcome: "done" } })),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("the natural-policy declaration was refused");
    expect(compiled.kind).toBe("draft");
    expect(compiled.plan.nodes[0]?.completion).toEqual({
      mode: "natural",
      outcome: "done",
    });
  });

  it("refuses an INVALID reading with malformed-declaration", () => {
    const compiled = compileGraph(rawDeclaration({ mode: "nope" }));
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("the invalid-policy declaration compiled");
    expect(compiled.errors.map((entry) => entry.code)).toContain("malformed-declaration");
  });

  it("refuses a DUPLICATE-NATURAL reading with duplicate-natural-completion", () => {
    const compiled = compileGraph(
      rawDeclaration([
        { mode: "natural", outcome: "done" },
        { mode: "natural", outcome: "done" },
      ]),
    );
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("the duplicate-natural declaration compiled");
    expect(compiled.errors.map((entry) => entry.code)).toContain(
      "duplicate-natural-completion",
    );
  });

  it("refuses a NATURAL reading naming an outcome the node does not declare", () => {
    const compiled = compileGraph(
      declarationOf(nodeOf({ completion: { mode: "natural", outcome: "ghost" } })),
    );
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("the unknown-outcome declaration compiled");
    expect(compiled.errors.map((entry) => entry.code)).toContain(
      "natural-completion-unknown-outcome",
    );
  });
});

// ── F-18: the join readers take the topology, not a fabricated plan ─────────

function entryNode(): NodeDeclarationV3 {
  return { id: "entry", agent: "agent", prompt: "prompt", outcomes: [{ id: "go" }] };
}

function diamondDeclaration(): GraphDeclarationV3 {
  return {
    version: 3,
    name: "join-topology",
    nodes: [
      entryNode(),
      {
        id: "left",
        agent: "agent",
        prompt: "prompt",
        outcomes: [{ id: "report" }],
        inputs: [{ from: "entry", outcome: "go" }],
      },
      {
        id: "right",
        agent: "agent",
        prompt: "prompt",
        outcomes: [{ id: "report" }],
        inputs: [{ from: "entry", outcome: "go" }],
      },
      {
        id: "join",
        agent: "agent",
        prompt: "prompt",
        outcomes: [{ id: "done" }],
        inputs: [
          { from: "left", outcome: "report" },
          { from: "right", outcome: "report" },
        ],
        join: { strategy: "all" },
      },
    ],
    edges: [
      { from: "entry", to: "left", outcome: "go" },
      { from: "entry", to: "right", outcome: "go" },
      { from: "left", to: "join", outcome: "report" },
      { from: "right", to: "join", outcome: "report" },
    ],
  };
}

describe("F-18 — the join topology is the three fields its readers read", () => {
  it("types the satisfiability parameter as JoinTopology", () => {
    expectTypeOf<Parameters<typeof unsatisfiableJoinsOf>[0]>().toEqualTypeOf<JoinTopology>();
    expectTypeOf<JoinTopology>().toEqualTypeOf<
      Pick<CompiledPlanBody, "nodes" | "edges" | "loopGroups">
    >();
    expectTypeOf<Parameters<typeof entryNodesOf>[0]>().toEqualTypeOf<JoinTopology>();
    expectTypeOf<Parameters<typeof feederSourcesOf>[0]>().toEqualTypeOf<JoinTopology>();
  });

  it("answers the same on a bare topology as on the compiled plan", () => {
    const compiled = compileGraph(diamondDeclaration());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("the diamond declaration was refused");
    const plan = compiled.plan;
    const topology: JoinTopology = {
      nodes: plan.nodes,
      edges: plan.edges,
      loopGroups: plan.loopGroups,
    };
    expect(feederSourcesOf(topology, "join")).toEqual(["left", "right"]);
    expect(feederSourcesOf(topology, "join")).toEqual(feederSourcesOf(plan, "join"));
    expect(entryNodesOf(topology).map((node) => node.id)).toEqual(
      entryNodesOf(plan).map((node) => node.id),
    );
    expect(unsatisfiableJoinsOf(topology)).toEqual(unsatisfiableJoinsOf(plan));
    expect(unsatisfiableJoinsOf(topology)).toEqual([]);
  });
});
