/**
 * Durable acceptance ledger — SQLite substrate contract.
 *
 * Covers the C2 slice end to end against the portable in-tree driver:
 * idempotent commit (committed / replayed / conflict / settled), the
 * single-accepted-event rule, the effect lifecycle and restart resume, the
 * format gate (unknown, newer, older, incomplete and foreign stores refused —
 * none of them recreated), durability across close + reopen, batch atomicity
 * under a forced mid-batch failure and a hostile payload, and the
 * runInTransaction extension point.
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
  LEDGER_FORMAT_VERSION,
  type AcceptanceBatch,
  type AcceptedEventRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
  type SubmissionKey,
} from "../../src/graph/ledger/types.ts";
import {
  LEDGER_STORE_TABLES,
  LEDGER_TABLES,
  LedgerClosedError,
  LedgerFormatError,
  LedgerWriteError,
  SqliteAcceptanceLedger,
  ledgerFilePath,
} from "../../src/graph/ledger/sqlite-ledger.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GRAPH = "graph-1";

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    graphId: GRAPH,
    attemptId: "attempt-1",
    submissionId: "submission-1",
    planRevision: "plan-r1",
    proposalDigest: "digest-a",
    decision: "accepted",
    committedAt: 1_700_000_000_000,
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
    planRevision: "plan-r1",
    outcomeId: "done",
    acceptedAt: 1_700_000_000_001,
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
    createdAt: 1_700_000_000_002,
    status: "pending",
    ...overrides,
  };
}

interface BatchOptions {
  readonly event?: AcceptedEventRecord;
  readonly effects?: readonly PendingEffectRecord[];
  /** Omit the accepted event even for an accepted decision (a malformed batch). */
  readonly omitEvent?: boolean;
}

function makeBatch(
  receiptOverrides: Partial<ReceiptRecord> = {},
  options: BatchOptions = {},
): AcceptanceBatch {
  const receipt = makeReceipt(receiptOverrides);
  const event =
    options.omitEvent !== true && receipt.decision === "accepted"
      ? options.event ??
        makeEvent({
          graphId: receipt.graphId,
          attemptId: receipt.attemptId,
          submissionId: receipt.submissionId,
          planRevision: receipt.planRevision,
        })
      : options.event;
  return {
    receipt,
    ...(event === undefined ? {} : { acceptedEvent: event }),
    ...(options.effects === undefined ? {} : { effects: options.effects }),
  };
}

function keyOf(
  record: Pick<ReceiptRecord, "graphId" | "attemptId" | "submissionId">,
): SubmissionKey {
  return {
    graphId: record.graphId,
    attemptId: record.attemptId,
    submissionId: record.submissionId,
  };
}

// ── Temp directories, raw access and error capture ──────────────────────────

async function withTempDir(
  run: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graph-ledger-"));
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

function countRows(
  db: DatabaseDriver,
  table: string,
  where = "1 = 1",
  ...params: unknown[]
): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM " + table + " WHERE " + where)
    .get(...params);
  if (typeof row === "object" && row !== null && "n" in row) {
    const value = row.n;
    if (typeof value === "number") return value;
  }
  throw new Error("count query did not answer a number: " + table);
}

