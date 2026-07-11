import { join } from "node:path";
import os from "node:os";
import { SKILL_MD } from "../constants.ts";

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

/** `~/.claude/agents/{agentId}.md` */
export function agentFilePath(agentId: string): string {
  return join(os.homedir(), ".claude", "agents", `${agentId}.md`);
}

/** `~/.claude/agents` */
export function agentsDir(): string {
  return join(os.homedir(), ".claude", "agents");
}

/**
 * Returns the platform-specific agent directory.
 * - `"pi"` → `~/.pi/agent/skills`
 * - default (or `"opencode"`) → `~/.claude/agents`
 */
export function platformAgentsDir(platformId?: string): string {
  if (platformId === "pi") {
    return join(os.homedir(), ".pi", "agent", "skills");
  }
  return agentsDir();
}

/**
 * Returns the platform-specific agent file path.
 * - `"pi"` → `~/.pi/agent/skills/{agentId}/SKILL.md`
 * - default (or `"opencode"`) → `~/.claude/agents/{agentId}.md`
 */
export function platformAgentFilePath(agentId: string, platformId?: string): string {
  if (platformId === "pi") {
    return join(platformAgentsDir("pi"), agentId, SKILL_MD);
  }
  return agentFilePath(agentId);
}
