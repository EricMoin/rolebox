/**
 * Target-aware model-source threading through `rolebox config`.
 *
 * `rolebox config --target dsh` must offer the models declared in the dsh
 * profile/home `cordis.patch.yml` layers (a legacy `settings.yaml` is still
 * read), and fall back to the opencode source when dsh declares none;
 * `--target pi` reads pi's own `models.json` with the same opencode fallback. The project directory is injected as a parameter, never by moving
 * the process working directory, so the opencode picker also offers models
 * declared in the project's own opencode documents. `runInteractive` is driven
 * with an injected
 * prompts fake (the same seam `configInteractive` uses) so the offered options
 * are observable without a terminal and without process-wide module mocks; all
 * filesystem access is redirected through the `DSH_HOME` /
 * `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME` / `HOME` /
 * `OPENCODE_CONFIG_DIR` seams into a tmpdir, and each injected project tree
 * lives under that tmpdir. The walk stops at the first directory holding a
 * VALID `.git` marker (see src/platform/opencode-config.ts); these fixtures
 * create none, so they rely on the isolated tree and on the absence of
 * documents in the ancestors above it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runInteractive,
  type ConfigPrompts,
} from "../../src/cli/commands/config.ts";

const ORIGINAL_PI_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;

let tmpDir: string;
let dshHome: string;
let piAgentDir: string;

interface SelectOptions {
  options: Array<{ value: string; label: string }>;
}

/** Options passed to the most recent `select` call. */
const selectCalls: SelectOptions[] = [];

/**
 * Scripted prompts fake: records the offered options and answers "Custom",
 * then supplies a custom model so the flow terminates.
 */
function fakePrompts(): ConfigPrompts {
  return {
    intro: () => {},
    outro: () => {},
    cancel: () => {},
    confirm: async () => true,
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    isCancel: () => false,
    select: async (opts: SelectOptions) => {
      selectCalls.push(opts);
      return "__custom__";
    },
    text: async () => "dsh/picked-model",
    log: {
      error: () => {},
      info: () => {},
      success: () => {},
      message: () => {},
      step: () => {},
      warn: () => {},
      debug: () => {},
    },
  } as unknown as ConfigPrompts;
}

/** A project-level opencode document declaring one project-only model. */
const PROJECT_OPENCODE =
  '{ "provider": { "project": { "models": { "local-model": { "name": "Project Local" } } } } }';

const PI_MODELS = `{
  "providers": {
    "pi-anthropic": {
      "models": [{ "id": "claude-sonnet-4", "name": "Claude Sonnet 4" }]
    }
  }
}`;

const DSH_SETTINGS = `
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
`;

/** A dsh profile patch: a default provider plus flat `config.models[]`. */
const DSH_PROFILE_PATCH = `
- id: agent-default-model
  name: '@scope/agent-default-model'
  config:
    provider: acme-official
    model: alpha
- id: llm-entry
  name: '@scope/llm-entry'
  config:
    models:
      - id: alpha
        name: Alpha
      - beta
`;