function tableNames(db: DatabaseDriver): string[] {
  const names: string[] = [];
  for (const row of db
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()) {
    if (typeof row === "object" && row !== null && "name" in row) {
      const name = row.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names.sort();
}

/** The column names one table declares, sorted. */
function columnNames(db: DatabaseDriver, table: string): string[] {
  const names: string[] = [];
  for (const row of db.query("PRAGMA table_info(" + table + ")").all()) {
    if (typeof row !== "object" || row === null) continue;
    if ("name" in row) {
      const name = row.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names.sort();
}

/** The declared type of one column, or undefined when the table has no such column. */
function columnType(
  db: DatabaseDriver,
  table: string,
  column: string,
): string | undefined {
  for (const row of db.query("PRAGMA table_info(" + table + ")").all()) {
    if (typeof row !== "object" || row === null) continue;
    if ("name" in row && row.name === column && "type" in row) {
      return typeof row.type === "string" ? row.type : undefined;
    }
  }
  return undefined;
}

/** The PRIMARY KEY columns of one table, in key order. */
function primaryKeyColumns(db: DatabaseDriver, table: string): string[] {
  const keys: Array<{ readonly name: string; readonly position: number }> = [];
  for (const row of db.query("PRAGMA table_info(" + table + ")").all()) {
    if (typeof row !== "object" || row === null) continue;
    if (!("name" in row) || !("pk" in row)) continue;
    const name = row.name;
    const position = row.pk;
    if (typeof name === "string" && typeof position === "number" && position > 0) {
      keys.push({ name, position });
    }
  }
  return keys
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.name);
}

/**
 * Replace one ledger table with explicit DDL, carrying its rows across — how a
 * store written by a different layout looks to this build.
 */
function reshapeTable(
  db: DatabaseDriver,
  table: string,
  ddl: string,
  columns: readonly string[],
): void {
  const previous = table + "_reshaped";
  db.exec("ALTER TABLE " + table + " RENAME TO " + previous);
  db.exec(ddl);
  const list = columns.join(", ");
  db.exec(
    "INSERT INTO " + table + " (" + list + ") SELECT " + list + " FROM " + previous,
  );
  db.exec("DROP TABLE " + previous);
}

/** The error a synchronous call throws, or undefined when it does not throw. */
function thrownError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The error an async call rejects with, or undefined when it does not. */
async function rejectedError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Every table one intact store file holds, sorted.
 *
 * The ledger's file IS the workspace's converged graph store (P1 item 3), so
 * the intact set is the store's whole table list — the assertion the refusal
 * cases make is that a refused open leaves the file's table set EXACTLY as it
 * was found, whatever that set contains.
 */
function ledgerSchema(): string[] {
  return Object.values(LEDGER_STORE_TABLES).sort();
}

// ── Commit outcomes ─────────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — commit outcomes", () => {
  it("commits a first submission and persists its receipt, event and effects", async () => {
    await withLedger(async (ledger, dir) => {
      const effect = makeEffect();
      const result = ledger.commitAccepted(
        makeBatch({}, { effects: [effect] }),
      );
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") return;
      expect(result.receipt).toEqual(makeReceipt());
      expect(ledger.lookupReceipt(keyOf(makeReceipt()))).toEqual(makeReceipt());
      expect(ledger.acceptedEvents(GRAPH)).toEqual([makeEvent()]);
      expect(ledger.pendingEffects(GRAPH)).toEqual([effect]);
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(1);
      });
    });
  });

  it("replays an identical submission with the persisted receipt and writes no second row", async () => {
    await withLedger(async (ledger, dir) => {
      const batch = makeBatch({}, { effects: [makeEffect()] });
      expect(ledger.commitAccepted(batch).kind).toBe("committed");

      const repeated = ledger.commitAccepted(batch);
      expect(repeated.kind).toBe("replayed");
      if (repeated.kind !== "replayed") return;
      expect(repeated.receipt).toEqual(makeReceipt());

      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(1);
      });
    });
  });

  it("refuses a different digest for the same key as a conflict that writes nothing", async () => {
    await withLedger(async (ledger, dir) => {
      expect(
        ledger.commitAccepted(makeBatch({ proposalDigest: "digest-a" })).kind,
      ).toBe("committed");

      const conflict = ledger.commitAccepted(
        makeBatch({ proposalDigest: "digest-b" }),
      );
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind === "conflict") {
        expect(conflict.reason).toContain("digest-a");
        expect(conflict.reason).toContain("digest-b");
      }
      expect(ledger.lookupReceipt(keyOf(makeReceipt()))).toEqual(
        makeReceipt({ proposalDigest: "digest-a" }),
      );
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(1);
      });
    });
  });

  it("refuses a distinct terminal submission after settlement and keeps the accepted event", async () => {
    await withLedger(async (ledger) => {
      expect(
        ledger.commitAccepted(
          makeBatch(
            { submissionId: "submission-1" },
            {
              event: makeEvent({
                submissionId: "submission-1",
                outcomeId: "done",
              }),
            },
          ),
        ).kind,
      ).toBe("committed");

      const settled = ledger.commitAccepted(
        makeBatch(
          { submissionId: "submission-2", proposalDigest: "digest-b" },
          {
            event: makeEvent({
              submissionId: "submission-2",
              outcomeId: "failed",
            }),
          },
        ),
      );
      expect(settled.kind).toBe("settled");
      if (settled.kind === "settled") {
        expect(settled.reason).toContain("submission-1");
      }

      expect(ledger.acceptedEvents(GRAPH)).toEqual([
        makeEvent({ submissionId: "submission-1", outcomeId: "done" }),
      ]);
      expect(
        ledger.lookupReceipt({
          graphId: GRAPH,
          attemptId: "attempt-1",
          submissionId: "submission-2",
        }),
      ).toBeUndefined();
    });
  });

  it("keeps a rejected decision out of the accepted-event stream and leaves the attempt open", async () => {
    await withLedger(async (ledger) => {
      const rejected = ledger.commitAccepted({
        receipt: makeReceipt({ decision: "rejected" }),
      });
      expect(rejected.kind).toBe("committed");
      expect(ledger.acceptedEvents(GRAPH)).toEqual([]);

      const replay = ledger.commitAccepted({
        receipt: makeReceipt({ decision: "rejected" }),
      });
      expect(replay.kind).toBe("replayed");
      if (replay.kind === "replayed") {
        expect(replay.receipt.decision).toBe("rejected");
      }

      // A rejection does not settle the attempt: a later acceptance commits.
      const accepted = ledger.commitAccepted(
        makeBatch({ submissionId: "submission-2", proposalDigest: "digest-b" }),
      );
      expect(accepted.kind).toBe("committed");
      expect(ledger.acceptedEvents(GRAPH)).toEqual([
        makeEvent({ submissionId: "submission-2" }),
      ]);
    });
  });

  it("enforces at most one accepted event per attempt in the schema itself", async () => {
    await withLedger(async (ledger, dir) => {
      expect(ledger.commitAccepted(makeBatch()).kind).toBe("committed");
      await withRawStore(dir, (db) => {
        const duplicate = thrownError(() =>
          db.run(
            "INSERT INTO " +
              LEDGER_TABLES.acceptedEvents +
              " (graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at)" +
              " VALUES (?, ?, ?, ?, ?, ?)",
            GRAPH,
            "attempt-1",
            "submission-2",
            "plan-r1",
            "failed",
            1_700_000_000_009,
          ),
        );
        expect(duplicate).toBeInstanceOf(Error);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(1);
      });
    });
  });
});

