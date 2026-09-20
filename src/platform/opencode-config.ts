/**
 * opencode's config documents — the single place that knows the layout.
 *
 * opencode reads a GLOBAL pair from its config home, PROJECT-level documents
 * from the project directory walk, and two HOME-derived layers — the
 * `<os home>/.opencode` pair and, when `$OPENCODE_CONFIG_DIR` is set, that
 * directory's pair. Load order, lowest → highest precedence:
 *
 *   1. `<home>/opencode.json`
 *   2. `<home>/opencode.jsonc`
 *   3. for every project-walk directory, outermost → innermost:
 *      `<dir>/opencode.json`, `<dir>/opencode.jsonc`
 *   4. for every project-walk directory, INNERMOST → OUTERMOST:
 *      `<dir>/.opencode/opencode.json`, `<dir>/.opencode/opencode.jsonc`
 *   5. `<os home>/.opencode/opencode.json`
 *   6. `<os home>/.opencode/opencode.jsonc`
 *   7. `$OPENCODE_CONFIG_DIR/opencode.json`
 *   8. `$OPENCODE_CONFIG_DIR/opencode.jsonc`
 *
 * `<home>` is an explicit config home or {@link defaultPlatformPaths}'s
 * `configDir`; `<os home>` is `HOME` when set and non-blank, otherwise
 * {@link homedir}. Layers 5–8 read their environment at CALL time and are
 * independent of the project walk, so they are resolved even when
 * `projectDir` is omitted. The kinds are ordered kind-major: every plain
 * document is folded before ANY `.opencode/` document, so an OUTER
 * `.opencode/opencode.json` beats an INNER plain `opencode.json`. Within
 * the plain kind the NEARER directory wins (directory-major, outermost →
 * innermost); within the dot kind the FURTHER directory wins (directory-major,
 * innermost → outermost), so the outermost `.opencode/` is folded last. In
 * both kinds `opencode.json` precedes `opencode.jsonc` inside one
 * directory.
 *
 * Measured on the installed opencode 1.18.31 with isolated `HOME` /
 * `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` and a fresh tree
 * per case (`opencode models` / `opencode debug config`), each case
 * declaring a DISTINCT provider and reading which provider won: the global
 * pair and its order, the kind-over-depth rule, the nearer-plain-wins rule,
 * the dot-kind order — a FARTHER `.opencode/opencode.json` beats a nearer
 * `.opencode/opencode.jsonc` — and the repository-root stop below. The two
 * home-derived layers measured the same way:
 *
 *   - `<os home>/.opencode` is folded AFTER the project walk, so it beats both
 *     the XDG global document and the project document (H1); `.jsonc` beats
 *     `.json` inside it (H2); it is read even when the process cwd is not
 *     under the home directory, so it is independent of the project walk and
 *     is included when `projectDir` is omitted (H3); its `plugin` array
 *     CONCATENATES with the global pair — `["g1"] + ["h1"] → ["g1","h1"]` (H5).
 *   - `$OPENCODE_CONFIG_DIR` is the LAST layer, so it beats the home-dot layer
 *     and the project document (O1, O4). It ADDS a source rather than
 *     replacing the XDG config home — the XDG document is still read
 *     (O3-fixed) — it uses the same `.json`/`.jsonc` layout (O5), the
 *     home-dot layer is still read alongside it (O6), its arrays concatenate
 *     (`["g1"] + ["o1"] → ["g1","o1"]`, O7), an empty value behaves exactly
 *     like an unset one (O8), and a nonexistent directory is harmless (O9).
 *
 * The project walk starts at the project directory and STOPS after the first
 * directory that is a git repository root: that root's own documents are read
 * (measured — the boundary directory's documents are used), while documents
 * strictly ABOVE it are not (measured — `opencode models` does not list a
 * provider declared one level above a real repository root). A directory ends
 * the walk only when its `.git` marker is VALID:
 *
 *   - `<dir>/.git` is a DIRECTORY containing `HEAD` — the shape a real
 *     `git init` writes. An EMPTY `.git` directory is not a repository
 *     (measured: the walk continued past it);
 *   - `<dir>/.git` is a FILE whose `gitdir: <path>` target exists — the
 *     worktree / submodule shape `git worktree add` writes. A relative target
 *     resolves against `<dir>`; a target that does not exist is not a
 *     repository (measured: the walk continued past it).
 *
 * Fixture trap — do not reintroduce: an earlier probe ran `git init` with its
 * cwd INSIDE `.git/`, which creates `.git/.git`. That directory was never a
 * valid repository (it reproduced the empty-`.git` case above), so the probe
 * "measured" no stop and this module briefly documented one. A genuine fixture
 * runs `git init` in the repository ROOT directory, or writes a `.git` file
 * whose `gitdir:` target exists.
 *
 * When no valid marker exists anywhere the walk continues to the filesystem
 * root; the walk itself reads no environment and has no home-directory stop.
 * A parent equal to its child (win32 drive roots, `/`) ends the loop.
 * {@link projectConfigDirs} owns the walk.
 *
 * Each document is parsed independently with `parseJsonc`, then folded with
 * the two array rules opencode 1.18.31 applies:
 *
 *   - **Objects merge key-wise, recursively.** A provider declared in only one
 *     document survives, so the documents' models are unioned.
 *   - **Arrays and scalars are replaced wholesale by the later document**,
 *     EXCEPT in the project-style layers — the project walk and the two
 *     home-derived layers (5–8) — which concatenate the two array-valued
 *     top-level keys opencode's project merge concatenates: `instructions`
 *     (union) and `plugin` (append). The global pair (1–2) replaces arrays
 *     for every key.
 *
 * The array split is measured for `plugin` and `instructions` and confirmed
 * in the 1.18.31 source (`mergeConfig`, `mergeConfigConcatArrays` and
 * `mergePluginOrigins` in packages/opencode/src/config/config.ts: remeda's
 * `mergeDeep` replaces arrays, `instructions` is unioned explicitly, and
 * `plugin` is accumulated by origin). The same source folds
 * `<os home>/.opencode/opencode.json(c)` after the project dot walk and
 * `$OPENCODE_CONFIG_DIR` after that; both layers are modeled here as entries
 * 5–8, and both take the project-style array rule above.
 *
 * Each layer is folded in the listed order, so a later layer LAYERS ON TOP of
 * every earlier one for a duplicate key.
 *
 * Deliberate divergence from opencode: opencode exits 1 when one document is
 * malformed, even when the other is valid. rolebox instead treats a missing or
 * malformed document as contributing nothing and ALWAYS keeps the other — its
 * consumers (`rolebox config`'s model picker, `sync`'s placeholder
 * detection, `rolebox status`'s registration check) must degrade to "fewer
 * models" or "not registered", never resurrect the false "every role is
 * unconfigured" storm that one bad file would otherwise cause.
 *
 * The documents are parsed, untrusted-shaped JSON, so every key is copied onto
 * a merge target as an OWN data property (`Object.defineProperty`), never
 * through an assignment: a hostile `__proto__` / `constructor` /
 * `prototype` key stays inert data and `Object.prototype` is never touched.
 *
 * @module
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultPlatformPaths } from "./paths.ts";
import { parseJsonc } from "../utils/jsonc.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain object record.
 *
 * Arrays are rejected along with `null` and primitives: only a JSON object can
 * contribute to, or receive, a key-wise recursive merge. An array is never
 * merged key-wise; the layer's rule decides whether it is replaced or
 * concatenated.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Copy one key onto a merge target as an OWN data property.
 *
 * `Object.defineProperty` never consults the inherited `__proto__` accessor or
 * an inherited `constructor` member, so a hostile key cannot reach (or
 * replace) a prototype; an own property under any name is inert data. The
 * property stays enumerable and writable so the merged document reads like a
 * normal parsed object.
 */
