import { dump } from "js-yaml";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getConfigDir } from "./paths.ts";
import { parseConfigFromYaml, parseLockFileFromYaml } from "./schemas.ts";
import type { RoleboxConfig, LockFile, LockEntry } from "./types.ts";

const DEFAULT_CONFIG: RoleboxConfig = {
  registries: [
    {
      name: "oh-my-role",
      url: "https://github.com/EricMoin/oh-my-role",
      default: true,
    },
  ],
};

export function getConfigPath(): string {
  return join(getConfigDir(), "config.yaml");
}

export function getLockPath(): string {
  return join(getConfigDir(), "rolebox.lock");
}

/** Ensure config directory exists */
export function ensureConfigDir(): void {
  mkdirSync(getConfigDir(), { recursive: true });
}

/**
 * Load config from ~/.config/rolebox/config.yaml.
 * If file doesn't exist, creates and returns default config
 * with the oh-my-role registry.
 */
export function loadConfig(): RoleboxConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return {
      registries: DEFAULT_CONFIG.registries.map((r) => ({ ...r })),
    };
  }
  const yaml = readFileSync(configPath, "utf-8");
  return parseConfigFromYaml(yaml);
}

/**
 * Save config to ~/.config/rolebox/config.yaml.
 */
export function saveConfig(config: RoleboxConfig): void {
  ensureConfigDir();
  const yaml = dump(config);
  writeFileSync(getConfigPath(), yaml, "utf-8");
}

/**
 * Load lock file from ~/.config/rolebox/rolebox.lock.
 * If file doesn't exist, returns empty LockFile { version: 1, roles: [] }.
 */
export function loadLock(): LockFile {
  const lockPath = getLockPath();
  if (!existsSync(lockPath)) {
    return { version: 1, roles: [] };
  }
  const yaml = readFileSync(lockPath, "utf-8");
  return parseLockFileFromYaml(yaml);
}

/**
 * Save lock file to ~/.config/rolebox/rolebox.lock.
 */
export function saveLock(lock: LockFile): void {
  ensureConfigDir();
  const yaml = dump(lock);
  writeFileSync(getLockPath(), yaml, "utf-8");
}

/**
 * Add or update a role entry in the lock file.
 * If the role+registry combo already exists, update version/installedAt/integrity.
 * Returns the updated LockFile.
 */
export function addToLock(entry: LockEntry): LockFile {
  const lock = loadLock();
  const index = lock.roles.findIndex(
    (r) => r.role === entry.role && r.registry === entry.registry,
  );
  if (index !== -1) {
    lock.roles[index] = entry;
  } else {
    lock.roles.push(entry);
  }
  saveLock(lock);
  return lock;
}

/**
 * Remove a role entry from the lock file by role ID and registry name.
 * Returns the updated LockFile.
 */
export function removeFromLock(roleId: string, registry: string): LockFile {
  const lock = loadLock();
  lock.roles = lock.roles.filter(
    (r) => !(r.role === roleId && r.registry === registry),
  );
  saveLock(lock);
  return lock;
}

/**
 * Find a role entry in the lock file by role ID (checked across all registries).
 * Returns the LockEntry if found, undefined otherwise.
 */
export function findInLock(roleId: string): LockEntry | undefined {
  const lock = loadLock();
  return lock.roles.find((r) => r.role === roleId);
}
