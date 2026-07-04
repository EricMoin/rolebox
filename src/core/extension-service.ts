import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { ExtensionRegistry } from "../extensions/index.ts";
import type { ConcurrencyPolicyModule } from "../extensions/types.ts";
import { createSubLogger } from "../logger.ts";
import type { RecoveryStrategy, ErrorPattern } from "../recovery/types.ts";

const log = createSubLogger("extension-service");

/**
 * Owns the ExtensionRegistry lifecycle and bridges extension-loaded
 * strategies/patterns into the RecoveryEngine and DispatchManager.
 *
 * Init order: must run after dispatch-service and recovery-service
 * because it bridges into both engines.
 */
export class ExtensionService implements PluginService {
  readonly name = "extension-service";
  readonly dependencies = ["dispatch-service", "recovery-service"];

  private extensionRegistry!: ExtensionRegistry;

  async init(ctx: PluginContext): Promise<void> {
    this.extensionRegistry = new ExtensionRegistry();

    const { resolvedRoles, directory } = ctx;

    // Load per-role extensions
    for (const role of resolvedRoles) {
      if (role.config.extensions) {
        try {
          await this.extensionRegistry.loadExtensions(role.config.extensions, directory);
          log.debug("Loaded extensions for role", { role: role.id });
        } catch (err) {
          log.warn("Failed to load extensions for role", {
            role: role.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Bridge loaded strategies/patterns into RecoveryEngine
    const recoveryService = ctx.core.getService<import("./recovery-service.ts").RecoveryService>("recovery-service");
    const recoveryEngine = recoveryService?.getRecoveryEngine();

    if (recoveryEngine) {
      for (const [name, mod] of this.extensionRegistry.getLoadedStrategies()) {
        recoveryEngine.registerStrategy({ name, execute: mod.execute } as RecoveryStrategy);
      }
      for (const [name, mod] of this.extensionRegistry.getLoadedPatterns()) {
        recoveryEngine.registerErrorPattern({ name, category: mod.category, match: mod.match } as unknown as ErrorPattern);
      }
    }

    // Bridge loaded concurrency policies into DispatchManager
    const dispatchService = ctx.core.getService<import("./dispatch-service.ts").DispatchService>("dispatch-service");
    const dispatchManager = dispatchService?.getDispatchManager();

    if (recoveryEngine && dispatchManager) {
      dispatchManager.setRecoverySnapshotProvider(() => recoveryEngine.getMetrics());
    }

    // Hot-swap concurrency manager if a custom policy was loaded via extensions
    if (dispatchManager) {
      const policyMod = this.extensionRegistry.getLoadedPolicies();
      for (const [, mod] of policyMod) {
        const cfg = dispatchManager.getConfig();
        const customMgr = mod.create({
          defaultLimit: cfg.maxConcurrent,
          maxQueueDepth: cfg.maxQueueDepth ?? 10,
          reserved: cfg.syncReservedSlots ?? 1,
          retryAfterMs: cfg.retryAfterMs,
        });
        dispatchManager.setConcurrencyManager(customMgr);
        log.debug("Hot-swapped concurrency manager from extension policy");
        break; // Use the first registered policy
      }
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.extensionRegistry?.dispose();
    } catch {
      // best effort
    }
  }

  getExtensionRegistry(): ExtensionRegistry {
    return this.extensionRegistry;
  }

  getLoadedPolicies(): Map<string, ConcurrencyPolicyModule> {
    return this.extensionRegistry.getLoadedPolicies();
  }
}
