import type { ResolvedFunction, ResolvedReference, ResolvedSkill } from "./types.js";

export interface PromptSource {
  prompt: string;
}

export function buildAgentPrompt(
  role: PromptSource,
  skills: ResolvedSkill[],
  subagents?: Array<{ id: string; name: string; description: string }>,
  references?: ResolvedReference[],
): string {
  const hasSkills = skills.length > 0;
  const hasSubagents = subagents && subagents.length > 0;
  const hasReferences = references && references.length > 0;

  if (!hasSkills && !hasSubagents && !hasReferences) {
    return role.prompt;
  }

  let result = role.prompt;

  if (hasReferences) {
    result = `${result}\n\n${buildReferenceBlock(references)}`;
  }

  if (hasSkills) {
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

    result = `${result}

<available_skills>
Skills provide specialized instructions. Use the skill tool to load when task matches.
${skillBlocks}
</available_skills>`;
  }

  const subagentBlock = buildSubagentBlock(subagents ?? []);
  if (subagentBlock) {
    result = `${result}\n\n${subagentBlock}`;
  }

  return result;
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

export function buildReferenceBlock(references: ResolvedReference[]): string {
  if (references.length === 0) {
    return "";
  }

  const blocks = references
    .map(
      (r) =>
        `  <reference>
    <name>${r.name}</name>
    <path>${r.filePath}</path>
    <description>${r.description}</description>
  </reference>`,
    )
    .join("\n");

  return `<available_references>
Reference documents provide deep knowledge. Use the Read tool to load full content when needed.
${blocks}
</available_references>`;
}

/**
 * Build an XML block listing available subagents for system prompt injection.
 *
 * Each subagent is listed with its id, name, and description.
 * Returns empty string when the subagents array is empty.
 */
export function buildSubagentBlock(
  subagents: Array<{ id: string; name: string; description: string }>,
): string {
  if (subagents.length === 0) {
    return "";
  }

  const blocks = subagents
    .map(
      (a) =>
        `  <subagent>
    <id>${a.id}</id>
    <name>${a.name}</name>
    <description>${a.description}</description>
  </subagent>`,
    )
    .join("\n");

  return `<available_subagents>
You can delegate tasks to these sub-agents via the task() tool.
Use task(subagent_type="agent-id", ...) to dispatch.

${blocks}
</available_subagents>`;
}