function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Read and parse ONE config document.
 *
 * Returns `null` — never throws — when the file is missing, unreadable,
 * malformed, or does not parse to a plain object, so one bad document can
 * never suppress the other.
 */
function readDocument(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  try {
    return asRecord(parseJsonc(raw));
  } catch {
    return null;
  }
}

/**
 * Which fold rule a merge belongs to.
 *
 * The rule decides the array rule: `global` (the explicit config-home pair)
 * replaces arrays, `project` — the project walk and the two home-derived
 * layers 5–8, which opencode merges the same way — concatenates the two keys
 * in {@link PROJECT_ARRAY_MERGES} and replaces everything else. Naming the
 * RULE (rather than passing a loose boolean) keeps it with the call site that
 * owns it.
 */
type FoldLayer = "global" | "project";

/**
 * Array-valued TOP-LEVEL keys opencode concatenates when it folds a
 * project-style document (the project walk and the two home-derived layers
 * 5–8) onto the accumulated config.
 *
 * opencode 1.18.31 merges a project document with `mergeConfigConcatArrays`
 * plus `mergePluginOrigins` (packages/opencode/src/config/config.ts):
 * `instructions` becomes the order-preserving union of both lists, and
 * `plugin` is appended (opencode additionally deduplicates plugin specs by
 * package identity, which rolebox does not need — its only consumer tests
 * membership with `.includes`). Every other array — and every array nested
 * under an object — is replaced by the later document, exactly as remeda's
 * `mergeDeep` does.
 */
