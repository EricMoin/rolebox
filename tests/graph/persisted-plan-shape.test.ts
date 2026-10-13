/// <reference types="bun-types" />

/**
 * The stored-plan reader's CONSUMER-SHAPE coverage: the fields the predicate
 * `isRunnablePersistedPlan` claims are actually read.
 *
 * WHY THIS FILE EXISTS. The reader proved the node fields its consumers read —
 * `agent`, `prompt`, `tools`, `inputs` and `join` — but narrowed the whole row
 * to `PersistedCompiledPlan` while `outcomes[].data`, `outcomes[].acceptance`
 * and `node.completion` were never read. Consumers DO read them:
 * `acceptance.ts` projects `outcome.data` into a data contract,
 * `natural-completion.ts` and `runtime.ts` read `node.completion.mode` and
 * `node.completion.outcome`, so a row whose bytes carried another shape was
 * narrowed into a type it did not satisfy.
 *
 * BOTH DIRECTIONS. The cases build the bad row OUT OF A REAL ONE — a plan this
 * build compiled and persisted — by mutating one field and RE-ADDRESSING the
 * body with the compiler's own `contractDigest`, so the row stays
 * content-addressed and the pre-existing integrity gate still verifies it. The
 * reader is then the only thing that reads the mutated field, and it refuses
 * the row by name (`unrunnable-plan`) instead of narrowing it. The first cases
 * prove the other direction: a plan this build compiled WITH a data contract,
 * acceptance gates and a completion policy still reads, so the reader is never
 * stricter than the producer.
 *
 * @module
 */

import { describe, expect, expectTypeOf, it } from "bun:test";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { PersistedCompiledPlan } from "../../src/graph/compiler/plan.ts";
import {
  readPersistedCompiledPlan,
  verifyPersistedCompiledPlan,
  verifyPersistedPlan,
} from "../../src/graph/compiler/verify-plan.ts";
import { contractDigest } from "../../src/graph/contracts/contract-definition.ts";
import { decodeStoredDefinition } from "../../src/graph/persistence/declared-record.ts";
import {
  completionPolicyRefOf,
  createCompletionPolicyRegistry,
  type CompletionPolicyBody,
} from "../../src/graph/policy/completion-policy.ts";
import type { GraphDefinitionRecord } from "../../src/graph/store/records.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import { AUTHORIZED, naturalDeclaration, plainDeclaration } from "./helpers/host-graph-fixture.ts";

const RECORDED_AT = 1_700_000_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("fixture: expected an array of records");
  const items: readonly unknown[] = value;
  const entries: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isPlainRecord(item)) throw new Error("fixture: expected a record");
    entries.push(item);
  }
  return entries;
}

function rowOf(graph: ReturnType<typeof buildDeclaredOutcomeGraph>): GraphDefinitionRecord {
  return {
    graphId: graph.graphId,
    declarationDigest: graph.declarationDigest,
    planRevision: graph.plan.planRevision,
    declaration: graph.declaration,
    plan: graph.record,
    recordedAt: RECORDED_AT,
  };
}

/** The real natural-completion row this build compiles and persists. */
function naturalRow(): GraphDefinitionRecord {
  return rowOf(
    buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    }),
  );
}

/** The real plain row (one node, one submitted outcome, no completion policy). */
function plainRow(): GraphDefinitionRecord {
  return rowOf(buildDeclaredOutcomeGraph({ declaration: plainDeclaration() }));
}

function nodeIdsOf(plan: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isPlainRecord(plan)) return ids;
  for (const node of plainRecordArray(plan.nodes)) {
    if (typeof node.id === "string" && node.id.length > 0) ids.add(node.id);
  }
  return ids;
}

function firstOutcomeOf(node: Record<string, unknown>): Record<string, unknown> {
  const outcome = plainRecordArray(node.outcomes)[0];
  if (outcome === undefined) throw new Error("fixture: node carries no outcomes");
  return outcome;
}

