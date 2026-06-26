import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "js-yaml";
import { validateInitRoleId, deriveRoleId, checkTargetDir } from "../../../src/cli/commands/init-utils";
import {
  generateRoleYaml,
  generatePromptFile,
  scaffoldRole,
} from "../../../src/cli/commands/init-scaffold";
import type { InitConfig, TemplateType } from "../../../src/cli/templates/index";

// ===========================================================================
// Helpers
// ===========================================================================

/** Capture console.log output for CLI test assertions. */
function captureLogs(fn: () => Promise<void>): {
  logs: string[];
  run: () => Promise<void>;
} {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args[0]);
    origLog.apply(console, args as any);
  };
  return {
    logs,
    run: async () => {
      try {
        await fn();
      } finally {
        console.log = origLog;
      }
    },
  };
}

/** Create a minimal InitConfig for testing. */
function makeConfig(overrides?: Partial<InitConfig>): InitConfig {
  return {
    name: "Test Role",
    roleId: "test-role",
    description: "A test role for unit testing",
    ...overrides,
  };
}

// ===========================================================================
// Group 1: validateInitRoleId
// ===========================================================================
describe("validateInitRoleId", () => {
  it("accepts a valid kebab-case role ID", () => {
    const result = validateInitRoleId("my-role");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("my-role");
    expect(result.error).toBeUndefined();
  });

  it("normalises spaces to hyphens and lowercases", () => {
    const result = validateInitRoleId("My Cool Role");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("my-cool-role");
  });

  it("accepts underscores in role IDs", () => {
    const result = validateInitRoleId("code_reviewer");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("code_reviewer");
  });

  it("accepts mixed hyphens and underscores", () => {
    const result = validateInitRoleId("my-role_v2");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("my-role_v2");
  });

  it("rejects empty input", () => {
    const result = validateInitRoleId("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rejects double-dash (reserved separator)", () => {
    const result = validateInitRoleId("parent--child");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("--");
  });

  it("rejects path separators", () => {
    const slashResult = validateInitRoleId("my/role");
    expect(slashResult.valid).toBe(false);
    expect(slashResult.error).toContain("path separator");

    const backslashResult = validateInitRoleId("my\\role");
    expect(backslashResult.valid).toBe(false);
    expect(backslashResult.error).toContain("path separator");
  });

  it("rejects non-ASCII characters", () => {
    const result = validateInitRoleId("café-role");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ASCII");
  });

  it("rejects too-long role IDs (>100 chars)", () => {
    const longName = "a".repeat(101);
    const result = validateInitRoleId(longName);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("1–100");
  });

  it("accepts exactly 100 chars", () => {
    const name100 = "a".repeat(100);
    const result = validateInitRoleId(name100);
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe(name100);
  });
});

// ===========================================================================
// Group 2: deriveRoleId
// ===========================================================================
describe("deriveRoleId", () => {
  it("derives a kebab-case ID from a display name", () => {
    expect(deriveRoleId("My Cool Role")).toBe("my-cool-role");
  });

  it("strips special characters while preserving hyphens", () => {
    expect(deriveRoleId("Hello World!")).toBe("hello-world");
  });

  it("preserves hyphens and underscores", () => {
    expect(deriveRoleId("code-review_v2")).toBe("code-review_v2");
  });

  it("handles leading/trailing whitespace", () => {
    expect(deriveRoleId("  Super   CODING  ")).toBe(
      "-super-coding-",
    );
  });
});

// ===========================================================================
// Group 3: checkTargetDir
// ===========================================================================
describe("checkTargetDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "rolebox-init-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reports non-existent directory", () => {
    const result = checkTargetDir(join(tmpRoot, "nonexistent"));
    expect(result.exists).toBe(false);
    expect(result.hasRoleYaml).toBe(false);
    expect(result.isEmpty).toBe(true);
  });

  it("detects role.yaml in existing directory", () => {
    const dir = join(tmpRoot, "existing-role");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "role.yaml"), "name: test", "utf-8");

    const result = checkTargetDir(dir);
    expect(result.exists).toBe(true);
    expect(result.hasRoleYaml).toBe(true);
    expect(result.isEmpty).toBe(false);
  });

  it("detects empty existing directory", () => {
    const dir = join(tmpRoot, "empty-dir");
    mkdirSync(dir, { recursive: true });

    const result = checkTargetDir(dir);
    expect(result.exists).toBe(true);
    expect(result.hasRoleYaml).toBe(false);
    expect(result.isEmpty).toBe(true);
  });

  it("detects non-empty directory without role.yaml", () => {
    const dir = join(tmpRoot, "non-role-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Hello", "utf-8");

    const result = checkTargetDir(dir);
    expect(result.exists).toBe(true);
    expect(result.hasRoleYaml).toBe(false);
    expect(result.isEmpty).toBe(false);
  });
});

