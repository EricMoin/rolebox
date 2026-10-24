/// <reference types="bun-types" />

/**
 * DshSkillProvider tests — rolebox's lazy pull-style skill source for dsh's
 * global `ctx.skills` registry (`src/platform/adapters/dsh/skill-provider.ts`),
 * exercised directly and through the installed skill registry with a real
 * temp-dir role fixture whose SKILL.md files live on disk.
 *
 * The provider is consumed structurally (no platform SDK import), so the
 * "registry" here is the provider itself: `list()` advertises candidates and
 * `get()` lazily reads the body. The fake-host discipline mirrors
 * `tests/pi-skills.test.ts` (a hermetic temp workspace with real SKILL.md
 * files and process cwd/env restore) and the Map-backed `fakeSubagents()`
 * convention in `tests/platform/dsh-rc6-contract.test.ts:148-160`.
 *
 * Fixture layout (all under a realpath'd temp workspace):
 *   alpha/skills/active-skill/SKILL.md          active role skill (body read)
 *   alpha/skills/dup-skill/SKILL.md             duplicate (role wins over subagent)
 *   alpha/skills/bad~name/SKILL.md              invalid grammar (tilde)
 *   alpha/skills/bad--name/SKILL.md             invalid grammar (double dash)
 *   alpha/skills/vanishing/SKILL.md             deleted between list() and get()
 *   alpha/subagents/child/skills/child-skill/SKILL.md
 *   alpha/subagents/child/skills/dup-skill/SKILL.md          (the losing duplicate)
 *   alpha/subagents/child/subagents/grandchild/skills/grandchild-skill/SKILL.md
 *   alpha/subagents/child/subagents/grandchild/subagents/great-grandchild/skills/great-grandchild-skill/SKILL.md
 *   beta/skills/beta-skill/SKILL.md             NON-active role (must be absent)
 *   primary/skills/primary-skill/SKILL.md       default/primary role
 *
 * Covered assertions (a)-(i):
 *   (a) the active role's skills appear in `list()` and `get()` returns the
 *       real SKILL.md body from the temp-dir fixture;
 *   (b) a NON-active role's skills are absent from `list()`;
 *   (c) private subagent skills are absent from the global registry, including
 *       a 3-level nest, and remain available to their owning role;
 *   (d) a skill name violating the kebab grammar (`~` / `--`) is filtered out
 *       with a warning and does NOT abort the whole `list()`;
 *   (e) duplicate names are deduped first-wins with deterministic role order;
 *   (f) a deleted SKILL.md yields `get() === undefined` rather than a throw;
 *   (g) `rank` is 450 and `resourceBase` is the SKILL.md's dirname;
 *   (h) an aborted `options.signal` settles promptly;
 *   (i) the default/primary role's skills are present when no role is active.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRootLogger } from "../../src/logger.ts";
import {
  DshSkillProvider,
  ROLEBOX_SKILL_PROVIDER,
  ROLEBOX_SKILL_RANK,
  ROLEBOX_SKILL_SOURCE,
} from "../../src/platform/adapters/dsh/skill-provider.ts";
import type {
  DshActiveRoleSnapshot,
  DshSkillProviderDeps,
} from "../../src/platform/adapters/dsh/skill-provider.ts";
import { SkillScope } from "../../src/constants.ts";
import type { ResolvedRole, ResolvedSkill, ResolvedSubAgent } from "../../src/types.ts";
import { createLoadRoleSkillTool } from "../../src/asset/skill-tool.ts";
import { makeToolContext } from "../asset/helpers.ts";

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** Body of the active skill — compared byte-for-byte by `get()`. */
const ACTIVE_SKILL_BODY =
  "---\ndescription: active-skill description\n---\n# active-skill\n\nActive skill body line.\n";

/** Body of the skill deleted between `list()` and `get()` (restored after). */
const VANISHING_SKILL_BODY =
  "---\ndescription: vanishing description\n---\n# vanishing\n";

/**
 * Materialize a real `skills/<name>/SKILL.md` under `rootSkillsDir` and return
 * the `ResolvedSkill` the provider sees (its `filePath` points at the file).
 */
function writeSkill(rootSkillsDir: string, name: string, body?: string): ResolvedSkill {
  const skillDir = join(rootSkillsDir, name);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, "SKILL.md");
  writeFileSync(
    filePath,
    body ?? `---\ndescription: ${name} description\n---\n# ${name}\n`,
    "utf-8",
  );
  return {
    name,
    description: `${name} description`,
    scope: SkillScope.Rolebox,
    filePath,
    references: [],
  };
}

