import { findInLock, removeFromLock } from "../config.js";
import { getRolePath, getSyncTarget } from "../paths.js";
import { existsSync, rmSync, lstatSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export async function uninstall(args: string[]): Promise<void> {
  const roleId = args[0];

  if (!roleId) {
    console.error("Usage: rolebox uninstall <role-id>");
    process.exit(1);
  }

  const entry = findInLock(roleId);

  if (!entry) {
    console.error(`Role '${roleId}' is not installed`);
    process.exit(1);
  }

  const { registry, version } = entry;
  const rolePath = getRolePath(registry, roleId, version);

  if (existsSync(rolePath)) {
    rmSync(rolePath, { recursive: true, force: true });
  }

  try {
    const syncTarget = getSyncTarget("opencode");
    if (existsSync(syncTarget)) {
      const entries = readdirSync(syncTarget);
      for (const entry of entries) {
        const fullPath = join(syncTarget, entry);
        try {
          if (lstatSync(fullPath).isSymbolicLink()) {
            unlinkSync(fullPath);
          }
        } catch {
        }
      }
    }
  } catch {
  }

  removeFromLock(roleId, registry);

  console.log(`✓ Uninstalled ${roleId}@${version}`);
}
