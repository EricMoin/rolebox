/**
 * Graph Execution Engine v2 — the host's AUTHORITATIVE store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * ONE SQLITE FILE UNDER THE HOST'S OWN ROOT, holding the two facts the host
 * must be able to recover TOGETHER after a crash:
 *
 * - `host_dispatch_executions` — the state of every dispatch effect the host
 *   took responsibility for: `pending` (a create right is held and nothing has
 *   been handed to the platform), `creating` (the request was handed over and
 *   the result is UNKNOWN), `created` (the platform confirmed it and named a
 *   real execution/task id). The primary key `(graph_id, effect_id)` IS the
 *   cross-instance uniqueness the create-once rule needs: two host processes
 *   cannot both hold a row for one effect, and a conditional UPDATE is what
 *   transfers ownership.
 * - `host_attempt_credentials` — the attempt's credential record, keyed by
 *   `(graph_id, node_id, attempt_id)`. The VALUE is present only when the host
 *   declared a durable credential store it can protect; otherwise the row
 *   records `not-retained`, which is what lets a recovery report "this
 *   attempt's credential was not retained" instead of inventing one.
 *
 * WHY A DATABASE AND NOT A FILE SNAPSHOT. The previous shape kept an in-memory
 * set and rewrote the whole JSON file on every change: two live processes each
 * rewrote the file from their own snapshot, so the later writer silently ERASED
 * rows the other had written (a reproduced defect), and a row was written
 * BEFORE the platform was asked to create anything, so "preparing to create"
 * read back as "the host confirmed it created". Both are properties of the
 * storage, not of the callers: a unique constraint plus conditional
 * single-statement transitions make them unrepresentable here.
 *
 * THE FORMAT IS REFUSED, NEVER RECREATED. An existing file that is not this
 * build's store — unreadable, foreign, missing the version row, carrying a
 * version this build does not write, or missing/retyped columns — throws
 * {@link HostStoreFormatError} and is left untouched. A zero-byte file is a new
 * store and is initialized in one transaction. This is the same discipline the
 * acceptance ledger applies to its own file.
 *
 * CONNECTIONS ARE THE CALLER'S. Each `open` creates its own connection (the
 * vault and the index may open the same file independently); nothing is cached
 * process-wide and no module-level singleton exists. `busy_timeout` is raised
 * so two connections over one file serialize instead of failing with
 * `SQLITE_BUSY`, and WAL is NOT enabled — the driver's default rollback
 * journal is the configuration the ledger already verified.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  createDatabaseSync,
  type DatabaseDriver,
} from "../../memory/db-driver.ts";
import { workspaceHash } from "../../utils/state-paths.ts";
import { errorText } from "../../utils/error-text.ts";

// ── Path, format and schema identity ────────────────────────────────────────

/** The store file the host owns inside its root. */
export const HOST_STORE_FILE = "rolebox-host-store.sqlite" as const;

/** The store's own format version, refused rather than read approximately. */
export const HOST_STORE_FORMAT_VERSION = 1 as const;

/** The tables this format version owns. */
export const HOST_STORE_TABLES = Object.freeze({
  meta: "host_store_meta",
  executions: "host_dispatch_executions",
  credentials: "host_attempt_credentials",
});

/**
 * The host store root for one workspace, under the host's OWN data directory.
 *
 * The root is deliberately NOT inside the workspace: a dispatched worker runs
 * with the workspace as its root, so keeping the host's state beside it would
 * hand every worker the directory (never a defense by itself — see
 * `credential-vault.ts` — but the one path-shaped part of the boundary this
 * build can choose). The entry points pass their own data directory in, so this
 * module stays free of CLI/platform layering.
 */
export function hostStoreRoot(dataDir: string, workspaceDir: string): string {
  return join(dataDir, "host", workspaceHash(workspaceDir));
}

