import { join, sep } from "node:path";
import { SKILL_MD } from "../constants.ts";
import {
  defaultPlatformPaths,
  piPlatformPaths,
} from "../platform/paths.ts";
import { resolvePlatformPaths } from "../platform/registry.ts";

// ── Path normalization ───────────────────────────────────────────

/**
 * Normalize a path to use forward slashes.
 *
 * On Windows, Node's path APIs and user-supplied paths often use backslashes,
 * while fast-glob returns forward-slash paths. Comparisons and stored paths
 * must agree, and Node's fs accepts forward slashes on win32 — so converting
 * backslashes to forward slashes keeps every path readable and comparable on
 * all platforms. A forward-slash path is returned unchanged.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Convert a forward-slash path back to native platform separators.
 *
 * Inverse of `toPosixPath`: on POSIX it is a no-op; on Windows it restores
 * backslash separators. Use it when a posix-normalized path must become a
 * real platform-native filesystem path again (e.g. before `join`, `dirname`,
 * or fs operations, which on win32 must agree with join-built paths).
 */
export function toNativePath(p: string): string {
  return p.replace(/\//g, sep);
}

/**
 * Escape backslashes in a path so fast-glob treats a literal `\` as a literal
 * path character rather than as a glob escape byte.
 *
 * fast-glob (via picomatch) treats `\` as an escape character. On POSIX a
 * directory segment may legitimately contain a literal `\`, and when such a
 * path is fed to fast-glob the backslash breaks the match (discoverRoles then
 * silently returns nothing). To match a literal backslash, the pattern must use
 * a glob character class: `\` → `[\\]`.
 *
 * Forward slashes and non-backslash input pass through unchanged, so this is a
 * no-op for ordinary (already-posix) patterns. It is meant to be applied when
 * *building* a glob pattern from a path whose segments may contain a literal
 * backslash.
 *
 * win32 note: on Windows `\` is a path separator, so a single path segment can
 * never contain a literal backslash. This escaping is therefore a POSIX-only
 * concern and never alters win32 pattern semantics (there, callers normalize
 * with `toPosixPath` before building a pattern).
 */
export function escapeGlobBackslashes(p: string): string {
  return p.replace(/\\/g, "[\\\\]");
}

// ── Function / Skill / Subagent helpers (pure joins) ─────────────

/** `{baseDir}/{name}.md` */
export function functionPath(baseDir: string, name: string): string {
  return join(baseDir, `${name}.md`);
}

/** `{baseDir}/{name}/SKILL.md` */
export function skillDirPath(baseDir: string, name: string): string {
  return join(baseDir, name, SKILL_MD);
}

/** `{baseDir}/{name}.md` */
export function skillFilePath(baseDir: string, name: string): string {
  return join(baseDir, `${name}.md`);
}

/** `{roleDir}/subagents/{slug}` */
export function subagentDir(roleDir: string, slug: string): string {
  return join(roleDir, "subagents", slug);
}

/** `{configDir}/functions` */
export function globalFunctionsPath(configDir: string): string {
  return join(configDir, "functions");
}

// ── Agent path helpers (delegate to PlatformPaths registry) ─────

/**
 * `{defaultPlatformPaths().agentsDir}/{agentId}.md`
 *
 * Delegates to the PlatformPaths registry; no longer hardcodes
 * `~/.claude/agents` directly.
 */
export function agentFilePath(agentId: string): string {
  return join(defaultPlatformPaths().agentsDir, `${agentId}.md`);
}

/**
 * `defaultPlatformPaths().agentsDir`
 *
 * Delegates to the PlatformPaths registry.
 */
export function agentsDir(): string {
  return defaultPlatformPaths().agentsDir;
}

/**
 * Returns the platform-specific agent directory.
 * - `"pi"` → `piPlatformPaths().agentsDir`
 * - `"dsh"` → `dshPlatformPaths().agentsDir`
 * - default (or `"opencode"`) → `defaultPlatformPaths().agentsDir`
 */
export function platformAgentsDir(platformId?: string): string {
  return resolvePlatformPaths(platformId).agentsDir;
}

/**
 * Returns the platform-specific agent file path.
 * - `"pi"` → `{piPlatformPaths().agentsDir}/{agentId}/SKILL.md`
 * - default (or `"opencode"`) → `agentFilePath(agentId)`
 */
export function platformAgentFilePath(
  agentId: string,
  platformId?: string,
): string {
  if (platformId === "pi") {
    return join(piPlatformPaths().agentsDir, agentId, SKILL_MD);
  }
  return agentFilePath(agentId);
}
