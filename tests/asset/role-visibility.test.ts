import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FunctionSource, ReferenceScope, SkillScope } from "../../src/constants.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";
import { createAssetSearchTool } from "../../src/asset/asset-search.ts";
import { createAssetInspectTool } from "../../src/asset/asset-inspect.ts";
import { createLoadRoleSkillTool } from "../../src/asset/skill-tool.ts";
import { createSkillComposeTool } from "../../src/asset/skill-compose.ts";
import { createAssetValidateTool } from "../../src/asset/asset-validate.ts";
import { createReferenceSearchTool } from "../../src/utils/reference-search.ts";
import { buildCanonicalTools } from "../../src/platform/tool-assembly.ts";
import { piCapabilities } from "../../src/platform/capabilities.ts";
import { makeToolContext } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): ResolvedRole[] {
  const directory = mkdtempSync(join(tmpdir(), "role-visibility-"));
  directories.push(directory);
  const makeRole = (id: string, skillName: string, subagents: ResolvedSubAgent[] = []): ResolvedRole => {
    const filePath = join(directory, `${skillName}.md`);
    writeFileSync(filePath, `visibility marker ${skillName}`);
    return {
      id, config: { name: id, description: id, prompt: id }, prompt: id, subagents,
      skills: [{ name: skillName, description: skillName, filePath, scope: SkillScope.Rolebox, references: [] }],
      references: [{ name: skillName, description: skillName, filePath, scope: ReferenceScope.Role, relativePath: `${skillName}.md` }],
      functions: [{ name: `${skillName}-fn`, description: skillName, content: "", filePath, source: FunctionSource.RoleLocal, requires: ["unavailable-function"] }],
    };
  };
  const child = (id: string, skillName: string, subagents: ResolvedSubAgent[] = []): ResolvedSubAgent => ({
    ...makeRole(id, skillName, subagents), parentId: id.split("--").slice(0, -1).join("--"), inheritedFrom: {},
  });
  return [
    makeRole("engineer", "engineer-public", [child("engineer--worker", "own-skill", [child("engineer--worker--nested", "nested-skill")])]),
    makeRole("designer", "designer-public", [child("designer--private", "private-skill")]),
  ];
}

const search = { query: "skill", type: "all" as const, limit: 20, format: "json" as const };

