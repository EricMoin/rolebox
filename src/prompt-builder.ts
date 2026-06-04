import type { RoleConfig, ResolvedSkill } from "./types";

/**
 * Build the final system prompt for a role.
 *
 * If the skills array is non-empty, the role prompt is followed by an
 * <available_skills> XML block that lists each resolved skill with its
 * name, description, and scope.
 *
 * If the skills array is empty, the raw role prompt is returned as-is
 * without any XML wrapping.
 */
export function buildAgentPrompt(
  role: RoleConfig,
  skills: ResolvedSkill[],
): string {
  if (skills.length === 0) {
    return role.prompt;
  }

  const skillBlocks = skills
    .map(
      (s) =>
        `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <scope>${s.scope}</scope>
  </skill>`,
    )
    .join("\n");

  return `${role.prompt}

<available_skills>
Skills provide specialized instructions. Use the skill tool to load when task matches.
${skillBlocks}
</available_skills>`;
}
