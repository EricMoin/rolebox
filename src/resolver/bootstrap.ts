/**
 * Shared bootstrap logic for role discovery and resolution.
 *
 * Both the OpenCode plugin entry point (src/index.ts) and the Pi extension
 * (src/pi-extension.ts) need to: discover roles → resolve them → populate
 * the registry maps. This module provides a single `bootstrapRoles()` function
 * that encapsulates that flow, eliminating duplication and ensuring both
 * platforms use the same resolution logic.
 */
import { discoverRoles } from "../loader/role-loader.ts";
import { resolveAllRoles, type ResolveContext } from "./orchestrator.ts";
import type { ResolvedRole, ResolvedFunction, ResolvedGraph } from "../types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("bootstrap");

/**
 * Options for bootstrapping roles.
 */
export interface BootstrapRolesOptions {
  /** Path to the rolebox directory containing role.yaml files. */
  roleboxDir: string;
  /** Path to the global skills directory. */
  globalSkillsDir: string;
  /** OpenCode config directory (parent of rolebox/ and skills/). */
  configDir: string;
  /** Path to the built-in functions directory (rolebox package's functions/). */
  builtinDir: string;
  /** Map to populate with roleId/subagentId → resolved functions. */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /** Map to populate with roleId → resolved collaboration graph. */
  roleGraphMap: Map<string, ResolvedGraph>;
}

/**
 * Result of bootstrapping roles.
 */
export interface BootstrapRolesResult {
  /** Number of roles discovered on disk. */
  discovered: number;
  /** Number of roles successfully resolved. */
  resolved: number;
  /** Number of roles that failed resolution. */
  skipped: number;
  /** The resolved roles array. */
  resolvedRoles: ResolvedRole[];
}

/**
 * Discover and resolve all roles from the given directories.
 *
 * This is the shared entry point for both OpenCode and Pi platforms.
 * It populates the provided Maps in-place (same behavior as the original
 * inline code in index.ts and pi-extension.ts).
 */
export async function bootstrapRoles(opts: BootstrapRolesOptions): Promise<BootstrapRolesResult> {
  const { roleboxDir, globalSkillsDir, configDir, builtinDir, roleFunctionsMap, roleGraphMap } = opts;

  const roles = await discoverRoles(roleboxDir);

  const resolveCtx: ResolveContext = {
    roleboxDir,
    globalSkillsDir,
    configDir,
    builtinDir,
    roleFunctionsMap,
    roleGraphMap,
  };

  const resolvedRoles = await resolveAllRoles(roles, resolveCtx);

  const discovered = roles.size;
  const resolved = resolvedRoles.length;
  const skipped = discovered - resolved;

  log.info("Roles bootstrapped", { discovered, resolved, skipped });

  if (resolved === 0 && discovered > 0) {
    log.warn("All discovered roles failed to resolve — check role.yaml files");
  }

  return { discovered, resolved, skipped, resolvedRoles };
}
