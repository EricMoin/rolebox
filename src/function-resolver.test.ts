import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveFunctions, loadFunctionContent } from "./function-resolver";

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

function mkFuncFile(
  baseDir: string,
  subDir: string,
  funcName: string,
  content: string,
): string {
  const targetDir = subDir ? join(baseDir, subDir) : baseDir;
  mkdirSync(targetDir, { recursive: true });
  const filePath = join(targetDir, `${funcName}.md`);
  writeFileSync(filePath, content);
  return filePath;
}

describe("resolveFunctions", () => {
  it("resolves role-local function (priority 1)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(roleDir, "functions", "my-func", "---\nname: my-func\n---\n\nBody content");

    const result = await resolveFunctions(["my-func"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-func");
    expect(result[0].source).toBe("role-local");
    expect(result[0].filePath).toContain("/functions/my-func.md");
    expect(result[0].content).toBe("\nBody content");
  });

  it("falls back to global when role-local missing (priority 2)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(globalDir, "", "my-func", "---\nname: my-func\n---\n\nGlobal body");

    const result = await resolveFunctions(["my-func"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-func");
    expect(result[0].source).toBe("global");
    expect(result[0].filePath).not.toContain("/functions/");
    expect(result[0].content).toBe("\nGlobal body");
  });

  it("falls back to built-in when role-local and global missing (priority 3)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(builtinDir, "", "my-func", "---\nname: my-func\n---\n\nBuilt-in body");

    const result = await resolveFunctions(["my-func"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("my-func");
    expect(result[0].source).toBe("built-in");
    expect(result[0].content).toBe("\nBuilt-in body");
  });

  it("respects full priority chain: role-local beats global beats built-in", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "dup",
      "---\nname: dup\n---\n\nRole-local content",
    );
    mkFuncFile(globalDir, "", "dup", "---\nname: dup\n---\n\nGlobal content");
    mkFuncFile(builtinDir, "", "dup", "---\nname: dup\n---\n\nBuilt-in content");

    const result = await resolveFunctions(["dup"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("role-local");
    expect(result[0].content).toBe("\nRole-local content");
  });

  it("skips missing function gracefully (empty result, no error)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const result = await resolveFunctions(
      ["nonexistent-func"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toEqual([]);
  });

  it("skips files with empty body after frontmatter", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(roleDir, "functions", "empty-body", "---\nname: empty-body\n---\n");

    const result = await resolveFunctions(["empty-body"], roleDir, globalDir, builtinDir);

    expect(result).toEqual([]);
  });

  it("skips files with only whitespace body after frontmatter", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "whitespace-body",
      "---\nname: ws\n---\n   \t\n \n  ",
    );

    const result = await resolveFunctions(
      ["whitespace-body"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toEqual([]);
  });

  it("uses frontmatter name when present (overrides file name)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "file-name",
      "---\nname: frontmatter-name\n---\n\nBody",
    );

    const result = await resolveFunctions(["file-name"], roleDir, globalDir, builtinDir);

    expect(result[0].name).toBe("frontmatter-name");
    expect(result[0].filePath).toContain("file-name.md");
  });

  it("falls back to file name when frontmatter has no name", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "fallback-func",
      "---\ndescription: Some desc\n---\n\nBody",
    );

    const result = await resolveFunctions(
      ["fallback-func"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result[0].name).toBe("fallback-func");
    expect(result[0].description).toBe("Some desc");
  });

  it("extracts frontmatter description", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "desc-func",
      "---\nname: desc-func\ndescription: A helpful function\n---\n\nBody",
    );

    const result = await resolveFunctions(["desc-func"], roleDir, globalDir, builtinDir);

    expect(result[0].description).toBe("A helpful function");
  });

  it("falls back to empty description when frontmatter has no description field", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(
      roleDir,
      "functions",
      "no-desc",
      "---\nname: no-desc\n---\n\nBody",
    );

    const result = await resolveFunctions(["no-desc"], roleDir, globalDir, builtinDir);

    expect(result[0].description).toBe("");
  });

  it("works with content that has no frontmatter at all", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(roleDir, "functions", "no-fm", "Plain body content. No frontmatter.");

    const result = await resolveFunctions(["no-fm"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Plain body content. No frontmatter.");
    expect(result[0].description).toBe("");
  });

  it("resolves multiple functions in one call (mix of found and not-found)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(roleDir, "functions", "func-a", "---\nname: func-a\n---\n\nA");
    mkFuncFile(globalDir, "", "func-b", "---\nname: func-b\n---\n\nB");
    mkFuncFile(builtinDir, "", "func-c", "---\nname: func-c\n---\n\nC");

    const result = await resolveFunctions(
      ["func-a", "func-b", "func-c", "missing"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(3);
    expect(result.map((f) => f.name).sort()).toEqual([
      "func-a",
      "func-b",
      "func-c",
    ]);
    expect(result.map((f) => f.source).sort()).toEqual([
      "built-in",
      "global",
      "role-local",
    ]);
  });

  it("preserves special characters in content", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const specialContent = `---
name: special
---

Content with <angle brackets>, "double quotes", 'single quotes', & ampersands,
backticks \`code\`, and **markdown** formatting.

\`\`\`typescript
const x: string = "hello";
\`\`\``;

    mkFuncFile(roleDir, "functions", "special", specialContent);

    const result = await resolveFunctions(["special"], roleDir, globalDir, builtinDir);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("<angle brackets>");
    expect(result[0].content).toContain('"double quotes"');
    expect(result[0].content).toContain("'single quotes'");
    expect(result[0].content).toContain("& ampersands");
    expect(result[0].content).toContain("`code`");
    expect(result[0].content).toContain('const x: string = "hello";');
  });

  it("respects priority: role-local beats global (no built-in)", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(roleDir, "functions", "priority", "---\nname: priority\n---\n\nRole");
    mkFuncFile(globalDir, "", "priority", "---\nname: priority\n---\n\nGlobal");

    const result = await resolveFunctions(
      ["priority"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("role-local");
    expect(result[0].content).toBe("\nRole");
  });

  it("skips non-existent role-local and falls back to global", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    mkFuncFile(globalDir, "", "fallthrough", "---\nname: ft\n---\n\nGlobal fallthrough");

    const result = await resolveFunctions(
      ["fallthrough"],
      roleDir,
      globalDir,
      builtinDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("global");
    expect(result[0].content).toBe("\nGlobal fallthrough");
  });

  it("gracefully handles empty name array", async () => {
    const roleDir = tmpDir();
    const globalDir = tmpDir();
    const builtinDir = tmpDir();

    const result = await resolveFunctions([], roleDir, globalDir, builtinDir);

    expect(result).toEqual([]);
  });
});