/**
 * Everything the file is checked against, in creation order.
 *
 * `IF NOT EXISTS` and the `INSERT OR IGNORE` below are what make TWO
 * PROCESSES opening a brand-new root at the same moment safe: the loser of the
 * race no-ops instead of failing on an already-created table, and the store is
 * verified afterwards either way.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${HOST_STORE_TABLES.meta} (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     format_version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${HOST_STORE_TABLES.executions} (
     graph_id TEXT NOT NULL,
     effect_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'creating', 'created')),
     owner_id TEXT NOT NULL,
     execution_id TEXT,
     task_id TEXT,
     claimed_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, effect_id),
     CHECK ((state = 'created') = (execution_id IS NOT NULL))
   )`,
  `CREATE TABLE IF NOT EXISTS ${HOST_STORE_TABLES.credentials} (
     graph_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     retention TEXT NOT NULL CHECK (retention IN ('retained', 'not-retained')),
     credential TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (graph_id, node_id, attempt_id),
     CHECK ((retention = 'retained') = (credential IS NOT NULL))
   )`,
];

/** The columns each table declares, in order, as this format writes them. */
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [HOST_STORE_TABLES.meta]: ["id", "format_version"],
  [HOST_STORE_TABLES.executions]: [
    "graph_id",
    "effect_id",
    "attempt_id",
    "state",
    "owner_id",
    "execution_id",
    "task_id",
    "claimed_at",
    "updated_at",
  ],
  [HOST_STORE_TABLES.credentials]: [
    "graph_id",
    "node_id",
    "attempt_id",
    "retention",
    "credential",
    "updated_at",
  ],
});

/** Raised when a file is not a store this build can read. */
export class HostStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = "HostStoreFormatError";
    this.filePath = filePath;
  }
}

// ── The store ───────────────────────────────────────────────────────────────

/** One row of an arbitrary query result, as a field bag. */
type Row = Readonly<Record<string, unknown>>;

/**
 * The host's authoritative SQLite store. Thin by design: it owns the format
 * gate, the connection and the transaction/statement surface; the meaning of
 * the rows belongs to the execution index and the credential vault.
 */
export class HostStore {
  private readonly db: DatabaseDriver;
  private readonly filePath: string;
  private closed = false;

  private constructor(db: DatabaseDriver, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Open (or initialize) the store inside `root`.
   *
   * The directory is created 0700 when absent. An existing non-empty file is
   * VERIFIED and refused when it is not this build's store; a new or zero-byte
   * file gets the schema and the version row in one transaction.
   */
  static openFile(root: string): HostStore {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const filePath = join(root, HOST_STORE_FILE);
    const existing = existsSync(filePath) && statSync(filePath).size > 0;
    const db = createDatabaseSync(filePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      if (existing) {
        verifyStore(db, filePath);
      } else {
        // A fresh (or zero-byte) file: create the schema idempotently, then
        // VERIFY it — a concurrent process may have won the creation, and the
        // file that exists afterwards is the thing this build must accept.
        initializeStore(db, filePath);
        verifyStore(db, filePath);
      }
    } catch (error) {
      db.close();
      if (error instanceof HostStoreFormatError) throw error;
      throw new HostStoreFormatError(
        filePath,
        "host-store: " +
          filePath +
          " could not be opened as a host store (" +
          errorText(error) +
          ") — refusing to treat a file this build cannot read as a new store",
      );
    }
    return new HostStore(db, filePath);
  }

  /** Open a private in-memory store with the same schema (`durability: "memory"`). */
  static openMemory(): HostStore {
    const db = createDatabaseSync(":memory:");
    initializeStore(db, ":memory:");
    return new HostStore(db, ":memory:");
  }

  /** The file this store owns, or `":memory:"`. */
  get path(): string {
    return this.filePath;
  }

  /** Whether this store outlives the process. */
  get durable(): boolean {
    return this.filePath !== ":memory:";
  }

  /** Run one statement. */
  run(sql: string, ...params: unknown[]): void {
    this.assertOpen();
    this.db.run(sql, ...params);
  }

  /** One row, or `undefined`. */
  get(sql: string, ...params: unknown[]): Row | undefined {
    this.assertOpen();
    const row = this.db.query(sql).get(...params);
    return isRow(row) ? row : undefined;
  }

  /** Every row. */
  all(sql: string, ...params: unknown[]): Row[] {
    this.assertOpen();
    const rows = this.db.query(sql).all(...params);
    const out: Row[] = [];
    for (const row of rows) {
      if (isRow(row)) out.push(row);
    }
    return out;
  }

  /**
   * Run `fn` inside one transaction (the driver's own BEGIN/COMMIT/ROLLBACK),
   * so a throw rolls back every row the callback wrote.
   */
  transaction<R>(fn: () => R): R {
    this.assertOpen();
    return this.db.transaction(fn)();
  }

  /**
   * SQLite's own count of rows the last statement changed on THIS connection.
   * The conditional transitions below depend on it, so the driver's
   * `run` (which discards the count) is not used for them.
   */
  changes(): number {
    const row = this.get("SELECT changes() AS changed");
    const changed = row?.["changed"];
    return typeof changed === "number" ? changed : 0;
  }

  /** Close the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("host-store: this store has been closed");
  }
}

// ── Format gate ─────────────────────────────────────────────────────────────

/** Create the schema and its version row in ONE transaction. */
function initializeStore(db: DatabaseDriver, filePath: string): void {
  try {
    const create = db.transaction(() => {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
      db.run(
        `INSERT OR IGNORE INTO ${HOST_STORE_TABLES.meta} (id, format_version) VALUES (1, ?)`,
        HOST_STORE_FORMAT_VERSION,
      );
    });
    create();
  } catch (error) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " could not be initialized as a host store (" +
        errorText(error) +
        ")",
    );
  }
}

