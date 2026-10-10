import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { findInLock, findAllInLock, removeFromLock } from "../config.ts";
import { parseRoleSpec } from "../role-spec.ts";
import type { LockEntry } from "../types.ts";
import { getRolePath, getSyncTarget } from "../paths.ts";
import {
  existsSync,
  rmSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

/**
 * Whether `candidate` is `parent` itself or lies inside it. Both arguments must
 * be of the same kind (both realpath-resolved, or both absolute-normalized):
 * an equal-or-inside test on two different normalizations would compare apples
 * to oranges and could attribute a link to the wrong copy.
 */
function isSameOrInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

/** Strip the `\\?\` prefix Windows junctions store in front of an absolute target. */
function stripWindowsPrefix(target: string): string {
  return target.startsWith("\\\\?\\") ? target.slice(4) : target;
}

/**
 * Whether the link at `linkPath` belongs to the role copy installed at
 * `rolePath` — i.e. whether its destination IS that directory or lies inside it.
 *
 * Identity is the destination, never the link's name: each sync target holds one
 * link per installed role, and the same role id can be installed from several
 * sources, so two links may share a name while pointing at different copies.
 * Resolving both sides first also keeps this honest on Windows, where
 * `createDirSymlink` creates a junction that stores an absolute native target
 * (see src/utils/symlink.ts): realpath reports where such a link actually points,
 * whereas the stored string alone would not be a reliable identity.
 *
 * Only a link that no longer resolves — its destination is already gone — falls
 * back to the target it stores, with the `\\?\` prefix junctions carry stripped,
 * so a dangling link still attributable to the removed copy is cleaned up
 * instead of being left behind.
 *
 * Every fs call is guarded: an unreadable link is left alone, never thrown on.
 */
function linkPointsAtRole(linkPath: string, rolePath: string): boolean {
  let linkReal: string | undefined;
  let roleReal: string | undefined;
  try {
    linkReal = realpathSync(linkPath);
  } catch {
    linkReal = undefined;
  }
  try {
    roleReal = realpathSync(rolePath);
  } catch {
    roleReal = undefined;
  }

  if (linkReal !== undefined) {
    // A live link is attributable only when the role directory it would have to
    // belong to is still there. A live link to another role — or to another
    // source's still-installed copy of the same role id — must survive.
    if (roleReal === undefined) return false;
    return isSameOrInside(linkReal, roleReal);
  }

  // Dangling link: compare the target it stores, resolved against the link's own
  // directory, with the (no longer existing) role directory.
  let stored: string;
  try {
    stored = readlinkSync(linkPath);
  } catch {
    return false;
  }
  return isSameOrInside(resolve(dirname(linkPath), stripWindowsPrefix(stored)), rolePath);
}

/**
 * Collect every sync link across the supported targets (opencode / pi / dsh /
 * codex) whose destination is `rolePath` or lies inside it.
 *
 * This must run BEFORE the role directory is removed: a link's identity is its
 * destination, and once the directory is gone a live-looking link becomes
 * dangling and can no longer be attributed reliably. A missing target directory
 * and an unknown target are both skipped, never errors — cleanup is best-effort.
 */
function collectRoleLinks(rolePath: string): string[] {
  const links: string[] = [];

  for (const target of SYNC_TARGET_VALUES) {
    let syncTarget: string;
    try {
      syncTarget = getSyncTarget(target);
    } catch {
      // Unknown target — nothing to scan.
      continue;
    }

    let names: string[];
    try {
      names = readdirSync(syncTarget);
    } catch {
      // Target directory missing or unreadable — nothing to scan.
      continue;
    }

    for (const name of names) {
      const linkPath = join(syncTarget, name);
      try {
        // Only symlinks are ours; a real directory or file at a target path is
        // the user's (or another tool's) and is never touched.
        if (!lstatSync(linkPath).isSymbolicLink()) continue;
      } catch {
        // Unreadable entry — leave it alone.
        continue;
      }
      if (linkPointsAtRole(linkPath, rolePath)) {
        links.push(linkPath);
      }
    }
  }

  return links;
}

export async function uninstall(spec: string): Promise<void> {
  const parsed = parseRoleSpec(spec);
  const roleId = parsed.roleId;

  // A `registry:role` spec selects that source's copy; a bare role selects the
  // only installed copy and refuses to guess when several sources provide one.
  const entries = parsed.registry
    ? [findInLock(roleId, parsed.registry)].filter((e): e is LockEntry => e !== undefined)
    : findAllInLock(roleId);

  if (entries.length === 0) {
    throw new Error(`Role '${roleId}' is not installed`);
  }

  if (entries.length > 1) {
    throw new Error(
      `Role '${roleId}' is installed from more than one source: ${entries.map((e) => e.registry).join(", ")} — specify one, e.g. 'rolebox uninstall ${entries[0].registry}:${roleId}'`,
    );
  }

  const entry = entries[0];

  const { registry, version } = entry;
  const rolePath = getRolePath(registry, roleId, version);

  // Resolve the links belonging to THIS copy while it is still on disk — a
  // destination can only be attributed reliably while it exists — across every
  // supported target platform (opencode / pi / dsh / codex), since the role may
  // have been synced to any of them.
  const links = collectRoleLinks(rolePath);

  if (existsSync(rolePath)) {
    rmSync(rolePath, { recursive: true, force: true });
  }

  // Best-effort per link: a failed cleanup warns and never aborts the uninstall.
  for (const linkPath of links) {
    try {
      unlinkSync(linkPath);
    } catch {
      console.warn("Warning: Failed to clean up symlink:", linkPath);
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