/** Minimal valid RoleConfig for a fixture role. */
function makeRoleConfig(id: string) {
  return { name: id, description: `Role ${id}`, prompt: `You are ${id}.` };
}

/** Build a `ResolvedSubAgent` with the given skills/children. */
function makeSubAgent(
  id: string,
  skills: ResolvedSkill[],
  subagents: ResolvedSubAgent[],
  parentId: string,
): ResolvedSubAgent {
  return {
    id,
    config: { name: id, description: `Subagent ${id}`, prompt: `You are ${id}.` },
    prompt: `You are ${id}.`,
    skills,
    functions: [],
    references: [],
    subagents,
    parentId,
    inheritedFrom: {},
  };
}

// ── Module-scoped fixture state ─────────────────────────────────────────────

let workspace: string;
let originalCwd: string;
let originalLogLevel: string | undefined;
let originalLogFile: string | undefined;

let roles: ResolvedRole[];
let standaloneRoles: ResolvedRole[];
let activeSkillPath: string;
let dupSkillPath: string;
let childDupSkillPath: string;
let vanishingSkillPath: string;

/** Per-session active-role snapshot selecting the `alpha` role for session `s1`. */
function alphaActive(): DshActiveRoleSnapshot {
  return { snapshot: () => new Map([["s1", { roleId: "alpha" }]]) };
}

/** A provider wired to the fixture, with an optional dep override. */
function makeProvider(overrides: Partial<DshSkillProviderDeps> = {}): DshSkillProvider {
  return new DshSkillProvider({
    roles: standaloneRoles,
    activeRole: alphaActive(),
    defaultRoleId: "primary",
    ...overrides,
  });
}

/** Reject if `p` does not settle within `ms` — proves abort "settles promptly". */
function withTimeout<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("did not settle promptly")), ms),
    ),
  ]);
}

// ── Hermetic environment ────────────────────────────────────────────────────

beforeAll(() => {
  originalCwd = process.cwd();
  originalLogLevel = process.env.ROLEBOX_LOG_LEVEL;
  originalLogFile = process.env.ROLEBOX_LOG_FILE;

  // Canonicalize: on macOS `os.tmpdir()` yields the /var symlink form.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "rolebox-dsh-skill-provider-")));

  const alphaSkillsDir = join(workspace, "alpha", "skills");
  const alphaChildSkillsDir = join(workspace, "alpha", "subagents", "child", "skills");
  const alphaGrandchildSkillsDir = join(
    workspace,
    "alpha",
    "subagents",
    "child",
    "subagents",
    "grandchild",
    "skills",
  );
  const alphaGreatGrandchildSkillsDir = join(
    workspace,
    "alpha",
    "subagents",
    "child",
    "subagents",
    "grandchild",
    "subagents",
    "great-grandchild",
    "skills",
  );

  // ── alpha (active): role-local skills + invalid names + vanishing ──────
  const activeSkill = writeSkill(alphaSkillsDir, "active-skill", ACTIVE_SKILL_BODY);
  activeSkillPath = activeSkill.filePath;
  const dupSkill = writeSkill(alphaSkillsDir, "dup-skill");
  dupSkillPath = dupSkill.filePath;
  const badTilde = writeSkill(alphaSkillsDir, "bad~name");
  const badDoubleDash = writeSkill(alphaSkillsDir, "bad--name");
  const vanishing = writeSkill(alphaSkillsDir, "vanishing", VANISHING_SKILL_BODY);
  vanishingSkillPath = vanishing.filePath;

  // ── alpha subagent tree: child → grandchild → great-grandchild ──────────
  const childSkill = writeSkill(alphaChildSkillsDir, "child-skill");
  const childDup = writeSkill(alphaChildSkillsDir, "dup-skill");
  childDupSkillPath = childDup.filePath;
  const grandchildSkill = writeSkill(alphaGrandchildSkillsDir, "grandchild-skill");
  const greatGrandchildSkill = writeSkill(
    alphaGreatGrandchildSkillsDir,
    "great-grandchild-skill",
  );

  const greatGrandchild = makeSubAgent(
    "alpha--child--grandchild--great-grandchild",
    [greatGrandchildSkill],
    [],
    "alpha--child--grandchild",
  );
  const grandchild = makeSubAgent(
    "alpha--child--grandchild",
    [grandchildSkill],
    [greatGrandchild],
    "alpha--child",
  );
  const child = makeSubAgent("alpha--child", [childSkill, childDup], [grandchild], "alpha");

  const alphaRole: ResolvedRole = {
    id: "alpha",
    config: makeRoleConfig("alpha"),
    prompt: "You are alpha.",
    skills: [activeSkill, dupSkill, badTilde, badDoubleDash, vanishing],
    functions: [],
    references: [],
    subagents: [child],
  };

  // ── beta (non-active) ──────────────────────────────────────────────────
  const betaRole: ResolvedRole = {
    id: "beta",
    config: makeRoleConfig("beta"),
    prompt: "You are beta.",
    skills: [writeSkill(join(workspace, "beta", "skills"), "beta-skill")],
    functions: [],
    references: [],
    subagents: [],
  };

  // ── primary (default) ──────────────────────────────────────────────────
  const primaryRole: ResolvedRole = {
    id: "primary",
    config: makeRoleConfig("primary"),
    prompt: "You are primary.",
    skills: [writeSkill(join(workspace, "primary", "skills"), "primary-skill")],
    functions: [],
    references: [],
    subagents: [],
  };

  // Deliberately scrambled so ordering-by-id (not input order) is observable.
  roles = [primaryRole, betaRole, alphaRole];
  // Catalog mechanics use standalone roles; boundary cases below use the
  // actual alpha tree, whose root workflow is private as well.
  standaloneRoles = roles.map(role => ({ ...role, subagents: [] }));

  // Redirect platform paths + cwd into the fixture (restored in afterAll).
  process.env.ROLEBOX_LOG_LEVEL = "warn";
  process.env.ROLEBOX_LOG_FILE = join(workspace, "rolebox.log");
  process.chdir(workspace);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalLogLevel === undefined) delete process.env.ROLEBOX_LOG_LEVEL;
  else process.env.ROLEBOX_LOG_LEVEL = originalLogLevel;
  if (originalLogFile === undefined) delete process.env.ROLEBOX_LOG_FILE;
  else process.env.ROLEBOX_LOG_FILE = originalLogFile;
  rmSync(workspace, { recursive: true, force: true });
});

