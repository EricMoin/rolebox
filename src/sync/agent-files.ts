import path from "node:path";
import os from "node:os";
import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import type { ResolvedRole } from "../types.js";

/**
 * Marker prefix used in agent .md files to identify rolebox-managed agents.
 * This allows cleanup of stale agents when roles are removed from rolebox.
 */
const ROLEBOX_MARKER = "<!-- rolebox-managed -->";

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
  const agentsDir = path.join(os.homedir(), ".claude", "agents");

  try {
    mkdirSync(agentsDir, { recursive: true });
  } catch {
    return; // Can't write — skip silently
  }

  const allAgents: AgentEntry[] = [];
  for (const role of resolvedRoles) {
    allAgents.push({
      id: role.id,
      name: role.config.name,
      description: role.config.description,
      prompt: role.prompt,
      mode: role.config.mode ?? "primary",
      model: role.config.model,
    });
    for (const sub of role.subagents) {
      allAgents.push({
        id: sub.id,
        name: sub.config.name,
        description: sub.config.description,
        prompt: sub.prompt,
        mode: "subagent",
        model: sub.config.model,
      });
    }
  }

  try {
    const existing = readdirSync(agentsDir);
    for (const file of existing) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(agentsDir, file);
      try {
        const text = readFileSync(filePath, "utf-8");
        if (text.includes(ROLEBOX_MARKER)) {
          const roleId = file.replace(/\.md$/, "");
          if (!allAgents.some((a) => a.id === roleId)) {
            unlinkSync(filePath);
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Directory not readable — skip cleanup
  }

  for (const agent of allAgents) {
    const lines = [
      ROLEBOX_MARKER,
      "---",
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `mode: ${agent.mode}`,
    ];
    if (agent.model) lines.push(`model: ${agent.model}`);
    lines.push("---", "", agent.prompt);

    const filePath = path.join(agentsDir, `${agent.id}.md`);
    try {
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    } catch {
      // Skip if write fails
    }
  }
}