/**
 * The real row with `mutate` applied to its first node, then the plan body
 * RE-ADDRESSED with the compiler's own `contractDigest`.
 *
 * The recomputed revision is what makes a case sharp: the row stays
 * content-addressed exactly as the producer leaves its rows, so
 * `verifyPersistedCompiledPlan` still answers `verified` and the consumer
 * reader is the only thing that reads the mutated field.
 */
function rowWithNodeMutation(
  row: GraphDefinitionRecord,
  mutate: (node: Record<string, unknown>) => void,
): GraphDefinitionRecord {
  const plan = structuredClone(row.plan);
  if (!isPlainRecord(plan)) throw new Error("fixture: persisted plan is not a record");
  const node = plainRecordArray(plan.nodes)[0];
  if (node === undefined) throw new Error("fixture: persisted plan carries no nodes");
  mutate(node);
  const body = Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== "nodeBindings" && key !== "planRevision"),
  );
  const planRevision = contractDigest(body);
  plan.planRevision = planRevision;
  return { ...row, planRevision, plan };
}

/** The refusal a mutated row must produce, with the field the reader names. */
function expectRefused(row: GraphDefinitionRecord, expectedMessage: string): void {
  const nodeIds = nodeIdsOf(row.plan);
  const record = readPersistedCompiledPlan(row.plan, nodeIds);
  expect(record).toBeUndefined();

  const verdict = verifyPersistedPlan(row.plan, row.graphId, nodeIds);
  expect(verdict.kind).toBe("corrupt");
  if (verdict.kind !== "corrupt") throw new Error("expected a corrupt verdict");
  expect(verdict.reason).toContain(expectedMessage);

  const reading = decodeStoredDefinition(row);
  expect(reading.kind).toBe("refused");
  if (reading.kind !== "refused") throw new Error("expected the row to be refused");
  expect(reading.issues.map((issue) => issue.code)).toEqual(["unrunnable-plan"]);
  expect(reading.issues[0]?.path).toBe("$.plan");
}

