/**
 * Per-harness model catalog dispatch.
 *
 * {@link MODEL_SOURCES} is the one place that knows where each harness
 * declares its models. The table is exhaustive by type, so adding a
 * {@link SyncTarget} fails `bun run typecheck` until its entry exists —
 * "adding a new harness is a single-entry change" (src/platform/registry.ts:1-20).
 *
 * @module
 */

import { SyncTarget, SYNC_TARGET_VALUES } from "../../constants.ts";
import { readDshCatalog } from "./dsh.ts";
import { readOpencodeCatalog } from "./opencode.ts";
import { readPiCatalog } from "./pi.ts";
import type {
  ModelCatalogOptions,
  ModelOption,
  ModelReadOptions,
  ModelSource,
} from "./types.ts";

export type {
  ModelCatalogOptions,
  ModelOption,
  ModelReadOptions,
  ModelSource,
} from "./types.ts";

// ── Source Table ──────────────────────────────────────────────────

/**
 * Every sync target's model source, keyed by target.
 *
 * `read` is absent for a harness rolebox cannot read yet; such a target is
 * served from its `seed` instead.
 */
export const MODEL_SOURCES: Record<SyncTarget, ModelSource> = {
  [SyncTarget.Opencode]: { read: readOpencodeCatalog },
  [SyncTarget.Pi]: { read: readPiCatalog, seed: SyncTarget.Opencode },
  [SyncTarget.Dsh]: { read: readDshCatalog, seed: SyncTarget.Opencode },
  // Codex selects its model in `<codexHome>/config.toml` (`model`,
  // `model_providers`) and rolebox has no TOML reader, so it is served from
  // opencode exactly as the pre-restructure dispatcher did.
  [SyncTarget.Codex]: { seed: SyncTarget.Opencode },
};

// ── Dispatch ──────────────────────────────────────────────────────

/**
 * Resolve an untyped platform id to the catalog target that covers it.
 *
 * Lenient by contract: a known id answers itself, while an unknown or omitted
 * id falls back to opencode — the same rule `resolvePlatformPaths` uses in
 * src/platform/registry.ts. Exported so a caller holding a raw `string`
 * platform id can obtain a typed {@link SyncTarget} without duplicating the
 * known-target check.
 */
export function resolveSyncTarget(target?: string): SyncTarget {
  return SYNC_TARGET_VALUES.find((value) => value === target) ?? SyncTarget.Opencode;
}

/**
 * Build one harness's read bag from the dispatcher options.
 *
 * A pure table-independent lookup: the harness's own `configDirs` entry plus
 * the shared `projectDir`. No harness is named here, so the target and the
 * seed hop receive the identical bag shape.
 */
function readOptionsFor(
  target: SyncTarget,
  opts: ModelCatalogOptions,
): ModelReadOptions {
  return {
    configDir: opts.configDirs?.[target],
    projectDir: opts.projectDir,
  };
}

/**
 * Resolve the model options offered for a sync target.
 *
 * The target's OWN catalog is read first; when it yields no models (missing
 * file, malformed document, or an empty declaration) and the target declares a
 * `seed`, the seed's catalog is read with ITS OWN `configDirs` entry — and
 * with the seed's own default home when it has none. A target without a reader
 * (codex) is served from its seed directly. Both hops are handed the same
 * {@link ModelReadOptions} bag, so `projectDir` reaches the seed too while
 * each reader ignores what it does not use.
 *
 * An unknown or omitted target falls back to opencode, matching the lenient
 * contract of `resolvePlatformPaths` in src/platform/registry.ts.
 */
export function scanModelsForTarget(
  target: string,
  opts: ModelCatalogOptions = {},
): ModelOption[] {
  const resolved = resolveSyncTarget(target);

  const source = MODEL_SOURCES[resolved];
  const own = source.read?.(readOptionsFor(resolved, opts)) ?? [];
  if (own.length > 0 || source.seed === undefined) return own;

  const seedSource = MODEL_SOURCES[source.seed];
  return seedSource.read?.(readOptionsFor(source.seed, opts)) ?? [];
}
