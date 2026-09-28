import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir as osTmpdir, homedir as osHomedir } from "node:os";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import RoleboxModule, { roleFunctionsMap } from "../src/entries/opencode.ts";
import { getDataDir } from "../src/cli/paths.ts";
import { graphStoreFilePath, graphStoreRoot } from "../src/graph/store/schema.ts";
import type { GraphDeclarationV3 } from "../src/graph/compiler/declaration-v3.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";
const RoleboxPlugin = RoleboxModule.server;

let tmpDir: string;
let originalXdg: string | undefined;
let originalDataDir: string | undefined;

/**
 * DATA-DIR REDIRECT — the declared-graph host the entry opens during `setup`
 * touches disk.
 *
 * `OpencodeGraphHost.open` -> `GraphApplication.open` ->
 * `HostExecutionIndex.open` -> `GraphStore.openFile(root)` CREATES the store
 * root (`0700`) and initialises the store file eagerly, and the entry passes
 * `graphStoreRoot(getDataDir(), ctx.directory)` — `<getDataDir()>/host/
 * <workspaceHash>` (src/graph/store/schema.ts:58-60), with `getDataDir()`
 * resolving `ROLEBOX_DATA_DIR` first (src/cli/paths.ts:61-86). `XDG_CONFIG_HOME`
 * alone therefore does NOT isolate this file: without the redirect below every
 * boot here writes into the developer's real data directory. The previous value
 * is SAVED and restored, never clobbered unconditionally.
 */
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-idx-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalDataDir = process.env.ROLEBOX_DATA_DIR;
  process.env.XDG_CONFIG_HOME = tmpDir;
  process.env.ROLEBOX_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalDataDir === undefined) delete process.env.ROLEBOX_DATA_DIR;
  else process.env.ROLEBOX_DATA_DIR = originalDataDir;
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
      "rolebox--parent--researcher~my-research-skill",
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

// ── Declared-graph wiring (the outcome run path's tool face) ────────────────

/**
 * The v1 entry (`src/entries/opencode.ts`) is the package root opencode 1.x
 * loads, and it must register the five declared-graph tools the host capability
 * layer binds — the same face the v2 entry registers through
 * `src/platform/adapters/opencode2/graph-host.ts`.
 *
 * The host is NOT injected here: these cases boot `RoleboxPlugin` itself, so
 * what they prove is that the REAL host opens during `setup`, arms itself
 * against the REAL platform session adapter, and is closed by the returned
 * `dispose`. The five names are read off the handler map the composition
 * returned (`hooks.tool`), which is the map opencode iterates.
 *
 * The entry only CONSTRUCTS the adapter at boot — nothing calls the client — so
 * the fake below carries the one namespace the adapter's constructor reads
 * (`client.session`, src/platform/adapters/opencode/session.ts:86-91) and no
 * behaviour.
 */