// ── (a) active role list + real body ────────────────────────────────────────

describe("DshSkillProvider (a) active role catalog + lazy body", () => {
  it("lists the active role's skills and `get()` returns the real SKILL.md body", async () => {
    const provider = makeProvider();
    const candidates = await provider.list({});

    const active = candidates.find((c) => c.name === "active-skill");
    expect(active).toBeDefined();
    expect(active!.provider).toBe(ROLEBOX_SKILL_PROVIDER);
    expect(active!.source).toBe(ROLEBOX_SKILL_SOURCE);
    expect(active!.path).toBe(activeSkillPath);

    const definition = await provider.get(active!, {});
    expect(definition).toBeDefined();
    expect(definition!.name).toBe("active-skill");
    // The real file content, read lazily — frontmatter and all.
    expect(definition!.content).toBe(ACTIVE_SKILL_BODY);
    expect(definition!.path).toBe(activeSkillPath);
  });
});

// ── (b) non-active role excluded ────────────────────────────────────────────

describe("DshSkillProvider (b) non-active roles", () => {
  it("omits a NON-active role's skills from list()", async () => {
    const names = (await makeProvider().list({})).map((c) => c.name);
    expect(names).not.toContain("beta-skill");
  });
});

// ── (c) private subagent skills ───────────────────────────────────────────

