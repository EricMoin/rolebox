/**
 * dsh model catalog.
 *
 * dsh composes its configuration from layered Cordis patch documents. User
 * settings no longer live in `<dsh home>/settings.yaml`: the settings package
 * imports that file once into the ACTIVE PROFILE and renames it
 * `settings.yaml.imported`, after which the profile's own patch carries the
 * values. The layer holding the user's models is therefore a top-level YAML
 * array of loader entries — `- id: <entry>` / `config: { ... }`, or
 * `- insert: [entries]` — in `<dsh home>/profiles/<profile>/cordis.patch.yml`,
 * with the higher-precedence home-level `<dsh home>/cordis.patch.yml` on top and
 * a legacy pre-0.2 `<dsh home>/settings.yaml` (top-level map of namespaces)
 * still supported below them.
 *
 * The reader is deliberately STRUCTURAL: it recognizes the documented shapes of
 * a model declaration in whatever entry carries them, instead of holding a
 * vendor/plugin→route table or a default model list:
 *
 *   - `config.providers.<route>.models[]` → `<route>/<model id>`, the route
 *     coming from the provider map key;
 *   - any other `config.models[]` → `<default provider>/<model id>` when the
 *     SAME document declares a non-empty string `agent-default-model` provider,
 *     otherwise the bare `<model id>` with an empty provider.
 *
 * @module
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml, DEFAULT_SCHEMA, Type } from "js-yaml";
import { dshPlatformPaths } from "../paths.ts";
import type { ModelOption, ModelReadOptions } from "./types.ts";

// ── dsh Model Source ──────────────────────────────────────────────

/** Legacy dsh settings document name under the harness home. */
const DSH_SETTINGS_FILENAME = "settings.yaml";

/** dsh Cordis patch layer name, under the harness home and under each profile. */
const DSH_PATCH_FILENAME = "cordis.patch.yml";

/** Directory under the dsh home holding one subdirectory per profile. */
const DSH_PROFILES_DIRNAME = "profiles";

/** Patch entry whose `config.provider` names the document's default route. */
const DSH_DEFAULT_MODEL_ENTRY = "agent-default-model";

/**
 * dsh patch layers allow `!!js` expressions — their own header documents it —
 * e.g. `env: { TOKEN: !!js process.env.TOKEN?.trim() || '' }`,
 * `cwd: !!js process.cwd()` or `disabled: !!js process.platform === 'win32'`.
 * js-yaml's DEFAULT_SCHEMA rejects that tag outright, which would discard the
 * WHOLE layer and with it every model it declares. The reader never evaluates
 * those expressions, so the tag is registered as an opaque value on every node
 * kind: it only has to see through the document that carries the models.
 * (A `disabled` computed by such an expression is also opaque and therefore
 * read as "not disabled" — the lenient direction.)
 */
const DSH_PATCH_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => data }),
  new Type("tag:yaml.org,2002:js", { kind: "sequence", construct: (data) => data }),
  new Type("tag:yaml.org,2002:js", { kind: "mapping", construct: (data) => data }),
]);

/**
 * Resolve the legacy dsh settings document
 * (`<configDir ?? dsh home>/settings.yaml`).
 */
export function getDshSettingsPath(configDir?: string): string {
  return join(configDir ?? dshPlatformPaths().configDir, DSH_SETTINGS_FILENAME);
}

/**
 * Resolve the dsh documents contributing a model catalog, most significant
 * first: the home-level `cordis.patch.yml`, then every profile's
 * `cordis.patch.yml` in directory-name order, then the legacy `settings.yaml`.
 *
 * A missing `profiles/` directory is not an error — it simply contributes no
 * profile documents, so an installation that has never created a profile still
 * resolves its home patch and legacy settings.
 */
export function getDshCatalogPaths(configDir?: string): string[] {
  const home = configDir ?? dshPlatformPaths().configDir;
  const paths = [join(home, DSH_PATCH_FILENAME)];

  let profileNames: string[] = [];
  try {
    profileNames = readdirSync(join(home, DSH_PROFILES_DIRNAME), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    profileNames = [];
  }
  for (const profileName of profileNames) {
    paths.push(join(home, DSH_PROFILES_DIRNAME, profileName, DSH_PATCH_FILENAME));
  }

  paths.push(getDshSettingsPath(home));
  return paths;
}

// ── Value narrowing ───────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain object record.
 *
 * Arrays are rejected along with `null` and primitives, so an array-valued
 * `providers` node is skipped instead of being read as an index-keyed map.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Read a non-empty string, or null for anything else. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── Model entries ─────────────────────────────────────────────────

/**
 * The model id of one `models[]` entry: a non-empty string, or an object with a
 * non-empty string `id`. Everything else contributes nothing.
 */
function modelEntryId(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct !== null) return direct;
  const entry = asRecord(value);
  return entry === null ? null : nonEmptyString(entry.id);
}

/** The entry's non-empty string `name`, falling back to the model id. */
function modelEntryName(value: unknown, id: string): string {
  const entry = asRecord(value);
  const name = entry === null ? null : nonEmptyString(entry.name);
  return name ?? id;
}

/** One `providers.<route>.models[]` entry, identified as `<route>/<model id>`. */
function dshRouteModelOption(route: string, modelValue: unknown): ModelOption | null {
  const modelId = modelEntryId(modelValue);
  if (modelId === null) return null;
  return {
    id: `${route}/${modelId}`,
    name: modelEntryName(modelValue, modelId),
    provider: route,
  };
}

/**
 * One flat `models[]` entry. With a document default provider the id is
 * `<provider>/<model id>`; without one the bare model id keeps an empty
 * provider so the picker can still label it.
 */
