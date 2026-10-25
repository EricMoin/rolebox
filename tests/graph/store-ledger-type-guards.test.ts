

import { describe, expect, expectTypeOf, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptedArtifact } from "../../src/graph/domain/model.ts";
import { STOPPING_CONTROL_COMMANDS } from "../../src/graph/ledger/types.ts";
import { nodeBudgetLimitsOf, type NodeBudgetLimits } from "../../src/graph/domain/budget.ts";
import {
  reserveDispatchStatement,
  type BudgetSqlValue,
} from "../../src/graph/store/budget-tables.ts";
import {
  GraphStoreFormatError,
  GraphStoreWriteError,
} from "../../src/graph/store/errors.ts";
import { GraphStore } from "../../src/graph/store/graph-store.ts";
import {
  GRAPH_STORE_TABLES,
  STOPPING_CONTROL_COMMAND_SQL,
  graphStoreFilePath,
} from "../../src/graph/store/schema.ts";
import type { AcceptedResultRecord } from "../../src/graph/store/records.ts";

const NOW = 1_700_000_000_000;
const GRAPH = "guards.store";
const RUN = "run-1";
const NODE = "work";
const ATTEMPT = "work#1";
const ATTEMPT2 = "work#2";
const PLAN_REVISION = "plan-rev-1";
const REF = "evidence/report.txt";

/** The identity `artifactIdOf` produces: `sha256:` plus 64 lowercase hex. */
const ARTIFACT_ID = "sha256:" + "ab".repeat(32);
/** A content digest, exactly as `digestOf` renders it. */
const DIGEST = "cd".repeat(32);

const TABLE = GRAPH_STORE_TABLES.acceptedResults;

const ARTIFACT: AcceptedArtifact = Object.freeze({
  ref: REF,
  artifactId: ARTIFACT_ID,
  digest: DIGEST,
  size: 3,
});