describe("RoleboxPlugin declared-graph tools", () => {
  /** The five names the host binds, exactly (src/graph/tools/index.ts:43-55). */
  const GRAPH_TOOL_NAMES = [
    "graph_audit",
    "graph_control",
    "graph_declare",
    "graph_status",
    "graph_submit_outcome",
  ];

  it("registers the five declared-graph tools on the returned handler map", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    const names = Object.keys(hooks.tool ?? {});
    for (const name of GRAPH_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    // The face is the host's, not a stub: each name carries a callable tool.
    for (const name of GRAPH_TOOL_NAMES) {
      expect(typeof (hooks.tool?.[name] as { execute?: unknown } | undefined)?.execute)
        .toBe("function");
    }

    // The observation, printed — the five names as this case sees them.
    const observed = names.filter((name) => name.startsWith("graph_")).sort();
    console.log("opencode v1 handler-map graph tools:", JSON.stringify(observed));
    expect(observed).toEqual([...GRAPH_TOOL_NAMES].sort());
  }, 30_000);

  it("opens the host's store root under the redirected data dir, not the real one", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    await RoleboxPlugin(createPluginInput(tmpDir));

    // The host owns `<getDataDir()>/host/<workspaceHash>` and CREATES it when it
    // opens (src/graph/store/schema.ts:58-60; src/graph/host/execution-index.ts).
    const root = graphStoreRoot(getDataDir(), tmpDir);
    expect(getDataDir()).toBe(path.join(tmpDir, "data"));
    expect(root.startsWith(path.join(tmpDir, "data") + path.sep)).toBe(true);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(graphStoreFilePath(root))).toBe(true);
  }, 30_000);

  it("keeps forwarding every event to the composition's own handler", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    // The returned `event` is the entry's WRAPPER, and the composition's own
    // handler is what it forwards to (`handleEvent` + the bus emit,
    // src/core/services/hook-service.ts:180-199). Driving a real canonical
    // session end through the wrapper therefore exercises both: it must resolve
    // (the inner handler ran) and it must not have touched the input it was
    // handed — the wrapper reads the event, it never rewrites it.
    const event = { type: "session.idle", rawType: "session.idle", properties: { sessionID: "ses_idx_1" } };
    const input = { event };
    const snapshot = JSON.stringify(input);

    await (hooks.event as (input: { event: unknown }) => Promise<void>)(input);

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.event).toBe(event);

    // A TYPED STATUS EVENT TAKES THE SAME PATH (it is the fresh source for the
    // declared-graph host's activity reading): the wrapper resolves, the input is
    // untouched, and nothing about the other keys changes.
    const statusEvent = {
      type: "session.status",
      properties: { sessionID: "ses_idx_1", status: { type: "busy" } },
    };
    const statusInput = { event: statusEvent };
    const statusSnapshot = JSON.stringify(statusInput);
    await (hooks.event as (input: { event: unknown }) => Promise<void>)(statusInput);
    expect(JSON.stringify(statusInput)).toBe(statusSnapshot);
    expect(statusInput.event).toBe(statusEvent);

    // The other keys opencode iterates are still on the map.
    expect(Object.keys(hooks.tool ?? {}).length).toBeGreaterThan(0);
    expect(hooks.dispose).toBeDefined();
  }, 30_000);
  

  it("returns a dispose that closes the declared-graph host", async () => {
    mkdirSync(roleboxPath(), { recursive: true });
    const hooks = await RoleboxPlugin(createPluginInput(tmpDir));

    expect(typeof hooks.dispose).toBe("function");
    // Closing twice must be safe: `OpencodeGraphHost.close` is idempotent, and
    // the process-level flush handler may race a host shutdown.
    await hooks.dispose?.();
    await hooks.dispose?.();
  }, 30_000);
});

// ── Declared-graph RUN NOTIFICATIONS through the real v1 entry ──────────────

/**
 * THE WAKE-UP IS OBSERVED THROUGH THE SHIPPED ENTRY.
 *
 * `src/entries/opencode.ts:80` hands the declared-graph host
 * `notifyClient: sessionAdapter` — the SAME `OpencodeSessionAdapter` the entry
 * dispatches over — so a declared graph that reaches a terminal state must push
 * the shipped `<system-reminder>[GRAPH COMPLETE] …</system-reminder>` payload
 * into the DECLARING session's inbox with `noReply: false`, which is what makes
 * opencode 1.x run a turn and wake that agent. The host-level cases
 * (tests/platform/opencode-graph-host.test.ts) prove the channel over an
 * injected fake; the case below proves the ENTRY's OWN WIRING by driving a fake
 * opencode 1.x client through the adapter the entry built — no source text is
 * read to establish it.
 */

/** The host test's `SINGLE` fixture: one node, explicit completion, a budget. */
const NOTIFY_SINGLE: GraphDeclarationV3 = {
  version: 3,
  name: "opencode.entry.notify.single",
  nodes: [
    {
      id: "solo",
      agent: "agent.worker",
      prompt: "Do the one thing.",
      outcomes: [{ id: "done" }, { id: "failed" }],
      completion: { mode: "explicit" },
      budget: { timeout_ms: 60_000 },
    },
  ],
  edges: [],
};

/** One `session.promptAsync` call the adapter made, as the fake recorded it. */
interface RecordedPromptCall {
  readonly sessionID: string;
  readonly body: {
    readonly parts: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly noReply?: boolean;
    readonly agent?: string;
  };
}

