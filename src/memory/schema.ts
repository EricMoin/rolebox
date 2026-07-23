import type { DatabaseDriver } from "./db-driver.ts";

/**
 * Ensure the memory database schema exists.
 * Creates tables, FTS virtual table, triggers, and indexes for the memory store.
 * All statements use IF NOT EXISTS — safe to call repeatedly (idempotent).
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
      source_sessions TEXT
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title, content, tags,
      content='memories',
      content_rowid='rowid'
    )
  `);

  // INSERT trigger — keeps FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END
  `);

  // DELETE trigger — removes entry from FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END
  `);

  // UPDATE trigger — re-indexes in FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO memories_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END
  `);

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
