import { join } from "node:path";
import os from "node:os";

/** `{baseDir}/{name}.md` */
export function functionPath(baseDir: string, name: string): string {
  return join(baseDir, `${name}.md`);
}

/** `{baseDir}/{name}/SKILL.md` */
export function skillDirPath(baseDir: string, name: string): string {
  return join(baseDir, name, "SKILL.md");
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
