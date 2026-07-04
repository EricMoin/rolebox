import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, ObserveHandlerModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:observe-events");

export class ObserveEventExtensionPoint implements ExtensionPoint {
  readonly name = "observe_events";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    const { registerObserveHandler } = await import("../../function/observe.ts");

    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const observeMod = mod as Partial<ObserveHandlerModule>;
      if (typeof observeMod.handle === "function") {
        registerObserveHandler(entry.name, observeMod.handle);
        log.debug("Registered custom observe event handler", { name: entry.name });
      } else {
        log.warn("Observe module missing handle function", { name: entry.name, module: entry.module });
      }
    }
  }
}
