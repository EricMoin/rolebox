import { describe, it, expect } from "bun:test";
import type { ResolvedRole } from "../../src/types.ts";
import { ReferenceScope } from "../../src/constants.ts";
import { createAssetValidateTool } from "../../src/asset/asset-validate.ts";

function makeMinimalRole(overrides: Partial<ResolvedRole>): ResolvedRole {
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
    const result = await tool.execute({ fix: false });

    // Must not crash — result is a string
    expect(typeof result).toBe("string");

    // The invalid-path reference should produce a warning (not crash)
    expect(result).toContain("unreadable-ref");
    expect(result).toContain("warning");
    expect(result).toContain("could not be verified");

    // The cleanly-missing reference should still produce an error
    expect(result).toContain("missing-ref");
    expect(result).toContain("error");
    expect(result).toContain("file not found");
  });

  it("returns clean validation for roles with valid references", async () => {
    const role = makeMinimalRole({
      references: [],
    });

    const tool = createAssetValidateTool([role]);
    const result = await tool.execute({ fix: false });

    expect(result).toContain("All assets are valid");
  });
});
