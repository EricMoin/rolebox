/**
 * Shared types for the per-harness model catalogs.
 *
 * Each sync target owns its catalog reader under this directory
 * (`opencode.ts`, `dsh.ts`, `pi.ts`), so harness-specific knowledge about
 * where a tool declares its models lives WITH that harness rather than in the
 * CLI dispatcher (src/platform/registry.ts:1-20).
 *
 * @module
 */

import type { SyncTarget } from "../../constants.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface ModelOption {
  /** Full identifier in provider/model format, e.g. "openrouter/anthropic/claude-sonnet-4" */
  id: string;
  /** Human-readable display name from config, falls back to the model key */
  name: string;
  /** Provider key from opencode.jsonc, e.g. "openrouter" */
  provider: string;
}

/**
 * Options accepted by every harness catalog reader.
 *
 * The bag lets the dispatcher forward ONE shape to the target and to its seed
 * without naming a harness: each reader takes what it understands and ignores
 * the rest.
 */
export interface ModelReadOptions {
  /**
   * Explicit config **home directory** for this harness; omitted = the
   * harness's own platform default. The caller names the home, never the
   * document filename, so the filename stays with the harness reader.
   */
  configDir?: string;
  /**
   * Project directory whose project-level documents participate. Only the
   * opencode reader consumes it; dsh and pi have no project-level config that
   * has been measured.
   */
  projectDir?: string;
}

/** One harness's model catalog and the fallback it is seeded from. */
export interface ModelSource {
  /**
   * Read this harness's declared catalog from its config home directory.
   * Absent = rolebox cannot read it yet.
   */
  read?: (opts?: ModelReadOptions) => ModelOption[];
  /** Harness whose catalog serves this one when `read` is absent or yields nothing. */
  seed?: SyncTarget;
}

/**
 * Dispatcher options.
 *
 * `configDirs` holds an explicit config **home directory per target** — the
 * caller names the harness's home, never its document filename, so the
 * filename stays with the harness reader. That also means no option key names a
 * harness inside the dispatcher and the seed hop is testable without env vars.
 *
 * `projectDir` is the ONE project directory forwarded to every reader (the
 * target and, on the seed hop, the seed): a harness without project-level
 * config ignores it, and the opencode reader resolves its project documents
 * from it. Omitted = global-only, exactly the pre-project behaviour.
 */
export interface ModelCatalogOptions {
  configDirs?: Partial<Record<SyncTarget, string>>;
  projectDir?: string;
}