// ── Effect lifecycle and restart ────────────────────────────────────────────

describe("SqliteAcceptanceLedger — effect lifecycle and restart", () => {
  it("moves an effect pending -> started -> done and stops listing terminal effects", async () => {
    await withLedger(async (ledger, dir) => {
      const first = makeEffect({ effectId: "effect-1" });
      const second = makeEffect({
        effectId: "effect-2",
        createdAt: 1_700_000_000_003,
      });
      expect(
        ledger.commitAccepted(makeBatch({}, { effects: [first, second] })).kind,
      ).toBe("committed");
      expect(ledger.pendingEffects(GRAPH)).toEqual([first, second]);

      expect(ledger.markEffectStarted(GRAPH, "effect-1").kind).toBe(
        "transitioned",
      );
      expect(ledger.pendingEffects(GRAPH)).toEqual([
        { ...first, status: "started" },
        second,
      ]);

      expect(ledger.markEffectDone(GRAPH, "effect-1").kind).toBe("transitioned");
      expect(ledger.markEffectFailed(GRAPH, "effect-2").kind).toBe(
        "transitioned",
      );
      expect(ledger.pendingEffects(GRAPH)).toEqual([]);

      // The terminal rows survive; they are simply never resumed.
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.pendingEffects, "status = 'done'")).toBe(1);
        expect(countRows(db, LEDGER_TABLES.pendingEffects, "status = 'failed'")).toBe(1);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(2);
      });

      const rewind = ledger.markEffectStarted(GRAPH, "effect-1");
      expect(rewind.kind).toBe("refused");
      if (rewind.kind === "refused") {
        expect(rewind.reason).toContain("terminal");
      }
      expect(ledger.markEffectDone(GRAPH, "effect-1").kind).toBe("unchanged");
      expect(ledger.markEffectDone(GRAPH, "effect-9").kind).toBe("missing");
    });
  });

  it("keeps every row across close + reopen", async () => {
    await withTempDir(async (dir) => {
      const first = await SqliteAcceptanceLedger.create(dir);
      const effect = makeEffect();
      expect(
        first.commitAccepted(makeBatch({}, { effects: [effect] })).kind,
      ).toBe("committed");
      expect(first.markEffectStarted(GRAPH, "effect-1").kind).toBe(
        "transitioned",
      );
      first.close();

      const second = await SqliteAcceptanceLedger.create(dir);
      try {
        expect(second.ledgerFormatVersion).toBe(LEDGER_FORMAT_VERSION);
        expect(second.lookupReceipt(keyOf(makeReceipt()))).toEqual(makeReceipt());
        expect(second.acceptedEvents(GRAPH)).toEqual([makeEvent()]);
        expect(second.pendingEffects(GRAPH)).toEqual([
          { ...effect, status: "started" },
        ]);
      } finally {
        second.close();
      }
    });
  });

  it("resumes an effect a previous instance left started", async () => {
    await withTempDir(async (dir) => {
      const first = await SqliteAcceptanceLedger.create(dir);
      first.commitAccepted(makeBatch({}, { effects: [makeEffect()] }));
      first.markEffectStarted(GRAPH, "effect-1");
      first.close();

      const second = await SqliteAcceptanceLedger.create(dir);
      try {
        expect(second.pendingEffects(GRAPH).map((entry) => entry.status)).toEqual([
          "started",
        ]);
        expect(second.markEffectDone(GRAPH, "effect-1").kind).toBe(
          "transitioned",
        );
        expect(second.pendingEffects(GRAPH)).toEqual([]);
      } finally {
        second.close();
      }
    });
  });
});

