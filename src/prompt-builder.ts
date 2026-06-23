import type { RoleConfig, ResolvedFunction, ResolvedSkill } from "./types.js";

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

/**
 * Build an XML block listing active functions for system prompt injection.
 *
 * Each function's content is wrapped in CDATA to prevent XML parsing issues.
 * Returns empty string when the functions array is empty.
 */
export function buildFunctionBlock(functions: ResolvedFunction[]): string {
  if (functions.length === 0) {
    return "";
  }

  const blocks = functions
    .map(
      (fn) =>
        `  <function>
    <name>${fn.name}</name>
    <description>${fn.description}</description>
    <instructions><![CDATA[
${fn.content}
    ]]></instructions>
  </function>`,
    )
    .join("\n");

  return `<active_functions>
These functions are currently active for this session. Follow their instructions.
${blocks}
</active_functions>`;
}
