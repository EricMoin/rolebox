import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import fg from "fast-glob";
import { getOpencodeConfigPath } from "./paths.ts";
import { dshPlatformPaths } from "../platform/paths.ts";
import { toNativePath } from "../utils/paths.ts";
import { SyncTarget } from "../constants.ts";

// ── Types ──────────────────────────────────────────────────────────

export interface ModelOption {
  /** Full identifier in provider/model format, e.g. "openrouter/anthropic/claude-sonnet-4" */
  id: string;
  /** Human-readable display name from config, falls back to the model key */
  name: string;
  /** Provider key from opencode.jsonc, e.g. "openrouter" */
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
export function scanAvailableModels(configPath?: string): ModelOption[] {
  const resolvedPath = configPath ?? getOpencodeConfigPath();
  if (!existsSync(resolvedPath)) {
    return [];
  }

  let config: unknown;
  try {
    const raw = readFileSync(resolvedPath, "utf-8");
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

// ── dsh Model Source ──────────────────────────────────────────────

/** dsh settings document name under the harness home. */
const DSH_SETTINGS_FILENAME = "settings.yaml";

/** dsh settings namespace holding per-route provider profiles. */
const DSH_PI_AI_NS = "llm-pi-ai";

/**
 * Resolve the dsh settings document (`<dsh home>/settings.yaml`) from the
 * platform paths (`$DSH_HOME` or `~/.dsh`).
 */
export function getDshSettingsPath(): string {
  return join(dshPlatformPaths().configDir, DSH_SETTINGS_FILENAME);
}

/**
 * Normalize one `llm-pi-ai.providers.<route>.models[]` entry into a
 * {@link ModelOption}. Accepts the documented object shape (`{ id, name? }`)
 * and a bare string model id; returns null for anything else.
 */
function dshModelOption(routeKey: string, modelValue: unknown): ModelOption | null {
  if (typeof modelValue === "string" && modelValue.length > 0) {
    return { id: `${routeKey}/${modelValue}`, name: modelValue, provider: routeKey };
  }
  if (typeof modelValue !== "object" || modelValue === null) return null;

  const entry = modelValue as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;

  const name =
    typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
  return { id: `${routeKey}/${entry.id}`, name, provider: routeKey };
}

/**
 * Read the dsh settings document and extract the models declared under
 * `llm-pi-ai.providers.<route>.models[]` (the key shape verified in subtask 1).
 *
 * The `providers` dict key is the provider route, so each model is identified
 * as `<route>/<model id>` — the same `provider/model` shape the opencode
 * reader produces. Returns an empty array when the file is missing,
 * unreadable, malformed, or declares no provider models, so the caller can
 * fall back to the opencode source.
 */
export function scanDshAvailableModels(configPath?: string): ModelOption[] {
  const resolvedPath = configPath ?? getDshSettingsPath();
  if (!existsSync(resolvedPath)) {
    return [];
  }

  let config: unknown;
  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    config = parseYaml(raw);
  } catch {
    return [];
  }

  if (typeof config !== "object" || config === null) return [];

  const piAi = (config as Record<string, unknown>)[DSH_PI_AI_NS];
  if (typeof piAi !== "object" || piAi === null) return [];

  const providers = (piAi as Record<string, unknown>).providers;
  if (typeof providers !== "object" || providers === null) return [];

  const results: ModelOption[] = [];

  for (const [routeKey, providerValue] of Object.entries(providers)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;

    const models = (providerValue as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;

    for (const modelValue of models) {
      const option = dshModelOption(routeKey, modelValue);
      if (option) results.push(option);
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

/**
 * Resolve the model options offered for a sync target.
 *
 * `dsh` reads its own settings document; when that yields no models (missing
 * file, malformed YAML, or an empty provider set) it falls back to the
 * opencode source. Every other target (opencode, pi) keeps the opencode
 * source unchanged.
 */
export function scanModelsForTarget(
  target: string,
  opts: { opencodeConfigPath?: string; dshConfigPath?: string } = {},
): ModelOption[] {
  if (target === SyncTarget.Dsh) {
    const dshModels = scanDshAvailableModels(opts.dshConfigPath);
    if (dshModels.length > 0) return dshModels;
  }
  return scanAvailableModels(opts.opencodeConfigPath);
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