// ── Format gate ─────────────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — format gate", () => {
  /**
   * Create a real ledger, close it, tamper with the file, then reopen: the
   * open must refuse with the named problem and leave the file untouched.
   */
  async function expectRefused(options: {
    tamper: (db: DatabaseDriver) => void;
    problem: LedgerFormatError["problem"];
    verifyUntouched: (db: DatabaseDriver) => void;
  }): Promise<void> {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      await withRawStore(dir, (db) => options.tamper(db));

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe(options.problem);
        expect(error.path).toBe(ledgerFilePath(dir));
        expect(error.supported).toBe(LEDGER_FORMAT_VERSION);
      }

      await withRawStore(dir, (db) => options.verifyUntouched(db));
    });
  }

  it("refuses a newer format version and leaves the file untouched", async () => {
    await expectRefused({
      problem: "newer-format",
      tamper: (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = ? WHERE id = 1",
          LEDGER_FORMAT_VERSION + 1,
        );
      },
      verifyUntouched: (db) => {
        expect(
          countRows(
            db,
            LEDGER_TABLES.meta,
            "format_version = ?",
            LEDGER_FORMAT_VERSION + 1,
          ),
        ).toBe(1);
        expect(tableNames(db)).toEqual(ledgerSchema());
      },
    });
  });

  it("refuses an unknown format version no build in this line writes", async () => {
    await expectRefused({
      problem: "newer-format",
      tamper: (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = 42 WHERE id = 1",
        );
      },
      verifyUntouched: (db) => {
        expect(countRows(db, LEDGER_TABLES.meta, "format_version = 42")).toBe(1);
        expect(tableNames(db)).toEqual(ledgerSchema());
      },
    });
  });

  it("refuses a malformed format discriminator", async () => {
    await expectRefused({
      problem: "malformed-format",
      tamper: (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = 'v1' WHERE id = 1",
        );
      },
      verifyUntouched: (db) => {
        expect(
          countRows(db, LEDGER_TABLES.meta, "format_version = 'v1'"),
        ).toBe(1);
        expect(tableNames(db)).toEqual(ledgerSchema());
      },
    });
  });

  it("refuses a format version that is not a positive integer", async () => {
    await expectRefused({
      problem: "malformed-format",
      tamper: (db) => {
        db.run(
          "UPDATE " + LEDGER_TABLES.meta + " SET format_version = 0 WHERE id = 1",
        );
      },
      verifyUntouched: (db) => {
        expect(countRows(db, LEDGER_TABLES.meta, "format_version = 0")).toBe(1);
        expect(tableNames(db)).toEqual(ledgerSchema());
      },
    });
  });

  it("refuses a ledger whose format-version row is missing", async () => {
    await expectRefused({
      problem: "malformed-format",
      tamper: (db) => {
        db.run("DELETE FROM " + LEDGER_TABLES.meta);
      },
      verifyUntouched: (db) => {
        expect(countRows(db, LEDGER_TABLES.meta)).toBe(0);
        expect(tableNames(db)).toEqual(ledgerSchema());
      },
    });
  });

  it("refuses a ledger whose schema is incomplete", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        db.exec("DROP TABLE " + LEDGER_TABLES.receipts);
      },
      verifyUntouched: (db) => {
        expect(tableNames(db)).not.toContain(LEDGER_TABLES.receipts);
        expect(tableNames(db)).toContain(LEDGER_TABLES.acceptedEvents);
      },
    });
  });

  it("refuses a store whose ledger table lost a column", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        reshapeTable(
          db,
          LEDGER_TABLES.receipts,
          `CREATE TABLE ${LEDGER_TABLES.receipts} (
             graph_id TEXT NOT NULL,
             attempt_id TEXT NOT NULL,
             submission_id TEXT NOT NULL,
             plan_revision TEXT NOT NULL,
             decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
             committed_at INTEGER NOT NULL,
             PRIMARY KEY (graph_id, attempt_id, submission_id)
           )`,
          [
            "graph_id",
            "attempt_id",
            "submission_id",
            "plan_revision",
            "decision",
            "committed_at",
          ],
        );
      },
      verifyUntouched: (db) => {
        expect(columnNames(db, LEDGER_TABLES.receipts)).not.toContain(
          "proposal_digest",
        );
      },
    });
  });

  it("refuses a store whose ledger table gained a column", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        db.exec(
          "ALTER TABLE " + LEDGER_TABLES.acceptedEvents + " ADD COLUMN note TEXT",
        );
      },
      verifyUntouched: (db) => {
        expect(columnNames(db, LEDGER_TABLES.acceptedEvents)).toContain("note");
      },
    });
  });

  it("refuses a store whose ledger table retyped a column", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        reshapeTable(
          db,
          LEDGER_TABLES.receipts,
          `CREATE TABLE ${LEDGER_TABLES.receipts} (
             graph_id TEXT NOT NULL,
             attempt_id TEXT NOT NULL,
             submission_id TEXT NOT NULL,
             plan_revision TEXT NOT NULL,
             proposal_digest TEXT NOT NULL,
             decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
             committed_at TEXT NOT NULL,
             PRIMARY KEY (graph_id, attempt_id, submission_id)
           )`,
          [
            "graph_id",
            "attempt_id",
            "submission_id",
            "plan_revision",
            "proposal_digest",
            "decision",
            "committed_at",
          ],
        );
      },
      verifyUntouched: (db) => {
        expect(columnType(db, LEDGER_TABLES.receipts, "committed_at")).toBe(
          "TEXT",
        );
      },
    });
  });

  it("refuses a store whose ledger table lost the uniqueness the rules need", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        reshapeTable(
          db,
          LEDGER_TABLES.receipts,
          `CREATE TABLE ${LEDGER_TABLES.receipts} (
             graph_id TEXT NOT NULL,
             attempt_id TEXT NOT NULL,
             submission_id TEXT NOT NULL,
             plan_revision TEXT NOT NULL,
             proposal_digest TEXT NOT NULL,
             decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
             committed_at INTEGER NOT NULL
           )`,
          [
            "graph_id",
            "attempt_id",
            "submission_id",
            "plan_revision",
            "proposal_digest",
            "decision",
            "committed_at",
          ],
        );
      },
      verifyUntouched: (db) => {
        expect(primaryKeyColumns(db, LEDGER_TABLES.receipts)).toEqual([]);
      },
    });
  });

  it("refuses a reshaped version table instead of failing with a raw driver error", async () => {
    await expectRefused({
      problem: "incomplete-store",
      tamper: (db) => {
        db.exec(
          "ALTER TABLE " +
            LEDGER_TABLES.meta +
            " RENAME COLUMN format_version TO schema_version",
        );
      },
      verifyUntouched: (db) => {
        expect(columnNames(db, LEDGER_TABLES.meta)).toContain("schema_version");
        expect(columnNames(db, LEDGER_TABLES.meta)).not.toContain(
          "format_version",
        );
      },
    });
  });

  it("refuses a foreign SQLite store without creating a ledger in it", async () => {
    await withTempDir(async (dir) => {
      await withRawStore(dir, (db) => {
        db.exec(
          "CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT NOT NULL)",
        );
        db.run("INSERT INTO unrelated (id, note) VALUES (1, 'kept')");
      });

      const error = await rejectedError(() => SqliteAcceptanceLedger.create(dir));
      expect(error).toBeInstanceOf(LedgerFormatError);
      if (error instanceof LedgerFormatError) {
        expect(error.problem).toBe("foreign-store");
      }

      await withRawStore(dir, (db) => {
        expect(tableNames(db)).toEqual(["unrelated"]);
        expect(countRows(db, "unrelated")).toBe(1);
      });
    });
  });
});

