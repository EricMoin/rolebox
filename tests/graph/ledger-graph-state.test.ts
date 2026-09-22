/**
 * Durable acceptance ledger — graph-state seam (C3b).
 *
 * Covers the state half of the protocol's single atomic boundary: the state
 * record round-trips on the port and inside a caller's transaction, a malformed
 * record is refused without touching the store, and a state body that cannot be
 * stored (unrepresentable, oversized) fails the WHOLE transaction — the receipt,
 * the accepted event and every pending effect that the same transaction wrote
 * are gone with it. The format gate is re-verified for the new table, including
 * an intact-looking store that is simply missing it.
 *
 * The second half covers the STATE-BODY VERSION gate: a same-version body
 * round-trips through the store with zero field loss, while an unknown body
 * field, an unknown node field, a body version this build has no reader for and
 * a missing version discriminator are each REFUSED — never read partially and
 * never rewritten with the unknown fields dropped.
 *
 * Every case runs in its own mkdtemp directory and removes it in a finally
 * block; nothing here writes outside a temp dir.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabase,
  type DatabaseDriver,
} from "../../src/memory/db-driver.ts";
import {
  GRAPH_STATE_MAX_BYTES,
  type AcceptanceBatch,
  type AcceptedEventRecord,
  type GraphStateRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
} from "../../src/graph/ledger/types.ts";
import {
  LEDGER_TABLES,
  LedgerFormatError,
  LedgerWriteError,
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";
import { buildDeclaredOutcomeGraph } from "../../src/graph/tools/declare-graph.ts";
import type { GraphDeclarationV3 } from "../../src/graph/compiler/declaration-v3.ts";
import {
  CURRENT_OUTCOME_STATE_BODY,
  DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
  OutcomeStateError,
  classifyOutcomeStateBody,
  createOutcomeStateBodyRegistry,
  readOutcomeGraphState,
  stateRecordOf,
  type OutcomeGraphState,
  type OutcomeStateBodyReading,
} from "../../src/graph/outcome/graph-state.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph-state-1";
const PLAN_REVISION = "plan-revision-a";
const NOW = 1_700_000_000_000;

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    graphId: GRAPH,
    attemptId: "attempt-1",
    submissionId: "submission-1",
    planRevision: PLAN_REVISION,
    proposalDigest: "digest-a",
    decision: "accepted",
    committedAt: NOW,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<AcceptedEventRecord> = {},
): AcceptedEventRecord {
  return {
    graphId: GRAPH,
    attemptId: "attempt-1",
    submissionId: "submission-1",
    planRevision: PLAN_REVISION,
    outcomeId: "done",
    acceptedAt: NOW,
    ...overrides,
  };
}

function makeEffect(
  overrides: Partial<PendingEffectRecord> = {},
): PendingEffectRecord {
  return {
    graphId: GRAPH,
    effectId: "effect-1",
    attemptId: "attempt-1",
    kind: "dispatch",
    payload: { node: "a" },
    createdAt: NOW,
    status: "pending",
    ...overrides,
  };
}

function makeBatch(): AcceptanceBatch {
  return {
    receipt: makeReceipt(),
    acceptedEvent: makeEvent(),
    effects: [makeEffect()],
  };
}

/** The submission key a batch is committed under. */
function batchKey(batch: AcceptanceBatch) {
  return {
    graphId: batch.receipt.graphId,
    attemptId: batch.receipt.attemptId,
    submissionId: batch.receipt.submissionId,
  };
}

