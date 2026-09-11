import { describe, it, expect } from "bun:test";
import type { ResolvedRole } from "../../src/types.ts";
import { ReferenceScope, SkillScope, FunctionSource } from "../../src/constants.ts";
import { createAssetInspectTool } from "../../src/asset/asset-inspect.ts";

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

function buildFn(name: string): Record<string, any> {
  return {
    name,
    description: `The ${name} function`,
    content: `export function ${name}() {}`,
    filePath: `/roles/test/functions/${name}.ts`,
    source: FunctionSource.RoleLocal,
    params: { input: "string" },
    phase: "execute",
    priority: 10,
    requires: [],
    produces: "output",
    consumes: "input",
    gate: "session_active()",
    continue_until: "todos_complete()",
    requires_evidence: ["lsp_diagnostics"],
    observe: [],
    transitions: [],
  };
}

function buildSkill(name: string): Record<string, any> {
  return {
    name,
    description: `The ${name} skill`,
    scope: SkillScope.Rolebox,
    filePath: `/roles/test/skills/${name}.md`,
    references: [],
  };
}

function buildRef(name: string, filePath: string): Record<string, any> {
  return {
    name,
    filePath,
    description: `Reference: ${name}`,
    scope: ReferenceScope.Role,
    relativePath: `references/${name}.md`,
  };
}

describe("asset-inspect", () => {
  describe("exact name matching", () => {
    it("finds a function by exact name at role level", async () => {
      const role = makeRole("test-role", { functions: [buildFn("do-something")] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "do-something", type: "function" }) as any;
      expect(result).toContain("## Function: do-something");
      expect(result).toContain("**Owner**: `test-role`");
      expect(result).toContain("The do-something function");
    });

    it("finds a skill by exact name at role level", async () => {
      const role = makeRole("test-role", { skills: [buildSkill("my-skill")] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "my-skill", type: "skill" }) as any;
      expect(result).toContain("## Skill: my-skill");
      expect(result).toContain("**Owner**: `test-role`");
    });

    it("finds a reference by exact name at role level", async () => {
      const role = makeRole("test-role", { references: [buildRef("my-ref", "/docs/ref.md")] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "my-ref", type: "reference" }) as any;
      expect(result).toContain("## Reference: my-ref");
      expect(result).toContain("Reference: my-ref");
    });

    it("finds assets in subagents with owner path", async () => {
      const role = makeRole("parent", {
        subagents: [{
          id: "child",
          config: { name: "Child", description: "A child subagent", prompt: "I am child." },
          prompt: "I am child.",
          skills: [buildSkill("sub-skill")],
          functions: [buildFn("sub-fn")],
          references: [buildRef("sub-ref", "/docs/sub.md")],
          subagents: [],
          parentId: "parent",
          inheritedFrom: {},
        }],
      });
      const tool = createAssetInspectTool([role]);
      const fnResult: string = await tool.execute({ name: "sub-fn", type: "function" }) as any;
      expect(fnResult).toContain("`parent/child`");
      const skillResult: string = await tool.execute({ name: "sub-skill", type: "skill" }) as any;
      expect(skillResult).toContain("`parent/child`");
      const refResult: string = await tool.execute({ name: "sub-ref", type: "reference" }) as any;
      expect(refResult).toContain("`parent/child`");
    });
  });

  describe("type filtering", () => {
    it("distinguishes function vs skill with same name", async () => {
      const role = makeRole("test-role", {
        functions: [buildFn("data-helper")],
        skills: [buildSkill("data-helper")],
      });
      const tool = createAssetInspectTool([role]);
      const fnResult: string = await tool.execute({ name: "data-helper", type: "function" }) as any;
      expect(fnResult).toContain("## Function:");
      const skillResult: string = await tool.execute({ name: "data-helper", type: "skill" }) as any;
      expect(skillResult).toContain("## Skill:");
    });

    it("returns not-found when type does not match", async () => {
      const role = makeRole("test-role", { functions: [buildFn("only-fn")] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "only-fn", type: "skill" }) as any;
      expect(result).toBe('Asset not found: no skill named "only-fn" exists in any loaded role or sub-agent.');
    });
  });

  describe("error scenarios", () => {
    it("returns clear message when no roles are loaded", async () => {
      const tool = createAssetInspectTool([]);
      const result: string = await tool.execute({ name: "anything", type: "function" }) as any;
      expect(result).toBe("No roles loaded. Cannot inspect assets.");
    });

    it("returns not-found message for nonexistent asset name", async () => {
      const role = makeRole("test-role");
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "does-not-exist", type: "function" }) as any;
      expect(result).toBe('Asset not found: no function named "does-not-exist" exists in any loaded role or sub-agent.');
    });

    it("searches across multiple roles", async () => {
      const roleA = makeRole("alpha", { functions: [buildFn("fn-a")] });
      const roleB = makeRole("beta", { functions: [buildFn("fn-b")] });
      const tool = createAssetInspectTool([roleA, roleB]);
      const resultA: string = await tool.execute({ name: "fn-a", type: "function" }) as any;
      expect(resultA).toContain("`alpha`");
      const resultB: string = await tool.execute({ name: "fn-b", type: "function" }) as any;
      expect(resultB).toContain("`beta`");
    });

    it("prefers deepest match (subagent before role)", async () => {
      const role = makeRole("parent", {
        functions: [buildFn("deep-fn")],
        subagents: [{
          id: "child",
          config: { name: "Child", description: "A child subagent", prompt: "I am child." },
          prompt: "I am child.",
          skills: [],
          functions: [buildFn("deep-fn")],
          references: [],
          subagents: [],
          parentId: "parent",
          inheritedFrom: {},
        }],
      });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "deep-fn", type: "function" }) as any;
      expect(result).toContain("`parent/child`");
    });
  });

  describe("optional field rendering", () => {
    it("renders parameters section when fn has params", async () => {
      const role = makeRole("test-role", { functions: [buildFn("with-params")] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "with-params", type: "function" }) as any;
      expect(result).toContain("### Parameters");
    });

    it("renders requires section when fn has dependencies", async () => {
      const fn = buildFn("dependent-fn");
      fn.requires = ["base-fn", "helper-fn"];
      const role = makeRole("test-role", { functions: [fn] });
      const tool = createAssetInspectTool([role]);
      const result: string = await tool.execute({ name: "dependent-fn", type: "function" }) as any;
      expect(result).toContain("### Requires");
      expect(result).toContain("`base-fn`");
      expect(result).toContain("`helper-fn`");
    });
  });
});
