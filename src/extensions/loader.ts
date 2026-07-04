import { join, dirname, isAbsolute } from "node:path";
import type { ExtensionModule } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("ext:loader");

const cache = new Map<string, ExtensionModule | null>();

/**
 * Dynamically import an extension module from disk.
 * Returns null (never throws) on failure — logs a warning.
 * @param modulePath Path to the module file (relative to roleDir or absolute)
 * @param roleDir The role's directory for relative path resolution
 */
export async function loadExtensionModule(
  modulePath: string,
  roleDir: string,
): Promise<ExtensionModule | null> {
  const abs = isAbsolute(modulePath)
    ? modulePath
    : join(roleDir, modulePath);

  if (cache.has(abs)) return cache.get(abs)!;

  try {
    const mod = (await import(abs)) as ExtensionModule;
    cache.set(abs, mod);
    return mod;
  } catch (err) {
    log.warn("Failed to load extension module", { modulePath: abs, err });
    cache.set(abs, null);
    return null;
  }
}

/** Clear the module cache — for testing or hot-reload scenarios. */
export function clearExtensionModuleCache(): void {
  cache.clear();
}
