import type { PluginService, ServiceHealth } from "../service.ts";
import { SERVICE_NAMES, type ServiceName } from "../service-names.ts";
import type { PluginContext } from "../context.ts";
import { ExtensionRegistry } from "../../extensions/index.ts";
import { createSubLogger } from "../../logger.ts";
import type { RecoveryStrategy, ErrorPattern } from "../../recovery/types.ts";

const log = createSubLogger(SERVICE_NAMES.extension);

/**
 * Owns the ExtensionRegistry lifecycle and bridges extension-loaded
 * strategies/patterns into the RecoveryEngine and DispatchManager.
 *
 * Init order: must run after dispatch-service and recovery-service
 * because it bridges into both engines.
 */
export class ExtensionService implements PluginService {
  readonly name: ServiceName = SERVICE_NAMES.extension;
  readonly dependencies: readonly ServiceName[] = [SERVICE_NAMES.dispatch, SERVICE_NAMES.recovery];

  private extensionRegistry!: ExtensionRegistry;
  private extensionLoadFailures = 0;

  async init(ctx: PluginContext): Promise<void> {
    this.extensionLoadFailures = 0;
    this.extensionRegistry = new ExtensionRegistry();

    const { resolvedRoles, directory } = ctx;

    // Load per-role extensions
    for (const role of resolvedRoles) {
      if (role.config.extensions) {
        try {
          await this.extensionRegistry.loadExtensions(role.config.extensions, directory);
          log.debug("Loaded extensions for role", { role: role.id });
        } catch (err) {
          this.extensionLoadFailures++;
          log.warn("Failed to load extensions for role", {
            role: role.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Bridge loaded strategies/patterns into RecoveryEngine
    const recoveryService = ctx.core.getService<import("./recovery-service.ts").RecoveryService>(SERVICE_NAMES.recovery);
    const recoveryEngine = recoveryService?.getRecoveryEngine();

    if (recoveryEngine) {
      for (const [name, mod] of this.extensionRegistry.getLoadedStrategies()) {
        recoveryEngine.registerStrategy({ name, execute: mod.execute } as RecoveryStrategy);
      }
      for (const [name, mod] of this.extensionRegistry.getLoadedPatterns()) {
        recoveryEngine.registerErrorPattern({ name, category: mod.category, match: mod.match } as unknown as ErrorPattern);
      }
    }

    // Bridge loaded strategies/patterns into RecoveryEngine
    const dispatchService = ctx.core.getService<import("./dispatch-service.ts").DispatchService>(SERVICE_NAMES.dispatch);
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

  health(): ServiceHealth {
    if (!this.extensionRegistry) {
      return { status: "unhealthy", detail: "ExtensionRegistry not initialized" };
    }
    if (this.extensionLoadFailures > 0) {
      return { status: "degraded", detail: `${this.extensionLoadFailures} extension load failure(s)` };
    }
    return { status: "healthy" };
  }
}
