/**
 * Per-harness model catalogs.
 *
 * Each `SyncTarget` reads its OWN declaration — opencode's merged
 * `opencode.json` + `opencode.jsonc`, dsh `settings.yaml` under
 * `llm-pi-ai.providers.<route>.models[]`, pi
 * `models.json` — and {@link scanModelsForTarget} seeds a target from its
 * declared fallback when its own catalog yields nothing.
 *
 * The opencode source also reads PROJECT-level documents when the dispatcher
 * is given a `projectDir`; dsh and pi ignore that field. Every case passes an
 * explicit config home or redirects the platform env seams
 * (`XDG_CONFIG_HOME` / `DSH_HOME` / `PI_CODING_AGENT_DIR`) into a tmpdir, and
 * the opencode reader's two home-derived layers — `HOME`'s `.opencode` pair
 * and `$OPENCODE_CONFIG_DIR` — are redirected into that same tmpdir, so no
 * real home directory is read. Every project fixture lives inside that tmpdir
 * tree. (opencode's walk stops at the first valid `.git` marker and
 * otherwise climbs to the filesystem root; the injected trees absorb that, as
 * in tests/platform/opencode-config.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOpencodeCatalog } from "../../src/platform/model-catalog/opencode.ts";
import { getOpencodeConfigPaths } from "../../src/platform/opencode-config.ts";
import {
  getDshSettingsPath,
  readDshCatalog,
} from "../../src/platform/model-catalog/dsh.ts";
import {
  getPiModelsPath,
  readPiCatalog,
} from "../../src/platform/model-catalog/pi.ts";
import {
  MODEL_SOURCES,
  scanModelsForTarget,
} from "../../src/platform/model-catalog/index.ts";
import { SYNC_TARGET_VALUES } from "../../src/constants.ts";

// ── Env seams ─────────────────────────────────────────────────────

const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_DSH_HOME = process.env.DSH_HOME;
const ORIGINAL_PI_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;

let tmpDir: string;
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
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-model-catalog-"));
  homeDir = join(tmpDir, "home");
  overrideDir = join(tmpDir, "override");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.DSH_HOME = join(tmpDir, "dsh-home");
  process.env.PI_CODING_AGENT_DIR = join(tmpDir, "pi-agent");
  process.env.HOME = homeDir;
  process.env.OPENCODE_CONFIG_DIR = overrideDir;
});

afterEach(() => {
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  restoreEnv("DSH_HOME", ORIGINAL_DSH_HOME);
  restoreEnv("PI_CODING_AGENT_DIR", ORIGINAL_PI_DIR);
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("OPENCODE_CONFIG_DIR", ORIGINAL_OPENCODE_CONFIG_DIR);
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write `{name}` into its own fresh config home and return that home.
 *
 * A reader is handed a harness config HOME and appends its own filename, so
 * fixtures live at `{home}/{harness filename}`; a fresh home per call keeps
 * each case's target and seed documents apart.
 */
function writeConfigHome(name: string, content: string): string {
  const home = mkdtempSync(join(tmpDir, "home-"));
  writeFileSync(join(home, name), content, "utf-8");
  return home;
}

/** Write both opencode documents into one fresh config home. */
function writeOpencodeDocs(json: string, jsonc: string): string {
  const home = mkdtempSync(join(tmpDir, "home-"));
  writeFileSync(join(home, "opencode.json"), json, "utf-8");
  writeFileSync(join(home, "opencode.jsonc"), jsonc, "utf-8");
  return home;
}

/** Write the default opencode document under the isolated XDG config dir. */
function writeDefaultOpencodeConfig(content: string): string {
  const dir = join(tmpDir, "opencode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.jsonc");
  writeFileSync(path, content, "utf-8");
  return path;
}

/**
 * Write a project-level opencode document into a fresh project directory under
 * the isolated tmpdir and return that directory.
 *
 * The walk has no `.git` stop, so the reader also climbs the tmpdir's
 * ancestors; those carry no opencode document, and the cases below assert the
 * presence of the fixture's providers rather than the absence of others.
 */
function writeProjectConfig(json: string): string {
  const projectDir = mkdtempSync(join(tmpDir, "project-"));
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  writeFileSync(join(projectDir, "opencode.json"), json, "utf-8");
  return projectDir;
}

// ── Fixtures ──────────────────────────────────────────────────────

