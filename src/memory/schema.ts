import type { DatabaseDriver } from "./db-driver.ts";
import { memorySearchText } from "./normalize.ts";

/** Column/full-text definition markers used to detect the pre-bigram schema. */
const CURRENT_FTS_MARKER = "search_text";
const CURRENT_TRIGGER_MARKER = "new.search_text";

/**
 * Ensure the memory database schema exists.
 * Creates tables, FTS virtual table, triggers, and indexes for the memory store,
 * and migrates a pre-bigram database in place. All creation is idempotent.
 */
export function ensureMemorySchema(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL,
      role_id         TEXT,
      category        TEXT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags            TEXT,
      relevance       TEXT DEFAULT 'medium',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      accessed_at     TEXT,
      access_count    INTEGER DEFAULT 0,
      session_id      TEXT,
      source_sessions TEXT,
      search_text     TEXT
    )
  `);

  // A pre-bigram database has no search_text column, indexes the raw
  // title/content/tags, and its triggers copy those columns. Detect any of the
  // three and rebuild the index in place without losing a row or a field.
  if (needsMigration(db)) {
    migrate(db);
  } else {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        search_text,
        content='memories',
        content_rowid='rowid'
      )
    `);
    createTriggers(db);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scope_role ON memories(scope, role_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_category ON memories(category)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_accessed ON memories(accessed_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relevance ON memories(relevance)
  `);
}

/** True when the table, the FTS index or its triggers predate the bigram index. */
function needsMigration(db: DatabaseDriver): boolean {
  const columns = db.query("PRAGMA table_info(memories)").all() as Array<{ name?: unknown }>;
  if (!columns.some(column => column.name === "search_text")) return true;

  const fts = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'")
    .get() as { sql?: unknown } | undefined;
  if (typeof fts?.sql !== "string" || !fts.sql.includes(CURRENT_FTS_MARKER)) return true;

  const triggers = db
    .query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')")
    .all() as Array<{ name?: unknown; sql?: unknown }>;
  const current = new Set(
    triggers
      .filter(trigger => typeof trigger.sql === "string" && trigger.sql.includes(CURRENT_TRIGGER_MARKER))
      .map(trigger => trigger.name),
  );
  return !["memories_ai", "memories_ad", "memories_au"].every(name => current.has(name));
}

/**
 * Rebuild the index for a pre-bigram database: drop the triggers and the FTS
 * table, add `search_text`, backfill every row through {@link memorySearchText},
 * then recreate the FTS table and triggers and rebuild the index from the
 * content table.
 */
function migrate(db: DatabaseDriver): void {
  const migrateTransaction = db.transaction(() => {
    dropTriggers(db);
    db.exec("DROP TABLE IF EXISTS memories_fts");

    const columns = db.query("PRAGMA table_info(memories)").all() as Array<{ name?: unknown }>;
    if (!columns.some(column => column.name === "search_text")) {
      db.exec("ALTER TABLE memories ADD COLUMN search_text TEXT");
    }

    const rows = db
      .query("SELECT rowid, title, content, tags FROM memories")
      .all() as Array<{ rowid: number; title: unknown; content: unknown; tags: unknown }>;
    for (const row of rows) {
      db.run(
        "UPDATE memories SET search_text = ? WHERE rowid = ?",
        memorySearchText({
          title: String(row.title ?? ""),
          content: String(row.content ?? ""),
          tags: parseTags(row.tags),
        }),
        row.rowid,
      );
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        search_text,
        content='memories',
        content_rowid='rowid'
      )
    `);
    createTriggers(db);
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  });
  migrateTransaction();
}

/** Drop every FTS-sync trigger so a reindex cannot write a stale index. */
function dropTriggers(db: DatabaseDriver): void {
  db.exec("DROP TRIGGER IF EXISTS memories_ai");
  db.exec("DROP TRIGGER IF EXISTS memories_ad");
  db.exec("DROP TRIGGER IF EXISTS memories_au");
}

/** Create the INSERT/DELETE/UPDATE triggers that keep the FTS index in sync. */
function createTriggers(db: DatabaseDriver): void {
  // INSERT trigger — keeps FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, search_text)
      VALUES (new.rowid, new.search_text);
    END
  `);

  // DELETE trigger — removes entry from FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, search_text)
      VALUES ('delete', old.rowid, old.search_text);
    END
  `);

  // UPDATE trigger — re-indexes in FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, search_text)
      VALUES ('delete', old.rowid, old.search_text);
      INSERT INTO memories_fts(rowid, search_text)
      VALUES (new.rowid, new.search_text);
    END
  `);
}

/** Parse the stored tags JSON into a string array, tolerating bad values. */
function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === "string") : [];
  } catch {
    return [];
  }
}
