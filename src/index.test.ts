import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir as osTmpdir, homedir as osHomedir } from "node:os";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import RoleboxModule, { roleFunctionsMap } from "./index";
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

describe("RoleboxPlugin subagents", () => {
  // Scenario 9: role with inline subagent → registered as subagent agent
  it("registers subagent in config.agent with mode subagent and hidden", async () => {
    await writeRole(
      "parent",
      [
        "name: Parent Role",
        "description: Has child agents",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: Child One",
        "    description: A child agent",
        "    prompt: You are the child.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agentKeys = Object.keys(cfg.agent ?? {});
    expect(agentKeys).toContain("parent");
    expect(agentKeys).toContain("parent--child-one");

    const child = cfg.agent!["parent--child-one"]!;
    expect(child.mode).toBe("subagent");
    expect((child as Record<string, unknown>).hidden).toBe(true);
    expect(child.prompt).toBe("You are the child.");
    expect(child.description).toBe("A child agent");
  });

  // Scenario 10: parent prompt contains <available_subagents> block
  it("includes <available_subagents> in parent prompt when role has subagents", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Delegates work",
        "prompt: Delegate tasks.",
        "subagents:",
        "  - name: Worker Bee",
        "    description: Does the actual work",
        "    prompt: Work hard.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const parentPrompt = cfg.agent!.orchestrator!.prompt!;
    expect(parentPrompt).toContain("<available_subagents>");
    expect(parentPrompt).toContain("<id>orchestrator--worker-bee</id>");
    expect(parentPrompt).toContain("<name>Worker Bee</name>");
    expect(parentPrompt).toContain("<description>Does the actual work</description>");
    expect(parentPrompt).toContain("</available_subagents>");
  });

  // Scenario 11: subagent with own skills → prompt has <available_skills>
  it("includes <available_skills> in subagent prompt when subagent has skills", async () => {
    await writeRole(
      "boss",
      [
        "name: Boss",
        "description: Manages",
        "prompt: Manage team.",
        "subagents:",
        "  - name: Analyst",
        "    description: Analyzes data",
        "    prompt: Analyze carefully.",
        "    skills:",
        "      - data-review",
      ].join("\n"),
    );
    await writeRoleSkill(
      "boss",
      "data-review",
      [
        "---",
        "name: data-review",
        "description: Data review patterns",
        "---",
        "# Data Review",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const subPrompt = cfg.agent!["boss--analyst"]!.prompt!;
    expect(subPrompt).toContain("<available_skills>");
    expect(subPrompt).toContain("<name>data-review</name>");
    expect(subPrompt).toContain("<description>Data review patterns</description>");
    expect(subPrompt).toContain("<scope>rolebox</scope>");
    expect(subPrompt).toContain("</available_skills>");
  });

  // Scenario 12: multiple subagents → all registered
  it("registers all subagents from a role with multiple children", async () => {
    await writeRole(
      "lead",
      [
        "name: Team Lead",
        "description: Leads a team",
        "prompt: Lead the team.",
        "subagents:",
        "  - name: Coder",
        "    description: Writes code",
        "    prompt: Write code.",
        "  - name: Tester",
        "    description: Runs tests",
        "    prompt: Run tests.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agentKeys = Object.keys(cfg.agent ?? {}).sort();
    expect(agentKeys).toContain("lead");
    expect(agentKeys).toContain("lead--coder");
    expect(agentKeys).toContain("lead--tester");

    expect(cfg.agent!["lead--coder"]!.mode).toBe("subagent");
    expect(cfg.agent!["lead--tester"]!.mode).toBe("subagent");
  });

  // Scenario 13: roleFunctionsMap has subagent entry
  it("stores subagent functions in roleFunctionsMap", async () => {
    await writeRole(
      "manager",
      [
        "name: Manager",
        "description: Manages things",
        "prompt: Manage.",
        "subagents:",
        "  - name: Helper",
        "    description: Helps out",
        "    prompt: Help.",
      ].join("\n"),
    );

    await RoleboxPlugin(createPluginInput(tmpDir));

    const funcs = roleFunctionsMap.get("manager--helper");
    expect(funcs).toBeDefined();
    expect(funcs!.length).toBeGreaterThanOrEqual(1);

    const names = funcs!.map((f) => f.name);
    expect(names).toContain("plan");
    expect(names).toContain("execute");
  });

  // Scenario 14: no recursive subagent injection in subagent prompts
  it("does not inject <available_subagents> into subagent prompts", async () => {
    await writeRole(
      "root",
      [
        "name: Root",
        "description: Top level",
        "prompt: I am root.",
        "subagents:",
        "  - name: Leaf",
        "    description: A leaf agent",
        "    prompt: I am a leaf.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const subPrompt = cfg.agent!["root--leaf"]!.prompt!;
    expect(subPrompt).not.toContain("<available_subagents>");
  });

  // Scenario 15: subagent skill symlinks created with correct prefix
  it("creates skill symlinks for subagent skills", async () => {
    await writeRole(
      "parent",
      [
        "name: Parent",
        "description: Has child with skill",
        "prompt: Parent prompt.",
        "subagents:",
        "  - name: Researcher",
        "    description: Researches things",
        "    prompt: Research prompt.",
        "    skills:",
        "      - my-research-skill",
      ].join("\n"),
    );
    await writeRoleSkill(
      "parent",
      "my-research-skill",
      [
        "---",
        "name: my-research-skill",
        "description: Research skill",
        "---",
        "",
        "# Research Skill",
        "Research content.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const skillSymlink = path.join(
      tmpDir,
      "opencode",
      "skills",
      "rolebox--parent--researcher--my-research-skill",
    );
    expect(existsSync(skillSymlink)).toBe(true);
    expect(lstatSync(skillSymlink).isSymbolicLink()).toBe(true);
  });

  // Scenario 16: subagent .md file written with mode subagent
  it("writes .md files for subagents with mode subagent", async () => {
    await writeRole(
      "orchestrator",
      [
        "name: Orchestrator",
        "description: Delegates work",
        "prompt: Orchestrate tasks.",
        "subagents:",
        "  - name: Worker",
        "    description: Does the work",
        "    prompt: Work hard.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agentFilePath = path.join(
      osHomedir(),
      ".claude",
      "agents",
      "orchestrator--worker.md",
    );
    expect(existsSync(agentFilePath)).toBe(true);

    const content = readFileSync(agentFilePath, "utf-8");
    expect(content).toContain("<!-- rolebox-managed -->");
    expect(content).toContain("mode: subagent");
    expect(content).toContain("Work hard.");
  });

  // Scenario 17: role with empty subagents array → no subagents, parent still works
  it("handles empty subagents array gracefully with no subagents registered", async () => {
    await writeRole(
      "solo",
      [
        "name: Solo Role",
        "description: Has an empty subagents list",
        "prompt: I work alone.",
        "subagents: []",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const agentKeys = Object.keys(cfg.agent ?? {}).sort();
    expect(agentKeys).toEqual(["solo"]);
    expect(cfg.agent!.solo!.prompt).toBe("I work alone.");
    expect(cfg.agent!.solo!.prompt).not.toContain("<available_subagents>");
  });

  // Scenario 18: subagent with skills has <available_skills> in prompt
  it("includes <available_skills> in subagent prompt from file-based subagent", async () => {
    await writeRole(
      "manager",
      [
        "name: Manager",
        "description: Manages the team",
        "prompt: Manage work.",
        "subagents:",
        "  - name: Analyst",
        "    description: Analyzes data",
        "    prompt: Analyze carefully.",
        "    skills:",
        "      - data-analysis",
      ].join("\n"),
    );
    await writeRoleSkill(
      "manager",
      "data-analysis",
      [
        "---",
        "name: data-analysis",
        "description: Data analysis patterns and methodology",
        "---",
        "",
        "# Data Analysis",
        "Analysis methodology.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const subPrompt = cfg.agent!["manager--analyst"]!.prompt!;
    expect(subPrompt).toContain("<available_skills>");
    expect(subPrompt).toContain("<name>data-analysis</name>");
    expect(subPrompt).toContain("<description>Data analysis patterns and methodology</description>");
    expect(subPrompt).toContain("<scope>rolebox</scope>");
  });

  // Scenario 19: parent and subagent with same skill name → resolve independently
  it("resolves same skill name for parent and subagent independently", async () => {
    await writeRole(
      "dual",
      [
        "name: Dual Role",
        "description: Parent with same skill as child",
        "prompt: Parent prompt.",
        "skills:",
        "  - shared-skill",
        "subagents:",
        "  - name: Child",
        "    description: Child agent",
        "    prompt: Child prompt.",
        "    skills:",
        "      - shared-skill",
      ].join("\n"),
    );
    // Write the skill once — it resolves for both parent and subagent
    await writeRoleSkill(
      "dual",
      "shared-skill",
      [
        "---",
        "name: shared-skill",
        "description: A skill shared by parent and child",
        "---",
        "",
        "# Shared Skill",
        "This skill is used by both parent and subagent.",
      ].join("\n"),
    );

    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));
    const cfg = emptyConfig();
    await hooks.config!(cfg);

    const parentPrompt = cfg.agent!.dual!.prompt!;
    expect(parentPrompt).toContain("<available_skills>");
    expect(parentPrompt).toContain("<name>shared-skill</name>");

    const childPrompt = cfg.agent!["dual--child"]!.prompt!;
    expect(childPrompt).toContain("<available_skills>");
    expect(childPrompt).toContain("<name>shared-skill</name>");

    // Both parent and child should have the skill independently
    const parentSkillCount = (parentPrompt.match(/<name>shared-skill<\/name>/g) ?? []).length;
    const childSkillCount = (childPrompt.match(/<name>shared-skill<\/name>/g) ?? []).length;
    expect(parentSkillCount).toBe(1);
    expect(childSkillCount).toBe(1);
  });
});
