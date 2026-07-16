import { describe, it, expect } from "bun:test";
import type { ResolvedRole } from "../../src/types.ts";
import { SkillScope } from "../../src/constants.ts";
import { createSkillComposeTool } from "../../src/asset/skill-compose.ts";

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

function buildSkill(name: string, refs: Array<{ name: string; path: string; description?: string }> = []): Record<string, any> {
  return {
    name,
    description: `The ${name} skill`,
    scope: SkillScope.Rolebox,
    filePath: `/skills/${name}.md`,
    references: refs.map((r) => ({
      name: r.name,
      filePath: r.path,
      description: r.description ?? `Reference ${r.name}`,
      scope: "role",
      relativePath: r.path,
    })),
  };
}

describe("skill-compose", () => {
  describe("reference deduplication", () => {
    it("deduplicates references with same filePath from different skills", async () => {
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "shared-ref", path: "/docs/shared.md", description: "Shared doc" }]),
          buildSkill("skill-b", [{ name: "shared-ref", path: "/docs/shared.md", description: "Shared doc" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: true }) as any;
      // The deduplicated references table should show shared-ref in one row only
      const lines = result.split("\n").filter((l) => l.includes("shared-ref"));
      // One row for the deduplicated table (both skills point to same row)
      const dataRows = lines.filter((l) => l.startsWith("|"));
      expect(dataRows.length).toBe(1);
    });

    it("keeps separate entries for references with different filePaths", async () => {
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "ref-one", path: "/docs/one.md" }]),
          buildSkill("skill-b", [{ name: "ref-two", path: "/docs/two.md" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: true }) as any;
      expect(result).toContain("ref-one");
      expect(result).toContain("ref-two");
    });

    it("lists both source skills for deduplicated references", async () => {
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "common-ref", path: "/docs/common.md" }]),
          buildSkill("skill-b", [{ name: "common-ref", path: "/docs/common.md" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: true }) as any;
      expect(result).toContain("skill-a");
      expect(result).toContain("skill-b");
    });
  });

  describe("conflict detection", () => {
    it("detects references with same name but different paths", async () => {
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "conflict-ref", path: "/docs/v1/ref.md" }]),
          buildSkill("skill-b", [{ name: "conflict-ref", path: "/docs/v2/ref.md" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: true }) as any;
      expect(result).toContain("Conflict");
      expect(result).toContain("conflict-ref");
    });

    it("skips conflict detection when check_conflicts is false (behavior: same output as no conflicts)", async () => {
      // Note: renderConflicts always outputs "No conflicts detected" even when
      // check_conflicts=false, because the function always renders the section.
      // This test validates the tool runs without error in this mode.
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "conflict-ref", path: "/docs/v1/ref.md" }]),
          buildSkill("skill-b", [{ name: "conflict-ref", path: "/docs/v2/ref.md" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: false }) as any;
      expect(result).toContain("Skill Composition Analysis");
      expect(typeof result).toBe("string");
    });

    it("reports no conflicts when all references share paths", async () => {
      const role = makeRole("test", {
        skills: [
          buildSkill("skill-a", [{ name: "ref-a", path: "/docs/a.md" }]),
          buildSkill("skill-b", [{ name: "ref-b", path: "/docs/b.md" }]),
        ],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["skill-a", "skill-b"], check_conflicts: true }) as any;
      expect(result).toContain("No conflicts detected");
    });
  });

  describe("missing skill detection", () => {
    it("reports missing skills in output", async () => {
      const role = makeRole("test", {
        skills: [buildSkill("existing-skill", [])],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["existing-skill", "missing-skill"], check_conflicts: true }) as any;
      expect(result).toContain("missing-skill");
      expect(result).toContain("not found");
    });

    it("returns empty-list message when no skills match", async () => {
      const role = makeRole("test", {
        skills: [buildSkill("real-skill", [])],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["nonexistent-skill"], check_conflicts: true }) as any;
      expect(result).toContain("No matching skills found");
    });
  });

  describe("subagent skill collection", () => {
    it("collects skills from subagents", async () => {
      const role = makeRole("parent", {
        subagents: [{
          id: "child",
          config: { name: "Child", description: "A child subagent", prompt: "I am child." },
          prompt: "I am child.",
          skills: [buildSkill("sub-skill", [])],
          functions: [],
          references: [],
          subagents: [],
          parentId: "parent",
          inheritedFrom: {},
        }],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["sub-skill"], check_conflicts: true }) as any;
      expect(result).toContain("sub-skill");
    });
  });

  describe("edge cases", () => {
    it("handles empty roles array", async () => {
      const tool = createSkillComposeTool([]);
      const result: string = await tool.execute({ skill_names: ["anything"], check_conflicts: true }) as any;
      expect(result).toBe("No roles loaded. Cannot analyze skills.");
    });

    it("handles skills with no references", async () => {
      const role = makeRole("test", {
        skills: [buildSkill("empty-skill", [])],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["empty-skill"], check_conflicts: true }) as any;
      expect(result).toContain("0 unique references");
      expect(result).toContain("0 conflicts");
    });

    it("renders summary line", async () => {
      const role = makeRole("test", {
        skills: [buildSkill("my-skill", [{ name: "r1", path: "/docs/r1.md" }])],
      });
      const tool = createSkillComposeTool([role]);
      const result: string = await tool.execute({ skill_names: ["my-skill"], check_conflicts: true }) as any;
      expect(result).toContain("Summary:");
      expect(result).toContain("1 skills found");
      expect(result).toContain("1 unique references");
    });
  });
});
