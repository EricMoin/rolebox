/**
 * opencode's dual config documents.
 *
 * `loadOpencodeConfig` reads <home>/opencode.json then <home>/opencode.jsonc
 * (the later document wins), then the project-level documents of the ancestor
 * walk when a project dir is given, then the `<os home>/.opencode` pair, then
 * the `$OPENCODE_CONFIG_DIR` pair. The plain documents are directory-major
 * outermost → innermost (`opencode.json` then `opencode.jsonc` per
 * directory), the `.opencode/` documents are directory-major innermost →
 * outermost, and both kinds come after the global pair. The walk stops after
 * the first directory that is a VALID git repository root — that directory's
 * own documents are read, nothing above it is — and otherwise climbs to the
 * filesystem root. Objects merge key-wise recursively; arrays are replaced
 * within the global pair and concatenated for `instructions`/`plugin` in
 * every project-style layer (the walk and the two home-derived layers), and
 * one malformed document never suppresses the others. The opencode registry
 * descriptor's registration check is covered here too, because it is the
 * loader's first consumer (and because it calls the loader and the path
 * resolver in their legacy bare-`string` form).
 *
 * Every case writes into a mkdtemp tree and redirects `XDG_CONFIG_HOME`,
 * `HOME` and `OPENCODE_CONFIG_DIR` into it, so a developer's real opencode
 * config is never read. The home-dot layer resolves `HOME` at call time, so
 * the per-case assignment is what keeps it isolated.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  getOpencodeConfigPaths,
  loadOpencodeConfig,
} from "../../src/platform/opencode-config.ts";
import { getPlatformDescriptor } from "../../src/platform/registry.ts";
import { PLUGIN_ID } from "../../src/constants.ts";

const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;

let tmpDir: string;
let configHome: string;
let homeDir: string;
let overrideDir: string;

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-opencode-config-"));
  configHome = join(tmpDir, "opencode");
  homeDir = join(tmpDir, "home");
  overrideDir = join(tmpDir, "override");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.HOME = homeDir;
  process.env.OPENCODE_CONFIG_DIR = overrideDir;
});

afterEach(() => {
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("OPENCODE_CONFIG_DIR", ORIGINAL_OPENCODE_CONFIG_DIR);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write one of opencode's two documents into the isolated config home. */
function writeDocument(name: "opencode.json" | "opencode.jsonc", content: string): void {
  writeFileSync(join(configHome, name), content, "utf-8");
}

/** Whether a usable `git` binary is on PATH, detected once. */
function detectGit(): boolean {
  const result = spawnSync("git", ["--version"], { stdio: "ignore" });
  return result.status === 0 && !result.error;
}

const HAS_GIT = detectGit();

/**
 * Initialize a GENUINE repository at `repoRoot`.
 *
 * The cwd is the repository ROOT itself: running `git init` with its cwd
 * inside `.git/` creates `.git/.git` and never produces a valid repository
 * — the fixture trap src/platform/opencode-config.ts names. `GIT_DIR` /
 * `GIT_WORK_TREE` are cleared so an inherited environment cannot redirect the
 * fixture elsewhere.
 */
function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "-q"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

const JSON_PROVIDER =
  '{ "provider": { "from-json": { "models": { "alpha": { "name": "Alpha" } } } } }';

const JSONC_PROVIDER =
  '{\n  // a JSONC comment the parser must strip\n  "provider": { "from-jsonc": { "models": { "beta": { "name": "Beta" } } } } }';

const MERGED_PROVIDER = {
  provider: {
    "from-json": { models: { alpha: { name: "Alpha" } } },
    "from-jsonc": { models: { beta: { name: "Beta" } } },
  },
};

describe("getOpencodeConfigPaths", () => {
  it("returns every default layer in load order under the isolated seams", () => {
    expect(getOpencodeConfigPaths()).toEqual([
      join(tmpDir, "opencode", "opencode.json"),
      join(tmpDir, "opencode", "opencode.jsonc"),
      join(homeDir, ".opencode", "opencode.json"),
      join(homeDir, ".opencode", "opencode.jsonc"),
      join(overrideDir, "opencode.json"),
      join(overrideDir, "opencode.jsonc"),
    ]);
  });

  it("lets an explicit config home override the platform default", () => {
    expect(getOpencodeConfigPaths({ configDir: "/cfg-opencode" })).toEqual([
      join("/cfg-opencode", "opencode.json"),
      join("/cfg-opencode", "opencode.jsonc"),
      join(homeDir, ".opencode", "opencode.json"),
      join(homeDir, ".opencode", "opencode.jsonc"),
      join(overrideDir, "opencode.json"),
      join(overrideDir, "opencode.jsonc"),
    ]);
  });
});

