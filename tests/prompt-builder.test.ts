import { describe, it, expect } from "bun:test";
import type { RoleConfig, ResolvedSkill, ResolvedFunction, ResolvedReference, ResolvedGraph } from "../src/types";
import { ReferenceScope } from "../src/constants";
import { buildAgentPrompt, buildFunctionBlock, buildPublicAgentsBlock, buildReferenceBlock, buildSkillBlock, buildSubagentBlock, escapeXml } from "../src/prompt/builder";

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
    references: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`<div class="a" & 'b'>`)).toBe(
      "&lt;div class=&quot;a&quot; &amp; &apos;b&apos;&gt;",
    );
  });

  it("returns plain text unchanged", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeXml("")).toBe("");
  });
});

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
    <location>/fake/path/SKILL.md</location>
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

  it("includes <location> with the file path for a skill that has one", () => {
    const role = makeRole();
    const skills = [makeSkill({ name: "located-skill", filePath: "/skills/located/SKILL.md" })];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("<location>/skills/located/SKILL.md</location>");
  });

  it("escapes special characters in <location> file path", () => {
    const role = makeRole();
    const skills = [makeSkill({ filePath: "/skills/a&b/SKILL.md" })];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("<location>/skills/a&amp;b/SKILL.md</location>");
  });

  it("omits <location> for a skill without a filePath", () => {
    const role = makeRole();
    const skills = [makeSkill({ filePath: undefined })];
    const result = buildAgentPrompt(role, skills);

    expect(result).toContain("<name>test-skill</name>");
    expect(result).not.toContain("<location>");
  });

  it("returns raw prompt when neither skills nor subagents are provided", () => {
    const role = makeRole({ prompt: "Just the prompt." });
    const result = buildAgentPrompt(role, [], { subagents: [] });
    expect(result).toBe("Just the prompt.");
  });

  it("returns raw prompt when skills empty and subagents undefined", () => {
    const role = makeRole({ prompt: "Just the prompt." });
    const result = buildAgentPrompt(role, []);
    expect(result).toBe("Just the prompt.");
  });

  it("appends <available_subagents> block when subagents are present but skills are empty", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      subagents: [{ id: "parent--child", name: "Child", description: "Does work" }],
    });
    expect(result).toContain("<available_subagents>");
    expect(result).toContain("<id>parent--child</id>");
    expect(result).toContain("<name>Child</name>");
    expect(result).toContain("<description>Does work</description>");
    expect(result).not.toContain("<available_skills>");
  });

  it("includes both skills and subagents blocks when both are present (skills first)", () => {
    const role = makeRole();
    const skills = [makeSkill({ name: "my-skill" })];
    const result = buildAgentPrompt(role, skills, {
      subagents: [{ id: "parent--child", name: "Child", description: "Does work" }],
    });
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<available_subagents>");
    const skillsIdx = result.indexOf("<available_skills>");
    const subIdx = result.indexOf("<available_subagents>");
    expect(skillsIdx).toBeLessThan(subIdx);
  });

  it("includes static subagents instruction text", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      subagents: [{ id: "a", name: "A", description: "Agent A" }],
    });
    expect(result).toContain(
      "You can delegate tasks to these sub-agents via the graph execution engine.",
    );
    expect(result).toContain(
      'graph_add_node(',
    );
  });

  it("includes multiple subagents", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      subagents: [
        { id: "alpha", name: "Alpha", description: "First agent" },
        { id: "beta", name: "Beta", description: "Second agent" },
      ],
    });
    expect(result).toContain("<id>alpha</id>");
    expect(result).toContain("<name>Beta</name>");
  });

  it("appends <available_public_agents> block when publicAgents are present but skills are empty", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      publicAgents: [{ id: "other-role--open", name: "Open Role", description: "A public open role" }],
    });
    expect(result).toContain("<available_public_agents>");
    expect(result).toContain("</available_public_agents>");
    expect(result).toContain("<public_agent>");
    expect(result).toContain("<id>other-role--open</id>");
    expect(result).toContain("<name>Open Role</name>");
    expect(result).toContain("<description>A public open role</description>");
    expect(result).not.toContain("<available_skills>");
  });

  it("omits <available_public_agents> when publicAgents is undefined", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {});
    expect(result).not.toContain("<available_public_agents>");
  });

  it("omits <available_public_agents> when publicAgents is an empty array", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], { publicAgents: [] });
    expect(result).not.toContain("<available_public_agents>");
  });

  it("renders subagents block before publicAgents block when both are present", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      subagents: [{ id: "parent--child", name: "Child", description: "Does work" }],
      publicAgents: [{ id: "other-role--open", name: "Open Role", description: "A public open role" }],
    });
    expect(result).toContain("<available_subagents>");
    expect(result).toContain("<available_public_agents>");
    const subIdx = result.indexOf("<available_subagents>");
    const publicIdx = result.indexOf("<available_public_agents>");
    expect(subIdx).toBeLessThan(publicIdx);
  });

  it("includes static public-agents instruction text", () => {
    const role = makeRole();
    const result = buildAgentPrompt(role, [], {
      publicAgents: [{ id: "other-role--open", name: "Open Role", description: "A public open role" }],
    });
    expect(result).toContain(
      "You can dispatch tasks to these open roles of other roles via the graph execution engine.",
    );
    expect(result).toContain('agent="<open-role-id>"');
    expect(result).toContain("graph_add_node(");
  });
});

