import { defineCommand } from "citty";
import { loadLock } from "../config.ts";
import { getSyncTarget, getRolePath } from "../paths.ts";
import { SyncTarget } from "../../constants.ts";
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