describe("loadOpencodeConfig", () => {
  it("returns null when neither document exists", () => {
    expect(loadOpencodeConfig({ configDir: configHome })).toBeNull();
  });

  it("reads a document that exists only as opencode.json", () => {
    writeDocument("opencode.json", JSON_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { "from-json": { models: { alpha: { name: "Alpha" } } } },
    });
  });

  it("reads a document that exists only as opencode.jsonc", () => {
    writeDocument("opencode.jsonc", JSONC_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { "from-jsonc": { models: { beta: { name: "Beta" } } } },
    });
  });

  it("reads a byte order mark prefixed opencode.json", () => {
    writeDocument("opencode.json", "\uFEFF" + JSON_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { "from-json": { models: { alpha: { name: "Alpha" } } } },
    });
  });

  it("merges byte order mark prefixed documents as usual", () => {
    writeDocument("opencode.json", "\uFEFF" + JSON_PROVIDER);
    writeDocument("opencode.jsonc", "\uFEFF" + JSONC_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual(MERGED_PROVIDER);
  });

  it("unions provider maps declared across both documents", () => {
    writeDocument("opencode.json", JSON_PROVIDER);
    writeDocument("opencode.jsonc", JSONC_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual(MERGED_PROVIDER);
  });

  it("lets opencode.jsonc win for the same nested key and keeps it once", () => {
    writeDocument(
      "opencode.json",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "From JSON" } } } } }',
    );
    writeDocument(
      "opencode.jsonc",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "From JSONC" } } } } }',
    );

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { oc: { models: { "gpt-4o": { name: "From JSONC" } } } },
    });
  });

  it("replaces an array-valued key wholesale within the global pair", () => {
    writeDocument("opencode.json", '{ "instructions": ["from-json.md"], "theme": "dark" }');
    writeDocument("opencode.jsonc", '{ "instructions": ["from-jsonc.md"] }');

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      instructions: ["from-jsonc.md"],
      theme: "dark",
    });
  });

  it("uses an array declared in only one document", () => {
    writeDocument("opencode.json", '{ "instructions": ["only-in-json.md"] }');
    writeDocument("opencode.jsonc", '{ "theme": "dark" }');

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      instructions: ["only-in-json.md"],
      theme: "dark",
    });
  });

  it("still uses the valid opencode.jsonc when opencode.json is malformed", () => {
    writeDocument("opencode.json", '{ "provider": ');
    writeDocument("opencode.jsonc", JSONC_PROVIDER);

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { "from-jsonc": { models: { beta: { name: "Beta" } } } },
    });
  });

  it("still uses the valid opencode.json when opencode.jsonc is malformed", () => {
    writeDocument("opencode.json", JSON_PROVIDER);
    writeDocument("opencode.jsonc", "{ /* unterminated");

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({
      provider: { "from-json": { models: { alpha: { name: "Alpha" } } } },
    });
  });

  it("ignores a non-object document without discarding the other", () => {
    writeDocument("opencode.json", "[1, 2, 3]");
    writeDocument("opencode.jsonc", '{ "theme": "dark" }');

    expect(loadOpencodeConfig({ configDir: configHome })).toEqual({ theme: "dark" });
  });

  it("returns null when neither document parses to a plain object", () => {
    writeDocument("opencode.json", "[]");
    writeDocument("opencode.jsonc", '"a string"');

    expect(loadOpencodeConfig({ configDir: configHome })).toBeNull();
  });
});

// ── Project-level documents ───────────────────────────────────────

