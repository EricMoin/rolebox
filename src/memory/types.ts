/**
 * Memory-domain types extracted from types.core.ts.
 * Consumers continue importing via the top-level types.ts barrel.
 */

/**
 * Memory configuration in role.yaml.
 * Controls how memories are injected into the system prompt.
 */
export interface MemoryConfig {
  /** Whether to auto-inject the `## Available memory` block at session start (default: true) */
  inject?: boolean;
  /** Max memory summaries to inject into system prompt, from 0 to 100 (default: 10) */
  max_inject?: number;
  /** Minimum relevance level to inject: "high" | "medium" | "low" (default: "medium") */
  min_relevance?: "high" | "medium" | "low";
  /** Which scope to inject: "role" | "workspace" | "both" (default: "both") */
  scope?: "role" | "workspace" | "both";
  /** Keep and inject a session-focus memory entry across dsh compaction (DSH only; default: true) */
  session_focus?: boolean;
  /**
   * Inject a per-turn block of memories retrieved from the current DSH user
   * prompt (DSH only; default: true).
   */
  recall?: boolean;
  /**
   * How turn recall builds its queries (DSH only; default: "auto").
   *
   * `auto` searches with the prompt first and runs the one-shot LLM query
   * scout only when workspace memory is large (at least 20 entries by default)
   * and the deterministic search is weak (fewer than two hits). `always` runs
   * the scout on every new human prompt; `deterministic` never runs it.
   */
  recall_mode?: "auto" | "always" | "deterministic";
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
