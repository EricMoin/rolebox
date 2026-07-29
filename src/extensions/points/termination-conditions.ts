import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, TerminationParserModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";
import { registerTerminationParser } from "../../graph/termination-parser.ts";

const log = createSubLogger("ext:point:termination-conditions");

export class TerminationConditionExtensionPoint implements ExtensionPoint {
  readonly name = "termination_conditions";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const termMod = mod as Partial<TerminationParserModule>;
      if (typeof termMod.parse === "function") {
        // Adapt the module's 2-param parse (value, availableAgents) to the
        // registry's 3-param signature (value, fullObj, availableAgents)
        registerTerminationParser(
          entry.name,
          (value, _fullObj, availableAgents) => termMod.parse!(value, availableAgents),
        );
        log.debug("Registered custom termination condition parser", { name: entry.name });
      } else {
        log.warn("Termination module missing parse function", { name: entry.name, module: entry.module });
      }
    }
  }
}
