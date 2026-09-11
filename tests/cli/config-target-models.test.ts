/**
 * Target-aware model-source threading through `rolebox config`.
 *
 * `rolebox config --target dsh` must offer the models declared in the dsh
 * settings document, and fall back to the opencode source when dsh declares
 * none. `runInteractive` is driven with an injected prompts fake (the same seam
 * `configInteractive` uses) so the offered options are observable without a
 * terminal and without process-wide module mocks; all filesystem access is
 * redirected through the `DSH_HOME` / `XDG_CONFIG_HOME` seams into a tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runInteractive,
  type ConfigPrompts,
} from "../../src/cli/commands/config.ts";

let tmpDir: string;
let dshHome: string;

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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-config-models-"));
  dshHome = join(tmpDir, "dsh-home");
  process.env.DSH_HOME = dshHome;
  process.env.XDG_CONFIG_HOME = tmpDir;
  selectCalls.length = 0;
});

afterEach(() => {
  delete process.env.DSH_HOME;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeDshSettings(content: string): void {
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(join(dshHome, "settings.yaml"), content, "utf-8");
}

function writeOpencodeConfig(content: string): void {
  const dir = join(tmpDir, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.jsonc"), content, "utf-8");
}

/** Create a role under the dsh sync root and return its role.yaml path. */
function writeSyncedRole(role: string): { roleDir: string; roleYaml: string } {
  const roleDir = join(dshHome, "rolebox", role);
  mkdirSync(roleDir, { recursive: true });
  const roleYaml = join(roleDir, "role.yaml");
  writeFileSync(roleYaml, `name: ${role}\nmodel: old/model\n`, "utf-8");
  return { roleDir, roleYaml };
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
});