describe("opencode project-level documents", () => {
  /** Write one opencode document into an arbitrary directory, creating it. */
  function writeIn(
    dir: string,
    name: "opencode.json" | "opencode.jsonc",
    content: string,
  ): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  /** A document declaring one model under one provider. */
  function providerDocument(provider: string, model: string, display: string): string {
    return JSON.stringify({
      provider: { [provider]: { models: { [model]: { name: display } } } },
    });
  }

  /** The merged provider map, or {} when the merge produced none. */
  function providers(config: Record<string, unknown> | null): Record<string, unknown> {
    const provider = config?.provider;
    return typeof provider === "object" && provider !== null
      ? (provider as Record<string, unknown>)
      : {};
  }

  it("orders the global pair, then the plain kind outer→inner and the dot kind inner→outer", () => {
    const projectDir = join(tmpDir, "ordered");
    const mid = join(projectDir, "mid");
    const inner = join(mid, "inner");
    mkdirSync(inner, { recursive: true });

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir: inner });

    // The global pair is always first.
    expect(paths.slice(0, 2)).toEqual([
      join(configHome, "opencode.json"),
      join(configHome, "opencode.jsonc"),
    ]);
    // The walk climbs past the temp root to the filesystem root, so assert the
    // order of the injected tree alone.
    expect(paths.filter((path) => path.startsWith(projectDir + sep))).toEqual([
      join(projectDir, "opencode.json"),
      join(projectDir, "opencode.jsonc"),
      join(mid, "opencode.json"),
      join(mid, "opencode.jsonc"),
      join(inner, "opencode.json"),
      join(inner, "opencode.jsonc"),
      join(inner, ".opencode", "opencode.json"),
      join(inner, ".opencode", "opencode.jsonc"),
      join(mid, ".opencode", "opencode.json"),
      join(mid, ".opencode", "opencode.jsonc"),
      join(projectDir, ".opencode", "opencode.json"),
      join(projectDir, ".opencode", "opencode.jsonc"),
    ]);
  });

  it("adds the home-derived layers but no project documents when projectDir is omitted", () => {
    const notRead = writeIn(
      join(tmpDir, "not-read"),
      "opencode.json",
      providerDocument("proj", "m", "P"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome });

    // The project walk does not run at all...
    expect(paths).not.toContain(notRead);
    // ...but the home-dot pair and the override pair are independent of it.
    expect(paths).toEqual([
      join(configHome, "opencode.json"),
      join(configHome, "opencode.jsonc"),
      join(homeDir, ".opencode", "opencode.json"),
      join(homeDir, ".opencode", "opencode.jsonc"),
      join(overrideDir, "opencode.json"),
      join(overrideDir, "opencode.jsonc"),
    ]);
  });

  it.skipIf(!HAS_GIT)("stops at a REAL git init repository root (measured S1)", () => {
    const repoRoot = join(tmpDir, "repo-real");
    const projectDir = join(repoRoot, "packages", "app");
    mkdirSync(projectDir, { recursive: true });
    gitInit(repoRoot);

    writeIn(repoRoot, "opencode.json", providerDocument("repo-root", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-repo", "not-read", "Nope"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    // The repository root is INCLUDED: its own document is read...
    expect(paths).toContain(join(repoRoot, "opencode.json"));
    expect(provider["repo-root"]).toBeDefined();
    // ...and the walk stops there, so the document one level up is NOT read.
    expect(paths).not.toContain(above);
    expect(provider["above-repo"]).toBeUndefined();
  });

  it("stops at a worktree-style .git FILE whose target exists (measured S2)", () => {
    const repoRoot = join(tmpDir, "repo-worktree");
    const projectDir = join(repoRoot, "app");
    const gitDir = join(tmpDir, "worktree-gitdir");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), `gitdir: ${gitDir}\n`, "utf-8");

    writeIn(repoRoot, "opencode.json", providerDocument("worktree-root", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-worktree", "not-read", "Nope"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    expect(paths).toContain(join(repoRoot, "opencode.json"));
    expect(provider["worktree-root"]).toBeDefined();
    expect(paths).not.toContain(above);
    expect(provider["above-worktree"]).toBeUndefined();
  });

  it("resolves a RELATIVE gitdir target against the .git file's directory", () => {
    const repoRoot = join(tmpDir, "repo-relative-gitdir");
    const projectDir = join(repoRoot, "app");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(tmpDir, "sibling-gitdir"), { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ../sibling-gitdir\n", "utf-8");

    writeIn(repoRoot, "opencode.json", providerDocument("relative-root", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-relative", "not-read", "Nope"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    // The target is a SIBLING of repoRoot, so only a resolve against repoRoot
    // finds it; resolving against the process cwd would keep walking.
    expect(provider["relative-root"]).toBeDefined();
    expect(paths).not.toContain(above);
    expect(provider["above-relative"]).toBeUndefined();
  });

  it("keeps walking when a .git FILE points at a nonexistent gitdir (measured)", () => {
    const repoRoot = join(tmpDir, "repo-dangling-gitdir");
    const projectDir = join(repoRoot, "app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(repoRoot, ".git"),
      `gitdir: ${join(tmpDir, "missing-gitdir")}\n`,
      "utf-8",
    );

    writeIn(repoRoot, "opencode.json", providerDocument("dangling-root", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-dangling", "also-read", "Also"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    expect(provider["dangling-root"]).toBeDefined();
    expect(paths).toContain(above);
    expect(provider["above-dangling"]).toBeDefined();
  });

  it("keeps walking when a .git FILE records no gitdir target", () => {
    const repoRoot = join(tmpDir, "repo-no-gitdir-line");
    const projectDir = join(repoRoot, "app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "not a gitdir pointer\n", "utf-8");

    writeIn(repoRoot, "opencode.json", providerDocument("not-a-marker", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-not-a-marker", "also-read", "Also"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    expect(provider["not-a-marker"]).toBeDefined();
    expect(paths).toContain(above);
    expect(provider["above-not-a-marker"]).toBeDefined();
  });

  it("keeps walking past an EMPTY .git DIRECTORY (measured S3)", () => {
    const projectDir = join(tmpDir, "repo-empty-git");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeIn(projectDir, "opencode.json", providerDocument("empty-git", "kept", "Kept"));
    const above = writeIn(
      tmpDir,
      "opencode.json",
      providerDocument("above-empty-git", "also-read", "Also"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    expect(provider["empty-git"]).toBeDefined();
    expect(paths).toContain(above);
    expect(provider["above-empty-git"]).toBeDefined();
  });

  it("walks to the filesystem root when no .git exists anywhere", () => {
    const root = join(tmpDir, "no-git-root");
    const deep = join(root, "a", "b", "c", "d", "e", "f");
    mkdirSync(deep, { recursive: true });
    const ancestorDoc = writeIn(
      root,
      "opencode.json",
      providerDocument("ancestor", "deep-model", "Deep"),
    );

    const paths = getOpencodeConfigPaths({ configDir: configHome, projectDir: deep });
    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir: deep }));

    // Six levels up — and still reached: there is no home-directory stop.
    expect(paths).toContain(ancestorDoc);
    expect(provider.ancestor).toBeDefined();
  });

  it("lets a project document override the global pair for a duplicate key", () => {
    writeDocument(
      "opencode.json",
      JSON.stringify({
        theme: "global",
        provider: { shared: { models: { m: { name: "Global M" } } } },
      }),
    );
    const projectDir = join(tmpDir, "override-project");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeIn(
      projectDir,
      "opencode.json",
      JSON.stringify({
        theme: "project",
        provider: { shared: { models: { m: { name: "Project M" } } } },
      }),
    );

    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      theme: "project",
      provider: { shared: { models: { m: { name: "Project M" } } } },
    });
  });

  it("unions project models with global ones", () => {
    writeDocument("opencode.json", providerDocument("global-provider", "global-model", "Global"));
    const projectDir = join(tmpDir, "union-project");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeIn(
      projectDir,
      "opencode.jsonc",
      providerDocument("project-provider", "project-model", "Project"),
    );

    const provider = providers(loadOpencodeConfig({ configDir: configHome, projectDir }));

    expect(provider["global-provider"]).toBeDefined();
    expect(provider["project-provider"]).toBeDefined();
  });

  it("lets the nearer directory win WITHIN the plain kind (measured, decisive case)", () => {
    const outer = join(tmpDir, "near-outer");
    const inner = join(outer, "mid");
    mkdirSync(inner, { recursive: true });
    writeIn(outer, "opencode.jsonc", providerDocument("oc", "shared", "Outer jsonc"));
    writeIn(inner, "opencode.json", providerDocument("oc", "shared", "Inner json"));

    // A NEARER opencode.json beats a FARTHER opencode.jsonc, so the plain kind
    // is folded directory-major outermost to innermost.
    expect(loadOpencodeConfig({ configDir: configHome, projectDir: inner })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Inner json" } } } },
    });
  });

  it("lets the FURTHER directory win WITHIN the dot kind (measured, decisive case)", () => {
    const outer = join(tmpDir, "far-outer");
    const inner = join(outer, "mid");
    mkdirSync(inner, { recursive: true });
    writeIn(
      join(outer, ".opencode"),
      "opencode.json",
      providerDocument("oc", "shared", "Outer dot json"),
    );
    writeIn(
      join(inner, ".opencode"),
      "opencode.jsonc",
      providerDocument("oc", "shared", "Inner dot jsonc"),
    );

    // A FARTHER .opencode/opencode.json beats a NEARER .opencode/opencode.jsonc,
    // so the dot kind is folded directory-major innermost to outermost.
    expect(loadOpencodeConfig({ configDir: configHome, projectDir: inner })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Outer dot json" } } } },
    });
  });

  it("lets the KIND dominate depth (measured: outer dot-dir beats inner plain)", () => {
    const outer = join(tmpDir, "kind-outer");
    const inner = join(outer, "mid");
    mkdirSync(inner, { recursive: true });
    writeIn(
      join(outer, ".opencode"),
      "opencode.json",
      providerDocument("oc", "shared", "Outer dot-dir"),
    );
    writeIn(inner, "opencode.json", providerDocument("oc", "shared", "Inner plain"));

    expect(loadOpencodeConfig({ configDir: configHome, projectDir: inner })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Outer dot-dir" } } } },
    });
  });

  it("concatenates plugin across the global-to-project boundary (measured)", () => {
    writeDocument("opencode.json", '{ "plugin": ["global-plugin"] }');
    const projectDir = join(tmpDir, "array-project");
    mkdirSync(projectDir, { recursive: true });
    writeIn(projectDir, "opencode.json", '{ "plugin": ["project-plugin"] }');

    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      plugin: ["global-plugin", "project-plugin"],
    });
  });

  it("concatenates plugin between project documents, outer before inner", () => {
    const outer = join(tmpDir, "array-outer");
    const inner = join(outer, "mid");
    mkdirSync(inner, { recursive: true });
    writeIn(outer, "opencode.json", '{ "plugin": ["outer-plugin"] }');
    writeIn(inner, "opencode.json", '{ "plugin": ["inner-plugin"] }');

    expect(loadOpencodeConfig({ configDir: configHome, projectDir: inner })).toMatchObject({
      plugin: ["outer-plugin", "inner-plugin"],
    });
  });

  it("unions instructions across the project layer", () => {
    writeDocument("opencode.json", '{ "instructions": ["global.md"] }');
    const projectDir = join(tmpDir, "instructions-project");
    mkdirSync(projectDir, { recursive: true });
    writeIn(projectDir, "opencode.jsonc", '{ "instructions": ["project.md"] }');

    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      instructions: ["global.md", "project.md"],
    });
  });

  it("still replaces the global pair's plugin array (measured)", () => {
    writeDocument("opencode.json", '{ "plugin": ["from-json"] }');
    writeDocument("opencode.jsonc", '{ "plugin": ["from-jsonc"] }');

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      plugin: ["from-jsonc"],
    });
  });

  it("replaces an array key opencode does not concatenate (source-derived)", () => {
    writeDocument("opencode.json", '{ "disabled_providers": ["global-provider"] }');
    const projectDir = join(tmpDir, "other-array-project");
    mkdirSync(projectDir, { recursive: true });
    writeIn(projectDir, "opencode.json", '{ "disabled_providers": ["project-provider"] }');

    // 1.18.31 concatenates only instructions and plugin in the project layer;
    // remeda's mergeDeep replaces every other array.
    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      disabled_providers: ["project-provider"],
    });
  });
});

