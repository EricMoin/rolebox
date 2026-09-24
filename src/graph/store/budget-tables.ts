import type { DatabaseDriver } from "../../memory/db-driver.ts";
import {
  type BudgetLimitKind,
  type BudgetUsageAmounts,
  type NodeBudgetLimits
} from "../domain/budget.ts";
import type {
  BudgetExhaustion,
  BudgetNodeUsage,
  BudgetReleaseInput,
  BudgetReleaseResult,
  BudgetReservationRecord,
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetUsageInput,
  BudgetUsageResult,
} from "../ledger/types.ts";
import { GraphStoreWriteError } from "./errors.ts";
import { malformedRow } from "./format.ts";
import { GRAPH_STORE_TABLES } from "./schema.ts";

/** The statuses a reservation row can carry, as the table's CHECK declares. */
const RESERVATION_STATUSES = ["reserved", "reconciled", "released"] as const;

/**
 * One limit dimension, as the three column families of the budget table.
 *
 * The column NAMES are the schema's, and the mapping from a declared ceiling to
 * a column is one list rather than four near-identical SQL statements: the
 * conditional write is generated from this list, so a dimension cannot be
 * enforced by one statement and silently skipped by another.
 */
interface BudgetDimension {
  readonly kind: BudgetLimitKind;
  readonly checkedColumn: string;
  readonly reservedColumn: string;
  readonly usedColumn: string;
  /** The ceiling for this dimension, or `undefined` when undeclared. */
  readonly limitOf: (limits: NodeBudgetLimits) => number | undefined;
}

const DIMENSIONS: readonly BudgetDimension[] = Object.freeze([
  {
    kind: "duration_ms" as const,
    checkedColumn: "checked_duration_ms",
    reservedColumn: "reserved_duration_ms",
    usedColumn: "used_duration_ms",
    limitOf: (limits: NodeBudgetLimits): number | undefined => limits.durationMs,
  },
  {
    kind: "input_tokens" as const,
    checkedColumn: "checked_input_tokens",
    reservedColumn: "reserved_input_tokens",
    usedColumn: "used_input_tokens",
    limitOf: (limits: NodeBudgetLimits): number | undefined => limits.inputTokens,
  },
  {
    kind: "output_tokens" as const,
    checkedColumn: "checked_output_tokens",
    reservedColumn: "reserved_output_tokens",
    usedColumn: "used_output_tokens",
    limitOf: (limits: NodeBudgetLimits): number | undefined => limits.outputTokens,
  },
  {
    kind: "cost_usd" as const,
    checkedColumn: "checked_cost_usd",
    reservedColumn: "reserved_cost_usd",
    usedColumn: "used_cost_usd",
    limitOf: (limits: NodeBudgetLimits): number | undefined => limits.costUsd,
  },
]);

/** The accounting fields of one usage reading, in the port's own names. */
type UsageField = keyof Omit<BudgetUsageAmounts, "executions">;

const USAGE_FIELDS: readonly {
  readonly field: UsageField;
  readonly limitKind: BudgetLimitKind;
}[] = Object.freeze([
  { field: "durationMs", limitKind: "duration_ms" },
  { field: "inputTokens", limitKind: "input_tokens" },
  { field: "outputTokens", limitKind: "output_tokens" },
  { field: "costUsd", limitKind: "cost_usd" },
]);

/** One column of the budget table, by dimension and family. */
function columnOf(kind: BudgetLimitKind, family: "reserved" | "used"): string {
  for (const dimension of DIMENSIONS) {
    if (dimension.kind !== kind) continue;
    return family === "reserved" ? dimension.reservedColumn : dimension.usedColumn;
  }
  throw new GraphStoreWriteError(
    "invalid-record",
    "graph-store: " + JSON.stringify(kind) + " is not an authorized budget dimension",
  );
}

/** Name what was received for a diagnostic, without throwing on the value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  return typeof value;
}

/** A non-empty identifier, or a refused write. */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: " +
      field +
      " is " +
      describeValue(value) +
      ", not a non-empty identifier — the budget row was refused and nothing was written",
    );
  }
  return value;
}

/** A non-negative safe integer, or a refused write. */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: " +
      field +
      " is " +
      describeValue(value) +
      ", not a non-negative safe integer — the budget row was refused and nothing was written",
    );
  }
  return value;
}

/** A finite non-negative number, or a refused write. */
function requireAmount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GraphStoreWriteError(
      "invalid-record",
      "graph-store: " +
      field +
      " is " +
      describeValue(value) +
      ", not a finite non-negative number — the budget row was refused and nothing was written",
    );
  }
  return value;
}