async function withTempDir(
  run: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graph-ledger-state-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withLedger(
  run: (ledger: SqliteAcceptanceLedger, dir: string) => Promise<void> | void,
): Promise<void> {
  await withTempDir(async (dir) => {
    const ledger = await SqliteAcceptanceLedger.create(dir);
    try {
      await run(ledger, dir);
    } finally {
      ledger.close();
    }
  });
}

/** Open the ledger file directly (a second connection) and run one callback. */
async function withRawStore<T>(
  dir: string,
  run: (db: DatabaseDriver) => T,
): Promise<T> {
  const db = await createDatabase(ledgerFilePath(dir));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function countRows(db: DatabaseDriver, table: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM " + table).get();
  if (typeof row === "object" && row !== null && "n" in row) {
    const value = row.n;
    if (typeof value === "number") return value;
  }
  throw new Error("count query did not answer a number: " + table);
}

function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function rejectedError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ── The state seam ──────────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — graph state", () => {
  it("round-trips a state snapshot on the port", async () => {
    await withLedger(async (ledger) => {
      expect(ledger.readGraphState(GRAPH)).toBeUndefined();

      const body = {
        phase: "executing",
        nodes: [{ nodeId: "work", status: "dispatched", attemptId: "work#1" }],
        loopTraversals: { "revise-loop": 2 },
        nested: { list: [1, null, "x", { deep: true }] },
      };
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body,
        updatedAt: NOW,
      });

      expect(ledger.readGraphState(GRAPH)).toEqual({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body,
        updatedAt: NOW,
      });
      // One row per graph: a second write REPLACES the snapshot.
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: "plan-revision-b",
        body: { phase: "complete" },
        updatedAt: NOW + 5,
      });
      expect(ledger.readGraphState(GRAPH)).toEqual({
        graphId: GRAPH,
        planRevision: "plan-revision-b",
        body: { phase: "complete" },
        updatedAt: NOW + 5,
      });
      // Another graph is untouched.
      expect(ledger.readGraphState("other-graph")).toBeUndefined();
    });
  });

  it("reads and writes the state inside a caller's transaction", async () => {
    await withLedger(async (ledger) => {
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { phase: "ready" },
        updatedAt: NOW,
      });

      const seen = ledger.runInTransaction((tx) => {
        expect(tx.readGraphState(GRAPH)?.body).toEqual({ phase: "ready" });
        tx.writeGraphState({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { phase: "executing" },
          updatedAt: NOW + 1,
        });
        // The transaction sees its OWN uncommitted write.
        expect(tx.readGraphState(GRAPH)?.body).toEqual({ phase: "executing" });
        return "joined";
      });
      expect(seen).toBe("joined");
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ phase: "executing" });
    });
  });

  it("persists the state across a close and reopen", async () => {
    await withTempDir(async (dir) => {
      const first = await SqliteAcceptanceLedger.create(dir);
      first.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { phase: "executing", attemptSeq: 3 },
        updatedAt: NOW,
      });
      first.close();

      const second = await SqliteAcceptanceLedger.create(dir);
      try {
        expect(second.readGraphState(GRAPH)).toEqual({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { phase: "executing", attemptSeq: 3 },
          updatedAt: NOW,
        });
      } finally {
        second.close();
      }
    });
  });

  it("refuses a state record that violates the record model", async () => {
    await withLedger(async (ledger, dir) => {
      const malformed = [
        {
          graphId: "",
          planRevision: PLAN_REVISION,
          body: {},
          updatedAt: NOW,
        },
        { graphId: GRAPH, planRevision: "", body: {}, updatedAt: NOW },
        { graphId: GRAPH, planRevision: PLAN_REVISION, body: {}, updatedAt: 1.5 },
      ];
      for (const record of malformed) {
        const error = thrownError(() => ledger.writeGraphState(record));
        expect(error).toBeInstanceOf(LedgerWriteError);
        if (error instanceof LedgerWriteError) {
          expect(error.problem).toBe("invalid-graph-state");
        }
      }
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.graphState)).toBe(0);
      });
    });
  });
});

