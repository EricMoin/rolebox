import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveSkills, loadSkillContent, parseFrontmatter } from "../src/skill-resolver";

let tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

function tmpDir(): string {
  const dir = mkdtempSync("/tmp/rolebox-test-");
  tmpRoots.push(dir);
  return dir;
}

function mkSkillFile(
  baseDir: string,
  skillName: string,
  content: string,
  dirBased = true,
): string {
  const skillsDir = join(baseDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  if (dirBased) {
    const skillDir = join(skillsDir, skillName);
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, content);
    return filePath;
  }

  const filePath = join(skillsDir, `${skillName}.md`);
  writeFileSync(filePath, content);
  return filePath;
}

function mkGlobalSkillFile(
  globalDir: string,
  skillName: string,
  content: string,
  dirBased = true,
): string {
  if (dirBased) {
    const skillDir = join(globalDir, skillName);
    mkdirSync(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, content);
    return filePath;
  }

  const filePath = join(globalDir, `${skillName}.md`);
  writeFileSync(filePath, content);
  return filePath;
}

describe("resolveSkills", () => {
  it("finds role-local directory-based skill (priority 1)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "my-skill", "content1", true);

    const result = await resolveSkills(["my-skill"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].scope).toBe("rolebox");
    expect(result[0].filePath).toContain("/skills/my-skill/SKILL.md");
  });

  it("finds role-local single-file skill (priority 2)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "my-skill", "content2", false);

    const result = await resolveSkills(["my-skill"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].scope).toBe("rolebox");
    expect(result[0].filePath).toContain("/skills/my-skill.md");
  });

  it("finds global directory-based skill (priority 3)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkGlobalSkillFile(globalDir, "my-skill", "content3", true);

    const result = await resolveSkills(["my-skill"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].scope).toBe("opencode");
    expect(result[0].filePath).toContain("/my-skill/SKILL.md");
  });

  it("finds global single-file skill (priority 4)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkGlobalSkillFile(globalDir, "my-skill", "content4", false);

    const result = await resolveSkills(["my-skill"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].scope).toBe("opencode");
    expect(result[0].filePath).toContain("/my-skill.md");
  });

  it("skips missing skills without error (returns empty array)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    const result = await resolveSkills(
      ["nonexistent-skill"],
      roleDir,
      globalDir,
    );

    expect(result).toEqual([]);
  });

  it("resolves multiple skills at once", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "skill-a", "a", true);
    mkGlobalSkillFile(globalDir, "skill-b", "b", false);

    const result = await resolveSkills(
      ["skill-a", "skill-b"],
      roleDir,
      globalDir,
    );

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("mixed: some found, some missing", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "found-skill", "x", true);

    const result = await resolveSkills(
      ["found-skill", "missing-skill"],
      roleDir,
      globalDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("found-skill");
  });

  it("respects priority: role-local dir-based beats single-file", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "dup", "dir-based", true);
    mkSkillFile(roleDir, "dup", "single-file", false);

    const result = await resolveSkills(["dup"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toContain("/skills/dup/SKILL.md");
    expect(result[0].scope).toBe("rolebox");
  });

  it("respects priority: role-local beats global", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "dup", "role", true);
    mkGlobalSkillFile(globalDir, "dup", "global", true);

    const result = await resolveSkills(["dup"], roleDir, globalDir);

    expect(result).toHaveLength(1);
    expect(result[0].scope).toBe("rolebox");
  });

  it("reads description from SKILL.md frontmatter", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(
      roleDir,
      "test",
      "---\ndescription: A test skill\n---\n# Body",
      true,
    );

    const result = await resolveSkills(["test"], roleDir, globalDir);

    expect(result[0].description).toBe("A test skill");
  });

  it("falls back to empty description when SKILL.md has no frontmatter", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(roleDir, "test", "# Just body content", true);

    const result = await resolveSkills(["test"], roleDir, globalDir);

    expect(result[0].description).toBe("");
  });

  it("falls back to empty description when SKILL.md has frontmatter but no description field", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    mkSkillFile(
      roleDir,
      "test",
      "---\nname: test-skill\n---\n# Body",
      true,
    );

    const result = await resolveSkills(["test"], roleDir, globalDir);

    expect(result[0].description).toBe("");
  });
});

describe("loadSkillContent", () => {
  it("returns full file content", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    const content = "---\nname: test-skill\n---\n\n# Heading\n\nSkill body.";
    mkSkillFile(roleDir, "test-skill", content, true);

    const [resolved] = await resolveSkills(
      ["test-skill"],
      roleDir,
      globalDir,
    );

    const loaded = await loadSkillContent(resolved);
    expect(loaded).toBe(content);
  });

  it("throws when the file no longer exists", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();

    const filePath = mkSkillFile(roleDir, "ephemeral", "gone soon", true);

    const [resolved] = await resolveSkills(
      ["ephemeral"],
      roleDir,
      globalDir,
    );

    rmSync(filePath);

    await expect(loadSkillContent(resolved)).rejects.toThrow(
      /Skill file not found/,
    );
  });
});

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter with --- delimiters", () => {
    const content = `---
name: humanizer
description: Remove signs of AI writing
license: MIT
compatibility: claude-code opencode
allowed-tools:
  - Read
  - Write
---
# Humanizer Skill

This is the body content.`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata.name).toBe("humanizer");
    expect(metadata.description).toBe("Remove signs of AI writing");
    expect(metadata.license).toBe("MIT");
    expect(metadata.compatibility).toBe("claude-code opencode");
    expect(metadata["allowed-tools"]).toEqual(["Read", "Write"]);

    expect(body).toContain("# Humanizer Skill");
    expect(body).toContain("This is the body content.");
  });

  it("returns empty metadata and full content when no --- markers", () => {
    const content = "# No frontmatter\n\nJust body text.";

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({});
    expect(body).toBe(content);
  });

  it("returns empty metadata when only opening --- exists", () => {
    const content = `---
unclosed frontmatter`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({});
    expect(body).toBe(content);
  });

  it("returns empty metadata and full content on invalid YAML", () => {
    const content = `---
\x00invalid: true
---
body after bad frontmatter`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({});
    expect(body).toBe(content);
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
body with empty frontmatter`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({});
    expect(body).toContain("body with empty frontmatter");
  });

  it("does not mistake horizontal rules in body as frontmatter", () => {
    const content = `# Title

---

Some body with a horizontal rule.

---

More content.`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({});
    expect(body).toBe(content);
  });

  it("handles frontmatter with nested YAML structures", () => {
    const content = `---
nested:
  key1: value1
  key2:
    - item1
    - item2
---
# Body`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata).toEqual({
      nested: {
        key1: "value1",
        key2: ["item1", "item2"],
      },
    });
    expect(body).toBe("# Body");
  });

  it("trims leading whitespace before checking for ---", () => {
    const content = `\n\n---
name: whitespace-test
---
body`;

    const { metadata, body } = parseFrontmatter(content);

    expect(metadata.name).toBe("whitespace-test");
    expect(body).toBe("body");
  });
});
