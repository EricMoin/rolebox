import type { PluginService } from "./service.ts";
import type { PluginContext } from "./context.ts";
import { ExtensionRegistry } from "../extensions/index.ts";
import { hookState } from "../hooks/state.ts";
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
    // Create ExtensionRegistry and store in hookState
    this.extensionRegistry = new ExtensionRegistry();
    hookState.extensionRegistry = this.extensionRegistry;

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

    // Bridge recovery metrics into DispatchManager
    const dispatchService = ctx.core.getService<import("./dispatch-service.ts").DispatchService>("dispatch-service");
    const dispatchManager = dispatchService?.getDispatchManager();

    if (recoveryEngine && dispatchManager) {
      dispatchManager.setRecoverySnapshotProvider(() => recoveryEngine.getMetrics());
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
}