function dshFlatModelOption(defaultProvider: string, modelValue: unknown): ModelOption | null {
  const modelId = modelEntryId(modelValue);
  if (modelId === null) return null;
  const name = modelEntryName(modelValue, modelId);
  if (defaultProvider.length === 0) {
    return { id: modelId, name, provider: "" };
  }
  return { id: `${defaultProvider}/${modelId}`, name, provider: defaultProvider };
}

// ── Structural walk ───────────────────────────────────────────────

/**
 * Walk one entry's `config` value tree (or one legacy namespace section body)
 * and collect every model declaration below it.
 *
 * A `providers` member that is a map of objects is consumed as the route table
 * and is NOT walked again; a `models` member that is an array is consumed as
 * this node's flat list. Every other member is recursed into, so a nested
 * config object declaring models is still found.
 */
function collectModels(node: unknown, defaultProvider: string, out: ModelOption[]): void {
  const record = asRecord(node);
  if (record === null) return;

  const providers = asRecord(record.providers);
  if (providers !== null) {
    for (const [route, providerValue] of Object.entries(providers)) {
      const provider = asRecord(providerValue);
      if (provider === null) continue;
      const models = provider.models;
      if (!Array.isArray(models)) continue;
      for (const modelValue of models) {
        const option = dshRouteModelOption(route, modelValue);
        if (option !== null) out.push(option);
      }
    }
  }

  const models = record.models;
  if (Array.isArray(models)) {
    for (const modelValue of models) {
      const option = dshFlatModelOption(defaultProvider, modelValue);
      if (option !== null) out.push(option);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "providers" || key === "models") continue;
    if (Array.isArray(value)) {
      for (const item of value) collectModels(item, defaultProvider, out);
    } else {
      collectModels(value, defaultProvider, out);
    }
  }
}

// ── Patch layer ───────────────────────────────────────────────────

/**
 * First non-empty `agent-default-model` `config.provider` declared by a patch
 * layer (searching `insert:` lists too), or "" when the layer declares none.
 */
function patchDefaultProvider(entries: unknown[]): string {
  for (const element of entries) {
    const entry = asRecord(element);
    if (entry === null) continue;

    if ("insert" in entry) {
      const inserted = entry.insert;
      if (Array.isArray(inserted)) {
        const nested = patchDefaultProvider(inserted);
        if (nested.length > 0) return nested;
      }
      continue;
    }

    if (entry.id !== DSH_DEFAULT_MODEL_ENTRY) continue;
    const provider = nonEmptyString(asRecord(entry.config)?.provider);
    if (provider !== null) return provider;
  }
  return "";
}

/**
 * Collect models from one top-level patch array: every element is either a
 * patch op `{ insert: [...] }` (recurse into the inserted entries) or an entry
 * object whose `config` is inspected. A `disabled: true` entry is skipped.
 */
function collectPatchLayer(
  entries: unknown[],
  defaultProvider: string,
  out: ModelOption[],
): void {
  for (const element of entries) {
    const entry = asRecord(element);
    if (entry === null) continue;

    if ("insert" in entry) {
      const inserted = entry.insert;
      if (Array.isArray(inserted)) collectPatchLayer(inserted, defaultProvider, out);
      continue;
    }

    if (entry.disabled === true) continue;
    collectModels(entry.config, defaultProvider, out);
  }
}

/** Extract the models declared by one top-level array (Cordis patch) document. */
function readPatchDocument(document: unknown[]): ModelOption[] {
  const defaultProvider = patchDefaultProvider(document);
  const out: ModelOption[] = [];
  collectPatchLayer(document, defaultProvider, out);
  return out;
}

/** Extract the models declared by one top-level map (legacy settings) document. */
function readSettingsDocument(root: Record<string, unknown>): ModelOption[] {
  const defaultProvider =
    nonEmptyString(asRecord(root[DSH_DEFAULT_MODEL_ENTRY])?.provider) ?? "";
  const out: ModelOption[] = [];
  for (const section of Object.values(root)) {
    collectModels(section, defaultProvider, out);
  }
  return out;
}

/** Read one catalog document, or [] when it is missing, unreadable or unusable. */
function readDshDocument(documentPath: string): ModelOption[] {
  if (!existsSync(documentPath)) return [];

  let document: unknown;
  try {
    document = parseYaml(readFileSync(documentPath, "utf-8"), {
      schema: DSH_PATCH_SCHEMA,
    });
  } catch {
    return [];
  }

  if (Array.isArray(document)) return readPatchDocument(document);
  const root = asRecord(document);
  if (root === null) return [];
  return readSettingsDocument(root);
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Read every dsh catalog document and extract the models it declares.
 *
 * {@link getDshCatalogPaths} fixes the scan order (home patch, profile patches,
 * legacy settings); the first occurrence of an id wins, so a higher-precedence
 * layer shadows a lower one, and the result is sorted by id. Documents that are
 * missing, unreadable, malformed, or neither a top-level array nor a map are
 * skipped without throwing — the reader is lenient exactly like the opencode
 * and pi readers, so the caller can fall back to the opencode seed when nothing
 * is declared.
 *
 * @param opts.configDir — dsh home holding `cordis.patch.yml` and `profiles/`;
 *   defaults to `$DSH_HOME` or `~/.dsh`.
 * @param opts.projectDir — IGNORED: dsh has no project-level config that has
 *   been measured, so only the config home selects the documents.
 */
export function readDshCatalog(opts: ModelReadOptions = {}): ModelOption[] {
  const results: ModelOption[] = [];
  const seen = new Set<string>();

  for (const documentPath of getDshCatalogPaths(opts.configDir)) {
    for (const option of readDshDocument(documentPath)) {
      // First occurrence wins: a lower-precedence layer must not add a second
      // picker row for an id the home patch already declared.
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      results.push(option);
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}
