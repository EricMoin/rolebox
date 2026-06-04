# rolebox

Define custom AI agent roles for [opencode](https://github.com/nicholasgriffintn/opencode) via YAML. Each role gets its own prompt, model, skills, and permissions. No code required.

## Quick start

```bash
# Install
cd ~/.config/opencode && npm install rolebox
```

Add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["rolebox"]
}
```

Create a role:

```bash
mkdir -p ~/.config/opencode/rolebox/copywriter
```

```yaml
# ~/.config/opencode/rolebox/copywriter/role.yaml
name: Copywriter
description: Writes concise, punchy copy.
prompt: |
  You are a copywriter. Short sentences. No jargon. Every word earns its place.
```

Restart opencode. The role appears in your agent list.

## Directory structure

```
~/.config/opencode/
├── opencode.jsonc
├── rolebox/
│   ├── copywriter/
│   │   └── role.yaml
│   ├── ai-designer/
│   │   ├── role.yaml
│   │   └── skills/
│   │       ├── visual-design.md
│   │       └── interaction-patterns/
│   │           └── SKILL.md
│   └── ...
└── skills/                 # Global opencode skills
```

## Configuration reference

### role.yaml

```yaml
# Required
name: string
description: string
prompt: |                     # Or use prompt_file (mutually exclusive)
  Your system prompt here...

# Optional
model: string                 # e.g. "gpt-4", "claude-3-sonnet"
mode: primary | subagent | all  # Default: "primary"
color: string                 # UI color
variant: string               # Model variant
temperature: number           # 0.0 - 2.0
top_p: number                 # 0.0 - 1.0
prompt_file: string           # Path to external prompt file

# Skills
skills:                       # From rolebox/{role}/skills/
  - my-skill
opencode_skills:              # From ~/.config/opencode/skills/
  - humanizer

# Permissions
permission:
  allow:
    - Read
    - Grep
  deny:
    - Bash
tools:
  Bash: false
```

### Environment variables

Use `{env:VARIABLE_NAME}` anywhere in role.yaml. Resolved at startup.

```yaml
model: "{env:PREFERRED_MODEL}"
prompt: |
  You work for {env:COMPANY_NAME}...
```

## Skills

Skills use standard opencode SKILL.md format with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does
---

Skill instructions here...
```

### Resolution order (first match wins)

1. `{roleDir}/skills/{name}/SKILL.md` (role-local, directory format)
2. `{roleDir}/skills/{name}.md` (role-local, single file)
3. `~/.config/opencode/skills/{name}/SKILL.md` (global, directory format)
4. `~/.config/opencode/skills/{name}.md` (global, single file)

### How skills work at runtime

Rolebox syncs role-local skills into `~/.config/opencode/skills/` at startup. The role's prompt gets an `<available_skills>` XML block listing skill names and descriptions. The model calls the `skill` tool when it needs specialized instructions.

### Example: multi-skill role

```yaml
name: AI Designer
description: Professional UI/UX designer producing design specification documents.
mode: primary
prompt: |
  You are a professional UI/UX designer...
skills:
  - ai-designer-core
  - ai-designer-visual
  - ai-designer-interaction
  - ai-designer-psychology
  - ai-designer-research
  - ai-designer-system
  - ai-designer-antipatterns
```

## Startup sequence

1. Scans `~/.config/opencode/rolebox/*/role.yaml`
2. Parses YAML, resolves `{env:*}` variables, loads `prompt_file` if specified
3. Resolves skill references to SKILL.md files
4. Registers each role as an opencode agent
5. Syncs skills to `~/.config/opencode/skills/`
6. Syncs agent .md files to `~/.claude/agents/` for compatibility

## Compatibility

Works alongside oh-my-openagent. If both are installed, rolebox roles appear in the agent list and skills are discoverable by the skill tool. No conflicts.

## Error handling

Invalid YAML or missing files won't crash opencode. The broken role is skipped, other roles load normally. Missing skills produce a warning but don't block the role.

## Limitations

- No role inheritance
- No hot-reload (restart opencode to pick up changes)
- No model existence validation
- No runtime role switching
- No MCP server integration
- No conditional skills based on project context
