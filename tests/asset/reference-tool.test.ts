import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReferenceScope, SkillScope } from "../../src/constants.ts";
import { createLoadReferenceTool } from "../../src/asset/reference-tool.ts";
import type { ResolvedReference, ResolvedRole, ResolvedSubAgent } from "../../src/types.ts";
import { makeToolContext } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reference-loader-"));
  directories.push(root);
  let sequence = 0;
  const reference = (name: string, content: string): ResolvedReference => {
    const filePath = join(root, `${++sequence}.md`);
    writeFileSync(filePath, content);
    return { name, filePath, description: `${name} description`, scope: ReferenceScope.Role, relativePath: `references/${name}.md` };
  };
  const role = (id: string, references: ResolvedReference[], subagents: ResolvedSubAgent[] = []): ResolvedRole => ({
    id, config: { name: id, description: id, prompt: id }, prompt: id,
    skills: [], references, functions: [], subagents,
  });
  const childReference = reference("nested/guide", "Child reference body");
  const child: ResolvedSubAgent = { ...role("owner--worker", [childReference]), parentId: "owner", inheritedFrom: {} };
  const ownReference = reference("guide", "---\ntitle: Guide\n---\nFull reference body\nRead ./example.json");
  const owner = role("owner", [ownReference], [child]);
  const foreignReference = reference("foreign-guide", "Foreign private body");
  const foreign = role("foreign", [foreignReference]);
  const skillReference = reference("skill/details", "Skill support body");
  owner.skills.push({ name: "research", description: "Research", scope: SkillScope.Rolebox,
    filePath: join(root, "SKILL.md"), references: [{ ...skillReference, scope: ReferenceScope.Skill }] });
  return { owner, child, ownReference, foreignReference, roles: [owner, foreign], reference, role };
}

describe("load_reference", () => {
  it.each(["owner", "owner--worker"])("loads full content and path metadata for %s", async agent => {
    const f = fixture();
    const result = await createLoadReferenceTool(f.roles).execute({ name: "guide" }, makeToolContext({ agent }));
    expect(result).toMatchObject({ metadata: { payload: {
      name: "guide", description: "guide description", scope: ReferenceScope.Role,
      path: f.ownReference.filePath, relativePath: "references/guide.md",
      content: "---\ntitle: Guide\n---\nFull reference body\nRead ./example.json",
    } } });
    expect(JSON.stringify(result)).toContain("## Reference: guide");
  });

  it("loads visible child resources and references advertised by skills", async () => {
    const f = fixture();
    const tool = createLoadReferenceTool(f.roles);
    const context = makeToolContext({ agent: "owner--worker" });
    expect(await tool.execute({ name: "nested/guide" }, context)).toMatchObject({ metadata: { payload: { content: "Child reference body" } } });
    expect(await tool.execute({ name: "skill/details" }, context)).toMatchObject({ metadata: { payload: {
      scope: ReferenceScope.Skill, content: "Skill support body",
    } } });
  });

  it("uses the skill loader's deepest-first precedence for duplicate names", async () => {
    const f = fixture();
    f.child.references.push(f.reference("guide", "Child override"));
    const nested: ResolvedSubAgent = { ...f.role("owner--worker--nested", [f.reference("guide", "Deepest override")]),
      parentId: f.child.id, inheritedFrom: {} };
    f.child.subagents.push(nested);
    const result = await createLoadReferenceTool(f.roles).execute({ name: "guide" }, makeToolContext({ agent: "owner" }));
    expect(result).toMatchObject({ metadata: { payload: { content: "Deepest override" } } });
  });

  it.each(["owner", "owner--worker"])("keeps foreign resources out of lookups and available-name lists for %s", async agent => {
    const f = fixture();
    const tool = createLoadReferenceTool(f.roles);
    const context = makeToolContext({ agent });
    const missing = await tool.execute({ name: "missing" }, context);
    expect(missing).toContain("guide, nested/guide, skill/details");
    expect(missing).not.toContain("foreign-guide");
    const denied = await tool.execute({ name: "foreign-guide" }, context);
    expect(denied).toContain("Reference not found");
    expect(denied).not.toContain("Foreign private body");
    expect(denied).not.toContain(f.foreignReference.filePath);
    expect(await tool.execute({ name: f.foreignReference.filePath }, context)).toContain("Reference not found");
  });

  it("reads current contents without retaining stale data", async () => {
    const f = fixture();
    const tool = createLoadReferenceTool(f.roles);
    const context = makeToolContext({ agent: "owner" });
    await tool.execute({ name: "guide" }, context);
    writeFileSync(f.ownReference.filePath, "Updated reference body");
    expect(await tool.execute({ name: "guide" }, context)).toMatchObject({ metadata: { payload: { content: "Updated reference body" } } });
    rmSync(f.ownReference.filePath);
    await expect(tool.execute({ name: "guide" }, context)).resolves.toContain("file could not be loaded");
  });

  it("reports an empty role catalog without reading arbitrary files", async () => {
    expect(await createLoadReferenceTool([]).execute({ name: "guide" }, makeToolContext())).toContain("No roles loaded");
    const tool = createLoadReferenceTool(fixture().roles);
    expect(tool.args.name.safeParse("").success).toBe(false);
  });
});