/** A dsh profile patch whose only entry declares no default provider. */
const DSH_PROFILE_PATCH_NO_PROVIDER = `
- id: llm-entry
  name: '@scope/llm-entry'
  config:
    models:
      - id: alpha
        name: Alpha
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-config-models-"));
  dshHome = join(tmpDir, "dsh-home");
  piAgentDir = join(tmpDir, "pi-agent");
  process.env.DSH_HOME = dshHome;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  process.env.XDG_CONFIG_HOME = tmpDir;
  // The opencode catalog's home-dot and OPENCODE_CONFIG_DIR layers resolve
  // HOME at call time; redirect both so no real home config is read.
  process.env.HOME = join(tmpDir, "home");
  process.env.OPENCODE_CONFIG_DIR = join(tmpDir, "opencode-config-dir");
  selectCalls.length = 0;
});

afterEach(() => {
  delete process.env.DSH_HOME;
  if (ORIGINAL_PI_DIR === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = ORIGINAL_PI_DIR;
  }
  delete process.env.XDG_CONFIG_HOME;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_OPENCODE_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = ORIGINAL_OPENCODE_CONFIG_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDshSettings(content: string): void {
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(join(dshHome, "settings.yaml"), content, "utf-8");
}

/** Write the active profile's `cordis.patch.yml` under the dsh home. */
function writeDshProfilePatch(content: string): void {
  const profileDir = join(dshHome, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "cordis.patch.yml"), content, "utf-8");
}

function writeOpencodeConfig(content: string): void {
  const dir = join(tmpDir, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.jsonc"), content, "utf-8");
}

function writePiModels(content: string): void {
  mkdirSync(piAgentDir, { recursive: true });
  writeFileSync(join(piAgentDir, "models.json"), content, "utf-8");
}

/**
 * Create the injected project directory under the isolated tmpdir and write its
 * `opencode.json`. The walk has no `.git` stop, so the tree boundary is the
 * tmpdir itself, not a marker file.
 */
function writeProjectDir(content: string): string {
  const projectDir = join(tmpDir, "project");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  writeFileSync(join(projectDir, "opencode.json"), content, "utf-8");
  return projectDir;
}

/** Create a role under a target's config home and return its role.yaml path. */
function writeSyncedRoleIn(
  configHome: string,
  role: string,
): { roleDir: string; roleYaml: string } {
  const roleDir = join(configHome, "rolebox", role);
  mkdirSync(roleDir, { recursive: true });
  const roleYaml = join(roleDir, "role.yaml");
  writeFileSync(roleYaml, `name: ${role}\nmodel: old/model\n`, "utf-8");
  return { roleDir, roleYaml };
}

/** Create a role under the dsh sync root and return its role.yaml path. */
function writeSyncedRole(role: string): { roleDir: string; roleYaml: string } {
  return writeSyncedRoleIn(dshHome, role);
}

function offeredValues(): string[] {
  expect(selectCalls.length).toBeGreaterThan(0);
  return selectCalls[0].options.map((o) => o.value);
}

describe("runInteractive target-aware model source", () => {
  it("offers dsh-configured models for the dsh target", async () => {
    writeDshSettings(DSH_SETTINGS);
    const { roleDir, roleYaml } = writeSyncedRole("dsh-role");

    await runInteractive(roleDir, "dsh", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("openrouter/anthropic/claude-sonnet-4");
    // The Custom escape hatch is always present.
    expect(offered).toContain("__custom__");
    // No opencode models configured here → no stray opencode entries.
    expect(offered.some((v) => v.startsWith("oc/"))).toBe(false);
    // The flow completed against the synced role.
    expect(readFileSync(roleYaml, "utf-8")).toContain("model: dsh/picked-model");
  });

  it("offers the dsh profile patch models for the dsh target", async () => {
    writeDshProfilePatch(DSH_PROFILE_PATCH);
    const { roleDir, roleYaml } = writeSyncedRole("dsh-role");

    await runInteractive(roleDir, "dsh", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("acme-official/alpha");
    expect(offered).toContain("acme-official/beta");
    // The Custom escape hatch is always present.
    expect(offered).toContain("__custom__");
    // No opencode models configured here → no stray opencode entries.
    expect(offered.some((v) => v.startsWith("oc/"))).toBe(false);
    // The flow completed against the synced role.
    expect(readFileSync(roleYaml, "utf-8")).toContain("model: dsh/picked-model");
  });

  it("labels a model with no declared provider without a dangling provider pair", async () => {
    writeDshProfilePatch(DSH_PROFILE_PATCH_NO_PROVIDER);
    const { roleDir } = writeSyncedRole("dsh-role");

    await runInteractive(roleDir, "dsh", fakePrompts());

    const options = selectCalls[0].options;
    expect(options).toContainEqual({ value: "alpha", label: "Alpha" });
    expect(options.some((o) => o.label.includes("()"))).toBe(false);
  });

  it("falls back to the opencode source for the dsh target when dsh declares no models", async () => {
    writeDshSettings("llm-pi-ai:\n  providers: {}\n");
    writeOpencodeConfig(
      `{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }`,
    );
    const { roleDir } = writeSyncedRole("dsh-role");

    await runInteractive(roleDir, "dsh", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("oc/gpt-4o");
    expect(offered).toContain("__custom__");
  });

  it("offers pi-declared models for the pi target", async () => {
    writePiModels(PI_MODELS);
    const { roleDir, roleYaml } = writeSyncedRoleIn(piAgentDir, "pi-role");

    await runInteractive(roleDir, "pi", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("pi-anthropic/claude-sonnet-4");
    // No opencode models configured here → no stray opencode entries.
    expect(offered.some((v) => v.startsWith("oc/"))).toBe(false);
    // The flow completed against the synced role.
    expect(readFileSync(roleYaml, "utf-8")).toContain("model: dsh/picked-model");
  });

  it("falls back to the opencode source for the pi target when models.json declares none", async () => {
    writePiModels(`{ "providers": {} }`);
    writeOpencodeConfig(
      `{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }`,
    );
    const { roleDir } = writeSyncedRoleIn(piAgentDir, "pi-role");

    await runInteractive(roleDir, "pi", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("oc/gpt-4o");
    expect(offered).toContain("__custom__");
  });

  it("keeps the opencode source for the opencode target", async () => {
    writeDshSettings(DSH_SETTINGS);
    writeOpencodeConfig(
      `{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }`,
    );
    const { roleDir } = writeSyncedRole("oc-role");

    await runInteractive(roleDir, "opencode", fakePrompts());

    const offered = offeredValues();
    expect(offered).toContain("oc/gpt-4o");
    expect(offered).not.toContain("openrouter/anthropic/claude-sonnet-4");
  });

  it("offers project-declared models when the project dir is injected", async () => {
    writeOpencodeConfig(
      '{ "provider": { "oc": { "models": { "gpt-4o": { "name": "GPT-4o" } } } } }',
    );
    const projectDir = writeProjectDir(PROJECT_OPENCODE);
    const { roleDir } = writeSyncedRole("oc-role");
    const cwdBefore = process.cwd();

    await runInteractive(roleDir, "opencode", fakePrompts(), projectDir);

    const offered = offeredValues();
    expect(offered).toContain("oc/gpt-4o");
    expect(offered).toContain("project/local-model");
    // The injected directory did the work; the process cwd was never touched.
    expect(process.cwd()).toBe(cwdBefore);
  });

  it("does not read a project document that was not injected", async () => {
    writeProjectDir(PROJECT_OPENCODE);
    const otherProject = join(tmpDir, "other-project");
    mkdirSync(join(otherProject, ".git"), { recursive: true });
    const { roleDir } = writeSyncedRole("oc-role");

    await runInteractive(roleDir, "opencode", fakePrompts(), otherProject);

    expect(offeredValues()).not.toContain("project/local-model");
  });
});