const OPENCODE_JSONC = `{
  // A comment the JSONC parser must strip
  "provider": {
    "oc": {
      "models": {
        "gpt-4o": { "name": "GPT-4o" }
      }
    }
  }
}`;

/** A trailing `//` comment whose text contains a double quote (defect 1). */
const OPENCODE_JSONC_TRAILING_QUOTE_COMMENT = `{
  "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } }
} // don't touch "this"`;

/** A block comment the removed regex heuristic left in place (defect 2). */
const OPENCODE_JSONC_BLOCK_COMMENT = `{
  /* provider configuration */
  "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } }
}`;

/** A realistic dsh settings document: agent-default-model + llm-pi-ai routes. */
const POPULATED_DSH_SETTINGS = `
agent-default-model:
  provider: openrouter
  model: anthropic/claude-sonnet-4
llm-pi-ai:
  providers:
    openrouter:
      api: openai-completions
      baseURL: https://example.test/v1
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - id: anthropic/claude-sonnet-4
          name: claude-sonnet-4
        - id: openai/gpt-4o-mini
    openrouter-anthropic:
      api: anthropic-messages
      models:
        - id: anthropic/claude-opus-4.8
          name: Claude Opus 4.8
`;

const POPULATED_PI_MODELS = `{
  // pi's own parser strips comments before validating
  "providers": {
    "pi-anthropic": {
      "name": "Anthropic",
      "models": [
        { "id": "claude-sonnet-4", "name": "Claude Sonnet 4" },
        { "id": "claude-opus-4.8" }
      ]
    },
    "pi-local": {
      "models": [{ "id": "llama-3.1-8b", "name": "Llama 3.1 8B" }]
    }
  }
}`;

// ── Default paths ─────────────────────────────────────────────────

describe("default catalog paths", () => {
  it("resolves every opencode layer under the isolated seams in load order", () => {
    expect(getOpencodeConfigPaths()).toEqual([
      join(tmpDir, "opencode", "opencode.json"),
      join(tmpDir, "opencode", "opencode.jsonc"),
      join(homeDir, ".opencode", "opencode.json"),
      join(homeDir, ".opencode", "opencode.jsonc"),
      join(overrideDir, "opencode.json"),
      join(overrideDir, "opencode.jsonc"),
    ]);
  });

  it("resolves the dsh settings document under DSH_HOME", () => {
    expect(getDshSettingsPath()).toBe(join(tmpDir, "dsh-home", "settings.yaml"));
  });

  it("resolves the pi models document under PI_CODING_AGENT_DIR", () => {
    expect(getPiModelsPath()).toBe(join(tmpDir, "pi-agent", "models.json"));
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
    expect(getDshSettingsPath("/cfg-dsh")).toBe(join("/cfg-dsh", "settings.yaml"));
    expect(getPiModelsPath("/cfg-pi")).toBe(join("/cfg-pi", "models.json"));
  });
});

// ── opencode ──────────────────────────────────────────────────────

describe("readOpencodeCatalog (opencode JSONC)", () => {
  it("keeps models when a trailing `//` comment contains a double quote", () => {
    const home = writeConfigHome("opencode.jsonc", OPENCODE_JSONC_TRAILING_QUOTE_COMMENT);

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("keeps models when the document contains a block comment", () => {
    const home = writeConfigHome("opencode.jsonc", OPENCODE_JSONC_BLOCK_COMMENT);

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("skips an array-valued `models` node instead of emitting index ids", () => {
    const home = writeConfigHome(
      "opencode.jsonc",
      `{
        "provider": {
          "oc": { "models": [{ "name": "a" }, { "name": "b" }] },
          "real": { "models": { "gpt-4o": { "name": "GPT-4o" } } }
        }
      }`,
    );

    // The array-valued provider contributes nothing: no `oc/0`, `oc/1` ids.
    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "real/gpt-4o", name: "GPT-4o", provider: "real" },
    ]);
  });
});

describe("readOpencodeCatalog (opencode.json + opencode.jsonc)", () => {
  it("reads models declared only in opencode.json", () => {
    const home = writeConfigHome(
      "opencode.json",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("reads models declared only in opencode.jsonc", () => {
    const home = writeConfigHome(
      "opencode.jsonc",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("unions the provider models declared across both documents", () => {
    const home = writeOpencodeDocs(
      '{ "provider": { "from-json": { "models": { "alpha": { "name": "Alpha" } } } } }',
      '{ "provider": { "from-jsonc": { "models": { "beta": { "name": "Beta" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "from-json/alpha", name: "Alpha", provider: "from-json" },
      { id: "from-jsonc/beta", name: "Beta", provider: "from-jsonc" },
    ]);
  });

  it("reads byte order mark prefixed documents", () => {
    const home = writeOpencodeDocs(
      "\uFEFF" +
        '{ "provider": { "from-json": { "models": { "alpha": { "name": "Alpha" } } } } }',
      "\uFEFF" +
        '{ "provider": { "from-jsonc": { "models": { "beta": { "name": "Beta" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "from-json/alpha", name: "Alpha", provider: "from-json" },
      { id: "from-jsonc/beta", name: "Beta", provider: "from-jsonc" },
    ]);
  });

  it("lets the .jsonc model entry replace the .json entry for the same key", () => {
    const home = writeOpencodeDocs(
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "From JSON" } } } } }',
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "From JSONC" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "From JSONC", provider: "oc" },
    ]);
  });
});

