import { loadConfig, loadLock, addToLock, findInLock } from "../config";
import { fetchRegistryManifest, downloadRole, resolveVersion, computeIntegrity } from "../registry-client";
import { getRolePath } from "../paths";
import type { LockEntry } from "../types";
import { existsSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface InstallOptions {
  registry?: string;     // registry name (defaults to first default registry)
  version?: string;      // specific version
}

/**
 * Parse a role specifier like:
 *   "software-architect"          → roleId="software-architect"
 *   "software-architect@1.0.0"   → roleId="software-architect", version="1.0.0"
 *   "my-registry:custom-role"    → registry="my-registry", roleId="custom-role"
 *   "my-registry:role@2.0.0"     → registry="my-registry", roleId="role", version="2.0.0"
 */
export function parseRoleSpec(spec: string): { roleId: string; registry?: string; version?: string } {
  let remaining = spec;
  let registry: string | undefined;
  let version: string | undefined;

  const colonIdx = remaining.indexOf(":");
  if (colonIdx !== -1) {
    registry = remaining.slice(0, colonIdx);
    remaining = remaining.slice(colonIdx + 1);
  }

  const atIdx = remaining.lastIndexOf("@");
  if (atIdx !== -1) {
    version = remaining.slice(atIdx + 1);
    remaining = remaining.slice(0, atIdx);
  }

  return { roleId: remaining, registry, version };
}

/**
 * Install a role from a registry.
 */
export async function install(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) {
    throw new Error("usage: rolebox install <role>[@version]");
  }

  // 1. Parse role spec
  const parsed = parseRoleSpec(spec);

  // 2. Load config to find registry URL
  const config = loadConfig();

  // 3. Determine registry
  let registryName: string;
  if (parsed.registry) {
    registryName = parsed.registry;
    const found = config.registries.find((r) => r.name === registryName);
    if (!found) {
      throw new Error(`Registry '${registryName}' not found`);
    }
  } else {
    const defaultRegistry = config.registries.find((r) => r.default) ?? config.registries[0];
    if (!defaultRegistry) {
      throw new Error("No registries configured. Run 'rolebox registry add' to add one.");
    }
    registryName = defaultRegistry.name;
  }

  const registryEntry = config.registries.find((r) => r.name === registryName)!;

  // 4. Fetch registry manifest
  const manifest = await fetchRegistryManifest(registryEntry);

  // 5. Resolve version
  let version: string;
  if (parsed.version) {
    version = parsed.version;
    // Verify the role exists in manifest
    if (!manifest.roles[parsed.roleId]) {
      throw new Error(`role "${parsed.roleId}" not found in registry "${registryName}"`);
    }
  } else {
    version = resolveVersion(manifest, parsed.roleId);
  }

  // 6. Check lock file — if already installed at same version, print and exit
  const existing = findInLock(parsed.roleId);
  if (existing && existing.version === version) {
    console.log(`Role "${parsed.roleId}@${version}" is already installed from ${existing.registry}`);
    return;
  }

  // 7. If already installed at different version, remove old directory first
  if (existing) {
    const oldPath = getRolePath(existing.registry, existing.role, existing.version);
    if (existsSync(oldPath)) {
      rmSync(oldPath, { recursive: true, force: true });
    }
  }

  // 8. Download and extract role
  const extractedDir = await downloadRole(registryEntry, parsed.roleId, version);

  // 9. Move extracted role to {rolesDir}/{registry}/{roleId}@{version}/
  const targetDir = getRolePath(registryName, parsed.roleId, version);
  mkdirSync(join(targetDir, ".."), { recursive: true });

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  renameSync(extractedDir, targetDir);

  // 10. Compute integrity hash
  const integrity = await computeIntegrity(targetDir);

  // 11. Update lock file
  const entry: LockEntry = {
    role: parsed.roleId,
    registry: registryName,
    version,
    installedAt: new Date().toISOString(),
    integrity,
  };
  addToLock(entry);

  // 12. Print success
  console.log(`✓ Installed ${parsed.roleId}@${version} from ${registryName}`);

  // 13. Print hint
  console.log(`Run \`rolebox sync opencode\` to deploy`);
}
