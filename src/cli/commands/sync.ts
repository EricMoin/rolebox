import { defineCommand } from "citty";
import { loadLock } from "../config.ts";
import { getSyncTarget, getRolePath } from "../paths.ts";
import { SyncTarget } from "../../constants.ts";
import {
  scanAvailableModels,
  findPlaceholderRoles,
} from "../model-utils.ts";
import type { RoleModelEntry } from "../model-utils.ts";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createDirSymlink } from "../../utils/symlink.ts";

export async function sync(target: string): Promise<void> {
  const syncTarget = getSyncTarget(target);

  mkdirSync(syncTarget, { recursive: true });

  const lock = loadLock();

  let synced = 0;
  let skipped = 0;

  for (const entry of lock.roles) {
    const { role, registry, version } = entry;
    const sourcePath = getRolePath(registry, role, version);
    const targetPath = join(syncTarget, role);

    if (!existsSync(sourcePath)) {
      console.warn(
        `Warning: source for '${role}' not found at ${sourcePath}, skipping. Try reinstalling: rolebox install ${role}`,
      );
      skipped++;
      continue;
    }

    // lstatSync (not existsSync): existsSync follows symlinks and misses broken ones
    let targetStat;
    try {
      targetStat = lstatSync(targetPath);
    } catch {
      targetStat = null;
    }

    if (targetStat === null) {
      createDirSymlink(sourcePath, targetPath);
      synced++;
    } else if (targetStat.isSymbolicLink()) {
      unlinkSync(targetPath);
      createDirSymlink(sourcePath, targetPath);
      synced++;
    } else if (targetStat.isDirectory()) {
      console.warn(
        `Warning: '${targetPath}' is a regular directory, skipping`,
      );
      skipped++;
    } else {
      console.warn(
        `Warning: '${targetPath}' is a regular file, skipping`,
      );
      skipped++;
    }
  }

  let cleaned = 0;
  try {
    const entries = readdirSync(syncTarget);
    for (const entry of entries) {
      const fullPath = join(syncTarget, entry);
      try {
        const linkStat = lstatSync(fullPath);
        if (linkStat.isSymbolicLink()) {
          try {
            statSync(fullPath);
          } catch {
            unlinkSync(fullPath);
            cleaned++;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // target dir might not exist or be unreadable — non-fatal
  }

  const parts: string[] = [`Synced ${synced} roles to ${target}`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (cleaned > 0) parts.push(`${cleaned} cleaned`);
  console.log(parts.join(", "));

  // ── Placeholder detection ───────────────────────────────────────────
  const availableModels = scanAvailableModels();
  const knownModelIds = availableModels.map((m) => m.id);

  // Scan each synced role for placeholder models
  const rolesWithPlaceholders: { role: string; entries: RoleModelEntry[] }[] = [];

  for (const entry of lock.roles) {
    const roleTargetPath = join(syncTarget, entry.role);
    if (!existsSync(roleTargetPath)) continue;

    const placeholders = findPlaceholderRoles(roleTargetPath, knownModelIds);
    if (placeholders.length > 0) {
      rolesWithPlaceholders.push({ role: entry.role, entries: placeholders });
    }
  }

  if (rolesWithPlaceholders.length > 0) {
    console.log("");
    console.warn("⚠  Roles with unconfigured models detected:");
    for (const { role, entries } of rolesWithPlaceholders) {
      const models = [...new Set(entries.map((e) => e.model))].join(", ");
      console.warn(`   ${role}: ${models}`);
    }
    console.log("");
    console.log("   Run `rolebox config <role-name>` to configure models interactively.");
  }
}

export default defineCommand({
  meta: {
    name: "sync",
    description: "Deploy roles to target tool (e.g. opencode)",
  },
  args: {
    target: {
      type: "positional",
      description: "Sync target (default: opencode)",
      default: SyncTarget.Opencode,
    },
  },
  async run({ args }) {
    await sync(args.target);
  },
});
