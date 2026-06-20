import { describe, it, expect } from "bun:test";
import type { RoleConfig, ResolvedSkill, ResolvedFunction } from "./types";
import { buildAgentPrompt, buildFunctionBlock } from "./prompt-builder";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRole(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    name: "test-role",
    description: "A test role",
    prompt: "You are a helpful assistant.",
    ...overrides,
  };
}

function makeSkill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name: "test-skill",
    description: "A test skill",
    scope: "rolebox",
    filePath: "/fake/path/SKILL.md",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAgentPrompt", () => {
  it("returns the raw prompt when no skills are provided (empty array)", () => {
    const role = makeRole({ prompt: "Be concise." });
    const result = buildAgentPrompt(role, []);
    expect(result).toBe("Be concise.");
  });

  it("returns the raw prompt when skills array is undefined / empty", () => {
    const role = makeRole({ prompt: "Just the prompt." });
    const result = buildAgentPrompt(role, []);
    expect(result).toBe("Just the prompt.");
  });

  it("includes the role prompt text when skills are present", () => {
    const role = makeRole({ prompt: "You are a coding assistant." });
    const skills = [makeSkill()];
    const result = buildAgentPrompt(role, skills);
    expect(result).toContain("You are a coding assistant.");
  });

  it("appends <available_skills> block when skills are non-empty", () => {
    const role = makeRole();
    const skills = [makeSkill()];
    const result = buildAgentPrompt(role, skills);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
  });

  it("includes skill name, description, and scope in the XML block", () => {
    const role = makeRole();
    const skills = [
      makeSkill({
        name: "my-skill",
        description: "Does something useful",
        scope: "opencode",
      }),
    ];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("<name>my-skill</name>");
    expect(result).toContain("<description>Does something useful</description>");
    expect(result).toContain("<scope>opencode</scope>");
  });

  it("includes all skills when multiple are provided", () => {
    const role = makeRole();
    const skills = [
      makeSkill({ name: "skill-a", description: "First skill", scope: "rolebox" }),
      makeSkill({ name: "skill-b", description: "Second skill", scope: "opencode" }),
      makeSkill({ name: "skill-c", description: "Third skill", scope: "rolebox" }),
    ];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("skill-a");
    expect(result).toContain("skill-b");
    expect(result).toContain("skill-c");
    expect(result).toContain("First skill");
    expect(result).toContain("Second skill");
    expect(result).toContain("Third skill");
  });

  it("each skill block has the correct XML structure", () => {
    const role = makeRole();
    const skills = [
      makeSkill({
        name: "alpha",
        description: "Alpha description",
        scope: "rolebox",
      }),
    ];
    const result = buildAgentPrompt(role, skills);

    const block = `<skill>
    <name>alpha</name>
    <description>Alpha description</description>
    <scope>rolebox</scope>
  </skill>`;
    expect(result).toContain(block);
  });

  it("handles multiline prompts correctly", () => {
    const multiline = "Line one.\nLine two.\nLine three.";
    const role = makeRole({ prompt: multiline });
    const skills = [makeSkill({ name: "multi-skill" })];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("Line one.\nLine two.\nLine three.");
    expect(result).toContain("<name>multi-skill</name>");
  });

  it("handles prompts with special characters", () => {
    const prompt = 'Use "quotes" and <angle> & brackets.';
    const role = makeRole({ prompt });
    const skills = [makeSkill()];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain('Use "quotes" and <angle> & brackets.');
    expect(result).toContain("<available_skills>");
  });

  it("contains the static instruction text in <available_skills> block", () => {
    const role = makeRole();
    const skills = [makeSkill()];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain(
      "Skills provide specialized instructions. Use the skill tool to load when task matches.",
    );
  });
});

// ---------------------------------------------------------------------------
// buildFunctionBlock helpers
// ---------------------------------------------------------------------------

function makeFunction(overrides: Partial<ResolvedFunction> = {}): ResolvedFunction {
  return {
    name: "plan",
    description: "Planning capability",
    content: "Plan carefully and methodically.",
    filePath: "/fake/path/plan.md",
    source: "global",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildFunctionBlock tests
// ---------------------------------------------------------------------------

describe("buildFunctionBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildFunctionBlock([])).toBe("");
  });

  it("generates active_functions XML with one function", () => {
    const result = buildFunctionBlock([makeFunction()]);
    expect(result).toContain("<active_functions>");
    expect(result).toContain("<name>plan</name>");
    expect(result).toContain("<description>Planning capability</description>");
    expect(result).toContain("<![CDATA[");
    expect(result).toContain("Plan carefully and methodically.");
    expect(result).toContain("]]>");
    expect(result).toContain("</active_functions>");
  });

  it("wraps content with special characters in CDATA", () => {
    const fn = makeFunction({
      content: "Use <script> and & stuff",
    });
    const result = buildFunctionBlock([fn]);
    expect(result).toContain("<![CDATA[");
    expect(result).toContain("Use <script> and & stuff");
    expect(result).toContain("]]>");
  });

  it("includes multiple functions", () => {
    const functions = [
      makeFunction({ name: "plan", description: "Plan things", content: "Plan content" }),
      makeFunction({ name: "execute", description: "Execute things", content: "Execute content" }),
    ];
    const result = buildFunctionBlock(functions);
    expect(result).toContain("<name>plan</name>");
    expect(result).toContain("<name>execute</name>");
    expect(result).toContain("Plan content");
    expect(result).toContain("Execute content");
  });
});
