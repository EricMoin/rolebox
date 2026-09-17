/// <reference types="bun-types" />

/**
 * Role-snapshot tool registration seam — src/platform/tool-assembly.ts
 * (ROLE_SNAPSHOT_TOOL_KEYS / buildRoleSnapshotTools) plus the
 * registerRoleSnapshotTools handle on the apply() disposer (src/dsh-plugin.ts).
 *
 * Verifies:
 *   - buildRoleSnapshotTools advertises exactly the four role-snapshot keys
 *   - boot registration is not doubled: apply() over a tools registry that
 *     THROWS on a duplicate name resolves, with each of the four registered
 *     exactly once
 *   - the dispose-then-re-register path serves the NEW roles after a swap: the
 *     previously registered asset_search definition is replaced, so it searches
 *     the new snapshot's assets and no longer the old ones
 *
 * The duplicate-throwing fake registry mirrors the host registry:
 * packages/core/tools/src/index.ts ToolRuntime.register() inserts through
 * packages/core/scope/src/store.ts NamedEntries.insert(), which throws when the
 * global name is already present, and register() returns the effect disposer
 * whose synchronous undo frees that name.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ROLE_SNAPSHOT_TOOL_KEYS,
  buildRoleSnapshotTools,
} from "../../src/platform/tool-assembly.ts";
import { apply } from "../../src/dsh-plugin.ts";
import type { DshPluginConfig, DshPluginContext } from "../../src/dsh-plugin.ts";
import type {
  DshToolDefinition,
  DshToolRunContext,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { DshSubagentDispatchRuntime } from "../../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentProvider } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshSessionStoreLike } from "../../src/platform/adapters/dsh/session.ts";
import { SkillScope } from "../../src/constants.ts";
import type { ResolvedRole } from "../../src/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

/** The four keys spelled out, so the key-set assertion cannot drift with it. */
const EXPECTED_ROLE_SNAPSHOT_KEYS = [
  "asset_search",
  "asset_inspect",
  "asset_validate",
  "reference_search",
];

/** Minimal ResolvedRole fixture for a synthetic (post-swap) snapshot. */
function makeResolvedRole(roleId: string, skillName: string): ResolvedRole {
  return {
    id: roleId,
    config: {
      name: "Snapshot Role",
      description: "role-snapshot reload seam test role",
      prompt: "You are the snapshot role.",
    },
    prompt: "You are the snapshot role.",
    skills: [
      {
        name: skillName,
        description: "The " + skillName + " asset.",
        scope: SkillScope.Rolebox,
        filePath: "/tmp/roles/" + roleId + "/skills/" + skillName + "/SKILL.md",
        references: [],
      },
    ],
    functions: [],
    references: [],
    subagents: [],
  } as ResolvedRole;
}

/** Write a role dir with role.yaml plus its role-local skills/<name>/SKILL.md. */
function writeRoleWithSkills(roleId: string, skillNames: string[]): void {
  const roleDir = join(tmpDir, roleId);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    join(roleDir, "role.yaml"),
    [
      "name: Snapshot Role",
      "description: role-snapshot reload seam test role",
      "prompt: You are the snapshot role.",
      "skills:",
      ...skillNames.map((skillName) => "  - " + skillName),
    ].join("\n"),
    "utf-8",
  );
  for (const skillName of skillNames) {
    const skillDir = join(roleDir, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: " + skillName,
        "description: The " + skillName + " asset.",
        "---",
        "# " + skillName,
        "",
      ].join("\n"),
      "utf-8",
    );
  }
}

// ── Fake cordis ctx double ─────────────────────────────────────────────────
//
// Mirrors the minimal harness in tests/dsh-plugin.test.ts:177-312 with ONE
// difference: tools.register rejects a duplicate name exactly like the host
// registry. A boot that registered any of the four role-snapshot tools twice
// therefore fails here instead of silently succeeding.