/** One open store over an isolated temp tree, removed with its connection. */
function withStore(work: (store: GraphStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "store-ledger-type-guards-"));
  const store = GraphStore.openFile(dir);
  try {
    work(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Plant one accepted-results row whose `artifacts` column holds `text` verbatim.
 *
 * This is the case the format gate and `malformedRow` exist for — a hand-edited
 * or foreign row — and the only way to hand the reader a value this build's
 * writer would never produce.
 */
function seedArtifacts(store: GraphStore, text: string | null): void {
  store.run(`DELETE FROM ${TABLE}`);
  store.run(
    `INSERT INTO ${TABLE} (graph_id, attempt_id, plan_revision, payload, artifacts, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    GRAPH,
    ATTEMPT,
    PLAN_REVISION,
    '{"kind":"absent"}',
    text,
    NOW,
  );
}

/** The refusal a thunk produced, or `undefined` when it produced a value. */
function refusalOf(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** One artifacts element as JSON text, with the fields a case overrides. */
function element(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...ARTIFACT, ...overrides });
}

/**
 * Require `readAcceptedResult` to REFUSE a row whose artifacts column is `text`.
 *
 * The refusal is a VALUE with a problem code that names the store file, the
 * table, the offending element and the field — never a bare `TypeError` a caller
 * cannot classify, and never a fabricated artifact handed outward.
 */
function expectArtifactsRefusal(
  store: GraphStore,
  dir: string,
  text: string,
  fragment: string,
): void {
  seedArtifacts(store, text);
  const caught = refusalOf(() => store.readAcceptedResult(GRAPH, ATTEMPT));
  expect(caught).toBeInstanceOf(GraphStoreFormatError);
  expect(caught).not.toBeInstanceOf(TypeError);
  if (!(caught instanceof GraphStoreFormatError)) return;
  expect(caught.problem).toBe("malformed-row");
  expect(caught.path).toBe(graphStoreFilePath(dir));
  expect(caught.message).toContain(TABLE);
  expect(caught.message).toContain(fragment);
}

describe("the accepted-results artifacts column is read, not asserted (F-01)", () => {
  const malformed: readonly (readonly [string, string, string])[] = [
    ["a column that is not an array", `{"ref":${JSON.stringify(REF)}}`, "not an array"],
    ["a column that is a scalar", "7", "not an array"],
    ["a null element", "[null]", "artifacts[0]"],
    ["a numeric element", "[1]", "artifacts[0]"],
    ["an array element", "[[]]", "artifacts[0]"],
    ["an element missing every other field", `[{"ref":${JSON.stringify(REF)}}]`, "artifacts[0]"],
    ["an element with an unknown field", `[${element({ extra: true })}]`, "artifacts[0]"],
    [
      "an artifactId that is not a content identity",
      `[${element({ artifactId: "artifact-1" })}]`,
      "artifactId",
    ],
    ["a digest that is not 64 hex characters", `[${element({ digest: "abc" })}]`, "digest"],
    ["an uppercase digest", `[${element({ digest: DIGEST.toUpperCase() })}]`, "digest"],
    ["a negative size", `[${element({ size: -1 })}]`, "size"],
    ["a fractional size", `[${element({ size: 1.5 })}]`, "size"],
    ["a size that is not a number", `[${element({ size: "3" })}]`, "size"],
    ["an empty ref", `[${element({ ref: "" })}]`, "ref"],
    ["a ref that is not a string", `[${element({ ref: 7 })}]`, "ref"],
  ];

  for (const [label, text, fragment] of malformed) {
    it(`refuses ${label}`, () => {
      withStore((store, dir) => {
        expectArtifactsRefusal(store, dir, text, fragment);
      });
    });
  }

  it("refuses through readAcceptedArtifact too, where the assertion used to throw a bare TypeError", () => {
    withStore((store) => {
      seedArtifacts(store, "[null]");
      const caught = refusalOf(() => store.readAcceptedArtifact(GRAPH, ATTEMPT, REF));
      expect(caught).toBeInstanceOf(GraphStoreFormatError);
      expect(caught).not.toBeInstanceOf(TypeError);
    });
  });

  it("reads a well-formed column back exactly as written", () => {
    withStore((store) => {
      store.writeAcceptedResult({
        graphId: GRAPH,
        attemptId: ATTEMPT,
        planRevision: PLAN_REVISION,
        payload: Object.freeze({ kind: "absent" as const }),
        artifacts: Object.freeze([ARTIFACT]),
        acceptedAt: NOW,
      });
      const record = store.readAcceptedResult(GRAPH, ATTEMPT);
      expect(record?.artifacts).toEqual([
        { ref: REF, artifactId: ARTIFACT_ID, digest: DIGEST, size: 3 },
      ]);
      // A well-formed reference meets the immutable store: with no object
      // deposited it is a PROBLEM value, not a thrown TypeError.
      const read = store.readAcceptedArtifact(GRAPH, ATTEMPT, REF);
      expect(read.kind).toBe("problem");
    });
  });

  it("keeps 'retained nothing' distinct from an empty list", () => {
    withStore((store) => {
      store.writeAcceptedResult({
        graphId: GRAPH,
        attemptId: ATTEMPT,
        planRevision: PLAN_REVISION,
        payload: Object.freeze({ kind: "absent" as const }),
        acceptedAt: NOW,
      });
      expect(store.readAcceptedResult(GRAPH, ATTEMPT)?.artifacts).toBeUndefined();

      store.writeAcceptedResult({
        graphId: GRAPH,
        attemptId: ATTEMPT2,
        planRevision: PLAN_REVISION,
        payload: Object.freeze({ kind: "absent" as const }),
        artifacts: Object.freeze([]),
        acceptedAt: NOW,
      });
      expect(store.readAcceptedResult(GRAPH, ATTEMPT2)?.artifacts).toEqual([]);
    });
  });

  it("refuses an unrepresentable element at the WRITE boundary and commits nothing", () => {
    withStore((store) => {
      const caught = refusalOf(() =>
        store.writeAcceptedResult({
          graphId: GRAPH,
          attemptId: ATTEMPT,
          planRevision: PLAN_REVISION,
          payload: Object.freeze({ kind: "absent" as const }),
          artifacts: Object.freeze([
            Object.freeze({
              ref: REF,
              artifactId: "artifact-1",
              digest: DIGEST,
              size: 3,
            }),
          ]),
          acceptedAt: NOW,
        })
      );
      expect(caught).toBeInstanceOf(GraphStoreWriteError);
      if (!(caught instanceof GraphStoreWriteError)) return;
      expect(caught.problem).toBe("invalid-record");
      expect(caught.message).toContain("artifacts[0]");
      // THE ROW IS NOT THERE: the write was refused before the encoder ran.
      expect(store.readAcceptedResult(GRAPH, ATTEMPT)).toBeUndefined();
    });
  });

  it("pins the record's artifacts field to the domain shape the reader returns", () => {
    expectTypeOf<AcceptedResultRecord["artifacts"]>().toEqualTypeOf<
      readonly AcceptedArtifact[] | undefined
    >();
  });
});

/** The four ceilings a fixture may declare, in the reading's own field names. */
type LimitFields = Pick<
  NodeBudgetLimits,
  "durationMs" | "inputTokens" | "outputTokens" | "costUsd"
>;

/**
 * Fixture ceilings go through the reader production uses: the brand on
 * `NodeBudgetLimits` (F-24) is written only by `nodeBudgetLimitsOf`, so a test
 * literal is not a substitute for reading a declared spec.
 */
function limitsOf(fields: LimitFields): NodeBudgetLimits {
  const reading = nodeBudgetLimitsOf({
    ...(fields.durationMs === undefined ? {} : { timeout_ms: fields.durationMs }),
    ...(fields.inputTokens === undefined ? {} : { max_input_tokens: fields.inputTokens }),
    ...(fields.outputTokens === undefined ? {} : { max_output_tokens: fields.outputTokens }),
    ...(fields.costUsd === undefined ? {} : { max_cost_usd: fields.costUsd }),
  });
  if (reading.kind !== "ok") throw new Error(reading.refusal.message);
  return reading.limits;
}

describe("the reservation statement and its bindings are one value (F-19)", () => {
  /** The builder's input for one fully-specified claim. */
  function statementInput(): Parameters<typeof reserveDispatchStatement>[0] {
    return {
      table: GRAPH_STORE_TABLES.budgetReservations,
      graphId: GRAPH,
      runId: RUN,
      nodeId: NODE,
      attemptId: ATTEMPT,
      effectId: "dispatch:" + ATTEMPT,
      at: NOW,
      limits: limitsOf({
        durationMs: 1000,
        inputTokens: 2000,
        outputTokens: 3000,
        costUsd: 0.25,
      }),
      maxExecutions: 4,
    };
  }

  it("emits one placeholder per binding and derives both column lists from the catalog", () => {
    const statement = reserveDispatchStatement(statementInput());
    // THE PAIRING the builder asserts before `db.run`: one bound value per
    // placeholder, so a catalog change cannot shift every later value.
    expect(statement.sql.split("?").length - 1).toBe(statement.params.length);
    // Pinned so a change to either side alone fails here rather than in SQL.
    expect(statement.params.length).toBe(83);
    // The checked columns and the reserved columns come from the SAME catalog
    // iteration, in its order — not from a literal beside it.
    expect(statement.sql).toContain(
      "checked_duration_ms, checked_input_tokens, checked_output_tokens, checked_cost_usd",
    );
    expect(statement.sql).toContain(
      "reserved_duration_ms, reserved_input_tokens, reserved_output_tokens, reserved_cost_usd",
    );
  });

  it("pins the builder's paired return type", () => {
    expectTypeOf<ReturnType<typeof reserveDispatchStatement>>().toEqualTypeOf<{
      readonly sql: string;
      readonly params: readonly BudgetSqlValue[];
    }>();
  });

  it("round-trips a reservation through the derived statement", () => {
    withStore((store) => {
      store.transaction((tx) => {
        tx.runs?.mintRun({
          graphId: GRAPH,
          runId: RUN,
          startedAt: NOW,
          planRevision: PLAN_REVISION,
        });
      });
      const result = store.transaction((tx) => {
        const budget = tx.budget;
        if (budget === undefined) {
          throw new Error("fixture: the shipped store exposes no budget surface");
        }
        return budget.reserveDispatch({
          graphId: GRAPH,
          runId: RUN,
          nodeId: NODE,
          attemptId: ATTEMPT,
          effectId: "dispatch:" + ATTEMPT,
          limits: limitsOf({ inputTokens: 1000 }),
          at: NOW + 1,
        });
      });
      expect(result.kind).toBe("reserved");
      if (result.kind !== "reserved") return;
      expect(result.reservation.checked.inputTokens).toBe(1000);
      expect(result.reservation.reserved.inputTokens).toBe(1000);
      expect(result.reservation.reserved.executions).toBe(1);
      // The claim is readable afterwards: the derived statement wrote the
      // values into the columns it names.
      expect(
        store.budget.reservationsOf(GRAPH, RUN).map((row) => row.attemptId),
      ).toEqual([ATTEMPT]);
    });
  });

  it("reads every declared ceiling back into its own dimension", () => {
    withStore((store) => {
      store.transaction((tx) => {
        tx.runs?.mintRun({
          graphId: GRAPH,
          runId: RUN,
          startedAt: NOW,
          planRevision: PLAN_REVISION,
        });
      });
      const result = store.transaction((tx) => {
        const budget = tx.budget;
        if (budget === undefined) {
          throw new Error("fixture: the shipped store exposes no budget surface");
        }
        return budget.reserveDispatch({
          graphId: GRAPH,
          runId: RUN,
          nodeId: NODE,
          attemptId: ATTEMPT,
          effectId: "dispatch:" + ATTEMPT,
          limits: limitsOf({
            durationMs: 11,
            inputTokens: 22,
            outputTokens: 33,
            costUsd: 0.44,
          }),
          at: NOW + 1,
        });
      });
      expect(result.kind).toBe("reserved");
      if (result.kind !== "reserved") return;
      // Each ceiling lands in its OWN field: the checked columns are read back
      // through the dimension-to-field table, so a mis-mapping fails here
      // rather than silently reporting one dimension's ceiling as another's.
      expect(result.reservation.checked).toEqual(
        limitsOf({ durationMs: 11, inputTokens: 22, outputTokens: 33, costUsd: 0.44 }),
      );
      expect(result.reservation.reserved).toEqual({
        executions: 1,
        durationMs: 11,
        inputTokens: 22,
        outputTokens: 33,
        costUsd: 0.44,
      });
    });
  });
});

describe("the stopping-command SQL list is derived from the one TypeScript owner (F-02)", () => {
  it("spells exactly the classified commands, in the classification's order", () => {
    const sqlCommands = STOPPING_CONTROL_COMMAND_SQL.split(",")
      .map((part) => part.trim())
      .map((part) => part.slice(1, -1));
    expect(sqlCommands).toEqual([...STOPPING_CONTROL_COMMANDS]);
  });
});
