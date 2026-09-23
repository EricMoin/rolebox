/**
 * Graph store — the acceptance-ledger tables of the unified store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * The ledger's own record model, its protocol rules and its SQL, moved out of
 * `src/graph/ledger/sqlite-ledger.ts` and onto the ONE connection the converged
 * store owns. Nothing about the rules changed: this is the same replay /
 * conflict / settled evaluation, the same receipt/event/effect/graph-state
 * writes, the same JSON representability and size gates, and the same
 * conditional effect transitions — the module seam moved so a host binding can
 * be written in the SAME transaction as the acceptance that authorizes it.
 *
 * CONTROL IS NOT OUTCOME, AND BOTH DIRECTIONS ARE STRUCTURAL (P3 item 1). The
 * control write is conditional on the attempt having no accepted event; this
 * side's acceptance is conditional on the RUN having no control fact. Both are
 * evaluated against the COMMITTED store inside the committing transaction, so
 * whichever COMMITS first is the fact that stands and the loser writes nothing —
 * one attempt can never carry both an accepted event and a control decision.
 *
 * ATOMICITY IS STILL THE POINT. `commitAccepted` evaluates the rules and then
 * writes the receipt, the accepted event, the accepted result and every pending
 * effect inside ONE transaction that COMMITS before the verdict is returned. A
 * constraint violation, an unrepresentable payload or an oversized state body
 * throws and the transaction ROLLS BACK: nothing from that batch is persisted,
 * and `committed` is never reported for an uncommitted batch.
 *
 * THE TRANSACTION IS THE STORE'S. This class never opens one: it receives a
 * `join` callback that runs work inside the caller's open transaction when
 * there is one and opens the single transaction otherwise. That is what makes
 * "commitAccepted issued inside a caller's `runInTransaction` joins it"
 * structural rather than a convention — opening a second transaction there
 * would either be refused by the driver or, worse, commit the batch before the
 * caller's other writes did.
 */

import type { DatabaseDriver } from "../../memory/db-driver.ts";
import { errorText } from "../../utils/error-text.ts";
import {
  type AcceptedEventRecord,
  type CommitResult,
  type EffectStatus,
  type EffectTransition,
  type GraphStateRecord,
  type PendingEffectRecord,
  type ReceiptRecord,
  type RunControlRecord,
  type SubmissionKey,
} from "../ledger/types.ts";
import { GraphStoreWriteError } from "./errors.ts";
import { encodeJsonBody, encodePayload, encodeStateBody } from "./json.ts";
import { malformedRow } from "./format.ts";
import { GRAPH_STORE_TABLES } from "./schema.ts";
import type { AcceptedResultRecord, GraphAcceptanceBatch } from "./records.ts";

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
    GRAPH_STORE_TABLES.receipts,
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
    GRAPH_STORE_TABLES.pendingEffects,
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
  return readJsonBody(row, "payload", path, GRAPH_STORE_TABLES.pendingEffects);
}

function toReceipt(
  row: Record<string, unknown>,
  path: string,
): ReceiptRecord {
  const table = GRAPH_STORE_TABLES.receipts;
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
  const table = GRAPH_STORE_TABLES.acceptedEvents;
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
  const table = GRAPH_STORE_TABLES.graphState;
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
  const table = GRAPH_STORE_TABLES.pendingEffects;
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

function toAcceptedResult(
  row: Record<string, unknown>,
  path: string,
): AcceptedResultRecord {
  const table = GRAPH_STORE_TABLES.acceptedResults;
  return {
    graphId: readText(row, "graph_id", path, table),
    attemptId: readText(row, "attempt_id", path, table),
    planRevision: readText(row, "plan_revision", path, table),
    payload: readJsonBody(row, "payload", path, table),
    acceptedAt: readEpoch(row, "accepted_at", path, table),
  };
}

// ── Batch validation ────────────────────────────────────────────────────────
//
// The JSON representability and size gates this file applies live in
// `json.ts`; the batch rules below are the port's own record model.

/** Refuse a field that is not a non-empty identifier. */
function requireIdentifier(
  value: unknown,
  field: string,
  problem: "invalid-batch" | "invalid-graph-state" | "invalid-effect" | "invalid-record" = "invalid-batch",
  consequence = "the batch was not written",
): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphStoreWriteError(
      problem,
      `acceptance-ledger: ${field} is ${describeValue(value)}, not a non-empty identifier — ${consequence}`,
    );
  }
}

