/**
 * Graph store — the format gate of the ONE authoritative store
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE GATE IS THE SAME DISCIPLINE THE LEDGER AND THE HOST STORE ALREADY
 * APPLIED, now over one file: an existing store is opened ONLY when its format
 * version is exactly the one this build writes and every table this format owns
 * declares exactly the columns, affinities, nullability and PRIMARY KEY
 * positions it writes. Everything else is refused BEFORE a row is read or
 * written, and the file is left exactly as it was found.
 *
 * THREE REFUSAL SITUATIONS THAT LOOK ALIKE AND ARE NOT:
 * - A ZERO-BYTE file at the authoritative path is `corrupt`: the file exists and
 *   is not a store, so it is never initialized into a fresh run (`§P1.6`).
 * - A NON-EMPTY RETIRED authority beside the path (`RETIRED_AUTHORITY_FILES`:
 *   the previous whole-file host store and the JSON invocation record) is
 *   `unsupported`: this build registers no conversion for it, and answering
 *   `absent` for the execution bindings it holds is what licenses a second
 *   creation for one effect. The gate names the file instead.
 * - An UNKNOWN, NEWER or OLDER format version is `unsupported`: the file is a
 *   well-formed member of a format this build has no decoder for, and the
 *   honest answer is a refusal that names it, never a downgrade, a widening or
 *   an automatic initialization.
 *
 * The verdict vocabulary is the P1 domain's `DomainLoadResult`
 * (`absent` / `valid` / `corrupt` / `unsupported`, with
 * `migration-required` reserved for a REGISTERED conversion) — see
 * `load.ts` for the mapping from these problems onto it.
 *
 * Dependency leaf in the record model: this module reads the file and its
 * schema, and touches no record type.
 */

import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseDriver } from "../../memory/db-driver.ts";
import { errorText } from "../../utils/error-text.ts";
import { GraphStoreFormatError } from "./errors.ts";
import {
  GRAPH_STORE_COLUMNS,
  GRAPH_STORE_FORMAT_VERSION,
  GRAPH_STORE_TABLES,
  RETIRED_AUTHORITY_FILES,
  RETIRED_AUTHORITY_PREFIX,
  RETIRED_AUTHORITY_SUFFIX,
  SCHEMA_STATEMENTS,
  graphStoreFilePath,
  type GraphStoreColumn,
} from "./schema.ts";

// ── Directory inspection ────────────────────────────────────────────────────

/**
 * What the authoritative path holds, decided WITHOUT opening a connection.
 *
 * The three cases are three different facts, and collapsing them is the defect
 * this type exists to prevent: a missing store may be initialized, a retired
 * authority blocks, and a present file must pass the gate.
 */
export type StoreDirectoryReading =
  /**
   * The authoritative file exists. `empty` is true for a ZERO-BYTE file, which
   * is refused BEFORE any connection exists: opening a zero-byte path with
   * SQLite writes a fresh database header into it, which would turn "the
   * authoritative file is damaged" into "the store was initialized".
   */
  | { readonly kind: "store"; readonly filePath: string; readonly empty: boolean }
  /** Nothing authoritative and nothing retired: a genuinely absent store. */
  | { readonly kind: "absent"; readonly filePath: string }
  /** No authoritative file, but a NON-EMPTY retired authority is present. */
  | {
      readonly kind: "retired";
      readonly filePath: string;
      readonly files: readonly string[];
    };

/** Classify the workspace's store directory without creating or changing it. */
export function readStoreDirectory(root: string): StoreDirectoryReading {
  const filePath = graphStoreFilePath(root);
  if (existsSync(filePath)) {
    let empty = false;
    try {
      empty = statSync(filePath).size === 0;
    } catch {
      // A file that exists but cannot be stat'ed is not "empty"; the open
      // below reports what it actually is.
    }
    return { kind: "store", filePath, empty };
  }
  const retired: string[] = [];
  const note = (name: string): void => {
    const path = join(root, name);
    try {
      if (existsSync(path) && statSync(path).size > 0) retired.push(name);
    } catch {
      // A file that cannot be stat'ed is not evidence of records; the gate
      // reports the store it was actually asked to open.
    }
  };
  for (const name of RETIRED_AUTHORITY_FILES) note(name);
  // The RETIRED PER-GRAPH CONTAINER (P1 item 5): `engine-<slug>.json` files
  // this build no longer writes and has no decoder for. A directory listing is
  // only consulted when the authoritative file is absent, and a listing that
  // fails is not evidence of records — the same containment the loop above has.
  let listed: string[] = [];
  try {
    listed = readdirSync(root, { encoding: "utf-8" });
  } catch {
    listed = [];
  }
  for (const name of listed.sort()) {
    if (name.startsWith(RETIRED_AUTHORITY_PREFIX) && name.endsWith(RETIRED_AUTHORITY_SUFFIX)) {
      note(name);
    }
  }
  if (retired.length === 0) return { kind: "absent", filePath };
  return { kind: "retired", filePath, files: Object.freeze(retired.sort()) };
}

