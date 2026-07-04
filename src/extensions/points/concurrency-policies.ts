import type { ExtensionPoint } from "../extension-point.ts";
import type { ExtensionEntry, ConcurrencyPolicyModule } from "../types.ts";
import { loadExtensionModule } from "../loader.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("ext:point:concurrency-policies");

export class ConcurrencyPolicyExtensionPoint implements ExtensionPoint {
  readonly name = "concurrency_policies";
  private policies = new Map<string, ConcurrencyPolicyModule>();

  async load(entries: ExtensionEntry[], roleDir: string): Promise<void> {
    for (const entry of entries) {
      const mod = await loadExtensionModule(entry.module, roleDir);
      if (!mod) continue;

      const policyMod = mod as Partial<ConcurrencyPolicyModule>;
      if (typeof policyMod.create === "function") {
        this.policies.set(entry.name, policyMod as ConcurrencyPolicyModule);
        log.debug("Registered custom concurrency policy", { name: entry.name });
      } else {
        log.warn("Concurrency policy module missing create function", {
          name: entry.name,
          module: entry.module,
          exports: Object.keys(mod),
        });
      }
    }
  }

  getPolicies(): Map<string, ConcurrencyPolicyModule> {
    return this.policies;
  }

  /** Get the first (or named) policy module. Returns undefined if none loaded. */
  getPolicy(name?: string): ConcurrencyPolicyModule | undefined {
    if (name) return this.policies.get(name);
    // Return the first registered policy
    for (const [, mod] of this.policies) return mod;
    return undefined;
  }
}