/** The text one recorded `promptAsync` carried (the adapter sends one part). */
function promptCallText(call: RecordedPromptCall): string {
  return call.body.parts.map((part) => part.text).join("\n");
}

/** Every recorded call whose payload is the shipped wake-up reminder. */
function wakeUpCalls(calls: readonly RecordedPromptCall[]): RecordedPromptCall[] {
  return calls.filter((call) => promptCallText(call).includes("[GRAPH COMPLETE]"));
}

/**
 * A FAKE opencode 1.x client the entry's adapter can drive
 * (src/platform/adapters/opencode/session.ts:210-300):
 *  - `session.create({ body, query })` answers ONE distinct worker session id;
 *    only an explicit `error` field would be a real rejection, and the adapter
 *    reads `data` — so an id the fake names is the id the host confirms;
 *  - `session.promptAsync({ path, body })` records the call and answers `{}` —
 *    HTTP 204 with no body IS success for the adapter;
 *  - the remaining methods exist and are harmless: the host's observation and
 *    cancel ports may reach `status` / `abort`, and nothing here fabricates a
 *    turn end.
 */
function fakeOpencodeClient(): {
  readonly client: PluginInput["client"];
  readonly prompts: RecordedPromptCall[];
  readonly created: Array<{ readonly directory?: string }>;
} {
  const prompts: RecordedPromptCall[] = [];
  const created: Array<{ readonly directory?: string }> = [];
  const client = {
    session: {
      create: async (input: { body?: unknown; query?: { directory?: string } }) => {
        created.push({ directory: input.query?.directory });
        return {
          data: {
            id: "ses_worker",
            projectID: "project",
            directory: input.query?.directory ?? "",
            title: "worker",
            version: "1.0",
            time: { created: 0, updated: 0 },
          },
        };
      },
      promptAsync: async (input: { path: { id: string }; body: RecordedPromptCall["body"] }) => {
        prompts.push({ sessionID: input.path.id, body: input.body });
        return {};
      },
      prompt: async () => ({ data: { parts: [] } }),
      status: async () => ({ data: {} }),
      abort: async () => ({}),
    },
  } as unknown as PluginInput["client"];
  return { client, prompts, created };
}