/**
 * The refusal a ZERO-BYTE authoritative file produces: it is a damaged store,
 * never an absent one, and never a new run. Opening it with SQLite would write
 * a fresh database header over it, so the caller must refuse before the open.
 */
export function emptyStoreRefusal(filePath: string): GraphStoreFormatError {
  return new GraphStoreFormatError(
    "foreign-store",
    filePath,
    "graph-store: " +
      filePath +
      " exists and is ZERO BYTES — it is a damaged authoritative store, not an " +
      "absent one, and this build neither initializes over it nor treats the " +
      "graph as new",
    undefined,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

/**
 * The refusal a retired authority produces: this build does not convert it, and
 * it must not be read as "no records" either.
 */
export function retiredAuthorityRefusal(
  reading: Extract<StoreDirectoryReading, { kind: "retired" }>,
): GraphStoreFormatError {
  return new GraphStoreFormatError(
    // An OLDER layout this build registers no migration for — the same problem
    // the load path reports as `unsupported`, so the refusal a write open
    // throws and the verdict a load answers say the same thing.
    "older-format",
    reading.filePath,
    "graph-store: " +
      reading.filePath +
      " does not exist, but this root still holds " +
      reading.files.join(", ") +
      " — a retired authority this build neither reads nor converts. It is NOT " +
      "treated as an empty store: the execution bindings it carries are what " +
      "keep a recovery from creating a second execution for one effect, so the " +
      "records must be inventoried and archived before a new store is " +
      "initialized here",
    reading.files,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

// ── Schema creation ─────────────────────────────────────────────────────────

/**
 * Create every table and the version row in ONE transaction.
 *
 * Called ONLY when the authoritative file holds no user tables. `IF NOT
 * EXISTS` plus `INSERT OR IGNORE` make two processes opening a brand-new root
 * at the same moment safe: the loser no-ops and the file is VERIFIED afterwards
 * either way.
 */
export function initializeStore(db: DatabaseDriver, filePath: string): void {
  try {
    const create = db.transaction(() => {
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
      db.run(
        `INSERT OR IGNORE INTO ${GRAPH_STORE_TABLES.meta} (id, format_version) VALUES (1, ?)`,
        GRAPH_STORE_FORMAT_VERSION,
      );
    });
    create();
  } catch (error) {
    throw new GraphStoreFormatError(
      "incomplete-store",
      filePath,
      "graph-store: " +
        filePath +
        " could not be initialized as this build's graph store (" +
        errorText(error) +
        ")",
      undefined,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
}

// ── Schema verification ─────────────────────────────────────────────────────

/**
 * Verify a non-empty existing file — version, tables, columns — or refuse it.
 *
 * The order is deliberate: the meta table's shape first (so its version row is
 * readable at all), then the version identity, then every other table. A file
 * whose version says "newer" is refused as NEWER even when its own layout
 * renames or drops the tables this build knows.
 */
export function verifyStore(db: DatabaseDriver, filePath: string): void {
  const tables = inspectTables(db, filePath);
  if (!tables.includes(GRAPH_STORE_TABLES.meta)) {
    throw new GraphStoreFormatError(
      "foreign-store",
      filePath,
      "graph-store: " +
        filePath +
        " is not this build's graph store — it holds " +
        (tables.length === 0 ? "no tables" : tables.join(", ")) +
        " and no " +
        GRAPH_STORE_TABLES.meta +
        " table, and refusing is the only honest answer to a file whose contents " +
        "this build cannot name",
      tables,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  requireTableShape(db, "meta", filePath);
  requireFormatVersion(db, filePath);
  for (const table of TABLE_ORDER) {
    if (table === "meta") continue;
    if (!tables.includes(GRAPH_STORE_TABLES[table])) {
      throw new GraphStoreFormatError(
        "incomplete-store",
        filePath,
        "graph-store: " +
          filePath +
          " carries " +
          GRAPH_STORE_TABLES.meta +
          " but is missing " +
          GRAPH_STORE_TABLES[table] +
          " — refusing to recreate a store that is not intact",
        GRAPH_STORE_TABLES[table],
        GRAPH_STORE_FORMAT_VERSION,
      );
    }
    requireTableShape(db, table, filePath);
  }
}

/** Every table this format owns, in gate order. */
const TABLE_ORDER = Object.keys(GRAPH_STORE_COLUMNS) as Array<
  keyof typeof GRAPH_STORE_TABLES
>;

/** The user tables a SQLite file holds, sorted; a foreign file fails here. */
export function inspectTables(db: DatabaseDriver, filePath: string): string[] {
  let rows: unknown[];
  try {
    rows = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
  } catch (error) {
    throw new GraphStoreFormatError(
      "foreign-store",
      filePath,
      "graph-store: " +
        filePath +
        " could not be read as a graph store (" +
        errorText(error) +
        ") — refusing to create a store over a file this build cannot recognize",
      undefined,
      GRAPH_STORE_FORMAT_VERSION,
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

/** One column a store declares, as `PRAGMA table_info` reports it. */
interface ObservedColumn {
  readonly name: string;
  readonly affinity: "text" | "integer" | "numeric" | "other";
  readonly primaryKey: number;
  readonly notNull: boolean;
}

/**
 * SQLite's own type-affinity rule, narrowed to the classes this format writes.
 *
 * The gate compares AFFINITY rather than the spelled type because affinity is
 * what SQLite itself applies when it stores or converts a value: `TEXT` and
 * `VARCHAR` describe the same column here, `REAL` and `DOUBLE` the same
 * numeric one, `BLOB` where this format writes `TEXT` is a reshape, and
 * anything else is `other` and refused.
 *
 * `numeric` was added with the budget rows, whose cost columns are REAL: a
 * monetary amount cannot be stored in an INTEGER column without truncating the
 * fraction an overrun is reported in, and refusing the class the format itself
 * writes would make the budget table unopenable by its own gate.
 */
function affinityOf(declaredType: string): ObservedColumn["affinity"] {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "text";
  }
  if (
    type.includes("REAL") ||
    type.includes("FLOA") ||
    type.includes("DOUB") ||
    type.includes("NUMERIC") ||
    type.includes("DECIMAL")
  ) {
    return "numeric";
  }
  return "other";
}

/**
 * The columns one table declares, or a typed refusal.
 *
 * A table named like a store table but holding columns this build cannot read
 * is not thereby foreign — it is refused with the same `incomplete-store`
 * problem as any other half-shaped store, BEFORE a row is touched.
 */
function inspectColumns(
  db: DatabaseDriver,
  table: keyof typeof GRAPH_STORE_TABLES,
  filePath: string,
): ObservedColumn[] {
  const name = GRAPH_STORE_TABLES[table];
  let rows: unknown[];
  try {
    rows = db.query(`PRAGMA table_info(${name})`).all();
  } catch (error) {
    throw new GraphStoreFormatError(
      "incomplete-store",
      filePath,
      "graph-store: " +
        filePath +
        " carries " +
        name +
        ", but its columns could not be read (" +
        errorText(error) +
        ") — refusing to open a store whose layout this build cannot know",
      undefined,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  const columns: ObservedColumn[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw malformedRow(filePath, name, "the driver answered a non-row");
    }
    const entry = row as Record<string, unknown>;
    const columnName = entry["name"];
    const declaredType = entry["type"];
    if (
      typeof columnName !== "string" ||
      columnName.length === 0 ||
      typeof declaredType !== "string"
    ) {
      throw new GraphStoreFormatError(
        "incomplete-store",
        filePath,
        "graph-store: " +
          filePath +
          " carries " +
          name +
          ", but a column description of it is unreadable — refusing to open a store whose layout this build cannot know",
        undefined,
        GRAPH_STORE_FORMAT_VERSION,
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
 * nothing, and the first statement against it would then fail with a raw driver
 * error — the very outcome the format gate exists to prevent. Every column's
 * name, affinity, NOT NULL declaration and PRIMARY KEY position is compared
 * against {@link GRAPH_STORE_COLUMNS}, and the whole file is refused BEFORE any
 * row is read.
 */
export function requireTableShape(
  db: DatabaseDriver,
  table: keyof typeof GRAPH_STORE_TABLES,
  filePath: string,
): void {
  const expected: readonly GraphStoreColumn[] = GRAPH_STORE_COLUMNS[table];
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
        `column ${column.name} is not part of format ${GRAPH_STORE_FORMAT_VERSION}`,
      );
    }
  }
  if (problems.length === 0) return;
  throw new GraphStoreFormatError(
    "incomplete-store",
    filePath,
    "graph-store: " +
      filePath +
      " carries " +
      GRAPH_STORE_TABLES[table] +
      " in a shape format " +
      GRAPH_STORE_FORMAT_VERSION +
      " does not write (" +
      problems.join("; ") +
      ") — refusing to open a store whose layout this build cannot know",
    problems,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

/**
 * Read and check the format-version row.
 *
 * A missing row, a value that is not a positive safe integer, or a version this
 * build does not write is refused here, before any other table is touched: the
 * store is left exactly as it was found. Newer and older are DIFFERENT
 * problems with the same answer — refuse, never downgrade and never widen.
 */
export function requireFormatVersion(db: DatabaseDriver, filePath: string): void {
  let raw: unknown;
  try {
    raw = db
      .query(`SELECT format_version FROM ${GRAPH_STORE_TABLES.meta} WHERE id = 1`)
      .get();
  } catch (error) {
    throw new GraphStoreFormatError(
      "incomplete-store",
      filePath,
      "graph-store: " +
        filePath +
        " carries a " +
        GRAPH_STORE_TABLES.meta +
        " table whose version row cannot be read (" +
        errorText(error) +
        ") — refusing to open a store this build cannot identify",
      undefined,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (raw === undefined || raw === null) {
    throw new GraphStoreFormatError(
      "malformed-format",
      filePath,
      "graph-store: " +
        filePath +
        " carries no format-version row — a store without its format identity is refused, never recreated",
      undefined,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  const row =
    typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const found = row?.["format_version"];
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found <= 0) {
    throw new GraphStoreFormatError(
      "malformed-format",
      filePath,
      "graph-store: " +
        filePath +
        " carries format_version " +
        JSON.stringify(found) +
        ", which is not a positive safe integer — this build writes " +
        String(GRAPH_STORE_FORMAT_VERSION),
      found,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (found > GRAPH_STORE_FORMAT_VERSION) {
    throw new GraphStoreFormatError(
      "newer-format",
      filePath,
      "graph-store: " +
        filePath +
        " was written with format " +
        String(found) +
        ", which is NEWER than the " +
        String(GRAPH_STORE_FORMAT_VERSION) +
        " this build writes — refusing to open a store whose layout this build cannot know",
      found,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
  if (found < GRAPH_STORE_FORMAT_VERSION) {
    throw new GraphStoreFormatError(
      "older-format",
      filePath,
      "graph-store: " +
        filePath +
        " was written with format " +
        String(found) +
        ", and this build registers no migration to " +
        String(GRAPH_STORE_FORMAT_VERSION) +
        " — refusing to downgrade, widen or recreate the store",
      found,
      GRAPH_STORE_FORMAT_VERSION,
    );
  }
}

/** Refuse one row that violates the record model (a hand-edited or foreign file). */
export function malformedRow(
  path: string,
  table: string,
  detail: string,
): GraphStoreFormatError {
  return new GraphStoreFormatError(
    "malformed-row",
    path,
    `graph-store: a ${table} row of ${path} violates the record model: ${detail}`,
    undefined,
    GRAPH_STORE_FORMAT_VERSION,
  );
}

// ── Journal-mode inspection ─────────────────────────────────────────────────

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
export function isWalStore(filePath: string): boolean {
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
