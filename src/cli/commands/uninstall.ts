import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { findInLock, removeFromLock } from "../config.ts";
import { getRolePath, getSyncTarget } from "../paths.ts";
import { existsSync, rmSync, lstatSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SYNC_TARGET_VALUES } from "../../constants.ts";
import { assertInteractiveContext, pickInstalledRole } from "../pick.ts";
import type { PromptApi } from "../pick.ts";

/**
 * Interactive flow for `rolebox uninstall` without a role: pick an installed
 * role, confirm, then uninstall. Returns true when an uninstall was performed,
 * false when the user cancelled. `prompts` is injectable for tests.
 */
export async function uninstallInteractive(prompts: PromptApi = clack): Promise<boolean> {
  assertInteractiveContext(
    "uninstall",
    "Pass the role explicitly, e.g. `rolebox uninstall software-architect`.",
  );

  prompts.intro("rolebox uninstall");
  const roleId = await pickInstalledRole("Select a role to uninstall:", prompts);
  if (!roleId) {
    prompts.cancel("Operation cancelled.");
    return false;
  }

  const confirmed = await prompts.confirm({
    message: `Uninstall "${roleId}"?`,
  });
  if (prompts.isCancel(confirmed) || !confirmed) {
    prompts.cancel("Operation cancelled.");
    return false;
  }

  prompts.outro("Uninstalling…");
  await uninstall(roleId);
  return true;
}

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

  // Clean up sync symlinks across every supported target platform
  // (opencode / pi / dsh) — the role may have been synced to any of them.
  for (const target of SYNC_TARGET_VALUES) {
    try {
      const syncTarget = getSyncTarget(target);
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
      description: "Role ID to uninstall. Omit for interactive selection",
      required: false,
    },
  },
  async run({ args }) {
    if (!args.role) {
      await uninstallInteractive();
      return;
    }
    await uninstall(args.role);
  },
});
