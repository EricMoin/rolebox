/**
 * Shared README content strings used across multiple scaffold templates.
 *
 * @module
 */

export const skillsReadme = `# Skills

Skills are on-demand knowledge modules loaded by the agent via the \`skill\` tool when needed. They provide contextual instructions or reference material.

## File formats

- **Single file**: \`skills/{name}.md\`
- **Directory skill**: \`skills/{name}/SKILL.md\`

## Example

\`\`\`markdown
---
name: review-checklist
description: Comprehensive code review checklist
---

When reviewing code, check:
- Error handling completeness
- Input validation
- Edge cases
\`\`\`

## Resolution order

1. \`skills/{name}/SKILL.md\` — role-local directory
2. \`skills/{name}.md\` — role-local single file
3. Global opencode skills (under \`~/.config/opencode/skills/\`)

See full docs: https://github.com/EricMoin/rolebox
`;

export const functionsReadme = `# Functions

Functions are composable behavior modules activated by users via \`|name|\` syntax. They inject additional instructions into the system prompt for the session.

## File format

Create a markdown file with YAML frontmatter:

\`\`\`markdown
---
name: review
description: Code review mode with configurable focus
params:
  focus: correctness
  severity: normal
---

Check for:
- Logic errors and edge cases
- Performance implications
- Consistency with existing patterns
\`\`\`

## Parameter syntax

- **Positional**: \`|review:security,strict|\`
- **Key-value**: \`|review focus=security severity=strict|\`
- **Mixed**: \`|plan|review:security|\`

## Resolution order

1. \`{roleDir}/functions/{name}.md\` — role-local override
2. \`~/.config/opencode/functions/{name}.md\` — global user-defined
3. Built-in (\`plan\`, \`execute\`) — shipped with rolebox

See full docs: https://github.com/EricMoin/rolebox
`;

export const subagentsReadme = `# Subagents

Subagents are child agents that the parent role delegates to via \`task()\`. They let you build roles with specialist sub-agents, each with its own prompt, skills, and configuration.

## Directory structure

\`\`\`
subagents/{name}/
├── role.yaml         # Required: name, description, prompt
├── PROMPT.md         # Optional: external prompt file
├── skills/           # Optional: subagent-specific skills
└── functions/        # Optional: subagent-specific functions
\`\`\`

## Config inheritance

Subagents inherit these from the parent when not set: model, color, variant, temperature, top_p, permission, tools.
They do NOT inherit: name, description, prompt, skills, functions.

Subagent ID format: \`{parentId}--{childId}\` (the \`--\` separator is reserved).

## Dispatch

\`\`\`
task(subagent_type="parent--child", prompt="Do something", run_in_background=true)
\`\`\`

See full docs: https://github.com/EricMoin/rolebox
`;

export const referencesReadme = `# References

References provide domain knowledge files that the agent can access. They are automatically discovered — no configuration needed.

## Auto-discovery

Any files placed in \`references/\` are automatically picked up by the agent.

## Skill-specific references

For references tied to a specific skill, place them inside that skill's directory:

\`\`\`
skills/{name}/references/
\`\`\`

## Declaring in role.yaml

\`\`\`yaml
references:
  - path/to/reference.md
  - path/to/guide.pdf
\`\`\`

References can also be declared in a SKILL.md frontmatter block.

See full docs: https://github.com/EricMoin/rolebox
`;
