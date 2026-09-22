/**
 * Graph Execution Engine v2 — SQLite durable acceptance ledger
 *
 * Version: 1.0
 * Date: 2026-09-22
 *
 * The durable substrate for {@link AcceptanceLedger}, over the portable
 * in-tree SQLite driver (`src/memory/db-driver.ts`): the SAME file works under
 * Bun and Node, the driver was verified on its delete-journal default for
 * rollback, whole-batch rollback, durability across restart, and recovery
 * after an abrupt exit, and nothing here changes that configuration — no
 * journal pragma, no module-level connection, no global singleton.
 *
 * ATOMICITY IS THE POINT. `commitAccepted` evaluates the idempotency rules
 * (replayed / conflict / settled) and then writes the receipt, the accepted
 * event and every pending effect inside ONE transaction that COMMITS before
 * the verdict is returned. A constraint violation, an effect row that cannot
 * be stored, or a payload JSON cannot represent throws a
 * {@link LedgerWriteError} and the transaction ROLLS BACK: nothing from that
 * batch is persisted, and `committed` is never reported for an uncommitted
 * batch (the verdict is built inside the transaction but is returned only
 * after the driver's COMMIT succeeded).
 *
 * THE FORMAT IS REFUSED, NEVER RECREATED. Opening a file that is not this
 * build's ledger — a foreign store, a malformed or missing version row, a
 * version this build does not write (unknown, newer, or older: this slice
 * registers no migration), or a table whose columns are missing, renamed,
 * retyped or keyed differently — throws a {@link LedgerFormatError} and leaves
 * the file untouched. "Unknown is not a clean start" is the same discipline the
 * B stage applies to engine snapshots.
 *
 * RESTART IS A READ. A new instance over the same file sees identical rows, and
 * `pendingEffects` answers what a previous process left `pending` or
 * `started` — that listing IS the resume path. Effects are bookkeeping only:
 * nothing here executes, dispatches or reconciles one.
 *
 * SCOPE: the durable substrate of the OUTCOME protocol. The legacy v2 run path
 * keeps its file persistence untouched and imports none of this module.
 * `ledger_graph_state` carries the outcome runtime's state (C3b), and
 * `writeGraphState` joins a caller's ACCEPTANCE transaction: the state snapshot
 * commits with the receipt, the accepted event and the pending effects instead
 * of landing beside them in a second write that a crash could separate. Nothing
 * under `src/graph/engine`, `src/graph/tools` or `src/dispatch` imports this
 * module; the run path that does is `src/graph/outcome/runtime.ts`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { errorText } from "../../utils/error-text.ts";
import {
  createDatabase,
  type DatabaseDriver,
} from "../../memory/db-driver.ts";
import {
  GRAPH_STATE_MAX_BYTES,
  LEDGER_FORMAT_VERSION,
  type AcceptanceBatch,
  type AcceptanceLedger,
  type AcceptanceLedgerTx,
  type AcceptedEventRecord,
  type CommitResult,
  type EffectStatus,
  type EffectTransition,
  type GraphStateRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
  type SubmissionKey,
} from "./types.ts";

// ── File and schema identity ────────────────────────────────────────────────

/** The file name the ledger owns inside its directory. */
export const LEDGER_FILE_NAME = "graph-acceptance-ledger.sqlite";

/**
 * The ledger file path for a directory.
 *
 * The DIRECTORY is the injection point — `create` takes it, derives this path,
 * and opens one connection — so a test uses `mkdtempSync` and two graphs may
 * keep separate stores without a process-wide singleton.
 */
export function ledgerFilePath(directory: string): string {
  return join(directory, LEDGER_FILE_NAME);
}

/**
 * The table names this schema version owns.
 *
 * Exported because the format gate must RECOGNIZE a foreign, newer or
 * incomplete store — and a test must be able to fabricate one — without
 * guessing at private names. The names are prefixed so the file can never be
 * mistaken for an unrelated SQLite store.
 */
export const LEDGER_TABLES = Object.freeze({
  meta: "ledger_meta",
  receipts: "ledger_receipts",
  acceptedEvents: "ledger_accepted_events",
  pendingEffects: "ledger_pending_effects",
  graphState: "ledger_graph_state",
});

/**
 * One DDL statement per table, in creation order.
 *
 * The uniqueness the protocol rules need is STRUCTURAL, not merely a code
 * path: receipts are unique on `(graph_id, attempt_id, submission_id)`, an
 * attempt can hold AT MOST ONE accepted event (`PRIMARY KEY (graph_id,
 * attempt_id)`), and effects are keyed by `(graph_id, effect_id)` with a
 * status column the lifecycle moves.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE ${LEDGER_TABLES.meta} (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     format_version INTEGER NOT NULL
   )`,
  `CREATE TABLE ${LEDGER_TABLES.receipts} (
     graph_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     submission_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     proposal_digest TEXT NOT NULL,
     decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
     committed_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, attempt_id, submission_id)
   )`,
  `CREATE TABLE ${LEDGER_TABLES.acceptedEvents} (
     graph_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     submission_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     outcome_id TEXT NOT NULL,
     accepted_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, attempt_id)
   )`,
  `CREATE TABLE ${LEDGER_TABLES.pendingEffects} (
     graph_id TEXT NOT NULL,
     effect_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'done', 'failed')),
     PRIMARY KEY (graph_id, effect_id)
   )`,
  `CREATE TABLE ${LEDGER_TABLES.graphState} (
     graph_id TEXT NOT NULL,
     plan_revision TEXT NOT NULL,
     body TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id)
   )`,
];

/**
 * One column this format version writes, as the shape gate expects to find it.
 *
 * `affinity` is SQLite's storage class rather than the spelled type, so the
 * gate compares what a column MEANS: `TEXT` and `VARCHAR` name the same
 * column, `BLOB` where this format writes `TEXT` does not. `primaryKey` is
 * the column's position in the table's PRIMARY KEY (0 = not part of it), which
 * is how the uniqueness the protocol rules need is verified as STRUCTURAL
 * rather than trusted; `notNull` mirrors the declaration.
 */
interface LedgerColumn {
  readonly name: string;
  readonly affinity: "text" | "integer";
  readonly primaryKey: number;
  readonly notNull: boolean;
}

/**
 * The exact column shape of every table this format version writes.
 *
 * The format gate compares a store against THIS, not against the table names
 * alone: a store can carry a `ledger_receipts` whose columns are missing,
 * renamed, retyped or keyless, and the first statement against it would then
 * fail with a raw driver error instead of the typed refusal a foreign store
 * gets. Columns are matched by NAME — every query in this module addresses
 * columns by name, so order is not identity — and the list is exhaustive,
 * because this format writes exactly these columns and an extra one is a
 * reshape too. The `id` of the meta table is an `INTEGER PRIMARY KEY`, the
 * rowid alias SQLite reports as nullable; the gate records the declaration,
 * not the intent.
 */
const LEDGER_COLUMNS: Readonly<
  Record<keyof typeof LEDGER_TABLES, readonly LedgerColumn[]>
