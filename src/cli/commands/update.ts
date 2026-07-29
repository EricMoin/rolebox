import { defineCommand } from "citty";
import { loadConfig, loadLock, addToLock, findInLock } from "../config.ts";
import { fetchRegistryManifest, downloadRole, computeIntegrity } from "../registry-client.ts";
import { DownloadProgress } from "../download-progress.ts";
import { getRolePath } from "../paths.ts";
import type { LockEntry } from "../types.ts";
import { existsSync, rmSync } from "node:fs";
import { moveDir, ensureWritableDir } from "../fs-utils.ts";
import { join } from "node:path";

export interface UpdateOptions {
  quiet?: boolean;       // suppress non-error output
  verbose?: boolean;     // emit per-phase detail
  noProgress?: boolean;  // force degraded line-based progress
}

/**
 * Simple semver comparison: "1.0.0" < "1.1.0" < "2.0.0"
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function update(specificRole: string | undefined, noCache: boolean, opts: UpdateOptions = {}): Promise<void> {
  const progress = new DownloadProgress({
    quiet: opts.quiet,
    verbose: opts.verbose,
    noProgress: opts.noProgress,
  });
  const out = (msg: string) => { if (!opts.quiet) console.log(msg); };
  const config = loadConfig();
  const lock = loadLock();

  let updated = 0;
  let upToDate = 0;

  const rolesToUpdate = specificRole
    ? [findInLock(specificRole)].filter(Boolean) as LockEntry[]
    : lock.roles;

  if (rolesToUpdate.length === 0) {
    if (specificRole) {
      out(`Role '${specificRole}' is not installed.`);
    } else {
      out("No roles installed. Nothing to update.");
    }
    return;
  }

  for (const entry of rolesToUpdate) {
    const registryConfig = config.registries.find(r => r.name === entry.registry);
    if (!registryConfig) {
      console.warn(`Warning: registry '${entry.registry}' not found in config, skipping '${entry.role}'`);
      continue;
    }

    let manifest;
    progress.phaseStart("resolving", entry.role);
    try {
      manifest = await fetchRegistryManifest(registryConfig, undefined, { noCache });
    } catch (err) {
      progress.phaseFail("resolving", { asset: `${entry.role}@${entry.version}`, reason: (err as Error).message, attempt: 1, maxAttempts: 1 });
      console.warn(`Warning: could not fetch registry '${entry.registry}': ${(err as Error).message}. Check your network connection, or verify the registry URL with: rolebox registry list`);
      continue;
    }
    progress.phaseComplete("resolving");

    const roleInfo = manifest.roles[entry.role];
    if (!roleInfo) {
      console.warn(`Warning: role '${entry.role}' not found in registry '${entry.registry}', skipping`);
      continue;
    }

    const latestVersion = roleInfo.version;

    if (compareVersions(latestVersion, entry.version) <= 0) {
      upToDate++;
      continue;
    }

    try {
      // Download + extract + verify into a TEMP location FIRST. The existing
      // version is never removed until the new artifact is fully downloaded,
      // extracted, integrity-checked, and atomically swapped into place
      // (rollback safety). On failure, the previously-installed version stays.
      const extractedDir = await downloadRole(registryConfig, entry.role, latestVersion, undefined, undefined, { progress });

      // Compute + verify integrity on the temp artifact BEFORE swapping it in.
      const integrity = await computeIntegrity(extractedDir);
      const expectedIntegrity = roleInfo.integrity;
      if (expectedIntegrity) {
        // Manifest-declared digest available: the computed digest MUST match.
        if (integrity !== expectedIntegrity) {
          throw new Error(`integrity check failed for role "${entry.role}@${latestVersion}": expected ${expectedIntegrity}, computed ${integrity}; refusing to update`);
        }
      } else {
        // No expected integrity value exists in the manifest. The computed
        // digest is recorded in the lock as a best-effort pin; it cannot be
        // verified against anything without a declared value.
        if (opts.verbose) {
          out(`Computed integrity for ${entry.role}@${latestVersion} (no expected value in manifest): ${integrity}`);
        }
      }

      const targetDir = getRolePath(entry.registry, entry.role, latestVersion);
      progress.phaseStart("installing", targetDir);
      ensureWritableDir(join(targetDir, ".."));

      // Atomic swap: stage into a sibling dir, then rename over the target so
      // the previously-installed version is replaced atomically rather than
      // deleted before the new one is ready.
      const staging = join(join(targetDir, ".."), `.${entry.role}@${latestVersion}.staging-${process.pid}-${Date.now()}`);
      try {
        moveDir(extractedDir, staging);
        if (existsSync(targetDir)) {
          rmSync(targetDir, { recursive: true, force: true });
        }
        moveDir(staging, targetDir);
      } catch (err) {
        // The previously-installed version (if any) is left intact; report
        // partial state clearly.
        try { rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw new Error(
          `failed to place the updated version for "${entry.role}@${latestVersion}"; the previously-installed version is left intact: ${(err as Error).message}`,
        );
      }
      progress.phaseComplete("installing");

      addToLock({
        role: entry.role,
        registry: entry.registry,
        version: latestVersion,
        installedAt: new Date().toISOString(),
        integrity,
      });

      progress.phaseStart("done", `${entry.role}@${latestVersion}`);
      progress.phaseComplete("done", `${entry.role}@${latestVersion}`);
      out(`✓ Updated ${entry.role} from ${entry.version} to ${latestVersion}`);
      updated++;
    } catch (err) {
      console.warn(`Warning: failed to update '${entry.role}': ${(err as Error).message}`);
    }
  }

  const parts: string[] = [];
  if (updated > 0) parts.push(`Updated ${updated} roles`);
  if (upToDate > 0) parts.push(`${upToDate} already up to date`);
  out(parts.join(". ") + ".");
  if (updated > 0) {
    out("Run `rolebox sync opencode` to deploy changes");
  }
}

export default defineCommand({
  meta: {
    name: "update",
    description: "Update installed roles to latest versions",
  },
  args: {
    role: {
      type: "positional",
      required: false,
      description: "Specific role to update (updates all if omitted)",
    },
    noCache: {
      type: "boolean",
      alias: ["no-cache"],
      description: "Bypass registry cache",
    },
    quiet: {
      type: "boolean",
      alias: ["q"],
      description: "Suppress non-error output",
    },
    verbose: {
      type: "boolean",
      alias: ["v"],
      description: "Show per-phase detail",
    },
    noProgress: {
      type: "boolean",
      alias: ["no-progress"],
      description: "Disable progress bars",
    },
  },
  async run({ args }) {
    await update(args.role, args.noCache ?? false, {
      quiet: args.quiet,
      verbose: args.verbose,
      noProgress: args.noProgress,
    });
  },
});