// ===========================================================================
// Group 4: generateRoleYaml
// ===========================================================================
describe("generateRoleYaml", () => {
  const config = makeConfig({
    name: "Code Reviewer",
    roleId: "code-reviewer",
    description: "Reviews code for quality",
    model: "gpt-4",
  });

  it("minimal template produces parseable YAML with required fields", () => {
    const yaml = generateRoleYaml(config, "minimal");
    const parsed = load(yaml) as Record<string, unknown>;

    expect(parsed.name).toBe("Code Reviewer");
    expect(parsed.description).toBe("Reviews code for quality");
    expect(parsed.prompt_file).toBe("PROMPT.md");
    expect(parsed.model).toBe("gpt-4");
    expect(parsed.skills).toBeUndefined();
    expect(parsed.functions).toBeUndefined();
    expect(parsed.subagents).toBeUndefined();
  });

  it("standard template includes skills and functions", () => {
    const yaml = generateRoleYaml(config, "standard");
    const parsed = load(yaml) as Record<string, unknown>;

    expect(parsed.name).toBe("Code Reviewer");
    expect(parsed.skills).toEqual([]);
    expect(parsed.functions).toEqual(["plan", "execute"]);
    expect(parsed.subagents).toBeUndefined();
    expect(parsed.collaboration).toBeUndefined();
  });

  it("subagents template includes subagents array", () => {
    const subConfig = makeConfig({
      name: "Team Lead",
      roleId: "team-lead",
      description: "Leads a team",
      subagentNames: ["Researcher", "Implementer"],
    });
    const yaml = generateRoleYaml(subConfig, "subagents");
    const parsed = load(yaml) as Record<string, unknown>;

    expect(parsed.name).toBe("Team Lead");
    expect(parsed.subagents).toHaveLength(2);

    const subs = parsed.subagents as Array<Record<string, unknown>>;
    expect(subs[0].name).toBe("Researcher");
    expect(subs[0].prompt_file).toBe("PROMPT.md");
    expect(subs[1].name).toBe("Implementer");
  });

  it("collaboration template includes collaboration block", () => {
    const collabConfig = makeConfig({
      name: "Review Team",
      roleId: "review-team",
      description: "Coordinates reviews",
      subagentNames: ["Coder", "Reviewer"],
      topology: "review-loop",
    });
    const yaml = generateRoleYaml(collabConfig, "collaboration");
    const parsed = load(yaml) as Record<string, unknown>;

    expect(parsed.name).toBe("Review Team");
    expect(parsed.subagents).toHaveLength(2);

    const collab = parsed.collaboration as Record<string, unknown>;
    expect(collab).toBeDefined();
    expect(collab.topology).toBe("review-loop");
    expect(collab.max_iterations).toBe(3);

    const agents = collab.agents as string[];
    expect(agents).toHaveLength(2);
    expect(agents[0]).toBe("coder");
    expect(agents[1]).toBe("reviewer");
  });

  it("handles subagents template with no subagent names gracefully", () => {
    const yaml = generateRoleYaml(config, "subagents");
    const parsed = load(yaml) as Record<string, unknown>;
    const subs = parsed.subagents as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(0);
  });

  it("is valid YAML for all template types", () => {
    const templates: TemplateType[] = [
      "minimal",
      "standard",
      "subagents",
      "collaboration",
    ];

    for (const t of templates) {
      const cfg = makeConfig({
        subagentNames:
          t === "subagents" || t === "collaboration"
            ? ["AgentA", "AgentB"]
            : undefined,
        topology: t === "collaboration" ? "pipeline" : undefined,
      });
      const yaml = generateRoleYaml(cfg, t);
      const parsed = load(yaml);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
      expect((parsed as Record<string, unknown>).name).toBe("Test Role");
    }
  });
});

