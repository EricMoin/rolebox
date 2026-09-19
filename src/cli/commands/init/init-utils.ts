import { existsSync, readdirSync } from "node:fs";
import { ROLE_YAML } from "../../../constants.ts";
import { err, ok, type Result } from "../../../utils/result.ts";

/**
 * Validates a role ID string against naming rules.
 *
 * Rules:
 * - Non-empty
 * - No `--` (double dash — reserved for parent/child separator)
 * - No path separators (`/`, `\`)
 * - Only ASCII alphanumeric + single hyphens + underscores
 * - Length 1–100 characters
 * - Auto-lowercase on normalization
 *
 * @param input - The raw role ID string to validate.
 * @returns `ok({ normalized })` with the normalized (lowercased) ID, or
 *   `err(reason)` when a rule is violated. A rejected input carries no
 *   normalized value — callers keep their own input on that path.
 */
export function validateInitRoleId(input: string): Result<{ normalized: string }, string> {
  if (input === "") {
    return err("Role ID must not be empty");
  }

  let normalized = input.toLowerCase().replace(/\s+/g, "-");

  if (normalized.length > 100) {
    return err("Role ID must be 1–100 characters");
  }

  if (normalized.includes("--")) {
    return err("Role ID must not contain '--' (reserved)");
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    return err("Role ID must not contain path separators");
  }

  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return err("Role ID may only contain ASCII letters, digits, hyphens, and underscores");
  }

  return ok({ normalized });
}

/**
 * Derives a valid role ID from a directory name.
 *
 * - Lowercases the input
 * - Replaces spaces with single hyphens
 * - Strips non-ASCII / non-alphanumeric except hyphens and underscores
 *
 * @param dirName - The raw directory name.
 * @returns A sanitized role ID string.
 */
export function deriveRoleId(dirName: string): string {
  return dirName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Checks the state of a target directory for role initialization.
 *
 * @param targetPath - Absolute path to the target directory.
 * @returns Object with `exists`, `hasRoleYaml`, and `isEmpty` flags.
 */
export function checkTargetDir(targetPath: string): {
  exists: boolean;
  hasRoleYaml: boolean;
  isEmpty: boolean;
} {
  if (!existsSync(targetPath)) {
    return { exists: false, hasRoleYaml: false, isEmpty: true };
  }

  const entries = readdirSync(targetPath);
  const filtered = entries.filter((e) => e !== "." && e !== "..");

  return {
    exists: true,
    hasRoleYaml: filtered.includes(ROLE_YAML),
    isEmpty: filtered.length === 0,
  };
}
