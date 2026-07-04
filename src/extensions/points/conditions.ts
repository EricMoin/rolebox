import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, ConditionModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";
import { registerCondition } from "../../function/conditions.ts";

const log = createSubLogger("ext:point:conditions");

export class ConditionExtensionPoint implements ExtensionPoint {
  readonly name = "conditions";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      // Check if module exports the expected handler
      const conditionMod = mod as Partial<ConditionModule>;
      if (typeof conditionMod.handler === "function") {
        registerCondition(entry.name, conditionMod.handler);
        log.debug("Registered custom condition", { name: entry.name });
      } else {
        log.warn("Extension module missing handler function", {
          name: entry.name,
          module: entry.module,
          exports: Object.keys(mod),
        });
      }
    }
  }
}
