import type { PluginService, PluginCoreLike } from "./service.ts";
import type { PluginContext } from "./context.ts";
import type { DispatchService } from "./dispatch-service.ts";
import { LoopCoordinator } from "../loop/coordinator.ts";
import { DispatchAdapter } from "../loop/dispatch-adapter.ts";
import { LoopStore } from "../loop/loop-store.ts";
import { INTER_ROUND_DELAY_MS } from "../loop/constants.ts";
import { hookState } from "../hooks/state.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("loop-service");

export class LoopService implements PluginService {
  readonly name = "loop-service";
  readonly dependencies = ["dispatch-service"];

  private loopManager!: LoopCoordinator;
  private loopStore!: LoopStore;

  async init(ctx: PluginContext): Promise<void> {
    // Get DispatchManager from DispatchService via core lookup
    const dispatchService = ctx.core.getService<DispatchService>("dispatch-service");
    if (!dispatchService) throw new Error("dispatch-service not initialized");
    const dispatchManager = dispatchService.getDispatchManager();

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

    const adapter = new DispatchAdapter(dispatchManager, ctx.client);
    const store = new LoopStore(dir);
    const coordinator = new LoopCoordinator(adapter, {
      delayMs: INTER_ROUND_DELAY_MS,
      persist: (loops) => {
        void store.save(loops);
      },
    });

    // Recovery: reconcile persisted loops with dispatch state
    const loaded = store.load();
    if (loaded) {
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
    }

    this.loopManager = coordinator;
    this.loopStore = store;
    hookState.loopManagerMap.set(mapDir, coordinator);
    hookState.loopStoreMap.set(mapDir, store);
    hookState.activeLoopManager = coordinator;
  }

  async dispose(): Promise<void> {
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
    return this.loopManager;
  }

  getLoopStore(): LoopStore {
    return this.loopStore;
  }

  // ── Health ───────────────────────────────────────────────────

  health(): import("./service.ts").ServiceHealth {
    if (!this.loopManager) {
      return { status: "unhealthy", detail: "LoopCoordinator not initialized" };
    }
    return { status: "healthy" };
  }
}
