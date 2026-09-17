/// <reference types="bun-types" />

/**
 * DshRoleboxReloader — src/platform/adapters/dsh/rolebox-reload.ts
 *
 * Verifies the dsh in-process, non-destructive role reload:
 *   - success: roles are re-resolved from disk INTO the captured array (same
 *     reference), the shared functions map and the open-role registry are
 *     swapped in place, the SAME registrar instance is re-synced, and the
 *     role-snapshot tool generation is rebuilt so it serves the NEW assets —
 *     which also proves the asset-index invalidation the in-place mutation
 *     requires (the index is keyed by array reference identity)
 *   - single-flight: a second concurrent call is rejected by the guard
 *   - kill switch: ROLEBOX_HOT_RELOAD=false|0 disables the reload without
 *     touching any state
 *   - mid-reload throw: the previous in-memory state is restored (roles,
 *     functions map, open-role registry, agent catalog)
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshRoleboxReloader } from "../../src/platform/adapters/dsh/rolebox-reload.ts";
import type { DshRoleboxReloadResult } from "../../src/platform/adapters/dsh/rolebox-reload.ts";
import { buildRoleSnapshotTools } from "../../src/platform/tool-assembly.ts";
import { DshToolFactory } from "../../src/platform/adapters/dsh/tool-factory.ts";
import type {
  DshToolDefinition,
  DshToolRunContext,
} from "../../src/platform/adapters/dsh/tool-factory.ts";
import type { IAgentRegistrar } from "../../src/platform/ports/agent-registrar.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";
import { RoleMode, SkillScope } from "../../src/constants.ts";
import { roleOpenRegistry } from "../../src/resolver/registry.ts";
import type { OpenRoleEntry } from "../../src/resolver/open-roles.ts";
import type { ResolvedFunction, ResolvedRole } from "../../src/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

let roleboxDir: string;
let configDir: string;
let globalSkillsDir: string;
let builtinDir: string;
let originalHotReloadEnv: string | undefined;

beforeEach(() => {
  roleboxDir = mkdtempSync(join(tmpdir(), "rolebox-dsh-reload-"));
  configDir = join(roleboxDir, "config");
  globalSkillsDir = join(roleboxDir, "global-skills");
  // Empty built-in dir: the default function names simply do not resolve,
  // which keeps the fixture hermetic (no dependency on the package's own
  // functions/ directory) without failing role resolution.
  builtinDir = join(roleboxDir, "builtin");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(globalSkillsDir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });

  originalHotReloadEnv = process.env.ROLEBOX_HOT_RELOAD;
  delete process.env.ROLEBOX_HOT_RELOAD;
});

afterEach(() => {
  if (originalHotReloadEnv === undefined) delete process.env.ROLEBOX_HOT_RELOAD;
  else process.env.ROLEBOX_HOT_RELOAD = originalHotReloadEnv;
  roleOpenRegistry.clear();
  rmSync(roleboxDir, { recursive: true, force: true });
});

/** Directories fixture mirroring resolveRoleboxDirectories()'s shape. */
function directories() {
  return { roleboxDir, globalSkillsDir, configDir, builtinDir };
}

/** Write a role dir with role.yaml plus its role-local skills/<name>/SKILL.md. */
function writeRole(roleId: string, skillNames: string[], open = false): void {
  const dir = join(roleboxDir, roleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "role.yaml"),
    [
      "name: " + roleId,
      "description: reload test role " + roleId,
      "prompt: You are " + roleId + ".",
      ...(open ? ["open: true"] : []),
      "skills:",
      ...skillNames.map((name) => "  - " + name),
    ].join("\n"),
    "utf-8",
  );
  for (const name of skillNames) {
    const skillDir = join(dir, "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: " + name,
        "description: The " + name + " asset.",
        "---",
        "# " + name,
        "",
      ].join("\n"),
      "utf-8",
    );
  }
}

/** Minimal pre-reload ResolvedRole fixture (a role that no longer exists on disk). */
function staleRole(roleId: string, skillName: string): ResolvedRole {
  return {
    id: roleId,
    config: {
      name: roleId,
      description: "stale pre-reload role",
      prompt: "You are stale.",
    },
    prompt: "You are stale.",
    skills: [
      {
        name: skillName,
        description: "The " + skillName + " asset.",
        scope: SkillScope.Rolebox,
        filePath: join(roleboxDir, roleId, "skills", skillName, "SKILL.md"),
        references: [],
      },
    ],
    functions: [],
    references: [],
    subagents: [],
  } as ResolvedRole;
}

