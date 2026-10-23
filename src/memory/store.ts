import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { type DatabaseDriver, createDatabase, createDatabaseSync } from "./db-driver.ts";
import { memoryDbPath } from "../utils/state-paths.ts";
import { createSubLogger } from "../logger.ts";
import { logEvent } from "../log/index.ts";
import type { MemoryEntry, MemorySummary } from "../types.ts";
import { ensureMemorySchema } from "./schema.ts";
import { searchMemories, type MemorySearchOptions } from "./search.ts";
import { memoryVisibility } from "./visibility.ts";

const log = createSubLogger("memory:store");

export interface MemoryListOptions {
  /** Undefined allows administrative access; an empty string allows only workspace entries. */
  roleId?: string;
  scope?: string;
  category?: string;
  limit?: number;
  offset?: number;
  sort?: "recent" | "relevance" | "accessed";
  minRelevance?: string;
}

export interface MemoryListSummary extends MemorySummary {
  scope: string;
  role_id: string;
  source_sessions: string[];
}

export type { MemorySearchOptions } from "./search.ts";

export class MemoryStore {
  private db: DatabaseDriver;

  private constructor(db: DatabaseDriver) {
    this.db = db;
  }

  /**
   * Async factory: resolve the runtime driver (Bun or Node), open the
   * database, and run schema migration.
   */
  static async create(workspaceDir: string): Promise<MemoryStore> {
    const path = memoryDbPath(workspaceDir);
    mkdirSync(dirname(path), { recursive: true });
    const db = await createDatabase(path);
    return MemoryStore.initialize(db);
  }

  /** Open synchronously for host prompt providers that cannot await. */
  static open(workspaceDir: string): MemoryStore {
    const path = memoryDbPath(workspaceDir);
    mkdirSync(dirname(path), { recursive: true });
    return MemoryStore.initialize(createDatabaseSync(path));
  }

  private static initialize(db: DatabaseDriver): MemoryStore {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      const store = new MemoryStore(db);
      store.ensureSchema();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    ensureMemorySchema(this.db);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Write a new memory entry. Generates an independent ID,
   * sets timestamps, and inserts atomically. Returns the new ID.
   */
  write(
    entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at" | "accessed_at" | "access_count">,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const doWrite = this.db.transaction((): string => {
      this.db.run(
        `INSERT INTO memories (id, scope, role_id, category, title, content, tags, relevance, created_at, updated_at, session_id, source_sessions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      return id;
    });

    return doWrite();
  }

  /**
   * Read a memory entry by ID. Returns null if not found.
   * Parses `tags` and `source_sessions` from JSON strings to arrays.
   */
  read(id: string, roleId?: string): MemoryEntry | null {
    try {
      const visibility = memoryVisibility(roleId);
      const row = this.db
        .query(`SELECT * FROM memories WHERE id = ? AND ${visibility.sql}`)
        .get(id, ...visibility.params) as Record<string, unknown> | undefined;

      if (!row) return null;

      return {
        ...row,
        tags: parseJsonArray(row.tags),
        source_sessions: parseJsonArray(row.source_sessions),
        access_count: Number(row.access_count),
      } as MemoryEntry;
    } catch (err) {
      logEvent("store.read-failed", { id, error: String(err) });
      return null;
    }
  }

  /**
   * Update an existing memory entry. Only the provided fields are changed.
   * Automatically sets `updated_at` to the current time.
   * Merges source sessions so provenance survives later updates.
   */
  update(id: string, fields: Partial<MemoryEntry>, roleId?: string): boolean {
    const doUpdate = this.db.transaction(() => {
      const existing = this.read(id, roleId);
      if (!existing) return false;
      if (roleId !== undefined &&
          ((fields.scope !== undefined && fields.scope !== existing.scope) ||
           (fields.role_id !== undefined && fields.role_id !== existing.role_id))) return false;
      const now = new Date().toISOString();
      const sets: string[] = [];
      const params: unknown[] = [];

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
          params.push(fields[key]);
        }
      }

      if (fields.tags !== undefined) {
        sets.push("tags = ?");
        params.push(JSON.stringify(fields.tags));
      }

      if (fields.source_sessions !== undefined) {
        sets.push("source_sessions = ?");
        params.push(JSON.stringify([...new Set([...existing.source_sessions, ...fields.source_sessions])]));
      }

      sets.push("updated_at = ?");
      params.push(now);

      const sql = `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`;
      params.push(id);
      this.db.run(sql, ...params);
      return true;
    });

    return doUpdate();
  }

  /**
   * Delete a memory entry by ID. The AFTER DELETE trigger cleans up the FTS index.
   */
  delete(id: string): void {
    this.db.run("DELETE FROM memories WHERE id = ?", id);
  }

  // ── Query ───────────────────────────────────────────────────────────────

  /**
   * List memory summaries with optional filters.
   * Includes identity and provenance, but not memory content.
   */
  list(options?: MemoryListOptions): MemoryListSummary[] {
    const visibility = memoryVisibility(options?.roleId);
    const conditions: string[] = [visibility.sql];
    const params: unknown[] = [...visibility.params];

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
    const sql = `SELECT id, title, category, relevance, updated_at, scope, role_id, source_sessions FROM memories ${where} ${orderClause}, id LIMIT ? OFFSET ?`;

    params.push(limit, options?.offset ?? 0);

    try {
      const rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
      return rows.map(row => ({ ...row, source_sessions: parseJsonArray(row.source_sessions) })) as MemoryListSummary[];
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
    return searchMemories(this.db, options);
  }

  /**
   * Update the accessed_at timestamp and increment access_count for a memory.
   * Called when a memory is recalled via search or direct read.
   */
  touch(id: string): void {
    const now = new Date().toISOString();
    this.db.run("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?", now, id);
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
