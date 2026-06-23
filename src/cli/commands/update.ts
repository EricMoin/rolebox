import { loadConfig, loadLock, addToLock, findInLock } from "../config.js";
import { fetchRegistryManifest, downloadRole, computeIntegrity } from "../registry-client.js";
import { getRolePath } from "../paths.js";
import type { LockEntry } from "../types.js";
import { existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Update installed roles to the latest versions from their registries.
 * `args[0]` optional — if provided, update only that role. Otherwise update all.
 */
export async function update(args: string[]): Promise<void> {
  const config = loadConfig();
  const lock = loadLock();
  const specificRole = args[0];

  let updated = 0;
  let upToDate = 0;

  const rolesToUpdate = specificRole
    ? [findInLock(specificRole)].filter(Boolean) as LockEntry[]
    : lock.roles;

  if (rolesToUpdate.length === 0) {
    if (specificRole) {
      console.log(`Role '${specificRole}' is not installed.`);
    } else {
      console.log("No roles installed. Nothing to update.");
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
    try {
      manifest = await fetchRegistryManifest(registryConfig);
    } catch (err) {
      console.warn(`Warning: could not fetch registry '${entry.registry}': ${(err as Error).message}`);
      continue;
    }

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
      const extractedDir = await downloadRole(registryConfig, entry.role, latestVersion);
      const targetDir = getRolePath(entry.registry, entry.role, latestVersion);
      mkdirSync(join(targetDir, ".."), { recursive: true });

      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }
      renameSync(extractedDir, targetDir);

      const integrity = await computeIntegrity(targetDir);

      addToLock({
        role: entry.role,
        registry: entry.registry,
        version: latestVersion,
        installedAt: new Date().toISOString(),
        integrity,
      });

      console.log(`✓ Updated ${entry.role} from ${entry.version} to ${latestVersion}`);
      updated++;
    } catch (err) {
      console.warn(`Warning: failed to update '${entry.role}': ${(err as Error).message}`);
    }
  }

  const parts: string[] = [];
  if (updated > 0) parts.push(`Updated ${updated} roles`);
  if (upToDate > 0) parts.push(`${upToDate} already up to date`);
  console.log(parts.join(". ") + ".");
  if (updated > 0) {
    console.log("Run `rolebox sync opencode` to deploy changes");
  }
}