/** Diff/idempotent IAgentRegistrar double, mirroring DshAgentRegistrar.sync. */
interface RegistrarSpy extends IAgentRegistrar {
  readonly syncCalls: AgentDefinition[][];
  readonly catalog: Map<string, AgentDefinition>;
}

function createRegistrarSpy(): RegistrarSpy {
  const catalog = new Map<string, AgentDefinition>();
  const syncCalls: AgentDefinition[][] = [];
  return {
    syncCalls,
    catalog,
    async register(agents: AgentDefinition[]): Promise<void> {
      for (const agent of agents) catalog.set(agent.id, agent);
    },
    async unregister(agentIds: string[]): Promise<void> {
      for (const id of agentIds) catalog.delete(id);
    },
    async sync(agents: AgentDefinition[]) {
      syncCalls.push(agents);
      const next = new Map(agents.map((agent) => [agent.id, agent]));
      const added: string[] = [];
      const removed: string[] = [];
      const unchanged: string[] = [];
      for (const [id, current] of catalog) {
        const incoming = next.get(id);
        if (!incoming) removed.push(id);
        else if (JSON.stringify(current) === JSON.stringify(incoming)) unchanged.push(id);
        else added.push(id);
      }
      for (const id of next.keys()) {
        if (!catalog.has(id)) added.push(id);
      }
      for (const id of removed) catalog.delete(id);
      for (const id of added) catalog.set(id, next.get(id)!);
      return { added, removed, unchanged };
    },
    async list(): Promise<string[]> {
      return [...catalog.keys()].sort();
    },
  };
}

/** Exec fixture mirroring tests/platform/dsh-role-snapshot-tools.test.ts:194-201. */
function makeExec(): DshToolRunContext {
  return {
    signal: new AbortController().signal,
    callId: "rolebox-reload-call-1",
    deferContext: () => {},
    concludeTurn: () => {},
  };
}

/** Compile the four role-snapshot tools through the dsh tool factory. */
function compileSnapshot(
  roles: ResolvedRole[],
): Record<string, DshToolDefinition> {
  return new DshToolFactory().compileAll(
    buildRoleSnapshotTools(roles),
  ) as Record<string, DshToolDefinition>;
}