const PROJECT_ARRAY_MERGES: ReadonlyMap<
  string,
  (base: readonly unknown[], override: readonly unknown[]) => unknown[]
> = new Map([
  ["instructions", (base, override) => Array.from(new Set([...base, ...override]))],
  ["plugin", (base, override) => [...base, ...override]],
]);

/**
 * Merge `override` onto `base` under one layer's array rule.
 *
 * Keys that are plain objects in BOTH documents merge recursively (always
 * under the GLOBAL array rule: opencode's concatenation is keyed to the two
 * top-level names, not to nesting depth). Every other value — an array, a
 * scalar, or a type change in either direction — is replaced wholesale by
 * `override`'s value, except that the PROJECT layer concatenates the two
 * keys in {@link PROJECT_ARRAY_MERGES}. Every key of both documents is copied
 * through {@link defineOwn}.
 */
function mergeDocuments(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  layer: FoldLayer,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);

  for (const key of keys) {
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inOverride = Object.prototype.hasOwnProperty.call(override, key);

    if (inBase && inOverride) {
      const baseValue = base[key];
      const overrideValue = override[key];
      const baseRecord = asRecord(baseValue);
      const overrideRecord = asRecord(overrideValue);
      const projectArrayMerge =
        layer === "project" ? PROJECT_ARRAY_MERGES.get(key) : undefined;

      if (baseRecord !== null && overrideRecord !== null) {
        defineOwn(
          merged,
          key,
          mergeDocuments(baseRecord, overrideRecord, "global"),
        );
      } else if (
        projectArrayMerge !== undefined &&
        Array.isArray(baseValue) &&
        Array.isArray(overrideValue)
      ) {
        defineOwn(merged, key, projectArrayMerge(baseValue, overrideValue));
      } else {
        defineOwn(merged, key, overrideValue);
      }
    } else if (inOverride) {
      defineOwn(merged, key, override[key]);
    } else {
      defineOwn(merged, key, base[key]);
    }
  }

  return merged;
}

// ── Project walk ────────────────────────────────────────────────────

/**
 * opencode's two config document names, in load order inside ONE directory
 * (the later document wins). Every directory-based layer uses this same pair:
 * the explicit config home (1–2), the project walk (3–4) and the two
 * home-derived layers (5–8).
 */
const CONFIG_DOCUMENT_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/** Project-local directory holding the dot-dir documents (kind 4). */
const PROJECT_DOT_DIR = ".opencode";

/** Directory under the OS home directory holding the home-dot pair (5–6). */
const HOME_DOT_DIR = ".opencode";

/** Prefix of the `gitdir:` line a worktree / submodule `.git` FILE records. */
const GITDIR_PREFIX = "gitdir:";

/**
 * The `gitdir:` target recorded in a `.git` FILE, or `null` when the file
 * holds no such line (or cannot be read).
 *
 * A worktree's `.git` file is one `gitdir: <path>` line. An unreadable file
 * and an empty target both mean "no target", never an exception: a malformed
 * marker must not stop the walk.
 */
function readGitdirTarget(dotGitFile: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(dotGitFile, "utf-8");
  } catch {
    return null;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(GITDIR_PREFIX)) continue;
    const target = trimmed.slice(GITDIR_PREFIX.length).trim();
    return target.length > 0 ? target : null;
  }

  return null;
}

/**
 * Whether `dir` is a git repository root — the directory where the project
 * walk stops.
 *
 * Validity is the measured rule (see the module doc): a `.git` DIRECTORY
 * counts only when it contains `HEAD` (an empty `.git` directory is not a
 * repository), and a `.git` FILE counts only when its `gitdir:` target
 * exists (relative targets resolve against `dir`). Nothing is spawned —
 * `git` is never invoked — so the answer depends only on the filesystem.
 */
function hasGitMarker(dir: string): boolean {
  const dotGit = join(dir, ".git");

  let isDirectory = false;
  let isFile = false;
  try {
    const stats = statSync(dotGit);
    isDirectory = stats.isDirectory();
    isFile = stats.isFile();
  } catch {
    return false;
  }

  if (isDirectory) return existsSync(join(dotGit, "HEAD"));
  if (!isFile) return false;

  const target = readGitdirTarget(dotGit);
  if (target === null) return false;

  return existsSync(isAbsolute(target) ? target : resolve(dir, target));
}