// ── The atomic boundary ─────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — the state commits with the acceptance", () => {
  /**
   * The proof the protocol needs: a state write that cannot be stored, issued
   * AFTER the acceptance batch already wrote its receipt, event and effect
   * inside the caller's transaction, must leave NOTHING behind. The batch is
   * deliberately written first so the failure lands after rows exist — the
   * window a non-atomic design would leave half-committed.
   */
  async function expectWholeTransactionRolledBack(body: unknown, problem: string) {
    await withLedger(async (ledger, dir) => {
      const batch = makeBatch();
      const error = thrownError(() =>
        ledger.runInTransaction((tx) => {
          const verdict = tx.commitAccepted(batch);
          expect(verdict.kind).toBe("committed");
          // The transaction can see the batch it just wrote...
          expect(tx.lookupReceipt(batchKey(batch))).toBeDefined();
          tx.writeGraphState({
            graphId: GRAPH,
            planRevision: PLAN_REVISION,
            body,
            updatedAt: NOW,
          });
        }),
      );
      expect(error).toBeInstanceOf(LedgerWriteError);
      if (error instanceof LedgerWriteError) {
        expect(error.problem).toBe(problem);
      }

      // ...and the rollback took the receipt, the event, the effect and the
      // state with it. There is no half-committed batch.
      expect(ledger.lookupReceipt(batchKey(batch))).toBeUndefined();
      expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
      expect(ledger.pendingEffects(GRAPH)).toEqual([]);
      expect(ledger.readGraphState(GRAPH)).toBeUndefined();
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.graphState)).toBe(0);
      });

      // The store is still usable after the contained failure.
      expect(ledger.commitAccepted(batch).kind).toBe("committed");
    });
  }

  it("fails the whole transaction for an unrepresentable state body", async () => {
    await expectWholeTransactionRolledBack(
      { bad: BigInt(1) },
      "unrepresentable-state",
    );
  });

  it("fails the whole transaction for an oversized state body", async () => {
    await expectWholeTransactionRolledBack(
      { pad: "x".repeat(GRAPH_STATE_MAX_BYTES + 1) },
      "oversized-state",
    );
  });

  it("keeps a body at the size limit and refuses the first byte beyond it", async () => {
    await withLedger(async (ledger) => {
      // The limit is measured on the ENCODED JSON text, so a string payload of
      // exactly the limit is already over it once quoted. Measure the encoded
      // size through the store's own round-trip: write a small body, then the
      // largest one that still fits.
      const padding = "y".repeat(1024);
      ledger.writeGraphState({
        graphId: GRAPH,
        planRevision: PLAN_REVISION,
        body: { pad: padding },
        updatedAt: NOW,
      });
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ pad: padding });

      const error = thrownError(() =>
        ledger.writeGraphState({
          graphId: GRAPH,
          planRevision: PLAN_REVISION,
          body: { pad: "z".repeat(GRAPH_STATE_MAX_BYTES) },
          updatedAt: NOW + 1,
        }),
      );
      expect(error).toBeInstanceOf(LedgerWriteError);
      // The refused write did not disturb the stored snapshot.
      expect(ledger.readGraphState(GRAPH)?.body).toEqual({ pad: padding });
    });
  });
});

// ── The format gate, extended to the new table ──────────────────────────────

describe("SqliteAcceptanceLedger — graph-state table format gate", () => {
  it("refuses a store missing ledger_graph_state, and leaves it untouched", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        db.exec("DROP TABLE " + LEDGER_TABLES.graphState);
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("incomplete-store");
        expect(error.path).toBe(ledgerFilePath(dir));
      }
      // Never recreated: the table is still absent after the refusal.
      await withRawStore(dir, (db) => {
        const names: string[] = [];
        for (const row of db
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()) {
          if (typeof row === "object" && row !== null && "name" in row) {
            if (typeof row.name === "string") names.push(row.name);
          }
        }
        expect(names).not.toContain(LEDGER_TABLES.graphState);
      });
    });
  });

  it("refuses a reshaped graph-state table instead of failing with a raw driver error", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        // Same columns, but the body is declared INTEGER: a layout this format
        // does not write, even though every name is present.
        db.exec("ALTER TABLE " + LEDGER_TABLES.graphState + " RENAME TO gs_old");
        db.exec(
          "CREATE TABLE " +
            LEDGER_TABLES.graphState +
            " (graph_id TEXT NOT NULL, plan_revision TEXT NOT NULL, body INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (graph_id))",
        );
        db.exec("DROP TABLE gs_old");
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("incomplete-store");
      }
    });
  });

  it("keeps the version discipline: a newer format is refused before any table is read", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = format_version + 1 WHERE id = 1",
        );
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("newer-format");
      }
    });
  });
});

// ── The state body is read as a versioned capability ────────────────────────

/** work -> ship, so a state body carries one dispatched and one pending node. */
const STATE_BODY_DECLARATION: GraphDeclarationV3 = {
  version: 3,
  name: "graph.state-body",
  nodes: [
    { id: "work", agent: "agent.work", prompt: "Do the work.", outcomes: [{ id: "done" }] },
    { id: "ship", agent: "agent.ship", prompt: "Ship it.", outcomes: [{ id: "delivered" }] },
  ],
  edges: [{ from: "work", to: "ship", outcome: "done" }],
};