// ── dsh ───────────────────────────────────────────────────────────

describe("readDshCatalog", () => {
  it("extracts provider/model ids from a populated settings.yaml", () => {
    const home = writeConfigHome("settings.yaml", POPULATED_DSH_SETTINGS);

    const models = readDshCatalog({ configDir: home });

    expect(models).toEqual([
      {
        id: "openrouter-anthropic/anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        provider: "openrouter-anthropic",
      },
      {
        id: "openrouter/anthropic/claude-sonnet-4",
        name: "claude-sonnet-4",
        provider: "openrouter",
      },
      {
        id: "openrouter/openai/gpt-4o-mini",
        name: "openai/gpt-4o-mini",
        provider: "openrouter",
      },
    ]);
  });

  it("returns [] when the settings file is missing", () => {
    const missingHome = join(tmpDir, "does-not-exist-home");

    expect(readDshCatalog({ configDir: missingHome })).toEqual([]);
  });

  it("returns [] when the settings file is malformed YAML", () => {
    const home = writeConfigHome("settings.yaml", "llm-pi-ai: [unterminated\n  : :");

    expect(readDshCatalog({ configDir: home })).toEqual([]);
  });

  it("returns [] when the provider set is empty", () => {
    const home = writeConfigHome("settings.yaml", "llm-pi-ai:\n  providers: {}\n");

    expect(readDshCatalog({ configDir: home })).toEqual([]);
  });

  it("returns [] when llm-pi-ai or providers is absent", () => {
    const home = writeConfigHome(
      "settings.yaml",
      "agent-default-model:\n  provider: openrouter\n  model: anthropic/claude-sonnet-4\n",
    );

    expect(readDshCatalog({ configDir: home })).toEqual([]);
  });

  it("tolerates a bare-string model entry and skips id-less objects", () => {
    const home = writeConfigHome(
      "settings.yaml",
      `llm-pi-ai:
  providers:
    openrouter:
      models:
        - anthropic/claude-sonnet-4
        - name: No id here
`,
    );

    expect(readDshCatalog({ configDir: home })).toEqual([
      { id: "openrouter/anthropic/claude-sonnet-4", name: "anthropic/claude-sonnet-4", provider: "openrouter" },
    ]);
  });

  it("dedupes repeated models[] entries to a single option", () => {
    const home = writeConfigHome(
      "settings.yaml",
      `llm-pi-ai:
  providers:
    openrouter:
      models:
        - id: shared/model
          name: First
        - id: shared/model
          name: Second
`,
    );

    expect(readDshCatalog({ configDir: home })).toEqual([
      { id: "openrouter/shared/model", name: "First", provider: "openrouter" },
    ]);
  });
});

// ── pi ────────────────────────────────────────────────────────────

