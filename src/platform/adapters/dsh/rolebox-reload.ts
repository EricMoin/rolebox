/**
 * DshRoleboxReloader — dsh (DeepSeek Harness) in-process, NON-DESTRUCTIVE role
 * reload.
 *
 * Mirrors the full-reload path of the opencode-only HotReloadService
 * (`src/core/services/hot-reload-service.ts:299-385`) with the dsh-specific
 * substitutes for the platform seams that service reaches through
 * `PluginContext`:
 *
 * | HotReloadService (opencode)              | dsh substitute                          |
 * | ---------------------------------------- | --------------------------------------- |
 * | `ctx.resolvedRoles` / `ctx.roleFunctionsMap` | the SAME mutable objects injected here |
 * | `new OpencodeAgentRegistrar()` per reload | the EXISTING {@link DshAgentRegistrar} instance |
 * | `ctx.core.restartService("dispatch-service")` (:372) | `refreshRoleSnapshotTools` (subtask 3 seam: dispose + re-register the four role-snapshot tools) + `refreshSkills` (skill-catalog invalidation) |
 *
 * The dsh platform has no dispatch service to restart: graph nodes and loop
 * rounds dispatch through {@link DshDispatchAdapter}, which resolves providers
 * from the registrar at spawn time, so re-syncing the registrar IS the refresh
 * for dispatch. The two consumers that hold a *captured* snapshot of role
 * state are the role-snapshot tools (`asset_search` / `asset_inspect` /
 * `asset_validate` / `reference_search`, built from the roles array) and the
 * lazy dsh skill provider (which reads the same array at `list()` time).
 *
 * ── Why the injected state is mutated IN PLACE ─────────────────────────────
 * Downstream consumers capture the *references*: the skill provider receives
 * the roles ARRAY (`DshSkillProviderDeps.roles`), the system-prompt adapter
 * and the spawn-context provider close over the role-functions Map, and
 * `resolveAllRoles` only ever ADDS to the shared map (it never clears it, so a
 * stale entry survives a naive re-resolve). A reload therefore clears and
 * refills the existing containers instead of replacing them
 * (`hot-reload-service.ts:327-334`).
 *
 * ── Atomicity ──────────────────────────────────────────────────────────────
 * Discovery, re-resolution and agent sync run against LOCAL containers, so a
 * failure in any of them leaves the live state untouched. Every mutation after
 * that point is guarded by an in-memory rollback: if the swap or any post-swap
 * refresh throws, the previous roles, functions and open-role registry are
 * restored and the agent catalog is re-synced, so no partially-swapped state
 * is observable.
 *
 * This module performs NO filesystem or git mutation — role configs, skills
 * and memory files are only ever read.
 *
 * @module
 */

import { createSubLogger } from "../../../logger.ts";
import { discoverRoles } from "../../../loader/role-loader.ts";
import {
  resolveAllRoles,
  type ResolveContext,
} from "../../../resolver/orchestrator.ts";
import { collectOpenRoles } from "../../../resolver/open-roles.ts";
import type { OpenRoleEntry } from "../../../resolver/open-roles.ts";
import { roleOpenRegistry } from "../../../resolver/registry.ts";
import { initModelResolver } from "../../../resolver/model-resolver.ts";
import { syncAllAgents } from "../../../sync/agent-files.ts";
import { invalidateAssetIndex } from "../../../asset/asset-search.ts";
import { applyProjectConfig } from "../../../project-config.ts";
import type { RoleboxDirectories } from "../../factory.ts";
import type { IAgentRegistrar } from "../../ports/agent-registrar.ts";
import type { ResolvedFunction, ResolvedRole } from "../../../types.ts";

const log = createSubLogger("dsh-rolebox-reload");

/**
 * Result of {@link DshRoleboxReloader.reload}. Shaped like
 * `HotReloadResult` (`src/core/services/hot-reload-service.ts:32-44`) so the
 * web route can report status identically to the opencode tool.
 */
export interface DshRoleboxReloadResult {
  success: boolean;
  /** Set when the reload is disabled via env var (not an error). */
  disabled?: boolean;
  /** Error message when success is false (and not disabled). */
  error?: string;
  /** Number of roles discovered on disk. */
  discovered?: number;
  /** Number of roles successfully resolved. */
  resolved?: number;
  /** Number of discovered roles that failed to resolve. */
  skipped?: number;
}