// ── Home-dot and OPENCODE_CONFIG_DIR layers (measured H1–H5, O1–O9) ──

describe("opencode home-dot and OPENCODE_CONFIG_DIR layers", () => {
  /** A one-provider document whose shared `oc` model is named `display`. */
  function namedModel(display: string): string {
    return JSON.stringify({
      provider: { oc: { models: { shared: { name: display } } } },
    });
  }

  /** A one-provider document declaring `provider` with a single model. */
  function layerDocument(provider: string, display: string): string {
    return JSON.stringify({
      provider: { [provider]: { models: { m: { name: display } } } },
    });
  }

  /** Write one opencode document into `dir`, creating it. */
  function writeIn(
    dir: string,
    name: "opencode.json" | "opencode.jsonc",
    content: string,
  ): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  /** The merged provider map, or {} when the merge produced none. */
  function providers(config: Record<string, unknown> | null): Record<string, unknown> {
    const provider = config?.provider;
    return typeof provider === "object" && provider !== null
      ? (provider as Record<string, unknown>)
      : {};
  }

  it("orders all eight layers: global pair, project walk, home-dot pair, override pair", () => {
    const projectDir = join(tmpDir, "eight-layers");
    // A `.git` DIRECTORY containing HEAD is a valid marker, so the walk stops
    // at the project directory and the list is exactly the four directory
    // pairs — every one of the eight layers, with no ancestor noise.
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeFileSync(join(projectDir, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");

    expect(getOpencodeConfigPaths({ configDir: configHome, projectDir })).toEqual([
      join(configHome, "opencode.json"),
      join(configHome, "opencode.jsonc"),
      join(projectDir, "opencode.json"),
      join(projectDir, "opencode.jsonc"),
      join(projectDir, ".opencode", "opencode.json"),
      join(projectDir, ".opencode", "opencode.jsonc"),
      join(homeDir, ".opencode", "opencode.json"),
      join(homeDir, ".opencode", "opencode.jsonc"),
      join(overrideDir, "opencode.json"),
      join(overrideDir, "opencode.jsonc"),
    ]);
  });

  it("lets the home-dot document beat the global pair and the project walk (H1)", () => {
    const projectDir = join(tmpDir, "home-wins-project");
    mkdirSync(projectDir, { recursive: true });
    delete process.env.OPENCODE_CONFIG_DIR;
    writeDocument("opencode.jsonc", namedModel("Global"));
    writeIn(projectDir, "opencode.json", namedModel("Project"));
    writeIn(join(homeDir, ".opencode"), "opencode.json", namedModel("Home"));

    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Home" } } } },
    });
  });

  it("lets the override document beat the home-dot layer and the project walk (O1, O4)", () => {
    const projectDir = join(tmpDir, "override-wins-project");
    mkdirSync(projectDir, { recursive: true });
    writeDocument("opencode.json", namedModel("Global"));
    writeIn(projectDir, "opencode.json", namedModel("Project"));
    writeIn(join(homeDir, ".opencode"), "opencode.json", namedModel("Home"));
    writeIn(overrideDir, "opencode.json", namedModel("Override"));

    expect(loadOpencodeConfig({ configDir: configHome, projectDir })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Override" } } } },
    });
  });

  it("keeps the XDG global document while ADDING the override source (O3-fixed)", () => {
    writeDocument("opencode.json", layerDocument("xdg-only", "XDG"));
    writeIn(overrideDir, "opencode.json", layerDocument("override-only", "Override"));

    const provider = providers(loadOpencodeConfig({ configDir: configHome }));

    expect(provider["xdg-only"]).toBeDefined();
    expect(provider["override-only"]).toBeDefined();
  });

  it("still reads the home-dot layer when the override is set (O6)", () => {
    writeIn(join(homeDir, ".opencode"), "opencode.json", layerDocument("home-only", "Home"));
    writeIn(overrideDir, "opencode.json", layerDocument("override-only", "Override"));

    const provider = providers(loadOpencodeConfig({ configDir: configHome }));

    expect(provider["home-only"]).toBeDefined();
    expect(provider["override-only"]).toBeDefined();
  });

  it("reads the home-dot layer even when projectDir is omitted (H3)", () => {
    const notRead = writeIn(
      join(tmpDir, "no-project-walk"),
      "opencode.json",
      namedModel("Project"),
    );
    writeIn(join(homeDir, ".opencode"), "opencode.json", namedModel("Home"));

    const paths = getOpencodeConfigPaths({ configDir: configHome });

    expect(paths).toContain(join(homeDir, ".opencode", "opencode.json"));
    expect(paths).not.toContain(notRead);
    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Home" } } } },
    });
  });

  it("lets opencode.jsonc beat opencode.json inside the home-dot directory (H2)", () => {
    writeIn(join(homeDir, ".opencode"), "opencode.json", namedModel("Home JSON"));
    writeIn(join(homeDir, ".opencode"), "opencode.jsonc", namedModel("Home JSONC"));

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Home JSONC" } } } },
    });
  });

  it("lets opencode.jsonc beat opencode.json inside the override directory (O5)", () => {
    writeIn(overrideDir, "opencode.json", namedModel("Override JSON"));
    writeIn(overrideDir, "opencode.jsonc", namedModel("Override JSONC"));

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      provider: { oc: { models: { shared: { name: "Override JSONC" } } } },
    });
  });

  it("concatenates plugin between the global pair and the home-dot layer (H5)", () => {
    writeDocument("opencode.json", '{ "plugin": ["g1"] }');
    writeIn(join(homeDir, ".opencode"), "opencode.jsonc", '{ "plugin": ["h1"] }');

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      plugin: ["g1", "h1"],
    });
  });

  it("concatenates plugin from the global pair through to the override layer (O7)", () => {
    writeDocument("opencode.json", '{ "plugin": ["g1"] }');
    writeIn(join(homeDir, ".opencode"), "opencode.json", '{ "plugin": ["h1"] }');
    writeIn(overrideDir, "opencode.json", '{ "plugin": ["o1"] }');

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      plugin: ["g1", "h1", "o1"],
    });
  });

  it("unions instructions across the home-dot layer too (project-style rule)", () => {
    writeDocument("opencode.json", '{ "instructions": ["global.md"] }');
    writeIn(join(homeDir, ".opencode"), "opencode.json", '{ "instructions": ["home.md"] }');

    expect(loadOpencodeConfig({ configDir: configHome })).toMatchObject({
      instructions: ["global.md", "home.md"],
    });
  });

  it("treats an empty or whitespace-only OPENCODE_CONFIG_DIR as unset (O8)", () => {
    writeIn(overrideDir, "opencode.json", namedModel("Override"));

    for (const value of ["", "   ", "\t"]) {
      process.env.OPENCODE_CONFIG_DIR = value;

      expect(getOpencodeConfigPaths({ configDir: configHome })).toEqual([
        join(configHome, "opencode.json"),
        join(configHome, "opencode.jsonc"),
        join(homeDir, ".opencode", "opencode.json"),
        join(homeDir, ".opencode", "opencode.jsonc"),
      ]);
      // Neither document exists outside the override dir, so a merge that
      // reaches a document at all would not be null.
      expect(loadOpencodeConfig({ configDir: configHome })).toBeNull();
    }
  });

  it("loads the other layers when the override directory does not exist (O9)", () => {
    const missing = join(tmpDir, "missing-override");
    process.env.OPENCODE_CONFIG_DIR = missing;
    writeDocument("opencode.json", layerDocument("xdg-only", "XDG"));
    writeIn(join(homeDir, ".opencode"), "opencode.json", layerDocument("home-only", "Home"));

    const paths = getOpencodeConfigPaths({ configDir: configHome });
    const provider = providers(loadOpencodeConfig({ configDir: configHome }));

    // A missing directory contributes no documents, but its paths stay in the
    // ordered list.
    expect(paths).toContain(join(missing, "opencode.json"));
    expect(paths).toContain(join(missing, "opencode.jsonc"));
    expect(provider["xdg-only"]).toBeDefined();
    expect(provider["home-only"]).toBeDefined();
  });

  it("falls back to os.homedir() when HOME is blank", () => {
    delete process.env.HOME;

    const paths = getOpencodeConfigPaths({ configDir: configHome });

    // Paths only — no document is read from the fallback home.
    expect(paths).toContain(join(homedir(), ".opencode", "opencode.json"));
    expect(paths).toContain(join(homedir(), ".opencode", "opencode.jsonc"));
  });
});

