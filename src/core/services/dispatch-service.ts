import type { PluginService, ServiceHealth } from "../service.ts";
import { SERVICE_NAMES, type ServiceName } from "../service-names.ts";
import type { PluginContext } from "../context.ts";
import type { ToolContributor } from "../tool-registry.ts";
import { sessionCreateUnavailableMessage } from "../../platform/capabilities.ts";
import type { ISessionClient } from "../../platform/ports/session-client.ts";
import { DispatchManager } from "../../dispatch/core/manager.ts";
import { cleanExpiredState } from "../../dispatch/persistence/state-gc.ts";
import { stateDirFor } from "../../utils/state-paths.ts";
import { hookState } from "../../hooks/state.ts";
import { logEvent } from "../../log/index.ts";
import { createDispatchTools } from "../../dispatch/tools.ts";
import type { CanonicalToolDef } from "../../platform/types.ts";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import {
  createDispatchManager,
  buildSubagentLineage,
  buildRoleConfigs,
} from "../../dispatch/factory.ts";

/**
 * Creates a stub CanonicalToolDef that returns the supplied "not available"
 * message. Used when the service is permanently degraded because the host
 * cannot create sessions.
 */
function stubTool(description: string, message: string): CanonicalToolDef {
  return defineTool({
    description,
    args: {
      _stub: z.string().optional().describe("This tool is unavailable on this host"),
    },
    async execute() {
      return message;
    },
  });
}

/**
 * Extracts the DispatchManager lifecycle from plugin-hooks.ts into its own
 * PluginService. Owns the resolvedSubagents and subagentModelKey maps that
 * were previously local to createPluginHooks.
 *
 * Init order: no dependencies (empty dependencies list).
 * Tool registration is deferred to ToolService (S8).
 *
 * Graceful degradation: when capabilities indicate the platform does not
 * support session creation (hasSessionCreate=false), the service skips
 * DispatchManager construction, registers stub tools that return clear
 * "not available" messages, and reports degraded health.
 */
export class DispatchService implements PluginService, ToolContributor {
  readonly name: ServiceName = SERVICE_NAMES.dispatch;
  readonly dependencies: readonly ServiceName[] = [];
  readonly critical = true;

  private dispatchManager!: DispatchManager;
  private resolvedSubagents = new Map<string, { parentFullId: string }>();
  private subagentModelKey = new Map<string, string>();
  private recoverFailed = false;
  /** managerMap key published by the last init() — used to evict this core's manager on dispose(). */
  private managerMapKey?: string;

  /** Optional session client override. When set, used in place of ctx.session. */
  private readonly sessionClient: ISessionClient | undefined;

  constructor(options?: { sessionClient?: ISessionClient }) {
    this.sessionClient = options?.sessionClient;
  }

  /** True when the service is permanently degraded (no session creation). */
  private degraded = false;
  private degradedDetail = "";
  /** Platform id captured at init for degraded stub messages. */
  private platformId = "unknown";

  async init(ctx: PluginContext): Promise<void> {
    // Check for graceful degradation: platforms without session create
    // and no injected session client cannot run the dispatch system.
    const caps = ctx.capabilities;
    if (!this.sessionClient && caps && !caps.hasSessionCreate) {
      this.degraded = true;
      this.platformId = caps.platformId ?? "unknown";
      this.degradedDetail = `session create not supported on ${this.platformId === "unknown" ? "this host" : this.platformId} and no session client provided`;
      logEvent("dispatch-service.degraded", { platformId: caps.platformId });
      return;
    }

    // Clear and repopulate in-place instead of reassigning — preserves the Map
    // reference held by dispatch tool closures from before restartService().
    this.resolvedSubagents.clear();
    this.subagentModelKey.clear();

    // 1. Build subagent lineage maps from shared factory.
    const lineage = buildSubagentLineage(ctx.resolvedRoles);
    for (const [k, v] of lineage.resolvedSubagents) {
      this.resolvedSubagents.set(k, v);
    }
    for (const [k, v] of lineage.subagentModelKey) {
      this.subagentModelKey.set(k, v);
    }

    // 2. Reuse or create DispatchManager (was lines 155-167 in plugin-hooks.ts)
    // Use rawDirectory for map keys to match test expectations and legacy behavior
    const mapDir = ctx.rawDirectory;
    this.managerMapKey = mapDir;
    const storeDir = ctx.directory;
    let dispatchManager = hookState.managerMap.get(mapDir);
    if (!dispatchManager) {
      const sessionClient =
        this.sessionClient ?? ctx.session;

      const result = await createDispatchManager({
        sessionClient,
        resolvedRoles: ctx.resolvedRoles,
        storeDirectory: storeDir,
      });

      dispatchManager = result.manager;
      hookState.managerMap.set(mapDir, dispatchManager);

      // Graceful degradation: recover() failure → log error + use empty state.
      // Assign (do not latch): a fresh manager whose recover() succeeded clears a
      // previous failure. A reused manager keeps its own verdict, because this
      // branch is skipped on the cache-hit path above.
      if (result.recoverError) {
        logEvent("dispatch-service.recover-failed", {
          error: result.recoverError.message,
        });
      }
      this.recoverFailed = result.recoverError !== undefined;
    }

    this.dispatchManager = dispatchManager;

    // Refresh per-role dispatch configs on EVERY init (hot-reload included).
    // The manager may be cached from a previous init (managerMap); rebuilding
    // role configs from the current resolvedRoles keeps per-role concurrency
    // limits and role-scoped configs in sync after a reload. subagentRoleKey
    // comes from the lineage built above (~line 93).
    dispatchManager.updateDispatchConfigs(
      buildRoleConfigs(ctx.resolvedRoles),
      lineage.subagentRoleKey,
    );

    // Fire-and-forget: clean expired state files from disk (7-day default retention)
    cleanExpiredState(stateDirFor(storeDir)).catch(() => {});
  }