// ── Atomicity and totality ──────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — atomicity and totality", () => {
  it("leaves nothing from a batch whose effect row collides mid-transaction", async () => {
    await withLedger(async (ledger, dir) => {
      const firstEffect = makeEffect({
        effectId: "effect-1",
        payload: { n: 1 },
      });
      expect(
        ledger.commitAccepted(makeBatch({}, { effects: [firstEffect] })).kind,
      ).toBe("committed");

      // The second batch inserts its receipt, its event, then effect-2, and
      // finally collides on effect-1 — a failure AFTER rows of the batch were
      // written, which is exactly the window atomicity must cover.
      const error = thrownError(() =>
        ledger.commitAccepted(
          makeBatch(
            {
              attemptId: "attempt-2",
              submissionId: "submission-2",
              proposalDigest: "digest-b",
            },
            {
              event: makeEvent({
                attemptId: "attempt-2",
                submissionId: "submission-2",
              }),
              effects: [
                makeEffect({ effectId: "effect-2", attemptId: "attempt-2" }),
                makeEffect({ effectId: "effect-1", attemptId: "attempt-2" }),
              ],
            },
          ),
        ),
      );
      expect(error).toBeInstanceOf(LedgerWriteError);

      expect(
        ledger.lookupReceipt({
          graphId: GRAPH,
          attemptId: "attempt-2",
          submissionId: "submission-2",
        }),
      ).toBeUndefined();
      expect(ledger.acceptedEvents(GRAPH)).toEqual([makeEvent()]);
      expect(ledger.pendingEffects(GRAPH)).toEqual([firstEffect]);
      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(1);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(1);
      });

      // The rolled-back transaction left the store usable.
      const third = ledger.commitAccepted(
        makeBatch(
          {
            attemptId: "attempt-3",
            submissionId: "submission-3",
            proposalDigest: "digest-c",
          },
          {
            event: makeEvent({
              attemptId: "attempt-3",
              submissionId: "submission-3",
            }),
          },
        ),
      );
      expect(third.kind).toBe("committed");
    });
  });

  it("contains a hostile payload and persists no part of its batch", async () => {
    await withLedger(async (ledger, dir) => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      const hostile: Array<{ label: string; payload: unknown }> = [
        { label: "bigint", payload: { bad: 1n } },
        { label: "cycle", payload: circular },
        { label: "nan", payload: { bad: Number.NaN } },
        { label: "function", payload: { bad: () => 1 } },
      ];

      for (const entry of hostile) {
        const attemptId = "attempt-" + entry.label;
        const submissionId = "submission-" + entry.label;
        const error = thrownError(() =>
          ledger.commitAccepted(
            makeBatch(
              {
                attemptId,
                submissionId,
                proposalDigest: "digest-" + entry.label,
              },
              {
                event: makeEvent({ attemptId, submissionId }),
                effects: [
                  makeEffect({
                    effectId: "effect-" + entry.label,
                    attemptId,
                    payload: { ok: true },
                  }),
                  makeEffect({
                    effectId: "hostile-" + entry.label,
                    attemptId,
                    payload: entry.payload,
                  }),
                ],
              },
            ),
          ),
        );
        expect(error).toBeInstanceOf(LedgerWriteError);
        if (error instanceof LedgerWriteError) {
          expect(error.problem).toBe("unrepresentable-payload");
        }
        expect(
          ledger.lookupReceipt({ graphId: GRAPH, attemptId, submissionId }),
        ).toBeUndefined();
        expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
        expect(ledger.pendingEffects(GRAPH)).toEqual([]);
        await withRawStore(dir, (db) => {
          expect(countRows(db, LEDGER_TABLES.receipts)).toBe(0);
          expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(0);
        });
      }

      // The store is still usable after every contained failure.
      expect(ledger.commitAccepted(makeBatch()).kind).toBe("committed");
    });
  });

  it("refuses a batch the record model rejects before it touches the store", async () => {
    await withLedger(async (ledger, dir) => {
      const malformed: AcceptanceBatch[] = [
        // An accepted decision without the accepted event it settles.
        makeBatch({}, { omitEvent: true }),
        // A rejected decision that tries to enter the accepted-event stream.
        {
          receipt: makeReceipt({ decision: "rejected" }),
          acceptedEvent: makeEvent(),
        },
        // An effect of a different attempt than the receipt.
        makeBatch({}, { effects: [makeEffect({ attemptId: "other" })] }),
        // A started effect: a transition is not part of an acceptance batch.
        makeBatch({}, { effects: [makeEffect({ status: "started" })] }),
        // An empty identifier.
        makeBatch({ proposalDigest: "" }),
        // A timestamp that is not epoch milliseconds.
        makeBatch({ committedAt: 1.5 }),
      ];

      for (const batch of malformed) {
        const error = thrownError(() => ledger.commitAccepted(batch));
        expect(error).toBeInstanceOf(LedgerWriteError);
        if (error instanceof LedgerWriteError) {
          expect(error.problem).toBe("invalid-batch");
        }
      }

      await withRawStore(dir, (db) => {
        expect(countRows(db, LEDGER_TABLES.receipts)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.acceptedEvents)).toBe(0);
        expect(countRows(db, LEDGER_TABLES.pendingEffects)).toBe(0);
      });
    });
  });
});

