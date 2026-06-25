import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  discoverReferences,
  resolveExplicitReferences,
  resolveAllReferences,
} from "../src/reference-resolver";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "rolebox-ref-test-"));
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

describe("discoverReferences", () => {
  it("returns empty array when no references/ directory exists", async () => {
    const result = await discoverReferences(tmpDir, "role");
    expect(result).toEqual([]);
  });

  it("discovers .md files in references/ directory", async () => {
    await writeRef("references/best-practices.md", "# Best Practices\nContent here.");
    await writeRef("references/patterns.md", "# Patterns\nMore content.");

    const result = await discoverReferences(tmpDir, "role");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("best-practices");
    expect(result[1].name).toBe("patterns");
  });

  it("discovers nested .md files and preserves directory structure in name", async () => {
    await writeRef("references/theory/psychology.md", "# Psychology");
    await writeRef("references/catalogs/anti-patterns.md", "# Anti-Patterns");

    const result = await discoverReferences(tmpDir, "role");
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === "catalogs/anti-patterns")).toBeDefined();
    expect(result.find((r) => r.name === "theory/psychology")).toBeDefined();
  });

  it("extracts description from frontmatter", async () => {
    await writeRef(
      "references/core.md",
      "---\ndescription: Core design principles\n---\n# Core\nContent.",
    );

    const result = await discoverReferences(tmpDir, "role");
    expect(result[0].description).toBe("Core design principles");
  });

  it("generates fallback description from filename when no frontmatter", async () => {
    await writeRef("references/my-great-doc.md", "# No frontmatter\nJust content.");

    const result = await discoverReferences(tmpDir, "role");
    expect(result[0].description).toBe("My Great Doc");
  });

  it("ignores non-.md files", async () => {
    await writeRef("references/data.json", '{"key": "value"}');
    await writeRef("references/readme.md", "# Readme");

    const result = await discoverReferences(tmpDir, "role");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("readme");
  });

  it("sets scope correctly", async () => {
    await writeRef("references/test.md", "# Test");

    const roleResult = await discoverReferences(tmpDir, "role");
    expect(roleResult[0].scope).toBe("role");

    const skillResult = await discoverReferences(tmpDir, "skill");
    expect(skillResult[0].scope).toBe("skill");
  });

  it("sets relativePath relative to baseDir", async () => {
    await writeRef("references/theory/visual.md", "# Visual");

    const result = await discoverReferences(tmpDir, "role");
    expect(result[0].relativePath).toBe("references/theory/visual.md");
  });
});

describe("resolveExplicitReferences", () => {
  it("resolves a simple path string declaration", async () => {
    await writeRef("references/api.md", "---\ndescription: API docs\n---\n# API");

    const result = await resolveExplicitReferences(
      { "api-docs": "references/api.md" },
      tmpDir,
      "role",
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("api-docs");
    expect(result[0].description).toBe("API docs");
  });

  it("resolves an object declaration with explicit description", async () => {
    await writeRef("references/api.md", "# API\nNo frontmatter.");

    const result = await resolveExplicitReferences(
      { "api-docs": { path: "references/api.md", description: "Custom description" } },
      tmpDir,
      "role",
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("api-docs");
    expect(result[0].description).toBe("Custom description");
  });

  it("skips non-existent files with a warning", async () => {
    const result = await resolveExplicitReferences(
      { "missing": "references/does-not-exist.md" },
      tmpDir,
      "role",
    );

    expect(result).toHaveLength(0);
  });

  it("uses frontmatter description when no explicit description provided", async () => {
    await writeRef(
      "docs/guide.md",
      "---\ndescription: The official guide\n---\n# Guide",
    );

    const result = await resolveExplicitReferences(
      { "guide": "docs/guide.md" },
      tmpDir,
      "role",
    );

    expect(result[0].description).toBe("The official guide");
  });

  it("falls back to name-derived description when no frontmatter and no explicit", async () => {
    await writeRef("docs/my-doc.md", "# Just content");

    const result = await resolveExplicitReferences(
      { "my-doc": "docs/my-doc.md" },
      tmpDir,
      "role",
    );

    expect(result[0].description).toBe("My Doc");
  });
});

describe("resolveAllReferences", () => {
  it("returns only discovered refs when no explicit declarations", async () => {
    await writeRef("references/a.md", "# A");
    await writeRef("references/b.md", "# B");

    const result = await resolveAllReferences(tmpDir, "role");
    expect(result).toHaveLength(2);
  });

  it("merges discovered and explicit refs without duplicates", async () => {
    await writeRef(
      "references/core.md",
      "---\ndescription: Auto-discovered\n---\n# Core",
    );

    const result = await resolveAllReferences(tmpDir, "role", {
      "core-override": { path: "references/core.md", description: "Explicit override" },
    });

    // Same file, so deduplicated — explicit wins
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Explicit override");
    expect(result[0].name).toBe("core-override");
  });

  it("includes explicit refs that point outside references/ directory", async () => {
    await writeRef("references/inside.md", "# Inside");
    await writeRef("docs/outside.md", "# Outside");

    const result = await resolveAllReferences(tmpDir, "role", {
      "outside": "docs/outside.md",
    });

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === "outside")).toBeDefined();
  });

  it("returns sorted by name", async () => {
    await writeRef("references/z-last.md", "# Z");
    await writeRef("references/a-first.md", "# A");
    await writeRef("references/m-middle.md", "# M");

    const result = await resolveAllReferences(tmpDir, "role");
    expect(result.map((r) => r.name)).toEqual(["a-first", "m-middle", "z-last"]);
  });
});
