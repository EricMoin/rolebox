/**
 * Minimal scaffold template.
 *
 * A simple role with just a YAML config file and a prompt file.
 * No skills, functions, or subagents.
 *
 * @module
 */

import type { Template, InitConfig } from "./types.ts";

export const minimalTemplate: Template = {
  type: 'minimal',
  label: 'Minimal Role',
  description:
    'A simple role with just a YAML config file and a prompt file. ' +
    'No skills, functions, or subagents.',
  files: [
    {
      relativePath: 'role.yaml',
      content: (config: InitConfig) => {
        const lines = [
          `name: ${config.name}`,
          `description: ${config.description}`,
          `prompt_file: PROMPT.md`,
        ];
        if (config.model) lines.push(`model: ${config.model}`);
        if (config.temperature !== undefined)
          lines.push(`temperature: ${config.temperature}`);
        return lines.join('\n') + '\n';
      },
    },
    {
      relativePath: 'PROMPT.md',
      content: (config: InitConfig) =>
        [
          `# ${config.name}`,
          '',
          config.description,
          '',
          '## Instructions',
          '',
          'TODO: Write your system prompt here. Define how',
          `**${config.name}** should behave, what output format to use,`,
          'and any constraints it must follow.',
          '',
        ].join('\n'),
    },
  ],
};
