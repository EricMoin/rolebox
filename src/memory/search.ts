import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { MemoryEntry } from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("memory:search");

export interface MemorySearchOptions {
  query: string;
  scope?: string;
  category?: string;
  limit?: number;
}

/**
 * Full-text search across memories using FTS5 MATCH.
 * Returns full MemoryEntry[] ranked by relevance.
 * Supports optional scope and category filtering.
 */
export function searchMemories(db: Database, options: MemorySearchOptions): MemoryEntry[] {
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
    const rows = db.query(sql).all(...params) as Record<string, unknown>[];
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
