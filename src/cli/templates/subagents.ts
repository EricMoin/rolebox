/**
 * Subagents scaffold template.
 *
 * A parent role with child sub-agents. Subagent directories are
 * created dynamically based on the names provided during init.
 *
 * @module
 */

import type { Template, InitConfig } from "./types.ts";
import { skillsReadme, functionsReadme, subagentsReadme, referencesReadme } from "./shared-readme.ts";

export const subagentsTemplate: Template = {
  type: 'subagents',
  label: 'Role with Subagents',
  description:
    'A parent role with child sub-agents. Subagent directories are ' +
    'created dynamically based on the names provided during init.',
  files: [
    {
      relativePath: 'role.yaml',
      content: (config: InitConfig) => {
        const names = config.subagentNames ?? [];
        const lines = [
          `name: ${config.name}`,
          `description: ${config.description}`,
          `prompt_file: PROMPT.md`,
          `skills: []`,
          `functions:`,
          `  - plan`,
          `  - execute`,
          `subagents:`,
        ];
        for (const n of names) {
          lines.push(`  - name: ${n}`);
          lines.push(`    description: Sub-agent handling ${n} tasks`);
          lines.push(`    prompt_file: PROMPT.md`);
        }
        if (config.model) lines.push(`model: ${config.model}`);
        if (config.temperature !== undefined)
          lines.push(`temperature: ${config.temperature}`);
        return lines.join('\n') + '\n';
      },
    },
    {
      relativePath: 'PROMPT.md',
      content: (config: InitConfig) => {
        const subagentList =
          (config.subagentNames ?? []).length > 0
            ? config.subagentNames!
                .map((s) => `  - ${s}`)
                .join('\n')
            : '  - TODO: add sub-agent names';
        return [
          `# ${config.name}`,
          '',
          `You coordinate a team of sub-agents to accomplish complex tasks.`,
          '',
          `Your role: ${config.description}`,
          '',
          '## Team',
          '',
          subagentList,
          '',
          '## Coordination',
          '',
          'TODO: Define how you delegate work and integrate results.',
          '',
          '- Use `task()` to dispatch work to sub-agents.',
          '- Collect and reconcile outputs before responding.',
          '- Escalate only when the team is blocked.',
          '',
        ].join('\n');
      },
    },
    {
      relativePath: 'skills/README.md',
      content: skillsReadme,
    },
    {
      relativePath: 'functions/README.md',
      content: functionsReadme,
    },
    {
      relativePath: 'subagents/README.md',
      content: subagentsReadme,
    },
    {
      relativePath: 'references/README.md',
      content: referencesReadme,
    },
    {
      relativePath: 'subagents/{name}/role.yaml',
      content: (config: InitConfig) => {
        const lines = [
          `name: {name}`,
          `description: Sub-agent of ${config.name}`,
          `prompt_file: PROMPT.md`,
        ];
        if (config.model) lines.push(`model: ${config.model}`);
        if (config.temperature !== undefined)
          lines.push(`temperature: ${config.temperature}`);
        return lines.join('\n') + '\n';
      },
    },
    {
      relativePath: 'subagents/{name}/PROMPT.md',
      content: (config: InitConfig) =>
        [
          `# {name}`,
          '',
          `You are a sub-agent of **${config.name}**.`,
          '',
          `Role: Sub-agent — {name}`,
          '',
          'TODO: Write your specialised system prompt here.',
          '',
          '## Behaviour',
          '',
          '- Focus on your assigned domain.',
          '- Report results clearly to the orchestrator.',
          '- Ask for clarification when the task is ambiguous.',
          '',
        ].join('\n'),
    },
  ],
};