function createFakeCtx() {
  const registeredTools: DshToolDefinition[] = [];
  const providers = new Map<string, DshSubagentProvider>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const tools = {
    registeredTools,
    register(definition: DshToolDefinition): () => void {
      if (registeredTools.some((tool) => tool.name === definition.name)) {
        throw new Error('duplicate tool name "' + definition.name + '"');
      }
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
    async start(name: string): Promise<never> {
      throw new Error('unexpected ctx.subagents.start("' + name + '")');
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
    get: () => undefined,
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((entry) => entry !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };

  return { ctx, tools, providers, listeners };
}

/** Exec fixture mirroring tests/platform/dsh-tool-factory.test.ts:88-93. */
function makeExec(): DshToolRunContext {
  return {
    signal: new AbortController().signal,
    callId: "role-snapshot-call-1",
    deferContext: () => {},
    concludeTurn: () => {},
  };
}

/** The single currently registered definition for a tool name. */
function currentTool(
  registry: { registeredTools: DshToolDefinition[] },
  name: string,
): DshToolDefinition {
  const matches = registry.registeredTools.filter((tool) => tool.name === name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Execute the CURRENTLY registered asset_search definition. */
async function runAssetSearch(
  registry: { registeredTools: DshToolDefinition[] },
  query: string,
): Promise<string> {
  const result = await currentTool(registry, "asset_search").execute(
    { query },
    makeExec(),
  );
  return String(result);
}

// ── Tests ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-role-snapshot-"));
  originalCwd = process.cwd();
  // apply() resolves workspace-relative state (graph state dir, active-role
  // sidecar) from process.cwd(); run inside the temp dir so the test never
  // writes into the checkout.
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("role-snapshot tool registration seam", () => {
  it("advertises exactly the four role-snapshot tool keys", () => {
    const built = buildRoleSnapshotTools([
      makeResolvedRole("snapshot-role", "alpha-skill"),
    ]);

    expect(Object.keys(built)).toEqual(Object.keys(ROLE_SNAPSHOT_TOOL_KEYS));
    expect([...Object.keys(built)].sort()).toEqual(
      [...EXPECTED_ROLE_SNAPSHOT_KEYS].sort(),
    );
    for (const def of Object.values(built)) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.execute).toBe("function");
    }
  });

  it("registers each role-snapshot tool exactly once at boot", async () => {
    writeRoleWithSkills("snapshot-role", ["alpha-skill"]);
    const { ctx, tools } = createFakeCtx();

    // The duplicate-throwing registry makes a double registration of any of the
    // four names reject here.
    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    for (const key of EXPECTED_ROLE_SNAPSHOT_KEYS) {
      expect(
        tools.registeredTools.filter((tool) => tool.name === key),
      ).toHaveLength(1);
    }
    // The stats count still matches the live registry exactly.
    expect(disposer.stats.registeredTools).toBe(tools.registeredTools.length);

    disposer();
    expect(tools.registeredTools).toHaveLength(0);
  });

  it("serves the NEW roles after dispose-then-re-register", async () => {
    writeRoleWithSkills("snapshot-role", ["alpha-skill"]);
    const { ctx, tools } = createFakeCtx();

    const disposer = await apply(ctx, { roleboxDir: tmpDir } as DshPluginConfig);

    // Boot generation: the on-disk alpha-skill is the searchable asset.
    expect(await runAssetSearch(tools, "alpha")).toContain("alpha-skill");
    expect(await runAssetSearch(tools, "beta")).not.toContain("beta-skill");

    // Swap to a snapshot whose assets differ. Re-registering the same four
    // names succeeds only because the previous generation was disposed FIRST —
    // tools.register throws on a duplicate name.
    const registered = disposer.registerRoleSnapshotTools([
      makeResolvedRole("snapshot-role", "beta-skill"),
    ]);
    expect(registered).toBe(EXPECTED_ROLE_SNAPSHOT_KEYS.length);
    for (const key of EXPECTED_ROLE_SNAPSHOT_KEYS) {
      expect(
        tools.registeredTools.filter((tool) => tool.name === key),
      ).toHaveLength(1);
    }

    // The CURRENTLY registered definition serves the new snapshot only.
    expect(await runAssetSearch(tools, "beta")).toContain("beta-skill");
    expect(await runAssetSearch(tools, "alpha")).not.toContain("alpha-skill");

    disposer();
    expect(tools.registeredTools).toHaveLength(0);
  });
});
