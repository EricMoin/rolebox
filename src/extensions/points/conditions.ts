import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, ConditionModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";
import { registerCondition, type CondEnv } from "../../function/conditions.ts";
import { wrapConditionCapability } from "../capabilities.ts";

const log = createSubLogger("ext:point:conditions");

function hasCapabilityFlag(mod: Record<string, unknown>): boolean {
  return mod.capability === true;
}

export class ConditionExtensionPoint implements ExtensionPoint {
  readonly name = "conditions";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const conditionMod = mod as Partial<ConditionModule>;
      if (typeof conditionMod.handler === "function") {
        if (hasCapabilityFlag(mod as Record<string, unknown>)) {
          // New-style: wrap to provide ConditionCapability instead of raw CondEnv
          const wrappedHandler = (arg: string, env: CondEnv): boolean => {
            const cap = wrapConditionCapability(env);
            return conditionMod.handler!(arg, cap as unknown as CondEnv);
          };
          registerCondition(entry.name, wrappedHandler);
          log.debug("Registered custom condition with capability wrapping", {
            name: entry.name,
          });
        } else {
          // Legacy: pass raw CondEnv (backward compat)
          registerCondition(entry.name, conditionMod.handler);
          log.debug("Registered custom condition (legacy)", {
            name: entry.name,
          });
        }
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