describe("readPiCatalog", () => {
  it("extracts provider/model ids from a populated models.json", () => {
    const home = writeConfigHome("models.json", POPULATED_PI_MODELS);

    expect(readPiCatalog({ configDir: home })).toEqual([
      { id: "pi-anthropic/claude-opus-4.8", name: "claude-opus-4.8", provider: "pi-anthropic" },
      { id: "pi-anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "pi-anthropic" },
      { id: "pi-local/llama-3.1-8b", name: "Llama 3.1 8B", provider: "pi-local" },
    ]);
  });

  it("returns [] when every provider omits models", () => {
    const home = writeConfigHome(
      "models.json",
      `{ "providers": { "pi-anthropic": { "name": "Anthropic" } } }`,
    );

    expect(readPiCatalog({ configDir: home })).toEqual([]);
  });

  it("skips a provider whose value is not a plain object", () => {
    const home = writeConfigHome(
      "models.json",
      `{
        "providers": {
          "array-valued": [{ "id": "nope" }],
          "real": { "models": [{ "id": "kept" }] }
        }
      }`,
    );

    expect(readPiCatalog({ configDir: home })).toEqual([
      { id: "real/kept", name: "kept", provider: "real" },
    ]);
  });

  it("rejects a bare-string model entry but keeps its object sibling", () => {
    const home = writeConfigHome(
      "models.json",
      `{
        "providers": {
          "pi-anthropic": {
            "models": ["bare-string-id", { "id": "object-entry" }]
          }
        }
      }`,
    );

    // pi's own schema requires the object form, unlike the dsh reader.
    expect(readPiCatalog({ configDir: home })).toEqual([
      { id: "pi-anthropic/object-entry", name: "object-entry", provider: "pi-anthropic" },
    ]);
  });

  it("skips an entry without a non-empty string id", () => {
    const home = writeConfigHome(
      "models.json",
      `{
        "providers": {
          "pi-anthropic": {
            "models": [{ "name": "No id" }, { "id": "" }, { "id": "ok" }]
          }
        }
      }`,
    );

    expect(readPiCatalog({ configDir: home })).toEqual([
      { id: "pi-anthropic/ok", name: "ok", provider: "pi-anthropic" },
    ]);
  });

  it("returns [] when the document is malformed JSON", () => {
    const home = writeConfigHome("models.json", `{ "providers": `);

    expect(readPiCatalog({ configDir: home })).toEqual([]);
  });

  it("returns [] when the file is missing", () => {
    expect(readPiCatalog({ configDir: join(tmpDir, "does-not-exist-home") })).toEqual([]);
  });

  it("returns [] for a wrong-shaped document", () => {
    expect(readPiCatalog({ configDir: writeConfigHome("models.json", `{ "providers": [] }`) })).toEqual([]);
    expect(readPiCatalog({ configDir: writeConfigHome("models.json", `[]`) })).toEqual([]);
  });
});

// ── Project-level document scope ──────────────────────────────────

describe("project-level document scope", () => {
  it("readOpencodeCatalog merges project documents on top of the global ones", () => {
    const home = writeConfigHome(
      "opencode.jsonc",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }',
    );
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home, projectDir })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
      { id: "project/local", name: "Local", provider: "project" },
    ]);
  });

  it("readOpencodeCatalog ignores project documents when projectDir is omitted", () => {
    const home = writeConfigHome(
      "opencode.jsonc",
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }',
    );
    writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(readOpencodeCatalog({ configDir: home })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("readDshCatalog ignores projectDir — dsh has no measured project config", () => {
    const home = writeConfigHome("settings.yaml", POPULATED_DSH_SETTINGS);
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(readDshCatalog({ configDir: home, projectDir })).toEqual(
      readDshCatalog({ configDir: home }),
    );
  });

  it("readPiCatalog ignores projectDir — pi has no measured project config", () => {
    const home = writeConfigHome("models.json", POPULATED_PI_MODELS);
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(readPiCatalog({ configDir: home, projectDir })).toEqual(
      readPiCatalog({ configDir: home }),
    );
  });
});

// ── Dispatcher ────────────────────────────────────────────────────

describe("MODEL_SOURCES", () => {
  it("covers every SyncTarget with a reader or a seed", () => {
    expect(Object.keys(MODEL_SOURCES).sort()).toEqual([...SYNC_TARGET_VALUES].sort());
    expect(MODEL_SOURCES.opencode.read).toBeDefined();
    expect(MODEL_SOURCES.pi.read).toBeDefined();
    expect(MODEL_SOURCES.dsh.read).toBeDefined();
    // Codex has no reader yet: it is served from the opencode seed.
    expect(MODEL_SOURCES.codex.read).toBeUndefined();
    expect(MODEL_SOURCES.codex.seed).toBe("opencode");
  });
});

