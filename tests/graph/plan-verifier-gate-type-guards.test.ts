
/**
 * The stored-plan reader's guards (F-04, plus A-11's agreement rule).
 *
 * WHY THIS FILE EXISTS. `persistence/declared-record.ts` used to decode the
 * `plan` column as `unknown`, run `verifyPersistedPlan(plan, plan, …)` — the
 * SAME record for both parameters — and then re-assert the column
 * `as PersistedCompiledPlan`. That validator proves topology, executability, the
 * contract indexes, the node-binding projection and the recomputed content
 * address, but it never reads the node fields its consumers read: a content
 * address proves integrity, not shape. `outcome/graph-state.ts` copies
 * `targetNode.agent`/`.prompt` into an `OutcomeDispatchIntent` whose fields are
 * `string`, so a row whose node omitted `agent` was accepted here and reached
 * dispatch as `undefined`.
 *
 * The cases below build that row OUT OF A REAL ONE — a plan this build compiled
 * and persisted — by removing one node field and RE-ADDRESSING the body with the
 * compiler's own `contractDigest`, so the row is still content-addressed and the
 * integrity gate still verifies it. That is the row the old gate accepted; the
 * reader now refuses it BY NAME (`unrunnable-plan`). The same reader must keep
 * every plan this build produces: the round trips below persist a real
 * declaration through the store and read it back, including the EMPTY `agent`
 * the v3 grammar explicitly allows (the reader requires a string, not a
 * non-empty one, so it is never stricter than the producer).
 *
 * The last case pins that the 120-line plan-binding agreement rule — a
 * tautology at its only production call site — is gone, and that
 * `verifyPersistedPlan` no longer takes a second record to compare against.
 *
 * @module
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import type { PersistedCompiledPlan } from "../../src/graph/compiler/plan.ts";
import {
  readPersistedCompiledPlan,
  verifyPersistedCompiledPlan,
  verifyPersistedPlan,
} from "../../src/graph/compiler/verify-plan.ts";
import * as verifyPlan from "../../src/graph/compiler/verify-plan.ts";
import { contractDigest } from "../../src/graph/contracts/contract-definition.ts";
import {
  decodeStoredDefinition,
  readStoredDefinition,
} from "../../src/graph/persistence/declared-record.ts";
import type { GraphDefinitionRecord } from "../../src/graph/store/records.ts";
import {
  buildDeclaredOutcomeGraph,
  persistDeclaredGraph,
} from "../../src/graph/tools/declare-graph.ts";
import { AUTHORIZED, naturalDeclaration } from "./helpers/host-graph-fixture.ts";

const RECORDED_AT = 1_700_000_000_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The real declaration this build compiles, as the store persists it. */
function storedRow(): GraphDefinitionRecord {
  const graph = buildDeclaredOutcomeGraph({
    declaration: naturalDeclaration(),
    completionPolicies: AUTHORIZED,
  });
  return {
    graphId: graph.graphId,
    declarationDigest: graph.declarationDigest,
    planRevision: graph.plan.planRevision,
    declaration: graph.declaration,
    plan: graph.record,
    recordedAt: RECORDED_AT,
  };
}

/**
 * The plain-record elements of a persisted array, or `undefined` if any element
 * is not a record. Written as a reader rather than `Array.isArray` plus
 * iteration so the elements stay `unknown` instead of widening to `any`.
 */
function plainRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: readonly unknown[] = value;
  const entries: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isPlainRecord(item)) return undefined;
    entries.push(item);
  }
  return entries;
}

function nodeIdsOf(plan: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!isPlainRecord(plan)) return ids;
  const nodes = plainRecordArray(plan.nodes);
  if (nodes === undefined) return ids;
  for (const node of nodes) {
    if (typeof node.id === "string" && node.id.length > 0) ids.add(node.id);
  }
  return ids;
}

