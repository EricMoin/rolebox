/**
 * Opencode model catalog.
 *
 * Opencode declares its models across its config documents —
 * `opencode.json` and `opencode.jsonc`, both global and project-level, merged
 * by `loadOpencodeConfig` — under
 * `provider.<provider key>.models.<model key>`. The reader accepts an explicit
 * config home and/or project directory; otherwise the default global documents
 * are resolved straight from the platform paths — deliberately NOT from
 * `src/cli/paths.ts`, which would invert the platform/CLI layering.
 *
 * @module
 */

import { loadOpencodeConfig } from "../opencode-config.ts";
import type { ModelOption, ModelReadOptions } from "./types.ts";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain object record.
 *
 * Arrays are rejected along with `null` and primitives, so an array-valued
 * `models` node is skipped instead of being read as an index-keyed map
 * (`provider/0`, `provider/1`, ...).
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Read opencode's merged config documents and extract all available model
 * identifiers.
 *
 * Each model is identified by its full `{provider_key}/{model_key}` path.
 * Returns an ordered (by id) array of ModelOption objects.
 *
 * Returns an empty array when neither document exists, both are unreadable or
 * malformed, or no provider models are declared.
 *
 * A `models` node that is not a plain object (for example an array) is skipped
 * instead of being read as an index-keyed map.
 *
 * @param opts.configDir — config home holding the global `opencode.json` and
 *   `opencode.jsonc`; defaults to the platform's opencode config home.
 * @param opts.projectDir — project directory whose walk contributes the
 *   project-level documents (and so project-declared models); omitted = global
 *   documents only.
 */
export function readOpencodeCatalog(opts: ModelReadOptions = {}): ModelOption[] {
  const root = loadOpencodeConfig(opts);
  if (root === null) return [];

  const provider = asRecord(root.provider);
  if (provider === null) return [];

  const results: ModelOption[] = [];

  for (const [providerKey, providerValue] of Object.entries(provider)) {
    const providerRecord = asRecord(providerValue);
    if (providerRecord === null) continue;

    // An array-valued `models` is not a keyed model map: skip it rather than
    // emitting index-derived ids (`provider/0`).
    const models = asRecord(providerRecord.models);
    if (models === null) continue;

    for (const [modelKey, modelValue] of Object.entries(models)) {
      const entry = asRecord(modelValue);
      if (entry === null) {
        // If model entry is not an object, use the key as display name
        results.push({
          id: `${providerKey}/${modelKey}`,
          name: modelKey,
          provider: providerKey,
        });
        continue;
      }

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
