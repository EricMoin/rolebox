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

// Advisory reports already emitted for the current cache generation.  These
// are hot-path guards: resolveModel runs once per role and per subagent on
// every discovery and hot reload, so an identical line must not repeat.
let reportedModels = new Set<string>();
let uninitializedWarned = false;

// ── Test seams ────────────────────────────────────────────────────────────

/** @internal Test seam — swap the module-level logger for a mock. */
export function __setLoggerForTest(mockLog: Logger<ILogObj>): void {
  log = mockLog;
}

/**
 * @internal Test seam — reset all module-level state to defaults.
 *
 * Clears `initialized`, `knownModelIds`, `modelAliases`, the per-generation
 * advisory state (`reportedModels`, `uninitializedWarned`), and restores
 * the default logger. Useful for test isolation between scenario groups.
 */
export function __resetForTest(): void {
  initialized = false;
  knownModelIds = new Set();
  modelAliases = new Map();
  reportedModels = new Set();
  uninitializedWarned = false;
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
 * Advisory logs are scoped to a cache generation: this call clears
 * `reportedModels` and `uninitializedWarned`, so each distinct unresolvable
 * model is reported once per generation and the not-initialized warning is
 * re-armed.
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

  // 3. New cache generation → re-arm the advisory reports
  reportedModels = new Set();
  uninitializedWarned = false;

  initialized = true;
}

/**
 * Resolve a model string through the fallback chain:
 *
 *   1. Not initialized → warn once per generation + passthrough original.
 *   2. Empty / whitespace-only → passthrough original.
 *   3. Found in `knownModelIds` (from opencode.jsonc) → passthrough original
 *      (already a canonical `provider/model_id`).
 *   4. Found in `modelAliases` → return the **single-hop** mapped value.
 *   5. Neither → `log.info` a hint + passthrough original.  The hint is
 *      emitted at most once per distinct model per generation.
 *
 * Advisory state is per cache generation: `initModelResolver()` and
 * `__resetForTest()` clear it, so a fresh generation re-reports.
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

  // Guard: not initialized → warn once per generation + passthrough
  if (!initialized) {
    if (!uninitializedWarned) {
      uninitializedWarned = true;
      log.warn(
        `Model resolver not initialized; passing through model "${model}" as-is. ` +
          `Call initModelResolver() before resolveModel().`,
      );
    }
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

  // Priority 3: unrecognized → info once per model per generation + passthrough
  if (!reportedModels.has(model)) {
    reportedModels.add(model);
    log.info(
      `Model "${model}" is not a known model and has no alias configured. ` +
        `Passing through as-is. You can add an alias in role_config.yaml under the "model_aliases" key. ` +
        `Example: model_aliases:\n  "${model}": provider/model_id`,
    );
  }
  return model;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain (non-array) record, or `null`.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read and parse `{configDir}/role_config.yaml`, extracting the
 * `model_aliases` map.
 *
 * Graceful degradation — never throws:
 * - Missing file → empty Map (no log).
 * - Malformed YAML → warn + empty Map.
 * - `model_aliases` absent or null → empty Map (no log).
 * - `model_aliases` not a mapping (string, number, boolean, array) →
 *   warn + empty Map.
 * - Invalid alias entries (empty key, non-string value, empty-string value) →
 *   warn for each skipped entry.
 *
 * @param configDir — absolute path to the opencode config directory.
 */
function loadModelAliases(configDir: string): Map<string, string> {
  const configPath = join(configDir, "role_config.yaml");

  if (!existsSync(configPath)) {
    return new Map();
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = parseYaml(raw);
  } catch {
    log.warn(
      `Failed to parse ${configPath}; model aliases will not be available.`,
    );
    return new Map();
  }

  const doc = asRecord(parsed);
  if (doc === null) {
    return new Map();
  }

  const rawAliases = doc.model_aliases;
  if (rawAliases === undefined || rawAliases === null) {
    return new Map();
  }

  const aliasRecord = asRecord(rawAliases);
  if (aliasRecord === null) {
    const kind = Array.isArray(rawAliases) ? "array" : typeof rawAliases;
    log.warn(
      `Ignoring "model_aliases" in ${configPath}: expected a mapping of name to model id, got ${kind}`,
    );
    return new Map();
  }

  const result = new Map<string, string>();

  for (const [key, value] of Object.entries(aliasRecord)) {
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
