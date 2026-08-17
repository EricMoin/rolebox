/**
 * Shared initialization helpers for rolebox entry points.
 *
 * Both the Opencode plugin (src/index.ts) and the Pi extension
 * (src/pi-extension.ts) need to resolve directory paths and bootstrap
 * roles. This module provides two helpers that eliminate the ~80 lines
 * of duplicated logic between the two entry points:
 *
 *   resolveRoleboxDirectories() — delegates to R5's PlatformPaths
 *     registry to determine configDir, skillsDir, etc., with
 *     working-directory-aware roleboxDir fallback.
 *
 *   initializeRoleboxRuntime() — calls bootstrapRoles() and
 *     optionally syncAllAgents() via the provided registrar,
 *     returning the bootstrap result.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePlatformPaths } from "./registry.ts";
import { bootstrapRoles, type BootstrapRolesResult } from "../resolver/bootstrap.ts";
import { syncAllAgents } from "../sync/agent-files.ts";
import type { IAgentRegistrar } from "./ports/agent-registrar.ts";
import type { ResolvedFunction, ResolvedGraph } from "../types.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Resolved directory paths for rolebox initialization. */
export interface RoleboxDirectories {
  /** Path to the rolebox directory containing role.yaml files. */
  roleboxDir: string;
  /** Path to the global skills directory. */
  globalSkillsDir: string;
  /** Platform configuration directory (e.g. ~/.config/opencode). */
  configDir: string;
  /** Path to the built-in functions directory (package root's functions/). */
  builtinDir: string;
}

/** Options for resolveRoleboxDirectories(). */
export interface ResolveDirectoriesOptions {
  /**
   * Working directory — used to check for a local `rolebox/` subdirectory.
   * Defaults to `process.cwd()`.
   */
  workingDir?: string;
  /**
   * Platform identifier — selects which PlatformPaths to delegate to.
   * - `"opencode"` (default) → `defaultPlatformPaths()` → `~/.config/opencode`
   * - `"pi"` → `piPlatformPaths()` → `~/.pi/agent`
   * - `"dsh"` → `dshPlatformPaths()` → `$DSH_HOME` or `~/.dsh`
   */
  platformId?: string;
}

/** Options for initializeRoleboxRuntime(). */
export interface InitializeRuntimeOptions {
  /** Resolved directory paths (from resolveRoleboxDirectories). */
  directories: RoleboxDirectories;
  /** Map to populate with roleId/subagentId → resolved functions (mutated in-place). */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /** Map to populate with roleId → resolved collaboration graph (mutated in-place). */
  roleGraphMap: Map<string, ResolvedGraph>;
  /**
   * Optional agent registrar. When provided, syncAllAgents() is called
   * after bootstrapRoles() to register agents with the host platform.
   * When omitted, agent sync is skipped (caller handles it separately).
   */
  registrar?: IAgentRegistrar;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve rolebox directory paths for the given platform and working directory.
 *
 * Delegates to R5's `PlatformPaths` registry to determine platform-specific
 * paths (configDir, skillsDir). The `roleboxDir` is resolved with a working-
 * directory-aware fallback: it checks for `{workingDir}/rolebox` first, and
 * falls back to `{configDir}/rolebox` if that does not exist.
 *
 * The `builtinDir` is always resolved relative to the package root
 * (the `functions/` directory shipped with the rolebox package).
 */
export function resolveRoleboxDirectories(
  opts: ResolveDirectoriesOptions = {},
): RoleboxDirectories {
  const workingDir = opts.workingDir ?? process.cwd();
  const platformId = opts.platformId ?? "opencode";
  const paths = resolvePlatformPaths(platformId);

  const cwdRoleboxDir = path.join(workingDir, "rolebox");
  const roleboxDir = existsSync(cwdRoleboxDir)
    ? cwdRoleboxDir
    : path.join(paths.configDir, "rolebox");
  const globalSkillsDir = paths.skillsDir;

  // builtinDir: package-root/functions/.  factory.ts lives in src/platform/,
  // so two levels up to reach the package root.
  const builtinDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "functions",
  );

  return { roleboxDir, globalSkillsDir, configDir: paths.configDir, builtinDir };
}

/**
 * Bootstrap roles and optionally sync agents to the host platform.
 *
 * Calls `bootstrapRoles()` with the resolved directories and shared state
 * maps, then optionally calls `syncAllAgents()` if a registrar is provided.
 * Returns the bootstrap result with discovered/resolved/skipped counts and
 * the resolved role array.
 */
export async function initializeRoleboxRuntime(
  opts: InitializeRuntimeOptions,
): Promise<BootstrapRolesResult> {
  const { directories: dirs, roleFunctionsMap, roleGraphMap, registrar } = opts;

  const result = await bootstrapRoles({
    roleboxDir: dirs.roleboxDir,
    globalSkillsDir: dirs.globalSkillsDir,
    configDir: dirs.configDir,
    builtinDir: dirs.builtinDir,
    roleFunctionsMap,
    roleGraphMap,
  });

  if (registrar) {
    await syncAllAgents(result.resolvedRoles, registrar);
  }

  return result;
}
