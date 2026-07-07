import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { createSubLogger } from "../logger.ts";
import { clearExtensionModuleCache } from "../extensions/loader.ts";
import { watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import { discoverRoles } from "../role-loader.ts";
import { resolveAllRoles, type ResolveContext } from "../resolver/orchestrator.ts";
import { syncAgentFiles } from "../sync/agent-files.ts";
import { syncSkillSymlinks } from "../sync/skill-symlinks.ts";
import type { ResolvedFunction, ResolvedGraph } from "../types.ts";

const log = createSubLogger("hot-reload-service");

const DEBOUNCE_MS = 500;

/** Result returned by triggerReload() so callers (tools, tests) can report status accurately. */
export interface HotReloadResult {
  success: boolean;
  /** Set when hot reload is disabled via env var (not an error). */
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
  readonly name = "hot-reload-service";
  readonly dependencies: string[] = [];

  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private ctx!: PluginContext;
  private disabled = false;

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Check env var: ROLEBOX_HOT_RELOAD=false disables hot reload
    if (process.env.ROLEBOX_HOT_RELOAD === "false" || process.env.ROLEBOX_HOT_RELOAD === "0") {
      this.disabled = true;
      log.info("Hot reload disabled by env var");
      return;
    }

    // Collect directories to watch: workspace + config dirs from resolved roles
    const dirsToWatch = new Set<string>();

    // Watch the raw directory (workspace root)
    dirsToWatch.add(ctx.rawDirectory);

    // Watch the normalized directory (may differ if symlinked)
    if (ctx.directory) {
      dirsToWatch.add(ctx.directory);
    }

    // Watch the rolebox role directory explicitly if available
    if (ctx.roleboxDir) {
      dirsToWatch.add(ctx.roleboxDir);
    }

    // Watch the opencode config directory (global skills + functions live here)
    if (ctx.configDir) {
      dirsToWatch.add(ctx.configDir);
    }

    // Watch the global skills directory explicitly (may differ from configDir)
    if (ctx.globalSkillsDir) {
      dirsToWatch.add(ctx.globalSkillsDir);
    }

    for (const dir of dirsToWatch) {
      try {
        const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const ext = filename.slice(filename.lastIndexOf("."));
          if (!WATCH_EXTENSIONS.has(ext)) return;
          this.scheduleReload();
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

    // Debounce: reset timer on each change
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.performReload();
    }, DEBOUNCE_MS);
  }

  /**
   * Public trigger to force a hot reload. If disabled, returns a resolved promise
   * with `success: false` and `disabled: true`.
   * Useful for P2 tools to programmatically trigger a reload and report status.
   */
  async triggerReload(): Promise<HotReloadResult> {
    if (this.disabled) return { success: false, disabled: true };
    return this.performReload();
  }

  private async performReload(): Promise<HotReloadResult> {
    if (this.disabled) return { success: false, disabled: true };

    log.info("Hot reload triggered — re-discovering and re-resolving roles");

    // Guard: we need the resolver context to reload
    if (!this.ctx.roleboxDir || !this.ctx.globalSkillsDir || !this.ctx.configDir || !this.ctx.builtinDir) {
      log.warn("Hot reload aborted: resolver context fields not set on PluginContext");
      return { success: false, error: "resolver context fields not set on PluginContext" };
    }

    try {
      // 1. Re-discover roles from disk
      const newRoles = await discoverRoles(this.ctx.roleboxDir);

      // 2. Create local Maps & construct resolver context using local Maps
      const localRoleFunctionsMap = new Map<string, ResolvedFunction[]>();
      const localRoleGraphMap = new Map<string, ResolvedGraph>();
      const resolverCtx: ResolveContext = {
        roleboxDir: this.ctx.roleboxDir,
        globalSkillsDir: this.ctx.globalSkillsDir,
        configDir: this.ctx.configDir,
        builtinDir: this.ctx.builtinDir,
        roleFunctionsMap: localRoleFunctionsMap,
        roleGraphMap: localRoleGraphMap,
      };

      // 3. Re-resolve all roles into LOCAL maps (shared maps untouched until success)
      const newResolvedRoles = await resolveAllRoles(newRoles, resolverCtx);

      // 4. Sync agent files and skill symlinks
      syncAgentFiles(newResolvedRoles);
      syncSkillSymlinks(newResolvedRoles, this.ctx.globalSkillsDir);

      // 5. Update the resolvedRoles array in-place (keep the reference stable)
      this.ctx.resolvedRoles.length = 0;
      this.ctx.resolvedRoles.push(...newResolvedRoles);

      // 5.5. Atomically swap shared maps (clear stale entries + populate fresh data)
      this.ctx.roleFunctionsMap.clear();
      for (const [k, v] of localRoleFunctionsMap) {
        this.ctx.roleFunctionsMap.set(k, v);
      }
      this.ctx.roleGraphMap.clear();
      for (const [k, v] of localRoleGraphMap) {
        this.ctx.roleGraphMap.set(k, v);
      }
      // 6. Clear extension module cache so re-imports get fresh code
      try {
        clearExtensionModuleCache();
      } catch (err) {
        log.warn("Failed to clear extension module cache", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 7. Restart dispatch-service (cascades to tool-service and hook-service,
      //    refreshing the frozen subagent maps and tool registrations)
      await this.ctx.core.restartService("dispatch-service");

      log.info("Hot reload complete", {
        discovered: newRoles.size,
        resolved: newResolvedRoles.length,
        skipped: newRoles.size - newResolvedRoles.length,
      });
      return {
        success: true,
        discovered: newRoles.size,
        resolved: newResolvedRoles.length,
        skipped: newRoles.size - newResolvedRoles.length,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Hot reload failed — previous state preserved", { error: errorMsg });
      return { success: false, error: errorMsg };
    }
  }

  async dispose(): Promise<void> {
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
