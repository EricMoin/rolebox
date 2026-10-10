import { DEFAULT_GIT_BRANCH } from "../constants.ts";
import type { RegistryEntry, RegistryManifest, RoleboxConfig } from "./types.ts";

/**
 * Role sources: the built-in registry plus every source the user added on top of
 * it. This module is the single owner of "which sources exist and in what order
 * they are consulted" — it is pure (no fs, no network, no config loading) so the
 * commands, the pickers and the tests all resolve sources the same way.
 */

/** Name of the source that ships with rolebox. */
export const BUILTIN_REGISTRY_NAME = "oh-my-role";

/** The source that ships with rolebox, used when the config does not name it. */
export const BUILTIN_REGISTRY: Readonly<RegistryEntry> = {
  name: BUILTIN_REGISTRY_NAME,
  url: "https://github.com/EricMoin/oh-my-role",
  default: true,
};

/** A configured source plus the resolved built-in flag. */
export interface ResolvedRegistry extends RegistryEntry {
  readonly builtin: boolean;
}

/**
 * Expand a config's `registries` into the effective source list.
 *
 * `registries: []` is an explicit opt-out — it means "no sources" and stays
 * empty. Otherwise the built-in source is always available: an entry named
 * `oh-my-role` in the file IS the built-in (keeping its own url/ref) and is
 * listed first; a file that does not name it gets the shipped default
 * prepended. Every entry is copied, so callers can normalize or edit the result
 * without writing those changes back into the user's config.
 *
 * The built-in's `default` flag is normalized so no two sources claim it: a
 * custom entry with `default: true` demotes the built-in, and the built-in is
 * the fallback default when nothing else claims it.
 */
export function effectiveRegistries(config: RoleboxConfig): ResolvedRegistry[] {
  if (config.registries.length === 0) return [];

  const builtinIndex = config.registries.findIndex((r) => r.name === BUILTIN_REGISTRY_NAME);
  const builtinEntry = builtinIndex === -1 ? BUILTIN_REGISTRY : config.registries[builtinIndex];
  const customEntries = config.registries.filter((_, index) => index !== builtinIndex);
  const customClaimsDefault = customEntries.some((r) => r.default === true);

  return [
    { ...builtinEntry, builtin: true, default: !customClaimsDefault },
    ...customEntries.map((entry) => ({ ...entry, builtin: false })),
  ];
}

/**
 * The source an unprefixed role is resolved from: the first entry flagged
 * `default`, else the first effective source. `undefined` when no source is
 * configured at all.
 */
export function defaultRegistry(config: RoleboxConfig): ResolvedRegistry | undefined {
  const registries = effectiveRegistries(config);
  return registries.find((r) => r.default === true) ?? registries[0];
}

/** Look an effective source up by exact name. */
export function findRegistry(config: RoleboxConfig, name: string): ResolvedRegistry | undefined {
  return effectiveRegistries(config).find((r) => r.name === name);
}

/** Whether `name` is the built-in source's name. */
export function isBuiltinName(name: string): boolean {
  return name === BUILTIN_REGISTRY_NAME;
}

/**
 * The order sources are consulted in when a role is named without a source: the
 * default source first, then the rest in config order.
 */
export function lookupOrder(config: RoleboxConfig): ResolvedRegistry[] {
  const registries = effectiveRegistries(config);
  const preferred = defaultRegistry(config);
  if (!preferred) return registries;
  return [preferred, ...registries.filter((r) => r.name !== preferred.name)];
}

/** The source that publishes a role, with the manifest it was found in. */
export interface RoleSourceMatch {
  registry: ResolvedRegistry;
  manifest: RegistryManifest;
}

/** A source whose manifest could not be fetched, and why. */
export interface RoleSourceFailure {
  registry: ResolvedRegistry;
  message: string;
}

export interface RoleLookupResult {
  match?: RoleSourceMatch;
  failures: RoleSourceFailure[];
  /** Sources that answered but do not publish the role. */
  searched: string[];
}

/**
 * Find the first source (in lookup order) that publishes `roleId`.
 *
 * The manifest is returned with the match so the caller never re-fetches it.
 * A source that cannot be fetched is recorded in `failures` and skipped rather
 * than failing the lookup — one unreachable source must not hide a role another
 * one publishes.
 */
export async function resolveRoleSource(
  roleId: string,
  config: RoleboxConfig,
  opts: {
    fetchManifest: (
      registry: RegistryEntry,
      ref: string | undefined,
      options: { noCache?: boolean },
    ) => Promise<RegistryManifest>;
    noCache?: boolean;
  },
): Promise<RoleLookupResult> {
  const failures: RoleSourceFailure[] = [];
  const searched: string[] = [];

  for (const registry of lookupOrder(config)) {
    const ref = registry.ref ?? DEFAULT_GIT_BRANCH;
    let manifest: RegistryManifest;
    try {
      manifest = await opts.fetchManifest(registry, ref, { noCache: opts.noCache });
    } catch (err) {
      failures.push({
        registry,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (manifest.roles[roleId]) {
      return { match: { registry, manifest }, failures, searched };
    }
    searched.push(registry.name);
  }

  return { failures, searched };
}
