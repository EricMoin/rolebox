import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedRole } from "../../src/types.core";
import type { ResolvedReference } from "../../src/types.core";
import { createReferenceSearchTool } from "../../src/utils/reference-search";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "ref-search-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeRef(relPath: string, content: string): Promise<string> {
  const fullPath = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  return fullPath;
}

function makeRole(
  id: string,
  refFiles: { name: string; filePath: string; description: string }[],
): ResolvedRole {
  const references: ResolvedReference[] = refFiles.map((r) => ({
    name: r.name,
    filePath: r.filePath,
    description: r.description,
    scope: "role" as const,
    relativePath: path.relative(tmpDir, r.filePath),
  }));

  return {
    id,
    config: {} as any,
    prompt: "",
    skills: [],
    functions: [],
    references,
    subagents: [],
  };
}

/** Execute tool and extract the string output */
async function execTool(
  tool: ReturnType<typeof createReferenceSearchTool>,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute(input as any, {} as any);
  return typeof result === "string" ? result : result.output;
}

describe("reference-search concurrency cap", () => {
  it("handles 22 reference files without crashing and returns correct results", async () => {
    // Create 22 reference files across 3 roles
    const files: { relPath: string; name: string; roleId: string }[] = [];

    for (let i = 0; i < 22; i++) {
      const roleId = i < 8 ? "role-a" : i < 16 ? "role-b" : "role-c";
      files.push({
        relPath: `refs/${roleId}/doc-${String(i).padStart(2, "0")}.md`,
        name: `doc-${i}`,
        roleId,
      });
    }

    for (const f of files) {
      const idx = parseInt(f.name.split("-")[1], 10);
      await writeRef(
        f.relPath,
        `# Document ${idx}\n\nThis is a common reference file.\n\nThe unique identifier is zebra-${idx}.\n\nAdditional line for context.\n`,
      );
    }

    // Build ResolvedRole objects
    const roleA = makeRole(
      "role-a",
      files
        .filter((f) => f.roleId === "role-a")
        .map((f) => ({
          name: f.name,
          filePath: path.join(tmpDir, f.relPath),
          description: `Document ${f.name}`,
        })),
    );
    const roleB = makeRole(
      "role-b",
      files
        .filter((f) => f.roleId === "role-b")
        .map((f) => ({
          name: f.name,
          filePath: path.join(tmpDir, f.relPath),
          description: `Document ${f.name}`,
        })),
    );
    const roleC = makeRole(
      "role-c",
      files
        .filter((f) => f.roleId === "role-c")
        .map((f) => ({
          name: f.name,
          filePath: path.join(tmpDir, f.relPath),
          description: `Document ${f.name}`,
        })),
    );

    const tool = createReferenceSearchTool([roleA, roleB, roleC]);

    // --- Test 1: search for "common" — matches in all 22 files ---
    const result1 = await execTool(tool, {
      query: "common",
      case_sensitive: false,
      limit: 50,
      context_lines: 1,
    });

    expect(result1).toContain("Found");
    expect(result1).toContain("match(es)");
    expect(result1).toContain("22 file(s)");
    for (let i = 0; i < 22; i++) {
      expect(result1).toContain(`doc-${i}`);
    }

    // --- Test 2: search for a unique zebra token — exactly one match ---
    const result2 = await execTool(tool, {
      query: "zebra-5",
      case_sensitive: false,
      limit: 10,
      context_lines: 1,
    });
    expect(result2).toContain("Found 1 match(es)");
    expect(result2).toContain("zebra-5");

    // --- Test 3: case-sensitive search ---
    const result3 = await execTool(tool, {
      query: "COMMON",
      case_sensitive: true,
      limit: 10,
      context_lines: 1,
    });
    expect(result3).toContain('No matches for "COMMON"');

    // --- Test 4: search with role_id filter ---
    const result4 = await execTool(tool, {
      query: "common",
      case_sensitive: false,
      limit: 50,
      context_lines: 0,
      role_id: "role-a",
    });
    expect(result4).toContain("role-a");
    expect(result4).not.toContain("role-b");
    expect(result4).not.toContain("role-c");
  });

  it("handles 0 reference files gracefully", async () => {
    const tool = createReferenceSearchTool([]);
    const output = await execTool(tool, {
      query: "anything",
      case_sensitive: false,
      limit: 10,
    });
    expect(output).toContain("No reference documents found");
  });

  it("preserves result ordering by filePath then lineNumber", async () => {
    const fileB = await writeRef(
      "file-b.md",
      "alpha\nbeta\ncharlie\n",
    );
    const fileA = await writeRef(
      "file-a.md",
      "alpha\nbeta\ncharlie\ndelta\n",
    );

    const role = makeRole("test-role", [
      { name: "file-b", filePath: fileB, description: "File B" },
      { name: "file-a", filePath: fileA, description: "File A" },
    ]);

    const tool = createReferenceSearchTool([role]);
    const output = await execTool(tool, {
      query: "alpha",
      case_sensitive: false,
      limit: 10,
      context_lines: 0,
    });

    // file-a.md sorts before file-b.md lexicographically
    const fileAIndex = output.indexOf("file-a.md");
    const fileBIndex = output.indexOf("file-b.md");
    expect(fileAIndex).toBeGreaterThan(0);
    expect(fileBIndex).toBeGreaterThan(0);
    expect(fileAIndex).toBeLessThan(fileBIndex);
  });
});
