# rolebox

Define custom AI agent roles for [opencode](https://github.com/nicholasgriffintn/opencode) via YAML. Each role gets its own prompt, model, skills, functions, and permissions. No code required.

## Install

```bash
cd ~/.config/opencode && npm install rolebox
```

Add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["rolebox"]
}
```

## Create a role

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

## Functions

Functions are composable behavior modules that users activate at runtime with `|name|` syntax. They inject additional instructions into the system prompt on demand.

Every role ships with two built-in functions (`plan` and `execute`) by default. Users activate them by prefixing their message:

```
|plan| redesign the auth module
|execute| implement the refactoring we discussed
|plan|execute| add pagination to the API
```

### How it works

1. User types `|plan| do something` → parser strips `|plan|`, activates the function for this session
2. On every subsequent turn, the function's instructions are injected into the system prompt
3. Functions persist for the session once activated

### Writing custom functions

Create a markdown file with YAML frontmatter:

```markdown
---
name: review
description: Code review mode with configurable focus
params:
  focus: correctness
  severity: normal
---

You are reviewing code with focus on **{focus}** at **{severity}** level.

Check for:
- Logic errors and edge cases
- Performance implications
- Consistency with existing patterns
```

### Parameterized functions

Functions accept parameters via two syntax styles:

**Positional** (maps to param declaration order):
```
|review:security,strict| check the auth module
```

**Key-value** (explicit naming):
```
|review focus=security severity=strict| check the auth module
```

**Mixed** (some with args, some without):
```
|plan|review:security| analyze this PR
```

Parameters that aren't provided fall back to their declared default values. Functions without a `params` block ignore any passed arguments.

### Resolution priority

1. `{roleDir}/functions/{name}.md` — role-local override
2. `~/.config/opencode/functions/{name}.md` — global user-defined
3. Built-in (`plan`, `execute`) — shipped with rolebox

### Configuring functions per role

```yaml
# Use only specific functions (replaces the default plan+execute)
functions:
  - plan
  - review
  - my-custom-fn

# Disable specific defaults
disable_functions:
  - execute
```

### Built-in functions

**plan** — Instructs the agent to investigate the codebase with tools (Read, Grep, Glob, LSP) before planning. Produces a structured plan with verification strategy. Waits for user approval before executing.

**execute** — Instructs the agent to implement step by step with tool-based verification (lsp_diagnostics, build, tests) after each change. Handles failures with a two-attempt escalation policy.

## Skills

Skills are on-demand knowledge modules the agent loads via the `skill` tool when needed. Unlike functions (which are always-on once activated), skills are pulled in contextually.

```markdown
---
name: review-checklist
description: Comprehensive code review checklist
---

When reviewing code, check:
- Error handling completeness
- Input validation
- ...
```

### Resolution order

1. `{roleDir}/skills/{name}/SKILL.md` (role-local, directory)
2. `{roleDir}/skills/{name}.md` (role-local, single file)
3. `~/.config/opencode/skills/{name}/SKILL.md` (global, directory)
4. `~/.config/opencode/skills/{name}.md` (global, single file)

### Skill vs Function

| | Skill | Function |
|---|---|---|
| Activation | Agent decides via `skill` tool | User activates with `\|name\|` syntax |
| Lifetime | Single use per invocation | Persists for the session |
| Purpose | Reference knowledge | Behavior modification |
| Injection | On-demand into context | Always in system prompt while active |

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

# Functions
functions:                    # Available functions (default: [plan, execute])
  - plan
  - execute
  - my-custom-fn
disable_functions:            # Remove specific defaults
  - execute

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

## Directory structure

```
~/.config/opencode/
├── opencode.jsonc
├── rolebox/
│   ├── copywriter/
│   │   └── role.yaml
│   ├── code-reviewer/
│   │   ├── role.yaml
│   │   ├── skills/
│   │   │   └── review-checklist.md
│   │   └── functions/
│   │       └── plan.md          # Role-local override of built-in plan
│   └── ...
├── functions/                    # Global user-defined functions
│   └── my-custom-fn.md
└── skills/                       # Global opencode skills
```

## Examples

### Code reviewer with custom plan function

```yaml
# rolebox/code-reviewer/role.yaml
name: Code Reviewer
description: Expert code reviewer
model: gpt-4
mode: subagent
temperature: 0.2
prompt: |
  You are an expert code reviewer. Review for correctness,
  performance, and readability. Be specific and actionable.
skills:
  - review-checklist
functions:
  - plan
permission:
  allow: [Read, Grep, Glob]
```

### Parameterized review function

```markdown
<!-- rolebox/code-reviewer/functions/review.md -->
---
name: review
description: Configurable code review
params:
  focus: correctness
  depth: normal
---

Review this code with focus on **{focus}**.

Depth level: **{depth}**
- normal: flag clear issues, suggest improvements
- deep: trace all code paths, verify edge cases, check error propagation
- surface: only obvious bugs and style issues
```

Usage: `|review:security,deep| check the new auth endpoints`

## Compatibility

Works alongside oh-my-openagent. Rolebox roles appear in the agent list and skills are discoverable by the skill tool. No conflicts.

## Error handling

- Invalid YAML or missing files won't crash opencode. The broken role is skipped.
- Missing skills produce a warning but don't block the role.
- Missing functions are silently skipped.
- Invalid function activation syntax (uppercase, mid-sentence pipes) is left untouched in the message.

## Limitations

- No hot-reload (restart opencode to pick up changes)
- No role inheritance
- No runtime role switching
- Functions persist for the entire session (no per-message deactivation yet)
- No conditional functions based on project context
