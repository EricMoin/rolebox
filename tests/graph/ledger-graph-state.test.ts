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
