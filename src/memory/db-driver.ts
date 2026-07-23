/**
 * Dual-runtime SQLite driver.
 *
 * Detects Bun vs. Node at runtime and dynamically imports the appropriate
 * sqlite module. NO static imports of `bun:sqlite` or `node:sqlite` — the
 * whole point is to avoid crashing Node when it encounters a `bun:sqlite`
 * static-import at module evaluation time.
 *
 * Under Bun:   uses `bun:sqlite` (Database)
 * Under Node:  uses `node:sqlite` (DatabaseSync / StatementSync)
 *
 * The public DatabaseDriver interface matches the subset of methods that
 * the memory module actually uses (store.ts, search.ts, schema.ts, and
 * memory-clean.ts).
 *
 * @module
 */

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

// ── Runtime detection ──────────────────────────────────────────────────────

function isBunRuntime(): boolean {
  try {
    return typeof (globalThis as any).Bun !== "undefined";
  } catch {
    return false;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a database handle using the runtime-appropriate sqlite driver.
 *
 * The `path` should be an absolute filesystem path (the directory must
 * already exist — callers are responsible for `mkdirSync(dirname(path),
 * { recursive: true })` beforehand).
 */
export async function createDatabase(path: string): Promise<DatabaseDriver> {
  if (isBunRuntime()) {
    return createBunDatabase(path);
  }
  return createNodeDatabase(path);
}

// ── Bun driver ─────────────────────────────────────────────────────────────

async function createBunDatabase(path: string): Promise<DatabaseDriver> {
  // Dynamic import — never evaluated under Node because of the runtime guard
  const { Database } = (await import("bun:sqlite")) as any;
  const db = new Database(path);

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, ...params: unknown[]): void {
      db.run(sql, params.length > 0 ? params : undefined);
    },
    query(sql: string): StatementDriver {
      const stmt = db.query(sql);
      return {
        get(...params: unknown[]) {
          return stmt.get(...params);
        },
        all(...params: unknown[]) {
          return stmt.all(...params);
        },
        run(...params: unknown[]) {
          stmt.run(...params);
        },
      };
    },
    transaction<R>(fn: () => R): () => R {
      return db.transaction(fn);
    },
    close(): void {
      db.close();
    },
  };
}

// ── Node driver ────────────────────────────────────────────────────────────

async function createNodeDatabase(path: string): Promise<DatabaseDriver> {
  // Dynamic import — never evaluated under Bun because of the runtime guard.
  // `node:sqlite` (DatabaseSync / StatementSync) is available since Node 22.5.
  const { DatabaseSync } = (await import("node:sqlite")) as any;
  const db = new DatabaseSync(path);

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, ...params: unknown[]): void {
      const stmt = db.prepare(sql);
      stmt.run(...params.length > 0 ? params : []);
    },
    query(sql: string): StatementDriver {
      const stmt = db.prepare(sql);
      return {
        get(...params: unknown[]) {
          return stmt.get(...params.length > 0 ? params : []);
        },
        all(...params: unknown[]) {
          return stmt.all(...params.length > 0 ? params : []);
        },
        run(...params: unknown[]) {
          stmt.run(...params.length > 0 ? params : []);
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