describe("DshSkillProvider (c) private subagent skills", () => {
  it("omits private subagent skills at every depth", async () => {
    const names = (await makeProvider({ roles }).list({})).map((c) => c.name);
    expect(names).not.toContain("active-skill");
    expect(names).not.toContain("child-skill");
    expect(names).not.toContain("grandchild-skill");
    expect(names).not.toContain("great-grandchild-skill");
  });

  it("rejects private and stale locators, including a private skill sharing a public name", async () => {
    const provider = makeProvider();
    const root = (await provider.list({})).find(candidate => candidate.name === "active-skill")!;
    const child = roles.find(role => role.id === "alpha")!.subagents[0];
    for (const skill of child.skills) {
      expect(await provider.get({ ...root, name: skill.name, path: skill.filePath, locator: skill }, {})).toBeUndefined();
    }
    expect(await makeProvider({ activeRole: undefined }).get(root, {})).toBeUndefined();
    expect(await makeProvider({ roles }).get(root, {})).toBeUndefined();
    expect(await provider.get({ ...root, description: "untrusted metadata", resourceBase: { kind: "directory", path: "/outside" } }, {}))
      .toMatchObject({ description: "active-skill description", resourceBase: { kind: "directory", path: dirname(activeSkillPath) } });
  });

  it("keeps the installed global registry public while the scoped loader serves only the owning role tree", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(SkillRegistry, {});
    const activeRole = { snapshot: () => new Map([["owner", { roleId: "alpha" }], ["peer", { roleId: "beta" }]]) };
    const workflow = writeSkill(join(workspace, "workflow"), "private-workflow", "Delegate to alpha--child.");
    const scopedRoles = roles.map(role => role.id === "alpha" ? { ...role, skills: [...role.skills, workflow] } : role);
    const dispose = ctx.skills.registerProvider(control => new DshSkillProvider({ roles: scopedRoles, activeRole }, control) as never);
    try {
      const catalog = await ctx.skills.list({ cwd: workspace });
      expect(catalog.map(skill => skill.name)).not.toContain("active-skill");
      expect(catalog.map(skill => skill.name)).toContain("beta-skill");
      expect(catalog.map(skill => skill.name)).not.toContain("child-skill");
      expect(catalog.map(skill => skill.name)).not.toContain("great-grandchild-skill");
      expect(await ctx.skills.get("active-skill", { cwd: workspace })).toBeUndefined();
      expect(await ctx.skills.get("child-skill", { cwd: workspace })).toBeUndefined();
      expect(await ctx.skills.get("private-workflow", { cwd: workspace })).toBeUndefined();

      const loader = createLoadRoleSkillTool(scopedRoles);
      expect(JSON.stringify(await loader.execute({ name: "active-skill" }, makeToolContext({ agent: "alpha" })))).toContain("Active skill body line.");
      expect(await loader.execute({ name: "active-skill" }, makeToolContext({ agent: "beta" }))).toContain("Skill not found");
      expect(JSON.stringify(await loader.execute({ name: "private-workflow" }, makeToolContext({ agent: "alpha" })))).toContain("Delegate to alpha--child");
      expect(await loader.execute({ name: "private-workflow" }, makeToolContext({ agent: "beta" }))).not.toContain("alpha--child");
      for (const agent of ["alpha", "alpha--child", "alpha--child--grandchild"]) {
        const own = await loader.execute({ name: "great-grandchild-skill" }, makeToolContext({ agent }));
        expect(typeof own).toBe("object");
        expect(JSON.stringify(own)).toContain("# great-grandchild-skill");
      }
      const denied = await loader.execute({ name: "child-skill" }, makeToolContext({ agent: "beta" }));
      expect(denied).toContain("Skill not found");
      expect(denied).not.toContain("# child-skill");
      expect(denied).not.toContain("grandchild-skill");
    } finally {
      dispose();
      await fiber.dispose();
    }
  });
});

// ── (d) invalid grammar filtered with a warning, list() survives ────────────

describe("DshSkillProvider (d) invalid skill-name grammar", () => {
  it("filters a bad name with a warning and does NOT abort the whole list()", async () => {
    // CAPTURE THROUGH THE PIPELINE: a root transport sees every record the
    // provider emits on its own channel — the message at "0", the fields at "1".
    const entries: Array<Record<string, unknown>> = [];
    getRootLogger().attachTransport((entry) => entries.push(entry as Record<string, unknown>));

    const names = (await makeProvider().list({})).map((c) => c.name);

    // Rejected names are dropped...
    expect(names).not.toContain("bad~name");
    expect(names).not.toContain("bad--name");
    // ...while the valid catalog still resolves (no catalog-wide abort).
    expect(names).toContain("active-skill");

    // One warning per rejected name, carrying the offending name.
    const warnedNames = entries
      .map((entry) => (entry["1"] as { name?: string } | undefined)?.name)
      .filter((name): name is string => typeof name === "string");
    expect(warnedNames).toContain("bad~name");
    expect(warnedNames).toContain("bad--name");
  });
});

// ── (e) duplicate dedupe + deterministic ordering ───────────────────────────

describe("DshSkillProvider (e) dedupe and deterministic ordering", () => {
  it("dedupes first-wins and orders top-level roles by id", async () => {
    const candidates = await makeProvider().list({});
    const names = candidates.map((c) => c.name);

    // Role skills first (alpha), then the default
    // primary role — even though `roles` was supplied [primary, beta, alpha].
    expect(names).toEqual([
      "active-skill",
      "dup-skill",
      "vanishing",
      "primary-skill",
    ]);

    // `dup-skill` appears once, and the role-local occurrence won.
    expect(names.filter((n) => n === "dup-skill")).toHaveLength(1);
    const dup = candidates.find((c) => c.name === "dup-skill")!;
    expect(dup.path).toBe(dupSkillPath);
    expect(dup.path).not.toBe(childDupSkillPath);
  });
});

// ── (f) deleted SKILL.md → get() undefined, not a throw ─────────────────────