const STATE_BODY_PLAN = buildDeclaredOutcomeGraph({
  declaration: STATE_BODY_DECLARATION,
}).plan;

/** The state the version-1 writer produces, in plan order. */
function stateBodyFixture(): OutcomeGraphState {
  const nodes = STATE_BODY_PLAN.nodes.map((node, index) =>
    index === 0
      ? Object.freeze({
          nodeId: node.id,
          status: "dispatched" as const,
          attemptId: node.id + "#1",
          attemptSeq: 1,
          dispatchedAt: NOW,
        })
      : Object.freeze({ nodeId: node.id, status: "pending" as const }),
  );
  return Object.freeze({
    bodyVersion: CURRENT_OUTCOME_STATE_BODY,
    graphId: STATE_BODY_PLAN.graphId,
    planRevision: STATE_BODY_PLAN.planRevision,
    phase: "executing" as const,
    nodes: Object.freeze(nodes),
    loopTraversals: Object.freeze({}),
    attemptSeq: 1,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body the version-1 writer persists for one state. */
function bodyOf(state: OutcomeGraphState): Record<string, unknown> {
  const body = stateRecordOf(state, NOW).body;
  if (!isRecord(body)) throw new Error("fixture: the state record body is not a record");
  return body;
}

/** The record an outside writer would store for this body. */
function recordOf(body: unknown): GraphStateRecord {
  return {
    graphId: STATE_BODY_PLAN.graphId,
    planRevision: STATE_BODY_PLAN.planRevision,
    body,
    updatedAt: NOW,
  };
}

/** Every leaf of a JSON value as a "path=value" line, sorted: field by field. */
function fieldLines(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => fieldLines(entry, path + "[" + index + "]"));
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => fieldLines(value[key], path + "." + key));
  }
  return [path + "=" + JSON.stringify(value)];
}

/** Run a reader and return the refusal it must raise. */
function refusalOf(run: () => unknown): OutcomeStateError {
  try {
    run();
  } catch (error) {
    if (error instanceof OutcomeStateError) return error;
    throw error;
  }
  throw new Error("the state reader accepted a body it must refuse");
}

