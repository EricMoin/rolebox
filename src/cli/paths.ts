import { homedir } from "node:os";
import { join } from "node:path";
import type { PlatformPaths } from "../platform/paths.ts";
import {
  defaultPlatformPaths,
  piPlatformPaths,
} from "../platform/paths.ts";
import { PLATFORM_REGISTRY } from "../platform/registry.ts";

/**
 * Strictly resolve a CLI sync target's platform paths from the registry.
 * Throws the CLI-flavored "Unknown sync target" error (listing supported ids)
 * for an unknown target — registry-backed, with no per-platform branches.
 */
function resolveSyncTargetPaths(target: string): PlatformPaths {
  const platform = PLATFORM_REGISTRY.find((p) => p.id === target);
  if (!platform) {
    throw new Error(
      `Unknown sync target: "${target}". Supported targets: ${PLATFORM_REGISTRY.map((p) => p.id).join(", ")}`,
    );
  }
  return platform.paths();
}

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
 * Normalize an env-var path override before returning it. A cmd.exe
 * `set VAR="C:\path\"` value carries literal surrounding quotes (and a trailing
 * backslash) that would resolve to an invalid path on Windows; also trim any
 * surrounding whitespace. Steps: strip matched surrounding single/double quotes,
 * trim whitespace, strip a lone trailing quote, then strip trailing path
 * separators. If the value collapses to empty, return "" so the caller falls
 * through to the default resolution instead of returning a useless override.
 */
function normalizeEnvDirOverride(raw: string): string {
  let v = raw.trim();
  // Strip a matched pair of surrounding single or double quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  // Strip a lone trailing quote (an unbalanced quote is equally unusable).
  if (v.endsWith('"') || v.endsWith("'")) {
    v = v.slice(0, -1);
  }
  // Strip trailing path separators (both / and \).
  return v.replace(/[\\/]+$/, "");
}

/**
 * Returns the rolebox data directory.
 * Precedence: ROLEBOX_DATA_DIR env override, then XDG_DATA_HOME/rolebox (all platforms),
 * then %LOCALAPPDATA%/rolebox on Windows, then ~/.local/share/rolebox on Unix.
 */
export function getDataDir(): string {
  const override = process.env.ROLEBOX_DATA_DIR;
  if (override) {
    const normalized = normalizeEnvDirOverride(override);
    if (normalized) return normalized;
  }

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
  if (override) {
    const normalized = normalizeEnvDirOverride(override);
    if (normalized) return normalized;
  }

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
  return join(resolveSyncTargetPaths(target).configDir, "rolebox");
}

/**
 * Returns the config (home) directory for a given sync target — the directory
 * whose presence indicates the tool is installed on this machine.
 * - `opencode` → `~/.config/opencode`
 * - `pi` → `$PI_CODING_AGENT_DIR` or `~/.pi/agent`
 * - `dsh` → `$DSH_HOME` or `~/.dsh`
 */
export function getTargetConfigDir(target: string): string {
  return resolveSyncTargetPaths(target).configDir;
}

/**
 * Returns the skills directory for a given sync target — where rolebox skill
 * symlinks are deployed for that tool's skill discovery.
 * - `opencode` → `{~/.config/opencode}/skills`
 * - `pi` → `{~/.pi/agent}/skills`
 * - `dsh` → `{~/.dsh}/skills`
 */
export function getTargetSkillsDir(target: string): string {
  return resolveSyncTargetPaths(target).skillsDir;
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
 * The base name Windows uses to decide if a segment is a reserved device name:
 * uppercased, trailing dots/spaces stripped (Windows strips them before matching),
 * then cut at the first dot. "CON.txt", "CON." and "CON. " all reduce to "CON".
 */
function winReservedBase(raw: string): string {
  let s = raw.toUpperCase().replace(/[\s.]+$/, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot);
  return s.replace(/[\s.]+$/, "");
}

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
  if (WIN_RESERVED_NAMES.has(winReservedBase(value))) {
    throw new Error(
      `${label} '${value}' is a Windows reserved device name; refusing to use it in a filesystem path`,
    );
  }
  // Windows silently strips trailing dots/spaces from a path segment, renaming
  // "foo." to "foo" and "CON " to "CON" — a collision/mangling vector. Reject any
  // segment whose Windows-normalized form differs from the raw value, in the same
  // spirit as a leading dot or an all-empty name.
  const winNormalized = value.replace(/[\s.]+$/, "");
  if (winNormalized !== value) {
    throw new Error(
      `${label} '${value}' ends with a trailing dot or space that Windows strips, just as it refuses a name that starts with a dot or is empty; refusing to use it in a filesystem path`,
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
