import type { PluginService } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { ToolContributor } from "../tool-registry.ts";
import { DispatchManager } from "../../dispatch/core/manager.ts";
import { mergeConfig, resolveEnvConfig, DEFAULT_CONFIG, DEFAULT_MAX_QUEUE_DEPTH, DEFAULT_SYNC_RESERVED_SLOTS } from "../../dispatch/config.ts";
import type { IConcurrencyManager } from "../../dispatch/concurrency/concurrency.ts";
import { cleanExpiredState } from "../../dispatch/persistence/state-gc.ts";
import { stateDirFor } from "../../utils/state-paths.ts";
import { RoleMode } from "../../constants.ts";
import { hookState } from "../../hooks/state.ts";
import type { ResolvedSubAgent } from "../../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("dispatch-service");

/**
 * Extracts the DispatchManager lifecycle from plugin-hooks.ts into its own
 * PluginService. Owns the resolvedSubagents and subagentModelKey maps that
 * were previously local to createPluginHooks.
 *
 * Init order: no dependencies (empty dependencies list).
 * Tool registration is deferred to ToolService (S8).
 */
export class DispatchService implements PluginService, ToolContributor {
  readonly name = "dispatch-service";
  readonly dependencies: string[] = [];
  readonly critical = true;

  private dispatchManager!: DispatchManager;
  private resolvedSubagents = new Map<string, { parentFullId: string }>();
  private subagentModelKey = new Map<string, string>();
  private recoverFailed = false;

  async init(ctx: PluginContext): Promise<void> {
    // Clear stale entries from previous init (supports hot-reload of deleted roles)
    this.resolvedSubagents.clear();
    this.subagentModelKey.clear();

    // 1. Build subagent lineage maps (was registerSubagentLineage in plugin-hooks.ts)
    for (const role of ctx.resolvedRoles) {
      this.registerSubagentLineage(role.subagents, role.id, role.config.model);
    }

    // 2. Reuse or create DispatchManager (was lines 155-167 in plugin-hooks.ts)
    // Use rawDirectory for map keys to match test expectations and legacy behavior
    const mapDir = ctx.rawDirectory;
    const storeDir = ctx.directory;
    let dispatchManager = hookState.managerMap.get(mapDir);
    if (!dispatchManager) {
      const primaryRole = ctx.resolvedRoles.find(
        (r) => r.config.mode === RoleMode.Primary,
      );
      const mergedConfig = mergeConfig(
        DEFAULT_CONFIG,
        primaryRole?.dispatchConfig,
        resolveEnvConfig(),
      );
      // Check for custom concurrency policy from role config
      let customConcurrency: IConcurrencyManager | undefined;
      if (primaryRole?.dispatchConfig?.concurrency_policy) {
        customConcurrency = primaryRole.dispatchConfig.concurrency_policy(
          mergedConfig.maxConcurrent,
          mergedConfig.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
          mergedConfig.syncReservedSlots ?? DEFAULT_SYNC_RESERVED_SLOTS,
          mergedConfig.retryAfterMs,
        );
      }

      dispatchManager = new DispatchManager(
        ctx.client,
        mergedConfig,
        this.subagentModelKey,
        customConcurrency,
      );
      dispatchManager.setStoreDirectory(storeDir);
      hookState.managerMap.set(mapDir, dispatchManager);

      // Graceful degradation: recover() failure → log error + use empty state
      try {
        await dispatchManager.recover();
      } catch (err) {
        this.recoverFailed = true;
        log.error("DispatchManager.recover() failed, continuing with empty state", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.dispatchManager = dispatchManager;

    // Fire-and-forget: clean expired state files from disk (7-day default retention)
    cleanExpiredState(stateDirFor(storeDir)).catch(() => {});
  }

  /**
   * Recursively register a subagent subtree into resolvedSubagents and
   * subagentModelKey. Models cascade down: a child without an explicit
   * model inherits its parent's model.
   */
  private registerSubagentLineage(
    subagents: ResolvedSubAgent[],
    parentFullId: string,
    parentModel: string | undefined,
  ): void {
    for (const sub of subagents) {
      this.resolvedSubagents.set(sub.id, { parentFullId });
      const model = sub.config.model ?? parentModel;
      const key = model ? model : "default";
      this.subagentModelKey.set(sub.id, key);
      log.debug("model key", { subagent: sub.id, key, parentFullId });
      if (sub.subagents.length > 0) {
        this.registerSubagentLineage(sub.subagents, sub.id, model);
      }
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.dispatchManager.flushPersist();
    } catch (err) {
      log.warn("dispatch flush during dispose failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── ToolContributor ─────────────────────────────────────────────

  /** Tools are registered by ToolService (S8). No-op until then. */
  getTools(): Record<
    string,
    {
      description: string;
      args: Record<string, unknown>;
      exec: (...args: unknown[]) => Promise<unknown>;
    }
  > {
    return {};
  }

  // ── Public getters ──────────────────────────────────────────────

  getDispatchManager(): DispatchManager {
    return this.dispatchManager;
  }

  getResolvedSubagents(): Map<string, { parentFullId: string }> {
    return this.resolvedSubagents;
  }

  getSubagentModelKey(): Map<string, string> {
    return this.subagentModelKey;
  }

  // ── Health ───────────────────────────────────────────────────

  health(): import("../service.ts").ServiceHealth {
    if (!this.dispatchManager) {
      return { status: "unhealthy", detail: "DispatchManager not initialized" };
    }
    if (this.recoverFailed) {
      return { status: "degraded", detail: "DispatchManager.recover() failed — running with empty state" };
    }
    return { status: "healthy" };
  }
}
