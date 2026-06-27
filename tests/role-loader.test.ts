import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRoles, applyInheritance, __setLoggerForTest } from "../src/role-loader";
import type { RoleConfig, SubAgentConfig } from "../src/types.ts";

const capturedLogs: unknown[][] = [];

// Inject a mock logger — tslog "hidden" mode doesn't use console.warn,
// so we replace the module-level logger via the test hook.
__setLoggerForTest({
  warn: (...args: unknown[]) => { capturedLogs.push(args); },
  debug: () => {},
  error: (...args: unknown[]) => { capturedLogs.push(args); },
  info: (...args: unknown[]) => { capturedLogs.push(args); },
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({}),
  attachTransport: () => {},
} as any);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-"));
  capturedLogs.length = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRoleYaml(
  roleName: string,
  content: string,
): Promise<string> {
  const roleDir = join(tmpDir, roleName);
  mkdirSync(roleDir, { recursive: true });
  const yamlPath = join(roleDir, "role.yaml");
  await writeFile(yamlPath, content, "utf-8");
  return yamlPath;
}

async function writeSubagentYaml(
  roleName: string,
  subagentName: string,
  content: string,
): Promise<string> {
  const subDir = join(tmpDir, roleName, "subagents", subagentName);
  mkdirSync(subDir, { recursive: true });
  const yamlPath = join(subDir, "role.yaml");
  await writeFile(yamlPath, content, "utf-8");
  return yamlPath;
}

