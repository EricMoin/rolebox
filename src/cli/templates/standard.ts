/**
 * Standard scaffold template.
 *
 * A role with skills and functions support. Adds skills/README.md
 * and functions/README.md directories plus a references/README.md.
 *
 * @module
 */

import type { Template, InitConfig } from "./types.ts";
import { skillsReadme, functionsReadme, referencesReadme } from "./shared-readme.ts";

export const standardTemplate: Template = {
  type: 'standard',
  label: 'Standard Role',
  description:
    'A role with skills and functions support. Adds ' +
    'skills/README.md and functions/README.md directories.',
  files: [
    {
      relativePath: 'role.yaml',
      content: (config: InitConfig) => {
        const lines = [
          `name: ${config.name}`,
          `description: ${config.description}`,
          `prompt_file: PROMPT.md`,
          `skills: []`,
          `functions:`,
          `  - plan`,
          `  - execute`,
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
          `You are ${config.description}.`,
          '',
          '## Instructions',
          '',
          'TODO: Define your role behaviour, constraints, and output format.',
          '',
          '## Code of Conduct',
          '',
          '- Be precise and actionable.',
          '- Verify assumptions before acting.',
          '- Communicate clearly and concisely.',
          '',
        ].join('\n'),
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
      relativePath: 'references/README.md',
      content: referencesReadme,
    },
  ],
};