describe("loadFunctionContent", () => {
  it("returns metadata and body content", async () => {
    const roleDir = tmpDir();

    const fullContent = "---\nname: test-func\ndescription: Test desc\n---\n\n# Heading\n\nBody here.";
    const filePath = mkFuncFile(roleDir, "functions", "test-func", fullContent);

    const result = await loadFunctionContent(filePath);

    expect(result.metadata.name).toBe("test-func");
    expect(result.metadata.description).toBe("Test desc");
    expect(result.content).toContain("# Heading");
    expect(result.content).toContain("Body here.");
  });

  it("returns empty description when frontmatter lacks description", async () => {
    const roleDir = tmpDir();

    const filePath = mkFuncFile(
      roleDir,
      "functions",
      "no-desc",
      "---\nname: no-desc\n---\n\nBody",
    );

    const result = await loadFunctionContent(filePath);

    expect(result.metadata.description).toBe("");
    expect(result.content).toBe("\nBody");
  });

  it("throws when the file does not exist", async () => {
    const roleDir = tmpDir();
    const missingPath = join(roleDir, "functions", "missing.md");

    await expect(loadFunctionContent(missingPath)).rejects.toThrow(
      /Function file not found/,
    );
  });

  it("returns metadata and content for file without frontmatter", async () => {
    const roleDir = tmpDir();

    const filePath = mkFuncFile(
      roleDir,
      "functions",
      "no-fm",
      "Just plain body content.",
    );

    const result = await loadFunctionContent(filePath);

    expect(result.metadata.name).toBeUndefined();
    expect(result.metadata.description).toBe("");
    expect(result.content).toBe("Just plain body content.");
  });
});