// ===========================================================================
// Group 5: generatePromptFile
// ===========================================================================
describe("generatePromptFile", () => {
  const config = makeConfig({
    name: "Code Reviewer",
    description: "Expert code reviewer",
  });

  it("minimal template produces non-empty prompt with role name", () => {
    const prompt = generatePromptFile(config, "minimal");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Code Reviewer");
    expect(prompt).toContain("TODO");
  });

  it("standard template produces structured prompt", () => {
    const prompt = generatePromptFile(config, "standard");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Code Reviewer");
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("## Code of Conduct");
    expect(prompt).toContain("Expert code reviewer");
  });

  it("subagents template includes coordination instructions", () => {
    const subConfig = makeConfig({
      name: "Team Lead",
      description: "Coordinates sub-agents",
      subagentNames: ["Researcher", "Implementer"],
    });
    const prompt = generatePromptFile(subConfig, "subagents");
    expect(prompt).toContain("Team Lead");
    expect(prompt).toContain("Researcher");
    expect(prompt).toContain("Implementer");
    expect(prompt).toContain("task()");
  });

  it("collaboration template includes topology info", () => {
    const collabConfig = makeConfig({
      name: "Review Lead",
      description: "Leads review workflow",
      topology: "review-loop",
    });
    const prompt = generatePromptFile(collabConfig, "collaboration");
    expect(prompt).toContain("Review Lead");
    expect(prompt).toContain("review-loop");
    expect(prompt).toContain("collaboration graph");
  });

  it("all template types produce non-empty content", () => {
    const templates: TemplateType[] = [
      "minimal",
      "standard",
      "subagents",
      "collaboration",
    ];

    for (const t of templates) {
      const cfg = makeConfig({
        subagentNames:
          t === "subagents" || t === "collaboration"
            ? ["AgentA"]
            : undefined,
      });
      const prompt = generatePromptFile(cfg, t);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Group 6: scaffoldRole
// ===========================================================================
describe("scaffoldRole", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "rolebox-scaffold-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("scaffolds minimal template files", async () => {
    const targetDir = join(tmpRoot, "my-minimal");
    const config = makeConfig({ name: "Minimal", roleId: "minimal" });

    await scaffoldRole(targetDir, config, "minimal");

    expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "PROMPT.md"))).toBe(true);
    // minimal should NOT have skills/functions dirs
    expect(existsSync(join(targetDir, "skills"))).toBe(false);
    expect(existsSync(join(targetDir, "functions"))).toBe(false);

    const yamlContent = readFileSync(join(targetDir, "role.yaml"), "utf-8");
    const parsed = load(yamlContent) as Record<string, unknown>;
    expect(parsed.name).toBe("Minimal");
  });

  it("scaffolds standard template with skills and functions dirs", async () => {
    const targetDir = join(tmpRoot, "my-standard");
    const config = makeConfig({ name: "Standard", roleId: "standard" });

    await scaffoldRole(targetDir, config, "standard");

    expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "PROMPT.md"))).toBe(true);
    expect(existsSync(join(targetDir, "skills/README.md"))).toBe(true);
    expect(existsSync(join(targetDir, "functions/README.md"))).toBe(true);
    expect(existsSync(join(targetDir, "subagents"))).toBe(false);
  });

  it("scaffolds subagents template with subagent directories", async () => {
    const targetDir = join(tmpRoot, "my-subagents");
    const config = makeConfig({
      name: "Team Lead",
      roleId: "team-lead",
      subagentNames: ["Researcher", "Implementer"],
    });

    await scaffoldRole(targetDir, config, "subagents");

    expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "subagents/Researcher/role.yaml"))).toBe(
      true,
    );
    expect(
      existsSync(join(targetDir, "subagents/Researcher/PROMPT.md")),
    ).toBe(true);
    expect(
      existsSync(join(targetDir, "subagents/Implementer/role.yaml")),
    ).toBe(true);

    const subYaml = load(
      readFileSync(
        join(targetDir, "subagents/Researcher/role.yaml"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(subYaml.name).toBe("Researcher");
    expect(subYaml.prompt_file).toBe("PROMPT.md");
  });

  it("scaffolds collaboration template with correct structure", async () => {
    const targetDir = join(tmpRoot, "my-collab");
    const config = makeConfig({
      name: "Review Team",
      roleId: "review-team",
      subagentNames: ["Coder", "Reviewer"],
      topology: "review-loop",
    });

    await scaffoldRole(targetDir, config, "collaboration");

    expect(existsSync(join(targetDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "PROMPT.md"))).toBe(true);

    const roleYaml = load(
      readFileSync(join(targetDir, "role.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    const collab = roleYaml.collaboration as Record<string, unknown>;
    expect(collab.topology).toBe("review-loop");
    expect(collab.max_iterations).toBe(3);
  });

  it("creates directories recursively for nested paths", async () => {
    const targetDir = join(tmpRoot, "nested-test");
    const config = makeConfig({
      name: "Deep Role",
      roleId: "deep-role",
      subagentNames: ["Sub"],
    });

    await scaffoldRole(targetDir, config, "subagents");

    expect(existsSync(join(targetDir, "subagents/Sub/PROMPT.md"))).toBe(true);
  });
});

// ===========================================================================
// Group 7: CLI integration (init function via --yes mode)
// ===========================================================================
describe("init CLI (--yes mode)", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-init-cli-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a role with --yes and name argument", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await init("my-test-role", true, undefined);

    const roleDir = join(tmpDir, "my-test-role");
    expect(existsSync(join(roleDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(roleDir, "PROMPT.md"))).toBe(true);

    const yaml = load(readFileSync(join(roleDir, "role.yaml"), "utf-8")) as Record<string, unknown>;
    expect(yaml.name).toBe("my-test-role");
    expect(yaml.functions).toEqual(["plan", "execute"]);
  });

  it("prints success and sync hint messages", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    const { logs, run } = captureLogs(async () => {
      await init("role-output", true, undefined);
    });
    await run();

    expect(logs.some((l) => l.includes("Created"))).toBe(true);
    expect(logs.some((l) => l.includes("rolebox sync"))).toBe(true);
  });

  it("respects --template flag for minimal template", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await init("bare-role", true, "minimal");

    const roleDir = join(tmpDir, "bare-role");
    const yaml = load(readFileSync(join(roleDir, "role.yaml"), "utf-8")) as Record<string, unknown>;
    expect(yaml.name).toBe("bare-role");
    expect(yaml.functions).toBeUndefined();
    expect(yaml.skills).toBeUndefined();
  });

  it("respects -t shorthand flag", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await init("team-role", true, "collaboration");

    const roleDir = join(tmpDir, "team-role");
    const yaml = load(readFileSync(join(roleDir, "role.yaml"), "utf-8")) as Record<string, unknown>;
    expect(yaml.name).toBe("team-role");
    expect(yaml.collaboration).toBeDefined();
    expect((yaml.collaboration as Record<string, unknown>).max_iterations).toBe(3);
  });

  it("throws error for invalid role name with --yes", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await expect(init("bad--name", true, undefined)).rejects.toThrow(/--/);
  });

  it("throws error when target directory already has role.yaml", async () => {
    const existingDir = join(tmpDir, "existing-dir");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, "role.yaml"), "name: existing", "utf-8");

    const { init } = await import("../../../src/cli/commands/init");
    await expect(init("existing-dir", true, undefined)).rejects.toThrow(
      /already contains a role\.yaml/,
    );
  });

  it("--yes without name uses cwd basename as role ID", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await init(undefined, true, undefined);

    const roleDir = tmpDir;
    expect(existsSync(join(roleDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(roleDir, "PROMPT.md"))).toBe(true);
  });

  it("throws error for invalid template type", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await expect(
      init("my-role", true, "nonexistent"),
    ).rejects.toThrow(/Unknown template/);
  });
});

