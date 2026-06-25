import { homedir } from "node:os";
import { join } from "node:path";
import { SyncTarget } from "../constants.js";

/**
 * Returns the rolebox data directory.
 * Respects XDG_DATA_HOME on Unix (default: ~/.local/share/rolebox).
 * On Windows: uses %LOCALAPPDATA%/rolebox.
 */
export function getDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "rolebox");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "rolebox");
  return join(homedir(), ".local", "share", "rolebox");
}

/**
 * Returns the rolebox config directory.
 * Respects XDG_CONFIG_HOME on Unix (default: ~/.config/rolebox).
 * On Windows: uses %APPDATA%/rolebox.
 */
export function getConfigDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "rolebox");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "rolebox");
  return join(homedir(), ".config", "rolebox");
}

/**
 * Returns the roles storage directory: {dataDir}/roles
 */
export function getRolesDir(): string {
  return join(getDataDir(), "roles");
}

/**
 * Returns the sync target directory for a given tool.
 * Currently only supports "opencode": ~/.config/opencode/rolebox
 * Extensible for future targets.
 */
export function getSyncTarget(target: string): string {
  if (target === SyncTarget.Opencode) {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "opencode", "rolebox");
    return join(homedir(), ".config", "opencode", "rolebox");
  }
  throw new Error(`Unknown sync target: "${target}". Supported targets: opencode`);
}

/**
 * Returns the path for a specific role installation.
 * Format: {rolesDir}/{registry}/{roleId}@{version}
 */
export function getRolePath(registry: string, roleId: string, version: string): string {
  return join(getRolesDir(), registry, `${roleId}@${version}`);
}
