/**
 * `load_role_skill` tool tests (Subtask S1 — pi-gate-dispatch fix).
 *
 * Verifies the Pi-only `load_role_skill` tool created by
 * createLoadRoleSkillTool():
 *   1. Exact-name match with deepest-first subagent priority (mirrors the
 *      asset-inspect.ts findAsset traversal).
 *   2. Not-found error lists the available skill names.
 *   3. Missing file on disk yields a graceful error (no throw).
 *   4. Complete self-contained payload shape (content + references present).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createLoadRoleSkillTool, type LoadedSkillPayload } from "../src/asset/skill-tool.ts";
import { SkillScope, ReferenceScope } from "../src/constants.ts";
import type {
  ResolvedRole,
  ResolvedSkill,
  ResolvedReference,
  ResolvedSubAgent,
} from "../src/types.ts";
import type { CanonicalToolContext } from "../src/platform/types.ts";

let tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-skill-tool-test-"));
  tmpRoots.push(dir);
  return dir;
}

/** Write a SKILL.md file and return its absolute path. */
function mkSkillFile(baseDir: string, label: string, content: string): string {
  const filePath = join(baseDir, label, "SKILL.md");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function makeSkill(opts: {
  name: string;
  filePath: string;
  description?: string;
  references?: ResolvedReference[];
}): ResolvedSkill {
  return {
    name: opts.name,
    description: opts.description ?? `Description for ${opts.name}`,
    scope: SkillScope.Rolebox,
    filePath: opts.filePath,
    references: opts.references ?? [],
  };
}

function makeReference(opts: {
  name: string;
  filePath: string;
  description: string;
}): ResolvedReference {
  return {
    name: opts.name,
    filePath: opts.filePath,
    description: opts.description,
    scope: ReferenceScope.Skill,
    relativePath: `references/${opts.name}.md`,
  };
}

function makeSubAgent(opts: {
  id: string;
  parentId: string;
  skills?: ResolvedSkill[];
  subagents?: ResolvedSubAgent[];
}): ResolvedSubAgent {
  return {
    id: opts.id,
    config: {
      name: opts.id,
      description: "",
      prompt: "",
    },
    prompt: "",
    skills: opts.skills ?? [],
    functions: [],
    references: [],
    subagents: opts.subagents ?? [],
    parentId: opts.parentId,
    inheritedFrom: {},
  };
}

function makeRole(opts: {
  id: string;
  skills?: ResolvedSkill[];
  subagents?: ResolvedSubAgent[];
}): ResolvedRole {
  return {
    id: opts.id,
    config: {
      name: opts.id,
      description: "Test role",
      prompt: "You are a test role.",
    },
    prompt: "You are a test role.",
    skills: opts.skills ?? [],
    functions: [],
    references: [],
    subagents: opts.subagents ?? [],
  };
}

function makeContext(dir: string): CanonicalToolContext {
  return {
    sessionID: "sess-1",
    messageID: "msg-1",
    agent: "test-agent",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function payloadOf(
  result: unknown,
): LoadedSkillPayload | null {
  if (typeof result === "string") return null;
  const metadata = (result as { metadata?: { payload?: LoadedSkillPayload } }).metadata;
  return metadata?.payload ?? null;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe("createLoadRoleSkillTool", () => {
  it("resolves exact-name match with deepest-first subagent priority", async () => {
    const dir = tmpDir();

    // Same skill name at three nesting depths with distinct content.
    const roleLevel = makeSkill({
      name: "shared-skill",
      filePath: mkSkillFile(dir, "role-level", "ROLE-LEVEL-CONTENT"),
    });
    const subLevel = makeSkill({
      name: "shared-skill",
      filePath: mkSkillFile(dir, "sub-alpha", "SUB-ALPHA-CONTENT"),
    });
    const nestedLevel = makeSkill({
      name: "shared-skill",
      filePath: mkSkillFile(dir, "sub-beta", "SUB-BETA-CONTENT"),
    });

    const beta = makeSubAgent({
      id: "beta",
      parentId: "root/alpha",
      skills: [nestedLevel],
    });
    const alpha = makeSubAgent({
      id: "alpha",
      parentId: "root",
      skills: [subLevel],
      subagents: [beta],
    });
    const role = makeRole({ id: "root", skills: [roleLevel], subagents: [alpha] });

    const tool = createLoadRoleSkillTool([role]);
    const result = await tool.execute({ name: "shared-skill" }, makeContext(dir));

    // Deepest subagent (beta) wins over alpha and over role-level.
    const payload = payloadOf(result);
    expect(payload).not.toBeNull();
    expect(payload!.content).toBe("SUB-BETA-CONTENT");
    expect(payload!.path).toBe(nestedLevel.filePath);
    // The human-readable rendering reflects the winning skill too.
    expect(typeof result).toBe("object");
    expect((result as { output: string }).output).toContain("SUB-BETA-CONTENT");
    expect((result as { output: string }).output).toContain("root/alpha/beta");
  });

  it("returns a not-found error listing the available skill names", async () => {
    const dir = tmpDir();

    const role = makeRole({
      id: "root",
      skills: [
        makeSkill({ name: "graph-visualiser", filePath: mkSkillFile(dir, "gv", "GV") }),
        makeSkill({ name: "context-assembler", filePath: mkSkillFile(dir, "ca", "CA") }),
      ],
    });

    const tool = createLoadRoleSkillTool([role]);
    const result = await tool.execute({ name: "does-not-exist" }, makeContext(dir));

    expect(typeof result).toBe("string");
    expect(result).toContain('Skill not found: no skill named "does-not-exist"');
    expect(result).toContain("Available skills");
    expect(result).toContain("graph-visualiser");
    expect(result).toContain("context-assembler");
  });

  it("gracefully reports a skill whose file is missing on disk", async () => {
    const dir = tmpDir();

    // Resolved skill pointing at a file that was never written.
    const missingPath = join(dir, "ghost", "SKILL.md");
    const role = makeRole({
      id: "root",
      skills: [makeSkill({ name: "ghost-skill", filePath: missingPath })],
    });

    const tool = createLoadRoleSkillTool([role]);
    const result = await tool.execute({ name: "ghost-skill" }, makeContext(dir));

    expect(typeof result).toBe("string");
    expect(result).toContain("could not be loaded");
    expect(result).toContain(missingPath);
  });

  it("returns a complete, self-contained payload (content + references)", async () => {
    const dir = tmpDir();

    const filePath = mkSkillFile(dir, "graph-visualiser", "SKILL-CONTENT-42");
    const skill = makeSkill({
      name: "graph-visualiser",
      filePath,
      description: "Renders dependency graphs for the rolebox graph engine",
      references: [
        makeReference({
          name: "theory/core-principles",
          filePath: "/refs/core-principles.md",
          description: "Core principles doc",
        }),
      ],
    });
    const role = makeRole({ id: "root", skills: [skill] });

    const tool = createLoadRoleSkillTool([role]);
    const result = await tool.execute({ name: "graph-visualiser" }, makeContext(dir));

    const payload = payloadOf(result);
    expect(payload).not.toBeNull();
    expect(payload!.name).toBe("graph-visualiser");
    expect(payload!.description).toBe("Renders dependency graphs for the rolebox graph engine");
    expect(payload!.scope).toBe("rolebox");
    expect(payload!.path).toBe(filePath);
    // Full SKILL.md content present verbatim.
    expect(payload!.content).toBe("SKILL-CONTENT-42");
    // References mapped to the { name, path, description } contract.
    expect(payload!.references).toEqual([
      {
        name: "theory/core-principles",
        path: "/refs/core-principles.md",
        description: "Core principles doc",
      },
    ]);

    // Human-readable rendering carries the same facts.
    const output = (result as { output: string }).output;
    expect(output).toContain("## Skill: graph-visualiser");
    expect(output).toContain("SKILL-CONTENT-42");
    expect(output).toContain("theory/core-principles");
  });
});