describe("discoverRoles", () => {
  it("returns a Map with one entry for a single valid role.yaml", async () => {
    await writeRoleYaml(
      "engineer",
      "name: Software Engineer\ndescription: Writes code\nprompt: You are a software engineer.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.has("engineer")).toBe(true);
    const config = roles.get("engineer")!;
    expect(config.name).toBe("Software Engineer");
    expect(config.description).toBe("Writes code");
    expect(config.prompt).toBe("You are a software engineer.");
    expect(capturedLogs.length).toBe(0);
  });

  it("loads multiple valid roles from different subdirectories", async () => {
    await writeRoleYaml(
      "engineer",
      "name: Engineer\ndescription: Builds features\nprompt: You build things.\n",
    );
    await writeRoleYaml(
      "reviewer",
      "name: Reviewer\ndescription: Reviews code\nprompt: You review things.\n",
    );
    await writeRoleYaml(
      "architect",
      "name: Architect\ndescription: Designs systems\nprompt: You design things.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(3);
    expect(roles.has("engineer")).toBe(true);
    expect(roles.has("reviewer")).toBe(true);
    expect(roles.has("architect")).toBe(true);
    expect(roles.get("engineer")!.name).toBe("Engineer");
    expect(roles.get("reviewer")!.name).toBe("Reviewer");
    expect(roles.get("architect")!.name).toBe("Architect");
  });

  it("skips bad YAML and logs a warning, still loads valid roles", async () => {
    await writeRoleYaml(
      "good",
      "name: Good\ndescription: Works fine\nprompt: I am good.\n",
    );
    await writeRoleYaml(
      "bad",
      "this is not: valid: yaml: [[[broken\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.has("good")).toBe(true);
    expect(roles.has("bad")).toBe(false);
    const warnings = capturedLogs as string[][];
    expect(warnings.some((c) => c[0].includes("bad") && c[0].includes("invalid YAML"))).toBe(true);
  });

  it("skips a role when prompt_file is missing and logs a warning", async () => {
    const roleDir = join(tmpDir, "broken");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "role.yaml"),
      "name: Broken\ndescription: Missing file\nprompt_file: ./nonexistent.md\n",
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = capturedLogs as string[][]
    expect(warnings.some((c) => c[0].includes("broken") && c[0].includes("prompt_file"))).toBe(true);
  });

  it("skips a role missing the name field and logs a warning", async () => {
    await writeRoleYaml(
      "anon",
      "description: No name here\nprompt: I have no name.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = capturedLogs as string[][]
    expect(warnings.some((c) => c[0].includes("anon") && c[0].includes("name"))).toBe(true);
  });

  it("skips a role with empty name string", async () => {
    await writeRoleYaml(
      "empty-name",
      "name: \"\"\ndescription: Empty name\nprompt: I have an empty name.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = capturedLogs as string[][]
    expect(warnings.some((c) => c[0].includes("empty-name") && c[0].includes("name"))).toBe(true);
  });

  it("returns empty Map for a non-existent roleboxDir without crashing", async () => {
    const nonexistent = join(tmpdir(), "definitely-does-not-exist-xyz");
    const roles = await discoverRoles(nonexistent);
    expect(roles.size).toBe(0);
    expect(capturedLogs.length).toBe(0);
  });

  it("returns empty Map when rolebox directory exists but is empty", async () => {
    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(0);
    expect(capturedLogs.length).toBe(0);
  });

  it("loads prompt from prompt_file and resolves its content", async () => {
    const roleDir = join(tmpDir, "reader");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(join(roleDir, "prompt.md"), "You are a helpful assistant.", "utf-8");
    await writeFile(
      join(roleDir, "role.yaml"),
      "name: Reader\ndescription: Reads from file\nprompt_file: ./prompt.md\n",
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("reader")!;
    expect(config.name).toBe("Reader");
    expect(config.prompt).toBe("You are a helpful assistant.");
    expect(config.prompt_file).toBe("./prompt.md");
  });

  it("resolves {env:HOME} patterns in role.yaml prompt", async () => {
    const home = process.env.HOME!;
    await writeRoleYaml(
      "home-aware",
      `name: Home Aware\ndescription: Knows home\nprompt: "Your home is {env:HOME}"\n`,
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("home-aware")!;
    expect(config.prompt).toBe(`Your home is ${home}`);
  });

  it("resolves env vars in prompt_file content", async () => {
    const home = process.env.HOME!;
    const roleDir = join(tmpDir, "env-reader");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "prompt.md"),
      "Your home directory is {env:HOME}",
      "utf-8",
    );
    await writeFile(
      join(roleDir, "role.yaml"),
      "name: Env Reader\ndescription: Reads env\nprompt_file: ./prompt.md\n",
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.get("env-reader")!.prompt).toBe(`Your home directory is ${home}`);
  });

  it("skips a role with neither prompt nor prompt_file", async () => {
    await writeRoleYaml(
      "silent",
      "name: Silent\ndescription: Has no prompt\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = capturedLogs as string[][]
    expect(warnings.some((c) => c[0].includes("silent") && c[0].includes("prompt"))).toBe(true);
  });

  it("loads optional fields like model, temperature, and skills", async () => {
    await writeRoleYaml(
      "full",
      "name: Full\ndescription: All fields\n"
        + "prompt: I am complete.\n"
        + "model: gpt-4\n"
        + "temperature: 0.7\n"
        + "top_p: 0.9\n"
        + "mode: subagent\n"
        + "color: '#ff0000'\n"
        + "variant: turbo\n"
        + "skills:\n"
        + "  - skill-a\n"
        + "  - skill-b\n"
        + "opencode_skills:\n"
        + "  - global-skill\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("full")!;
    expect(config.model).toBe("gpt-4");
    expect(config.temperature).toBe(0.7);
    expect(config.top_p).toBe(0.9);
    expect(config.mode).toBe("subagent");
    expect(config.color).toBe("#ff0000");
    expect(config.variant).toBe("turbo");
    expect(config.skills).toEqual(["skill-a", "skill-b"]);
    expect(config.opencode_skills).toEqual(["global-skill"]);
  });

  it("does not scan nested subdirectories beyond one level", async () => {
    const deepRoleDir = join(tmpDir, "outer", "inner");
    mkdirSync(deepRoleDir, { recursive: true });
    await writeFile(
      join(deepRoleDir, "role.yaml"),
      "name: Deep\ndescription: Too deep\nprompt: Hidden.\n",
      "utf-8",
    );
    await writeRoleYaml(
      "shallow",
      "name: Shallow\ndescription: Visible\nprompt: Found.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.has("shallow")).toBe(true);
    expect(roles.has("deep")).toBe(false);
  });

  it("skips a role when directory name contains double-dash (--)", async () => {
    await writeRoleYaml(
      "my--role",
      "name: DoubleDash\ndescription: Has -- in name\nprompt: Should be skipped.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = capturedLogs as string[][]
    expect(warnings.some((c) => c[0].includes("my--role") && c[0].includes("--"))).toBe(true);
  });

  it("accepts a role with single dash in directory name", async () => {
    await writeRoleYaml(
      "my-role",
      "name: SingleDash\ndescription: Has single dash\nprompt: Should be accepted.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.has("my-role")).toBe(true);
    expect(roles.get("my-role")!.name).toBe("SingleDash");
  });

  it("accepts a role with no dash in directory name", async () => {
    await writeRoleYaml(
      "role",
      "name: NoDash\ndescription: No dash\nprompt: Should be accepted.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    expect(roles.has("role")).toBe(true);
    expect(roles.get("role")!.name).toBe("NoDash");
  });

  it("parses valid inline subagents into config.subagents", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has subagents",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: Child",
        '    description: "A child agent"',
        '    prompt: "You are the child."',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].name).toBe("Child");
    expect(config.subagents![0].description).toBe("A child agent");
    expect(config.subagents![0].prompt).toBe("You are the child.");
  });

  it("loads subagent prompt from prompt_file relative to parent YAML dir", async () => {
    const roleDir = join(tmpDir, "parent");
    mkdirSync(roleDir, { recursive: true });
    await writeFile(
      join(roleDir, "child-prompt.md"),
      "You are the child from file.",
      "utf-8",
    );
    await writeFile(
      join(roleDir, "role.yaml"),
      [
        "name: Parent Role",
        "description: Has file-based subagent",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: FileChild",
        '    description: "A file-based child"',
        "    prompt_file: ./child-prompt.md",
      ].join("\n"),
      "utf-8",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].name).toBe("FileChild");
    expect(config.subagents![0].prompt).toBe("You are the child from file.");
    expect(config.subagents![0].prompt_file).toBe("./child-prompt.md");
  });

  it("skips subagent missing name, parent still loads", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has broken subagent",
        "prompt: You are the parent.",
        "subagents:",
        "  - description: No name here",
        '    prompt: "I have no name."',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeUndefined();
    const warnings = capturedLogs as string[][]
    expect(
      warnings.some(
        (c) =>
          c[0].includes("parent") && c[0].includes('"name"'),
      ),
    ).toBe(true);
  });

  it("skips subagent missing prompt and prompt_file", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has promptless subagent",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: Silent",
        '    description: "No prompt at all"',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeUndefined();
    const warnings = capturedLogs as string[][]
    expect(
      warnings.some(
        (c) =>
          c[0].includes("Silent") && c[0].includes("prompt"),
      ),
    ).toBe(true);
  });

  it("strips nested subagents from subagent with warning", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has nested subagents",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: Nested",
        '    description: "Has own subagents"',
        '    prompt: "I have nested subagents."',
        "    subagents:",
        "      - name: Grandchild",
        '        prompt: "I am too deep."',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents!.length).toBe(1);
    expect(config.subagents![0].name).toBe("Nested");
    expect('subagents' in (config.subagents![0] as object)).toBe(false);
    const warnings = capturedLogs as string[][]
    expect(
      warnings.some(
        (c) =>
          c[0].includes("Nested") && c[0].includes('"subagents"'),
      ),
    ).toBe(true);
  });

  it("skips subagent with -- in name", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has bad-name subagent",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: bad--name",
        '    description: "Has double dash"',
        '    prompt: "I have a bad name."',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeUndefined();
    const warnings = capturedLogs as string[][]
    expect(
      warnings.some(
        (c) =>
          c[0].includes("bad--name") && c[0].includes("--"),
      ),
    ).toBe(true);
  });

  it("does not add subagents field when subagents list is empty", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has empty subagents",
        "prompt: You are the parent.",
        "subagents: []",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeUndefined();
  });

  it("resolves env vars in subagent fields via resolveEnvVarsDeep", async () => {
    const home = process.env.HOME!;
    await writeRoleYaml(
      "parent",
      [
        "name: Parent Role",
        "description: Has env-aware subagent",
        "prompt: You are the parent.",
        "subagents:",
        "  - name: EnvChild",
        '    description: "Knows env"',
        '    prompt: "Home is {env:HOME}"',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents![0].prompt).toBe(`Home is ${home}`);
  });

  describe("file-based subagent discovery", () => {
    it("discovers and parses a file-based subagent from subagents/{name}/role.yaml", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has file subagent\nprompt: I am the parent.\n",
      );
      await writeSubagentYaml(
        "parent",
        "helper",
        "name: Helper\ndescription: Helps out\nprompt: I am the helper.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeDefined();
      expect(config.subagents!.length).toBe(1);
      expect(config.subagents![0].name).toBe("Helper");
      expect(config.subagents![0].description).toBe("Helps out");
      expect(config.subagents![0].prompt).toBe("I am the helper.");
    });

    it("resolves prompt_file in file-based subagent relative to subagent directory", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has file subagent\nprompt: I am the parent.\n",
      );
      const subDir = join(tmpDir, "parent", "subagents", "filer");
      mkdirSync(subDir, { recursive: true });
      await writeFile(join(subDir, "instructions.md"), "Helper prompt from file.", "utf-8");
      await writeFile(
        join(subDir, "role.yaml"),
        "name: Filer\ndescription: File-based\nprompt_file: ./instructions.md\n",
        "utf-8",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeDefined();
      expect(config.subagents!.length).toBe(1);
      expect(config.subagents![0].name).toBe("Filer");
      expect(config.subagents![0].prompt).toBe("Helper prompt from file.");
      expect(config.subagents![0].prompt_file).toBe("./instructions.md");
    });

    it("inline subagent wins over file-based with same name", async () => {
      await writeRoleYaml(
        "parent",
        [
          "name: Parent",
          "description: Has both inline and file subagents",
          "prompt: I am the parent.",
          "subagents:",
          "  - name: Helper",
          '    description: "Inline helper"',
          '    prompt: "I am inline."',
        ].join("\n"),
      );
      await writeSubagentYaml(
        "parent",
        "helper",
        "name: Helper\ndescription: File-based helper\nprompt: I am file-based.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeDefined();
      expect(config.subagents!.length).toBe(1);
      expect(config.subagents![0].name).toBe("Helper");
      expect(config.subagents![0].description).toBe("Inline helper");
      expect(config.subagents![0].prompt).toBe("I am inline.");
    });

    it("merges inline and file-based subagents with different names", async () => {
      await writeRoleYaml(
        "parent",
        [
          "name: Parent",
          "description: Has mixed subagents",
          "prompt: I am the parent.",
          "subagents:",
          "  - name: Alpha",
          '    description: "Inline alpha"',
          '    prompt: "I am alpha."',
        ].join("\n"),
      );
      await writeSubagentYaml(
        "parent",
        "beta",
        "name: Beta\ndescription: File beta\nprompt: I am beta.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeDefined();
      expect(config.subagents!.length).toBe(2);
      const names = config.subagents!.map((s) => s.name);
      expect(names).toContain("Alpha");
      expect(names).toContain("Beta");
    });

    it("empty subagents/ directory causes no error and no subagents", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has empty subagents dir\nprompt: I am the parent.\n",
      );
      const subagentsDir = join(tmpDir, "parent", "subagents");
      mkdirSync(subagentsDir, { recursive: true });

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeUndefined();
      expect(capturedLogs.length).toBe(0);
    });

    it("non-existent subagents/ directory causes no error and no subagents", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has no subagents dir\nprompt: I am the parent.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeUndefined();
      expect(capturedLogs.length).toBe(0);
    });

    it("skips file-based subagent with invalid YAML and logs warning", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has broken file subagent\nprompt: I am the parent.\n",
      );
      await writeSubagentYaml(
        "parent",
        "bad",
        "this is not: valid: yaml: [[[broken\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeUndefined();
      const warnings = capturedLogs as string[][]
      expect(
        warnings.some((c) => c[0].includes("bad") && c[0].includes("invalid YAML")),
      ).toBe(true);
    });

    it("skips file-based subagent missing name", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has nameless file subagent\nprompt: I am the parent.\n",
      );
      await writeSubagentYaml(
        "parent",
        "anon",
        "description: No name\nprompt: I have no name.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeUndefined();
      const warnings = capturedLogs as string[][]
      expect(
        warnings.some((c) => c[0].includes("anon") && c[0].includes("name")),
      ).toBe(true);
    });

    it("skips file-based subagent with -- in name", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has bad-name file subagent\nprompt: I am the parent.\n",
      );
      await writeSubagentYaml(
        "parent",
        "bad--name",
        "name: bad--name\ndescription: Double dash\nprompt: I have a bad name.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeUndefined();
      const warnings = capturedLogs as string[][]
      expect(
        warnings.some((c) => c[0].includes("bad--name") && c[0].includes("--")),
      ).toBe(true);
    });

    it("discovers multiple file-based subagents", async () => {
      await writeRoleYaml(
        "parent",
        "name: Parent\ndescription: Has multiple file subagents\nprompt: I am the parent.\n",
      );
      await writeSubagentYaml(
        "parent",
        "one",
        "name: One\ndescription: First\nprompt: I am one.\n",
      );
      await writeSubagentYaml(
        "parent",
        "two",
        "name: Two\ndescription: Second\nprompt: I am two.\n",
      );
      await writeSubagentYaml(
        "parent",
        "three",
        "name: Three\ndescription: Third\nprompt: I am three.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("parent")!;
      expect(config.subagents).toBeDefined();
      expect(config.subagents!.length).toBe(3);
      const names = config.subagents!.map((s) => s.name);
      expect(names).toContain("One");
      expect(names).toContain("Two");
      expect(names).toContain("Three");
    });
  });

  describe("dispatch block parsing", () => {
    it("parses a valid dispatch: block with all numeric fields", async () => {
      await writeRoleYaml(
        "dispatcher",
        [
          "name: Dispatcher",
          "description: Has dispatch config",
          "prompt: I dispatch tasks.",
          "dispatch:",
          "  maxConcurrent: 3",
          "  maxQueueDepth: 20",
          "  syncReservedSlots: 2",
          "  maxActivePerParent: 5",
          "  retryAfterMs: 15000",
          "  backpressureMaxRetries: 10",
          "  backpressureMaxDelayMs: 120000",
          "  backgroundStaleTimeoutMs: 600000",
          "  syncAcquireTimeoutMs: 180000",
          "  syncPromptTimeoutMs: 300000",
        ].join("\n"),
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("dispatcher")!;
      expect(config.dispatch).toBeDefined();
      expect(config.dispatch!.maxConcurrent).toBe(3);
      expect(config.dispatch!.maxQueueDepth).toBe(20);
      expect(config.dispatch!.syncReservedSlots).toBe(2);
      expect(config.dispatch!.maxActivePerParent).toBe(5);
      expect(config.dispatch!.retryAfterMs).toBe(15000);
      expect(config.dispatch!.backpressureMaxRetries).toBe(10);
      expect(config.dispatch!.backpressureMaxDelayMs).toBe(120000);
      expect(config.dispatch!.backgroundStaleTimeoutMs).toBe(600000);
      expect(config.dispatch!.syncAcquireTimeoutMs).toBe(180000);
      expect(config.dispatch!.syncPromptTimeoutMs).toBe(300000);
      expect(capturedLogs.length).toBe(0);
    });

    it("parses a partial dispatch: block with only some fields", async () => {
      await writeRoleYaml(
        "partial-dispatch",
        [
          "name: Partial",
          "description: Some dispatch fields",
          "prompt: I dispatch.",
          "dispatch:",
          "  maxConcurrent: 7",
          "  retryAfterMs: 60000",
        ].join("\n"),
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("partial-dispatch")!;
      expect(config.dispatch).toBeDefined();
      expect(config.dispatch!.maxConcurrent).toBe(7);
      expect(config.dispatch!.retryAfterMs).toBe(60000);
      expect(config.dispatch!.maxQueueDepth).toBeUndefined();
      expect(config.dispatch!.backgroundStaleTimeoutMs).toBeUndefined();
      expect(capturedLogs.length).toBe(0);
    });

    it("drops invalid dispatch values (NaN, ≤0, non-number) with warnings, role still loads", async () => {
      await writeRoleYaml(
        "bad-dispatch",
        [
          "name: BadDispatch",
          "description: Has bad dispatch values",
          "prompt: I dispatch badly.",
          "dispatch:",
          '  maxConcurrent: "not-a-number"',
          "  maxQueueDepth: -5",
          "  retryAfterMs: 30000",
          "  backgroundStaleTimeoutMs: 0",
        ].join("\n"),
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("bad-dispatch")!;
      expect(config.dispatch).toBeDefined();
      // Invalid values should be dropped
      expect(config.dispatch!.maxConcurrent).toBeUndefined();
      expect(config.dispatch!.maxQueueDepth).toBeUndefined();
      expect(config.dispatch!.backgroundStaleTimeoutMs).toBeUndefined();
      // Valid value should survive
      expect(config.dispatch!.retryAfterMs).toBe(30000);

      // Should have warnings about invalid entries
      const warnings = capturedLogs as string[][];
      const warningCount = warnings.filter((c) =>
        c[0].includes("bad-dispatch") && c[0].includes("dispatch"),
      ).length;
      expect(warningCount).toBeGreaterThanOrEqual(3);
    });

    it("role without dispatch: block loads normally with dispatch undefined", async () => {
      await writeRoleYaml(
        "plain",
        "name: Plain\ndescription: No dispatch\nprompt: I am plain.\n",
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("plain")!;
      expect(config.dispatch).toBeUndefined();
      expect(capturedLogs.length).toBe(0);
    });

    it("dispatch: block with empty object yields dispatch undefined (no valid fields)", async () => {
      await writeRoleYaml(
        "empty-dispatch",
        [
          "name: EmptyDispatch",
          "description: Empty dispatch block",
          "prompt: I have empty dispatch.",
          "dispatch: {}",
        ].join("\n"),
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("empty-dispatch")!;
      expect(config.dispatch).toBeUndefined();
      expect(capturedLogs.length).toBe(0);
    });

    it("resolves env vars in dispatch values", async () => {
      process.env.ROLEBOX_TEST_DISPATCH_CONC = "12";
      await writeRoleYaml(
        "env-dispatch",
        [
          "name: EnvDispatch",
          "description: Dispatch with env vars",
          "prompt: I dispatch with env.",
          "dispatch:",
          "  maxConcurrent: \"{env:ROLEBOX_TEST_DISPATCH_CONC}\"",
          "  retryAfterMs: 45000",
        ].join("\n"),
      );

      const roles = await discoverRoles(tmpDir);

      expect(roles.size).toBe(1);
      const config = roles.get("env-dispatch")!;
      expect(config.dispatch).toBeDefined();
      expect(config.dispatch!.maxConcurrent).toBe(12);
      expect(config.dispatch!.retryAfterMs).toBe(45000);

      delete process.env.ROLEBOX_TEST_DISPATCH_CONC;
    });
  });
});

describe("applyInheritance", () => {
  function makeParent(overrides: Partial<RoleConfig> = {}): RoleConfig {
    return {
      name: "Parent",
      description: "Parent role",
      prompt: "You are the parent.",
      ...overrides,
    };
  }

  function makeChild(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
      name: "Child",
      description: "Child agent",
      prompt: "You are the child.",
      ...overrides,
    };
  }

  it("inherits model from parent when child omits it", () => {
    const parent = makeParent({ model: "gpt-4" });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.model).toBe("gpt-4");
  });

  it("child model overrides parent model", () => {
    const parent = makeParent({ model: "gpt-4" });
    const child = makeChild({ model: "claude-3" });
    const result = applyInheritance(parent, child);
    expect(result.model).toBe("claude-3");
  });

  it("inherits temperature from parent when child omits it", () => {
    const parent = makeParent({ temperature: 0.5 });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.temperature).toBe(0.5);
  });

  it("child temperature overrides parent temperature", () => {
    const parent = makeParent({ temperature: 0.5 });
    const child = makeChild({ temperature: 0.8 });
    const result = applyInheritance(parent, child);
    expect(result.temperature).toBe(0.8);
  });

  it("inherits top_p from parent when child omits it", () => {
    const parent = makeParent({ top_p: 0.9 });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.top_p).toBe(0.9);
  });

  it("child top_p overrides parent top_p", () => {
    const parent = makeParent({ top_p: 0.9 });
    const child = makeChild({ top_p: 0.5 });
    const result = applyInheritance(parent, child);
    expect(result.top_p).toBe(0.5);
  });

  it("inherits permission from parent when child omits it", () => {
    const parent = makeParent({ permission: { allow: ["Read"] } });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.permission).toEqual({ allow: ["Read"] });
  });

  it("inherits tools from parent when child omits it", () => {
    const parent = makeParent({ tools: { Bash: false } });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.tools).toEqual({ Bash: false });
  });

  it("inherits color from parent when child omits it", () => {
    const parent = makeParent({ color: "#ff0000" });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.color).toBe("#ff0000");
  });

  it("inherits variant from parent when child omits it", () => {
    const parent = makeParent({ variant: "turbo" });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.variant).toBe("turbo");
  });

  it("child variant overrides parent variant", () => {
    const parent = makeParent({ variant: "turbo" });
    const child = makeChild({ variant: "normal" });
    const result = applyInheritance(parent, child);
    expect(result.variant).toBe("normal");
  });

  it("returns undefined for model when neither parent nor child has it", () => {
    const parent = makeParent();
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.model).toBeUndefined();
    expect("model" in result).toBe(false);
  });

  it("does NOT inherit name from parent", () => {
    const parent = makeParent({ name: "ParentName" });
    const child = makeChild({ name: "ChildName" });
    const result = applyInheritance(parent, child);
    expect(result.name).toBe("ChildName");
  });

  it("does NOT inherit description from parent", () => {
    const parent = makeParent({ description: "Parent description" });
    const child = makeChild({ description: "Child description" });
    const result = applyInheritance(parent, child);
    expect(result.description).toBe("Child description");
  });

  it("does NOT inherit prompt from parent", () => {
    const parent = makeParent({ prompt: "Parent prompt" });
    const child = makeChild({ prompt: "Child prompt" });
    const result = applyInheritance(parent, child);
    expect(result.prompt).toBe("Child prompt");
  });

  it("does NOT inherit skills from parent", () => {
    const parent = makeParent({ skills: ["parent-skill"] });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.skills).toBeUndefined();
    expect("skills" in result).toBe(false);
  });

  it("does NOT inherit opencode_skills from parent", () => {
    const parent = makeParent({ opencode_skills: ["global-skill"] });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.opencode_skills).toBeUndefined();
    expect("opencode_skills" in result).toBe(false);
  });

  it("does NOT inherit functions from parent", () => {
    const parent = makeParent({ functions: ["plan"] });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.functions).toBeUndefined();
    expect("functions" in result).toBe(false);
  });

  it("does NOT inherit disable_functions from parent", () => {
    const parent = makeParent({ disable_functions: ["execute"] });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.disable_functions).toBeUndefined();
    expect("disable_functions" in result).toBe(false);
  });

  it("preserves child prompt_file without inheriting from parent", () => {
    const parent = makeParent({ prompt_file: "./parent-prompt.md" });
    const child = makeChild({ prompt_file: "./child-prompt.md" });
    const result = applyInheritance(parent, child);
    expect(result.prompt_file).toBe("./child-prompt.md");
  });

  it("child prompt_file is undefined when child has none (not inherited)", () => {
    const parent = makeParent({ prompt_file: "./parent-prompt.md" });
    const child = makeChild();
    const result = applyInheritance(parent, child);
    expect(result.prompt_file).toBeUndefined();
    expect("prompt_file" in result).toBe(false);
  });

  it("child keeps its own skills when set", () => {
    const parent = makeParent({ skills: ["parent-skill"] });
    const child = makeChild({ skills: ["child-skill"] });
    const result = applyInheritance(parent, child);
    expect(result.skills).toEqual(["child-skill"]);
  });

  it("child keeps its own functions when set", () => {
    const parent = makeParent({ functions: ["plan"] });
    const child = makeChild({ functions: ["review"] });
    const result = applyInheritance(parent, child);
    expect(result.functions).toEqual(["review"]);
  });

  it("inherits multiple fields simultaneously", () => {
    const parent = makeParent({
      model: "gpt-4",
      temperature: 0.3,
      color: "#00ff00",
      permission: { allow: ["Read"] },
    });
    const child = makeChild({ temperature: 0.7 });
    const result = applyInheritance(parent, child);
    expect(result.model).toBe("gpt-4");
    expect(result.temperature).toBe(0.7);
    expect(result.color).toBe("#00ff00");
    expect(result.permission).toEqual({ allow: ["Read"] });
  });
});