/** Refuse a timestamp that is not epoch milliseconds. */
function requireEpoch(
  value: unknown,
  field: string,
  problem: "invalid-batch" | "invalid-graph-state" | "invalid-effect" | "invalid-record" = "invalid-batch",
  consequence = "the batch was not written",
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GraphStoreWriteError(
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

/**
 * Validate one standalone effect record before it is stored as an INTENT.
 *
 * The record model is the port's, and the status rule is the batch's: an intent
 * write records work that has NOT begun, so a record that arrives `started` or
 * terminal is refused rather than stored — a caller that wants a transition
 * uses `markEffectStarted` / `markEffectDone` / `markEffectFailed`, which
 * carry the terminal guard this write deliberately does not have.
 */
function assertEffectShape(record: PendingEffectRecord): void {
  requireIdentifier(
    record.graphId,
    "effect.graphId",
    "invalid-effect",
    "the effect was not written",
  );
  requireIdentifier(
    record.effectId,
    "effect.effectId",
    "invalid-effect",
    "the effect was not written",
  );
  requireIdentifier(
    record.attemptId,
    "effect.attemptId",
    "invalid-effect",
    "the effect was not written",
  );
  requireIdentifier(
    record.kind,
    "effect.kind",
    "invalid-effect",
    "the effect was not written",
  );
  requireEpoch(
    record.createdAt,
    "effect.createdAt",
    "invalid-effect",
    "the effect was not written",
  );
  if (record.status !== "pending") {
    throw new GraphStoreWriteError(
      "invalid-effect",
      `acceptance-ledger: effect ${record.effectId} was offered as ${describeValue(record.status)} — an intent write records work that has not begun, so only a "pending" effect may be written here; a started or terminal effect is a transition, not an intent`,
    );
  }
}

/** Refuse a batch field that disagrees with the receipt it must describe. */
function requireSame(value: unknown, expected: string, field: string): void {
  if (value !== expected) {
    throw new GraphStoreWriteError(
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
function assertBatchShape(batch: GraphAcceptanceBatch): void {
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
    throw new GraphStoreWriteError(
      "invalid-batch",
      `acceptance-ledger: receipt.decision is ${describeValue(receipt.decision)}, not "accepted" or "rejected" — the batch was not written`,
    );
  }

  const event = batch.acceptedEvent;
  if (decision === "accepted" && event === undefined) {
    throw new GraphStoreWriteError(
      "invalid-batch",
      "acceptance-ledger: an accepted decision requires the accepted event it settles — a receipt without a settlement would record a decision while leaving the attempt open, so the batch was not written",
    );
  }
  if (decision === "rejected" && event !== undefined) {
    throw new GraphStoreWriteError(
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

  // THE ACCEPTED RESULT ENTERS THE SAME BATCH under the same rule: only an
  // accepted decision has one, and it describes exactly the submission the
  // receipt names — otherwise a receipt and a result could commit for
  // different attempts in one transaction.
  const result = batch.acceptedResult;
  if (result !== undefined) {
    if (decision !== "accepted") {
      throw new GraphStoreWriteError(
        "invalid-batch",
        `acceptance-ledger: attempt ${receipt.attemptId} carries a rejected decision AND an accepted result — a rejected proposal stores no result, so the batch was not written`,
      );
    }
    requireIdentifier(result.graphId, "acceptedResult.graphId");
    requireIdentifier(result.attemptId, "acceptedResult.attemptId");
    requireIdentifier(result.planRevision, "acceptedResult.planRevision");
    requireEpoch(result.acceptedAt, "acceptedResult.acceptedAt");
    requireSame(result.graphId, receipt.graphId, "acceptedResult.graphId");
    requireSame(result.attemptId, receipt.attemptId, "acceptedResult.attemptId");
    requireSame(
      result.planRevision,
      receipt.planRevision,
      "acceptedResult.planRevision",
    );
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
      throw new GraphStoreWriteError(
        "invalid-batch",
        `acceptance-ledger: effect ${effect.effectId} enters the batch as ${describeValue(effect.status)} — an acceptance batch writes PENDING effects only; a started or terminal effect is a transition, not part of the commit`,
      );
    }
  }
}

/**
 * The `controlled` verdict for one run-control fact.
 *
 * ONE owner of the wording, so the fast-path read and the atomic guard's
 * post-refusal classification refuse a batch in the same words and a caller
 * cannot tell which of the two answered.
 */
function controlledVerdict(control: RunControlRecord): CommitResult {
  return {
    kind: "controlled",
    control,
    reason:
      `run ${control.runId} of graph ${control.graphId} was stopped by the trusted control command ` +
      `${control.command} (${control.reason}) before this submission committed — a controlled run ` +
      "accepts nothing, so no receipt, accepted event, state advance or successor effect was written",
  };
}

// ── The tables ──────────────────────────────────────────────────────────────

/**
 * The acceptance-ledger tables ON the unified store's connection.
 *
 * One instance per store. Every method is synchronous (the driver's
 * transaction commits synchronously) and every compound write goes through
 * `join`, which opens the single transaction only when the caller has none.
 */
export class LedgerTables {
  private readonly db: DatabaseDriver;
  private readonly filePath: string;
  private readonly join: <R>(work: () => R) => R;
  /**
   * The graph's RUN-LEVEL control fact, read through the store that owns the
   * run tables. Injected rather than re-queried here so the SQL of
   * `graph_runs` keeps ONE owner and this class only asks the question it
   * needs answered inside the acceptance transaction (P3 item 1).
   */
  private readonly readRunControl: (graphId: string) => RunControlRecord | undefined;

  constructor(
    db: DatabaseDriver,
    filePath: string,
    join: <R>(work: () => R) => R,
    readRunControl: (graphId: string) => RunControlRecord | undefined,
  ) {
    this.db = db;
    this.filePath = filePath;
    this.join = join;
    this.readRunControl = readRunControl;
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  /**
   * Commit one acceptance batch atomically.
   *
   * The protocol rules are evaluated in this order — replay, conflict,
   * settled, controlled — and only a batch that clears all four reaches the
   * write. The write itself runs inside ONE transaction and the verdict is
   * returned only after that transaction committed; a refusal inside it
   * propagates as a {@link GraphStoreWriteError} with nothing persisted.
   */
  commitAccepted(batch: GraphAcceptanceBatch): CommitResult {
    assertBatchShape(batch);
    const receipt = batch.receipt;

    const existing = this.lookupReceipt(receipt);
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

    // CONTROL IS NOT OUTCOME (P3 item 1, plan §3.4). An acceptance for a run a
    // trusted command STOPPED commits nothing. This read is the FAST PATH: a
    // run already known to carry a control fact refuses the batch without
    // opening a write transaction, and a control fact is never cleared, so its
    // verdict cannot go stale. It is NOT the guarantee — the authoritative
    // check is the FIRST STATEMENT of the batch write below, inside the same
    // atomic boundary as the rows it guards (see {@link writeBatch}).
    const control = this.readRunControl(receipt.graphId);
    if (control !== undefined) return controlledVerdict(control);

    const write = (): CommitResult => {
      if (!this.writeBatch(batch)) {
        // THE GUARD REFUSED THE BATCH: the run carried no control fact when the
        // fast path read it, and the guarded write found one — a command
        // committed in that window. The verdict is classified from the
        // COMMITTED store (the fact this transaction can see), never assumed
        // from the refusal, and NOTHING of the batch was written.
        const raced = this.readRunControl(receipt.graphId);
        if (raced === undefined) {
          throw new GraphStoreWriteError(
            "invalid-record",
            "acceptance-ledger: the batch write for graph " +
              JSON.stringify(receipt.graphId) +
              " was refused by the run-control guard, but the store holds no control fact " +
              "for that graph — the guarded write and the store disagree, so the batch was " +
              "rolled back and no verdict is reported",
          );
        }
        return controlledVerdict(raced);
      }
      return { kind: "committed", receipt };
    };
    // A commit issued inside a caller's transaction joins it: opening a second
    // transaction here would either be refused by the driver or, worse, commit
    // the batch before the caller's other writes did.
    return this.join(write);
  }

  /**
   * Write the receipt, the accepted event, the accepted result and every
   * pending effect — and answer whether the batch actually landed.
   *
   * THE RUN-CONTROL GUARD IS THE FIRST STATEMENT (P3 item 1, plan §3.4). The
   * receipt INSERT carries its own
   * `WHERE NOT EXISTS (graph_runs.control_command IS NOT NULL)`, so it decides
   * against the COMMITTED STORE at the moment of the write rather than against
   * the value the fast path read earlier — the structural twin of the control
   * write's conditional `INSERT ... WHERE NOT EXISTS (accepted event)`.
   * Whichever of an acceptance and a control command COMMITS first is therefore
   * the fact that stands, and the loser writes NOTHING; a batch that carries a
   * receipt is never one whose run is stopped.
   *
   * BEING FIRST IS ALSO WHAT MAKES THE RACE A WAIT. A write statement takes
   * SQLite's RESERVED lock immediately, so a racing control writer WAITS on
   * `busy_timeout` instead of failing the shared-to-reserved lock PROMOTION a
   * read-then-write shape produces (the "database is locked" failure P3 solved
   * for the control path). The guard is never evaluated by a separate SELECT:
   * a read here would take the lock first and reintroduce exactly that failure.
   *
   * `false` means the guard matched no row and NOTHING was written — not a
   * partial batch, because the receipt is the batch's first row. The caller
   * then classifies the refusal from the committed store; it is never assumed.
   * Called ONLY from inside a transaction. The catch turns a driver-level
   * rejection into the typed error the caller sees, and — because the throw
   * crosses the driver's transaction boundary — into the rollback of every row
   * this batch already wrote.
   */
  private writeBatch(batch: GraphAcceptanceBatch): boolean {
    try {
      const receipt = batch.receipt;
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.receipts}
           (graph_id, attempt_id, submission_id, plan_revision, proposal_digest, decision, committed_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${GRAPH_STORE_TABLES.runs}
           WHERE graph_id = ? AND control_command IS NOT NULL
         )`,
        receipt.graphId,
        receipt.attemptId,
        receipt.submissionId,
        receipt.planRevision,
        receipt.proposalDigest,
        receipt.decision,
        receipt.committedAt,
        receipt.graphId,
      );
      // A conditional INSERT that matched nothing changed no row. A PRIMARY KEY
      // violation is NOT this case: the guard passing means the row was
      // selected, and a duplicate key throws and rolls the batch back instead.
      if (this.changes() === 0) return false;
      const event = batch.acceptedEvent;
      if (event !== undefined) {
        this.db.run(
          `INSERT INTO ${GRAPH_STORE_TABLES.acceptedEvents}
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
      const result = batch.acceptedResult;
      if (result !== undefined) {
        this.writeAcceptedResult(result);
      }
      for (const effect of batch.effects ?? []) {
        this.db.run(
          `INSERT INTO ${GRAPH_STORE_TABLES.pendingEffects}
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
      return true;
    } catch (error) {
      if (error instanceof GraphStoreWriteError) throw error;
      throw new GraphStoreWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected a row of the batch for graph ${batch.receipt.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from this batch was committed`,
      );
    }
  }

  /**
   * How many rows the statement just executed on this connection changed.
   *
   * Read from the connection itself (`SELECT changes()`), exactly as the store's
   * own conditional writes do, so a guarded INSERT that matched no row is
   * distinguishable from one that landed. An answer that is not a number is
   * REFUSED rather than defaulted to 0: 0 means "the guard refused the batch",
   * and inventing that verdict from an unreadable counter would report a
   * controlled run where the batch simply did not commit.
   */
  private changes(): number {
    const row = this.db.query("SELECT changes() AS changed").get();
    const value =
      typeof row === "object" && row !== null && !Array.isArray(row)
        ? (row as Record<string, unknown>)["changed"]
        : undefined;
    if (typeof value !== "number") {
      throw new GraphStoreWriteError(
        "invalid-record",
        "acceptance-ledger: the store did not answer how many rows the guarded batch write changed, so whether the batch landed cannot be established and no verdict is reported",
      );
    }
    return value;
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
    const row = this.db
      .query(
        `SELECT graph_id, plan_revision, body, updated_at
         FROM ${GRAPH_STORE_TABLES.graphState}
         WHERE graph_id = ?`,
      )
      .get(graphId);
    if (isNoRow(row)) return undefined;
    return toGraphState(
      asRow(row, this.filePath, GRAPH_STORE_TABLES.graphState),
      this.filePath,
    );
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
    assertGraphStateShape(record);
    try {
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.graphState}
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
      if (error instanceof GraphStoreWriteError) throw error;
      throw new GraphStoreWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected the state snapshot of graph ${record.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from it was committed`,
      );
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  lookupReceipt(key: SubmissionKey): ReceiptRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, proposal_digest, decision, committed_at
         FROM ${GRAPH_STORE_TABLES.receipts}
         WHERE graph_id = ? AND attempt_id = ? AND submission_id = ?`,
      )
      .get(key.graphId, key.attemptId, key.submissionId);
    if (isNoRow(row)) return undefined;
    return toReceipt(
      asRow(row, this.filePath, GRAPH_STORE_TABLES.receipts),
      this.filePath,
    );
  }

  acceptedEvents(graphId: string): readonly AcceptedEventRecord[] {
    const rows = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at
         FROM ${GRAPH_STORE_TABLES.acceptedEvents}
         WHERE graph_id = ?
         ORDER BY accepted_at, attempt_id`,
      )
      .all(graphId);
    return rows.map((row) =>
      toAcceptedEvent(
        asRow(row, this.filePath, GRAPH_STORE_TABLES.acceptedEvents),
        this.filePath,
      ),
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
    const rows = this.db
      .query(
        `SELECT graph_id, effect_id, attempt_id, kind, payload, created_at, status
         FROM ${GRAPH_STORE_TABLES.pendingEffects}
         WHERE graph_id = ? AND status IN ('pending', 'started')
         ORDER BY created_at, effect_id`,
      )
      .all(graphId);
    return rows.map((row) =>
      toPendingEffect(
        asRow(row, this.filePath, GRAPH_STORE_TABLES.pendingEffects),
        this.filePath,
      ),
    );
  }

  /**
   * Write one new effect as the durable intent of work this transaction is
   * about to do.
   *
   * `ON CONFLICT DO NOTHING` is the rule, not an optimization: an effect row is
   * a record of intent that a later transition ADVANCES, so a racing or
   * repeated writer must never move a `started` or terminal row back to
   * `pending`. The insert is validated and encoded exactly like the effects a
   * batch carries, so an unrepresentable payload fails the caller's whole
   * transaction instead of landing a half-written intent.
   */
  writeEffect(record: PendingEffectRecord): void {
    assertEffectShape(record);
    try {
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.pendingEffects}
           (graph_id, effect_id, attempt_id, kind, payload, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(graph_id, effect_id) DO NOTHING`,
        record.graphId,
        record.effectId,
        record.attemptId,
        record.kind,
        encodePayload(record.payload, record.effectId),
        record.createdAt,
        record.status,
      );
    } catch (error) {
      if (error instanceof GraphStoreWriteError) throw error;
      throw new GraphStoreWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected effect ${record.effectId} of graph ${record.graphId} (${errorText(error)}) — the transaction rolled back, so nothing from it was committed`,
      );
    }
  }

  // ── Accepted results ──────────────────────────────────────────────────────

  /**
   * Write one accepted result.
   *
   * `ON CONFLICT DO NOTHING` mirrors {@link writeEffect}: an accepted result is
   * written ONCE per attempt, and a racing writer must never overwrite the
   * payload an attempt already settled with. A write that lands nothing is not
   * an error — the settled result is immutable.
   */
  writeAcceptedResult(record: AcceptedResultRecord): void {
    requireIdentifier(
      record.graphId,
      "acceptedResult.graphId",
      "invalid-record",
      "the result was not written",
    );
    requireIdentifier(
      record.attemptId,
      "acceptedResult.attemptId",
      "invalid-record",
      "the result was not written",
    );
    requireIdentifier(
      record.planRevision,
      "acceptedResult.planRevision",
      "invalid-record",
      "the result was not written",
    );
    requireEpoch(
      record.acceptedAt,
      "acceptedResult.acceptedAt",
      "invalid-record",
      "the result was not written",
    );
    try {
      this.db.run(
        `INSERT INTO ${GRAPH_STORE_TABLES.acceptedResults}
           (graph_id, attempt_id, plan_revision, payload, accepted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(graph_id, attempt_id) DO NOTHING`,
        record.graphId,
        record.attemptId,
        record.planRevision,
        encodeJsonBody(
          record.payload,
          `the accepted result of attempt ${record.attemptId}`,
          "unrepresentable-record",
        ),
        record.acceptedAt,
      );
    } catch (error) {
      if (error instanceof GraphStoreWriteError) throw error;
      throw new GraphStoreWriteError(
        "write-rejected",
        `acceptance-ledger: the store rejected the accepted result of attempt ${record.attemptId} (${errorText(error)}) — the transaction rolled back, so nothing from it was committed`,
      );
    }
  }

  /** The accepted result of one settled attempt, or `undefined`. */
  readAcceptedResult(
    graphId: string,
    attemptId: string,
  ): AcceptedResultRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, attempt_id, plan_revision, payload, accepted_at
         FROM ${GRAPH_STORE_TABLES.acceptedResults}
         WHERE graph_id = ? AND attempt_id = ?`,
      )
      .get(graphId, attemptId);
    if (isNoRow(row)) return undefined;
    return toAcceptedResult(
      asRow(row, this.filePath, GRAPH_STORE_TABLES.acceptedResults),
      this.filePath,
    );
  }

  // ── Effect lifecycle ──────────────────────────────────────────────────────

  markEffectStarted(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "started");
  }

  markEffectDone(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "done");
  }

  markEffectFailed(graphId: string, effectId: string): EffectTransition {
    return this.transitionEffect(graphId, effectId, "failed");
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
  ): EffectTransition {
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
      `UPDATE ${GRAPH_STORE_TABLES.pendingEffects}
       SET status = ?
       WHERE graph_id = ? AND effect_id = ? AND status NOT IN ('done', 'failed') AND status <> ?`,
      next,
      graphId,
      effectId,
      next,
    );
    return { kind: "transitioned", effect: { ...current, status: next } };
  }

  // ── Selection helpers ─────────────────────────────────────────────────────

  private selectAcceptedEvent(
    graphId: string,
    attemptId: string,
  ): AcceptedEventRecord | undefined {
    const row = this.db
      .query(
        `SELECT graph_id, attempt_id, submission_id, plan_revision, outcome_id, accepted_at
         FROM ${GRAPH_STORE_TABLES.acceptedEvents}
         WHERE graph_id = ? AND attempt_id = ?`,
      )
      .get(graphId, attemptId);
    if (isNoRow(row)) return undefined;
    return toAcceptedEvent(
      asRow(row, this.filePath, GRAPH_STORE_TABLES.acceptedEvents),
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
         FROM ${GRAPH_STORE_TABLES.pendingEffects}
         WHERE graph_id = ? AND effect_id = ?`,
      )
      .get(graphId, effectId);
    if (isNoRow(row)) return undefined;
    return toPendingEffect(
      asRow(row, this.filePath, GRAPH_STORE_TABLES.pendingEffects),
      this.filePath,
    );
  }
}