/**
 * The real row with one field removed from the first persisted node, then the
 * plan body RE-ADDRESSED with the compiler's own `contractDigest`.
 *
 * The recomputed revision is what makes the case sharp: the row stays
 * content-addressed exactly as the producer left it, so the integrity gate
 * (`verifyPersistedCompiledPlan`) still answers `verified` — and the reader is
 * the only thing that reads the missing field.
 */
function rowWithoutNodeField(field: "agent" | "prompt"): GraphDefinitionRecord {
  const row = storedRow();
  const plan = structuredClone(row.plan);
  if (!isPlainRecord(plan)) throw new Error("fixture: persisted plan is not a record");
  const nodes = plainRecordArray(plan.nodes);
  if (nodes === undefined || nodes.length === 0) {
    throw new Error("fixture: persisted plan carries no nodes");
  }
  const node = nodes.find((entry) => entry.id === "work");
  if (node === undefined) throw new Error("fixture: persisted plan has no work node");
  delete node[field];

  const body = Object.fromEntries(
    Object.entries(plan).filter(
      ([key]) => key !== "nodeBindings" && key !== "planRevision",
    ),
  );
  const planRevision = contractDigest(body);
  plan.planRevision = planRevision;
  return { ...row, planRevision, plan };
}

describe("the stored-plan reader", () => {
  it("round-trips a plan this build compiled and persisted", () => {
    const graph = buildDeclaredOutcomeGraph({
      declaration: naturalDeclaration(),
      completionPolicies: AUTHORIZED,
    });
    const dir = mkdtempSync(join(tmpdir(), "plan-verifier-gate-"));
    try {
      expect(persistDeclaredGraph(graph, dir)).toBe(true);
      const reading = readStoredDefinition(dir, graph.graphId);
      expect(reading.kind).toBe("ok");
      if (reading.kind !== "ok") {
        throw new Error(`expected an ok reading, received ${reading.kind}`);
      }
      // Node order in the plan is canonical (id order), so the cases address a
      // node by its id rather than by its position.
      const nodes = new Map(
        reading.declared.plan.nodes.map((node) => [node.id, node] as const),
      );
      expect([...nodes.keys()].sort()).toEqual(["ship", "work"]);
      expect(nodes.get("work")?.agent).toBe("agent.work");
      expect(nodes.get("work")?.prompt).toBe("Do the work.");
      expect(nodes.get("ship")?.agent).toBe("agent.ship");
      expect(reading.declared.plan.planRevision).toBe(graph.plan.planRevision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads back the real record and pins the reader's return type", () => {
    const row = storedRow();
    const nodeIds = nodeIdsOf(row.plan);
    const reading = decodeStoredDefinition(row);
    expect(reading.kind).toBe("ok");

    const record = readPersistedCompiledPlan(row.plan, nodeIds);
    expect(record).toBeDefined();
    expectTypeOf(record).toEqualTypeOf<PersistedCompiledPlan | undefined>();
    if (record === undefined) throw new Error("expected the real plan to read");
    expect(record.planRevision).toBe(row.planRevision);
    const work = record.nodes.find((node) => node.id === "work");
    expect(work?.agent).toBe("agent.work");
    expect(work?.prompt).toBe("Do the work.");
  });

  it("keeps the EMPTY agent and prompt the v3 grammar allows", () => {
    // The grammar reads both fields as strings of ANY length (see
    // `readString`/`readNode` in `parse-declaration-v3.ts`), so an empty agent
    // is a plan THIS BUILD produced and the reader must not refuse it: it
    // requires a `string`, never a non-empty one.
    const declaration: GraphDeclarationV3 = {
      version: 3,
      name: "graph.plan-verifier.empty-agent",
      nodes: [{ id: "work", agent: "", prompt: "", outcomes: [{ id: "done" }] }],
      edges: [],
    };
    const graph = buildDeclaredOutcomeGraph({ declaration });
    const row: GraphDefinitionRecord = {
      graphId: graph.graphId,
      declarationDigest: graph.declarationDigest,
      planRevision: graph.plan.planRevision,
      declaration: graph.declaration,
      plan: graph.record,
      recordedAt: RECORDED_AT,
    };
    const reading = decodeStoredDefinition(row);
    expect(reading.kind).toBe("ok");
    if (reading.kind !== "ok") {
      throw new Error(`expected the empty-agent plan to read, received ${reading.kind}`);
    }
    expect(reading.declared.plan.nodes[0]?.agent).toBe("");
    expect(reading.declared.plan.nodes[0]?.prompt).toBe("");
  });

  it("keeps the tool grant, inputs and join the compiler writes", () => {
    // The reader also reads `tools`, `inputs` and `join`, so a plan this build
    // produced WITH them must still read: the checks are the compiler's own
    // shapes, never a stricter rule.
    const declaration: GraphDeclarationV3 = {
      version: 3,
      name: "graph.plan-verifier.consumer-fields",
      nodes: [
        { id: "a", agent: "agent.a", prompt: "A", outcomes: [{ id: "done" }], tools: ["host_tool"] },
        { id: "b", agent: "agent.b", prompt: "B", outcomes: [{ id: "done" }], tools: ["host_tool"] },
        {
          id: "c",
          agent: "agent.c",
          prompt: "C",
          outcomes: [{ id: "done" }],
          join: { strategy: "quorum", quorum: 1 },
          inputs: [
            { from: "a", outcome: "done" },
            { from: "b", outcome: "done" },
          ],
          tools: ["host_tool"],
        },
      ],
      edges: [
        { from: "a", to: "c", outcome: "done" },
        { from: "b", to: "c", outcome: "done" },
      ],
    };
    const graph = buildDeclaredOutcomeGraph({ declaration });
    const dir = mkdtempSync(join(tmpdir(), "plan-verifier-gate-fields-"));
    try {
      expect(persistDeclaredGraph(graph, dir)).toBe(true);
      const reading = readStoredDefinition(dir, graph.graphId);
      expect(reading.kind).toBe("ok");
      if (reading.kind !== "ok") {
        throw new Error(`expected an ok reading, received ${reading.kind}`);
      }
      const c = reading.declared.plan.nodes.find((node) => node.id === "c");
      expect(c?.tools).toEqual(["host_tool"]);
      expect(c?.join).toEqual({ strategy: "quorum", quorum: 1 });
      expect(c?.inputs?.map((input) => input.from)).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const field of ["agent", "prompt"] as const) {
    it(`refuses a content-addressed row whose node omits ${field}`, () => {
      const row = rowWithoutNodeField(field);
      const nodeIds = nodeIdsOf(row.plan);

      // THE ROW IS STILL CONTENT-ADDRESSED. The body was re-hashed, so the
      // whole pre-F-04 integrity gate VERIFIES it — this is the acceptance the
      // new refusal discriminates against.
      expect(verifyPersistedCompiledPlan(row.plan, row.graphId, nodeIds).kind).toBe("verified");

      // The reader reads the node field the gate never did, so it refuses the
      // row instead of handing a `PersistedCompiledPlan` outward.
      expect(readPersistedCompiledPlan(row.plan, nodeIds)).toBeUndefined();
      expect(verifyPersistedPlan(row.plan, row.graphId, nodeIds).kind).toBe("corrupt");

      const reading = decodeStoredDefinition(row);
      expect(reading.kind).toBe("refused");
      if (reading.kind !== "refused") throw new Error("expected the row to be refused");
      expect(reading.issues.map((issue) => issue.code)).toEqual(["unrunnable-plan"]);
      expect(reading.issues[0]?.path).toBe("$.plan");
      expect(reading.issues[0]?.message).toContain(`node "work" ${field} is`);
      expect(reading.issues[0]?.message).toContain(
        `not the string its dispatch intent requires`,
      );
    });
  }

  it("has no plan-binding agreement rule left to compare a record with itself", () => {
    expect("verifyPersistedPlanAgreement" in verifyPlan).toBe(false);
    expectTypeOf(verifyPersistedPlan).parameters.toEqualTypeOf<
      [unknown, string, ReadonlySet<string>]
    >();
  });
});