describe("role asset visibility", () => {
  it("limits search to the caller's role tree even when filtering by a foreign root", async () => {
    const roles = fixture();
    const tool = createAssetSearchTool(roles);
    const context = makeToolContext({ agent: "engineer--worker" });
    const result = await tool.execute(search, context);
    expect(result).toContain("own-skill");
    expect(result).toContain("nested-skill");
    expect(result).not.toContain("private-skill");
    expect(result).not.toContain("designer--private");
    const filtered = await tool.execute({ ...search, role_id: "designer" }, context);
    expect(filtered).not.toContain("private-skill");
    const other = await tool.execute(search, makeToolContext({ agent: "designer" }));
    expect(other).toContain("private-skill");
    expect(other).not.toContain("own-skill");
  });

  it("keeps public assets visible and withholds private assets from unattributed callers", async () => {
    const roles = fixture();
    for (const agent of ["", "external-agent"]) {
      const context = makeToolContext({ agent });
      const result = await createAssetSearchTool(roles).execute({ ...search, query: "public" }, context);
      expect(result).toContain("engineer-public");
      expect(result).toContain("designer-public");
      const children = await createAssetSearchTool(roles).execute(search, context);
      expect(children).not.toContain("private-skill");
      expect(children).not.toContain("own-skill");
    }
  });

  it("does not inspect or load a foreign child's resource, including not-found listings", async () => {
    const roles = fixture();
    const context = makeToolContext({ agent: "engineer" });
    const inspect = createAssetInspectTool(roles);
    expect(await inspect.execute({ name: "private-skill", type: "skill" }, context)).toContain("Asset not found");
    expect(await inspect.execute({ name: "designer-public", type: "skill" }, context)).toContain("Asset not found");
    expect(await inspect.execute({ name: "nested-skill", type: "skill" }, context)).toContain("engineer--worker--nested");
    const load = createLoadRoleSkillTool(roles);
    const denied = await load.execute({ name: "private-skill" }, context);
    expect(denied).toContain("Skill not found");
    expect(denied).not.toContain("designer--private");
    const missing = await load.execute({ name: "missing" }, context);
    expect(missing).not.toContain("private-skill");
    expect(missing).toContain("own-skill");
    const own = await load.execute({ name: "nested-skill" }, context);
    expect(typeof own).toBe("object");
    expect(JSON.stringify(own)).toContain("visibility marker nested-skill");
  });

  it("applies the same scope to reference search, validation, and skill composition", async () => {
    const roles = fixture();
    const context = makeToolContext({ agent: "engineer" });
    const references = await createReferenceSearchTool(roles).execute({ query: "visibility marker", case_sensitive: false, limit: 50, context_lines: 0, format: "markdown" }, context);
    expect(references).toContain("own-skill");
    expect(references).not.toContain("private-skill");
    const validation = await createAssetValidateTool(roles).execute({}, context);
    expect(validation).toContain("own-skill");
    expect(validation).not.toContain("private-skill");
    const composition = await createSkillComposeTool(roles).execute({ skill_names: ["own-skill"], check_conflicts: true }, context);
    expect(composition).toContain("engineer--worker");
    expect(composition).not.toContain("designer--private");
    const privateComposition = await createSkillComposeTool(roles).execute({ skill_names: ["private-skill"], check_conflicts: true }, context);
    expect(privateComposition).toContain("No matching skills found");
  });

  it("uses the platform role resolver when a tool context carries a session id as its agent", async () => {
    const roles = fixture();
    const tools = buildCanonicalTools({
      resolvedRoles: roles, directory: directories[0], capabilities: piCapabilities(),
      getEffectiveAgent: sessionID => sessionID === "test-session" ? "engineer" : undefined,
      extraTools: { load_role_skill: createLoadRoleSkillTool(roles) },
    });
    const context = makeToolContext({ agent: "host-session-agent" });
    const result = await tools.asset_search.execute(search, context);
    expect(result).toContain("own-skill");
    expect(result).not.toContain("private-skill");
    expect(await tools.load_role_skill.execute({ name: "missing" }, context)).not.toContain("private-skill");
  });

  it("withholds foreign root workflow bodies, metadata, and reference excerpts that name private children", async () => {
    const roles = fixture();
    roles[1].skills[0].description = "Delegate to designer--private";
    writeFileSync(roles[1].skills[0].filePath, "Delegate to designer--private for the private workflow.");
    const caller = makeToolContext({ agent: "engineer" });
    const loader = createLoadRoleSkillTool(roles);
    expect(await loader.execute({ name: "designer-public" }, caller)).toContain("Skill not found");
    expect(await loader.execute({ name: "missing" }, caller)).not.toContain("designer-public");
    expect(await createAssetSearchTool(roles).execute({ ...search, query: "designer" }, caller)).not.toContain("designer--private");
    expect(await createReferenceSearchTool(roles).execute({ query: "Delegate", case_sensitive: false, limit: 50, context_lines: 0, format: "markdown" }, caller)).not.toContain("designer--private");
    const own = await loader.execute({ name: "designer-public" }, makeToolContext({ agent: "designer" }));
    expect(JSON.stringify(own)).toContain("Delegate to designer--private");
  });

  it("refuses host-bound resource calls when the session has no attributable role", async () => {
    const roles = fixture();
    const tools = buildCanonicalTools({
      resolvedRoles: roles, directory: directories[0], capabilities: piCapabilities(),
      getEffectiveAgent: () => undefined,
      extraTools: { load_role_skill: createLoadRoleSkillTool(roles) },
    });
    const context = makeToolContext({ agent: "unbound-host-session" });
    expect(await tools.load_role_skill.execute({ name: "designer-public" }, context)).toBe("Role assets require an active role for this session.");
    expect(await tools.asset_search.execute(search, context)).toBe("Role assets require an active role for this session.");
  });
});
