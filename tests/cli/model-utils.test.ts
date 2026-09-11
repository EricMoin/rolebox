/**
 * dsh model source: `rolebox config --target dsh` reads the models declared in
 * the dsh settings document (`<dsh home>/settings.yaml`) under
 * `llm-pi-ai.providers.<route>.models[]` — the key shape verified in subtask 1.
 *
 * These cases cover the reader in isolation (explicit config paths, so no env
 * or real home directory is touched) and the target-aware dispatcher, including
 * the opencode fallback when dsh yields no models.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanDshAvailableModels,
  scanModelsForTarget,
} from "../../src/cli/model-utils.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-model-utils-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFileNamed(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

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

describe("scanDshAvailableModels", () => {
  it("extracts provider/model ids from a populated settings.yaml", () => {
    const path = writeFileNamed("settings.yaml", POPULATED_DSH_SETTINGS);

    const models = scanDshAvailableModels(path);

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
    const missing = join(tmpDir, "does-not-exist.yaml");

    expect(scanDshAvailableModels(missing)).toEqual([]);
  });

  it("returns [] when the settings file is malformed YAML", () => {
    const path = writeFileNamed("settings.yaml", "llm-pi-ai: [unterminated\n  : :");

    expect(scanDshAvailableModels(path)).toEqual([]);
  });

  it("returns [] when the provider set is empty", () => {
    const path = writeFileNamed("settings.yaml", "llm-pi-ai:\n  providers: {}\n");

    expect(scanDshAvailableModels(path)).toEqual([]);
  });

  it("returns [] when llm-pi-ai or providers is absent", () => {
    const path = writeFileNamed(
      "settings.yaml",
      "agent-default-model:\n  provider: openrouter\n  model: anthropic/claude-sonnet-4\n",
    );

    expect(scanDshAvailableModels(path)).toEqual([]);
  });

  it("tolerates a bare-string model entry and skips id-less objects", () => {
    const path = writeFileNamed(
      "settings.yaml",
      `llm-pi-ai:
  providers:
    openrouter:
      models:
        - anthropic/claude-sonnet-4
        - name: No id here
`,
    );

    expect(scanDshAvailableModels(path)).toEqual([
      { id: "openrouter/anthropic/claude-sonnet-4", name: "anthropic/claude-sonnet-4", provider: "openrouter" },
    ]);
  });
});

describe("scanModelsForTarget", () => {
  it("uses the dsh source for the dsh target when it yields models", () => {
    const dshConfigPath = writeFileNamed("settings.yaml", POPULATED_DSH_SETTINGS);
    const opencodeConfigPath = writeFileNamed("opencode.jsonc", OPENCODE_JSONC);

    const models = scanModelsForTarget("dsh", { dshConfigPath, opencodeConfigPath });

    expect(models.map((m) => m.id)).toEqual([
      "openrouter-anthropic/anthropic/claude-opus-4.8",
      "openrouter/anthropic/claude-sonnet-4",
      "openrouter/openai/gpt-4o-mini",
    ]);
  });

  it("falls back to the opencode source for dsh when dsh yields no models", () => {
    const dshConfigPath = writeFileNamed("settings.yaml", "llm-pi-ai:\n  providers: {}\n");
    const opencodeConfigPath = writeFileNamed("opencode.jsonc", OPENCODE_JSONC);

    const models = scanModelsForTarget("dsh", { dshConfigPath, opencodeConfigPath });

    expect(models).toEqual([
      { id: "oc/gpt-4o", name: "GPT-4o", provider: "oc" },
    ]);
  });

  it("keeps the opencode source for the opencode target", () => {
    const dshConfigPath = writeFileNamed("settings.yaml", POPULATED_DSH_SETTINGS);
    const opencodeConfigPath = writeFileNamed("opencode.jsonc", OPENCODE_JSONC);

    const models = scanModelsForTarget("opencode", { dshConfigPath, opencodeConfigPath });

    expect(models.map((m) => m.id)).toEqual(["oc/gpt-4o"]);
  });

  it("keeps the opencode source for the pi target (pi path unchanged)", () => {
    const dshConfigPath = writeFileNamed("settings.yaml", POPULATED_DSH_SETTINGS);
    const opencodeConfigPath = writeFileNamed("opencode.jsonc", OPENCODE_JSONC);

    const models = scanModelsForTarget("pi", { dshConfigPath, opencodeConfigPath });

    expect(models.map((m) => m.id)).toEqual(["oc/gpt-4o"]);
  });
});