describe("discoverRoles with inheritance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-"));
    capturedLogs.length = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeRoleYaml(roleName: string, content: string): Promise<string> {
    const roleDir = join(tmpDir, roleName);
    mkdirSync(roleDir, { recursive: true });
    const yamlPath = join(roleDir, "role.yaml");
    await writeFile(yamlPath, content, "utf-8");
    return yamlPath;
  }

  async function writeSubagentYaml(
    roleName: string,
    subagentName: string,
    content: string,
  ): Promise<string> {
    const subDir = join(tmpDir, roleName, "subagents", subagentName);
    mkdirSync(subDir, { recursive: true });
    const yamlPath = join(subDir, "role.yaml");
    await writeFile(yamlPath, content, "utf-8");
    return yamlPath;
  }

  it("inline subagent inherits parent model", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent",
        "description: Has subagents",
        "prompt: I am the parent.",
        "model: gpt-4",
        "subagents:",
        "  - name: Child",
        '    description: "Child agent"',
        '    prompt: "I am the child."',
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents![0].model).toBe("gpt-4");
  });

  it("inline subagent explicit model overrides parent model", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent",
        "description: Has subagents",
        "prompt: I am the parent.",
        "model: gpt-4",
        "subagents:",
        "  - name: Child",
        '    description: "Child agent"',
        '    prompt: "I am the child."',
        "    model: claude-3",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents![0].model).toBe("claude-3");
  });

  it("file-based subagent inherits parent temperature", async () => {
    await writeRoleYaml(
      "parent",
      "name: Parent\ndescription: Has subagents\nprompt: I am the parent.\ntemperature: 0.3\n",
    );
    await writeSubagentYaml(
      "parent",
      "helper",
      "name: Helper\ndescription: Helps out\nprompt: I am the helper.\n",
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents![0].temperature).toBe(0.3);
  });

  it("file-based subagent explicit permission overrides parent", async () => {
    await writeRoleYaml(
      "parent",
      [
        "name: Parent",
        "description: Has subagents",
        "prompt: I am the parent.",
        "permission:",
        "  allow:",
        "    - Read",
      ].join("\n"),
    );
    await writeSubagentYaml(
      "parent",
      "helper",
      [
        "name: Helper",
        "description: Helps out",
        "prompt: I am the helper.",
        "permission:",
        "  allow:",
        "    - Bash",
      ].join("\n"),
    );

    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(1);
    const config = roles.get("parent")!;
    expect(config.subagents).toBeDefined();
    expect(config.subagents![0].permission).toEqual({ allow: ["Bash"] });
  });
});
