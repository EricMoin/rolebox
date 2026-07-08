import { readFileSync, existsSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import fg from "fast-glob";
import { getOpencodeConfigPath } from "./paths.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface ModelOption {
  /** Full identifier in provider/model format, e.g. "hfai/deepseek-v4-pro-max" */
  id: string;
  /** Human-readable display name from config, falls back to the model key */
  name: string;
  /** Provider key from opencode.jsonc, e.g. "hfai" */
  provider: string;
}

export interface RoleModelEntry {
  /** Absolute path to the role.yaml file */
  path: string;
  /** Role name from the YAML (name field) */
  name: string;
  /** Current model value from the YAML */
  model: string;
}

// ── JSONC Parsing ─────────────────────────────────────────────────

/**
 * Parse a JSONC string into a JavaScript value.
 *
 * Strips `//` line comments and trailing `//` comments (heuristic:
 * a `//` followed by `"` is treated as inside a string and preserved).
 * Also removes trailing commas before `}` or `]`.
 */
function parseJsonc(text: string): unknown {
  // Remove full-line comments: lines where the first non-whitespace is //
  let stripped = text.replace(/^\s*\/\/.*$/gm, "");
  // Remove trailing // comments when there is no unescaped " after them
  stripped = stripped.replace(/\/\/[^"]*$/gm, "");
  // Remove trailing commas before } or ]
  stripped = stripped.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Read `~/.config/opencode/opencode.jsonc`, parse the JSONC, and
 * extract all available model identifiers.
 *
 * Each model is identified by its full `{provider_key}/{model_key}` path.
 * Returns an ordered (by id) array of ModelOption objects.
 *
 * Returns an empty array when the config file is missing, unreadable,
 * malformed, or contains no provider models.
 */
export function scanAvailableModels(): ModelOption[] {
  const configPath = getOpencodeConfigPath();
  if (!existsSync(configPath)) {
    return [];
  }

  let config: unknown;
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = parseJsonc(raw);
  } catch {
    return [];
  }

  if (typeof config !== "object" || config === null) return [];
  if (!("provider" in config)) return [];

  const provider = (config as Record<string, unknown>).provider;
  if (typeof provider !== "object" || provider === null) return [];

  const results: ModelOption[] = [];

  for (const [providerKey, providerValue] of Object.entries(provider)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;

    const models = (providerValue as Record<string, unknown>).models;
    if (typeof models !== "object" || models === null) continue;

    for (const [modelKey, modelValue] of Object.entries(models)) {
      if (typeof modelValue !== "object" || modelValue === null) {
        // If model entry is not an object, use the key as display name
        results.push({
          id: `${providerKey}/${modelKey}`,
          name: modelKey,
          provider: providerKey,
        });
        continue;
      }

      const entry = modelValue as Record<string, unknown>;
      const displayName =
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : modelKey;

      results.push({
        id: `${providerKey}/${modelKey}`,
        name: displayName,
        provider: providerKey,
      });
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

/**
 * Determine whether a model string is a placeholder that needs
 * real configuration before it can be used.
 *
 * Returns `true` when:
 * - The string matches known placeholder literals
 *   (`PLACEHOLDER`, `YOUR_MODEL_HERE`, `CHANGE_ME`, `TODO`, empty string)
 * - The string does NOT contain a `/` separator (bare model names
 *   like `gpt-4o` are likely placeholders since the canonical format
 *   is `provider/model_id`)
 * - `knownModels` is provided and the string is not in that list
 *   (meaning it refers to a model that hasn't been configured yet)
 */
export function isPlaceholderModel(
  model: string,
  knownModels?: string[],
): boolean {
  // Empty or whitespace-only
  if (model.trim().length === 0) return true;

  // Known placeholder literals (case-sensitive)
  const placeholders = new Set([
    "PLACEHOLDER",
    "YOUR_MODEL_HERE",
    "CHANGE_ME",
    "TODO",
  ]);
  if (placeholders.has(model)) return true;

  // Bare model name without provider — likely a placeholder
  if (!model.includes("/")) return true;

  // If knownModels is provided, check membership
  if (knownModels !== undefined) {
    return !knownModels.includes(model);
  }

  return false;
}

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
        path: filePath,
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