> = Object.freeze({
  meta: [
    { name: "id", affinity: "integer", primaryKey: 1, notNull: false },
    { name: "format_version", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  receipts: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "submission_id", affinity: "text", primaryKey: 3, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "proposal_digest", affinity: "text", primaryKey: 0, notNull: true },
    { name: "decision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "committed_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  acceptedEvents: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "submission_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "outcome_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "accepted_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
  pendingEffects: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "effect_id", affinity: "text", primaryKey: 2, notNull: true },
    { name: "attempt_id", affinity: "text", primaryKey: 0, notNull: true },
    { name: "kind", affinity: "text", primaryKey: 0, notNull: true },
    { name: "payload", affinity: "text", primaryKey: 0, notNull: true },
    { name: "created_at", affinity: "integer", primaryKey: 0, notNull: true },
    { name: "status", affinity: "text", primaryKey: 0, notNull: true },
  ],
  graphState: [
    { name: "graph_id", affinity: "text", primaryKey: 1, notNull: true },
    { name: "plan_revision", affinity: "text", primaryKey: 0, notNull: true },
    { name: "body", affinity: "text", primaryKey: 0, notNull: true },
    { name: "updated_at", affinity: "integer", primaryKey: 0, notNull: true },
  ],
});

// ── Refusals ────────────────────────────────────────────────────────────────

/** Why a ledger file was refused. Stable identifiers; wording is not API. */
export type LedgerFormatProblem =
  /** The file's format version is NEWER than this build writes. */
  | "newer-format"
  /**
   * The file's format version is older and this build registers no migration.
   * With one registered format the branch is unreachable (version 0 or a
   * negative is malformed); it exists so the first format bump cannot open an
   * older file as the newer layout.
   */
  | "older-format"
  /** The version row is missing, or its value is not a positive safe integer. */
  | "malformed-format"
  /** The file is a SQLite store, but not this ledger. */
  | "foreign-store"
  /**
   * The version table exists, but the schema this version owns is incomplete
   * or reshaped — a table is missing, or a table's columns, affinities, NOT
   * NULL declarations or PRIMARY KEY are not the ones this format writes.
   */
  | "incomplete-store"
  /** A row exists but violates the record model. */
  | "malformed-row"
  /**
   * The file is a SQLite store whose journal mode is WAL. A read-only SQLite
   * open of a WAL database attaches to — and rewrites — its `-shm`
   * shared-memory side file, so the drain audit refuses it BEFORE any
   * connection exists instead of changing the store it is reading. The file and
   * its side files are left exactly as they were found.
   */
  | "wal-journal-mode";

/**
 * The ledger file was refused: it is not a store this build may open.
 *
 * The error names the FILE and the concrete problem, and it is thrown BEFORE
 * any schema is created or any row is changed, so a refusal never destroys the
 * record it could not understand.
 */
export class LedgerFormatError extends Error {
  readonly problem: LedgerFormatProblem;
  readonly path: string;
  /** The raw offending value, when the problem has one. */
  readonly found: unknown;
  /** The ledger format this build writes. */
  readonly supported: number;

  constructor(
    problem: LedgerFormatProblem,
    path: string,
    message: string,
    found: unknown,
    supported: number = LEDGER_FORMAT_VERSION,
  ) {
    super(message);
    this.name = "LedgerFormatError";
    this.problem = problem;
    this.path = path;
    this.found = found;
    this.supported = supported;
  }
}

/** Why one batch could not be written. Stable identifiers; wording is not API. */
export type LedgerWriteProblem =
  /** The batch violates the record model or the one-submission rule. */
  | "invalid-batch"
  /** A payload JSON cannot represent — nothing from the batch was committed. */
  | "unrepresentable-payload"
  /** A graph-state record violates the record model. */
  | "invalid-graph-state"
  /**
   * A graph-state body JSON cannot represent — the transaction that would have
   * committed it rolled back, so no receipt, event or effect survives either.
   */
  | "unrepresentable-state"
  /**
   * A graph-state body is larger than {@link GRAPH_STATE_MAX_BYTES} — refused
   * BEFORE a row is written, so the acceptance transaction as a whole rolls
   * back rather than storing a truncated state.
   */
  | "oversized-state"
  /** The store rejected a row (a uniqueness violation, a broken file). */
  | "write-rejected"
  /** A nested `runInTransaction` — the boundary is one transaction. */
  | "nested-transaction"
  /** A `runInTransaction` callback that returned a promise. */
  | "async-transaction";

/**
 * A batch write was refused or rolled back.
 *
 * Thrown INSTEAD of returning `committed`: a batch the store cannot persist
 * must never report success, and the transaction that carried its earlier rows
 * has already rolled back when this error reaches the caller.
 */
export class LedgerWriteError extends Error {
  readonly problem: LedgerWriteProblem;

  constructor(problem: LedgerWriteProblem, message: string) {
    super(message);
    this.name = "LedgerWriteError";
    this.problem = problem;
  }
}

/** A closed ledger refuses every read and write. */
export class LedgerClosedError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `acceptance-ledger: ${operation} refused — this ledger is closed, and a closed ledger refuses reads and writes rather than touching a released connection`,
    );
    this.name = "LedgerClosedError";
    this.operation = operation;
  }
}

// ── Row model ───────────────────────────────────────────────────────────────

/**
 * Whether the driver answered "no row".
 *
 * The two runtimes disagree on the empty case — `bun:sqlite` answers `null`
 * and `node:sqlite` answers `undefined` — so BOTH mean no row here. Reading
 * only one of them would make a first commit look like a malformed receipt
 * under one runtime and work under the other.
 */
function isNoRow(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Whether a value can be awaited (the callback of `runInTransaction` must not be). */
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  if (!("then" in value)) return false;
  return typeof value.then === "function";
}

/** Name what was received for a diagnostic, without throwing on the value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return `${String(value)}n`;
  return typeof value;
}

/** Refuse one row that violates the record model (a hand-edited or foreign file). */
function malformedRow(
  path: string,
  table: string,
  detail: string,
): LedgerFormatError {
  return new LedgerFormatError(
    "malformed-row",
    path,
    `acceptance-ledger: a ${table} row of ${path} violates the ledger record model: ${detail}`,
    undefined,
  );
}

/** Read one row-shaped answer, or refuse what the driver returned instead. */
function asRow(
  value: unknown,
  path: string,
  table: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedRow(
      path,
      table,
      `the driver answered ${describeValue(value)} instead of a row`,
    );
  }
  return value as Record<string, unknown>;
}

/** Read one TEXT column as a non-empty string. */
function readText(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw malformedRow(
      path,
      table,
      `${column} is ${describeValue(value)}, not a non-empty string`,
    );
  }
  return value;
}

/** Read one INTEGER column as epoch milliseconds. */
function readEpoch(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw malformedRow(
      path,
      table,
      `${column} is ${describeValue(value)}, not epoch milliseconds (a safe integer)`,
    );
  }
  return value;
}

/** Read the `decision` column as the closed vocabulary. */
function readDecision(
  row: Record<string, unknown>,
  path: string,
): "accepted" | "rejected" {
  const value = row["decision"];
  if (value === "accepted" || value === "rejected") return value;
  throw malformedRow(
    path,
    LEDGER_TABLES.receipts,
    `decision is ${describeValue(value)}, not "accepted" or "rejected"`,
  );
}