/** A declared ceiling: absent, or a finite non-negative number. */
function optionalAmount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireAmount(value, field);
}

// ── Row readers ─────────────────────────────────────────────────────────────

/** One row-shaped answer, or a refusal of what the driver returned instead. */
function asRow(value: unknown, filePath: string, table: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedRow(
      filePath,
      table,
      `the driver answered ${describeValue(value)} instead of a row`,
    );
  }
  return value as Record<string, unknown>;
}

/** One TEXT column as a non-empty string. */
function readText(
  row: Record<string, unknown>,
  column: string,
  filePath: string,
  table: string,
): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw malformedRow(
      filePath,
      table,
      `${column} is ${describeValue(value)}, not a non-empty string`,
    );
  }
  return value;
}

/** One INTEGER column as a non-negative safe integer. */
function readCount(
  row: Record<string, unknown>,
  column: string,
  filePath: string,
  table: string,
): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformedRow(
      filePath,
      table,
      `${column} is ${describeValue(value)}, not a non-negative safe integer`,
    );
  }
  return value;
}

/** One nullable numeric column: absent stays absent, a value must be finite. */
function readOptionalAmount(
  row: Record<string, unknown>,
  column: string,
  filePath: string,
  table: string,
): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw malformedRow(
      filePath,
      table,
      `${column} is ${describeValue(value)}, not a finite non-negative number`,
    );
  }
  return value;
}

/** One required numeric column. */
function readAmount(
  row: Record<string, unknown>,
  column: string,
  filePath: string,
  table: string,
): number {
  const value = readOptionalAmount(row, column, filePath, table);
  if (value === undefined) {
    throw malformedRow(filePath, table, `${column} is null where a value is required`);
  }
  return value;
}

// ── The tables ──────────────────────────────────────────────────────────────

/**
 * The dispatch budget rows of the workspace's ONE store.
 *
 * The class never opens a transaction: it receives the store's `join` callback,
 * so every read and write runs inside the caller's boundary when there is one
 * and inside the single boundary otherwise — the same rule `LedgerTables`
 * follows, for the same reason.
 */
export class BudgetTables {
  private readonly db: DatabaseDriver;
  private readonly filePath: string;
  private readonly join: <R>(work: () => R) => R;
  /**
   * The graph's CURRENT run id, read through the store that owns the run table.
   * An omitted `runId` means "the run this graph is executing now", and the
   * resolution happens INSIDE the reading or writing transaction so a row can
   * never be filed under a run the graph has moved past.
   */
  private readonly readCurrentRunId: (graphId: string) => string | undefined;

  constructor(
    db: DatabaseDriver,
    filePath: string,
    join: <R>(work: () => R) => R,
    readCurrentRunId: (graphId: string) => string | undefined,
  ) {
    this.db = db;
    this.filePath = filePath;
    this.join = join;
    this.readCurrentRunId = readCurrentRunId;
  }

  /** SQLite's own count of rows THIS connection's last statement changed. */
  private changes(): number {
    const row = asRow(
      this.db.query("SELECT changes() AS changed").get(),
      this.filePath,
      GRAPH_STORE_TABLES.budgetReservations,
    );
    const changed = row["changed"];
    return typeof changed === "number" ? changed : 0;
  }

  /**
   * Take the table's write lock before the first read, and record nothing.
   *
   * A no-op write: it sets the value that is already there, so a transaction
   * that rolls back leaves no trace, and it takes RESERVED even when it matches
   * no row — the statement is a write whether or not a row exists.
   */
  private lockWrite(graphId: string): void {
    this.db.run(
      `UPDATE ${GRAPH_STORE_TABLES.budgetReservations}
       SET reserved_at = reserved_at
       WHERE graph_id = ?`,
      graphId,
    );
  }

  /**
   * The run a budget row belongs to: the caller's own id, verified against the
   * graph's CURRENT run inside the transaction that is about to write it.
   *
   * A budget row under a superseded run would be a claim nobody reads (the
   * report and the enforcement both read the current run), and a row under a run
   * that never existed would be an unaddressable fact. Both are refused rather
   * than written.
   */
  private requireRunId(graphId: string, explicit: string): string {
    const current = this.readCurrentRunId(graphId);
    if (current === undefined || current !== explicit) {
      throw new GraphStoreWriteError(
        "invalid-record",
        "graph-store: run " +
        JSON.stringify(explicit) +
        " of graph " +
        JSON.stringify(graphId) +
        " is not the graph's CURRENT run (" +
        JSON.stringify(current ?? null) +
        ") — a budget row under any other run would be a claim no reader resolves, so " +
        "it was refused and nothing was written",
      );
    }
    return current;
  }