/** Execute a compiled asset_search definition. */
async function runAssetSearch(
  tools: Record<string, DshToolDefinition>,
  query: string,
): Promise<string> {
  return String(await tools.asset_search.execute({ query }, makeExec()));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DshRoleboxReloader", () => {
  it("re-resolves roles in place and refreshes every captured consumer", async () => {
    writeRole("live-role", ["fresh-skill"]);

    // Captured pre-reload state: a role that is gone from disk, a matching
    // functions-map entry and a matching agent catalog entry.
    const staleFunctions: ResolvedFunction[] = [];
    const roles: ResolvedRole[] = [staleRole("stale-role", "stale-skill")];
    const functions = new Map<string, ResolvedFunction[]>([
      ["stale-role", staleFunctions],
    ]);
    const registrar = createRegistrarSpy();
    await registrar.sync([
      {
        id: "stale-role",
        name: "stale-role",
        description: "stale",
        systemPrompt: "stale",
        mode: RoleMode.Primary,
      },
    ]);

    // Boot generation: the snapshot tools bind to the STALE array, warming the
    // module-level asset index with the stale role's assets.
    let tools = compileSnapshot(roles);
    expect(await runAssetSearch(tools, "stale-skill")).toContain("stale-role");

    const snapshotCalls: ResolvedRole[][] = [];
    let skillsRefreshes = 0;
    const reloader = new DshRoleboxReloader({
      directories: directories(),
      resolvedRoles: roles,
      roleFunctionsMap: functions,
      registrar,
      refreshRoleSnapshotTools: (nextRoles) => {
        snapshotCalls.push(nextRoles);
        tools = compileSnapshot(nextRoles);
        return Object.keys(tools).length;
      },
      refreshSkills: () => {
        skillsRefreshes++;
      },
    });

    const result: DshRoleboxReloadResult = await reloader.reload();

    expect(result).toEqual({
      success: true,
      discovered: 1,
      resolved: 1,
      skipped: 0,
    });

    // The captured array reference is preserved; only its contents were swapped.
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe("live-role");
    expect(roles[0].skills.map((skill) => skill.name)).toEqual(["fresh-skill"]);

    // The shared functions map is swapped in place too (stale keys dropped).
    expect(functions.has("live-role")).toBe(true);
    expect(functions.has("stale-role")).toBe(false);

    // The SAME registrar instance was re-synced (seed + reload).
    expect(registrar.syncCalls).toHaveLength(2);
    expect([...registrar.catalog.keys()]).toEqual(["live-role"]);

    // The role-snapshot generation was rebuilt from the SAME array, and the
    // skill catalog was refreshed exactly once.
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toBe(roles);
    expect(skillsRefreshes).toBe(1);

    // The rebuilt tools serve the NEW snapshot. The roles array is the SAME
    // reference as the boot generation's, so without the asset-index
    // invalidation the stale cache (keyed by reference identity) would still
    // answer with the pre-reload role here.
    expect(await runAssetSearch(tools, "fresh-skill")).toContain("live-role");
    expect(await runAssetSearch(tools, "stale-skill")).not.toContain("stale-role");
  });

  it("rejects a second concurrent reload with the single-flight guard", async () => {
    writeRole("live-role", ["fresh-skill"]);

    const roles: ResolvedRole[] = [];
    const registrar = createRegistrarSpy();
    const snapshotCalls: ResolvedRole[][] = [];
    const reloader = new DshRoleboxReloader({
      directories: directories(),
      resolvedRoles: roles,
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      registrar,
      refreshRoleSnapshotTools: (nextRoles) => {
        snapshotCalls.push(nextRoles);
        return 4;
      },
      refreshSkills: () => {},
    });

    // reload() runs synchronously up to its first await, so the guard is
    // already held when the second call is issued.
    const first = reloader.reload();
    const second: DshRoleboxReloadResult = await reloader.reload();
    expect(second).toEqual({
      success: false,
      error: "reload already in progress",
    });

    expect((await first).success).toBe(true);
    expect(snapshotCalls).toHaveLength(1);

    // The guard is released once the first reload settles.
    expect((await reloader.reload()).success).toBe(true);
    expect(snapshotCalls).toHaveLength(2);
  });

  it("returns a disabled result under the ROLEBOX_HOT_RELOAD kill switch", async () => {
    writeRole("live-role", ["fresh-skill"]);

    for (const value of ["false", "0"]) {
      process.env.ROLEBOX_HOT_RELOAD = value;
      const roles: ResolvedRole[] = [staleRole("stale-role", "stale-skill")];
      const registrar = createRegistrarSpy();
      const snapshotCalls: ResolvedRole[][] = [];
      let skillsRefreshes = 0;
      const reloader = new DshRoleboxReloader({
        directories: directories(),
        resolvedRoles: roles,
        roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
        registrar,
        refreshRoleSnapshotTools: (nextRoles) => {
          snapshotCalls.push(nextRoles);
          return 4;
        },
        refreshSkills: () => {
          skillsRefreshes++;
        },
      });

      const disabledResult: DshRoleboxReloadResult = await reloader.reload();
      expect(reloader.isDisabled).toBe(true);
      expect(disabledResult).toEqual({ success: false, disabled: true });

      // Nothing was touched.
      expect(roles).toHaveLength(1);
      expect(roles[0].id).toBe("stale-role");
      expect(registrar.syncCalls).toHaveLength(0);
      expect(snapshotCalls).toHaveLength(0);
      expect(skillsRefreshes).toBe(0);
    }

    process.env.ROLEBOX_HOT_RELOAD = "true";
    const reloader = new DshRoleboxReloader({
      directories: directories(),
      resolvedRoles: [],
      roleFunctionsMap: new Map<string, ResolvedFunction[]>(),
      registrar: createRegistrarSpy(),
      refreshRoleSnapshotTools: () => 4,
      refreshSkills: () => {},
    });
    expect(reloader.isDisabled).toBe(false);
  });

  it("restores the previous state when a refresh throws mid-reload", async () => {
    writeRole("live-role", ["fresh-skill"], true);

    const stale = staleRole("stale-role", "stale-skill");
    const staleFunctions: ResolvedFunction[] = [];
    const roles: ResolvedRole[] = [stale];
    const functions = new Map<string, ResolvedFunction[]>([
      ["stale-role", staleFunctions],
    ]);
    const staleOpenEntry: OpenRoleEntry = {
      roleId: "stale-role",
      name: "stale-role",
      description: "stale pre-reload role",
      exports: [],
    };
    roleOpenRegistry.clear();
    roleOpenRegistry.set("stale-role", staleOpenEntry);

    const registrar = createRegistrarSpy();
    await registrar.sync([
      {
        id: "stale-role",
        name: "stale-role",
        description: "stale",
        systemPrompt: "stale",
        mode: RoleMode.Primary,
      },
    ]);

    // The refresh receives the live array by reference, so the ids must be
    // captured AT CALL TIME — after the rollback the array holds the old roles.
    const refreshedIds: string[][] = [];
    let skillsRefreshes = 0;
    const reloader = new DshRoleboxReloader({
      directories: directories(),
      resolvedRoles: roles,
      roleFunctionsMap: functions,
      registrar,
      // Throws AFTER the swap: the new roles are already in place, so only the
      // rollback can preserve the previous state.
      refreshRoleSnapshotTools: (nextRoles) => {
        refreshedIds.push(nextRoles.map((role) => role.id));
        throw new Error("role-snapshot re-registration failed");
      },
      refreshSkills: () => {
        skillsRefreshes++;
      },
    });

    const result: DshRoleboxReloadResult = await reloader.reload();

    expect(result).toEqual({
      success: false,
      error: "role-snapshot re-registration failed",
    });

    // The swap DID happen (the refresh saw the freshly resolved role), and the
    // rollback re-ran the seam once more against the restored array.
    expect(refreshedIds).toEqual([["live-role"], ["stale-role"]]);

    // ...and was rolled back: the captured containers are the same objects and
    // hold the same contents as before the reload.
    expect(roles).toHaveLength(1);
    expect(roles[0]).toBe(stale);
    expect(functions.get("stale-role")).toBe(staleFunctions);
    expect([...functions.keys()]).toEqual(["stale-role"]);
    expect(roleOpenRegistry.get("stale-role")).toBe(staleOpenEntry);
    expect([...roleOpenRegistry.keys()]).toEqual(["stale-role"]);

    // The agent catalog was re-synced back to the previous definitions.
    expect([...registrar.catalog.keys()]).toEqual(["stale-role"]);

    // The skill refresh never ran (the throw came first).
    expect(skillsRefreshes).toBe(0);

    // The guard is released, so a later attempt is not stuck "in progress".
    const retry = await reloader.reload();
    expect(retry.success).toBe(false);
    expect(retry.error).toBe("role-snapshot re-registration failed");
  });

  it("restores the previous state when the skill refresh throws after the tool rebuild", async () => {
    writeRole("live-role", ["fresh-skill"]);

    const stale = staleRole("stale-role", "stale-skill");
    const roles: ResolvedRole[] = [stale];
    const functions = new Map<string, ResolvedFunction[]>([["stale-role", []]]);
    const registrar = createRegistrarSpy();

    const refreshedIds: string[][] = [];
    const generations: Array<Record<string, DshToolDefinition>> = [];
    const reloader = new DshRoleboxReloader({
      directories: directories(),
      resolvedRoles: roles,
      roleFunctionsMap: functions,
      registrar,
      refreshRoleSnapshotTools: (nextRoles) => {
        refreshedIds.push(nextRoles.map((role) => role.id));
        const compiled = compileSnapshot(nextRoles);
        generations.push(compiled);
        return Object.keys(compiled).length;
      },
      // Throws AFTER the role-snapshot generation was rebuilt from the new
      // roles and the asset index was re-warmed with their assets.
      refreshSkills: () => {
        throw new Error("skill catalog refresh failed");
      },
    });

    const result: DshRoleboxReloadResult = await reloader.reload();

    expect(result).toEqual({
      success: false,
      error: "skill catalog refresh failed",
    });
    expect(refreshedIds).toEqual([["live-role"], ["stale-role"]]);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toBe(stale);
    expect([...functions.keys()]).toEqual(["stale-role"]);

    // The generation that remains registered was rebuilt from the restored
    // array on rollback, so it serves the previous roles again — the failed
    // attempt's generation (which captured the NEW roles' assets in its
    // closure) was disposed.
    const currentTools = generations.at(-1)!;
    expect(await runAssetSearch(currentTools, "stale-skill")).toContain("stale-role");
    expect(await runAssetSearch(currentTools, "fresh-skill")).not.toContain("live-role");
  });
});
