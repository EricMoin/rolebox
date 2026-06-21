import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import RoleboxModule from "./index";
const RoleboxPlugin = RoleboxModule.server;

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-idx-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────

function roleboxPath(): string {
  return path.join(tmpDir, "rolebox");
}

async function writeRole(name: string, content: string): Promise<string> {
  const roleDir = path.join(roleboxPath(), name);
  mkdirSync(roleDir, { recursive: true });
  const yamlFile = path.join(roleDir, "role.yaml");
  await writeFile(yamlFile, content, "utf-8");
  return roleDir;
}

async function writeRoleSkill(
  roleName: string,
  skillName: string,
  content: string,
): Promise<string> {
  const skillDir = path.join(roleboxPath(), roleName, "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, "SKILL.md");
  await writeFile(skillFile, content, "utf-8");
  return skillFile;
}

function createPluginInput(directory: string): PluginInput {
  return {
    client: {} as never,
    project: {
      id: "test",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:0"),
    $: {} as never,
  };
}

function emptyConfig(): Config {
  return {};
}

// ── tests ────────────────────────────────────────────────────────

describe("RoleboxPlugin config hook", () => {
  // Scenario 1: rolebox dir doesn't exist → no crash, no agents
  it("handles non-existent rolebox directory gracefully", async () => {
    const base = path.join(tmpDir, "no-such-dir");
    const hooks = await RoleboxPlugin(createPluginInput(base));

    const cfg = emptyConfig();
    await hooks.config!(cfg);

    expect(cfg.agent ?? {}).toEqual({});
  });

  // Scenario 1b: rolebox dir exists but is empty → no agents
  it("returns empty agents when rolebox dir has no roles", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    const cfg = emptyConfig();
    await hooks.config!(cfg);

    expect(cfg.agent ?? {}).toEqual({});
  });

  // Scenario 1c: config hook preserves existing agent entries
  it("preserves existing agent entries when no roles are found", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    const cfg: Config = {
      agent: { existing: { prompt: "keep-me", mode: "primary" } },
    };
    await hooks.config!(cfg);

    expect(cfg.agent!.existing!.prompt).toBe("keep-me");
  });

  // Scenario 2: single basic role → agent registered
  it("registers a single role as an opencode agent", async () => {
    await writeRole(
      "engineer",
      [
        "name: Software Engineer",
        "description: Builds features",
        "prompt: Write clean code.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    expect(Object.keys(cfg.agent ?? {})).toEqual(["engineer"]);
    const agent = cfg.agent!.engineer!;
    expect(agent.prompt).toBe("Write clean code.");
    expect(agent.description).toBe("Builds features");
    expect(agent.mode).toBe("primary");
  });

  // Scenario 3: role with skills → prompt contains <available_skills>
  it("includes <available_skills> block in prompt when role has skills", async () => {
    await writeRole(
      "reviewer",
      [
        "name: Code Reviewer",
        "description: Reviews pull requests",
        "prompt: You review code.",
        "skills:",
        "  - git-master",
        "  - dart-add-unit-test",
      ].join("\n"),
    );
    await writeRoleSkill(
      "reviewer",
      "git-master",
      [
        "---",
        "name: git-master",
        "description: Expert git workflows",
        "---",
        "",
        "# Git Master",
        "Advanced git operations.",
      ].join("\n"),
    );
    await writeRoleSkill(
      "reviewer",
      "dart-add-unit-test",
      [
        "---",
        "name: dart-add-unit-test",
        "description: Unit test patterns for Dart",
        "---",
        "",
        "# Dart Add Unit Test",
        "Write and organize Dart unit tests.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const prompt = cfg.agent!.reviewer!.prompt!;
    expect(prompt).toStartWith("You review code.");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>git-master</name>");
    expect(prompt).toContain("<description>Expert git workflows</description>");
    expect(prompt).toContain("<name>dart-add-unit-test</name>");
    expect(prompt).toContain("<description>Unit test patterns for Dart</description>");
    expect(prompt).toContain("<scope>rolebox</scope>");
    expect(prompt).toContain("</available_skills>");
  });

  // Scenario 4: multiple roles → all registered
  it("registers multiple roles as separate agents", async () => {
    await writeRole("alpha", [
      "name: Alpha",
      "description: First role",
      "prompt: I am alpha.",
    ].join("\n"));
    await writeRole("beta", [
      "name: Beta",
      "description: Second role",
      "prompt: I am beta.",
    ].join("\n"));
    await writeRole("gamma", [
      "name: Gamma",
      "description: Third role",
      "prompt: I am gamma.",
    ].join("\n"));

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const keys = Object.keys(cfg.agent ?? {}).sort();
    expect(keys).toEqual(["alpha", "beta", "gamma"]);
    expect(cfg.agent!.alpha!.prompt).toBe("I am alpha.");
    expect(cfg.agent!.beta!.prompt).toBe("I am beta.");
    expect(cfg.agent!.gamma!.prompt).toBe("I am gamma.");
  });

  // Scenario 5: all optional fields populated → all mapped
  it("maps all optional config fields to the agent config", async () => {
    await writeRole(
      "full",
      [
        "name: Full Featured",
        "description: Has every field",
        "model: claude-3-5-sonnet",
        "mode: subagent",
        "color: '#EE2211'",
        "variant: pro",
        "temperature: 0.2",
        "top_p: 0.95",
        "prompt: Do it all.",
        "tools:",
        "  bash: true",
        "  edit: false",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agent = cfg.agent!.full!;
    expect(agent.model).toBe("claude-3-5-sonnet");
    expect(agent.description).toBe("Has every field");
    expect(agent.mode).toBe("subagent");
    expect(agent.color).toBe("#EE2211");
    expect(agent.variant).toBe("pro");
    expect(agent.temperature).toBe(0.2);
    expect(agent.top_p).toBe(0.95);
    expect(agent.prompt).toBe("Do it all.");
    expect(agent.tools).toEqual({ bash: true, edit: false });
  });

  // Scenario 6: role without optional fields → only required + defaults
  it("omits undefined optional fields from agent config", async () => {
    await writeRole(
      "minimal",
      "name: Minimal\ndescription: Bare minimum\nprompt: Hello.\n",
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agent = cfg.agent!.minimal!;
    expect(agent.prompt).toBe("Hello.");
    expect(agent.description).toBe("Bare minimum");
    expect(agent.mode).toBe("primary");

    // None of these should exist on the object
    expect("model" in agent).toBe(false);
    expect("color" in agent).toBe(false);
    expect("variant" in agent).toBe(false);
    expect("temperature" in agent).toBe(false);
    expect("top_p" in agent).toBe(false);
    expect("tools" in agent).toBe(false);
    expect("permission" in agent).toBe(false);
  });

  // Scenario 7: mode defaults to "primary" when unspecified
  it("defaults mode to primary when the role does not define it", async () => {
    await writeRole(
      "defaulted",
      "name: Defaulted\ndescription: No mode\nprompt: Let opencode decide.\n",
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    expect(cfg.agent!.defaulted!.mode).toBe("primary");
  });

  // Scenario 8: end-to-end integration — verifying prompt with skills
  it("builds correct full prompt for a role with skills", async () => {
    await writeRole(
      "dev",
      [
        "name: Developer",
        "description: Writes production code",
        "model: gpt-4",
        "mode: subagent",
        "prompt: You are a senior developer.",
        "skills:",
        "  - typescript-patterns",
      ].join("\n"),
    );
    await writeRoleSkill(
      "dev",
      "typescript-patterns",
      [
        "---",
        "name: typescript-patterns",
        "description: Common TS design patterns",
        "---",
        "",
        "# TypeScript Patterns",
        "Pattern catalog.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agent = cfg.agent!.dev!;
    expect(agent.model).toBe("gpt-4");
    expect(agent.description).toBe("Writes production code");
    expect(agent.mode).toBe("subagent");

    const prompt = agent.prompt!;
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("You are a senior developer.");
    expect(lines).toContain("<available_skills>");
    expect(lines).toContain("  <skill>");
    expect(lines).toContain("    <name>typescript-patterns</name>");
    expect(lines).toContain("    <description>Common TS design patterns</description>");
    expect(lines).toContain("    <scope>rolebox</scope>");
    expect(lines).toContain("  </skill>");
    expect(lines).toContain("</available_skills>");
  });
});