  /** The declared ceilings, validated field by field, in the port's names. */
  private normalizedLimits(limits: NodeBudgetLimits): NodeBudgetLimits {
    return Object.freeze({
      ...(limits.durationMs === undefined
        ? {}
        : { durationMs: requireAmount(limits.durationMs, "budget.limits.durationMs") }),
      ...(limits.inputTokens === undefined
        ? {}
        : { inputTokens: requireAmount(limits.inputTokens, "budget.limits.inputTokens") }),
      ...(limits.outputTokens === undefined
        ? {}
        : { outputTokens: requireAmount(limits.outputTokens, "budget.limits.outputTokens") }),
      ...(limits.costUsd === undefined
        ? {}
        : { costUsd: requireAmount(limits.costUsd, "budget.limits.costUsd") }),
    });
  }

  // ── The enforcement: reserve one dispatch ─────────────────────────────────

  /**
   * Claim one dispatch's share of its node's declared ceilings.
   *
   * ONE STATEMENT, and the `WHERE` is the whole gate: for every dimension the
   * declaration ceilinged, the SUM of the node's recorded usage and its
   * outstanding claims must still be BELOW the ceiling. A dimension with no
   * headroom yields no row at all, so a second dispatch racing for the last unit
   * loses at the database, not in a comparison performed beside it.
   */
  reserveDispatch(input: BudgetReserveInput): BudgetReserveResult {
    const graphId = requireIdentifier(input.graphId, "budget.graphId");
    const runId = requireIdentifier(input.runId, "budget.runId");
    const nodeId = requireIdentifier(input.nodeId, "budget.nodeId");
    const attemptId = requireIdentifier(input.attemptId, "budget.attemptId");
    const effectId = requireIdentifier(input.effectId, "budget.effectId");
    const at = requireCount(input.at, "budget.at");
    const limits = this.normalizedLimits(input.limits);
    const maxExecutions = input.maxExecutions === undefined
      ? undefined
      : requireCount(input.maxExecutions, "budget.maxExecutions");
    const table = GRAPH_STORE_TABLES.budgetReservations;
    return this.join(() => {
      this.lockWrite(graphId);
      this.requireRunId(graphId, runId);
      // ── The claim amounts ───────────────────────────────────────────────
      //
      // For each dimension: the declared ceiling, and what is LEFT of it. The
      // subqueries read the rows the WHERE below approved in the same statement,
      // so the values written are the values that passed the gate.
      const remainingOf = (dimension: BudgetDimension): string =>
        `CASE WHEN ? IS NULL THEN 0 ELSE ? - ` +
        `COALESCE((SELECT SUM(${dimension.usedColumn}) FROM ${table} ` +
        `WHERE graph_id = ? AND run_id = ? AND node_id = ? AND status = 'reconciled'), 0) - ` +
        `COALESCE((SELECT SUM(${dimension.reservedColumn}) FROM ${table} ` +
        `WHERE graph_id = ? AND run_id = ? AND node_id = ? AND status = 'reserved'), 0) END`;

      const headroomOf = (dimension: BudgetDimension): string =>
        `(? IS NULL OR (` +
        `COALESCE((SELECT SUM(${dimension.usedColumn}) FROM ${table} ` +
        `WHERE graph_id = ? AND run_id = ? AND node_id = ? AND status = 'reconciled'), 0) + ` +
        `COALESCE((SELECT SUM(${dimension.reservedColumn}) FROM ${table} ` +
        `WHERE graph_id = ? AND run_id = ? AND node_id = ? AND status = 'reserved'), 0)` +
        `) < ?)`;

      const params: unknown[] = [graphId, runId, nodeId, attemptId, effectId];
      for (const dimension of DIMENSIONS) params.push(dimension.limitOf(limits) ?? null);
      params.push(1); // reserved_executions: exactly one armed dispatch.
      for (const dimension of DIMENSIONS) {
        const limit = dimension.limitOf(limits) ?? null;
        params.push(limit, limit, graphId, runId, nodeId, graphId, runId, nodeId);
      }
      params.push(at);
      params.push(graphId, runId, nodeId, attemptId);
      for (const dimension of DIMENSIONS) {
        const limit = dimension.limitOf(limits) ?? null;
        params.push(limit, graphId, runId, nodeId, graphId, runId, nodeId, limit);
      }
      params.push(maxExecutions ?? null, graphId, runId, maxExecutions ?? null);

      this.db.run(
        `INSERT INTO ${table} (
           graph_id, run_id, node_id, attempt_id, effect_id, status,
           checked_duration_ms, checked_input_tokens, checked_output_tokens, checked_cost_usd,
           reserved_executions, reserved_duration_ms, reserved_input_tokens,
           reserved_output_tokens, reserved_cost_usd,
           reserved_at
         )
         SELECT ?, ?, ?, ?, ?, 'reserved',
                ?, ?, ?, ?,
                ?, ${DIMENSIONS.map(remainingOf).join(", ")},
                ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${table}
           WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
         )
           AND ${DIMENSIONS.map(headroomOf).join("\n           AND ")}
           AND (? IS NULL OR (SELECT COUNT(*) FROM ${table}
             WHERE graph_id = ? AND run_id = ?) < ?)`,
        ...params,
      );
      if (this.changes() === 1) {
        const reservation = this.readReservationIn(graphId, attemptId, runId);
        if (reservation === undefined) {
          throw new GraphStoreWriteError(
            "invalid-record",
            "graph-store: the budget reservation for attempt " +
            JSON.stringify(attemptId) +
            " was inserted and could not be read back — refusing to report a claim the " +
            "store cannot show",
          );
        }
        return Object.freeze({ kind: "reserved" as const, reservation });
      }
      // NOTHING WAS INSERTED. Two conditions can do that, and they are told
      // apart from the COMMITTED rows rather than from the statement's outcome:
      // an attempt that already holds a row is the replay of the claim that
      // stands, and anything else is a dimension with no headroom left.
      const existing = this.readReservationIn(graphId, attemptId, runId);
      if (existing !== undefined) {
        return Object.freeze({ kind: "replayed" as const, reservation: existing });
      }
      return Object.freeze({
        kind: "exhausted" as const,
        exhausted: this.exhaustionOf(graphId, runId, nodeId, limits, maxExecutions),
      });
    });
  }

