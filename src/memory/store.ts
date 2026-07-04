import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { memoryDbPath, shortHash } from "../state-paths.ts";
import { createSubLogger } from "../logger.ts";
import type { MemoryEntry, MemorySummary } from "../types.ts";

const log = createSubLogger("memory:store");

export interface MemoryListOptions {
  scope?: string;
  category?: string;
  limit?: number;
  sort?: "recent" | "relevance" | "accessed";
  minRelevance?: string;
}

export interface MemorySearchOptions {
  query: string;
  scope?: string;
  category?: string;
  limit?: number;
}

export class MemoryStore {
  private db: Database;

  constructor(private workspaceDir: string) {
    const path = memoryDbPath(workspaceDir);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.ensureSchema();
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    this.db.exec(`
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

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, tags,
        content='memories',
        content_rowid='rowid'
      )
    `);

    // INSERT trigger — keeps FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END
    `);

    // DELETE trigger — removes entry from FTS
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END
    `);

    // UPDATE trigger — re-indexes in FTS
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scope_role ON memories(scope, role_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_category ON memories(category)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_accessed ON memories(accessed_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relevance ON memories(relevance)
    `);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Write a new memory entry. Generates the ID from title + timestamp,
   * sets timestamps, and inserts atomically. Returns the new ID.
   */
  write(
    entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at" | "accessed_at" | "access_count">,
  ): string {
    const id = shortHash(`${entry.title}${Date.now()}`);
    const now = new Date().toISOString();

    const doWrite = this.db.transaction((): string => {
      this.db.run(
        `INSERT INTO memories (id, scope, role_id, category, title, content, tags, relevance, created_at, updated_at, session_id, source_sessions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          entry.scope,
          entry.role_id,
          entry.category,
          entry.title,
          entry.content,
          JSON.stringify(entry.tags ?? []),
          entry.relevance ?? "medium",
          now,
          now,
          entry.session_id,
          JSON.stringify(entry.source_sessions ?? []),
        ],
      );
      return id;
    });

    return doWrite();
  }

  /**
   * Read a memory entry by ID. Returns null if not found.
   * Parses `tags` and `source_sessions` from JSON strings to arrays.
   */
  read(id: string): MemoryEntry | null {
    try {
      const row = this.db
        .query("SELECT * FROM memories WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!row) return null;

      return {
        ...row,
        tags: parseJsonArray(row.tags),
        source_sessions: parseJsonArray(row.source_sessions),
        access_count: Number(row.access_count),
      } as MemoryEntry;
    } catch (err) {
      log.warn("memory read failed", { id, error: String(err) });
      return null;
    }
  }

  /**
   * Update an existing memory entry. Only the provided fields are changed.
   * Automatically sets `updated_at` to the current time.
   * Serializes `tags` and `source_sessions` to JSON strings if present.
   */
  update(id: string, fields: Partial<MemoryEntry>): void {
    const doUpdate = this.db.transaction(() => {
      const now = new Date().toISOString();
      const sets: string[] = [];
      const params: SQLQueryBindings[] = [];

      const fieldMap: Array<[keyof MemoryEntry, string]> = [
        ["scope", "scope"],
        ["role_id", "role_id"],
        ["category", "category"],
        ["title", "title"],
        ["content", "content"],
        ["relevance", "relevance"],
        ["session_id", "session_id"],
      ];

      for (const [key, col] of fieldMap) {
        if (fields[key] !== undefined) {
          sets.push(`${col} = ?`);
          params.push(fields[key] as SQLQueryBindings);
        }
      }

      if (fields.tags !== undefined) {
        sets.push("tags = ?");
        params.push(JSON.stringify(fields.tags));
      }

      if (fields.source_sessions !== undefined) {
        sets.push("source_sessions = ?");
        params.push(JSON.stringify(fields.source_sessions));
      }

      sets.push("updated_at = ?");
      params.push(now);

      if (sets.length === 1) {
        // Only updated_at was pushed — nothing to update beyond that
        params.push(id);
        this.db.run("UPDATE memories SET updated_at = ? WHERE id = ?", params);
        return;
      }

      const sql = `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`;
      params.push(id);
      this.db.run(sql, params);
    });

    doUpdate();
  }

  /**
   * Delete a memory entry by ID. The AFTER DELETE trigger cleans up the FTS index.
   */
  delete(id: string): void {
    this.db.run("DELETE FROM memories WHERE id = ?", [id]);
  }

  // ── Query ───────────────────────────────────────────────────────────────

  /**
   * List memory summaries with optional filters.
   * Returns only summary fields (id, title, category, relevance, updated_at).
   */
  list(options?: MemoryListOptions): MemorySummary[] {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    // Scope filtering
    if (options?.scope && options.scope !== "both") {
      conditions.push("scope = ?");
      params.push(options.scope);
    }

    // Category filtering
    if (options?.category) {
      conditions.push("category = ?");
      params.push(options.category);
    }

    // Relevance filtering
    if (options?.minRelevance && options.minRelevance !== "low") {
      const levels = relevanceLevels(options.minRelevance);
      const placeholders = levels.map(() => "?").join(", ");
      conditions.push(`relevance IN (${placeholders})`);
      for (const level of levels) {
        params.push(level);
      }
    }

    // Sorting
    let orderClause: string;
    switch (options?.sort) {
      case "relevance":
        orderClause = "ORDER BY CASE relevance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END";
        break;
      case "accessed":
        orderClause = "ORDER BY accessed_at DESC NULLS LAST";
        break;
      case "recent":
      default:
        orderClause = "ORDER BY updated_at DESC";
        break;
    }

    // Limit
    const limit = options?.limit ?? 20;

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, title, category, relevance, updated_at FROM memories ${where} ${orderClause} LIMIT ?`;

    params.push(limit);

    try {
      return this.db.query(sql).all(...params) as MemorySummary[];
    } catch (err) {
      log.warn("memory list query failed", { error: String(err) });
      return [];
    }
  }

  /**
   * Full-text search across memories using FTS5 MATCH.
   * Returns full MemoryEntry[] ranked by relevance.
   * Supports optional scope and category filtering.
   */
  search(options: MemorySearchOptions): MemoryEntry[] {
    const conditions: string[] = [];
    const params: SQLQueryBindings[] = [];

    // Escape double quotes in the query to prevent FTS syntax errors
    const ftsQuery = options.query.replace(/"/g, "\"\"");
    params.push(ftsQuery);

    // Use a JOIN with the FTS table to access the `rank` column for ordering
    conditions.push("memories_fts MATCH ?");

    // Scope filtering
    if (options?.scope && options.scope !== "both") {
      conditions.push("m.scope = ?");
      params.push(options.scope);
    }

    // Category filtering
    if (options?.category) {
      conditions.push("m.category = ?");
      params.push(options.category);
    }

    const limit = options?.limit ?? 10;
    const where = conditions.join(" AND ");
    const sql = `SELECT m.* FROM memories m INNER JOIN memories_fts ON m.rowid = memories_fts.rowid WHERE ${where} ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
      return rows.map((row) => ({
        ...row,
        tags: parseJsonArray(row.tags),
        source_sessions: parseJsonArray(row.source_sessions),
        access_count: Number(row.access_count),
      })) as MemoryEntry[];
    } catch (err) {
      log.warn("memory search query failed", { query: options.query, error: String(err) });
      return [];
    }
  }

  /**
   * Update the accessed_at timestamp and increment access_count for a memory.
   * Called when a memory is recalled via search or direct read.
   */
  touch(id: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?", [now, id]);
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  /**
   * Return aggregated statistics about the memory store.
   */
  stats(): {
    total: number;
    byScope: Record<string, number>;
    byCategory: Record<string, number>;
    byRelevance: Record<string, number>;
  } {
    try {
      const total = (
        this.db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number }
      ).count;

      const byScope = this.db
        .query("SELECT scope, COUNT(*) as count FROM memories GROUP BY scope")
        .all() as { scope: string; count: number }[];

      const byCategory = this.db
        .query("SELECT category, COUNT(*) as count FROM memories GROUP BY category")
        .all() as { category: string; count: number }[];

      const byRelevance = this.db
        .query("SELECT relevance, COUNT(*) as count FROM memories GROUP BY relevance")
        .all() as { relevance: string; count: number }[];

      return {
        total,
        byScope: toRecord(byScope, "scope"),
        byCategory: toRecord(byCategory, "category"),
        byRelevance: toRecord(byRelevance, "relevance"),
      };
    } catch (err) {
      log.warn("memory stats query failed", { error: String(err) });
      return { total: 0, byScope: {}, byCategory: {}, byRelevance: {} };
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Close the database connection. Call when the store is no longer needed.
   */
  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn("memory store close error", { error: String(err) });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse a value from SQLite as a JSON array.
 * Returns an empty array for null, undefined, or invalid values.
 */
function parseJsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(value as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Convert an array of { key, count } objects to a Record<string, number>.
 */
function toRecord(
  rows: Record<string, unknown>[],
  keyField: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[String(row[keyField])] = Number(row.count);
  }
  return result;
}

/**
 * Return the relevance levels that satisfy a given minimum relevance filter.
 * "high" → ["high"]; "medium" → ["high", "medium"]; "low" → ["high", "medium", "low"].
 */
function relevanceLevels(minRelevance: string): string[] {
  const order = ["high", "medium", "low"];
  const idx = order.indexOf(minRelevance);
  if (idx === -1) return [];
  return order.slice(0, idx + 1);
}