describe("DshSkillProvider (f) vanished SKILL.md", () => {
  it("returns undefined from get() when the SKILL.md was deleted after listing", async () => {
    const provider = makeProvider();
    const candidate = (await provider.list({})).find((c) => c.name === "vanishing");
    expect(candidate).toBeDefined();

    unlinkSync(vanishingSkillPath);
    try {
      const result = await provider.get(candidate!, {});
      expect(result).toBeUndefined();
    } finally {
      // Restore the fixture for sibling tests.
      writeFileSync(vanishingSkillPath, VANISHING_SKILL_BODY, "utf-8");
    }
  });
});

// ── (g) rank + resourceBase ─────────────────────────────────────────────────

describe("DshSkillProvider (g) rank and resourceBase", () => {
  it("emits rank 450 and resourceBase = the SKILL.md's dirname", async () => {
    const candidate = (await makeProvider().list({})).find(
      (c) => c.name === "active-skill",
    )!;
    expect(ROLEBOX_SKILL_RANK).toBe(450);
    expect(candidate.rank).toBe(450);
    expect(candidate.resourceBase).toEqual({
      kind: "directory",
      path: dirname(activeSkillPath),
    });
  });
});

// ── (h) abort handling ──────────────────────────────────────────────────────

describe("DshSkillProvider (h) abort handling", () => {
  it("settles promptly for pre-aborted and mid-flight aborted signals", async () => {
    const provider = makeProvider();
    const candidate = (await provider.list({})).find((c) => c.name === "active-skill")!;

    // Pre-aborted signal: list() short-circuits to [], get() to undefined.
    const controller = new AbortController();
    controller.abort();
    expect(await withTimeout(provider.list({ signal: controller.signal }))).toEqual([]);
    expect(
      await withTimeout(provider.get(candidate, { signal: controller.signal })),
    ).toBeUndefined();

    // Aborted mid-flight (during role resolution): still settles to [].
    const midFlight = new AbortController();
    const resolving = new DshSkillProvider({
      roles: async () => {
        midFlight.abort();
        return roles;
      },
      activeRole: alphaActive(),
      defaultRoleId: "primary",
    });
    expect(await withTimeout(resolving.list({ signal: midFlight.signal }))).toEqual([]);
  });
});

// ── (i) default/primary role with no active role ────────────────────────────

describe("DshSkillProvider (i) default role fallback", () => {
  it("advertises the default/primary role's skills when no role is active", async () => {
    const names = (await makeProvider({ activeRole: undefined }).list({})).map(
      (c) => c.name,
    );
    expect(names).toContain("primary-skill");
    // Neither the would-be active role nor other roles leak in.
    expect(names).not.toContain("active-skill");
    expect(names).not.toContain("beta-skill");
  });
});

// ── (j) invalidate — the subtask-7 hot-reload refresh seam ──────────────────
//
// The provider retains the `control` handed to the factory
// (`dsh-skill/lib/index.js:151-159`) and exposes `invalidate()` as the single
// refresh seam the dsh plugin calls on an active-role change or a role
// re-resolution. These tests pin the three guarantees: exactly one forward per
// call, a disposal no-op (the control signal aborts on teardown), and throw
// containment.

describe("DshSkillProvider (j) invalidate", () => {
  it("forwards invalidate() to the registration control exactly once per call", () => {
    let calls = 0;
    const provider = new DshSkillProvider(
      { roles: [] },
      { signal: new AbortController().signal, invalidate: () => calls++ },
    );

    provider.invalidate();
    expect(calls).toBe(1);
    provider.invalidate();
    expect(calls).toBe(2);
  });

  it("is a safe no-op after disposal (control.signal aborted)", () => {
    let calls = 0;
    const lifecycle = new AbortController();
    const provider = new DshSkillProvider(
      { roles: [] },
      { signal: lifecycle.signal, invalidate: () => calls++ },
    );

    // Disposal of the exact registration aborts the control signal
    // (`dsh-skill/lib/index.js:170`); a stale provider must not poke it.
    lifecycle.abort();

    expect(() => provider.invalidate()).not.toThrow();
    expect(calls).toBe(0);
  });

  it("contains a throwing control.invalidate() instead of propagating", () => {
    const provider = new DshSkillProvider(
      { roles: [] },
      {
        signal: new AbortController().signal,
        invalidate: () => {
          throw new Error("registry exploded");
        },
      },
    );

    expect(() => provider.invalidate()).not.toThrow();
  });

  it("is a no-op when constructed without a control", () => {
    const provider = new DshSkillProvider({ roles: [] });
    expect(() => provider.invalidate()).not.toThrow();
  });
});

