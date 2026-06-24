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

## CLI

rolebox includes a command-line interface for installing and managing AI agent roles from remote registries.

### Usage

```bash
npx rolebox <command> [options]
```

Or if installed globally:

```bash
rolebox <command> [options]
```

### Commands

#### `install <role>[@version]`

Install a role from a registry. The role specifier can be in several formats:

- `rolebox install software-architect` — install latest version from default registry
- `rolebox install software-architect@1.0.0` — install specific version
- `rolebox install my-registry:custom-role` — install from named registry
- `rolebox install my-registry:role@2.0.0` — install specific version from named registry

After installing, run `rolebox sync opencode` to deploy the role.

#### `uninstall <role>`

Remove an installed role and clean up any symlinks.

```bash
rolebox uninstall software-architect
```

#### `sync <target>`

Deploy installed roles to a target tool's configuration directory. Currently only supports `opencode`.

```bash
rolebox sync opencode
```

This creates symlinks: `~/.config/opencode/rolebox/{roleId}` → `~/.local/share/rolebox/roles/{registry}/{roleId}@{version}/`

If a manual role (regular directory) already exists at the target path, it is preserved with a warning.

#### `list`

Show all installed roles with versions and their source registries.

```bash
rolebox list
rolebox list --json   # JSON output for scripting
```

#### `search [query]`

Search available roles across all configured registries.

```bash
rolebox search               # List all available roles
rolebox search react         # Search for roles matching "react"
```

Matches against role names, descriptions, and tags (case-insensitive).

#### `update [role]`

Update installed roles to the latest versions available in their registries.

```bash
rolebox update                # Update all installed roles
rolebox update software-architect  # Update a specific role
```

#### `registry <subcommand>`

Manage registry sources.

```bash
rolebox registry list                    # Show all configured registries
rolebox registry add https://github.com/user/my-roles  # Add a registry
rolebox registry remove my-roles         # Remove a registry (not the default)
```

### Configuration

The CLI stores its state in two files:

- `~/.config/rolebox/config.yaml` — registry configuration (default registry: oh-my-role)
- `~/.config/rolebox/rolebox.lock` — installed role manifest with version and integrity tracking

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

## Subagents

Subagents are child agents that a parent role can delegate to via `task()`. They let you build roles that coordinate specialist sub-agents, each with its own prompt, skills, and configuration.

### When to use

Use subagents when a role needs to break work across multiple specialists. A team lead might delegate research to one sub-agent and implementation to another, each tuned for its domain.

### Inline declaration

Define subagents directly in the parent's `role.yaml`:

```yaml
# team-lead/role.yaml
name: Team Lead
description: Delegates work to specialist sub-agents
model: gpt-4
prompt: |
  You are a team lead. Delegate tasks to the appropriate specialist.
subagents:
  - name: Implementer
    description: Writes production code
    prompt: |
      You are a senior software engineer. Write clean, testable code.
    temperature: 0.1
```

Each entry in `subagents:` takes the same fields as a regular `role.yaml` (name, description, prompt, model, etc.).

### File-based declaration

For subagents with their own skills or functions, use a directory structure:

```
team-lead/
├── role.yaml
└── subagents/
    └── researcher/
        ├── role.yaml
        └── skills/
            └── research-checklist/
                └── SKILL.md
```

File-based subagents are discovered automatically from the `subagents/` directory. You can mix both approaches: some subagents inline, others file-based.

### Config inheritance

Subagents inherit certain fields from the parent when not explicitly set.

| Inherited | Not inherited |
|---|---|
| model | name |
| color | description |
| variant | prompt |
| temperature | prompt_file |
| top_p | skills |
| permission | functions |
| tools | |

The `mode` field is always forced to `"subagent"` for child agents.

### Naming convention

Subagent IDs follow the pattern `{parentId}--{childId}`. The child ID is derived from the name field (lowercased, spaces replaced with dashes). For example, a "Team Lead" role with an "Implementer" subagent produces the ID `team-lead--implementer`.

The `--` separator is reserved. Don't use it in regular role IDs.

### Dispatch

The parent dispatches work to a subagent using `task()` in its prompt:

```
task(subagent_type="team-lead--implementer", prompt="Implement the auth module", run_in_background=true)
```

### Subagent skills and functions

Subagents can have their own `skills/` and `functions/` directories (file-based declaration only). Skills from subagents are symlinked into opencode as `rolebox--{parentId}--{childId}--{skillName}`.

### Limitations

Subagents don't nest. A subagent can't define its own subagents. There's no runtime creation of subagents, and subagents can't communicate directly with each other. All coordination goes through the parent.

## Collaboration Graph

By default, the parent role decides who to dispatch to and when. The collaboration graph adds structure: you define a workflow (who passes work to whom), and rolebox handles the routing automatically.

Think of it like a flowchart for your agents.

### Quick start

Add a `collaboration:` block to your role.yaml. The simplest way is to pick a built-in topology:

```yaml
name: Review Team Lead
description: Coordinates code review workflow
prompt: |
  You are a team lead coordinating a code review workflow.
  Follow the collaboration graph to dispatch work.
subagents:
  - name: Coder
    description: Implements code changes
    prompt: You are a senior developer. Write clean, testable code.
  - name: Reviewer
    description: Reviews code for quality
    prompt: You review code for correctness, style, and edge cases.
collaboration:
  topology: review-loop
  agents: [coder, reviewer]
  max_iterations: 3
```

