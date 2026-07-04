import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { createSubLogger } from "../logger.ts";
import { clearExtensionModuleCache } from "../extensions/loader.ts";
import { watch, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";

const log = createSubLogger("hot-reload-service");

const DEBOUNCE_MS = 500;
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

    // ResolvedRole doesn't directly expose its base directory, but we can watch
    // parent directories of reference/function/skill files to catch role-level changes.
    // The workspace and config directories cover most cases.

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

  private async performReload(): Promise<void> {
    log.info("Hot reload triggered — clearing cache and restarting services");

    // Clear extension module cache so re-imports get fresh code
    try {
      clearExtensionModuleCache();
    } catch (err) {
      log.warn("Failed to clear extension module cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Restart extension-service (which cascades to hook-service since it depends on it)
    try {
      await this.ctx.core.restartService("extension-service");
      log.info("Hot reload complete — extension-service and dependents restarted");
    } catch (err) {
      log.error("Hot reload failed during service restart", {
        error: err instanceof Error ? err.message : String(err),
      });
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
