import path from "node:path";
import os from "node:os";
import { writeFileSync, readFileSync, mkdirSync, rmdirSync, readdirSync, unlinkSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import { discoverRoles } from "./role-loader";
import { resolveSkills } from "./skill-resolver";
import { buildAgentPrompt } from "./prompt-builder";
import type { RoleConfig, ResolvedRole, ResolvedSkill } from "./types";

/**
 * Resolve all discovered roles into ResolvedRole objects.
 *
 * For each role in the Map:
 *  1. Gather both role-local skills (skills[]) and opencode-global skills
 *     (opencode_skills[]) into a single name list.
 *  2. Resolve those names to file paths via the 4-candidate priority system.
 *  3. Build the final agent prompt with <available_skills> XML block.
 *  4. Return a ResolvedRole object for each successfully-resolved role.
 *
 * Errors from individual role resolution are caught and the failing role is
 * silently skipped (the returned array omits it).
 */
async function resolveAllRoles(
  roles: Map<string, RoleConfig>,
  roleboxDir: string,
  globalSkillsDir: string,
): Promise<ResolvedRole[]> {
  const resolved: ResolvedRole[] = [];

  for (const [roleId, config] of roles) {
    try {
      const roleDir = path.join(roleboxDir, roleId);

      // Combine both role-local and opencode-global skill names.
      const localSkills = config.skills ?? [];
      const globalSkills = config.opencode_skills ?? [];
      const allSkillNames = [...localSkills, ...globalSkills];

      let skills: ResolvedSkill[] = [];
      if (allSkillNames.length > 0) {
        skills = await resolveSkills(allSkillNames, roleDir, globalSkillsDir);
      }

      const prompt = buildAgentPrompt(config, skills);

      resolved.push({ id: roleId, config, prompt, skills });
    } catch {
      // Silently skip roles that fail during resolution.
    }
  }

  return resolved;
}

/**
 * Build an SDK-compatible AgentConfig from a ResolvedRole.
 *
 * Only defined fields are included so that defaults in opencode itself
 * are not accidentally overwritten with empty strings or zero values.
 */
function buildAgentConfig(resolved: ResolvedRole): AgentConfig {
  const { config } = resolved;

  const agent: AgentConfig = {
    prompt: resolved.prompt,
    mode: config.mode ?? "primary",
  };

  if (config.model !== undefined) {
    agent.model = config.model;
  }
  if (config.description !== undefined) {
    agent.description = config.description;
  }
  if (config.color !== undefined) {
    agent.color = config.color;
  }
  if (config.variant !== undefined) {
    agent.variant = config.variant;
  }
  if (config.temperature !== undefined) {
    agent.temperature = config.temperature;
  }
  if (config.top_p !== undefined) {
    agent.top_p = config.top_p;
  }
  if (config.tools !== undefined) {
    agent.tools = config.tools;
  }
  if (config.permission !== undefined) {
    agent.permission = config.permission as AgentConfig["permission"];
  }

  return agent;
}

/**
 * Marker prefix used in agent .md files to identify rolebox-managed agents.
 * This allows cleanup of stale agents when roles are removed from rolebox.
 */
const ROLEBOX_MARKER = "<!-- rolebox-managed -->";

/**
 * Write agent definitions to ~/.claude/agents/ as fallback registration.
 *
 * This ensures agents are discoverable by oh-my-openagent (which reads
 * from this directory) even though rolebox also registers them via the
 * standard config hook. Agents managed by rolebox are tagged with a
 * marker comment so they can be cleaned up if the role is removed.
 */
function syncAgentFiles(resolvedRoles: ResolvedRole[]): void {
  const agentsDir = path.join(os.homedir(), ".claude", "agents");

  try {
    mkdirSync(agentsDir, { recursive: true });
  } catch {
    return; // Can't write — skip silently
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
          if (!resolvedRoles.some((r) => r.id === roleId)) {
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

  // Write current roles
  for (const resolved of resolvedRoles) {
    const { config } = resolved;
    const lines = [
      ROLEBOX_MARKER,
      "---",
      `name: ${config.name}`,
      `description: ${config.description}`,
      `mode: ${config.mode ?? "primary"}`,
    ];
    if (config.model) lines.push(`model: ${config.model}`);
    lines.push("---", "", resolved.prompt);

    const filePath = path.join(agentsDir, `${resolved.id}.md`);
    try {
      writeFileSync(filePath, lines.join("\n"), "utf-8");
    } catch {
      // Skip if write fails
    }
  }
}

const ROLEBOX_SKILL_PREFIX = "rolebox--";

/**
 * Sync rolebox skills into ~/.config/opencode/skills/ for oh-my-openagent discovery.
 *
 * oh-my-openagent's loadSkillsFromDir treats symlinks as directories:
 * it resolves them and looks for SKILL.md inside. So:
 * - Directory skills (with SKILL.md): create symlink to the directory
 * - Single-file skills (.md): create a wrapper directory with SKILL.md symlink inside
 */
function syncSkillSymlinks(resolvedRoles: ResolvedRole[], globalSkillsDir: string): void {
  try {
    mkdirSync(globalSkillsDir, { recursive: true });
  } catch {
    return;
  }

  // Clean up stale rolebox entries
  try {
    const existing = readdirSync(globalSkillsDir);
    for (const entry of existing) {
      if (!entry.startsWith(ROLEBOX_SKILL_PREFIX)) continue;
      const entryPath = path.join(globalSkillsDir, entry);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(entryPath);
        } else if (stat.isDirectory()) {
          // Wrapper directory: remove SKILL.md symlink inside, then rmdir
          const inner = path.join(entryPath, "SKILL.md");
          try { unlinkSync(inner); } catch {}
          try { rmdirSync(entryPath); } catch {}
        }
      } catch {
        continue;
      }
    }
  } catch {}

  // Create entries for all resolved role-local skills
  for (const role of resolvedRoles) {
    for (const skill of role.skills) {
      if (skill.scope !== "rolebox") continue;
      if (!existsSync(skill.filePath)) continue;

      const entryName = `${ROLEBOX_SKILL_PREFIX}${skill.name}`;
      const entryPath = path.join(globalSkillsDir, entryName);
      const isDirectorySkill = path.basename(skill.filePath).toLowerCase() === "skill.md";

      try {
        if (isDirectorySkill) {
          // Symlink to the directory containing SKILL.md
          symlinkSync(path.dirname(skill.filePath), entryPath);
        } else {
          // Create wrapper directory with SKILL.md symlink inside
          mkdirSync(entryPath, { recursive: true });
          symlinkSync(skill.filePath, path.join(entryPath, "SKILL.md"));
        }
      } catch {}
    }
  }
}

/**
 * OpenCode plugin for rolebox — define custom agent roles via YAML
 * configuration files with custom prompts, models, skills, and permissions.
 */
const RoleboxPlugin: Plugin = async (ctx) => {
  const roleboxDir = path.join(ctx.directory, "rolebox");
  const globalSkillsDir = path.join(ctx.directory, "skills");

  // Discover all roles from the rolebox directory.
  // Returns an empty Map when the directory does not exist or is empty.
  const roles = await discoverRoles(roleboxDir);

  // Resolve skills and build final prompts for every discovered role.
  const resolvedRoles = await resolveAllRoles(
    roles,
    roleboxDir,
    globalSkillsDir,
  );

  // Sync agent files to ~/.claude/agents/ for oh-my-openagent compatibility.
  syncAgentFiles(resolvedRoles);

  // Sync role skills as symlinks into ~/.config/opencode/skills/ so that
  // oh-my-openagent's skill tool can discover and load them.
  syncSkillSymlinks(resolvedRoles, globalSkillsDir);

  return {
    config: async (config) => {
      for (const resolved of resolvedRoles) {
        const agentConfig = buildAgentConfig(resolved);
        config.agent ??= {};
        config.agent[resolved.id] = agentConfig;
      }
    },
  };
};

export default RoleboxPlugin;
