/**
 * Collaboration scaffold template.
 *
 * A multi-agent role with a collaboration graph topology.
 * Includes subagent scaffolding plus collaboration configuration.
 *
 * @module
 */

import type { Template, InitConfig } from "./types.ts";
import { skillsReadme, functionsReadme, subagentsReadme, referencesReadme } from "./shared-readme.ts";

export const collaborationTemplate: Template = {
  type: 'collaboration',
  label: 'Collaboration Role',
  description:
    'A multi-agent role with a collaboration graph topology. ' +
    'Includes subagent scaffolding plus collaboration configuration.',
  files: [
    {
      relativePath: 'role.yaml',
      content: (config: InitConfig) => {
        const names = config.subagentNames ?? [];
        const topology = config.topology ?? 'pipeline';
        const agents = names.map((s) => s.toLowerCase().replace(/\s+/g, '-'));
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
        lines.push(`collaboration:`);
        lines.push(`  topology: ${topology}`);
        lines.push(`  agents: [${agents.join(', ')}]`);
        lines.push(`  max_iterations: 3`);
        if (config.model) lines.push(`model: ${config.model}`);
        if (config.temperature !== undefined)
          lines.push(`temperature: ${config.temperature}`);
        return lines.join('\n') + '\n';
      },
    },
    {
      relativePath: 'PROMPT.md',
      content: (config: InitConfig) => {
        const topology = config.topology ?? 'pipeline';
        return [
          `# ${config.name}`,
          '',
          `You lead a collaborative workflow using a **${topology}** topology.`,
          '',
          `Your role: ${config.description}`,
          '',
          '## Workflow',
          '',
          'TODO: Describe the hand-off sequence between agents.',
          '',
          `The collaboration graph (topology: ${topology}) routes work`,
          'automatically. Follow the graph state shown in each turn.',
          '',
          '## Guidelines',
          '',
          '- Dispatch work according to the collaboration graph.',
          '- Respect `max_iterations` — don\'t loop indefinitely.',
          '- Summarise final output when the workflow completes.',
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
