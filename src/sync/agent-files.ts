import path from "node:path";
import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import type { ResolvedRole } from "../types.ts";
import { RoleMode, ROLEBOX_AGENT_MARKER } from "../constants.ts";
import { agentsDir, agentFilePath } from "../paths.ts";

interface AgentEntry {
  id: string;
  name: string;
  description: string;
  prompt: string;
  mode: string;
  model?: string;
}

/**
 * Write agent definitions to ~/.claude/agents/ as fallback registration.
 *
 * This ensures agents are discoverable by oh-my-openagent (which reads
 * from this directory) even though rolebox also registers them via the
 * standard config hook. Agents managed by rolebox are tagged with a
 * marker comment so they can be cleaned up if the role is removed.
 */
export function syncAgentFiles(resolvedRoles: ResolvedRole[]): void {
  const agentsDirPath = agentsDir();

  try {
    mkdirSync(agentsDirPath, { recursive: true });
  } catch {
    return;
  }

  const allAgents: AgentEntry[] = [];
  for (const role of resolvedRoles) {
    allAgents.push({
      id: role.id,
      name: role.config.name,
      description: role.config.description,
      prompt: role.prompt,
      mode: role.config.mode ?? RoleMode.Primary,
      model: role.config.model,
    });
    for (const sub of role.subagents) {
      allAgents.push({
        id: sub.id,
        name: sub.config.name,
        description: sub.config.description,
        prompt: sub.prompt,
        mode: RoleMode.Subagent,
        model: sub.config.model,
      });
    }
  }

  try {
    const existing = readdirSync(agentsDirPath);
    for (const file of existing) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(agentsDirPath, file);
      try {
        const text = readFileSync(filePath, "utf-8");
        if (text.includes(ROLEBOX_AGENT_MARKER)) {
          const roleId = file.replace(/\.md$/, "");
          if (!allAgents.some((a) => a.id === roleId)) {
            unlinkSync(filePath);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {}

  for (const agent of allAgents) {
    const lines = [
      ROLEBOX_AGENT_MARKER,
      "---",
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `mode: ${agent.mode}`,
    ];
    if (agent.model) lines.push(`model: ${agent.model}`);
    lines.push("---", "", agent.prompt);

    const filePath = agentFilePath(agent.id);
    try {
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    } catch {}
  }
}
