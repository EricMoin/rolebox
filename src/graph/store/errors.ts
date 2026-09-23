/**
 * Graph store — the refusal vocabulary of the ONE authoritative store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * These are the ledger's own error names, moved to the store that now emits
 * them and re-exported under their previous names by
 * `src/graph/ledger/sqlite-ledger.ts` (the same "move the definition, keep the
 * import path" discipline the P1 domain module used for join/budget). Nothing
 * new is invented: a store that is not this build's is still refused with
 * `GraphStoreFormatError` and the SAME `problem` identifiers, and a write
 * that cannot be persisted is still `GraphStoreWriteError` with the same
 * codes, so every existing test's assertion on `problem` keeps its meaning.
 *
 * WHY THE CLASSES MOVED RATHER THAN BEING DUPLICATED. The unified store is the
 * module that inspects the file, verifies the layout and rejects a row, so it
 * must own the errors it throws; leaving a second copy in the ledger would make
 * `instanceof LedgerFormatError` false for the refusal the ledger's own open
 * produces — a silent compatibility break no test would catch by name.
 *
 * Dependency leaf: this module imports nothing.
 */

// ── Format refusals ─────────────────────────────────────────────────────────

/** Why a store file was refused. Stable identifiers; wording is not API. */
export type GraphStoreFormatProblem =
  /** The file's format version is NEWER than this build writes. */
  | "newer-format"
  /**
   * The file's format version is older and this build registers no migration.
   * A version-1 file is a ledger without the host records, so widening it in
   * place would answer `absent` for execution bindings it never carried.
   */
  | "older-format"
  /** The version row is missing, or its value is not a positive safe integer. */
  | "malformed-format"
  /** The file is a SQLite store, but not this graph store. */
  | "foreign-store"
  /**
   * The version table exists, but the schema this version owns is incomplete or
   * reshaped — a table is missing, or a table's columns, affinities, NOT NULL
   * declarations or PRIMARY KEY are not the ones this format writes.
   */
  | "incomplete-store"
  /** A row exists but violates the record model. */
  | "malformed-row"
  /**
   * The file is a SQLite store whose journal mode is WAL. A read-only SQLite
   * open of a WAL database attaches to — and rewrites — its `-shm`
   * shared-memory side file, so the drain audit refuses it BEFORE any connection
   * exists instead of changing the store it is reading. The file and its side
   * files are left exactly as they were found.
   */
  | "wal-journal-mode";

/**
 * The store file was refused: it is not a store this build may open.
 *
 * The error names the FILE and the concrete problem, and it is thrown BEFORE
 * any schema is created or any row is changed, so a refusal never destroys the
 * record it could not understand.
 */
export class GraphStoreFormatError extends Error {
  readonly problem: GraphStoreFormatProblem;
  readonly path: string;
  /** The raw offending value, when the problem has one. */
  readonly found: unknown;
  /** The store format this build writes. */
  readonly supported: number;

  constructor(
    problem: GraphStoreFormatProblem,
    path: string,
    message: string,
    found: unknown,
    supported: number,
  ) {
    super(message);
    this.name = "GraphStoreFormatError";
    this.problem = problem;
    this.path = path;
    this.found = found;
    this.supported = supported;
  }
}

// ── Write refusals ──────────────────────────────────────────────────────────

/** Why one transaction could not be written. Stable identifiers. */
export type GraphStoreWriteProblem =
  /** The batch violates the record model or the one-submission rule. */
  | "invalid-batch"
  /** A payload JSON cannot represent — nothing from the batch was committed. */
  | "unrepresentable-payload"
  /** A graph-state record violates the record model. */
  | "invalid-graph-state"
  /** A standalone effect record violates the record model. */
  | "invalid-effect"
  /**
   * A graph-state body JSON cannot represent — the transaction that would have
   * committed it rolled back, so no receipt, event or effect survives either.
   */
  | "unrepresentable-state"
  /**
   * A graph-state body is larger than `GRAPH_STATE_MAX_BYTES` — refused BEFORE
   * a row is written, so the acceptance transaction as a whole rolls back rather
   * than storing a truncated state.
   */
  | "oversized-state"
  /**
   * A store record OUTSIDE the ledger port's model (a graph definition, an
   * accepted result) violates its record model. The ledger's own records keep
   * their existing codes; this one names the store's additions without
   * inventing a second vocabulary for the rules that already have names.
   */
  | "invalid-record"
  /** A store record's JSON cannot be represented — nothing was committed. */
  | "unrepresentable-record"
  /** The store rejected a row (a uniqueness violation, a broken file). */
  | "write-rejected"
  /** A nested `runInTransaction` — the boundary is one transaction. */
  | "nested-transaction"
  /** A `runInTransaction` callback that returned a promise. */
  | "async-transaction";

/**
 * A write was refused or rolled back.
 *
 * Thrown INSTEAD of returning `committed`: a batch the store cannot persist
 * must never report success, and the transaction that carried its earlier rows
 * has already rolled back when this error reaches the caller.
 */
export class GraphStoreWriteError extends Error {
  readonly problem: GraphStoreWriteProblem;

  constructor(problem: GraphStoreWriteProblem, message: string) {
    super(message);
    this.name = "GraphStoreWriteError";
    this.problem = problem;
  }
}

/** A closed store refuses every read and write. */
export class GraphStoreClosedError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `graph-store: ${operation} refused — this store is closed, and a closed store refuses reads and writes rather than touching a released connection`,
    );
    this.name = "GraphStoreClosedError";
    this.operation = operation;
  }
}