/** Dependencies for {@link DshRoleboxReloader}. */
export interface DshRoleboxReloaderOptions {
  /** The role directories the runtime was booted from (factory.ts). */
  directories: RoleboxDirectories;
  /**
   * The workspace's MUTABLE resolved-roles array — the SAME reference the
   * runtime handed to every consumer. Mutated in place, never reassigned.
   */
  resolvedRoles: ResolvedRole[];
  /**
   * The workspace's MUTABLE roleId/subagentId → functions map — mutated in
   * place (cleared + refilled), never reassigned.
   */
  roleFunctionsMap: Map<string, ResolvedFunction[]>;
  /**
   * The EXISTING registrar instance the boot path built. Its `sync` is
   * diff/idempotent (`agent-registrar.ts:793-842`), so re-registering an
   * unchanged role is a no-op and only changed/added/removed agents are
   * touched.
   */
  registrar: IAgentRegistrar;
  /**
   * Role-snapshot tool refresh seam (subtask 3): disposes the previously
   * registered generation of `asset_search` / `asset_inspect` /
   * `asset_validate` / `reference_search` and registers a fresh one built
   * from the passed roles. This is the dsh-plugin's
   * `registerRoleSnapshotTools` handle.
   */
  refreshRoleSnapshotTools: (roles: ResolvedRole[]) => number;
  /**
   * Skill-catalog refresh seam: invalidates the dsh `ctx.skills` catalog so
   * the re-resolved roles are advertised on the next lookup. This is the
   * dsh-plugin's `refreshSkillCatalog` (a no-op when no skill provider is
   * registered, e.g. a headless profile).
   */
  refreshSkills: () => void;
  /**
   * Optional project-level default role, re-promoted after each reload
   * (mirrors `dsh-plugin.ts:948-951`).
   */
  defaultRole?: string;
}

/**
 * In-process role reloader for the dsh web plugin. Construct once per plugin
 * boot, then call {@link reload} on demand (the `POST /rolebox/reload` route).
 */
export class DshRoleboxReloader {
  private readonly directories: RoleboxDirectories;
  private readonly resolvedRoles: ResolvedRole[];
  private readonly roleFunctionsMap: Map<string, ResolvedFunction[]>;
  private readonly registrar: IAgentRegistrar;
  private readonly refreshRoleSnapshotTools: (roles: ResolvedRole[]) => number;
  private readonly refreshSkills: () => void;
  private readonly defaultRole: string | undefined;

  /** `ROLEBOX_HOT_RELOAD` kill switch, evaluated once at construction. */
  private readonly disabled: boolean;

  /** Single-flight guard: a second concurrent reload is rejected. */
  private isReloading = false;

  constructor(options: DshRoleboxReloaderOptions) {
    this.directories = options.directories;
    this.resolvedRoles = options.resolvedRoles;
    this.roleFunctionsMap = options.roleFunctionsMap;
    this.registrar = options.registrar;
    this.refreshRoleSnapshotTools = options.refreshRoleSnapshotTools;
    this.refreshSkills = options.refreshSkills;
    this.defaultRole = options.defaultRole;

    // Mirrors HotReloadService.init() (:73-81): ROLEBOX_HOT_RELOAD=false|0
    // disables the capability rather than failing it.
    this.disabled =
      process.env.ROLEBOX_HOT_RELOAD === "false" ||
      process.env.ROLEBOX_HOT_RELOAD === "0";
    if (this.disabled) {
      log.info("dsh role reload disabled by env var");
    }
  }

  /** True when the `ROLEBOX_HOT_RELOAD` kill switch disabled this reloader. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Re-discover and re-resolve every role, then refresh every consumer that
   * captured the previous role state.
   *
   * Never throws: a failure is caught and reported as `{success: false,
   * error}`, with the previous state preserved. A second concurrent call is
   * rejected by the single-flight guard.
   */
  async reload(): Promise<DshRoleboxReloadResult> {
    if (this.disabled) return { success: false, disabled: true };

    // Concurrency guard (mirrors hot-reload-service.ts:185-190).
    if (this.isReloading) {
      log.warn("Role reload skipped — another reload is already in progress");
      return { success: false, error: "reload already in progress" };
    }
    this.isReloading = true;

    try {
      return await this.performFullReload();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Role reload failed — previous state preserved", {
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    } finally {
      this.isReloading = false;
    }
  }