// ===========================================================================
// Group 8: CLI integration (interactive mode with mocked prompts)
// ===========================================================================
describe("init CLI (mocked interactive mode)", () => {
  let originalCwd: string;
  let tmpDir: string;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-init-mock-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    origIsTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    let selectCount = 0;
    let textCount = 0;

    mock.module("@clack/prompts", () => ({
      intro: () => {},
      outro: () => {},
      note: () => {},
      select: async (_opts: any) => {
        selectCount++;
        if (selectCount === 1) return "standard";
        if (selectCount === 2) return "gpt-4o";
        return "standard";
      },
      text: async (opts: any) => {
        textCount++;
        if (textCount === 1) return "Mocked Role";
        if (textCount === 2) return "A mock role for testing";
        return opts.defaultValue ?? "mock";
      },
      confirm: async () => true,
      isCancel: () => false,
      cancel: (_msg?: string) => {},
    }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (origIsTTY !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  it("scaffolds a role through mocked interactive flow", async () => {
    const { init } = await import("../../../src/cli/commands/init");
    await init("mock-role", false, undefined);

    const roleDir = join(tmpDir, "mock-role");
    expect(existsSync(join(roleDir, "role.yaml"))).toBe(true);
    expect(existsSync(join(roleDir, "PROMPT.md"))).toBe(true);

    const yaml = load(
      readFileSync(join(roleDir, "role.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(yaml.name).toBe("Mocked Role");
    expect(yaml.functions).toEqual(["plan", "execute"]);
    expect(yaml.model).toBe("gpt-4o");
  });
});