// ── Transaction extension point ─────────────────────────────────────────────

describe("SqliteAcceptanceLedger — transaction extension point", () => {
  it("commits the ledger's writes with the caller's transaction", async () => {
    await withLedger(async (ledger) => {
      const returned = ledger.runInTransaction((tx) => {
        const commit = tx.commitAccepted(
          makeBatch({}, { effects: [makeEffect()] }),
        );
        expect(commit.kind).toBe("committed");
        // The callback sees its own uncommitted writes.
        expect(tx.lookupReceipt(keyOf(makeReceipt()))).toEqual(makeReceipt());
        expect(tx.markEffectStarted(GRAPH, "effect-1").kind).toBe(
          "transitioned",
        );
        return "joined";
      });

      expect(returned).toBe("joined");
      expect(ledger.pendingEffects(GRAPH)).toEqual([
        { ...makeEffect(), status: "started" },
      ]);
    });
  });

  it("rolls the ledger's writes back when the caller's transaction throws", async () => {
    await withLedger(async (ledger) => {
      const error = thrownError(() =>
        ledger.runInTransaction((tx) => {
          tx.commitAccepted(
            makeBatch(
              {
                attemptId: "attempt-2",
                submissionId: "submission-2",
                proposalDigest: "digest-b",
              },
              {
                event: makeEvent({
                  attemptId: "attempt-2",
                  submissionId: "submission-2",
                }),
              },
            ),
          );
          throw new Error("caller aborted");
        }),
      );
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe("caller aborted");
      }
      expect(
        ledger.lookupReceipt({
          graphId: GRAPH,
          attemptId: "attempt-2",
          submissionId: "submission-2",
        }),
      ).toBeUndefined();
      expect(ledger.acceptedEvents(GRAPH)).toEqual([]);
    });
  });

  it("refuses a nested transaction and an async callback", async () => {
    await withLedger(async (ledger) => {
      const nested = thrownError(() =>
        ledger.runInTransaction(() => ledger.runInTransaction(() => 1)),
      );
      expect(nested).toBeInstanceOf(LedgerWriteError);
      if (nested instanceof LedgerWriteError) {
        expect(nested.problem).toBe("nested-transaction");
      }

      const async = thrownError(() => ledger.runInTransaction(async () => 1));
      expect(async).toBeInstanceOf(LedgerWriteError);
      if (async instanceof LedgerWriteError) {
        expect(async.problem).toBe("async-transaction");
      }
    });
  });
});

// ── Closed ledger ───────────────────────────────────────────────────────────

describe("SqliteAcceptanceLedger — closed ledger", () => {
  it("refuses every operation after close and tolerates a second close", async () => {
    await withTempDir(async (dir) => {
      const ledger = await SqliteAcceptanceLedger.create(dir);
      ledger.close();
      ledger.close();

      const key = keyOf(makeReceipt());
      const operations: Array<() => unknown> = [
        () => ledger.commitAccepted(makeBatch()),
        () => ledger.lookupReceipt(key),
        () => ledger.acceptedEvents(GRAPH),
        () => ledger.pendingEffects(GRAPH),
        () => ledger.markEffectStarted(GRAPH, "effect-1"),
        () => ledger.runInTransaction(() => 1),
      ];
      for (const operation of operations) {
        const error = thrownError(operation);
        expect(error).toBeInstanceOf(LedgerClosedError);
      }

      // The closed handle did not damage the file: a fresh instance opens it.
      const reopened = await SqliteAcceptanceLedger.create(dir);
      try {
        expect(reopened.acceptedEvents(GRAPH)).toEqual([]);
      } finally {
        reopened.close();
      }
    });
  });
});