/** Verify a non-empty existing file: version, tables, columns — or refuse it. */
function verifyStore(db: DatabaseDriver, filePath: string): void {
  const tables = inspectTables(db, filePath);
  const meta = HOST_STORE_TABLES.meta;
  if (!tables.includes(meta)) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " is not this build's host store (it carries no " +
        meta +
        " table) — refusing to read a foreign store approximately",
    );
  }
  requireColumns(db, meta, filePath);
  let version: unknown;
  try {
    version = db
      .query(`SELECT format_version FROM ${meta} WHERE id = 1`)
      .get() as unknown;
  } catch (error) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " could not be read as this build's host store (" +
        errorText(error) +
        ") — refusing to treat it as a new store",
    );
  }
  const declared = isRow(version) ? version["format_version"] : undefined;
  if (declared !== HOST_STORE_FORMAT_VERSION) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " does not declare format version " +
        String(HOST_STORE_FORMAT_VERSION) +
        " (it declares " +
        JSON.stringify(declared) +
        ") — refusing to read it approximately",
    );
  }
  for (const table of [HOST_STORE_TABLES.executions, HOST_STORE_TABLES.credentials]) {
    if (!tables.includes(table)) {
      throw new HostStoreFormatError(
        filePath,
        "host-store: " +
          filePath +
          " carries " +
          meta +
          " but is missing " +
          table +
          " — refusing to recreate a store that is not intact",
      );
    }
    requireColumns(db, table, filePath);
  }
}

/** The user tables a SQLite file holds; a foreign file fails here. */
function inspectTables(db: DatabaseDriver, filePath: string): string[] {
  let rows: unknown[];
  try {
    rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
  } catch (error) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " could not be read as a host store (" +
        errorText(error) +
        ") — refusing to create a store over a file this build cannot recognize",
    );
  }
  const names: string[] = [];
  for (const row of rows) {
    if (!isRow(row)) continue;
    const name = row["name"];
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names.sort();
}

/** Refuse a table whose columns are not exactly the ones this format writes. */
function requireColumns(
  db: DatabaseDriver,
  table: string,
  filePath: string,
): void {
  const expected = TABLE_COLUMNS[table];
  if (expected === undefined) return;
  let rows: unknown[];
  try {
    rows = db.query(`PRAGMA table_info(${table})`).all();
  } catch (error) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " carries " +
        table +
        ", but its columns could not be read (" +
        errorText(error) +
        ") — refusing to open a store whose layout this build cannot know",
    );
  }
  const observed: string[] = [];
  for (const row of rows) {
    if (!isRow(row)) continue;
    const name = row["name"];
    if (typeof name === "string") observed.push(name);
  }
  const same =
    observed.length === expected.length &&
    expected.every((column, index) => observed[index] === column);
  if (!same) {
    throw new HostStoreFormatError(
      filePath,
      "host-store: " +
        filePath +
        " declares " +
        table +
        " as (" +
        observed.join(", ") +
        "), not (" +
        expected.join(", ") +
        ") — refusing to read a store this build cannot interpret",
    );
  }
}

/** Whether a value is a plain, non-array record. */
function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
