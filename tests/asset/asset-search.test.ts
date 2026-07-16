import { describe, it, expect } from "bun:test";
import type { ResolvedRole } from "../../src/types.ts";
import { SkillScope, FunctionSource } from "../../src/constants.ts";
import { createAssetSearchTool } from "../../src/asset/asset-search.ts";

function makeRole(id: string, overrides: Record<string, any> = {}): ResolvedRole {
  return {
    id,
    config: { name: id, description: `Role ${id}`, prompt: "You are a test role." },
    prompt: "You are a test role.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  } as unknown as ResolvedRole;
}

function buildFn(name: string, desc: string, phase?: string): Record<string, any> {
  return {
    name,
    description: desc,
    content: `export function ${name}() {}`,
    filePath: `/roles/test/functions/${name}.ts`,
    source: FunctionSource.RoleLocal,
    phase,
  };
}

function buildSkill(name: string, desc: string): Record<string, any> {
  return {
    name,
    description: desc,
    scope: SkillScope.Rolebox,
    filePath: `/roles/test/skills/${name}.md`,
    references: [],
  };
}

function buildRef(name: string, desc: string): Record<string, any> {
  return {
    name,
    filePath: `/docs/${name}.md`,
    description: desc,
    scope: "role",
    relativePath: `references/${name}.md`,
  };
}

describe("asset-search", () => {
  describe("keyword matching", () => {
    it("finds assets by keyword in name", async () => {
      const role = makeRole("test", { functions: [buildFn("deploy-app", "Deploy to production")] });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "deploy", type: "all", limit: 20 }) as any;
      expect(result).toContain("deploy-app");
      expect(result).toContain("Found 1 matching asset");
    });

    it("finds assets by keyword in description", async () => {
      const role = makeRole("test", { functions: [buildFn("build", "Compile and package the app")] });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "compile", type: "all", limit: 20 }) as any;
      expect(result).toContain("build");
    });

    it("uses AND logic — all keywords must match", async () => {
      const role = makeRole("test", {
        functions: [
          buildFn("deploy-app", "Deploy the application"),
          buildFn("build-app", "Build the application"),
          buildFn("test-runner", "Run tests"),
        ],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "deploy application", type: "all", limit: 20 }) as any;
      expect(result).toContain("deploy-app");
      expect(result).not.toContain("build-app");
      expect(result).not.toContain("test-runner");
    });

    it("returns empty message when no assets match", async () => {
      const role = makeRole("test", { functions: [buildFn("deploy", "Deploy the app")] });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "nonexistent", type: "all", limit: 20 }) as any;
      expect(result).toBe('No assets matching "nonexistent".');
    });

    it("returns empty message for empty role array", async () => {
      const tool = createAssetSearchTool([]);
      const result: string = await tool.execute({ query: "anything", type: "all", limit: 20 }) as any;
      expect(result).toBe("No assets found. Make sure roles are properly loaded.");
    });
  });

  describe("relevance sorting", () => {
    it("ranks name matches above description-only matches", async () => {
      const role = makeRole("test", {
        functions: [
          buildFn("search-index", "Rebuild the search index"),
          buildFn("notify", "Send search notifications"),
        ],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "search", type: "all", limit: 20 }) as any;
      const idxSearch = result.indexOf("search-index");
      const idxNotify = result.indexOf("notify");
      expect(idxSearch).toBeGreaterThan(-1);
      expect(idxNotify).toBeGreaterThan(-1);
      expect(idxSearch).toBeLessThan(idxNotify);
    });

    it("exact name match gets top ranking", async () => {
      const role = makeRole("test", {
        functions: [
          buildFn("build", "Build system for the project"),
          buildFn("build-image", "Build and push Docker images"),
          buildFn("setup-build", "Setup the build environment"),
        ],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "build", type: "all", limit: 20 }) as any;
      // Find the first data row with "build" — the exact match should be first
      const buildRowIndex = result.indexOf("| build |");
      const buildImageRowIndex = result.indexOf("| build-image |");
      expect(buildRowIndex).toBeGreaterThan(-1);
      expect(buildImageRowIndex).toBeGreaterThan(-1);
      expect(buildRowIndex).toBeLessThan(buildImageRowIndex);
    });
  });

  describe("limit enforcement", () => {
    it("returns at most `limit` results", async () => {
      const role = makeRole("test", {
        functions: Array.from({ length: 10 }, (_, i) =>
          buildFn(`func-${i + 1}`, `Function number ${i + 1}`),
        ),
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "function", type: "all", limit: 3 }) as any;
      const matchCount = (result.match(/\| func-/g) || []).length;
      expect(matchCount).toBeLessThanOrEqual(3);
    });

    it("defaults to no limit truncation when limit equals total", async () => {
      const role = makeRole("test", {
        functions: Array.from({ length: 5 }, (_, i) =>
          buildFn(`func-${i + 1}`, `Function number ${i + 1}`),
        ),
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "function", type: "all", limit: 20 }) as any;
      expect(result).not.toContain("showing first");
    });

    it("shows truncated notice when limit is exceeded", async () => {
      const role = makeRole("test", {
        functions: Array.from({ length: 10 }, (_, i) =>
          buildFn(`func-${i + 1}`, `Function number ${i + 1}`),
        ),
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "function", type: "all", limit: 3 }) as any;
      expect(result).toContain("showing first 3");
    });
  });

  describe("type filter", () => {
    it("filters by function type", async () => {
      const role = makeRole("test", {
        functions: [buildFn("my-fn", "A function")],
        skills: [buildSkill("my-skill", "A skill")],
        references: [buildRef("my-ref", "A reference")],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "my", type: "function", limit: 20 }) as any;
      expect(result).toContain("my-fn");
      expect(result).not.toContain("my-skill");
    });

    it("filters by skill type", async () => {
      const role = makeRole("test", {
        functions: [buildFn("my-fn", "A function")],
        skills: [buildSkill("my-skill", "A skill")],
        references: [buildRef("my-ref", "A reference")],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "my", type: "skill", limit: 20 }) as any;
      expect(result).toContain("my-skill");
      expect(result).not.toContain("my-fn");
    });

    it("filters by reference type", async () => {
      const role = makeRole("test", {
        functions: [buildFn("my-fn", "A function")],
        skills: [buildSkill("my-skill", "A skill")],
        references: [buildRef("my-ref", "A reference")],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "my", type: "reference", limit: 20 }) as any;
      expect(result).toContain("my-ref");
      expect(result).not.toContain("my-fn");
    });
  });

  describe("subagent asset search", () => {
    it("searches assets in subagents", async () => {
      const role = makeRole("parent", {
        subagents: [{
          id: "child",
          config: { name: "Child", description: "A child subagent", prompt: "I am child." },
          prompt: "I am child.",
          skills: [],
          functions: [buildFn("child-fn", "Child function")],
          references: [],
          subagents: [],
          parentId: "parent",
          inheritedFrom: {},
        }],
      });
      const tool = createAssetSearchTool([role]);
      const result: string = await tool.execute({ query: "child", type: "all", limit: 20 }) as any;
      expect(result).toContain("child-fn");
      expect(result).toContain("parent/child");
    });
  });
});
