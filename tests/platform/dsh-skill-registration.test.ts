/// <reference types="bun-types" />

/**
 * dsh plugin-level skill-registration integration test —
 * `src/dsh-plugin.ts` booted on a fake cordis ctx whose `skills` service is a
 * duck-typed double, against a real temp-dir role fixture.
 *
 * This is the end-to-end proof of the skill-surface defect fix at the WIRING
 * seam: under dsh, rolebox role skills were unreachable (`skill
 * "<name>" is unknown or no longer available`) because rolebox never
 * published them into dsh's global `ctx.skills` registry
 * (`@deepseek-ai/dsh-skill`). Subtask 6 wired a LAZY `SkillProvider` factory
 * into `apply()` via `probeSkillRegistry`; this suite asserts the wiring
 * behaves, not the provider internals (covered by
 * `tests/platform/dsh-skill-provider.test.ts`).
 *
 * The fake-ctx double follows the `tests/dsh-plugin.test.ts` conventions: a
 * structural `DshPluginContext` with recording `tools` / `subagents` doubles,
 * a `get(name)` optional-service seam, and a recording event bus. The `skills`
 * double records every `registerProvider(create)` call, invokes the factory
 * with a `{signal, invalidate}` control (the rc.6 contract), and returns a
 * disposer that counts its invocations.
 *
 * Fixture: `{tmpDir}/ai-designer/role.yaml` declares the role-local skill
 * `ai-designer-director` (a director-style skill mirroring the bug report),
 * whose `SKILL.md` lives on disk. The active role is seeded through the
 * workspace sidecar so the provider's candidate set (active ∪ default) is
 * non-empty at `list()` time.
 *
 * Covered assertions (a)-(e):
 *   (a) exactly ONE provider is registered and its name is `'rolebox'`;
 *   (b) the recorded provider's `list({cwd})` returns the ACTIVE role's skills
 *       — `ai-designer-director` (the previously-missing name) IS present;
 *   (c) `get()` on that candidate returns the real SKILL.md body;
 *   (d) a ctx with NO `skills` service still activates the plugin and
 *       registers ZERO providers (graceful degradation);
 *   (e) the plugin disposer invokes the `registerProvider` disposer exactly
 *       once.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "../../src/dsh-plugin.ts";
import type {
  DshPluginConfig,
  DshPluginContext,
} from "../../src/dsh-plugin.ts";
import { shortHash } from "../../src/utils/state-paths.ts";
import type { DshToolDefinition } from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshSubagentDispatchRuntime } from "../../src/platform/adapters/dsh/dispatch.ts";
import type { DshSessionStoreLike } from "../../src/platform/adapters/dsh/session.ts";
import {
  ROLEBOX_SKILL_PROVIDER,
} from "../../src/platform/adapters/dsh/skill-provider.ts";
import type {
  DshSkillProviderControl,
  DshSkillProviderLike,
} from "../../src/platform/adapters/dsh/skill-provider.ts";

// ── Fake cordis ctx double ─────────────────────────────────────────────────

/** One recorded `registerProvider` call on the fake skills registry. */
interface FakeSkillRegistration {
  provider: DshSkillProviderLike;
  control: DshSkillProviderControl;
  disposeCalls: number;
}

/**
 * Minimal fake of the cordis Context + the injected dsh services
 * (`tools`, `sessions`, `subagents`) and the OPTIONAL `skills` registry.
 *
 * The `skills` option (default `false`) mirrors a full dsh profile, where the
 * `dsh-skill` registry row is mounted and rolebox's skill provider is
 * registered; the default leaves it absent so case (d) exercises apply()'s
 * graceful degrade. The double records each `registerProvider(create)` call,
 * invokes `create(control)` once with the rc.6 `{signal, invalidate}` control,
 * and returns a disposer that counts its own invocations.
 */