describe("loadOpencodeConfig prototype-pollution guard", () => {
  it("copies a merged __proto__ key as own data and never touches Object.prototype", () => {
    writeDocument(
      "opencode.json",
      '{ "__proto__": { "polluted": "yes" }, "agent": { "__proto__": { "nested": "yes" } } }',
    );
    writeDocument("opencode.jsonc", '{ "agent": { "theme": "dark" } }');

    const config = loadOpencodeConfig({ configDir: configHome });

    expect(config).not.toBeNull();
    const merged = config as Record<string, unknown>;

    // The dangerous key is inert OWN data, not a prototype swap.
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(merged, "__proto__")).toBe(true);

    // Neither the global prototype nor a fresh object gained a key.
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "nested")).toBe(false);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(probe.nested).toBeUndefined();

    // The recursion still merged the benign sibling.
    const agent = merged.agent as Record<string, unknown>;
    expect(agent.theme).toBe("dark");
    expect(Object.getPrototypeOf(agent)).toBe(Object.prototype);
    expect(agent.nested).toBeUndefined();
  });

  it("keeps constructor/prototype keys as own data", () => {
    writeDocument("opencode.json", '{ "constructor": { "prototype": { "polluted": true } } }');
    writeDocument("opencode.jsonc", '{ "constructor": { "name": "still data" } }');

    const config = loadOpencodeConfig({ configDir: configHome });

    expect(config).not.toBeNull();
    const merged = config as Record<string, unknown>;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(merged, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
  });

  it("returns a lone dangerous document without a prototype swap", () => {
    writeDocument("opencode.json", '{ "__proto__": { "polluted": "yes" } }');

    const config = loadOpencodeConfig({ configDir: configHome });

    expect(config).not.toBeNull();
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
  });
});

