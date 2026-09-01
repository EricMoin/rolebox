import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { findInLock, removeFromLock, loadLock } from "../config.ts";
import { getRolePath, getSyncTarget } from "../paths.ts";
import { existsSync, rmSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SYNC_TARGET_VALUES } from "../../constants.ts";
import { assertInteractiveContext, pickInstalledRole } from "../pick.ts";
import { removeLinkSafe } from "../../utils/symlink.ts";
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

  // WIN-009: before deleting the source dir, detect whether ANY other lock
  // entry resolves (via getRolePath) to a path equal to this role's source —
  // CASE-INSENSITIVELY. On a case-insensitive filesystem (Windows / APFS) two
  // case-variant role IDs can resolve to the SAME physical directory, so
  // deleting one would silently destroy the other's data (permanent loss).
  // When a sibling shares the source, keep the source dir, only drop this
  // role's lock entry, and warn naming the sibling.
  let sharedSource = false;
  let siblingRole = "";
  const lock = loadLock();
  for (const other of lock.roles) {
    if (other.role === entry.role && other.registry === entry.registry) continue;
    const otherPath = getRolePath(other.registry, other.role, other.version);
    if (resolve(otherPath).toLowerCase() === resolve(rolePath).toLowerCase()) {
      sharedSource = true;
      siblingRole = other.role;
      break;
    }
  }

  if (sharedSource) {
    console.warn(
      `Warning: '${roleId}' shares its source directory with '${siblingRole}'. ` +
        `Skipping source removal to avoid deleting the sibling role's data.`,
    );
  } else if (existsSync(rolePath)) {
    rmSync(rolePath, { recursive: true, force: true });
  }

  // Clean up sync symlinks across every supported target platform
  // (opencode / pi / dsh) — the role may have been synced to any of them.
  // Only remove links whose readlink target resolves to THIS role's source;
  // never blindly unlink every symlink in a sync target (that would destroy
  // other roles' links). When a sibling shares this source (WIN-009), leave
  // the shared link untouched so the sibling stays reachable.
  for (const target of SYNC_TARGET_VALUES) {
    try {
      const syncTarget = getSyncTarget(target);
      if (existsSync(syncTarget)) {
        const entries = readdirSync(syncTarget);
        for (const entryName of entries) {
          const fullPath = join(syncTarget, entryName);
          try {
            if (lstatSync(fullPath).isSymbolicLink()) {
              const linkTarget = readlinkSync(fullPath);
              const pointsAtRole = resolve(linkTarget) === resolve(rolePath);
              if (pointsAtRole && !sharedSource) {
                removeLinkSafe(fullPath);
              }
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
