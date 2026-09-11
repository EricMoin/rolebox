import { join, dirname, isAbsolute } from "node:path";
import type { HookModule } from "./types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:custom-loader");

const cache = new Map<string, HookModule | null>();

export async function loadHookModule(
  modulePath: string,
  roleDir: string,
): Promise<HookModule | null> {
  const abs = isAbsolute(modulePath)
    ? modulePath
    : join(roleDir, modulePath);

  if (cache.has(abs)) return cache.get(abs)!;

  try {
    const mod = (await import(abs)) as HookModule;
    cache.set(abs, mod);
    return mod;
  } catch (err) {
    log.warn("Failed to load custom hook module", { modulePath: abs, err });
    cache.set(abs, null);
    return null;
  }
}

/** Clear the module cache — for testing or hot-reload scenarios. */
export function clearHookModuleCache(): void {
  cache.clear();
}
