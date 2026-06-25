import { existsSync, readdirSync } from "node:fs";

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
 * @returns Validation result with normalized (lowercased) ID or error.
 */
export function validateInitRoleId(input: string): {
  valid: boolean;
  error?: string;
  normalized: string;
} {
  if (input === "") {
    return { valid: false, error: "Role ID must not be empty", normalized: input };
  }

  let normalized = input.toLowerCase().replace(/\s+/g, "-");

  if (normalized.length > 100) {
    return { valid: false, error: "Role ID must be 1–100 characters", normalized: input };
  }

  if (normalized.includes("--")) {
    return { valid: false, error: "Role ID must not contain '--' (reserved)", normalized: input };
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    return { valid: false, error: "Role ID must not contain path separators", normalized: input };
  }

  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    return {
      valid: false,
      error: "Role ID may only contain ASCII letters, digits, hyphens, and underscores",
      normalized: input,
    };
  }

  return { valid: true, normalized };
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
    hasRoleYaml: filtered.includes("role.yaml"),
    isEmpty: filtered.length === 0,
  };
}