describe("outcome state body — versioned capability, no silent trimming", () => {
  it("round-trips a same-version body through the store with zero field loss", async () => {
    await withLedger(async (ledger) => {
      const state = stateBodyFixture();
      ledger.writeGraphState(stateRecordOf(state, NOW));

      const stored = ledger.readGraphState(STATE_BODY_PLAN.graphId);
      if (stored === undefined) throw new Error("fixture: the state row is missing");
      const reread = readOutcomeGraphState(stored, STATE_BODY_PLAN);
      expect(reread).toEqual(state);
      expect(reread.bodyVersion).toBe(CURRENT_OUTCOME_STATE_BODY);

      // write -> read -> write: every field survives, field by field.
      expect(fieldLines(stateRecordOf(reread, NOW + 1).body)).toEqual(
        fieldLines(stored.body),
      );
      // ...and a second trip is stable as well.
      const again = readOutcomeGraphState(
        stateRecordOf(reread, NOW + 2),
        STATE_BODY_PLAN,
      );
      expect(fieldLines(stateRecordOf(again, NOW + 3).body)).toEqual(
        fieldLines(stored.body),
      );
    });
  });

  it("refuses an unknown top-level body field instead of dropping it", () => {
    const body = {
      ...bodyOf(stateBodyFixture()),
      progressBaselines: { work: { digest: "abc", round: 2 } },
    };
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("progressBaselines");
  });

  it("refuses an unknown node-level field instead of dropping it", () => {
    const body = bodyOf(stateBodyFixture());
    const nodes = body.nodes;
    if (!Array.isArray(nodes) || !isRecord(nodes[0])) {
      throw new Error("fixture: the state body carries no first node");
    }
    const extended = {
      ...body,
      nodes: [{ ...nodes[0], baselineDigest: "abc" }, ...nodes.slice(1)],
    };
    const error = refusalOf(() =>
      readOutcomeGraphState(recordOf(extended), STATE_BODY_PLAN),
    );
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("baselineDigest");
  });

  it("refuses a body version this build has no reader for", () => {
    const future = CURRENT_OUTCOME_STATE_BODY + 1;
    const body = { ...bodyOf(stateBodyFixture()), bodyVersion: future };
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("unsupported-state-version");
    expect(error.message).toContain(String(future));
    expect(error.message).toContain("no reader");
  });

  it("refuses a body with no version discriminator as malformed, not as a newer format", () => {
    const { bodyVersion: _version, ...body } = bodyOf(stateBodyFixture());
    const error = refusalOf(() => readOutcomeGraphState(recordOf(body), STATE_BODY_PLAN));
    expect(error.problem).toBe("malformed-state");
    expect(error.message).toContain("bodyVersion");
  });

  it("keeps the existing identity refusals: another graph or revision stays a plan mismatch", () => {
    const body = bodyOf(stateBodyFixture());
    const otherRevision = refusalOf(() =>
      readOutcomeGraphState(
        { ...recordOf(body), planRevision: "another-revision" },
        STATE_BODY_PLAN,
      ),
    );
    expect(otherRevision.problem).toBe("state-plan-mismatch");
    const otherGraph = refusalOf(() =>
      readOutcomeGraphState({ ...recordOf(body), graphId: "another-graph" }, STATE_BODY_PLAN),
    );
    expect(otherGraph.problem).toBe("state-plan-mismatch");

    // A body whose OWN identity fields disagree with the record is malformed:
    // the reader never silently corrects a field to the record's value.
    const bodyGraph = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({ ...body, graphId: "another-graph" }),
        STATE_BODY_PLAN,
      ),
    );
    expect(bodyGraph.problem).toBe("malformed-state");
    expect(bodyGraph.message).toContain("another-graph");
    const bodyRevision = refusalOf(() =>
      readOutcomeGraphState(
        recordOf({ ...body, planRevision: "another-revision" }),
        STATE_BODY_PLAN,
      ),
    );
    expect(bodyRevision.problem).toBe("malformed-state");
    expect(bodyRevision.message).toContain("another-revision");
  });

  it("classifies a version as supported, unsupported or invalid", () => {
    const supported = classifyOutcomeStateBody(
      CURRENT_OUTCOME_STATE_BODY,
      DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
    );
    expect(supported.kind).toBe("supported");
    if (supported.kind === "supported") {
      expect(supported.reader.format).toBe(CURRENT_OUTCOME_STATE_BODY);
    }
    expect(
      classifyOutcomeStateBody(
        CURRENT_OUTCOME_STATE_BODY + 1,
        DEFAULT_OUTCOME_STATE_BODY_REGISTRY,
      ),
    ).toEqual({ kind: "unsupported", version: CURRENT_OUTCOME_STATE_BODY + 1 });
    for (const illegal of [
      undefined,
      null,
      "1",
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        classifyOutcomeStateBody(illegal, DEFAULT_OUTCOME_STATE_BODY_REGISTRY).kind,
      ).toBe("invalid");
    }
  });

  it("rejects a duplicate reader and a current version with no reader", () => {
    const stub = (format: number) => ({
      format,
      read: (): OutcomeStateBodyReading => ({
        kind: "invalid" as const,
        error: new OutcomeStateError("malformed-state", "stub reader " + format),
      }),
    });
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(1), stub(1)] }),
    ).toThrow(/duplicate reader/);
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(2)] }),
    ).toThrow(/no registered reader/);
    expect(() =>
      createOutcomeStateBodyRegistry({ current: 1, formats: [stub(0)] }),
    ).toThrow(/not a legal state-body version/);
  });

  it("reads through the registered capability, not through the number", () => {
    const stubReader = {
      format: 2,
      read(body: Record<string, unknown>): OutcomeStateBodyReading {
        return {
          kind: "invalid",
          error: new OutcomeStateError(
            "malformed-state",
            "stub reader reached for version " + String(body.bodyVersion),
          ),
        };
      },
    };
    const registry = createOutcomeStateBodyRegistry({
      current: 2,
      formats: [stubReader],
    });
    const error = refusalOf(() =>
      readOutcomeGraphState(recordOf({ bodyVersion: 2 }), STATE_BODY_PLAN, registry),
    );
    expect(error.message).toBe("stub reader reached for version 2");
  });
});