/** Read the `status` column as the closed vocabulary. */
function readStatus(row: Record<string, unknown>, path: string): EffectStatus {
  const value = row["status"];
  if (
    value === "pending" ||
    value === "started" ||
    value === "done" ||
    value === "failed"
  ) {
    return value;
  }
  throw malformedRow(
    path,
    LEDGER_TABLES.pendingEffects,
    `status is ${describeValue(value)}, not pending, started, done or failed`,
  );
}

/** Read one JSON body column and parse its TEXT value. */
function readJsonBody(
  row: Record<string, unknown>,
  column: string,
  path: string,
  table: string,
): unknown {
  const text = readText(row, column, path, table);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw malformedRow(
      path,
      table,
      `${column} is not readable JSON (${errorText(error)})`,
    );
  }
}

/** Read the effect payload column. */
function readPayload(row: Record<string, unknown>, path: string): unknown {
  return readJsonBody(row, "payload", path, LEDGER_TABLES.pendingEffects);
}

function toReceipt(
  row: Record<string, unknown>,
  path: string,
): ReceiptRecord {
  const table = LEDGER_TABLES.receipts;
  return {
    graphId: readText(row, "graph_id", path, table),
    attemptId: readText(row, "attempt_id", path, table),
    submissionId: readText(row, "submission_id", path, table),
    planRevision: readText(row, "plan_revision", path, table),
    proposalDigest: readText(row, "proposal_digest", path, table),
    decision: readDecision(row, path),
    committedAt: readEpoch(row, "committed_at", path, table),
  };
}

function toAcceptedEvent(
  row: Record<string, unknown>,
  path: string,
): AcceptedEventRecord {
  const table = LEDGER_TABLES.acceptedEvents;
  return {
    graphId: readText(row, "graph_id", path, table),
    attemptId: readText(row, "attempt_id", path, table),
    submissionId: readText(row, "submission_id", path, table),
    planRevision: readText(row, "plan_revision", path, table),
    outcomeId: readText(row, "outcome_id", path, table),
    acceptedAt: readEpoch(row, "accepted_at", path, table),
  };
}

function toGraphState(
  row: Record<string, unknown>,
  path: string,
): GraphStateRecord {
  const table = LEDGER_TABLES.graphState;
  return {
    graphId: readText(row, "graph_id", path, table),
    planRevision: readText(row, "plan_revision", path, table),
    body: readJsonBody(row, "body", path, table),
    updatedAt: readEpoch(row, "updated_at", path, table),
  };
}

function toPendingEffect(
  row: Record<string, unknown>,
  path: string,
): PendingEffectRecord {
  const table = LEDGER_TABLES.pendingEffects;
  return {
    graphId: readText(row, "graph_id", path, table),
    effectId: readText(row, "effect_id", path, table),
    attemptId: readText(row, "attempt_id", path, table),
    kind: readText(row, "kind", path, table),
    payload: readPayload(row, path),
    createdAt: readEpoch(row, "created_at", path, table),
    status: readStatus(row, path),
  };
}

// ── Batch validation and payload encoding ───────────────────────────────────

/** Refuse a field that is not a non-empty identifier. */
function requireIdentifier(
  value: unknown,
  field: string,
  problem: LedgerWriteProblem = "invalid-batch",
  consequence = "the batch was not written",
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerWriteError(
      problem,
      `acceptance-ledger: ${field} is ${describeValue(value)}, not a non-empty identifier — ${consequence}`,
    );
  }
}

/** Refuse a timestamp that is not epoch milliseconds. */
function requireEpoch(
  value: unknown,
  field: string,
  problem: LedgerWriteProblem = "invalid-batch",
  consequence = "the batch was not written",
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LedgerWriteError(
      problem,
      `acceptance-ledger: ${field} is ${describeValue(value)}, not epoch milliseconds (a safe integer) — ${consequence}`,
    );
  }
}

/**
 * Validate one graph-state record against the record model BEFORE it is stored.
 *
 * A malformed record is refused with its own code, so it can never be confused
 * with a batch violation; the body itself is the encoder's question, not this
 * gate's.
 */
function assertGraphStateShape(record: GraphStateRecord): void {
  requireIdentifier(
    record.graphId,
    "graphState.graphId",
    "invalid-graph-state",
    "the state was not written",
  );
  requireIdentifier(
    record.planRevision,
    "graphState.planRevision",
    "invalid-graph-state",
    "the state was not written",
  );
  requireEpoch(
    record.updatedAt,
    "graphState.updatedAt",
    "invalid-graph-state",
    "the state was not written",
  );
}

/** Refuse a batch field that disagrees with the receipt it must describe. */
function requireSame(value: unknown, expected: string, field: string): void {
  if (value !== expected) {
    throw new LedgerWriteError(
      "invalid-batch",
      `acceptance-ledger: ${field} is ${describeValue(value)}, but the receipt names ${JSON.stringify(expected)} — a batch describes exactly ONE submission and was not written`,
    );
  }
}

/**
 * Validate the whole batch against the record model BEFORE any protocol rule
 * runs, so a malformed batch can never look like a replay, a conflict or a
 * settlement. Uniqueness is deliberately NOT checked here: the store's own
 * constraints are the authority, and a violation must fail the transaction.
 */
function assertBatchShape(batch: AcceptanceBatch): void {
  const receipt = batch.receipt;
  requireIdentifier(receipt.graphId, "receipt.graphId");
  requireIdentifier(receipt.attemptId, "receipt.attemptId");
  requireIdentifier(receipt.submissionId, "receipt.submissionId");
  requireIdentifier(receipt.planRevision, "receipt.planRevision");
  requireIdentifier(receipt.proposalDigest, "receipt.proposalDigest");
  requireEpoch(receipt.committedAt, "receipt.committedAt");
  const decision =
    receipt.decision === "accepted" || receipt.decision === "rejected"
      ? receipt.decision
      : undefined;
  if (decision === undefined) {
    throw new LedgerWriteError(
      "invalid-batch",
      `acceptance-ledger: receipt.decision is ${describeValue(receipt.decision)}, not "accepted" or "rejected" — the batch was not written`,
    );
  }

  const event = batch.acceptedEvent;
  if (decision === "accepted" && event === undefined) {
    throw new LedgerWriteError(
      "invalid-batch",
      "acceptance-ledger: an accepted decision requires the accepted event it settles — a receipt without a settlement would record a decision while leaving the attempt open, so the batch was not written",
    );
  }
  if (decision === "rejected" && event !== undefined) {
    throw new LedgerWriteError(
      "invalid-batch",
      `acceptance-ledger: attempt ${receipt.attemptId} carries a rejected decision AND an accepted event — rejected proposals do not enter the accepted-event stream, so the batch was not written`,
    );
  }
  if (event !== undefined) {
    requireSame(event.graphId, receipt.graphId, "acceptedEvent.graphId");
    requireSame(event.attemptId, receipt.attemptId, "acceptedEvent.attemptId");
    requireSame(
      event.submissionId,
      receipt.submissionId,
      "acceptedEvent.submissionId",
    );
    requireSame(
      event.planRevision,
      receipt.planRevision,
      "acceptedEvent.planRevision",
    );
    requireIdentifier(event.outcomeId, "acceptedEvent.outcomeId");
    requireEpoch(event.acceptedAt, "acceptedEvent.acceptedAt");
  }

  for (const effect of batch.effects ?? []) {
    requireIdentifier(effect.effectId, "effect.effectId");
    requireIdentifier(effect.kind, `effect ${effect.effectId}.kind`);
    requireSame(effect.graphId, receipt.graphId, `effect ${effect.effectId}.graphId`);
    requireSame(
      effect.attemptId,
      receipt.attemptId,
      `effect ${effect.effectId}.attemptId`,
    );
    requireEpoch(effect.createdAt, `effect ${effect.effectId}.createdAt`);
    if (effect.status !== "pending") {
      throw new LedgerWriteError(
        "invalid-batch",
        `acceptance-ledger: effect ${effect.effectId} enters the batch as ${describeValue(effect.status)} — an acceptance batch writes PENDING effects only; a started or terminal effect is a transition, not part of the commit`,
      );
    }
  }
}