  /**
   * Full re-discovery + re-resolution (mirrors
   * `hot-reload-service.ts:299-385`).
   */
  private async performFullReload(): Promise<DshRoleboxReloadResult> {
    log.info("Role reload — full re-discovery and re-resolution");

    // 1. Re-initialize the model resolver so edits to the platform config take
    //    effect without a process restart (:302-304).
    initModelResolver(this.directories.configDir);

    // 2. Re-discover roles from disk.
    const newRoles = await discoverRoles(this.directories.roleboxDir);

    // 3. Resolve into LOCAL containers — the shared resolvedRoles array and
    //    roleFunctionsMap stay untouched until every fallible step succeeded
    //    (:309-320).
    const localRoleFunctionsMap = new Map<string, ResolvedFunction[]>();
    const resolverCtx: ResolveContext = {
      roleboxDir: this.directories.roleboxDir,
      globalSkillsDir: this.directories.globalSkillsDir,
      configDir: this.directories.configDir,
      builtinDir: this.directories.builtinDir,
      roleFunctionsMap: localRoleFunctionsMap,
    };
    const newResolvedRoles = await resolveAllRoles(newRoles, resolverCtx);

    // 4. Sync the agent catalog against the SAME registrar instance (:323).
    //    The registrar diffs the new definitions against its catalog, so
    //    unchanged agents are left registered untouched.
    await syncAllAgents(newResolvedRoles, this.registrar);

    // Snapshot the pre-swap state so ANY throw from here on is rolled back.
    const previousRoles = [...this.resolvedRoles];
    const previousFunctions = new Map(this.roleFunctionsMap);
    const previousOpenRegistry = new Map(roleOpenRegistry);

    try {
      // 5. Swap the resolved roles in place, keeping the array reference
      //    stable for every consumer that captured it (:326-328).
      this.resolvedRoles.length = 0;
      this.resolvedRoles.push(...newResolvedRoles);

      // 5.5. Atomically swap the shared functions map (:330-334).
      this.roleFunctionsMap.clear();
      for (const [key, value] of localRoleFunctionsMap) {
        this.roleFunctionsMap.set(key, value);
      }

      // 5.6. Rebuild the open-roles registry from the freshly resolved roles
      //      (:336-343). roleOpenRegistry is module-level shared state and
      //      this reloader is its only writer on the dsh path.
      const newOpenRegistry = collectOpenRoles(newResolvedRoles);
      roleOpenRegistry.clear();
      for (const [key, value] of newOpenRegistry) {
        roleOpenRegistry.set(key, value);
      }

      // 6. Invalidate the asset-search module-level index (:365). Required
      //    BECAUSE the roles array is mutated in place: the index is keyed by
      //    array reference identity, so an un-invalidated cache would keep
      //    serving the pre-reload assets.
      invalidateAssetIndex();

      // 7. Re-apply the project default role, mirroring the boot promotion
      //    (dsh-plugin.ts:948-951) on the freshly resolved set.
      if (this.defaultRole) {
        applyProjectConfig(this.resolvedRoles, { defaultRole: this.defaultRole });
      }

      // 8. dsh substitute for restartService("dispatch-service") (:367-372):
      //    dispose + re-register the role-snapshot tool generation, then
      //    refresh the skill catalog. There is no dispatch service on dsh.
      this.refreshRoleSnapshotTools(this.resolvedRoles);
      this.refreshSkills();
    } catch (err) {
      // Roll the swap back so no partially-swapped state is observable.
      this.restore(previousRoles, previousFunctions, previousOpenRegistry);
      // The role-snapshot generation might already have been rebuilt from the
      // NEW roles — its asset closure is captured at build time, so it must be
      // rebuilt again from the restored array to stay consistent. Best effort:
      // if the seam failed once, a second failure is logged, never rethrown
      // over the original error.
      try {
        this.refreshRoleSnapshotTools(this.resolvedRoles);
      } catch (rebuildErr) {
        log.warn("role-snapshot rollback failed", {
          error: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr),
        });
      }
      try {
        await syncAllAgents(previousRoles, this.registrar);
      } catch (rollbackErr) {
        log.warn("agent catalog rollback failed", {
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
      throw err;
    }

    const discovered = newRoles.size;
    const resolved = newResolvedRoles.length;
    const skipped = discovered - resolved;
    log.info("Role reload complete", { discovered, resolved, skipped });
    return { success: true, discovered, resolved, skipped };
  }

  /** Restore the pre-swap in-memory state, in place. */
  private restore(
    previousRoles: ResolvedRole[],
    previousFunctions: Map<string, ResolvedFunction[]>,
    previousOpenRegistry: Map<string, OpenRoleEntry>,
  ): void {
    this.resolvedRoles.length = 0;
    this.resolvedRoles.push(...previousRoles);

    this.roleFunctionsMap.clear();
    for (const [key, value] of previousFunctions) {
      this.roleFunctionsMap.set(key, value);
    }

    roleOpenRegistry.clear();
    for (const [key, value] of previousOpenRegistry) {
      roleOpenRegistry.set(key, value);
    }

    // The refresh seam may have rebuilt the role-snapshot tools — and thereby
    // re-warmed the asset index — from the NEW roles before a later step threw.
    // Invalidate once more so the index is rebuilt lazily from the restored
    // array. The tool generation itself holds that array by reference, so it
    // needs no re-registration to observe the rollback.
    invalidateAssetIndex();

    log.warn("Role reload rolled back — previous state restored");
  }
}
