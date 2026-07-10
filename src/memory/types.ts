/**
 * Memory-domain types extracted from types.core.ts.
 * Consumers continue importing via the top-level types.ts barrel.
 */

/**
 * Memory configuration in role.yaml.
 * Controls how memories are injected into the system prompt.
 */
export interface MemoryConfig {
  /** Whether to auto-inject <available_memory> block at session start (default: true) */
  inject?: boolean;
  /** Max memory summaries to inject into system prompt (default: 10) */
  max_inject?: number;
  /** Minimum relevance level to inject: "high" | "medium" | "low" (default: "medium") */
  min_relevance?: string;
  /** Which scope to inject: "role" | "workspace" | "both" (default: "both") */
  scope?: string;
}

/**
 * A memory entry returned by list/search/store.read.
 */
export interface MemoryEntry {
  id: string;
  scope: string;
  role_id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  relevance: string;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  session_id: string | null;
  source_sessions: string[];
}

/**
 * A memory summary for injection (lighter weight — no full content).
 */
export interface MemorySummary {
  id: string;
  title: string;
  category: string;
  relevance: string;
  updated_at: string;
}
