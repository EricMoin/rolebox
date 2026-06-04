import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRoles } from "./role-loader";

let tmpDir: string;
let warnMock: ReturnType<typeof mock>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-test-"));
  warnMock = mock();
  console.warn = warnMock;
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
    expect(warnMock).toHaveBeenCalledTimes(0);
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
    const warnings = warnMock.mock.calls as string[][];
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
    const warnings = warnMock.mock.calls as string[][];
    expect(warnings.some((c) => c[0].includes("broken") && c[0].includes("prompt_file"))).toBe(true);
  });

  it("skips a role missing the name field and logs a warning", async () => {
    await writeRoleYaml(
      "anon",
      "description: No name here\nprompt: I have no name.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = warnMock.mock.calls as string[][];
    expect(warnings.some((c) => c[0].includes("anon") && c[0].includes("name"))).toBe(true);
  });

  it("skips a role with empty name string", async () => {
    await writeRoleYaml(
      "empty-name",
      "name: \"\"\ndescription: Empty name\nprompt: I have an empty name.\n",
    );

    const roles = await discoverRoles(tmpDir);

    expect(roles.size).toBe(0);
    const warnings = warnMock.mock.calls as string[][];
    expect(warnings.some((c) => c[0].includes("empty-name") && c[0].includes("name"))).toBe(true);
  });

  it("returns empty Map for a non-existent roleboxDir without crashing", async () => {
    const nonexistent = join(tmpdir(), "definitely-does-not-exist-xyz");
    const roles = await discoverRoles(nonexistent);
    expect(roles.size).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(0);
  });

  it("returns empty Map when rolebox directory exists but is empty", async () => {
    const roles = await discoverRoles(tmpDir);
    expect(roles.size).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(0);
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
    const warnings = warnMock.mock.calls as string[][];
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
});
