/**
 * Project-level rolebox configuration.
 *
 * Reads `.rolebox/config.json` from the workspace root to determine
 * project-specific role overrides (e.g. which role is "primary").
 *
 * This is read once during plugin initialization. There is no file watching.
 * If the file does not exist or is invalid, the system falls back to defaults
 * (fully backward compatible).
 *
 * @module
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ResolvedRole } from "./types.ts";
import { createSubLogger } from "./logger.ts";

const log = createSubLogger("project-config");

/**
 * Project-level configuration loaded from `.rolebox/config.json`.
 */
export interface ProjectConfig {
  /**
   * Role ID (directory name) to set as the default "primary" role.
   * All other roles that were "primary" are demoted to "all".
   */
  defaultRole?: string;
}

/**
 * Load project config from `{workspaceDir}/.rolebox/config.json`.
 *
 * Reads and validates the config file. If the file does not exist, contains
 * invalid JSON, or has an invalid schema, returns `null` (never throws).
 * Warnings are logged for recoverable errors.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @returns Parsed ProjectConfig or null on any failure.
 */
export function loadProjectConfig(workspaceDir: string): ProjectConfig | null {
  try {
    const configPath = path.join(workspaceDir, ".rolebox", "config.json");

    if (!existsSync(configPath)) {
      return null;
    }

    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log.warn("Project config must be a JSON object, ignoring");
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.defaultRole !== undefined && typeof obj.defaultRole !== "string") {
      log.warn("Project config 'defaultRole' must be a string, ignoring");
      return null;
    }

    return { defaultRole: obj.defaultRole as string | undefined };
  } catch (err) {
    log.warn("Failed to load project config", { error: String(err) });
    return null;
  }
}

/**
 * Apply project-level config to resolved roles.
 *
 * If `defaultRole` is specified and matches an existing role:
 * - Sets that role's mode to `"primary"`.
 * - Sets all other roles with `mode === "primary"` or `mode === undefined`
 *   to `"all"` (non-default but still available).
 *
 * This ensures only the project-designated role is the default agent.
 * Roles with explicit `"subagent"` or `"all"` mode are left unchanged
 * (except the target role which is always promoted to "primary").
 *
 * If `defaultRole` does not match any resolved role, a warning is logged
 * and no changes are made.
 *
 * @param resolvedRoles - Array of fully resolved roles.
 * @param config - Project configuration (must have defaultRole set).
 */
export function applyProjectConfig(resolvedRoles: ResolvedRole[], config: ProjectConfig): void {
  if (!config.defaultRole) return;

  const targetRole = resolvedRoles.find((r) => r.id === config.defaultRole);
  if (!targetRole) {
    log.warn(`Project config defaultRole "${config.defaultRole}" not found in resolved roles`);
    return;
  }

  // Demote all current primaries (roles with mode "primary" or undefined)
  for (const role of resolvedRoles) {
    if (role.config.mode === "primary" || role.config.mode === undefined) {
      role.config.mode = "all";
    }
  }

  // Promote the designated target role
  targetRole.config.mode = "primary";
  log.info("Project config applied", { defaultRole: config.defaultRole });
}