  /**
   * The dimensions with no headroom left, with the numbers the refusal is
   * reported from.
   *
   * Read AFTER a refused claim, from the same rows the claim was compared
   * against, so the answer names the ceiling, the committed amount and the
   * arithmetic instead of asserting "budget exhausted".
   */
  private exhaustionOf(
    graphId: string,
    runId: string,
    nodeId: string,
    limits: NodeBudgetLimits,
    maxExecutions?: number,
  ): readonly BudgetExhaustion[] {
    const out: BudgetExhaustion[] = [];
    if (maxExecutions !== undefined) {
      const row = asRow(this.db.query(
        `SELECT COUNT(*) AS executions FROM ${GRAPH_STORE_TABLES.budgetReservations}
         WHERE graph_id = ? AND run_id = ?`,
      ).get(graphId, runId), this.filePath, GRAPH_STORE_TABLES.budgetReservations);
      const committed = readAmount(row, "executions", this.filePath, GRAPH_STORE_TABLES.budgetReservations);
      if (committed >= maxExecutions) out.push(Object.freeze({
        kind: "executions", limit: maxExecutions, committed,
        message: `run ${JSON.stringify(runId)} has reserved ${committed} executions against max_executions ${maxExecutions}`,
      }));
    }
    for (const dimension of DIMENSIONS) {
      const limit = dimension.limitOf(limits);
      if (limit === undefined) continue;
      const committed = this.committedOf(graphId, runId, nodeId, dimension);
      if (committed < limit) continue;
      out.push(
        Object.freeze({
          kind: dimension.kind,
          limit,
          committed,
          message:
            "node " +
            JSON.stringify(nodeId) +
            " has no remaining " +
            dimension.kind +
            " budget: " +
            String(committed) +
            " committed (recorded usage plus outstanding reservations) against a declared " +
            "ceiling of " +
            String(limit) +
            ", so no further dispatch of it was authorized",
        }),
      );
    }
    return Object.freeze(out);
  }