describe("the stored-plan reader reads every consumer-visible node field", () => {
  it("reads a plain row this build compiled and persisted", () => {
    const row = plainRow();
    const nodeIds = nodeIdsOf(row.plan);
    expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIds).kind).toBe("verified");
    const record = readPersistedCompiledPlan(row.plan, nodeIds);
    expect(record).toBeDefined();
    expectTypeOf(record).toEqualTypeOf<PersistedCompiledPlan | undefined>();
    expect(decodeStoredDefinition(row).kind).toBe("ok");
  });

  it("keeps the data contracts, acceptance gates and completion policy the compiler writes", () => {
    // The reader checks `outcomes[].data`, `outcomes[].acceptance` and
    // `node.completion` too, so a plan this build produced WITH them must still
    // read: the checks are the compiler's own shapes, never a stricter rule.
    const declaration: GraphDeclarationV3 = {
      version: 3,
      name: "graph.persisted-plan-shape.consumer-fields",
      nodes: [
        {
          id: "work",
          agent: "agent.work",
          prompt: "Do the work.",
          outcomes: [
            {
              id: "done",
              data: { schema: "graph.test.payload", version: 1 },
              acceptance: [{ validator: "graph.test.check", version: 1 }],
            },
          ],
          completion: { mode: "natural", outcome: "done" },
        },
      ],
      edges: [],
      completion_policy: { id: "test.persisted-plan-shape", revision: "1" },
    };
    const body: CompletionPolicyBody = {
      version: 1,
      default: "ungranted",
      rules: [
        {
          graphId: declaration.name,
          nodeId: "work",
          outcome: "done",
          decision: "allow",
        },
      ],
    };
    const completionPolicies = createCompletionPolicyRegistry({
      policies: [
        {
          ref: completionPolicyRefOf({
            id: "test.persisted-plan-shape",
            revision: "1",
            body,
          }),
          body,
        },
      ],
    });
    const graph = buildDeclaredOutcomeGraph({
      declaration,
      supportedValidators: [{ validator: "graph.test.check", version: 1 }],
      completionPolicies,
    });
    const row = rowOf(graph);
    const nodeIds = nodeIdsOf(row.plan);

    expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIds).kind).toBe("verified");
    const record = readPersistedCompiledPlan(row.plan, nodeIds);
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("expected the consumer-field plan to read");
    expect(record.nodes[0]?.outcomes[0]?.data).toEqual({
      schema: "graph.test.payload",
      version: 1,
    });
    expect(record.nodes[0]?.outcomes[0]?.acceptance).toEqual([
      { validator: "graph.test.check", version: 1 },
    ]);
    expect(record.nodes[0]?.completion).toEqual({ mode: "natural", outcome: "done" });
    expect(decodeStoredDefinition(row).kind).toBe("ok");
  });

  it("keeps the natural completion policy the compiler writes", () => {
    const row = naturalRow();
    const nodeIds = nodeIdsOf(row.plan);
    const record = readPersistedCompiledPlan(row.plan, nodeIds);
    expect(record).toBeDefined();
    const work = record?.nodes.find((node) => node.id === "work");
    expect(work?.completion).toEqual({ mode: "natural", outcome: "done" });
    expect(decodeStoredDefinition(row).kind).toBe("ok");
  });

  describe("a mutated row the integrity gate still verifies", () => {
    it("refuses a completion mode that is not explicit or natural", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        node.completion = { mode: "sometimes" };
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).toBe(
        "verified",
      );
      expectRefused(row, 'completion mode is "sometimes", not "explicit" or "natural"');
    });

    it("refuses a natural completion whose outcome is not a non-empty id", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        node.completion = { mode: "natural", outcome: "" };
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).toBe(
        "verified",
      );
      expectRefused(row, 'natural completion outcome is "", not a non-empty outcome id');
    });

    it("refuses a data contract that is not a record", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        firstOutcomeOf(node).data = "graph.test.payload";
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).toBe(
        "verified",
      );
      expectRefused(row, 'data is "graph.test.payload", not a { schema, version? } contract');
    });

    it("refuses a data schema that is not a non-empty string", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        firstOutcomeOf(node).data = { schema: "" };
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).toBe(
        "verified",
      );
      expectRefused(row, 'data schema is "", not a non-empty string');
    });

    it("refuses a data version that is not a finite number", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        firstOutcomeOf(node).data = { schema: "graph.test.payload", version: "1" };
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).toBe(
        "verified",
      );
      expectRefused(row, 'data version is "1", not a finite number');
    });
  });

  describe("a mutated row the integrity gate also refuses", () => {
    // The topology inspector already refuses these shapes, so the reader's own
    // acceptance/outcome checks are a second line rather than the only one.
    // The row must still be refused BY NAME, never narrowed into the type.
    it("refuses outcomes that are not an array", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        node.outcomes = "done";
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).not.toBe(
        "verified",
      );
      expectRefused(row, "has no outcomes array");
    });

    it("refuses an outcome that is not a record", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        node.outcomes = [42];
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).not.toBe(
        "verified",
      );
      expectRefused(row, "has no non-empty string id");
    });

    it("refuses an acceptance list that is not an array", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        firstOutcomeOf(node).acceptance = "graph.test.check";
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).not.toBe(
        "verified",
      );
      expectRefused(row, "has no acceptance array");
    });

    it("refuses an acceptance requirement with no validator", () => {
      const row = rowWithNodeMutation(plainRow(), (node) => {
        firstOutcomeOf(node).acceptance = [{ validator: "" }];
      });
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIdsOf(row.plan)).kind).not.toBe(
        "verified",
      );
      expectRefused(row, "is not pinned to an exact validator version");
    });
  });
});
