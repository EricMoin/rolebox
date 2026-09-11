import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, RecoveryPatternModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:recovery-patterns");

export class RecoveryPatternExtensionPoint implements ExtensionPoint {
  readonly name = "recovery_patterns";

  private loaded = new Map<string, RecoveryPatternModule>();

  getLoadedPatterns(): Map<string, RecoveryPatternModule> {
    return this.loaded;
  }

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const patternMod = mod as Partial<RecoveryPatternModule>;
      if (patternMod.name && typeof patternMod.match === "function") {
        this.loaded.set(entry.name, mod as RecoveryPatternModule);
        log.debug("Loaded custom recovery pattern module", { name: entry.name });
      } else {
        log.warn("Recovery pattern module missing name/match", { name: entry.name, module: entry.module });
      }
    }
  }
}