describe("scanModelsForTarget", () => {
  it("reads each target's own catalog", () => {
    const configDirs = {
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
      dsh: writeConfigHome("settings.yaml", POPULATED_DSH_SETTINGS),
      pi: writeConfigHome("models.json", POPULATED_PI_MODELS),
    };

    expect(scanModelsForTarget("opencode", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
    expect(scanModelsForTarget("dsh", { configDirs }).map((m) => m.id)).toEqual([
      "openrouter-anthropic/anthropic/claude-opus-4.8",
      "openrouter/anthropic/claude-sonnet-4",
      "openrouter/openai/gpt-4o-mini",
    ]);
    expect(scanModelsForTarget("pi", { configDirs }).map((m) => m.id)).toEqual([
      "pi-anthropic/claude-opus-4.8",
      "pi-anthropic/claude-sonnet-4",
      "pi-local/llama-3.1-8b",
    ]);
  });

  it("falls back to the opencode seed for dsh when dsh yields no models", () => {
    const configDirs = {
      dsh: writeConfigHome("settings.yaml", "llm-pi-ai:\n  providers: {}\n"),
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
    };

    expect(scanModelsForTarget("dsh", { configDirs })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("falls back to the opencode seed for pi when models.json declares no models", () => {
    const configDirs = {
      pi: writeConfigHome("models.json", `{ "providers": {} }`),
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
    };

    expect(scanModelsForTarget("pi", { configDirs })).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("serves codex from the opencode seed", () => {
    const configDirs = {
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
      pi: writeConfigHome("models.json", POPULATED_PI_MODELS),
    };

    expect(scanModelsForTarget("codex", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
  });

  it("falls back to opencode for an unknown target", () => {
    const configDirs = {
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
      pi: writeConfigHome("models.json", POPULATED_PI_MODELS),
    };

    expect(scanModelsForTarget("not-a-harness", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
  });

  it("reads the seed through the seed's own configDirs entry", () => {
    const configDirs = {
      // pi declares nothing → the seed hop must read the opencode entry below,
      // not reuse pi's home.
      pi: writeConfigHome("models.json", `{ "providers": {} }`),
      opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC),
    };

    expect(scanModelsForTarget("pi", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
  });

  it("reads the seed's default document when it has no configDirs entry", () => {
    writeDefaultOpencodeConfig(OPENCODE_JSONC);
    const configDirs = { pi: writeConfigHome("models.json", `{ "providers": {} }`) };

    expect(scanModelsForTarget("pi", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
  });

  it("includes project-declared opencode models when a projectDir is given", () => {
    const configDirs = { opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC) };
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(
      scanModelsForTarget("opencode", { configDirs, projectDir }).map((m) => m.id),
    ).toEqual(["oc/gpt-4o", "project/local"]);
  });

  it("omitting projectDir yields exactly the global opencode catalog", () => {
    const configDirs = { opencode: writeConfigHome("opencode.jsonc", OPENCODE_JSONC) };
    writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(scanModelsForTarget("opencode", { configDirs }).map((m) => m.id)).toEqual([
      "oc/gpt-4o",
    ]);
  });

  it("dsh ignores projectDir when its own catalog answers", () => {
    const configDirs = { dsh: writeConfigHome("settings.yaml", POPULATED_DSH_SETTINGS) };
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(scanModelsForTarget("dsh", { configDirs, projectDir })).toEqual(
      scanModelsForTarget("dsh", { configDirs }),
    );
  });

  it("forwards projectDir to the opencode seed hop", () => {
    // dsh declares nothing, so the opencode seed is read; the seed sees the
    // project documents through the same bag.
    const configDirs = {
      dsh: writeConfigHome("settings.yaml", "llm-pi-ai:\n  providers: {}\n"),
    };
    const projectDir = writeProjectConfig(
      '{ "provider": { "project": { "models": { "local": { "name": "Local" } } } } }',
    );

    expect(
      scanModelsForTarget("dsh", { configDirs, projectDir }).map((m) => m.id),
    ).toEqual(["project/local"]);
  });

  it("keeps the opencode default when no options are given", () => {
    writeDefaultOpencodeConfig(OPENCODE_JSONC);

    expect(scanModelsForTarget("opencode").map((m) => m.id)).toEqual(["oc/gpt-4o"]);
  });
});
