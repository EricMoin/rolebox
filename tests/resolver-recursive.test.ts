import { describe, it, expect } from "bun:test";
import { resolveAllRoles, type ResolveContext } from "../src/resolver/orchestrator.ts";
import type { RoleConfig, ResolvedFunction, ResolvedGraph } from "../src/types.ts";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp-resolver-recursive");

function setup(): { ctx: ResolveContext; roleMap: Map<string, RoleConfig>; cleanup: () => void } {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const ctx: ResolveContext = {
    roleboxDir: TEST_DIR,
    globalSkillsDir: TEST_DIR,
    configDir: TEST_DIR,
    builtinDir: TEST_DIR,
    roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
    roleGraphMap: new Map<string, ResolvedGraph>(),
  };

  // Build a role with nested subagents: emperor -> chancellor -> [drafter, reviewer, finalizer]
  const emperor: RoleConfig = {
    name: "Emperor",
    description: "Orchestrator role",
    prompt: "You are the Emperor.",
    subagents: [
      {
        name: "Chancellor",
        description: "Strategic planner",
        prompt: "You are the Chancellor.",
        subagents: [
          {
            name: "Drafter",
            description: "Writes first draft",
            prompt: "You are the Drafter.",
          },
          {
            name: "Reviewer",
            description: "Reviews output",
            prompt: "You are the Reviewer.",
          },
          {
            name: "Finalizer",
            description: "Finalizes work",
            prompt: "You are the Finalizer.",
          },
        ],
      },
    ],
  };

  const roleMap = new Map<string, RoleConfig>();
  roleMap.set("emperor", emperor);

  return { ctx, roleMap, cleanup: () => rmSync(TEST_DIR, { recursive: true }) };
}

describe("Recursive subagent resolution", () => {
  it("resolves nested subagents with hierarchical IDs", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved.length).toBe(1);

      const emperor = resolved[0];
      expect(emperor.id).toBe("emperor");
      expect(emperor.subagents.length).toBe(1);

      const chancellor = emperor.subagents[0];
      expect(chancellor.id).toBe("emperor--chancellor");
      expect(chancellor.parentId).toBe("emperor");
      expect(chancellor.subagents.length).toBe(3);

      const childIds = chancellor.subagents.map(s => s.id).sort();
      expect(childIds).toEqual([
        "emperor--chancellor--drafter",
        "emperor--chancellor--finalizer",
        "emperor--chancellor--reviewer",
      ]);

      for (const child of chancellor.subagents) {
        expect(child.parentId).toBe("emperor--chancellor");
        expect(child.subagents.length).toBe(0);
      }
    } finally {
      cleanup();
    }
  });

  it("includes child metadata in parent subagent prompt", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const chancellor = resolved[0].subagents[0];
      expect(chancellor.prompt).toContain("available_subagents");
      expect(chancellor.prompt).toContain("emperor--chancellor--drafter");
      expect(chancellor.prompt).toContain("emperor--chancellor--reviewer");
      expect(chancellor.prompt).toContain("emperor--chancellor--finalizer");
      expect(chancellor.prompt).toContain("Drafter");
      expect(chancellor.prompt).toContain("Reviewer");
      expect(chancellor.prompt).toContain("Finalizer");
    } finally {
      cleanup();
    }
  });

  it("registers functions for nested subagent IDs", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      await resolveAllRoles(roleMap, ctx);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--drafter")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--reviewer")).toBe(true);
      expect(ctx.roleFunctionsMap.has("emperor--chancellor--finalizer")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("still resolves roles without subagents", async () => {
    const { ctx, roleMap, cleanup } = setup();
    // Add a flat role without subagents
    roleMap.set("simple-role", {
      name: "Simple Role",
      description: "A plain role",
      prompt: "You are a simple role.",
    });

    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      expect(resolved.length).toBe(2);
      const simple = resolved.find(r => r.id === "simple-role")!;
      expect(simple.subagents.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("does not modify top-level prompt for nested grandchildren", async () => {
    const { ctx, roleMap, cleanup } = setup();
    try {
      const resolved = await resolveAllRoles(roleMap, ctx);
      const emperor = resolved[0];
      expect(emperor.prompt).toContain("Chancellor");
      expect(emperor.prompt).toContain("emperor--chancellor");
      expect(emperor.prompt).not.toContain("emperor--chancellor--drafter");
    } finally {
      cleanup();
    }
  });
});