/**
 * The project-walk directories contributing project-level config, OUTERMOST →
 * INNERMOST.
 *
 * Climbs from `projectDir` toward the filesystem root and STOPS after the
 * first directory holding a valid git marker ({@link hasGitMarker}). That
 * repository root IS included — its own documents are read — and nothing above
 * it is. When no marker is found the walk continues to the filesystem root; a
 * parent equal to its child (win32 drive roots, `/`) ends the loop instead of
 * spinning. No environment is read: the result depends only on `projectDir`
 * and the filesystem.
 */
export function projectConfigDirs(projectDir: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(projectDir);

  for (;;) {
    dirs.push(dir);

    if (hasGitMarker(dir)) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Outermost first, so the nearer directory is the later one in the list.
  return dirs.reverse();
}

/**
 * The project-level documents of kinds 3–4 for one project directory.
 *
 * Two directory-major passes, each reproducing opencode's own walk order:
 *
 *   - the plain kind outermost → innermost (the NEARER directory wins), so a
 *     near `opencode.json` beats a far `opencode.jsonc`;
 *   - the dot kind innermost → outermost (the FURTHER `.opencode/` wins), so
 *     an outer `.opencode/opencode.json` beats an inner
 *     `.opencode/opencode.jsonc`.
 *
 * Inside one directory `opencode.json` always precedes `opencode.jsonc`.
 * See the module doc for the measurement behind both orders.
 */
function projectDocumentPaths(projectDir: string): string[] {
  const dirs = projectConfigDirs(projectDir);
  const paths: string[] = [];

  for (const dir of dirs) {
    for (const name of CONFIG_DOCUMENT_NAMES) paths.push(join(dir, name));
  }
  for (let index = dirs.length - 1; index >= 0; index -= 1) {
    for (const name of CONFIG_DOCUMENT_NAMES) {
      paths.push(join(dirs[index], PROJECT_DOT_DIR, name));
    }
  }

  return paths;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Where opencode's documents are resolved from.
 *
 * `projectDir` omitted (or absent) means NO PROJECT WALK: the global pair
 * (1–2) and the two home-derived layers (5–8) are still resolved.
 */
export interface OpencodeConfigOptions {
  /** Explicit config home; defaults to `defaultPlatformPaths().configDir`. */
  configDir?: string;
  /** Project directory whose ancestor walk contributes kinds 3–4. */
  projectDir?: string;
}

/**
 * Normalize the accepted call shapes.
 *
 * The options bag is the API this module advertises. A bare `string` is the
 * legacy `configDir` shorthand, kept because `src/platform/registry.ts`'s
 * registration probe calls both exports that way and is outside the scope of
 * the project-level change; every new caller passes
 * {@link OpencodeConfigOptions}.
 */
function normalizeOptions(
  opts?: OpencodeConfigOptions | string,
): OpencodeConfigOptions {
  if (opts === undefined) return {};
  return typeof opts === "string" ? { configDir: opts } : opts;
}

/**
 * The two global documents, in load order (later wins).
 *
 * `<home>` is `configDir` when given, otherwise the opencode config home from
 * {@link defaultPlatformPaths}.
 */
function globalDocumentPaths(configDir?: string): string[] {
  const home = configDir ?? defaultPlatformPaths().configDir;
  return [join(home, "opencode.json"), join(home, "opencode.jsonc")];
}

/**
 * The OS home directory the home-dot layer (5–6) is resolved against.
 *
 * Read at CALL time, never at module load, so a caller can point the layer at
 * another directory. A non-blank `HOME` wins over {@link homedir}: on POSIX
 * that is exactly the directory opencode's own `os.homedir()` resolves, and
 * Bun freezes `os.homedir()` at the environment the process STARTED with
 * (measured on Bun 1.3.14 — a later `process.env.HOME` assignment never
 * reaches it), so the explicit read is what keeps this module isomorphic with
 * the host it models. An unset or blank `HOME` falls back to {@link homedir}.
 */
function osHomeDir(): string {
  const home = process.env.HOME?.trim() ?? "";
  return home === "" ? homedir() : home;
}

/**
 * The `<os home>/.opencode` documents (5–6), in load order (later wins).
 *
 * opencode folds this layer AFTER the project walk and BEFORE
 * `$OPENCODE_CONFIG_DIR` (measured H1), which is also why it is resolved even
 * when `projectDir` is omitted — it is independent of the walk (measured H3).
 * Inside the directory `opencode.json` precedes `opencode.jsonc` (measured
 * H2). The directory is read at call time by {@link osHomeDir}; a missing
 * directory contributes no documents.
 */
function homeDocumentPaths(): string[] {
  const home = osHomeDir();
  return [
    join(home, HOME_DOT_DIR, "opencode.json"),
    join(home, HOME_DOT_DIR, "opencode.jsonc"),
  ];
}

/**
 * The `$OPENCODE_CONFIG_DIR` documents (7–8), in load order (later wins), or
 * `[]` when the variable is unset or blank.
 *
 * The value is read at CALL time. An unset, empty or whitespace-only value is
 * treated as absent (measured O8: `OPENCODE_CONFIG_DIR=""` behaves exactly
 * like unset). The override ADDS this source; it does not replace the XDG
 * config home or the home-dot layer, which are still read (measured O3-fixed
 * and O6). A directory that does not exist is harmless — the other layers
 * still load, and the paths stay in the returned list (measured O9).
 */
function overrideDocumentPaths(): string[] {
  const dir = process.env.OPENCODE_CONFIG_DIR?.trim() ?? "";
  if (dir === "") return [];
  return [join(dir, "opencode.json"), join(dir, "opencode.jsonc")];
}

/**
 * Fold one layer's documents onto `initial` and return the accumulated
 * document.
 *
 * Each document is read and parsed independently; a missing, unreadable,
 * malformed, or non-object document contributes nothing and does not suppress
 * the others (see the module doc's divergence note). `layer` selects this
 * layer's array rule: the `global` pair replaces arrays, the `project`
 * layers (the walk and the two home-derived layers) concatenate
 * `instructions`/`plugin` (see {@link PROJECT_ARRAY_MERGES}).
 */
function foldDocuments(
  paths: readonly string[],
  initial: Record<string, unknown> | null,
  layer: FoldLayer,
): Record<string, unknown> | null {
  let merged = initial;

  for (const path of paths) {
    const document = readDocument(path);
    if (document === null) continue;
    merged = merged === null ? document : mergeDocuments(merged, document, layer);
  }

  return merged;
}

/**
 * Resolve opencode's config documents in LOAD ORDER (later wins):
 *
 *   `[<home>/opencode.json, <home>/opencode.jsonc,
 *     ...project documents (only when `projectDir` is given),
 *     <os home>/.opencode/opencode.json, <os home>/.opencode/opencode.jsonc,
 *     $OPENCODE_CONFIG_DIR/opencode.json, $OPENCODE_CONFIG_DIR/opencode.jsonc]`
 *
 * where `<home>` is `configDir` when given, otherwise the opencode config home
 * from {@link defaultPlatformPaths}, and `<os home>` is `HOME` when set and
 * non-blank, otherwise {@link homedir}. The project documents of kinds 3–4
 * follow only when `projectDir` is given (see the module doc for the order and
 * {@link projectConfigDirs} for the walk); the home-dot pair (5–6) and the
 * override pair (7–8) are independent of the walk, and the override pair is
 * present only when `OPENCODE_CONFIG_DIR` is set and non-blank. Missing files
 * stay in the list: the loader tolerates them, and returning the full ordered
 * list keeps the order assertable on its own.
 */
export function getOpencodeConfigPaths(
  opts?: OpencodeConfigOptions | string,
): string[] {
  const { configDir, projectDir } = normalizeOptions(opts);
  const paths = globalDocumentPaths(configDir);

  if (projectDir !== undefined) paths.push(...projectDocumentPaths(projectDir));
  paths.push(...homeDocumentPaths());
  paths.push(...overrideDocumentPaths());

  return paths;
}

/**
 * Load and merge opencode's config documents.
 *
 * The layers are folded in the order {@link getOpencodeConfigPaths} returns
 * them, lowest precedence first: the global pair (1–2) under the GLOBAL array
 * rule (arrays are replaced wholesale), then — when `projectDir` is given —
 * the project walk (3–4), then the home-dot pair (5–6) and the override pair
 * (7–8), each under the PROJECT rule (see {@link PROJECT_ARRAY_MERGES}). A
 * missing, unreadable, malformed, or non-object document contributes nothing
 * and does not suppress the others.
 *
 * @returns the merged document, or `null` when NO document yields a plain
 *   object.
 */
export function loadOpencodeConfig(
  opts?: OpencodeConfigOptions | string,
): Record<string, unknown> | null {
  const { configDir, projectDir } = normalizeOptions(opts);

  let merged = foldDocuments(globalDocumentPaths(configDir), null, "global");
  if (projectDir !== undefined) {
    merged = foldDocuments(projectDocumentPaths(projectDir), merged, "project");
  }
  merged = foldDocuments(homeDocumentPaths(), merged, "project");
  merged = foldDocuments(overrideDocumentPaths(), merged, "project");

  return merged;
}
