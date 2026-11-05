import type { PluginService } from "../service.ts";
import { SERVICE_NAMES, type ServiceName } from "../service-names.ts";
import type { PluginContext } from "../context.ts";
import { createSubLogger } from "../../logger.ts";
import { clearExtensionModuleCache } from "../../extensions/loader.ts";
import { realpathSync, watch, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { readTextFile } from "../../utils/fs.ts";
import { discoverRoles } from "../../loader/role-loader.ts";
import { resolveAllRoles, resolvePublicAgents, type ResolveContext } from "../../resolver/orchestrator.ts";
import { collectOpenRoles } from "../../resolver/open-roles.ts";
import { roleOpenRegistry } from "../../resolver/registry.ts";
import { initModelResolver } from "../../resolver/model-resolver.ts";
import { resolveSkills } from "../../resolver/skill-resolver.ts";
import { buildAgentPrompt } from "../../prompt/builder.ts";
import { syncAllAgents } from "../../sync/agent-files.ts";
import { syncSkillSymlinks } from "../../sync/skill-symlinks.ts";
import type { ResolvedFunction, ResolvedRole, RoleConfig } from "../../types.ts";
import { ROLE_YAML } from "../../constants.ts";
import { invalidateAssetIndex } from "../../asset/asset-search.ts";
import { toPosixPath } from "../../utils/paths.ts";

const log = createSubLogger(SERVICE_NAMES.hotReload);

const DEBOUNCE_MS = 500;

/** Settle window to absorb late fsevents after symlink writes during reload. */
const SETTLE_MS = 200;

/**
 * Sealed outcome of a hot reload, returned by triggerReload() so callers
 * (tools, tests, routes) can report status accurately. Exactly one arm
 * describes what happened:
 *
 * - `reloaded` — the reload ran; `scope` names what actually refreshed.
 *   `fast` re-resolved the skill files of exactly one role; `full`
 *   re-discovered and re-resolved every role.
 * - `disabled` — hot reload is off via env var; nothing was attempted and
 *   this is NOT an error.
 * - `busy` — another reload already holds the single-flight guard; nothing
 *   was attempted and this is NOT an error.
 * - `failed` — the attempt failed; `reason` says why and the previous state
 *   was preserved.
 */
export type HotReloadResult =
  | { kind: "reloaded"; scope: "full"; discovered: number; resolved: number; skipped: number }
  | { kind: "reloaded"; scope: "fast"; roleId: string; skills: number }
  | { kind: "disabled" }
  | { kind: "busy" }
  | { kind: "failed"; reason: string };
const WATCH_EXTENSIONS = new Set([
  ".md",
  ".yaml",
  ".yml",
  ".js",
  ".ts",
  ".json",
  ".mjs",
  ".cjs",
]);

export class HotReloadService implements PluginService {
  readonly name: ServiceName = SERVICE_NAMES.hotReload;
  readonly dependencies: readonly ServiceName[] = [];

  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private ctx!: PluginContext;
  private disabled = false;
  private reloadSuppressUntil: number = 0;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private isReloading = false;

  /** Tracks the list of file changes since last reload for incremental path selection. */
  private pendingChanges: Array<{ watchedDir: string; filename: string }> = [];
  /** Cache of role.yaml content hashes for detecting which roles actually changed. */
  private roleHashCache = new Map<string, string>();
  /** Latches the "declared file sync but injected no registrar" warning to one line. */
  private agentSyncWarned = false;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Check env var: ROLEBOX_HOT_RELOAD=false disables hot reload
    if (process.env.ROLEBOX_HOT_RELOAD === "false" || process.env.ROLEBOX_HOT_RELOAD === "0") {
      this.disabled = true;
      log.info("Hot reload disabled by env var");
      return;
    }

    // Defer watcher creation to avoid:
    // 1. Blocking plugin-service init on macOS where recursive FSEvents setup
    //    can be slow on certain directory trees
    // 2. Triggering a hot-reload from the initial FSEvents event flood during
    //    test execution, which caused test timeouts as the reload re-resolves
    //    all roles and restarts services in the background
    this.initTimer = setTimeout(() => {
      this.initTimer = undefined;
      void this.startWatchers();
    }, 0);
  }

  private startWatchers(): void {
    // Collect directories to watch: workspace + config dirs from resolved roles
    const dirsToWatch = new Set<string>();

    // Watch the raw directory (workspace root)
    dirsToWatch.add(this.ctx.rawDirectory);

    // Watch the normalized directory (may differ if symlinked)
    if (this.ctx.directory) {
      dirsToWatch.add(this.ctx.directory);
    }

    // Watch the rolebox role directory explicitly if available
    if (this.ctx.roleboxDir) {
      dirsToWatch.add(this.ctx.roleboxDir);
    }

    // Watch the opencode config directory (global skills + functions live here)
    if (this.ctx.configDir) {
      dirsToWatch.add(this.ctx.configDir);
    }

    // Watch the global skills directory explicitly (may differ from configDir)
    if (this.ctx.globalSkillsDir) {
      dirsToWatch.add(this.ctx.globalSkillsDir);
    }

    for (const dir of dirsToWatch) {
      try {
        // Windows notifications resolve 8.3 aliases, so the watcher must use their canonical path.
        const watchDirectory = process.platform === "win32" ? realpathSync.native(dir) : dir;
        const watcher = watch(watchDirectory, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const ext = filename.slice(filename.lastIndexOf("."));
          if (!WATCH_EXTENSIONS.has(ext)) return;
          this.onFileChange(dir, filename);
        });
        watcher.on("error", (err) => {
          log.warn("File watcher error", {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        this.watchers.push(watcher);
        log.debug("Watching directory for hot reload", { dir });
      } catch (err) {
        log.warn("Failed to watch directory", {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.watchers.length > 0) {
      log.info("Hot reload service initialized", { watchedDirs: this.watchers.length });
    }

  }
  private scheduleReload(): void {
    if (this.disabled) return;
    if (Date.now() < this.reloadSuppressUntil) return;

    // Debounce: reset timer on each change
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (Date.now() < this.reloadSuppressUntil) return;
      void this.performReload();
    }, DEBOUNCE_MS);
  }

  /**
   * Public trigger to force a hot reload. If disabled, returns
   * `{ kind: "disabled" }` without attempting anything.
   * Useful for P2 tools to programmatically trigger a reload and report status.
   */
  async triggerReload(): Promise<HotReloadResult> {
    if (this.disabled) return { kind: "disabled" };
    return this.performReload();
  }

  private async performReload(): Promise<HotReloadResult> {
    if (this.disabled) return { kind: "disabled" };

    // Guard: we need the resolver context to reload
    if (!this.ctx.roleboxDir || !this.ctx.globalSkillsDir || !this.ctx.configDir || !this.ctx.builtinDir) {
      log.warn("Hot reload aborted: resolver context fields not set on PluginContext");
      return { kind: "failed", reason: "resolver context fields not set on PluginContext" };
    }

    // Concurrency guard: if a reload is already in progress, bail
    if (this.isReloading) {
      log.warn("Hot reload skipped — another reload is already in progress");
      return { kind: "busy" };
    }
    this.isReloading = true;

    // Suppress watcher-triggered reloads during our own symlink writes
    this.reloadSuppressUntil = Number.MAX_SAFE_INTEGER;

    try {
      // Classify accumulated changes to select the appropriate reload path
      const classification = this.classifyChanges();
      log.info("Hot reload triggered", { changes: this.pendingChanges.length, path: classification.type, roleIds: classification.roleIds });

      if (classification.type === "fast" && classification.roleIds.length === 1) {
        return await this.performFastReload(classification.roleIds[0]);
      }

      // Medium or full path — full re-discovery and re-resolution
      return await this.performFullReload();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Hot reload failed — previous state preserved", { error: errorMsg });
      return { kind: "failed", reason: errorMsg };
    } finally {
      this.pendingChanges = [];
      this.isReloading = false;
    }
  }

  /**
   * Fast path: Only skill files changed within a single role.
   * Re-resolves skills for that role, rebuilds the agent prompt,
   * updates the agent registry, and syncs skill symlinks.
   * Does NOT restart dispatch-service.
   */
  private async performFastReload(roleId: string): Promise<HotReloadResult> {
    log.info("Fast reload — re-resolving skills for role", { roleId });

    // Find the existing resolved role
    const existingRole = this.ctx.resolvedRoles.find((r) => r.id === roleId);
    if (!existingRole) {
      log.warn("Fast reload: role not found, falling back to full reload", { roleId });
      return this.performFullReload();
    }

    const roleDir = join(this.ctx.roleboxDir!, roleId);
    const allSkillNames = [
      ...(existingRole.config.skills ?? []),
      ...(existingRole.config.opencode_skills ?? []),
    ];

    try {
      // 1. Re-resolve skills for this role
      const newSkills = await resolveSkills(allSkillNames, roleDir, this.ctx.globalSkillsDir!);

      // 2. Rebuild agent prompt with new skills
      const subagentMetadata = existingRole.subagents.map((sa) => ({
        id: sa.id,
        name: sa.config.name,
        description: sa.config.description,
      }));

      // Preserve the current teammate directory during skill-only reloads.
      const openRegistry = collectOpenRoles(this.ctx.resolvedRoles);
      const publicAgents = resolvePublicAgents(existingRole.config, openRegistry, existingRole.id);

      const newPrompt = buildAgentPrompt(existingRole.config, newSkills, {
        subagents: subagentMetadata,
        references: existingRole.references,
        canDelegate: existingRole.config.tools?.graph_declare !== false,
        canTeam: true,
        ...(publicAgents.length > 0 ? { publicAgents } : {}),
      });

      // 3. Update the role in-place
      existingRole.skills = newSkills;
      existingRole.prompt = newPrompt;

      // 4. Also update subagent prompts if they reference changed skills
      // (Subagents inherit skills via resolveAgentBundle — for the fast path,
      //  we only update the top-level role prompt since subagent skill changes
      //  would be caught by medium/full path via role.yaml changes)

      // 5. Sync skill symlinks and agents
      syncSkillSymlinks(this.ctx.resolvedRoles, this.ctx.globalSkillsDir!);
      await this.syncAgents(this.ctx.resolvedRoles);

      // 6. Clear extension module cache
      try {
        clearExtensionModuleCache();
      } catch (err) {
        log.warn("Failed to clear extension module cache", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 7. Do NOT restart dispatch-service — only skills changed,
      //    the agent registry has been updated in-place

      log.info("Fast reload complete", { roleId, skills: newSkills.length });
      return { kind: "reloaded", scope: "fast", roleId, skills: newSkills.length };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Fast reload failed, falling back to full reload", { roleId, error: errorMsg });
      return this.performFullReload();
    }
  }

  /**
   * Full/medium path: Re-discovers and re-resolves all roles.
   * This is the existing full reload behavior with added hash cache refresh.
   */
  private async performFullReload(): Promise<HotReloadResult> {
    log.info("Hot reload — full re-discovery and re-resolution");

    // Re-initialize model resolver so edits to the running harness's model
    // catalog (opencode.jsonc / cordis.patch.yml / models.json) and
    // role_config.yaml take effect without a process restart.
    initModelResolver(this.ctx.configDir!, this.ctx.capabilities.platformId);

    // 1. Re-discover roles from disk
    const newRoles = await discoverRoles(this.ctx.roleboxDir!);

    // 2. Create local Maps & construct resolver context using local Maps
    const localRoleFunctionsMap = new Map<string, ResolvedFunction[]>();
    const resolverCtx: ResolveContext = {
      roleboxDir: this.ctx.roleboxDir!,
      globalSkillsDir: this.ctx.globalSkillsDir!,
      configDir: this.ctx.configDir!,
      builtinDir: this.ctx.builtinDir!,
      roleFunctionsMap: localRoleFunctionsMap,
    };

    // 3. Re-resolve all roles into LOCAL maps (shared maps untouched until success)
    const newResolvedRoles = await resolveAllRoles(newRoles, resolverCtx);

    // 4. Sync agent files and skill symlinks
    await this.syncAgents(newResolvedRoles);
    syncSkillSymlinks(newResolvedRoles, this.ctx.globalSkillsDir!);

    // 5. Update the resolvedRoles array in-place (keep the reference stable)
    this.ctx.resolvedRoles.length = 0;
    this.ctx.resolvedRoles.push(...newResolvedRoles);

    // 5.5. Atomically swap shared maps (clear stale entries + populate fresh data)
    this.ctx.roleFunctionsMap.clear();
    for (const [k, v] of localRoleFunctionsMap) {
      this.ctx.roleFunctionsMap.set(k, v);
    }

    // 5.6. Refresh the top-level teammate directory.
    const newOpenRegistry = collectOpenRoles(newResolvedRoles);
    roleOpenRegistry.clear();
    for (const [k, v] of newOpenRegistry) {
      roleOpenRegistry.set(k, v);
    }

    // 6. Clear extension module cache so re-imports get fresh code
    try {
      clearExtensionModuleCache();
    } catch (err) {
      log.warn("Failed to clear extension module cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 7. Clear stale role hash cache entries (roles removed from disk)
    this.roleHashCache.clear();

    // 8. Refresh role hash cache for incremental diff on next change
    await this.refreshRoleHashCache(newRoles);

    // Invalidate the asset-search module-level index. reference_search needs
    // no equivalent invalidation: it keeps NO module-level cache — its index
    // is a per-tool-instance closure snapshot rebuilt when the tool is
    // re-created below (dispatch-service restart cascades to tool-service,
    // which re-runs buildCanonicalTools with the refreshed resolvedRoles).
    invalidateAssetIndex();

    // 9. Restart dispatch-service (cascades to tool-service and hook-service,
    //    refreshing the frozen subagent maps and tool registrations).
    //    Awaited: the reload tool only reports completion after this resolves,
    //    so newly-discovered role agents are resolvable to the dispatch and
    //    graph run paths synchronously after the reload returns (no
    //    "Agent not found" race).
    await this.ctx.core.restartService(SERVICE_NAMES.dispatch);

    log.info("Hot reload complete", {
      discovered: newRoles.size,
      resolved: newResolvedRoles.length,
      skipped: newRoles.size - newResolvedRoles.length,
    });
    return {
      kind: "reloaded",
      scope: "full",
      discovered: newRoles.size,
      resolved: newResolvedRoles.length,
      skipped: newRoles.size - newResolvedRoles.length,
    };
  }

  /**
   * Sync agent definitions through the host's registrar.
   *
   * The registrar is supplied by the host entry because it owns the platform's
   * registration mechanics; this shared service must not construct one. A host
   * that declares `hasAgentFileSync: false` registers agents in-process and
   * needs no file sync. A host that declares file sync but injected no
   * registrar is a wiring gap: warn once and skip, rather than falling back to
   * another platform's file layout.
   */
  private async syncAgents(resolvedRoles: ResolvedRole[]): Promise<void> {
    if (!this.ctx.capabilities.hasAgentFileSync) return;
    const registrar = this.ctx.agentRegistrar;
    if (!registrar) {
      if (!this.agentSyncWarned) {
        this.agentSyncWarned = true;
        log.warn("Agent file sync skipped: host declares hasAgentFileSync but injected no agentRegistrar");
      }
      return;
    }
    await syncAllAgents(resolvedRoles, registrar);
  }

  // ── Incremental diff helpers ────────────────────────────────────────

  /** Record a file change and schedule a reload. */
  private onFileChange(watchedDir: string, filename: string): void {
    this.recordChange(watchedDir, filename);
    this.scheduleReload();
  }

  private recordChange(watchedDir: string, filename: string): void {
    this.pendingChanges.push({ watchedDir, filename });
    // Cap the buffer to avoid unbounded memory growth
    if (this.pendingChanges.length > 200) {
      this.pendingChanges.splice(0, this.pendingChanges.length - 200);
    }
  }

  /**
   * Classify accumulated changes to determine the best reload path.
   * Returns:
   *   { type: "full", roleIds: [] } — global skills/config changed, need full reload
   *   { type: "medium", roleIds: [...] } — role.yaml changed
   *   { type: "fast", roleIds: [...] } — only skill files changed
   */
  private classifyChanges(): { type: "full" | "medium" | "fast"; roleIds: string[] } {
    const mediumRoles = new Set<string>();
    const fastRoles = new Set<string>();

    for (const { watchedDir, filename } of this.pendingChanges) {
      // Check if this is a global skills or config dir change
      if (this.ctx.globalSkillsDir && watchedDir === this.ctx.globalSkillsDir) {
        return { type: "full", roleIds: [] };
      }
      if (this.ctx.configDir && watchedDir === this.ctx.configDir) {
        return { type: "full", roleIds: [] };
      }

      // Only classify roleboxDir and raw/directory changes further
      const isRoleScope = (this.ctx.roleboxDir && watchedDir === this.ctx.roleboxDir)
        || (this.ctx.directory && watchedDir === this.ctx.directory)
        || (this.ctx.rawDirectory && watchedDir === this.ctx.rawDirectory);

      if (!isRoleScope) {
        // Unknown directory — fall back to full
        return { type: "full", roleIds: [] };
      }

      // Try to extract roleId from the relative path.
      // watch() emits native separators (backslashes on Windows), so normalize
      // once here — subsequent slash-based extraction depends on it.
      const rel = toPosixPath(filename);
      const slashIdx = rel.indexOf("/");
      if (slashIdx === -1) continue; // Top-level file, not role-specific

      const potentialRoleId = rel.slice(0, slashIdx);
      if (!potentialRoleId || potentialRoleId.startsWith(".")) continue;

      const subPath = rel.slice(slashIdx + 1);

      // role.yaml changed → medium path
      if (subPath === ROLE_YAML || subPath === "role.yaml") {
        mediumRoles.add(potentialRoleId);
        continue;
      }

      // Skill file changed → fast path
      if (subPath.startsWith("skills/") || subPath.includes("/skills/")) {
        fastRoles.add(potentialRoleId);
        continue;
      }

      // Other files (functions, references, etc.) → full path for safety
      return { type: "full", roleIds: [] };
    }

    // Priority: medium changes take precedence over fast
    if (mediumRoles.size > 0) {
      return { type: "medium", roleIds: [...mediumRoles] };
    }
    if (fastRoles.size > 0) {
      // For fast path, only handle single-role changes. Multiple roles → full.
      if (fastRoles.size === 1) {
        return { type: "fast", roleIds: [...fastRoles] };
      }
      return { type: "full", roleIds: [] };
    }

    // No recognizable changes — still do a full reload to be safe
    return { type: "full", roleIds: [] };
  }

  /** Compute a content-addressable hash string from role.yaml content.
   *  Only compared in-process (roleHashCache) — NOT persisted.
   */
  private hashContent(content: string): string {
    return createHash("sha1").update(content).digest("hex");
  }

  /** Read each role.yaml and update the hash cache for incremental detection. */
  private async refreshRoleHashCache(roles: Map<string, RoleConfig>): Promise<void> {
    if (!this.ctx.roleboxDir) return;
    for (const [roleId] of roles) {
      const yamlPath = join(this.ctx.roleboxDir, roleId, ROLE_YAML);
      try {
        const content = await readTextFile(yamlPath);
        this.roleHashCache.set(roleId, this.hashContent(content));
      } catch {
        // Role may no longer exist — remove from cache
        this.roleHashCache.delete(roleId);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* best effort */
      }
    }
    this.watchers = [];
  }

  health(): { status: "healthy" | "degraded" | "unhealthy"; detail?: string } {
    if (this.disabled) return { status: "healthy", detail: "disabled by env" };
    return { status: "healthy" };
  }
}
