# Custom Hooks

> Part of the rolebox documentation. See [README](../README.md) for overview.

Hooks are declared in `role.yaml` under the `hooks.custom` field and fire in two phases: `before` (before the built-in handler) and `after` (after the built-in handler). Each hook runs independently — a failure in one hook never crashes the agent.

## Schema

```yaml
hooks:
  custom:
    - name: my-quality-checker
      description: "Checks code quality after edits"
      events: [tool.execute.after, chat.message]
      module: hooks/quality-checker.js
      config:
        severity: warn
        checks: [no_console_log]
      filter:
        tools: [edit, write, hashline_edit]
      priority: 50
      phase: after
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Unique identifier for this hook |
| `description` | string | — | Human-readable description |
| `events` | string[] | — | Events to listen to: `chat.message`, `tool.execute.before`, `tool.execute.after`, `system.transform`, `event` |
| `module` | string | — | Path to the hook module (relative to the role directory or absolute) |
| `config` | object | — | Arbitrary configuration passed to the hook at runtime |
| `filter` | object | — | Conditions to limit when the hook fires |
| `filter.tools` | string[] | — | Only fire for these tool names (applies to `tool.execute.before` / `tool.execute.after`) |
| `filter.eventTypes` | string[] | — | Only fire for these event types (applies to `event`: `session.idle`, `session.error`, etc.) |
| `priority` | number | `50` | Lower values fire first within the same phase |
| `phase` | string | `"after"` | `"before"` (runs before built-in logic) or `"after"` (runs after built-in logic) |

## Hook Module Interface

Each hook module is a JavaScript/TypeScript file that exports an object with optional handler methods:

| Method | Trigger | Input |
|---|---|---|
| `onChatMessage(ctx, { text })` | After user sends a message | The full message text |
| `onToolBefore(ctx, { tool, args })` | Before a tool executes | Tool name and arguments |
| `onToolAfter(ctx, { tool, args, output })` | After a tool executes | Tool name, args, and result output |
| `onSystemTransform(ctx, { system })` | During system prompt construction | The system prompt array (modifiable) |
| `onEvent(ctx, { type, properties })` | On lifecycle events | Event type and properties |
| `onLoad(ctx)` | Once when the hook is registered | — |
| `onDispose(ctx)` | Once when the plugin shuts down | — |

## HookContext API

Every handler receives a `ctx` (HookContext) object:

| Property | Type | Description |
|---|---|---|
| `hookName` | string | The hook's configured name |
| `config` | object \| undefined | The hook's `config` from role.yaml |
| `sessionID` | string \| undefined | Current session ID (when available) |
| `agent` | string \| undefined | Current agent ID (when available) |
| `inject(text)` | function | Appends text to the next system prompt (uses `appendCorrection`) |
| `log` | Logger | Structured logger scoped to this hook |

## Filter and Phase

**Filter** limits which tool calls or events trigger the hook:

```yaml
filter:
  tools: [write, edit]          # Only fire on write/edit tool calls
  eventTypes: [session.error]   # Only fire on session.error events
```

**Phase** controls ordering relative to built-in handlers:

- `"before"` — fires before the built-in handler runs its logic
- `"after"` (default) — fires after the built-in handler completes

Multiple hooks with the same phase are ordered by `priority` (lower = earlier). Within the same priority, registration order is preserved.

## Complete Example

```yaml
# role.yaml
name: Quality-Conscious Coder
description: Warns about debug code and enforces conventions
hooks:
  custom:
    - name: no-console-log
      description: Detect stray console.log in file writes
      events: [tool.execute.after]
      module: hooks/no-console-log.js
      filter:
        tools: [write, edit]
      priority: 10
      phase: after
```

```javascript
// hooks/no-console-log.js
export default {
  onToolAfter: (ctx, { tool, args, output }) => {
    const content = typeof args?.content === "string" ? args.content : "";
    if (content.includes("console.log(")) {
      ctx.inject(`Warning: console.log() in ${tool} output.`);
    }
  },
};
```

## Safety

- Hooks never crash the agent. Every hook handler is wrapped in try/catch — failures log a warning and continue.
- The `inject()` mechanism appends to the next system prompt via the existing `appendCorrection` system, the same pathway used by built-in guardrails.
- Module loading failures (missing file, syntax error) are logged and the hook is skipped — the registry stores `null` and continues.
