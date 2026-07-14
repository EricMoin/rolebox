import type { PluginService, PluginCoreLike, ServiceHealth } from "../service.ts";
import type { PluginContext } from "../context.ts";
import type { DispatchService } from "./dispatch-service.ts";
import { LoopCoordinator } from "../../loop/coordinator.ts";
import { DispatchAdapter } from "../../loop/dispatch-adapter.ts";
import { LoopStore } from "../../loop/loop-store.ts";
import type { LoopState } from "../../loop/types.ts";
import { INTER_ROUND_DELAY_MS } from "../../loop/constants.ts";
import { hookState } from "../../hooks/state.ts";
import { createSubLogger } from "../../logger.ts";
import { OpencodeSessionAdapter } from "../../platform/adapters/opencode/session.ts";

const log = createSubLogger("loop-service");

/** Message shown by stub loop tools when the service is degraded on Pi. */
const PI_LOOP_UNAVAILABLE_MSG =
  "Loop is not available on Pi — dispatch is not supported.";

/**
 * Creates a stub tool definition that returns a fixed "not available" message.
 * Used when the service is permanently degraded (e.g., on Pi when dispatch is degraded).
 */
function stubTool(description: string): {
  description: string;
  args: Record<string, unknown>;
  exec: (...args: unknown[]) => Promise<string>;
} {
  return {
    description,
    args: {},
    exec: async () => PI_LOOP_UNAVAILABLE_MSG,
  };
}

export class LoopService implements PluginService {
  readonly name = "loop-service";
  readonly dependencies = ["dispatch-service"];
  readonly critical = true;

  private loopManager!: LoopCoordinator;
  private loopStore!: LoopStore;
  private stateDegraded = false;
  private degradedDetail = "";

  async init(ctx: PluginContext): Promise<void> {
    // Check if DispatchService is degraded. If so, skip init gracefully.
    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service");
    if (!dispatchService) {
      this.stateDegraded = true;
      this.degradedDetail = "dispatch-service not initialized";
      log.warn("loop-service: degraded (dispatch-service not initialized)");
      return;
    }
    // DispatchService exposes isDegraded() — check for degraded state
    const dispatchHealth = dispatchService.health();
    if (dispatchHealth && dispatchHealth.status === "degraded") {
      this.stateDegraded = true;
      this.degradedDetail = "dispatch not available on Pi";
      log.warn("loop-service: degraded (dispatch not available on Pi)");
      return;
    }

    let dispatchManager;
    try {
      dispatchManager = dispatchService.getDispatchManager();
    } catch {
      this.stateDegraded = true;
      this.degradedDetail = "dispatch not available — getDispatchManager() threw";
      log.warn("loop-service: degraded (dispatch not available)");
      return;
    }

    const dir = ctx.directory;

    // Reuse existing if available (keyed by raw directory for cross-call consistency)
    const mapDir = ctx.rawDirectory;
    const existing = hookState.loopManagerMap.get(mapDir);
    if (existing) {
      this.loopManager = existing;
      this.loopStore = hookState.loopStoreMap.get(mapDir)!;
      hookState.activeLoopManager = this.loopManager;
      return;
    }

    const adapter = new DispatchAdapter(dispatchManager, new OpencodeSessionAdapter(ctx.client));
    const store = new LoopStore(dir);
    const coordinator = new LoopCoordinator(adapter, {
      delayMs: INTER_ROUND_DELAY_MS,
      persist: (loops) => {
        void store.save(loops);
      },
    });

    // Recovery: reconcile persisted loops with dispatch state
    let loaded: Map<string, LoopState> | null = null;
    try {
      loaded = store.load();
    } catch (err) {
      this.stateDegraded = true;
      this.degradedDetail = "LoopStore.load() failed — starting with empty coordinator";
      log.error(this.degradedDetail, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (loaded) {
      try {
        const reconciled = await store.reconcile(loaded, async (taskId) => {
          try {
            const task = dispatchManager.getTask(taskId);
            if (task) return { status: task.status, exists: true };
          } catch {
            // Fall through to unknown
          }
          return { status: "unknown", exists: false };
        });
        for (const [, state] of reconciled) {
          coordinator.restoreState(state);
        }
        // Re-subscribe terminated listeners for active loops after restart
        await coordinator.reSubscribeListeners();
      } catch (err) {
        this.stateDegraded = true;
        this.degradedDetail = "LoopStore.reconcile() failed — using empty coordinator";
        log.error(this.degradedDetail, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.loopManager = coordinator;
    this.loopStore = store;
    hookState.loopManagerMap.set(mapDir, coordinator);
    hookState.loopStoreMap.set(mapDir, store);
    hookState.activeLoopManager = coordinator;
  }

  async dispose(): Promise<void> {
    if (this.stateDegraded) return;
    try {
      if (this.loopStore) {
        this.loopStore.saveSync(this.loopManager.getAllLoopStates());
      }
    } catch {
      // Best-effort save during dispose
    }
    try {
      this.loopManager?.dispose();
    } catch {
      // Best-effort dispose
    }
  }

  getLoopManager(): LoopCoordinator {
    if (this.stateDegraded) {
      throw new Error("LoopService is degraded — cannot access LoopCoordinator");
    }
    return this.loopManager;
  }

  getLoopStore(): LoopStore {
    if (this.stateDegraded) {
      throw new Error("LoopService is degraded — cannot access LoopStore");
    }
    return this.loopStore;
  }

  isDegraded(): boolean {
    return this.stateDegraded;
  }

  getDegradedDetail(): string {
    return this.degradedDetail;
  }

  health(): ServiceHealth {
    if (this.stateDegraded) {
      return { status: "degraded", detail: this.degradedDetail };
    }
    if (!this.loopManager) {
      return { status: "unhealthy", detail: "LoopCoordinator not initialized" };
    }
    return { status: "healthy" };
  }
}
