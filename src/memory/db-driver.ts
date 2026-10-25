import { createRequire } from "node:module";

/** How a database file is opened. */
export interface DatabaseOpenOptions {
  /**
   * Open the file READ-ONLY.
   *
   * The connection then refuses every write at the SQLite layer, which is what
   * makes a read-only consumer (the graph drain audit) read-only BY
   * CONSTRUCTION rather than by convention. Defaults to `false` — the
   * existing read/write open is byte-for-byte unchanged.
   */
  readonly readonly?: boolean;
}

/** Thin abstraction over a single prepared statement. */
export interface StatementDriver {
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

/** Thin abstraction over an SQLite database connection. */
export interface DatabaseDriver {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  query(sql: string): StatementDriver;
  transaction<R>(fn: () => R): () => R;
  close(): void;
}

/** The `node:sqlite` surface this driver uses. */
interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface NodeSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NodeSqliteStatement;
  close(): unknown;
}

/** Opens a private connection; the parent directory must already exist. */
export async function createDatabase(
  path: string,
  options: DatabaseOpenOptions = {},
): Promise<DatabaseDriver> {
  return createDatabaseSync(path, options);
}

/** Synchronous entry for host capabilities constructed during setup. */
export function createDatabaseSync(
  path: string,
  options: DatabaseOpenOptions = {},
): DatabaseDriver {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => NodeSqliteDatabase;
  };
  const db =
    options.readonly === true
      ? new DatabaseSync(path, { readOnly: true })
      : new DatabaseSync(path);
  const statement = (sql: string): NodeSqliteStatement => db.prepare(sql);
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, ...params: unknown[]): void {
      statement(sql).run(...params);
    },
    query(sql: string): StatementDriver {
      const stmt = statement(sql);
      return {
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
        run: (...params: unknown[]) => {
          stmt.run(...params);
        },
      };
    },
    transaction<R>(fn: () => R): () => R {
      return () => {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      };
    },
    close(): void {
      db.close();
    },
  };
}
