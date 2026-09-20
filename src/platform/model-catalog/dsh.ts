/**
 * dsh model catalog.
 *
 * dsh declares its models in `<dsh home>/settings.yaml` under
 * `llm-pi-ai.providers.<route>.models[]`; the provider dict key is the route,
 * so each model id is `<route>/<model id>`.
 *
 * @module
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { dshPlatformPaths } from "../paths.ts";
import type { ModelOption, ModelReadOptions } from "./types.ts";

// ── dsh Model Source ──────────────────────────────────────────────

/** dsh settings document name under the harness home. */
const DSH_SETTINGS_FILENAME = "settings.yaml";

/** dsh settings namespace holding per-route provider profiles. */
const DSH_PI_AI_NS = "llm-pi-ai";

/**
 * Resolve the dsh settings document
 * (`<configDir ?? dsh home>/settings.yaml`).
 */
export function getDshSettingsPath(configDir?: string): string {
  return join(configDir ?? dshPlatformPaths().configDir, DSH_SETTINGS_FILENAME);
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
 * fall back to the opencode source. Duplicate ids are collapsed to their
 * first occurrence.
 *
 * @param opts.configDir — dsh home holding `settings.yaml`; defaults to
 *   `$DSH_HOME` or `~/.dsh`.
 * @param opts.projectDir — IGNORED: dsh has no project-level config that has
 *   been measured, so only the config home selects the document.
 */
export function readDshCatalog(opts: ModelReadOptions = {}): ModelOption[] {
  const resolvedPath = getDshSettingsPath(opts.configDir);
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
  const seen = new Set<string>();

  for (const [routeKey, providerValue] of Object.entries(providers)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;

    const models = (providerValue as Record<string, unknown>).models;
    if (!Array.isArray(models)) continue;

    for (const modelValue of models) {
      const option = dshModelOption(routeKey, modelValue);
      // First occurrence wins: a repeated `models[]` entry must not become a
      // second picker row with the same id.
      if (!option || seen.has(option.id)) continue;
      seen.add(option.id);
      results.push(option);
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}
