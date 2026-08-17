import { homedir } from "node:os";
import { join } from "node:path";
import { SyncTarget } from "../constants.ts";
import {
  defaultPlatformPaths,
  dshPlatformPaths,
  piPlatformPaths,
} from "../platform/paths.ts";

// ── Platform seam ─────────────────────────────────────────────────
//
// A minimal, non-invasive test seam: production callers always resolve the
// real `process.platform`, but tests can override it (via setPlatformForTest)
// to exercise the win32 / darwin branches of getDataDir / getConfigDir on any
// host OS without restructuring the module or spawning a real platform.

let _platformOverride: string | undefined;

/** Resolve the current platform. Defaults to `process.platform`. */
export function getPlatform(): string {
  return _platformOverride ?? process.platform;
}

/** Test-only seam. Pass `undefined` to restore the real platform. */
export function setPlatformForTest(platform: string | undefined): void {
  _platformOverride = platform;
}

// ── Opencode Paths ────────────────────────────────────────────────

export function getOpencodeConfigDir(): string {
  return defaultPlatformPaths().configDir;
}

export function getOpencodeConfigPath(): string {
  return join(getOpencodeConfigDir(), "opencode.jsonc");
}

export function getOpencodeSkillsDir(): string {
  return defaultPlatformPaths().skillsDir;
}

// ── Rolebox Paths ─────────────────────────────────────────────────

/**
 * Returns the rolebox data directory.
 * Precedence: ROLEBOX_DATA_DIR env override, then XDG_DATA_HOME/rolebox (all platforms),
 * then %LOCALAPPDATA%/rolebox on Windows, then ~/.local/share/rolebox on Unix.
 */
export function getDataDir(): string {
  const override = process.env.ROLEBOX_DATA_DIR;
  if (override) return override;

  // XDG_DATA_HOME is honored on ALL platforms (including win32) so the data dir
  // can be isolated consistently on Windows too. This sits below the
  // ROLEBOX_DATA_DIR override and above the platform-specific branches.
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return join(xdgData, "rolebox");

  if (getPlatform() === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "rolebox");
  }

  // Darwin (macOS): deliberate parity with opencode's config location
  // (~/.local/share / ~/.config), NOT ~/Library/Application Support.
  // Relocating would orphan existing installs, so keep the XDG-style layout.
  if (getPlatform() === "darwin") {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".local", "share", "rolebox");
  }

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "rolebox");
  return join(homedir(), ".local", "share", "rolebox");
}

/**
 * Returns the rolebox config directory.
 * Precedence: ROLEBOX_CONFIG_DIR env override, then XDG_CONFIG_HOME/rolebox (all platforms),
 * then %APPDATA%/rolebox on Windows, then ~/.config/rolebox on Unix.
 */
export function getConfigDir(): string {
  const override = process.env.ROLEBOX_CONFIG_DIR;
  if (override) return override;

  // XDG_CONFIG_HOME is honored on ALL platforms (including win32) so the config
  // dir can be isolated consistently on Windows too. This sits below the
  // ROLEBOX_CONFIG_DIR override and above the platform-specific branches.
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return join(xdgConfig, "rolebox");

  if (getPlatform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "rolebox");
  }

  // Darwin (macOS): deliberate parity with opencode's config location
  // (~/.config / ~/.local/share), NOT ~/Library/Application Support.
  // Relocating would orphan existing installs, so keep the XDG-style layout.
  if (getPlatform() === "darwin") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg) return join(xdg, "rolebox");
    return join(homedir(), ".config", "rolebox");
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
 * Delegates to the PlatformPaths registry for directory resolution:
 * - `"opencode"` → `{~/.config/opencode}/rolebox`
 * - `"pi"` → `{$PI_CODING_AGENT_DIR or ~/.pi/agent}/rolebox`
 * - `"dsh"` → `{$DSH_HOME or ~/.dsh}/rolebox`
 *
 * Each path matches where the corresponding runtime entry point resolves
 * its `roleboxDir` (see `resolveRoleboxDirectories` in platform/factory.ts).
 */
export function getSyncTarget(target: string): string {
  if (target === SyncTarget.Opencode) {
    return join(defaultPlatformPaths().configDir, "rolebox");
  }
  if (target === SyncTarget.Pi) {
    return join(piPlatformPaths().configDir, "rolebox");
  }
  if (target === SyncTarget.Dsh) {
    return join(dshPlatformPaths().configDir, "rolebox");
  }
  throw new Error(
    `Unknown sync target: "${target}". Supported targets: opencode, pi, dsh`,
  );
}

/**
 * Returns the path for a specific role installation.
 * Format: {rolesDir}/{registry}/{roleId}@{version}
 *
 * `registry` and `roleId` are validated before being used as path components so
 * that a crafted value can never escape `{rolesDir}` or reach `rmSync` (the
 * arbitrary-delete vector). Invalid inputs are rejected with an actionable
 * error rather than silently mangled.
 */
export function getRolePath(registry: string, roleId: string, version: string): string {
  assertSafePathSegment(registry, "registry");
  assertSafePathSegment(roleId, "roleId");
  assertSafePathSegment(version, "version");
  return join(getRolesDir(), registry, `${roleId}@${version}`);
}

const WIN_INVALID_CHARS = /[:*?"<>|]/;

const WIN_RESERVED_NAMES = new Set<string>([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Validate that a single path segment (registry name, roleId, or version) is safe
 * to use verbatim as a directory/file component. Throws an actionable error
 * (naming the offending segment and its value) instead of silently mangling it.
 */
export function assertSafePathSegment(value: string, label: string): void {
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(
      `${label} '${value}' contains a path separator; refusing to use it in a filesystem path`,
    );
  }
  if (value.includes("..")) {
    throw new Error(
      `${label} '${value}' contains '..' (path traversal); refusing to use it in a filesystem path`,
    );
  }
  if (value.startsWith(".")) {
    throw new Error(
      `${label} '${value}' starts with a dot; refusing to use it in a filesystem path`,
    );
  }
  if (WIN_INVALID_CHARS.test(value)) {
    throw new Error(
      `${label} '${value}' contains a Windows-invalid character (one of : * ? " < > |); refusing to use it in a filesystem path`,
    );
  }
  if (WIN_RESERVED_NAMES.has(value.toUpperCase())) {
    throw new Error(
      `${label} '${value}' is a Windows reserved device name; refusing to use it in a filesystem path`,
    );
  }
  if (value.trim() === "") {
    throw new Error(`${label} is empty; refusing to use it in a filesystem path`);
  }
}

// ── Pi Paths ───────────────────────────────────────────────────────

/** `~/.pi/agent` — delegates to `piPlatformPaths().configDir` */
export function getPiConfigDir(): string {
  return piPlatformPaths().configDir;
}

/** `~/.pi/agent/skills` — delegates to `piPlatformPaths().skillsDir` */
export function getPiSkillsDir(): string {
  return piPlatformPaths().skillsDir;
}

/** `~/.pi/agent/sessions` — delegates to `piPlatformPaths().sessionsDir` */
export function getPiSessionsDir(): string {
  return piPlatformPaths().sessionsDir!;
}

/** `~/.pi/agent/extensions` — delegates to `piPlatformPaths().extensionsDir` */
export function getPiExtensionsDir(): string {
  return piPlatformPaths().extensionsDir!;
}
