/**
 * Role-side model helpers: reading the `model:` field out of rolebox's own
 * `role.yaml` files and classifying a model string as a placeholder that still
 * needs configuration.
 *
 * This module holds NO harness knowledge — where a given tool declares its
 * models lives under `src/platform/model-catalog/`.
 *
 * @module
 */

import { readFileSync, existsSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import fg from "fast-glob";
import { toNativePath } from "../utils/paths.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface RoleModelEntry {
  /** Absolute path to the role.yaml file */
  path: string;
  /** Role name from the YAML (name field) */
  name: string;
  /** Current model value from the YAML */
  model: string;
}

// ── Placeholder Policy ────────────────────────────────────────────

/** Model literals that always mean "configure me" (case-sensitive). */
const PLACEHOLDER_MODEL_LITERALS = new Set([
  "PLACEHOLDER",
  "YOUR_MODEL_HERE",
  "CHANGE_ME",
  "TODO",
]);

/**
 * Determine whether a model string is a placeholder that needs
 * real configuration before it can be used.
 *
 * The trimmed form is used only for the structural checks — empty,
 * placeholder literal, and bare name. The `knownModels` comparison uses the
 * original `model` string, so membership is exact identity.
 *
 * Returns `true` when:
 * - The trimmed string is empty
 * - The trimmed string matches a known placeholder literal
 *   (`PLACEHOLDER`, `YOUR_MODEL_HERE`, `CHANGE_ME`, `TODO`; case-sensitive)
 * - The trimmed string does NOT contain a `/` separator (bare model names
 *   like `gpt-4o` are likely placeholders since the canonical format
 *   is `provider/model_id`)
 * - `knownModels` is a non-empty list and the original string is not in it
 *   (meaning it refers to a model that has not been configured yet)
 *
 * The membership check is deliberately exact and not trimmed: model strings
 * are consumed verbatim, and `resolveModel` (src/resolver/model-resolver.ts)
 * tests `knownModelIds.has(model)` with the raw string, so a quoted,
 * whitespace-padded YAML value such as `model: " openrouter/x "` can never
 * resolve. Trimming it into a membership match would silence the
 * `rolebox sync` "unconfigured models" warning for a genuinely
 * misconfigured role — the opposite of this module's purpose.
 *
 * An empty `knownModels` array carries no information and is treated like
 * `undefined`: a fully-qualified model falls through to the structural checks
 * instead of being flagged as unconfigured.
 */
export function isPlaceholderModel(
  model: string,
  knownModels?: string[],
): boolean {
  const trimmed = model.trim();

  // Empty or whitespace-only
  if (trimmed.length === 0) return true;

  // Known placeholder literals (case-sensitive)
  if (PLACEHOLDER_MODEL_LITERALS.has(trimmed)) return true;

  // Bare model name without provider — likely a placeholder
  if (!trimmed.includes("/")) return true;

  // A non-empty list is the only list that carries information: an empty
  // array means "nothing known here", not "nothing is configured".
  if (knownModels !== undefined && knownModels.length > 0) {
    // Exact identity, deliberately not the trimmed form: the trimmed form is
    // not a configured id, and consumers (resolveModel) test membership with
    // the raw string.
    return !knownModels.includes(model);
  }

  return false;
}

// ── Role Scanning ─────────────────────────────────────────────────

/**
 * Recursively scan a role directory for all `role.yaml` files
 * (including those inside `subagents/` subdirectories) and return
 * the model value from each.
 *
 * Skips files that cannot be read or parsed. Returns an empty array
 * when the directory does not exist.
 */
export function scanRoleModels(roleDir: string): RoleModelEntry[] {
  if (!existsSync(roleDir)) return [];

  const files: string[] = fg.sync("**/role.yaml", {
    cwd: roleDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const results: RoleModelEntry[] = [];

  for (const filePath of files) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const doc = parseYaml(raw) as Record<string, unknown> | undefined;

      if (typeof doc !== "object" || doc === null) continue;

      const roleName =
        typeof doc.name === "string" && doc.name.length > 0
          ? doc.name
          : "unnamed";
      const model =
        typeof doc.model === "string" && doc.model.length > 0
          ? doc.model
          : "";

      results.push({
        // fast-glob applies unixify() (backslashes -> forward slashes) to
        // entries only when `absolute: true` (node_modules/fast-glob/out/
        // providers/transformers/entry.js:15 via out/utils/path.js), so on
        // Windows `filePath` uses forward slashes while join() produces
        // backslashes. Store the real filesystem path (native separators on
        // win32) so consumers' fs access and path joins agree with join-built
        // paths — mirroring src/resolver/skill-resolver.ts:84-88.
        path: toNativePath(filePath),
        name: roleName,
        model,
      });
    } catch {
      // Skip unreadable or malformed files
      continue;
    }
  }

  return results;
}

/**
 * Find all roles within a directory that have placeholder models.
 *
 * Combines `scanRoleModels` and `isPlaceholderModel` to identify
 * roles whose `model` field needs real configuration.
 */
export function findPlaceholderRoles(
  roleDir: string,
  knownModels?: string[],
): RoleModelEntry[] {
  const allRoles = scanRoleModels(roleDir);
  return allRoles.filter((entry) =>
    isPlaceholderModel(entry.model, knownModels),
  );
}
