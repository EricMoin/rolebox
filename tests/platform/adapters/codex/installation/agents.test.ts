import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAgentName,
  collectCodexAgentDescriptors,
  renderCodexAgent,
  syncCodexAgents,
} from "../../../../../src/platform/adapters/codex/installation/agents.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../../../../src/types.ts";

const { parse: parseToml } = createRequire(import.meta.url)("toml") as {
  parse: (value: string) => Record<string, unknown>;
};
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-codex-agents-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function role(id = "reviewer", config: Partial<ResolvedRole["config"]> = {}, subagents: ResolvedSubAgent[] = []): ResolvedRole {
  return {
    id,
    config: { name: id, description: `${id} description`, prompt: `Review as ${id}.`, ...config },
    prompt: config.prompt ?? `Review as ${id}.`,
    skills: [],
    functions: [],
    references: [],
    subagents,
  };
}

function child(id: string, parentId: string, subagents: ResolvedSubAgent[] = []): ResolvedSubAgent {
  return {
    ...role(id, {}, subagents),
    parentId,
    inheritedFrom: {},
  };
}

describe("Codex native agent descriptors", () => {
  it("keeps recursive child identities private and gives each parent only its direct-child roster", () => {
    const nested = child("reviewer--researcher--reader", "reviewer--researcher");
    const researcher = child("reviewer--researcher", "reviewer", [nested]);
    const hiddenOtherChild = child("builder--executor", "builder");
    const { agents } = collectCodexAgentDescriptors([
      role("reviewer", {}, [researcher]),
      role("builder", {}, [hiddenOtherChild]),
    ]);

    expect(agents.map(agent => [agent.roleId, agent.parentId, agent.rootRoleId])).toEqual([
      ["reviewer", undefined, "reviewer"],
      ["reviewer--researcher", "reviewer", "reviewer"],
      ["reviewer--researcher--reader", "reviewer--researcher", "reviewer"],
      ["builder", undefined, "builder"],
      ["builder--executor", "builder", "builder"],
    ]);
    expect(agents[0].developerInstructions).toContain('"reviewer--researcher"');
    expect(agents[0].developerInstructions).not.toContain("reviewer--researcher--reader");
    expect(agents[0].developerInstructions).not.toContain("builder--executor");
    expect(agents[1].developerInstructions).toContain('"reviewer--researcher--reader"');
    expect(agents[0].developerInstructions).toContain("not globally registered native Codex agent names");
  });

  it("renders real TOML that round-trips Unicode, multiline instructions and control characters", () => {
    const prompt = 'Review "quoted" text.\nWindows C:\\project\n日本語\t\u0001';
    const { agents } = collectCodexAgentDescriptors([role("reviewer", {
      prompt,
      description: 'Review "carefully"\nwith evidence.',
      model: "native-model",
      variant: "high",
    })]);
    const parsed = parseToml(renderCodexAgent(agents[0]));

    expect(parsed).toEqual({
      name: "rolebox--reviewer",
      description: 'Review "carefully"\nwith evidence.',
      developer_instructions: agents[0].developerInstructions,
      model: "native-model",
      model_reasoning_effort: "high",
    });
    expect(parsed.developer_instructions).toContain(prompt);
  });

  it("projects provider-qualified models only for a matching inherited provider", () => {
    const roles = [role("one", { model: "example-provider/family/model-name" })];
    const unknown = collectCodexAgentDescriptors(roles);
    const matching = collectCodexAgentDescriptors(roles, { modelProvider: "example-provider" });
    const different = collectCodexAgentDescriptors(roles, { modelProvider: "another-provider" });

    expect(unknown.agents[0].model).toBeUndefined();
    expect(unknown.warnings).toHaveLength(1);
    expect(matching.agents[0].model).toBe("family/model-name");
    expect(matching.warnings).toEqual([]);
    expect(different.agents[0].model).toBeUndefined();
    expect(different.warnings.join(" ")).not.toContain("family/model-name");
  });

  it("preserves the current native ultra reasoning effort", () => {
    const { agents, warnings } = collectCodexAgentDescriptors([role("reviewer", { variant: "ultra" })]);
    expect(agents[0].reasoningEffort).toBe("ultra");
    expect(parseToml(renderCodexAgent(agents[0])).model_reasoning_effort).toBe("ultra");
    expect(warnings).toEqual([]);
  });

  it("emits only supported feature denials and never escalates inherited permissions", () => {
    const { agents, warnings } = collectCodexAgentDescriptors([role("reviewer", {
      tools: { exec_command: false, apps: true, read: false },
      permission: { allow: ["plugins"], deny: ["request_permissions_tool"] },
      temperature: 0.2,
      top_p: 0.8,
      variant: "unknown-variant",
    })]);
    expect(parseToml(renderCodexAgent(agents[0]))).toEqual({
      name: "rolebox--reviewer",
      description: "reviewer description",
      developer_instructions: agents[0].developerInstructions,
      features: { request_permissions_tool: false, shell_tool: false },
    });
    expect(warnings).toHaveLength(3);
    expect(agents[0]).not.toHaveProperty("reasoningEffort");
    expect(renderCodexAgent(agents[0])).not.toMatch(/sandbox_mode|approval_policy|model_provider|mcp_servers|= true/);
  });

  it.each(["*", "exec_*"])("honors permission denial %s over explicit native tool grants", pattern => {
    const { agents } = collectCodexAgentDescriptors([role("reviewer", {
      tools: { exec_command: true }, permission: { deny: [pattern] },
    })]);
    expect(parseToml(renderCodexAgent(agents[0])).features).toMatchObject({ shell_tool: false });
  });

  it("uses namespaced, filesystem-safe names without case or normalization collisions", () => {
    const ids = ["worker", "Worker", "worker/../../secret", "worker name", "worker-name", "审查员", "x".repeat(100)];
    const names = ids.map(codexAgentName);
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(ids.length);
    for (const name of names) {
      expect(name).toMatch(/^rolebox--[a-z0-9_-]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(names[0]).toBe("rolebox--worker");
    expect(ids.map(codexAgentName)).toEqual(names);
  });

  it("refuses duplicate and inconsistent identities before writing a native catalog", () => {
    expect(() => collectCodexAgentDescriptors([role("reviewer"), role("reviewer")])).toThrow(/Duplicate/);
    expect(() => collectCodexAgentDescriptors([role("reviewer", {}, [child("reviewer--child", "other")])])).toThrow(/inconsistent parent/);
  });
});

describe("syncCodexAgents", () => {
  it("exports native top-level roles while keeping recursive children out of auto-discovery", () => {
    const codexHome = temporaryDirectory();
    const result = syncCodexAgents([role("reviewer", {}, [child("reviewer--researcher", "reviewer")])], { codexHome });

    expect(result.agents).toHaveLength(2);
    expect(result.written).toBe(1);
    expect(readdirSync(result.agentDir)).toEqual(["rolebox--reviewer.toml"]);
    expect(parseToml(readFileSync(join(result.agentDir, "rolebox--reviewer.toml"), "utf-8")).name).toBe("rolebox--reviewer");
  });

  it("is byte and inode stable when unchanged and updates generated instructions when the role changes", () => {
    const codexHome = temporaryDirectory();
    const first = syncCodexAgents([role()], { codexHome });
    const path = join(first.agentDir, "rolebox--reviewer.toml");
    const content = readFileSync(path, "utf-8");
    const inode = lstatSync(path).ino;
    const manifest = readFileSync(first.manifestPath, "utf-8");
    expect(syncCodexAgents([role()], { codexHome }).written).toBe(0);
    expect(readFileSync(path, "utf-8")).toBe(content);
    expect(readFileSync(first.manifestPath, "utf-8")).toBe(manifest);
    expect(lstatSync(path).ino).toBe(inode);

    expect(syncCodexAgents([role("reviewer", { prompt: "New instructions." })], { codexHome }).written).toBe(1);
    expect(parseToml(readFileSync(path, "utf-8")).developer_instructions).toContain("New instructions.");
  });

  it("preserves unmanaged files and local edits, including managed-looking names", () => {
    const codexHome = temporaryDirectory();
    const agentsDir = join(codexHome, "agents");
    mkdirSync(agentsDir);
    const userPath = join(agentsDir, "rolebox--reviewer.toml");
    writeFileSync(userPath, 'name = "user-role"\n');
    const collision = syncCodexAgents([role()], { codexHome });
    expect(collision.written).toBe(0);
    expect(collision.warnings.join(" ")).toContain("unmanaged or edited");
    expect(readFileSync(userPath, "utf-8")).toBe('name = "user-role"\n');

    const generated = syncCodexAgents([role("builder")], { codexHome });
    const generatedPath = join(generated.agentDir, "rolebox--builder.toml");
    writeFileSync(generatedPath, "# user edit\n");
    const edited = syncCodexAgents([role("builder", { prompt: "Update." })], { codexHome });
    expect(edited.written).toBe(0);
    expect(readFileSync(generatedPath, "utf-8")).toBe("# user edit\n");
  });

  it("removes stale owned agents and preserves stale locally edited agents", () => {
    const codexHome = temporaryDirectory();
    const first = syncCodexAgents([role("one"), role("two")], { codexHome });
    writeFileSync(join(first.agentDir, "rolebox--two.toml"), "# keep user edit\n");
    const result = syncCodexAgents([], { codexHome });
    expect(result.removed).toBe(1);
    expect(existsSync(join(first.agentDir, "rolebox--one.toml"))).toBe(false);
    expect(readFileSync(join(first.agentDir, "rolebox--two.toml"), "utf-8")).toBe("# keep user edit\n");
    expect(result.warnings.join(" ")).toContain("local changes");
  });

  it("keeps project-scoped roles in the project Codex layer", () => {
    const codexHome = temporaryDirectory();
    const projectDir = temporaryDirectory();
    const result = syncCodexAgents([role()], { codexHome, projectDir });
    expect(result.agentDir).toBe(join(projectDir, ".codex", "agents"));
    expect(existsSync(join(codexHome, "agents"))).toBe(false);
  });

  it("does not follow an existing symlink at an agent destination", () => {
    const codexHome = temporaryDirectory();
    const external = join(temporaryDirectory(), "external.toml");
    writeFileSync(external, "# external file\n");
    mkdirSync(join(codexHome, "agents"));
    const agentPath = join(codexHome, "agents", "rolebox--reviewer.toml");
    symlinkSync(external, agentPath);
    expect(syncCodexAgents([role()], { codexHome }).written).toBe(0);
    expect(lstatSync(agentPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, "utf-8")).toBe("# external file\n");
  });

  it("preserves a broken manifest symlink instead of replacing it", () => {
    const codexHome = temporaryDirectory();
    const manifest = join(codexHome, "rolebox-agents.json");
    symlinkSync(join(codexHome, "missing-manifest.json"), manifest);
    expect(() => syncCodexAgents([role()], { codexHome })).toThrow(/regular file/);
    expect(lstatSync(manifest).isSymbolicLink()).toBe(true);
    expect(existsSync(join(codexHome, "agents"))).toBe(false);
  });

  it("refuses a manifest with path traversal entries before mutating agent files", () => {
    const codexHome = temporaryDirectory();
    writeFileSync(join(codexHome, "rolebox-agents.json"), JSON.stringify({
      version: 1,
      files: [{ name: "../outside.toml", sha256: "a".repeat(64) }],
    }));
    expect(() => syncCodexAgents([role()], { codexHome })).toThrow(/manifest entry/);
    expect(existsSync(join(codexHome, "agents"))).toBe(false);
  });
});