/**
 * Encode one JSON body for its TEXT column.
 *
 * The stored value is the body's JSON text, which is exactly what the port
 * round-trips (`payload: unknown`, `body: unknown`), and a value JSON has NO
 * representation for — `undefined`, a function, a symbol, a BigInt, a
 * non-finite number, a reference cycle — throws BEFORE the row is inserted, so a
 * hostile body rolls the whole transaction back instead of storing a silently
 * truncated one. Effects and graph state share this ONE representability rule,
 * parameterized by `subject` (what the body belongs to, for the diagnostic) and
 * `problem` (the code its caller reports).
 */
function encodeJsonBody(
  value: unknown,
  subject: string,
  problem: LedgerWriteProblem,
): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key: string, entry: unknown) => {
      if (
        entry === undefined ||
        typeof entry === "function" ||
        typeof entry === "symbol" ||
        typeof entry === "bigint"
      ) {
        throw new LedgerWriteError(
          problem,
          `acceptance-ledger: ${subject} contains ${
            entry === undefined ? "an undefined value" : `a ${typeof entry} value`
          }, which JSON cannot represent — nothing from this transaction was committed`,
        );
      }
      if (typeof entry === "number" && !Number.isFinite(entry)) {
        throw new LedgerWriteError(
          problem,
          `acceptance-ledger: ${subject} contains ${String(entry)}, which JSON cannot represent — nothing from this transaction was committed`,
        );
      }
      return entry;
    });
  } catch (error) {
    if (error instanceof LedgerWriteError) throw error;
    throw new LedgerWriteError(
      problem,
      `acceptance-ledger: ${subject} cannot be serialized as JSON (${errorText(error)}) — nothing from this transaction was committed`,
    );
  }
  if (typeof text !== "string") {
    throw new LedgerWriteError(
      problem,
      `acceptance-ledger: ${subject} has no JSON text — nothing from this transaction was committed`,
    );
  }
  return text;
}

/** Encode one effect payload for its TEXT column. */
function encodePayload(payload: unknown, effectId: string): string {
  return encodeJsonBody(
    payload,
    `the payload of effect ${effectId}`,
    "unrepresentable-payload",
  );
}

/**
 * Encode one graph-state body for its TEXT column, enforcing the size bound.
 *
 * The byte length of the ENCODED text is what `GRAPH_STATE_MAX_BYTES` limits,
 * so the check measures exactly what would be stored; an oversized body is
 * refused before the row is written, and the caller's transaction rolls back
 * with it.
 */
function encodeStateBody(body: unknown, graphId: string): string {
  const text = encodeJsonBody(
    body,
    `the state body of graph ${graphId}`,
    "unrepresentable-state",
  );
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > GRAPH_STATE_MAX_BYTES) {
    throw new LedgerWriteError(
      "oversized-state",
      `acceptance-ledger: the state body of graph ${graphId} is ${bytes} bytes, beyond the ${GRAPH_STATE_MAX_BYTES}-byte limit this ledger stores — nothing from this transaction was committed`,
    );
  }
  return text;
}

// ── Open-time format gate ───────────────────────────────────────────────────

/** Best-effort close for a handle that is being abandoned after a refusal. */
function closeQuietly(db: DatabaseDriver): void {
  try {
    db.close();
  } catch {
    // The refusal is the error that matters; a release failure cannot replace it.
  }
}

/** SQLite's own file magic, the first 16 bytes of every database file. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * Is this file a SQLite database in WAL journal mode? Decided from the FILE
 * HEADER, before any connection exists.
 *
 * The header's bytes 18/19 are the "file format read version" and "write
 * version": 2 for a WAL database, 1 for a rollback-journal one, and the mode is
 * durable in the file. Reading 20 bytes cannot touch a side file, which is
 * exactly the point: opening a WAL database through SQLite — even read-only —
 * attaches to its `-shm` shared-memory file and rewrites it.
 *
 * A file that cannot be read, or does not carry the magic, is NOT this check's
 * problem: the open and the format gate report it with their own vocabulary.
 */
function isWalStore(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(20);
    const read = readSync(fd, header, 0, 20, 0);
    return (
      read === 20 &&
      header.subarray(0, 16).toString("latin1") === SQLITE_MAGIC &&
      (header[18] === 2 || header[19] === 2)
    );
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The user tables a SQLite file holds, sorted; a foreign file fails here. */
function inspectTables(db: DatabaseDriver, filePath: string): string[] {
  let rows: unknown[];
  try {
    rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
  } catch (error) {
    throw new LedgerFormatError(
      "foreign-store",
      filePath,
      `acceptance-ledger: ${filePath} could not be read as an acceptance ledger (${errorText(error)}) — refusing to create a ledger over a file this build cannot recognize`,
      undefined,
    );
  }
  const names: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const name = (row as { readonly name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names.sort();
}

/** Create the schema and its version row in ONE transaction. */
function initializeLedger(db: DatabaseDriver): void {
  const create = db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.run(
      `INSERT INTO ${LEDGER_TABLES.meta} (id, format_version) VALUES (1, ?)`,
      LEDGER_FORMAT_VERSION,
    );
  });
  create();
}

/** Refuse a store that claims this ledger's version table but is not intact. */
function requireLedgerTables(
  tables: readonly string[],
  filePath: string,
): void {
  const missing = [
    LEDGER_TABLES.receipts,
    LEDGER_TABLES.acceptedEvents,
    LEDGER_TABLES.pendingEffects,
    LEDGER_TABLES.graphState,
  ].filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new LedgerFormatError(
      "incomplete-store",
      filePath,
      `acceptance-ledger: ${filePath} carries ${LEDGER_TABLES.meta} but is missing ${missing.join(", ")} — refusing to recreate a ledger that is not intact`,
      missing,
    );
  }
}

