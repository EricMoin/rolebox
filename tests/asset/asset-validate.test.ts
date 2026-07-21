import { describe, it, expect } from "bun:test";
import type { ResolvedRole } from "../../src/types.ts";
import { ReferenceScope, FunctionSource } from "../../src/constants.ts";
import { createAssetValidateTool } from "../../src/asset/asset-validate.ts";

function makeMinimalRole(overrides: Record<string, any> = {}): ResolvedRole {
  return {
    id: "test-role",
    config: {
      name: "Test Role",
      description: "A minimal test role",
      prompt: "You are a test.",
    },
    prompt: "You are a test.",
    skills: [],
    functions: [],
    references: [],
    subagents: [],
    ...overrides,
  } as unknown as ResolvedRole;
}

function buildFn(name: string, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name,
    description: `The ${name} function`,
    content: `export function ${name}() {}`,
    filePath: `/roles/test/functions/${name}.ts`,
    source: FunctionSource.RoleLocal,
    ...overrides,
  };
}

describe("asset-validate — reference path resilience", () => {
  it("survives an unreadable/invalid reference path without crashing", async () => {
    const role = makeMinimalRole({
      references: [
        {
          name: "unreadable-ref",
          filePath: "/tmp/\0nonexistent",
          description: "A reference at a null-byte path that throws on exists()",
          scope: ReferenceScope.Role,
          relativePath: "references/\0nonexistent",
        },
        {
          name: "missing-ref",
          filePath: "/tmp/definitely-does-not-exist-12345",
          description: "A reference that cleanly does not exist",
          scope: ReferenceScope.Role,
          relativePath: "references/missing.md",
        },
      ],
    });

    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;

    expect(typeof result).toBe("string");
    expect(result).toContain("unreadable-ref");
    expect(result).toContain("warning");
    expect(result).toContain("could not be verified");
    expect(result).toContain("missing-ref");
    expect(result).toContain("error");
    expect(result).toContain("file not found");
  });

  it("returns clean validation for roles with valid references", async () => {
    const role = makeMinimalRole({ references: [] });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("All assets are valid");
  });
});

describe("asset-validate — missing dependencies", () => {
  it("detects requires referencing a nonexistent function", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("my-fn", { requires: ["missing-dep"] })],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("missing-dep");
    expect(result).toContain("requires nonexistent function");
    expect(result).toContain("error");
  });

  it("passes when requires references an existing function", async () => {
    const role = makeMinimalRole({
      functions: [
        buildFn("base-fn"),
        buildFn("dependent-fn", { requires: ["base-fn"] }),
      ],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).not.toContain("requires nonexistent function");
  });

  it("passes when function has no requires field", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("standalone-fn")],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("All assets are valid");
  });

  it("detects multiple missing dependencies", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("my-fn", { requires: ["missing-a", "missing-b", "missing-c"] })],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("missing-a");
    expect(result).toContain("missing-b");
    expect(result).toContain("missing-c");
  });

  it("validates dependencies in subagent functions", async () => {
    const role = makeMinimalRole({
      subagents: [{
        id: "child",
        config: { name: "Child", description: "A child", prompt: "I am child." },
        prompt: "I am child.",
        skills: [],
        functions: [buildFn("sub-fn", { requires: ["nonexistent-in-parent"] })],
        references: [],
        subagents: [],
        parentId: "test-role",
        inheritedFrom: {},
      }],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("nonexistent-in-parent");
    expect(result).toContain("requires nonexistent function");
  });
});

describe("asset-validate — broken reference paths", () => {
  it("detects reference filePath pointing to nonexistent file", async () => {
    const role = makeMinimalRole({
      references: [{
        name: "broken-ref",
        filePath: "/tmp/definitely-missing-file-98765.md",
        description: "A reference to a file that does not exist",
        scope: ReferenceScope.Role,
        relativePath: "references/missing.md",
      }],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("broken-ref");
    expect(result).toContain("file not found");
    expect(result).toContain("error");
  });

  it("skips references with empty filePath", async () => {
    const role = makeMinimalRole({
      references: [{
        name: "empty-path-ref",
        filePath: "",
        description: "Reference without a path",
        scope: ReferenceScope.Role,
        relativePath: "",
      }],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("All assets are valid");
  });
});

describe("asset-validate — unknown transition conditions", () => {
  it("detects unknown condition names in transitions", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("my-fn", {
        transitions: [{ when: { all: ["bogus_condition_xyz()", "user_approval()"] } }],
      })],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("unknown condition");
    expect(result).toContain("bogus_condition_xyz");
    expect(result).toContain("warning");
  });

  it("passes when all transition conditions are known", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("my-fn", {
        transitions: [{ when: "user_approval()", activate: ["next-fn"], deactivate: [] }],
      })],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).not.toContain("unknown condition");
  });

  it("passes when function has no transitions", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("simple-fn")],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("All assets are valid");
  });

  it("detects unknown conditions in subagent transitions", async () => {
    const role = makeMinimalRole({
      subagents: [{
        id: "sub1",
        config: { name: "Sub1", description: "A subagent", prompt: "I am sub." },
        prompt: "I am sub.",
        skills: [],
        functions: [buildFn("sub-fn", {
          transitions: [{ when: "not_a_real_condition()" }],
        })],
        references: [],
        subagents: [],
        parentId: "test-role",
        inheritedFrom: {},
      }],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("unknown condition");
    expect(result).toContain("not_a_real_condition");
  });

  it("handles nested compound conditions (all/any/not)", async () => {
    const role = makeMinimalRole({
      functions: [buildFn("complex-fn", {
        transitions: [{
          when: {
            all: [
              { any: ["user_approval()", "fake_cond_a()"] },
              { not: "fake_cond_b()" },
            ],
          },
        }],
      })],
    });
    const tool = createAssetValidateTool([role]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toContain("fake_cond_a");
    expect(result).toContain("fake_cond_b");
  });
});

describe("asset-validate — empty / edge cases", () => {
  it("handles empty roles array", async () => {
    const tool = createAssetValidateTool([]);
    const result: string = await tool.execute({ fix: false }) as any;
    expect(result).toBe("No roles loaded. Cannot validate assets.");
  });

  // Note: role_id filtering has a known behavior where checkRoleFunctions
  // is called for ALL roles regardless of filter (only subagent checks are filtered).
  // This test documents the current behavior.
  it("role_id filter scopes validation (subagent-level only)", async () => {
    const roleA = makeMinimalRole({ id: "role-a", functions: [buildFn("fn-a", { requires: ["missing-a"] })] }) as ResolvedRole;
    const roleB = makeMinimalRole({ id: "role-b", functions: [buildFn("fn-b", { requires: ["missing-b"] })] }) as ResolvedRole;
    const tool = createAssetValidateTool([roleA, roleB]);

    const result: string = await tool.execute({ fix: false, role_id: "role-a" }) as any;

    // role-a's issues are always included
    expect(result).toContain("missing-a");
    // role-b's issues are also included because checkRoleFunctions has no filter
    expect(result).toContain("missing-b");
    // But the scope header mentions role-a
    expect(result).toContain("for role `role-a`");
  });
});