/** A canonical tool context, as the v1 entry's tool face is handed one. */
function graphToolContext(sessionID: string, agent: string): CanonicalToolContext {
  return {
    sessionID,
    messageID: "m1",
    agent,
    directory: tmpDir,
    worktree: tmpDir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

/** The canonical `execute` face of one tool the entry's handler map carries. */
type GraphToolFace = {
  execute(args: Record<string, unknown>, context: CanonicalToolContext): Promise<unknown>;
};

function graphToolFace(hooks: Hooks, name: string): GraphToolFace {
  const def = hooks.tool?.[name] as unknown as GraphToolFace | undefined;
  if (def === undefined || typeof def.execute !== "function") {
    throw new Error("entry fixture: the v1 entry registered no " + name + " tool");
  }
  return def;
}

/** Poll a predicate the entry settles asynchronously — bounded, never a sleep. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("entry fixture: timed out waiting for " + label);
}

describe("RoleboxPlugin declared-graph run notifications", () => {
  it("wakes the declaring session through the real v1 entry when a graph completes", async () => {
    mkdirSync(roleboxPath(), { recursive: true });

    // THE REAL ENTRY over a fake opencode 1.x client: `RoleboxPlugin` builds the
    // session adapter from `client`, hands that SAME adapter to the host as its
    // wake-up channel, and returns the handler map opencode iterates.
    const fake = fakeOpencodeClient();
    const hooks = await RoleboxPlugin({ ...createPluginInput(tmpDir), client: fake.client });

    try {
      const declared = JSON.parse(
        String(
          await graphToolFace(hooks, "graph_declare").execute(
            { declaration: NOTIFY_SINGLE },
            graphToolContext("ses_parent", "agent.parent"),
          ),
        ),
      ) as { persisted: boolean; start: { kind: string }; graph_id: string };
      expect(declared.persisted).toBe(true);
      expect(declared.start.kind).toBe("started");

      // THE DISPATCH TRAVELLED THE ENTRY'S OWN ADAPTER: the worker session was
      // created through the fake client, and the delivery handoff — the ONE
      // channel the credential travels over — was prompted to that session.
      await waitFor(() => fake.prompts.length >= 1, "the delivery handoff");
      expect(fake.created).toEqual([{ directory: tmpDir }]);
      const handoff = fake.prompts[0]!;
      expect(handoff.sessionID).toBe("ses_worker");
      const handoffText = promptCallText(handoff);
      expect(handoffText).toContain("[rolebox outcome protocol — attempt handoff]");
      const credential = /credential: (\S+)/.exec(handoffText)?.[1];
      if (credential === undefined) {
        throw new Error("entry fixture: the delivery handoff carried no credential");
      }

      // The WORKER session settles its own attempt with the credential.
      const submitted = JSON.parse(
        String(
          await graphToolFace(hooks, "graph_submit_outcome").execute(
            { graph_id: declared.graph_id, node_id: "solo", outcome_id: "done", credential },
            graphToolContext("ses_worker", "agent.worker"),
          ),
        ),
      ) as { decision: string; verdict: string };
      expect(submitted.decision).toBe("accepted");
      expect(submitted.verdict).toBe("committed");

      // THE FLUSH IS ASYNCHRONOUS — the run's own completion transaction arms
      // it — so the push is polled for with a bounded wait, never slept on.
      await waitFor(() => wakeUpCalls(fake.prompts).length >= 1, "the graph-complete push");
      const push = wakeUpCalls(fake.prompts)[0]!;
      const pushText = promptCallText(push);

      // WHAT WAKES THE 1.x AGENT LOOP: the shipped reminder, addressed to the
      // DECLARING session, with `noReply: false`.
      expect(push.sessionID).toBe("ses_parent");
      expect(push.body.noReply).toBe(false);
      expect(pushText).toContain("<system-reminder>");
      expect(pushText).toContain("[GRAPH COMPLETE]");
      expect(pushText).toContain(declared.graph_id);
      expect(pushText).toContain("graph_status");

      // ... AND NEVER THE WORKER: the worker's ONLY promptAsync is the delivery
      // handoff, so the wake-up reached the declarer alone.
      expect(wakeUpCalls(fake.prompts)).toHaveLength(1);
      expect(fake.prompts.filter((call) => call.sessionID === "ses_worker")).toHaveLength(1);
      expect(wakeUpCalls(fake.prompts).map((call) => call.sessionID)).not.toContain("ses_worker");

      // THE GRAPH REALLY SETTLED, read back through the entry's own tool face.
      const reading = JSON.parse(
        String(
          await graphToolFace(hooks, "graph_status").execute(
            { graph_id: declared.graph_id, format: "json" },
            graphToolContext("ses_parent", "agent.parent"),
          ),
        ),
      ) as {
        phase: string;
        nodes: ReadonlyArray<{ node_id: string; status: string; outcomeId?: string }>;
      };
      expect(reading.phase).toBe("complete");
      const solo = reading.nodes.find((node) => node.node_id === "solo");
      expect(solo?.status).toBe("settled");
      expect(solo?.outcomeId).toBe("done");

      // THE OBSERVATION, printed: every promptAsync the entry produced (session
      // ids only, in order) and the wake-up payload itself, truncated.
      console.log(
        "opencode v1 entry promptAsync sessions, in order:",
        JSON.stringify(fake.prompts.map((call) => call.sessionID)),
      );
      console.log(
        "opencode v1 entry wake-up promptAsync:",
        JSON.stringify({
          sessionID: push.sessionID,
          noReply: push.body.noReply,
          text: pushText.replace(/\n/g, " ⏎ ").slice(0, 500),
        }),
      );
    } finally {
      // Close the host the entry opened while the redirected data dir it lives
      // under is still present; the shared afterEach removes that dir.
      await hooks.dispose?.();
    }
  }, 30_000);
});