describe("opencode registry descriptor registration", () => {
  it("reports registered when the plugin array lives in opencode.jsonc", () => {
    writeDocument("opencode.jsonc", '{ "plugin": ["' + PLUGIN_ID + '"] }');

    const integration = getPlatformDescriptor("opencode").detectIntegration();

    expect(integration?.mechanism).toBe("Plugin");
    expect(integration?.registered).toBe(true);
    expect(integration?.detail).toBe("registered");
    expect(integration?.hint).toBeUndefined();
  });

  it("reports registered when the plugin array lives in opencode.json", () => {
    writeDocument("opencode.json", '{ "plugin": ["' + PLUGIN_ID + '@1.10.0"] }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(true);
  });

  it("reports registered for a byte order mark prefixed document", () => {
    writeDocument("opencode.json", "\uFEFF" + '{ "plugin": ["' + PLUGIN_ID + '"] }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(true);
  });

  it("merges both files, so a rolebox entry in either one counts", () => {
    writeDocument("opencode.json", '{ "plugin": ["some-other-plugin", "' + PLUGIN_ID + '"] }');
    writeDocument("opencode.jsonc", '{ "theme": "dark" }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(true);
  });

  it("lets a .jsonc plugin array that omits rolebox replace the .json array", () => {
    writeDocument("opencode.json", '{ "plugin": ["' + PLUGIN_ID + '"] }');
    writeDocument("opencode.jsonc", '{ "plugin": ["some-other-plugin"] }');

    const integration = getPlatformDescriptor("opencode").detectIntegration();

    expect(integration?.registered).toBe(false);
    expect(integration?.detail).toBe("not found in opencode config");
  });

  it("reports not registered when neither document lists rolebox", () => {
    writeDocument("opencode.json", '{ "plugin": ["some-other-plugin"] }');
    writeDocument("opencode.jsonc", '{ "plugin": [] }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(false);
  });

  it("reports not registered when no opencode document exists", () => {
    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(false);
  });

  it("reports not registered for a non-array plugin value", () => {
    writeDocument("opencode.jsonc", '{ "plugin": "' + PLUGIN_ID + '" }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(false);
  });

  it("keeps the valid document when the other is malformed", () => {
    writeDocument("opencode.json", '{ "plugin": ');
    writeDocument("opencode.jsonc", '{ "plugin": ["' + PLUGIN_ID + '"] }');

    expect(getPlatformDescriptor("opencode").detectIntegration()?.registered).toBe(true);
  });

  it("hints at both documents when not registered", () => {
    const integration = getPlatformDescriptor("opencode").detectIntegration();

    expect(integration?.hint).toContain(join(configHome, "opencode.jsonc"));
    expect(integration?.hint).toContain(join(configHome, "opencode.json"));
  });
});