function createFakeCtx(options: { skills?: boolean } = {}) {
  const registeredTools: DshToolDefinition[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const skillRegistrations: FakeSkillRegistration[] = [];

  const skills = {
    registerProvider(
      create: (control: DshSkillProviderControl) => DshSkillProviderLike,
    ): () => void {
      const control: DshSkillProviderControl = {
        signal: new AbortController().signal,
        invalidate: () => {},
      };
      const provider = create(control);
      const record: FakeSkillRegistration = { provider, control, disposeCalls: 0 };
      skillRegistrations.push(record);
      return () => {
        record.disposeCalls += 1;
      };
    },
  };

  const tools = {
    register(definition: DshToolDefinition): () => void {
      registeredTools.push(definition);
      return () => {
        const i = registeredTools.indexOf(definition);
        if (i >= 0) registeredTools.splice(i, 1);
      };
    },
  };

  const subagents: DshSubagentDispatchRuntime = {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (providerName: string) => providers.get(providerName),
    list: () => [...providers.keys()],
    async start(
      _name: string,
      _request: DshSubagentStartRequest,
    ): Promise<DshSubagentRun> {
      return {
        id: "fake-run",
        result: Promise.resolve({ stopReason: "completed", output: [] }),
        dispose: async () => {},
      };
    },
  };

  const sessions: DshSessionStoreLike = {
    create: (id?: string) => ({
      id: id ?? "session-1",
      seq: 0,
      events: [],
      header: { cwd: process.cwd() },
      append: () => ({ type: "log/only", seq: 0 } as never),
      deriveMessages: () => [],
    }),
    get: () => undefined,
    list: () => [],
    fork: () => ({ id: "session-fork", seq: 0, events: [] } as never),
  };

  const ctx: DshPluginContext = {
    tools,
    sessions,
    subagents,
    ...(options.skills ? { skills } : {}),
    get(name: string): unknown {
      // Optional-service seam: the skills registry is probed by the plugin;
      // every other name (webServer/systemPrompt/agents/llm) is absent.
      if (name === "skills") return options.skills ? skills : undefined;
      return undefined;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((l) => l !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };

  return { ctx, tools, providers, skillRegistrations };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Role id of the fixture role — the bug report's director-style role. */
const DIRECTOR_ROLE_ID = "ai-designer";
/** The previously-missing skill name the bug report filed. */
const DIRECTOR_SKILL_NAME = "ai-designer-director";
/** Body of the fixture SKILL.md — compared byte-for-byte by `get()`. */
const DIRECTOR_SKILL_BODY = [
  "---",
  "description: Director-style orchestration skill from the bug report",
  "---",
  "# ai-designer-director",
  "",
  "Director skill body used by the dsh skill-registration regression test.",
  "",
].join("\n");

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-skill-reg-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create `{tmpDir}/ai-designer/role.yaml` declaring the role-local
 * `ai-designer-director` skill, plus the matching `SKILL.md` on disk.
 */
function writeDirectorRoleFixture(): string {
  const roleDir = join(tmpDir, DIRECTOR_ROLE_ID);
  const skillDir = join(roleDir, "skills", DIRECTOR_SKILL_NAME);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(roleDir, "role.yaml"),
    [
      "name: AI Designer",
      "description: The director-style role from the bug report",
      "prompt: You are the AI designer.",
      "skills:",
      `  - ${DIRECTOR_SKILL_NAME}`,
    ].join("\n"),
    "utf-8",
  );
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, DIRECTOR_SKILL_BODY, "utf-8");
  return skillPath;
}

/**
 * Seed the workspace active-role sidecar so `ai-designer` is ACTIVE for
 * session `s1` before the plugin boots (the ActiveRoleStore hydrates it
 * synchronously). The sidecar path mirrors `ActiveRoleStore`'s layout:
 * `{cwd}/.rolebox/state/activerole-<shortHash(cwd)>.json`.
 */
function seedActiveRole(sessionId = "s1"): void {
  const sidecar = join(
    process.cwd(),
    ".rolebox",
    "state",
    `activerole-${shortHash(process.cwd())}.json`,
  );
  mkdirSync(dirname(sidecar), { recursive: true });
  writeFileSync(
    sidecar,
    JSON.stringify({
      version: 1,
      sessions: [{ sessionId, roleId: DIRECTOR_ROLE_ID, updatedAt: Date.now() }],
    }),
    "utf-8",
  );
}

// ── (a)-(c) registration + catalog + lazy body ─────────────────────────────

describe("dsh plugin skill registration (a)-(c)", () => {
  it("registers exactly one 'rolebox' provider whose list() surfaces the active role's director skill and get() returns its body", async () => {
    const skillPath = writeDirectorRoleFixture();
    seedActiveRole();

    const { ctx, skillRegistrations } = createFakeCtx({ skills: true });
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // (a) exactly one provider registered, named 'rolebox'.
    expect(skillRegistrations).toHaveLength(1);
    const registration = skillRegistrations[0];
    expect(registration.provider.name).toBe(ROLEBOX_SKILL_PROVIDER);
    expect(registration.provider.name).toBe("rolebox");
    // The plugin registered the provider's disposer (asserted again in (e)).
    expect(registration.disposeCalls).toBe(0);

    // (b) the recorded provider's list() advertises the ACTIVE role's skill —
    // the name the bug reported as unavailable is now present.
    const candidates = await registration.provider.list({ cwd: process.cwd() });
    const names = candidates.map((c) => c.name);
    expect(names).toContain(DIRECTOR_SKILL_NAME);
    // Every candidate echoes the provider name (rc.6 validateCandidate).
    for (const candidate of candidates) {
      expect(candidate.provider).toBe("rolebox");
    }

    // (c) get() lazily loads the real SKILL.md body from disk.
    const director = candidates.find((c) => c.name === DIRECTOR_SKILL_NAME);
    expect(director).toBeDefined();
    expect(director!.path).toBe(skillPath);
    const definition = await registration.provider.get(director!, {
      cwd: process.cwd(),
    });
    expect(definition).toBeDefined();
    expect(definition!.name).toBe(DIRECTOR_SKILL_NAME);
    expect(definition!.content).toBe(DIRECTOR_SKILL_BODY);
    expect(definition!.path).toBe(skillPath);

    disposer();
  });
});

// ── (d) graceful degradation without a skills service ──────────────────────

describe("dsh plugin skill registration (d) graceful degradation", () => {
  it("activates the plugin and registers zero providers when no skills service is mounted", async () => {
    writeDirectorRoleFixture();
    seedActiveRole();

    // Headless/minimal profile: no ctx.skills service at all.
    const { ctx, skillRegistrations } = createFakeCtx({ skills: false });

    // The plugin MUST still activate (boot succeeds) — no gate on the
    // optional service.
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // The skill provider is simply not registered (no-op marker).
    expect(skillRegistrations).toHaveLength(0);

    // The boot is otherwise healthy: roles resolved and tools registered.
    expect(disposer.stats.resolved).toBeGreaterThanOrEqual(1);
    expect(disposer.stats.registeredTools).toBeGreaterThanOrEqual(1);

    disposer();
  });
});

// ── (e) disposer invokes the registration disposer exactly once ─────────────

describe("dsh plugin skill registration (e) teardown", () => {
  it("invokes the registerProvider disposer exactly once when the plugin disposer runs", async () => {
    writeDirectorRoleFixture();
    seedActiveRole();

    const { ctx, skillRegistrations } = createFakeCtx({ skills: true });
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    expect(skillRegistrations).toHaveLength(1);
    expect(skillRegistrations[0].disposeCalls).toBe(0);

    disposer();

    expect(skillRegistrations[0].disposeCalls).toBe(1);
  });
});
