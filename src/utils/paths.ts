import { join } from "node:path";
import { SKILL_MD } from "../constants.ts";
import {
  defaultPlatformPaths,
  piPlatformPaths,
  type PlatformPaths,
} from "../platform/paths.ts";

// ── Internal platform path resolver ──────────────────────────────

function resolvePaths(platformId?: string): PlatformPaths {
  if (platformId === "pi") return piPlatformPaths();
  return defaultPlatformPaths();
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
 * - default (or `"opencode"`) → `defaultPlatformPaths().agentsDir`
 */
export function platformAgentsDir(platformId?: string): string {
  return resolvePaths(platformId).agentsDir;
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