/** One column a store declares, as `PRAGMA table_info` reports it. */
interface ObservedColumn {
  readonly name: string;
  readonly affinity: "text" | "integer" | "other";
  readonly primaryKey: number;
  readonly notNull: boolean;
}

/**
 * SQLite's own type-affinity rule, narrowed to the classes this format writes.
 *
 * The gate compares AFFINITY rather than the spelled type because affinity is
 * what SQLite itself applies when it stores or converts a value: `TEXT` and
 * `VARCHAR` describe the same column here, `BLOB` where this format writes
 * `TEXT` is a reshape, and anything else is `other` and refused.
 */
function affinityOf(declaredType: string): ObservedColumn["affinity"] {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "text";
  }
  return "other";
}

/**
 * The columns one table declares, or a typed refusal.
 *
 * A table named like a ledger table but holding columns this build cannot read
 * is not thereby foreign — it is refused with the same `incomplete-store`
 * problem as any other half-shaped store, BEFORE a row is touched.
 */
function inspectColumns(
  db: DatabaseDriver,
  table: keyof typeof LEDGER_TABLES,
  filePath: string,
): ObservedColumn[] {
  const name = LEDGER_TABLES[table];
  let rows: unknown[];
  try {
    rows = db.query(`PRAGMA table_info(${name})`).all();
  } catch (error) {
    throw new LedgerFormatError(
      "incomplete-store",
      filePath,
      `acceptance-ledger: ${filePath} carries ${name}, but its columns could not be read (${errorText(error)}) — refusing to open a store whose layout this build cannot know`,
      undefined,
    );
  }
  const columns: ObservedColumn[] = [];
  for (const row of rows) {
    const entry = asRow(row, filePath, name);
    const columnName = entry["name"];
    const declaredType = entry["type"];
    if (
      typeof columnName !== "string" ||
      columnName.length === 0 ||
      typeof declaredType !== "string"
    ) {
      throw new LedgerFormatError(
        "incomplete-store",
        filePath,
        `acceptance-ledger: ${filePath} carries ${name}, but a column description of it is unreadable — refusing to open a store whose layout this build cannot know`,
        undefined,
      );
    }
    const rawPrimaryKey = entry["pk"];
    const rawNotNull = entry["notnull"];
    columns.push({
      name: columnName,
      affinity: affinityOf(declaredType),
      primaryKey: typeof rawPrimaryKey === "number" ? rawPrimaryKey : 0,
      notNull: rawNotNull === 1 || rawNotNull === true,
    });
  }
  return columns;
}

/**
 * Refuse a store whose table is not the shape this format version writes.
 *
 * Table NAMES are not identity: a store can carry a `ledger_receipts` with a
 * renamed or dropped column, a retyped timestamp or a key that enforces
 * nothing, and the first statement against it would then fail with a raw
 * driver error — the very outcome the format gate exists to prevent. Every
 * column's name, affinity, NOT NULL declaration and PRIMARY KEY position is
 * compared against {@link LEDGER_COLUMNS}, and the whole file is refused
 * BEFORE any row is read. The key is checked here because the protocol rules
 * depend on that uniqueness being structural, not merely a code path.
 */
function requireTableShape(
  db: DatabaseDriver,
  table: keyof typeof LEDGER_TABLES,
  filePath: string,
): void {
  const expected = LEDGER_COLUMNS[table];
  const observed = inspectColumns(db, table, filePath);
  const problems: string[] = [];
  const byName = new Map(observed.map((column) => [column.name, column]));
  for (const column of expected) {
    const found = byName.get(column.name);
    if (found === undefined) {
      problems.push(`column ${column.name} is missing`);
      continue;
    }
    if (found.affinity !== column.affinity) {
      problems.push(
        `column ${column.name} is ${found.affinity} where this format writes ${column.affinity}`,
      );
    }
    if (found.notNull !== column.notNull) {
      problems.push(
        `column ${column.name} is ${found.notNull ? "declared NOT NULL" : "nullable"} where this format writes it ${column.notNull ? "NOT NULL" : "nullable"}`,
      );
    }
    if (found.primaryKey !== column.primaryKey) {
      problems.push(
        `column ${column.name} is ${found.primaryKey === 0 ? "outside the PRIMARY KEY" : `at PRIMARY KEY position ${found.primaryKey}`} where this format writes ${column.primaryKey === 0 ? "it outside the key" : `PRIMARY KEY position ${column.primaryKey}`}`,
      );
    }
  }
  for (const column of observed) {
    if (!expected.some((entry) => entry.name === column.name)) {
      problems.push(
        `column ${column.name} is not part of format ${LEDGER_FORMAT_VERSION}`,
      );
    }
  }
  if (problems.length === 0) return;
  throw new LedgerFormatError(
    "incomplete-store",
    filePath,
    `acceptance-ledger: ${filePath} carries ${LEDGER_TABLES[table]} in a shape ledger format ${LEDGER_FORMAT_VERSION} does not write (${problems.join("; ")}) — refusing to open a store whose layout this build cannot know`,
    problems,
  );
}

/**
 * Read and check the format-version row.
 *
 * A missing row, a value that is not a positive safe integer, or a version this
 * build does not write is refused here, before any table is touched: the store
 * is left exactly as it was found.
 */
function requireFormatVersion(db: DatabaseDriver, filePath: string): void {
  let raw: unknown;
  try {
    raw = db
      .query(`SELECT format_version FROM ${LEDGER_TABLES.meta} WHERE id = 1`)
      .get();
  } catch (error) {
    throw new LedgerFormatError(
      "incomplete-store",
      filePath,
      `acceptance-ledger: ${filePath} carries a ${LEDGER_TABLES.meta} table whose version row cannot be read (${errorText(error)}) — refusing to open a store this build cannot identify`,
      undefined,
    );
  }
  if (isNoRow(raw)) {
    throw new LedgerFormatError(
      "malformed-format",
      filePath,
      `acceptance-ledger: ${filePath} carries no format-version row — a ledger without its format identity is refused, never recreated`,
      undefined,
    );
  }
  const found = asRow(raw, filePath, LEDGER_TABLES.meta)["format_version"];
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found <= 0) {
    throw new LedgerFormatError(
      "malformed-format",
      filePath,
      `acceptance-ledger: ${filePath} carries format_version ${describeValue(found)}, which is not a positive safe integer — this build writes ${LEDGER_FORMAT_VERSION}`,
      found,
    );
  }
  if (found > LEDGER_FORMAT_VERSION) {
    throw new LedgerFormatError(
      "newer-format",
      filePath,
      `acceptance-ledger: ${filePath} was written with ledger format ${found}, which is NEWER than the ${LEDGER_FORMAT_VERSION} this build writes — refusing to open a store whose layout this build cannot know`,
      found,
    );
  }
  if (found < LEDGER_FORMAT_VERSION) {
    throw new LedgerFormatError(
      "older-format",
      filePath,
      `acceptance-ledger: ${filePath} was written with ledger format ${found}, and this build registers no migration to ${LEDGER_FORMAT_VERSION} — refusing to downgrade or recreate the store`,
      found,
    );
  }
}

// ── Read-only access ────────────────────────────────────────────────────────

