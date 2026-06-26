import { defineCommand } from "citty";
import { findInLock, removeFromLock } from "../config.ts";
import { getRolePath, getSyncTarget } from "../paths.ts";
import { existsSync, rmSync, lstatSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SyncTarget } from "../../constants.ts";

export async function uninstall(roleId: string): Promise<void> {
  const entry = findInLock(roleId);

  if (!entry) {
    throw new Error(`Role '${roleId}' is not installed`);
  }

  const { registry, version } = entry;
  const rolePath = getRolePath(registry, roleId, version);

  if (existsSync(rolePath)) {
    rmSync(rolePath, { recursive: true, force: true });
  }

  try {
    const syncTarget = getSyncTarget(SyncTarget.Opencode);
    if (existsSync(syncTarget)) {
      const entries = readdirSync(syncTarget);
      for (const entry of entries) {
        const fullPath = join(syncTarget, entry);
        try {
          if (lstatSync(fullPath).isSymbolicLink()) {
            unlinkSync(fullPath);
          }
        } catch {
          console.warn("Warning: Failed to clean up symlink:", fullPath);
        }
      }
    }
  } catch {
    // Best-effort — symlink cleanup should not crash uninstall
  }

  removeFromLock(roleId, registry);

  console.log(`✓ Uninstalled ${roleId}@${version}`);
}

export default defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove an installed role",
  },
  args: {
    role: {
      type: "positional",
      description: "Role ID to uninstall",
      required: true,
    },
  },
  async run({ args }) {
    await uninstall(args.role);
  },
});
