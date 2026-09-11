import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, TopologyModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";
import { registerTopology } from "../../graph/templates.ts";
import { addGraphTemplateValue } from "../../constants.ts";

const log = createSubLogger("ext:point:graph-topologies");

export class GraphTopologyExtensionPoint implements ExtensionPoint {
  readonly name = "graph_topologies";

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const topoMod = mod as Partial<TopologyModule>;
      if (typeof topoMod.expand === "function") {
        registerTopology(entry.name, topoMod.expand);
        addGraphTemplateValue(entry.name);
        log.debug("Registered custom graph topology", { name: entry.name });
      } else {
        log.warn("Topology module missing expand function", { name: entry.name, module: entry.module });
      }
    }
  }
}