describe("Backward compatibility (roles without open-role fields)", () => {
  it("byte-identical composition with skills + subagents and no <available_public_agents>", () => {
    // A pre-feature role: no open / exports / open_roles fields, and the
    // publicAgents option is not supplied — output must be byte-identical
    // to the pre-feature prompt (raw prompt, then sections, nothing else).
    const role = makeRole({ prompt: "You are a plain role." });
    const skills = [makeSkill({ name: "core-skill", description: "Core skill", scope: "rolebox" })];
    const subagents = [{ id: "plain--worker", name: "Worker", description: "Does work" }];

    const result = buildAgentPrompt(role, skills, { subagents });

    expect(result).toBe(
      "You are a plain role.\n\n" +
        buildSkillBlock(skills) +
        "\n\n" +
        buildSubagentBlock(subagents),
    );
    expect(result).not.toContain("<available_public_agents>");
  });

  it("byte-identical composition with references + skills + subagents + graph and no <available_public_agents>", () => {
    const role = makeRole({ prompt: "Raw prompt text." });
    const skills = [makeSkill({ name: "skill-a", description: "Skill A", scope: "rolebox" })];
    const subagents = [{ id: "plain--worker", name: "Worker", description: "Does work" }];
    const references: ResolvedReference[] = [
      {
        name: "guide",
        filePath: "/refs/guide.md",
        description: "The guide",
        scope: ReferenceScope.Role,
        relativePath: "guide.md",
      },
    ];
    // Empty collaboration graph: the graph option is passed but contributes
    // no section (buildCollaborationBlock returns "" for zero nodes).
    const graph: ResolvedGraph = {
      edges: [],
      nodes: [],
      maxIterations: 5,
      exitEdges: [],
      loopGroups: [],
    };

    const result = buildAgentPrompt(role, skills, { subagents, references, graph });

    expect(result).toBe(
      "Raw prompt text.\n\n" +
        buildReferenceBlock(references) +
        "\n\n" +
        buildSkillBlock(skills) +
        "\n\n" +
        buildSubagentBlock(subagents),
    );
    expect(result).not.toContain("<available_public_agents>");
  });

  it("does not append anything after the <available_subagents> block when publicAgents is absent", () => {
    const role = makeRole({ prompt: "You are a plain role." });
    const result = buildAgentPrompt(role, [], {
      subagents: [{ id: "plain--worker", name: "Worker", description: "Does work" }],
    });

    // The public-agents block renders after subagents in buildAgentPrompt, so
    // the prompt ending at </available_subagents> proves nothing was appended.
    expect(result.endsWith("</available_subagents>")).toBe(true);
    expect(result).not.toContain("<available_public_agents>");
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

// ---------------------------------------------------------------------------
// buildSubagentBlock helpers
// ---------------------------------------------------------------------------

function makeSubagent(
  overrides: Partial<{ id: string; name: string; description: string }> = {},
): { id: string; name: string; description: string } {
  return {
    id: "test--child",
    name: "Test Child",
    description: "Does things",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSubagentBlock tests
// ---------------------------------------------------------------------------

describe("buildSubagentBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildSubagentBlock([])).toBe("");
  });

  it("generates <available_subagents> XML with one subagent", () => {
    const result = buildSubagentBlock([makeSubagent()]);
    expect(result).toContain("<available_subagents>");
    expect(result).toContain("</available_subagents>");
    expect(result).toContain("<subagent>");
    expect(result).toContain("</subagent>");
    expect(result).toContain("<id>test--child</id>");
    expect(result).toContain("<name>Test Child</name>");
    expect(result).toContain("<description>Does things</description>");
  });

  it("includes all subagents when multiple are provided", () => {
    const subagents = [
      makeSubagent({ id: "alpha", name: "Alpha", description: "First agent" }),
      makeSubagent({ id: "beta", name: "Beta", description: "Second agent" }),
      makeSubagent({ id: "gamma", name: "Gamma", description: "Third agent" }),
    ];
    const result = buildSubagentBlock(subagents);

    expect(result).toContain("<id>alpha</id>");
    expect(result).toContain("<name>Beta</name>");
    expect(result).toContain("<description>Third agent</description>");
  });

  it("contains the static instruction text", () => {
    const result = buildSubagentBlock([makeSubagent()]);
    expect(result).toContain(
      "You can delegate tasks to these sub-agents via the graph execution engine.",
    );
    expect(result).toContain(
      'graph_add_node(',
    );
  });

  it("escapes special characters in description", () => {
    const result = buildSubagentBlock([
      makeSubagent({ description: "Handles <script> & <style> tags" }),
    ]);
    expect(result).toContain("<description>Handles &lt;script&gt; &amp; &lt;style&gt; tags</description>");
  });
});

// ---------------------------------------------------------------------------
// buildPublicAgentsBlock helpers
// ---------------------------------------------------------------------------

function makePublicAgent(
  overrides: Partial<{ id: string; name: string; description: string }> = {},
): { id: string; name: string; description: string } {
  return {
    id: "other-role--open",
    name: "Open Role",
    description: "A public open role of another role",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPublicAgentsBlock tests
// ---------------------------------------------------------------------------

describe("buildPublicAgentsBlock", () => {
  it("returns empty string for empty array", () => {
    expect(buildPublicAgentsBlock([])).toBe("");
  });

  it("generates <available_public_agents> XML with one public agent", () => {
    const result = buildPublicAgentsBlock([makePublicAgent()]);
    expect(result).toContain("<available_public_agents>");
    expect(result).toContain("</available_public_agents>");
    expect(result).toContain("<public_agent>");
    expect(result).toContain("</public_agent>");
    expect(result).toContain("<id>other-role--open</id>");
    expect(result).toContain("<name>Open Role</name>");
    expect(result).toContain("<description>A public open role of another role</description>");
  });

  it("includes all public agents when multiple are provided", () => {
    const agents = [
      makePublicAgent({ id: "alpha--open", name: "Alpha", description: "First open role" }),
      makePublicAgent({ id: "beta--open", name: "Beta", description: "Second open role" }),
      makePublicAgent({ id: "gamma--open", name: "Gamma", description: "Third open role" }),
    ];
    const result = buildPublicAgentsBlock(agents);

    expect(result).toContain("<id>alpha--open</id>");
    expect(result).toContain("<name>Beta</name>");
    expect(result).toContain("<description>Third open role</description>");
  });

  it("contains the static instruction text", () => {
    const result = buildPublicAgentsBlock([makePublicAgent()]);
    expect(result).toContain(
      "You can dispatch tasks to these open roles of other roles via the graph execution engine.",
    );
    expect(result).toContain(
      'agent="<open-role-id>"',
    );
    expect(result).toContain(
      "graph_add_node(",
    );
  });

  it("escapes special characters in description", () => {
    const result = buildPublicAgentsBlock([
      makePublicAgent({ description: "Handles <script> & <style> tags" }),
    ]);
    expect(result).toContain("<description>Handles &lt;script&gt; &amp; &lt;style&gt; tags</description>");
  });
});