  /** Recorded usage plus outstanding claims of one dimension, from the rows. */
  private committedOf(
    graphId: string,
    runId: string,
    nodeId: string,
    dimension: BudgetDimension,
  ): number {
    const table = GRAPH_STORE_TABLES.budgetReservations;
    const row = asRow(
      this.db
        .query(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'reconciled' THEN ${dimension.usedColumn} ELSE 0 END), 0) AS used_amount,
             COALESCE(SUM(CASE WHEN status = 'reserved' THEN ${dimension.reservedColumn} ELSE 0 END), 0) AS reserved_amount
           FROM ${table}
           WHERE graph_id = ? AND run_id = ? AND node_id = ?`,
        )
        .get(graphId, runId, nodeId),
      this.filePath,
      table,
    );
    return (
      readAmount(row, "used_amount", this.filePath, table) +
      readAmount(row, "reserved_amount", this.filePath, table)
    );
  }

  // ── Reconciliation against real usage ─────────────────────────────────────

  /**
   * Reconcile one attempt with the REAL usage the trusted host path reported.
   *
   * A claim still outstanding (`reserved`) and a claim withdrawn as unknown
   * (`released`) both transition to `reconciled` — the late report of a
   * delayed bill is a usage fact like any other. A row already reconciled is
   * NOT rewritten: the same numbers replay it, different numbers are IGNORED
   * with the standing fact returned, because adding a second report for one
   * attempt is the double count plan §5 A13 forbids. An attempt this store
   * never reserved is APPENDED as a settled fact: external billing that arrives
   * after the fact is recorded, never dropped.
   *
   * THE ATTEMPT'S OWN ROW DECIDES WHICH RUN THE FACT BELONGS TO. A report arrives
   * with the run that is CURRENT when the bill lands, which is not necessarily the
   * run that made the claim: a delayed bill for an attempt of a superseded run
   * settles THAT attempt's row, against the ceiling that row was checked against,
   * instead of appending a second fact under a run that never dispatched it. The
   * addressed run is the fallback for an attempt that holds no row at all — the
   * only case in which "never reserved here" is a fact this store can know.
   */
  reconcileUsage(input: BudgetUsageInput): BudgetUsageResult {
    const graphId = requireIdentifier(input.graphId, "budget.graphId");
    const runId = requireIdentifier(input.runId, "budget.runId");
    const nodeId = requireIdentifier(input.nodeId, "budget.nodeId");
    const attemptId = requireIdentifier(input.attemptId, "budget.attemptId");
    const effectId = requireIdentifier(input.effectId, "budget.effectId");
    const at = requireCount(input.at, "budget.at");
    const executions =
      input.usage.executions === undefined
        ? 1
        : requireCount(input.usage.executions, "budget.usage.executions");
    const used: BudgetUsageAmounts = Object.freeze({
      executions,
      durationMs: requireAmount(input.usage.durationMs, "budget.usage.durationMs"),
      inputTokens: requireAmount(input.usage.inputTokens, "budget.usage.inputTokens"),
      outputTokens: requireAmount(input.usage.outputTokens, "budget.usage.outputTokens"),
      costUsd: requireAmount(input.usage.costUsd, "budget.usage.costUsd"),
    });
    const table = GRAPH_STORE_TABLES.budgetReservations;
    return this.join(() => {
      this.lockWrite(graphId);
      this.requireRunId(graphId, runId);
      // THE ROW THE ATTEMPT ALREADY HOLDS IS THE AUTHORITY ON WHICH RUN THE FACT
      // BELONGS TO. The addressed run is tried first — it is the row's run in every
      // ordinary report — and the graph-wide fallback exists for exactly one case:
      // a delayed bill whose attempt was dispatched by a run that has since been
      // superseded. Filing that bill under the run that is current when it lands
      // would charge a run that never dispatched the attempt, while leaving the
      // claim that actually holds the budget outstanding forever.
      const existing =
        this.readReservationIn(graphId, attemptId, runId) ??
        this.attemptRowOf(graphId, attemptId);
      if (existing === undefined) {
        this.db.run(
          `INSERT INTO ${table} (
             graph_id, run_id, node_id, attempt_id, effect_id, status,
             reserved_executions, reserved_duration_ms, reserved_input_tokens,
             reserved_output_tokens, reserved_cost_usd,
             used_executions, used_duration_ms, used_input_tokens,
             used_output_tokens, used_cost_usd,
             reserved_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, 'reconciled', 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
          graphId,
          runId,
          nodeId,
          attemptId,
          effectId,
          used.executions,
          used.durationMs,
          used.inputTokens,
          used.outputTokens,
          used.costUsd,
          at,
          at,
        );
        const recorded = this.readReservationIn(graphId, attemptId, runId);
        if (recorded === undefined) {
          throw new GraphStoreWriteError(
            "invalid-record",
            "graph-store: the late usage report for attempt " +
            JSON.stringify(attemptId) +
            " was appended and could not be read back",
          );
        }
        return Object.freeze({ kind: "recorded-late" as const, reservation: recorded });
      }
      if (existing.status === "reconciled") {
        return this.reconciledVerdict(existing, used);
      }
      this.db.run(
        `UPDATE ${table}
           SET status = 'reconciled',
               effect_id = ?,
               used_executions = ?,
               used_duration_ms = ?,
               used_input_tokens = ?,
               used_output_tokens = ?,
               used_cost_usd = ?,
               settled_at = ?
         WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
           AND status IN ('reserved', 'released')`,
        effectId,
        used.executions,
        used.durationMs,
        used.inputTokens,
        used.outputTokens,
        used.costUsd,
        at,
        graphId,
        existing.runId,
        existing.nodeId,
        attemptId,
      );
      const changed = this.changes();
      if (changed !== 1) {
        // The conditional UPDATE matched nothing although this transaction just
        // read a `reserved`/`released` row. That is not a state this store can
        // produce, and reporting it as a settlement would be a claim the row does
        // not corroborate.
        throw new GraphStoreWriteError(
          "invalid-record",
          "graph-store: the budget reservation of attempt " +
          JSON.stringify(attemptId) +
          " could not be reconciled although it is not reconciled (status " +
          JSON.stringify(existing.status) +
          ") — nothing was reported as settled",
        );
      }
      const reconciled = this.readReservationIn(graphId, attemptId, existing.runId);
      if (reconciled === undefined) {
        throw new GraphStoreWriteError(
          "invalid-record",
          "graph-store: the reconciled usage of attempt " +
          JSON.stringify(attemptId) +
          " could not be read back",
        );
      }
      return Object.freeze({ kind: "reconciled" as const, reservation: reconciled });
    });
  }

  /** The verdict for a usage report against an already-reconciled row. */
  private reconciledVerdict(
    reservation: BudgetReservationRecord,
    used: BudgetUsageAmounts,
  ): BudgetUsageResult {
    const standing = reservation.used;
    const equal =
      standing !== undefined &&
      standing.executions === used.executions &&
      standing.durationMs === used.durationMs &&
      standing.inputTokens === used.inputTokens &&
      standing.outputTokens === used.outputTokens &&
      standing.costUsd === used.costUsd;
    if (equal) {
      return Object.freeze({ kind: "replayed" as const, reservation });
    }
    return Object.freeze({
      kind: "ignored" as const,
      reservation,
      reason:
        "attempt " +
        JSON.stringify(reservation.attemptId) +
        " already carries recorded usage (" +
        describeUsage(standing) +
        "), so this later report (" +
        describeUsage(used) +
        ") was NOT added: one attempt has ONE usage fact, and summing a second report " +
        "would double count it",
    });
  }

  // ── Releasing a claim of an attempt that ended with no report ─────────────

  /**
   * Withdraw one attempt's claim because it ENDED and no usage was reported.
   *
   * The row stays, as `released`: the dispatch happened (it is counted), its
   * consumption is UNKNOWN (never recorded as zero), and a later bill still
   * reconciles it. Releasing is what keeps a finished dispatch from holding the
   * node's remaining budget forever.
   */
  releaseReservation(input: BudgetReleaseInput): BudgetReleaseResult {
    const graphId = requireIdentifier(input.graphId, "budget.graphId");
    const runId = requireIdentifier(input.runId, "budget.runId");
    const nodeId = requireIdentifier(input.nodeId, "budget.nodeId");
    const attemptId = requireIdentifier(input.attemptId, "budget.attemptId");
    const at = requireCount(input.at, "budget.at");
    const table = GRAPH_STORE_TABLES.budgetReservations;
    return this.join(() => {
      this.lockWrite(graphId);
      this.requireRunId(graphId, runId);
      this.db.run(
        `UPDATE ${table}
           SET status = 'released', settled_at = ?
         WHERE graph_id = ? AND run_id = ? AND node_id = ? AND attempt_id = ?
           AND status = 'reserved'`,
        at,
        graphId,
        runId,
        nodeId,
        attemptId,
      );
      const changed = this.changes();
      const existing = this.readReservationIn(graphId, attemptId, runId);
      if (existing === undefined) {
        return Object.freeze({ kind: "absent" as const });
      }
      if (existing.status === "released" && changed === 1) {
        return Object.freeze({ kind: "released" as const, reservation: existing });
      }
      // A reconciled row keeps its real usage — a release is not a way to erase
      // a recorded fact — and an already-released row is the replay of the
      // release that stands.
      return Object.freeze({ kind: "replayed" as const, reservation: existing });
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** One attempt's reservation, or `undefined`. */
  readReservation(
    graphId: string,
    attemptId: string,
    runId?: string,
  ): BudgetReservationRecord | undefined {
    return this.join(() => this.readReservationIn(graphId, attemptId, runId));
  }

  /** The row reader shared by every path, with the run resolved the same way. */
  private readReservationIn(
    graphId: string,
    attemptId: string,
    runId?: string,
  ): BudgetReservationRecord | undefined {
    const resolved = runId ?? this.readCurrentRunId(graphId);
    if (resolved === undefined) return undefined;
    const table = GRAPH_STORE_TABLES.budgetReservations;
    const row = this.db
      .query(
        `SELECT ${RESERVATION_COLUMNS} FROM ${table}
         WHERE graph_id = ? AND run_id = ? AND attempt_id = ?`,
      )
      .get(graphId, resolved, attemptId);
    if (row === null || row === undefined) return undefined;
    return this.toReservation(asRow(row, this.filePath, table));
  }

  /**
   * The row an ATTEMPT already holds, under whichever run of this graph made it.
   *
   * ATTEMPT IDS ARE UNIQUE PER GRAPH — the run path continues the attempt counter
   * when it forms a successor run — so this lookup names at most one row in every
   * state this store can produce. It exists because a usage report is addressed to
   * the run that is current when the bill lands, which is not necessarily the run
   * that spent the resource; reconciliation uses it so the bill settles the claim
   * that exists rather than creating a second fact under the addressed run.
   */
  private attemptRowOf(
    graphId: string,
    attemptId: string,
  ): BudgetReservationRecord | undefined {
    const table = GRAPH_STORE_TABLES.budgetReservations;
    const row = this.db
      .query(
        `SELECT ${RESERVATION_COLUMNS} FROM ${table}
         WHERE graph_id = ? AND attempt_id = ?
         ORDER BY reserved_at ASC, run_id ASC
         LIMIT 1`,
      )
      .get(graphId, attemptId);
    if (row === null || row === undefined) return undefined;
    return this.toReservation(asRow(row, this.filePath, table));
  }

  /** Every reservation of one run, in reservation order. */
  reservationsOf(graphId: string, runId?: string): readonly BudgetReservationRecord[] {
    return this.join(() => {
      const resolved = runId ?? this.readCurrentRunId(graphId);
      if (resolved === undefined) return Object.freeze([]);
      const table = GRAPH_STORE_TABLES.budgetReservations;
      const rows = this.db
        .query(
          `SELECT ${RESERVATION_COLUMNS} FROM ${table}
           WHERE graph_id = ? AND run_id = ?
           ORDER BY reserved_at ASC, node_id ASC, attempt_id ASC`,
        )
        .all(graphId, resolved);
      const out: BudgetReservationRecord[] = [];
      for (const row of rows) {
        out.push(this.toReservation(asRow(row, this.filePath, table)));
      }
      return Object.freeze(out);
    });
  }

  /**
   * The per-node accumulation of one run's reservation facts, from the rows.
   *
   * `executions` counts EVERY row (each one is an authorized dispatch), the
   * recorded usage sums only the reconciled rows, the outstanding claims sum the
   * reserved ones, and the released ones are counted as attempts whose usage is
   * UNKNOWN — never as zero. The two `executions` fields inside `used` and
   * `reserved` are EXECUTIONS the platform accounted for, which a report may
   * show differing from the dispatch count because one dispatch can report more
   * than one execution.
   */
  budgetUsageOf(graphId: string, runId?: string): readonly BudgetNodeUsage[] {
    return this.join(() => {
      const resolved = runId ?? this.readCurrentRunId(graphId);
      if (resolved === undefined) return Object.freeze([]);
      const table = GRAPH_STORE_TABLES.budgetReservations;
      const sums = USAGE_FIELDS.flatMap((entry) => [
        `COALESCE(SUM(CASE WHEN status = 'reconciled' THEN ${columnOf(entry.limitKind, "used")} ELSE 0 END), 0) AS used_${entry.field}`,
        `COALESCE(SUM(CASE WHEN status = 'reserved' THEN ${columnOf(entry.limitKind, "reserved")} ELSE 0 END), 0) AS reserved_${entry.field}`,
      ]).join(",\n             ");
      // `executions` counts DISPATCHES (one per row). The two execution sums
      // below count the EXECUTIONS the two sides of the ledger account for: a
      // platform may report more than one execution for a single dispatch, and
      // the recorded number is what the count dimension accumulates.
      const rows = this.db
        .query(
          `SELECT node_id,
             COUNT(*) AS executions,
             COALESCE(SUM(CASE WHEN status = 'reconciled' THEN used_executions ELSE 0 END), 0) AS recorded_executions,
             COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_executions ELSE 0 END), 0) AS claimed_executions,
             COALESCE(SUM(CASE WHEN status = 'released' THEN 1 ELSE 0 END), 0) AS unknown_attempts,
             ${sums}
           FROM ${table}
           WHERE graph_id = ? AND run_id = ?
           GROUP BY node_id
           ORDER BY node_id ASC`,
        )
        .all(graphId, resolved);
      const out: BudgetNodeUsage[] = [];
      for (const value of rows) {
        const row = asRow(value, this.filePath, table);
        const used: {
          executions: number;
          durationMs: number;
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
        } = {
          executions: readCount(row, "recorded_executions", this.filePath, table),
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        const reserved: {
          executions: number;
          durationMs: number;
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
        } = {
          executions: readCount(row, "claimed_executions", this.filePath, table),
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
        for (const entry of USAGE_FIELDS) {
          used[entry.field] = readAmount(row, `used_${entry.field}`, this.filePath, table);
          reserved[entry.field] = readAmount(
            row,
            `reserved_${entry.field}`,
            this.filePath,
            table,
          );
        }
        out.push(
          Object.freeze({
            nodeId: readText(row, "node_id", this.filePath, table),
            executions: readCount(row, "executions", this.filePath, table),
            used: Object.freeze(used),
            reserved: Object.freeze(reserved),
            unknownUsageAttempts: readCount(row, "unknown_attempts", this.filePath, table),
          }),
        );
      }
      return Object.freeze(out);
    });
  }

  /** One row as the port's record. */
  private toReservation(row: Record<string, unknown>): BudgetReservationRecord {
    const table = GRAPH_STORE_TABLES.budgetReservations;
    const status = row["status"];
    if (
      typeof status !== "string" ||
      !RESERVATION_STATUSES.includes(status as (typeof RESERVATION_STATUSES)[number])
    ) {
      throw malformedRow(
        this.filePath,
        table,
        `status is ${describeValue(status)}, not reserved, reconciled or released`,
      );
    }
    const checked: {
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    } = {};
    for (const dimension of DIMENSIONS) {
      const ceiling = readOptionalAmount(row, dimension.checkedColumn, this.filePath, table);
      if (ceiling === undefined) continue;
      if (dimension.kind === "duration_ms") checked.durationMs = ceiling;
      else if (dimension.kind === "input_tokens") checked.inputTokens = ceiling;
      else if (dimension.kind === "output_tokens") checked.outputTokens = ceiling;
      else checked.costUsd = ceiling;
    }
    const settled = status === "reconciled";
    return Object.freeze({
      graphId: readText(row, "graph_id", this.filePath, table),
      runId: readText(row, "run_id", this.filePath, table),
      nodeId: readText(row, "node_id", this.filePath, table),
      attemptId: readText(row, "attempt_id", this.filePath, table),
      effectId: readText(row, "effect_id", this.filePath, table),
      status: status as BudgetReservationRecord["status"],
      checked: Object.freeze(checked),
      reserved: Object.freeze({
        executions: readCount(row, "reserved_executions", this.filePath, table),
        durationMs: readAmount(row, "reserved_duration_ms", this.filePath, table),
        inputTokens: readAmount(row, "reserved_input_tokens", this.filePath, table),
        outputTokens: readAmount(row, "reserved_output_tokens", this.filePath, table),
        costUsd: readAmount(row, "reserved_cost_usd", this.filePath, table),
      }),
      ...(settled
        ? {
          used: Object.freeze({
            executions: readCount(row, "used_executions", this.filePath, table),
            durationMs: readAmount(row, "used_duration_ms", this.filePath, table),
            inputTokens: readAmount(row, "used_input_tokens", this.filePath, table),
            outputTokens: readAmount(row, "used_output_tokens", this.filePath, table),
            costUsd: readAmount(row, "used_cost_usd", this.filePath, table),
          }),
        }
        : {}),
      reservedAt: readCount(row, "reserved_at", this.filePath, table),
      ...(status === "reserved"
        ? {}
        : { settledAt: readCount(row, "settled_at", this.filePath, table) }),
    });
  }
}

/**
 * Every column of a reservation row, spelled once.
 *
 * `SELECT *` would work, but the reader below addresses these columns by name
 * and the schema gate compares them by name — one list keeps the query and the
 * record model from drifting apart without a failing read.
 */
const RESERVATION_COLUMNS = [
  "graph_id",
  "run_id",
  "node_id",
  "attempt_id",
  "effect_id",
  "status",
  ...DIMENSIONS.flatMap((dimension) => [
    dimension.checkedColumn,
    dimension.reservedColumn,
    dimension.usedColumn,
  ]),
  "reserved_executions",
  "used_executions",
  "reserved_at",
  "settled_at",
].join(", ");

/** One usage reading as a short, value-only description for a refusal. */
function describeUsage(usage: BudgetUsageAmounts | undefined): string {
  if (usage === undefined) return "no recorded usage";
  return (
    "executions " +
    String(usage.executions) +
    ", durationMs " +
    String(usage.durationMs) +
    ", inputTokens " +
    String(usage.inputTokens) +
    ", outputTokens " +
    String(usage.outputTokens) +
    ", costUsd " +
    String(usage.costUsd)
  );
}
