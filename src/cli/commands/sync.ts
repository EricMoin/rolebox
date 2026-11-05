import { defineCommand } from "citty";
import { loadLock } from "../config.ts";
import { getSyncTarget, getTargetSkillsDir, getRolePath } from "../paths.ts";
import { syncBuiltinSkills } from "../../sync/builtin-skills.ts";
import { SyncTarget } from "../../constants.ts";
import { scanModelsForTarget } from "../../platform/model-catalog/index.ts";
import { PLATFORM_REGISTRY } from "../../platform/registry.ts";
import { findPlaceholderRoles } from "../role-models.ts";
import type { RoleModelEntry } from "../role-models.ts";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  statSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createDirSymlink } from "../../utils/symlink.ts";

/**
 * Build a filesystem-safe, collision-free backup path beside the target:
 * `<role>.backup-<ISO>`. Colons and dots in the ISO timestamp are replaced
 * with hyphens because Windows forbids `:` in filenames. A numeric suffix is
 * appended on the (astronomically unlikely) millisecond collision so a backup
 * can never overwrite an earlier one.
 */
function makeBackupPath(syncTarget: string, role: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backupPath = join(syncTarget, `${role}.backup-${stamp}`);
  let n = 1;
  while (existsSync(backupPath)) {
    backupPath = join(syncTarget, `${role}.backup-${stamp}-${n}`);
    n++;
  }
  return backupPath;
}

/**
 * Deploy every locked role into the sync target as a symlink to its shared
 * source.
 *
 * `relink` defaults to `false`: a real (non-symlink) directory at a target
 * path is only reported, never mutated. Passing `relink: true` opts into the
 * destructive reconciliation — the divergent directory is copied to a
 * timestamped backup beside the target BEFORE the original is removed, then
 * the correct symlink is created.
 */
export async function sync(target: string, relink = false): Promise<void> {
  const syncTarget = getSyncTarget(target);

  mkdirSync(syncTarget, { recursive: true });
  syncBuiltinSkills(getTargetSkillsDir(target));

  const lock = loadLock();

  let synced = 0;
  let skipped = 0;
  const unlinkedDirs: { role: string; path: string }[] = [];
  const relinkedDirs: { role: string; target: string; backup: string }[] = [];

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
      if (!relink) {
        // Default behavior: report only, never mutate a divergent directory.
        console.warn(
          `Warning: '${targetPath}' is a regular directory, skipping`,
        );
        unlinkedDirs.push({ role, path: targetPath });
        skipped++;
      } else {
        // Opt-in reconciliation. Copy to a timestamped backup BESIDE the
        // target BEFORE removing the original, so a failed copy leaves the
        // divergent directory fully intact.
        const backupPath = makeBackupPath(syncTarget, role);
        cpSync(targetPath, backupPath, { recursive: true });
        rmSync(targetPath, { recursive: true, force: true });
        createDirSymlink(sourcePath, targetPath);
        relinkedDirs.push({ role, target: targetPath, backup: backupPath });
        synced++;
      }
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

  // ── Host-owned post-sync/install step ───────────────────────────────
  // A target whose integration needs more than role symlinks declares a
  // `postSync` hook on its platform descriptor (Codex writes its plugin
  // bundle and registers it in `config.toml`). The CLI stays neutral: it asks
  // the descriptor for the target and calls the hook when one is declared.
  const descriptor = PLATFORM_REGISTRY.find((p) => p.id === target);
  await descriptor?.postSync?.({ syncTarget });

  // ── Relinked role directories ───────────────────────────────────────
  // Only populated by an explicit `--relink`. The original directory was
  // copied to `backup` before the symlink replaced it, so no local edits are
  // lost. Both paths are reported so the user can find the backup.
  if (relinkedDirs.length > 0) {
    console.log("");
    console.log("↻ Relinked divergent role directories:");
    for (const { role, target: tPath, backup } of relinkedDirs) {
      console.log(`   ${role}: backup → ${backup}`);
      console.log(`   ${role}: symlink → ${tPath}`);
    }
  }

  // ── Unlinked role directories ───────────────────────────────────────
  // A regular directory at a target path shadows the shared source, so this
  // role diverges from every other platform and never receives updates.
  // Detection is read-only here; `--relink` performs the reconciliation.
  if (unlinkedDirs.length > 0) {
    console.log("");
    console.warn("⚠  Role directories not tracked by rolebox detected:");
    for (const { role, path } of unlinkedDirs) {
      console.warn(`   ${role}: ${path}`);
    }
    console.log("");
    console.log(
      "   These directories are NOT tracked by rolebox and will never receive",
    );
    console.log(
      "   updates from other platforms. To repair, back up any local changes, then run:",
    );
    console.log(`   rolebox sync ${target} --relink`);
  }

  // ── Placeholder detection ───────────────────────────────────────────
  // The project cwd contributes opencode's project-level documents: a model
  // declared only in the project must not be reported as unconfigured.
  const availableModels = scanModelsForTarget(target, {
    projectDir: process.cwd(),
  });
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
    description: "Deploy roles to target tool (opencode | pi | dsh | codex)",
  },
  args: {
    target: {
      type: "positional",
      description: "Sync target: opencode, pi, dsh, or codex (default: opencode)",
      default: SyncTarget.Opencode,
    },
    relink: {
      type: "boolean",
      description:
        "Reconcile divergent real directories: copy each to a timestamped backup beside the target, then replace it with the correct symlink",
    },
  },
  async run({ args }) {
    await sync(args.target, args.relink ?? false);
  },
});