/**
 * The READ-ONLY half of the acceptance ledger: exactly the reads a consumer
 * that must not change the store needs.
 *
 * It is a distinct type rather than a flag on {@link AcceptanceLedger} so a
 * read-only consumer (the drain audit) cannot reach a write at all: the handle
 * a read-only open answers is typed as this, and the connection underneath
 * refuses a write at the SQLite layer as well. Both halves of that are the
 * point — the type says what the caller may do, the connection says what the
 * process may do.
 *
 * {@link SqliteAcceptanceLedger} satisfies it structurally, so one
 * implementation serves both surfaces and the read rules cannot drift.
 */
export interface AcceptanceLedgerReader {
  /** The persisted state snapshot of one graph, or `undefined`. */
  readGraphState(graphId: string): GraphStateRecord | undefined;
  /** The effects of one graph still `pending` or `started`. */
  pendingEffects(graphId: string): readonly PendingEffectRecord[];
  /** Close the substrate. Idempotent. */
  close(): void;
}

/**
 * What {@link SqliteAcceptanceLedger.openReadOnly} produced.
 *
 * TOTAL: every way an existing ledger can fail to be readable is a value, never
 * a throw, because the audit this serves must report an unreadable store as a
 * BLOCKER instead of crashing on it. An ABSENT store (no file at all) is
 * deliberately its own kind: it is not an unreadable record, and a read-only
 * open must never create the file that would turn it into one.
 */
export type LedgerReadOpenResult =
  | {
      readonly kind: "opened";
      readonly filePath: string;
      readonly ledger: AcceptanceLedgerReader;
    }
  /** No ledger file exists — nothing has ever been committed here. */
  | { readonly kind: "absent"; readonly filePath: string }
  /**
   * The file exists and is a SQLite store, but not one this build may read:
   * unknown / newer / older format, a foreign store, or a reshaped layout. The
   * file is left exactly as it was found.
   */
  | {
      readonly kind: "refused";
      readonly filePath: string;
      readonly problem: LedgerFormatProblem;
      readonly message: string;
    }
  /** The file exists but could not be opened or read (I/O, permissions, …). */
  | { readonly kind: "unreadable"; readonly filePath: string; readonly reason: string };

// ── The store ───────────────────────────────────────────────────────────────

/**
 * The durable acceptance ledger over the portable SQLite driver.
 *
 * Build one with {@link SqliteAcceptanceLedger.create}, which opens the file in
 * the directory it is given and runs the format gate — there is no module-level
 * connection and no singleton, so the substrate is injectable and a test owns
 * its own temp directory.
 */
export class SqliteAcceptanceLedger implements AcceptanceLedger {
  readonly ledgerFormatVersion: number = LEDGER_FORMAT_VERSION;

  private readonly db: DatabaseDriver;
  private readonly filePath: string;
  private closed = false;
  /** Transaction nesting depth; the write path wraps only at depth 0. */
  private depth = 0;