That's it. The parent dispatches to Coder first, Coder's output goes to Reviewer, and Reviewer can either loop back to Coder for revisions or finish the workflow. After 3 loops max, the workflow ends automatically.

### Built-in topologies

Three ready-made patterns:

| Topology | Flow | Use case |
|---|---|---|
| `pipeline` | parent → A → B → C → parent | Sequential handoff. Each agent builds on the previous one's output. |
| `review-loop` | parent → A → B → A (loop) → parent | Revision cycles. The last agent can send work back for another pass. |
| `star` | parent → A, parent → B, parent → C (parallel) | Fan-out. Each agent works independently and reports back. |

```
# pipeline: A → B → C, done.
collaboration:
  topology: pipeline
  agents: [researcher, writer, editor]

# review-loop: writer ↔ editor, up to 5 rounds.
collaboration:
  topology: review-loop
  agents: [writer, editor]
  max_iterations: 5

# star: all agents work in parallel.
collaboration:
  topology: star
  agents: [frontend, backend, devops]
```

### Custom flow

Need more control? Define edges explicitly:

```yaml
collaboration:
  flow:
    - "parent -> researcher"
    - "researcher -> writer: research findings"
    - "writer -> editor: draft content"
    - from: editor
      to: writer
      label: revision requests
    - from: editor
      to: parent
      label: approved
      exit: true
  max_iterations: 2
```

Two edge syntaxes (mix freely):

- **String**: `"from -> to"` or `"from -> to: label"`
- **Object**: `{ from: ..., to: ..., label: ..., exit: true }`

Special rules:
- `parent` is a reserved name — it means the orchestrator (your main role)
- Edges pointing to `parent` or marked `exit: true` terminate the workflow
- `max_iterations` prevents infinite loops in cyclic graphs (defaults to 3 if a cycle is detected)

### Hybrid: topology + custom edges

Start from a template, then override or add edges:

```yaml
collaboration:
  topology: pipeline
  agents: [coder, reviewer]
  flow:
    - "reviewer -> coder: needs revision"   # adds a back-edge on top of the pipeline
  max_iterations: 3
```

Custom `flow` edges are merged with the template. If a custom edge has the same `from → to` as a template edge, the custom one wins.

### What happens at runtime

You don't need to manage the workflow manually. Rolebox handles it:

1. When a chat starts, the graph state initializes (step 0, status: active)
2. The orchestrator's system prompt gets a `<collaboration_graph>` block describing the workflow and a `<collaboration_state>` block showing current progress
3. Each subagent's prompt gets a `<collaboration_role>` block explaining its position (e.g., "You receive work from Coder. Your output goes to Editor.")
4. Every time `task()` dispatches to a subagent, the state advances to the next step
5. When an exit edge is reached or max iterations are exceeded, the workflow completes

The orchestrator LLM sees the state on every turn, so it knows which agent to call next without you hardcoding dispatch logic in the prompt.

### No graph? No problem

The `collaboration:` field is optional. Roles with subagents but no graph continue to work exactly as before — the parent decides dispatch order freely via `task()`.

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

# Subagents
subagents:                    # Inline child agents (see ## Subagents)
  - name: string
    description: string
    prompt: string
    # ... same fields as role.yaml

# Collaboration Graph (see ## Collaboration Graph)
collaboration:
  topology: pipeline | review-loop | star  # Built-in topology
  agents: [agent-a, agent-b]               # Agent slugs (lowercase name)
  flow:                                     # Custom edges (string or object)
    - "from -> to: label"
    - { from: a, to: b, label: x, exit: true }
  max_iterations: number                   # Loop limit (default: 3 for cycles)

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
│   ├── team-lead/
│   │   ├── role.yaml            # Parent role (can have inline subagents)
│   │   └── subagents/           # File-based subagents
│   │       └── researcher/
│   │           ├── role.yaml
│   │           └── skills/
│   │               └── research-checklist/
│   │                   └── SKILL.md
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
- No recursive subagent nesting (subagents can't have their own subagents)
- `--` is reserved in role IDs (used as the parent/child separator)

## Creating a Registry

A registry is a GitHub repository with a specific structure:

```
registry-repo/
├── registry.yaml
└── roles/
    ├── role-a/
    │   ├── role.yaml
    │   └── skills/
    └── role-b/
        ├── role.yaml
        └── skills/
```

The `registry.yaml` file must follow this format:

```yaml
name: my-registry
description: Description of the registry
url: https://github.com/user/my-registry
roles:
  role-a:
    version: "1.0.0"
    description: Role description
    tags: [tag1, tag2]
  role-b:
    version: "1.1.0"
    description: Another role
    tags: [tag3]
```

To publish your own registry:
1. Create a GitHub repository with the structure above
2. Add roles as subdirectories under `roles/`
3. Version management: use git tags on the repository (e.g., `v1.0.0`)
4. Users can add it: `rolebox registry add https://github.com/your-org/your-registry`

### Default Registry

The default registry is [oh-my-role](https://github.com/EricMoin/oh-my-role), which provides a curated set of roles:

- `software-architect` — System design and architecture
- `react-frontend` — React/Next.js frontend development
- `ai-designer` — AI application design
- `tauri` — Desktop app development with Tauri
- `dart-flutter` — Cross-platform mobile and desktop with Flutter
