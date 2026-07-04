import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, RecoveryStrategyModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:recovery-strategies");

export class RecoveryStrategyExtensionPoint implements ExtensionPoint {
  readonly name = "recovery_strategies";

  private loaded = new Map<string, RecoveryStrategyModule>();

  getLoadedStrategies(): Map<string, RecoveryStrategyModule> {
    return this.loaded;
  }

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    // Import dynamically to avoid circular dependency
    const { addKnownStrategy } = await import("../../recovery/config.ts");

    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const stratMod = mod as Partial<RecoveryStrategyModule>;
      if (stratMod.name && typeof stratMod.execute === "function") {
        // Register strategy name so parseChain accepts it
        addKnownStrategy(entry.name);
        this.loaded.set(entry.name, mod as RecoveryStrategyModule);
        log.debug("Registered custom recovery strategy name", { name: entry.name });
      } else {
        log.warn("Recovery strategy module missing name/execute", { name: entry.name, module: entry.module });
      }
    }
  }
}
