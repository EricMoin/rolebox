/**
 * Template data structures for the `rolebox init` command.
 *
 * Defines the 4 built-in scaffold templates (minimal, standard, subagents,
 * collaboration) and the types that describe them.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported scaffold template identifiers. */
export type TemplateType = 'minimal' | 'standard' | 'subagents' | 'collaboration';

/**
 * A single file within a template.
 *
 * The `content` field can be either a static string or a function that
 * receives the user's init configuration and returns a string. This
 * allows dynamic content (e.g. subagent names interpolated into prompts).
 */
export interface TemplateFile {
  /** Relative path from the role root directory (e.g. `role.yaml`). */
  relativePath: string;
  /**
   * File content — either a literal string or a function that derives
   * content from the init configuration.
   */
  content: string | ((config: InitConfig) => string);
}

/** A complete scaffold template with metadata and its file list. */
export interface Template {
  /** Template identifier. */
  type: TemplateType;
  /** Human-readable label shown in the CLI prompt. */
  label: string;
  /** Short description explaining what the template produces. */
  description: string;
  /** Ordered list of files to be created. */
  files: TemplateFile[];
}

/**
 * Configuration values collected during the interactive `init` flow.
 * These are passed to template content functions so that file content can
 * be customised per-user (e.g. substituting role names, subagent names).
 */
export interface InitConfig {
  /** Human-readable role name (e.g. "Code Reviewer"). */
  name: string;
  /** Role identifier used for directory names and symlinks. */
  roleId: string;
  /** One-line description of the role's purpose. */
  description: string;
  /** LLM model override (optional). */
  model?: string;
  /** Sampling temperature (optional, 0.0 – 2.0). */
  temperature?: number;
  /** Names of sub-agents when the template includes subagent scaffolding. */
  subagentNames?: string[];
  /** Collaboration topology identifier (e.g. "pipeline", "review-loop"). */
  topology?: string;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Built-in scaffold templates indexed by `TemplateType`.
 *
 * Each template defines the set of files that `rolebox init` will create
 * when the user picks that option. Content is currently placeholder text;
 * real content generation will be implemented in follow-up tasks.
 */
export const templates: Record<TemplateType, Template> = {
  // ── minimal ──────────────────────────────────────────────────────────
  minimal: {
    type: 'minimal',
    label: 'Minimal Role',
    description:
      'A simple role with just a YAML config file and a prompt file. ' +
      'No skills, functions, or subagents.',
    files: [
      {
        relativePath: 'role.yaml',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'PROMPT.md',
        content: 'PLACEHOLDER',
      },
    ],
  },

  // ── standard ─────────────────────────────────────────────────────────
  standard: {
    type: 'standard',
    label: 'Standard Role',
    description:
      'A role with skills and functions support. Adds ' +
      'skills/README.md and functions/README.md directories.',
    files: [
      {
        relativePath: 'role.yaml',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'PROMPT.md',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'skills/README.md',
        content: `# Skills

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
`,
      },
      {
        relativePath: 'functions/README.md',
        content: `# Functions

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
`,
      },
      {
        relativePath: 'references/README.md',
        content: `# References

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
`,
      },
    ],
  },

  // ── subagents ────────────────────────────────────────────────────────
  subagents: {
    type: 'subagents',
    label: 'Role with Subagents',
    description:
      'A parent role with child sub-agents. Subagent directories are ' +
      'created dynamically based on the names provided during init.',
    files: [
      {
        relativePath: 'role.yaml',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'PROMPT.md',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'skills/README.md',
        content: `# Skills

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
`,
      },
      {
        relativePath: 'functions/README.md',
        content: `# Functions

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
`,
      },
      {
        relativePath: 'subagents/README.md',
        content: `# Subagents

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
`,
      },
      {
        relativePath: 'references/README.md',
        content: `# References

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
`,
      },
      {
        relativePath: 'subagents/{name}/role.yaml',
        content: (config: InitConfig) =>
          `# PLACEHOLDER — subagent role.yaml for "${config.name}"`,
      },
      {
        relativePath: 'subagents/{name}/PROMPT.md',
        content: (config: InitConfig) =>
          `# PLACEHOLDER — subagent prompt for "${config.name}"`,
      },
    ],
  },

  // ── collaboration ────────────────────────────────────────────────────
  collaboration: {
    type: 'collaboration',
    label: 'Collaboration Role',
    description:
      'A multi-agent role with a collaboration graph topology. ' +
      'Includes subagent scaffolding plus collaboration configuration.',
    files: [
      {
        relativePath: 'role.yaml',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'PROMPT.md',
        content: 'PLACEHOLDER',
      },
      {
        relativePath: 'skills/README.md',
        content: `# Skills

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
`,
      },
      {
        relativePath: 'functions/README.md',
        content: `# Functions

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
`,
      },
      {
        relativePath: 'subagents/README.md',
        content: `# Subagents

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
`,
      },
      {
        relativePath: 'references/README.md',
        content: `# References

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
`,
      },
      {
        relativePath: 'subagents/{name}/role.yaml',
        content: (config: InitConfig) =>
          `# PLACEHOLDER — subagent role.yaml for "${config.name}"`,
      },
      {
        relativePath: 'subagents/{name}/PROMPT.md',
        content: (config: InitConfig) =>
          `# PLACEHOLDER — subagent prompt for "${config.name}"`,
      },
    ],
  },
};
