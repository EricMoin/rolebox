# Functions

> Part of the rolebox documentation. See [README](../README.md) for overview.

Functions are composable behavior modules that users activate at runtime with `|name|` syntax. They inject additional instructions into the system prompt on demand.

Every role ships with two built-in functions (`plan` and `execute`) by default. Users activate them by prefixing their message:

```
|plan| redesign the auth module
|execute| implement the refactoring we discussed
|plan|execute| add pagination to the API
```

## How it works

1. User types `|plan| do something` → parser strips `|plan|`, activates the function for this session
2. On every subsequent turn, the function's instructions are injected into the system prompt
3. Functions persist for the session once activated

## Writing custom functions

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

## Parameterized functions

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

## Resolution priority

1. `{roleDir}/functions/{name}.md` — role-local override
2. `~/.config/opencode/functions/{name}.md` — global user-defined
3. Built-in (`plan`, `execute`) — shipped with rolebox

## Configuring functions per role

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

## Built-in functions

**plan** — Instructs the agent to investigate the codebase with tools (Read, Grep, Glob, LSP) before planning. Produces a structured plan with verification strategy. Waits for user approval before executing.

**execute** — Instructs the agent to implement step by step with tool-based verification (lsp_diagnostics, build, tests) after each change. Handles failures with a two-attempt escalation policy.

**loop** — Runs the same task repeatedly across isolated worker sessions. The origin session becomes a pure orchestrator: it acknowledges activation, dispatches each round to a child worker via the dispatch system, and produces a user-facing summary when the round completes. The orchestrator never executes the task itself.

```
|loop| refactor the utils module        # 5 rounds (default), inherit mode
|loop:3| run the test suite             # 3 rounds
|loop:10,fresh| generate examples       # 10 rounds, fresh mode
```

**How it works:**

1. Every round (including the first) executes in a fresh child worker session dispatched through the dispatch system
2. The origin session is a pure orchestrator/observer. It acknowledges activation, produces one user-facing summary per completed round, and never executes the task
3. Each round's summary becomes the seed context for the next round (`inherit` mode), creating a self-contained context chain
4. The iteration count controls stopping. There's no LLM early-stop mechanism

**Modes:**

| Mode | Behavior |
|---|---|
| `inherit` (default) | Round N+1 gets round N's summary prepended as seed context |
| `fresh` | Each round starts with only the base task, no prior context |

**Cancellation:** Any user message sent while a round is running cancels the loop immediately. System re-prompts (dispatch completion notifications, auto-continue signals) never cancel.
