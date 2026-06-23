import { loadLock } from "../config";
import { getSyncTarget, getRolePath } from "../paths";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Sync installed roles to a target tool's configuration directory.
 * Currently only supports "opencode".
 *
 * Flow:
 *   1. Parse args, default to "opencode" if not provided
 *   2. Validate target via getSyncTarget (throws if unknown)
 *   3. Create target directory if it doesn't exist
 *   4. Load lock file to get all installed roles
 *   5. For each installed role, create/update symlink
 *   6. Clean up stale (broken) symlinks
 *   7. Print summary
 */
export async function sync(args: string[]): Promise<void> {
  const target = args[0] || "opencode";

  let syncTarget: string;
  try {
    syncTarget = getSyncTarget(target);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

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
        `Warning: source for '${role}' not found at ${sourcePath}, skipping`,
      );
      skipped++;
      continue;
    }

    if (existsSync(targetPath)) {
      let linkStat;
      try {
        linkStat = lstatSync(targetPath);
      } catch {
        console.warn(
          `Warning: could not access '${targetPath}', skipping`,
        );
        skipped++;
        continue;
      }

      if (linkStat.isSymbolicLink()) {
        unlinkSync(targetPath);
        symlinkSync(sourcePath, targetPath);
        synced++;
      } else {
        console.warn(
          `Warning: '${targetPath}' is a regular directory, skipping`,
        );
        skipped++;
      }
    } else {
      symlinkSync(sourcePath, targetPath);
      synced++;
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
}
