/**
 * Model resolver for rolebox.
 *
 * Replaces placeholder/bare-name model strings with canonical
 * `provider/model_id` values using a two-source fallback chain:
 *   1. Known models (from opencode.jsonc) — passthrough if already canonical.
 *   2. User-configurable aliases (from role_config.yaml) — single-hop mapping.
 *
 * Unrecognized models pass through unchanged with a log message.
 * Callers must initialize via `initModelResolver()` before resolving.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { createSubLogger } from "../logger.ts";
import type { Logger } from "tslog";
import type { ILogObj } from "tslog";
import { scanAvailableModels } from "../cli/model-utils.ts";
import { getOpencodeConfigDir } from "../cli/paths.ts";

// ── Module-level mutable state (reloaded on every `initModelResolver` call) ──

let log: Logger<ILogObj> = createSubLogger("model-resolver");
let initialized = false;
let knownModelIds: Set<string> = new Set();
let modelAliases: Map<string, string> = new Map();

// ── Test seams ────────────────────────────────────────────────────────────

/** @internal Test seam — swap the module-level logger for a mock. */
export function __setLoggerForTest(mockLog: Logger<ILogObj>): void {
  log = mockLog;
}

/**
 * @internal Test seam — reset all module-level state to defaults.
 *
 * Clears `initialized`, `knownModelIds`, `modelAliases`, and restores
 * the default logger. Useful for test isolation between scenario groups.
 */
export function __resetForTest(): void {
  initialized = false;
  knownModelIds = new Set();
  modelAliases = new Map();
  log = createSubLogger("model-resolver");
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize (or re-initialize) the model resolver from the filesystem.
 *
 * Every call reloads **both** caches from disk — there is no idempotency
 * check and no lazy initialization.  This guarantees that edits to
 * `opencode.jsonc` or `role_config.yaml` take effect on the next
 * `initModelResolver()` call (which happens at every bootstrap and
 * hot-reload cycle).
 *
 * @param configDir — path to the opencode config directory (contains
 *   `opencode.jsonc` and `role_config.yaml`).  When omitted, falls back
 *   to the XDG-aware `getOpencodeConfigDir()`.
 */
export function initModelResolver(configDir?: string): void {
  const dir = configDir ?? getOpencodeConfigDir();

  // 1. Load known model IDs from opencode.jsonc
  const opencodeConfigPath = join(dir, "opencode.jsonc");
  const models = scanAvailableModels(opencodeConfigPath);
  knownModelIds = new Set(models.map((m) => m.id));

  // 2. Load model aliases from role_config.yaml
  modelAliases = loadModelAliases(dir);

  initialized = true;
}

/**
 * Resolve a model string through the fallback chain:
 *
 *   1. Not initialized → warn + passthrough original.
 *   2. Empty / whitespace-only → passthrough original.
 *   3. Found in `knownModelIds` (from opencode.jsonc) → passthrough original
 *      (already a canonical `provider/model_id`).
 *   4. Found in `modelAliases` → return the **single-hop** mapped value.
 *   5. Neither → `log.info` a hint + passthrough original.
 *
 * @param model — the model string to resolve (from a role's `model:` field).
 * @returns The resolved canonical model string, or the original string if
 *          no resolution was possible.
 */
export function resolveModel(model: string): string {
  // Guard: empty or whitespace-only → passthrough
  if (!model || model.trim().length === 0) {
    return model;
  }

  // Guard: not initialized → warn + passthrough
  if (!initialized) {
    log.warn(
      `Model resolver not initialized; passing through model "${model}" as-is. ` +
        `Call initModelResolver() before resolveModel().`,
    );
    return model;
  }

  // Priority 1: known model (already canonical) → passthrough
  if (knownModelIds.has(model)) {
    return model;
  }

  // Priority 2: alias mapping → single-hop resolution
  const aliased = modelAliases.get(model);
  if (aliased !== undefined) {
    return aliased;
  }

  // Priority 3: unrecognized → info + passthrough original
  log.info(
    `Model "${model}" is not a known model and has no alias configured. ` +
      `Passing through as-is. You can add an alias in role_config.yaml under the "model_aliases" key. ` +
      `Example: model_aliases:\n  "${model}": provider/model_id`,
  );
  return model;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Read and parse `{configDir}/role_config.yaml`, extracting the
 * `model_aliases` map.
 *
 * Graceful degradation — never throws:
 * - Missing file → empty Map (no log).
 * - Malformed YAML → warn + empty Map.
 * - Invalid alias entries (empty key, non-string value, empty-string value) →
 *   warn for each skipped entry.
 *
 * @param configDir — absolute path to the opencode config directory.
 */
function loadModelAliases(configDir?: string): Map<string, string> {
  const dir = configDir ?? getOpencodeConfigDir();
  const configPath = join(dir, "role_config.yaml");

  if (!existsSync(configPath)) {
    return new Map();
  }

  let doc: unknown;
  try {
    const raw = readFileSync(configPath, "utf-8");
    doc = parseYaml(raw);
  } catch {
    log.warn(
      `Failed to parse ${configPath}; model aliases will not be available.`,
    );
    return new Map();
  }

  if (typeof doc !== "object" || doc === null) {
    return new Map();
  }

  const rawAliases = (doc as Record<string, unknown>).model_aliases;
  if (typeof rawAliases !== "object" || rawAliases === null) {
    return new Map();
  }

  const result = new Map<string, string>();

  for (const [key, value] of Object.entries(rawAliases)) {
    // Skip empty-string keys (YAML can produce these)
    if (key.length === 0) {
      log.warn(`Skipping empty alias key in ${configPath}`);
      continue;
    }

    // Skip non-string values (number, boolean, null, array, object)
    if (typeof value !== "string") {
      log.warn(
        `Skipping alias "${key}" in ${configPath}: value must be a string, got ${typeof value}`,
      );
      continue;
    }

    // Skip empty-string values
    if (value.length === 0) {
      log.warn(`Skipping alias "${key}" in ${configPath}: value is empty`);
      continue;
    }

    result.set(key, value);
  }

  return result;
}