  private constructor(db: DatabaseDriver, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Open (or initialize) the ledger file in `directory`.
   *
   * A directory with no store gets the schema and its version row in one
   * transaction; an existing store is opened only when its format version is
   * exactly the one this build writes and every table's columns, affinities,
   * nullability and PRIMARY KEY are the ones this format writes. Every refusal
   * closes the handle and leaves the file untouched.
   */
  static async create(directory: string): Promise<SqliteAcceptanceLedger> {
    const filePath = ledgerFilePath(directory);
    mkdirSync(directory, { recursive: true });
    const db = await createDatabase(filePath);
    try {
      return SqliteAcceptanceLedger.openVerified(db, filePath, true);
    } catch (error) {
      closeQuietly(db);
      throw error;
    }
  }

  /**
   * Open an EXISTING ledger READ-ONLY, or report why it cannot be read.
   *
   * The audit's entry point, and deliberately NOT a variant of {@link create}:
   * nothing here may change the store. The directory is not created, the file
   * is not created, the schema is never initialized, and the connection is
   * opened read-only, so a write attempted later fails at the SQLite layer
   * instead of landing. A store that does not exist answers `absent` — the
   * honest reading of "nothing has been committed here", and never a licence to
   * initialize one.
   *
   * An existing file passes the SAME format gate the read/write opener applies
   * (version identity first, then every table's columns, affinities,
   * nullability and PRIMARY KEY), and a refusal is returned as data, with the
   * file left exactly as it was found. TOTAL: a throwing open or an unexpected
   * failure is `unreadable` rather than an exception, because the audit must
   * report such a store as a blocker instead of crashing on it.
   *
   * A WAL-MODE STORE IS REFUSED BEFORE ANY CONNECTION EXISTS. A read-only
   * SQLite open of a WAL database still attaches to — and rewrites — its
   * `-shm` shared-memory side file, so reading one would change the store this
   * open promises not to touch. {@link isWalStore} decides the journal mode
   * from the file header, which is a plain read; the store and its side files
   * are left exactly as found, and the refusal is the named problem
   * `wal-journal-mode`.
   */
  static async openReadOnly(directory: string): Promise<LedgerReadOpenResult> {
    const filePath = ledgerFilePath(directory);
    if (!existsSync(filePath)) return { kind: "absent", filePath };

    if (isWalStore(filePath)) {
      return {
        kind: "refused",
        filePath,
        problem: "wal-journal-mode",
        message:
          `acceptance-ledger: ${filePath} is a WAL-mode SQLite store; a ` +
          "read-only open would attach to and rewrite its -shm side file, so " +
          "this build refuses to read it rather than change the store it reads",
      };
    }

    let db: DatabaseDriver;
    try {
      db = await createDatabase(filePath, { readonly: true });
    } catch (error) {
      return { kind: "unreadable", filePath, reason: errorText(error) };
    }
    try {
      return {
        kind: "opened",
        filePath,
        ledger: SqliteAcceptanceLedger.openVerified(db, filePath, false),
      };
    } catch (error) {
      closeQuietly(db);
      if (error instanceof LedgerFormatError) {
        return {
          kind: "refused",
          filePath,
          problem: error.problem,
          message: error.message,
        };
      }
      return { kind: "unreadable", filePath, reason: errorText(error) };
    }
  }

  /**
   * The open-time format gate, shared by both openers.
   *
   * `initialize` is true only for {@link create}: a file holding no user tables
   * is then a fresh store that gets the schema and its version row in one
   * transaction. The read-only opener passes false, so an empty file — a file
   * that is not this ledger — is refused instead of being turned into one by a
   * read. Every check below is READ-ONLY; the only write in this method is the
   * initialization `create` explicitly asked for.
   */
  private static openVerified(
    db: DatabaseDriver,
    filePath: string,
    initialize: boolean,
  ): SqliteAcceptanceLedger {
    const tables = inspectTables(db, filePath);
    if (tables.length === 0) {
      if (!initialize) {
        throw new LedgerFormatError(
          "foreign-store",
          filePath,
          `acceptance-ledger: ${filePath} holds no tables, so it is not a ledger this build wrote — a read-only open never initializes a store`,
          tables,
        );
      }
      initializeLedger(db);
      return new SqliteAcceptanceLedger(db, filePath);
    }
    if (!tables.includes(LEDGER_TABLES.meta)) {
      throw new LedgerFormatError(
        "foreign-store",
        filePath,
        `acceptance-ledger: ${filePath} is not this ledger — it holds ${tables.join(", ")} and no ${LEDGER_TABLES.meta} table, and refusing is the only honest answer to a file whose contents this build cannot name`,
        tables,
      );
    }
    // Identity first: the version row must be READABLE and name exactly this
    // format before the layout it claims is judged, so a newer store is
    // refused as newer even when its own layout renames or drops tables.
    requireTableShape(db, "meta", filePath);
    requireFormatVersion(db, filePath);
    requireLedgerTables(tables, filePath);
    requireTableShape(db, "receipts", filePath);
    requireTableShape(db, "acceptedEvents", filePath);
    requireTableShape(db, "pendingEffects", filePath);
    requireTableShape(db, "graphState", filePath);
    return new SqliteAcceptanceLedger(db, filePath);
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  /**
   * Commit one acceptance batch atomically.
   *
   * The protocol rules are evaluated in this order — replay, conflict,
   * settled — and only a batch that clears all three reaches the write. The
   * write itself runs inside ONE transaction and the verdict is returned only
   * after that transaction committed; a refusal inside it propagates as a
   * {@link LedgerWriteError} with nothing persisted.
   */
  commitAccepted(batch: AcceptanceBatch): CommitResult {
    this.assertOpen("commitAccepted");
    assertBatchShape(batch);
    const receipt = batch.receipt;

    const existing = this.selectReceipt(receipt);
    if (existing !== undefined) {
      if (existing.proposalDigest === receipt.proposalDigest) {
        return { kind: "replayed", receipt: existing };
      }
      return {
        kind: "conflict",
        reason:
          `submission (graph ${receipt.graphId}, attempt ${receipt.attemptId}, submission ${receipt.submissionId}) ` +
          `is already committed with proposal digest ${existing.proposalDigest}, and this batch carries ${receipt.proposalDigest} — ` +
          "a submission key is bound to the proposal committed under it, and nothing was written",
      };
    }

    const settlement = this.selectAcceptedEvent(
      receipt.graphId,
      receipt.attemptId,
    );
    if (settlement !== undefined) {
      return {
        kind: "settled",
        reason:
          `attempt ${receipt.attemptId} of graph ${receipt.graphId} already settled on submission ${settlement.submissionId} ` +
          `with outcome ${settlement.outcomeId} — a distinct terminal submission is refused and nothing was written`,
      };
    }

    const write = (): CommitResult => {
      this.writeBatch(batch);
      return { kind: "committed", receipt };
    };
    // A commit issued inside a caller's transaction joins it: opening a second
    // transaction here would either be refused by the driver or, worse, commit
    // the batch before the caller's other writes did.
    if (this.depth > 0) return write();
    return this.inTransaction(write);
  }

  /**
   * Write the receipt, the accepted event and every pending effect.
   *
   * Called ONLY from inside a transaction (or a caller's transaction at depth >
   * 0). The catch turns a driver-level rejection into the typed error the
   * caller sees, and — because the throw crosses the driver's transaction
   * boundary — into the rollback of every row this batch already wrote.
   */
  private writeBatch(batch: AcceptanceBatch): void {
    try {
      const receipt = batch.receipt;
      this.db.run(
        `INSERT INTO ${LEDGER_TABLES.receipts}
           (graph_id, attempt_id, submission_id, plan_revision, proposal_digest, decision, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        receipt.graphId,
        receipt.attemptId,
        receipt.submissionId,
        receipt.planRevision,
        receipt.proposalDigest,
        receipt.decision,
        receipt.committedAt,
      );
      const event = batch.acceptedEvent;
      if (event !== undefined) {
        this.db.run(
          `INSERT INTO ${LEDGER_TABLES.acceptedEvents}
             (graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          event.graphId,
          event.attemptId,
          event.submissionId,
          event.planRevision,
          event.outcomeId,
          event.acceptedAt,
        );
      }
      for (const effect of batch.effects ?? []) {
        this.db.run(
          `INSERT INTO ${LEDGER_TABLES.pendingEffects}
             (graph_id, effect_id, attempt_id, kind, payload, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          effect.graphId,
          effect.effectId,
          effect.attemptId,
          effect.kind,
          encodePayload(effect.payload, effect.effectId),
          effect.createdAt,
          effect.status,
        );
      }
    } catch (error) {
      if (error instanceof LedgerWriteError) throw error;
      throw new LedgerWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected a row of the batch for graph ${batch.receipt.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from this batch was committed`,
      );
    }
  }

  // ── Graph state ───────────────────────────────────────────────────────────

  /**
   * The persisted state snapshot of one graph, or `undefined`.
   *
   * Inside a caller's transaction this reads the transaction's own uncommitted
   * snapshot, which is what lets a reducer derive the next state from the state
   * the acceptance is actually committing against.
   */
  readGraphState(graphId: string): GraphStateRecord | undefined {
    this.assertOpen("readGraphState");
    return this.selectGraphState(graphId);
  }

  /**
   * Write (or replace) one graph's state snapshot.
   *
   * The record is validated, the body is encoded, its encoded size is checked
   * against {@link GRAPH_STATE_MAX_BYTES}, and only then is the row written —
   * all inside whatever transaction the caller has open, so a body that cannot
   * be stored rolls back the receipt, the accepted event and the pending effects
   * that were written before it. A store-level rejection becomes the typed
   * error the caller sees and, because the throw crosses the driver's
   * transaction boundary, the rollback that makes "never a half-committed
   * batch" true rather than intended.
   */
  writeGraphState(record: GraphStateRecord): void {
    this.assertOpen("writeGraphState");
    assertGraphStateShape(record);
    try {
      this.db.run(
        `INSERT INTO ${LEDGER_TABLES.graphState}
           (graph_id, plan_revision, body, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(graph_id) DO UPDATE SET
           plan_revision = excluded.plan_revision,
           body = excluded.body,
           updated_at = excluded.updated_at`,
        record.graphId,
        record.planRevision,
        encodeStateBody(record.body, record.graphId),
        record.updatedAt,
      );
    } catch (error) {
      if (error instanceof LedgerWriteError) throw error;
      throw new LedgerWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected the state snapshot of graph ${record.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from it was committed`,
      );
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined {
    this.assertOpen("lookupReceipt");
    return this.selectReceipt(key);
  }

  acceptedEvents(graphId: string): readonly AcceptedEventRecord[] {
    this.assertOpen("acceptedEvents");
    const rows = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at
         FROM ${LEDGER_TABLES.acceptedEvents}
         WHERE graph_id = ?
         ORDER BY accepted_at, attempt_id`,
      )
      .all(graphId);
    return rows.map((row) =>
      toAcceptedEvent(asRow(row, this.filePath, LEDGER_TABLES.acceptedEvents), this.filePath),
    );
  }

  /**
   * The UNSETTLED effects of one graph: rows still `pending` or `started`.
   *
   * Terminal effects are not listed — a settled effect must never be resumed —
   * and the listing survives a restart because it is a read, which IS the
   * resume path for a process that died between the commit and the work.
   */
  pendingEffects(graphId: string): readonly PendingEffectRecord[] {
    this.assertOpen("pendingEffects");
    const rows = this.db
      .query(
        `SELECT graph_id, effect_id, attempt_id, kind, payload, created_at, status
         FROM ${LEDGER_TABLES.pendingEffects}
         WHERE graph_id = ? AND status IN ('pending', 'started')
         ORDER BY created_at, effect_id`,
      )
      .all(graphId);
    return rows.map((row) =>
      toPendingEffect(asRow(row, this.filePath, LEDGER_TABLES.pendingEffects), this.filePath),
    );
  }

  // ── Effect lifecycle ──────────────────────────────────────────────────────

  markEffectStarted(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "started", "markEffectStarted");
  }

  markEffectDone(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "done", "markEffectDone");
  }

  markEffectFailed(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "failed", "markEffectFailed");
  }

  /**
   * Move one effect to `next`.
   *
   * The read decides the verdict; the UPDATE repeats the terminal guard in its
   * own WHERE clause, so a row that settled between the two statements is never
   * rewritten even though this store assumes the single-writer discipline of a
   * local file.
   */
  private transitionEffect(
    graphId: string,
    effectId: string,
    next: EffectStatus,
    operation: string,
  ): EffectTransition {
    this.assertOpen(operation);
    const current = this.selectEffect(graphId, effectId);
    if (current === undefined) {
      return {
        kind: "missing",
        reason: `graph ${graphId} holds no effect ${effectId} — nothing was written`,
      };
    }
    if (current.status === next) {
      return { kind: "unchanged", effect: current };
    }
    if (current.status === "done" || current.status === "failed") {
      return {
        kind: "refused",
        reason:
          `effect ${effectId} of graph ${graphId} is ${current.status} and terminal — a settled effect is never rewound to ${next}; ` +
          "new work gets a new effect id, and nothing was written",
        effect: current,
      };
    }
    this.db.run(
      `UPDATE ${LEDGER_TABLES.pendingEffects}
       SET status = ?
       WHERE graph_id = ? AND effect_id = ? AND status NOT IN ('done', 'failed') AND status <> ?`,
      next,
      graphId,
      effectId,
      next,
    );
    return { kind: "transitioned", effect: { ...current, status: next } };
  }

  // ── Transaction extension point ───────────────────────────────────────────

  /**
   * Run `fn` inside ONE transaction and return its result after COMMIT.
   *
   * The callback receives the ledger's full read/write surface, so a reducer
   * can write engine state and commit an acceptance batch in the same
   * transaction. It MUST be synchronous and it must not call
   * `runInTransaction` again: the driver's transaction commits synchronously,
   * so an async callback would run its writes outside the boundary, and a
   * nested transaction would silently become a savepoint with a different
   * rollback scope. Both are refused by name.
   */
  runInTransaction<R>(fn: (tx: AcceptanceLedgerTx) => R): R {
    this.assertOpen("runInTransaction");
    if (this.depth > 0) {
      throw new LedgerWriteError(
        "nested-transaction",
        "acceptance-ledger: runInTransaction is not re-entrant — the acceptance boundary is ONE transaction, and a nested call is refused rather than silently becoming a savepoint whose rollback scope differs",
      );
    }
    return this.inTransaction(() => {
      const result = fn(this.transactionView());
      if (isThenable(result)) {
        throw new LedgerWriteError(
          "async-transaction",
          "acceptance-ledger: the runInTransaction callback returned a promise — the transaction commits synchronously, so an async callback would run its writes OUTSIDE the atomic boundary; pass a synchronous callback",
        );
      }
      return result;
    });
  }

  /** Wrap one synchronous callback in the driver's transaction. */
  private inTransaction<R>(work: () => R): R {
    this.depth += 1;
    try {
      return this.db.transaction(work)();
    } finally {
      this.depth -= 1;
    }
  }

  /** The write surface a transaction callback receives. */
  private transactionView(): AcceptanceLedgerTx {
    return Object.freeze({
      commitAccepted: (batch: AcceptanceBatch): CommitResult =>
        this.commitAccepted(batch),
      readGraphState: (graphId: string): GraphStateRecord | undefined =>
        this.readGraphState(graphId),
      writeGraphState: (record: GraphStateRecord): void =>
        this.writeGraphState(record),
      lookupReceipt: (key: SubmissionKey): ReceiptRecord | undefined =>
        this.lookupReceipt(key),
      acceptedEvents: (graphId: string): readonly AcceptedEventRecord[] =>
        this.acceptedEvents(graphId),
      pendingEffects: (graphId: string): readonly PendingEffectRecord[] =>
        this.pendingEffects(graphId),
      markEffectStarted: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectStarted(graphId, effectId),
      markEffectDone: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectDone(graphId, effectId),
      markEffectFailed: (graphId: string, effectId: string): EffectTransition =>
        this.markEffectFailed(graphId, effectId),
    });
  }

  // ── Selection helpers (no open check: every caller checked first) ─────────

  private selectReceipt(key: SubmissionKey): ReceiptRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, proposal_digest, decision, committed_at
         FROM ${LEDGER_TABLES.receipts}
         WHERE graph_id = ? AND attempt_id = ? AND submission_id = ?`,
      )
      .get(key.graphId, key.attemptId, key.submissionId);
    if (isNoRow(row)) return undefined;
    return toReceipt(asRow(row, this.filePath, LEDGER_TABLES.receipts), this.filePath);
  }

  private selectGraphState(graphId: string): GraphStateRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, plan_revision, body, updated_at
         FROM ${LEDGER_TABLES.graphState}
         WHERE graph_id = ?`,
      )
      .get(graphId);
    if (isNoRow(row)) return undefined;
    return toGraphState(
      asRow(row, this.filePath, LEDGER_TABLES.graphState),
      this.filePath,
    );
  }

  private selectAcceptedEvent(
    graphId: string,
    attemptId: string,
  ): AcceptedEventRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at
         FROM ${LEDGER_TABLES.acceptedEvents}
         WHERE graph_id = ? AND attempt_id = ?`,
      )
      .get(graphId, attemptId);
    if (isNoRow(row)) return undefined;
    return toAcceptedEvent(
      asRow(row, this.filePath, LEDGER_TABLES.acceptedEvents),
      this.filePath,
    );
  }

  private selectEffect(
    graphId: string,
    effectId: string,
  ): PendingEffectRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, effect_id, attempt_id, kind, payload, created_at, status
         FROM ${LEDGER_TABLES.pendingEffects}
         WHERE graph_id = ? AND effect_id = ?`,
      )
      .get(graphId, effectId);
    if (isNoRow(row)) return undefined;
    return toPendingEffect(
      asRow(row, this.filePath, LEDGER_TABLES.pendingEffects),
      this.filePath,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Refuse any use of a closed ledger with a clear, typed error. */
  private assertOpen(operation: string): void {
    if (this.closed) throw new LedgerClosedError(operation);
  }

  /** Close the connection. Idempotent; a second close is a no-op. */
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