  async dispose(): Promise<void> {
    if (this.degraded) return;
    try {
      await this.dispatchManager.dispose();
    } catch (err) {
      logEvent("dispatch-service.flush-failed", {
        phase: "dispose",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Evict the cached manager so the next init() rebuilds a fresh one with all
    // periodic timers re-armed. Identity-guarded: an older core must never evict
    // a newer manager another PluginCore published for the same rawDirectory.
    const key = this.managerMapKey;
    if (key && hookState.managerMap.get(key) === this.dispatchManager) {
      hookState.managerMap.delete(key);
    }
  }

  /**
   * Synchronous crash-safe flush for process exit/SIGINT/SIGTERM. No-op before
   * init or when degraded.
   */
  flushPersistSync(): void {
    if (this.degraded || !this.dispatchManager) return;
    try {
      this.dispatchManager.flushPersistSync();
    } catch (err) {
      logEvent("dispatch-service.flush-failed", { phase: "exit", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── ToolContributor ─────────────────────────────────────────────

  /**
   * Returns real compatibility `dispatch_*` tools (CanonicalToolDefs) when the
   * service is healthy, or unavailable stub tools when degraded.
   *
   * These tools are the restored Phase-C compatibility shims backed by the
   * DispatchManager (see src/dispatch/tools.ts). They are consumed on the
   * opencode path via `dispatchToolsOverride` in buildCanonicalTools, which is
   * how the five dispatch_* tools appear in ToolService.getTools() output.
   */
  getTools(): Record<string, CanonicalToolDef> {
    if (this.degraded) {
      const message = sessionCreateUnavailableMessage(this.platformId);
      return {
        dispatch: stubTool("Dispatch work to a subagent.", message),
        dispatch_output: stubTool("Retrieve output from a completed background task.", message),
        dispatch_cancel: stubTool("Cancel a running background task.", message),
        dispatch_metrics: stubTool("Retrieve runtime dispatch metrics.", message),
        dispatch_status: stubTool("Check background task liveness.", message),
      };
    }
    if (!this.dispatchManager) {
      return {};
    }
    return createDispatchTools(
      this.dispatchManager,
      this.resolvedSubagents,
      this.subagentModelKey,
    );
  }

  // ── Public getters ──────────────────────────────────────────────

  getDispatchManager(): DispatchManager {
    if (this.degraded) {
      throw new Error("DispatchService is permanently degraded — cannot access DispatchManager");
    }
    return this.dispatchManager;
  }

  getResolvedSubagents(): Map<string, { parentFullId: string }> {
    return this.resolvedSubagents;
  }

  getSubagentModelKey(): Map<string, string> {
    return this.subagentModelKey;
  }

  /** Whether the service is permanently degraded (no session creation). */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** The reason for degradation, if any. */
  getDegradedDetail(): string {
    return this.degradedDetail;
  }

  // ── Health ───────────────────────────────────────────────────

  health(): ServiceHealth {
    if (this.degraded) {
      return { status: "degraded", detail: this.degradedDetail };
    }
    if (!this.dispatchManager) {
      return { status: "unhealthy", detail: "DispatchManager not initialized" };
    }
    if (this.recoverFailed) {
      return { status: "degraded", detail: "DispatchManager.recover() failed — running with empty state" };
    }
    if (!this.dispatchManager.isOperational()) {
      return { status: "unhealthy", detail: "DispatchManager present but periodic pipeline stopped (sweeper not running)" };
    }
    return { status: "healthy" };
  }
}
