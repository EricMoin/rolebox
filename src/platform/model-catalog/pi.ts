/**
 * pi model catalog.
 *
 * pi declares its providers and their models in `<pi config dir>/models.json`:
 * `{ providers: { <provider id>: { name?, models?: [{ id, name? }] } } }`
 * (the installed pi package validates exactly this shape in its
 * `ModelConfig` schema and parses the document with a JSONC comment stripper,
 * so comments are tolerated here too). The reader is deliberately lenient per
 * entry instead of rejecting the whole document the way pi's own schema
 * validation does.
 *
 * `models-store.json` beside it is deliberately NOT read: that is pi's async,
 * lock-backed refresh cache, not the user's declaration.
 *
 * @module
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { piPlatformPaths } from "../paths.ts";
import { parseJsonc } from "../../utils/jsonc.ts";
import type { ModelOption, ModelReadOptions } from "./types.ts";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain object record.
 *
 * Arrays are rejected along with `null` and primitives, so an array-valued
 * `providers` or provider `models` node is skipped instead of being read as
 * an index-keyed map.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Resolve the pi models document
 * (`<configDir ?? pi config home>/models.json`).
 */
export function getPiModelsPath(configDir?: string): string {
  return join(configDir ?? piPlatformPaths().configDir, "models.json");
}

/**
 * Read the pi models document and extract every declared model.
 *
 * Each model is identified as `<provider id>/<model id>`; the display name is
 * the entry's `name`, falling back to its `id`. Returns an ordered (by id)
 * array of ModelOption objects.
 *
 * Acceptance rules: the provider value must be a plain object, `models` must be
 * an array (absent → the provider contributes nothing), and each entry must be
 * an object with a non-empty string `id`. A bare string entry is NOT accepted
 * — pi's own schema requires the object form, unlike the dsh reader.
 *
 * Returns an empty array when the file is missing, unreadable, malformed, or
 * shaped differently than above, so the caller can fall back to the seed
 * source.
 *
 * @param opts.configDir — pi config home holding `models.json`; defaults to
 *   `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.
 * @param opts.projectDir — IGNORED: pi has no project-level config that has
 *   been measured, so only the config home selects the document.
 */
export function readPiCatalog(opts: ModelReadOptions = {}): ModelOption[] {
  const resolvedPath = getPiModelsPath(opts.configDir);
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

  const root = asRecord(config);
  if (root === null) return [];

  const providers = asRecord(root.providers);
  if (providers === null) return [];

  const results: ModelOption[] = [];

  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = asRecord(providerValue);
    if (provider === null) continue;

    const models = provider.models;
    if (!Array.isArray(models)) continue;

    for (const modelValue of models) {
      const entry = asRecord(modelValue);
      if (entry === null) continue;
      if (typeof entry.id !== "string" || entry.id.length === 0) continue;

      const name =
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : entry.id;

      results.push({
        id: `${providerId}/${entry.id}`,
        name,
        provider: providerId,
      });
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}
