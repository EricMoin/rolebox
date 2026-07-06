# Subagents

> Part of the rolebox documentation. See [README](../README.md) for overview.

Subagents are child agents that a parent role can delegate to via `dispatch`. They let you build roles that coordinate specialist sub-agents, each with its own prompt, skills, and configuration.

## When to use

Use subagents when a role needs to break work across multiple specialists. A team lead might delegate research to one sub-agent and implementation to another, each tuned for its domain.

## Inline declaration

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

## File-based declaration

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

## Config inheritance

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

## Naming convention

Subagent IDs follow the pattern `{parentId}--{childId}`. The child ID is derived from the name field (lowercased, spaces replaced with dashes). For example, a "Team Lead" role with an "Implementer" subagent produces the ID `team-lead--implementer`.

The `--` separator is reserved. Don't use it in regular role IDs.

## Dispatch

The parent dispatches work to a subagent using the `dispatch` tool:

```
dispatch(subagent="team-lead--implementer", prompt="Implement the auth module", run_in_background=true)
```

Rolebox exposes three dispatch tools to the parent agent:

| Tool | Purpose |
|---|---|
| `dispatch` | Launch a task (sync or background) |
| `dispatch_output` | Retrieve results from a completed background task |
| `dispatch_cancel` | Cancel a running background task |

A fourth tool, `dispatch_metrics`, provides runtime counters, gauges, and histograms for the dispatch subsystem when `ROLEBOX_METRICS` is set.

A fifth tool, `dispatch_budget`, reports token/cost budget status for the current dispatch request. It shows configured limits, current usage, remaining budget, and percentage used. The orchestrator agent calls this before dispatching more tasks to avoid exceeding budget limits.

**Background tasks** run asynchronously. The parent gets a task ID back immediately and receives a `<system-reminder>` notification when the task finishes. Call `dispatch_output` after the notification to collect results.

**Sync tasks** block until the subagent finishes (10 min timeout). Use these for short work where the parent needs the result right away.

### Session continuation

Pass `session_id` (the task ID from a previous dispatch) to re-prompt a subagent in the same opencode session. This preserves the conversation history, so the subagent picks up where it left off.

```
dispatch(subagent="team-lead--implementer", session_id="<previous-task-id>", prompt="Now add tests", run_in_background=true)
```

### Per-task timeout

Background tasks accept an optional `timeout_ms` to override the default 15 min stale timeout. Without it, long-running tasks get reaped.

### Concurrency

Background tasks are gated by a per-model semaphore (default: 5 concurrent tasks per model). When all slots are full, new tasks queue up in a bounded FIFO (default depth: 10). If the queue is also full, the dispatch fails immediately with an error. One slot per model is reserved for sync dispatch so that synchronous calls don't starve behind a full background queue.

## Subagent skills and functions

Subagents can have their own `skills/` and `functions/` directories (file-based declaration only). Skills from subagents are symlinked into opencode as `rolebox--{parentId}--{childId}--{skillName}`.

## Limitations

File-based subagents support recursive nesting up to `maxDepth=3` (configurable) via nested `subagents/` directories. There's no runtime creation of subagents, and subagents can't communicate directly with each other. All coordination goes through the parent. The `--` separator chains at each level (e.g. `grandparent--parent--child`).
