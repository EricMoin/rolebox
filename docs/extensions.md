# Extensions

> Part of the rolebox documentation. See [README](../README.md) for overview.

Extensions let you register custom modules that open rolebox's closed vocabularies — adding your own conditions, graph topologies, recovery strategies, notification channels, and observe events. No source code changes needed.

Declare an `extensions:` block in `role.yaml`:

```yaml
extensions:
  conditions:
    - name: dispatch_all_complete
      module: ext/dispatch-complete.js
  graph_topologies:
    - name: diamond
      module: ext/diamond-topology.js
  recovery_strategies:
    - name: my-recovery
      module: ext/my-recovery.js
      categories: [session_error]
  notification_channels:
    - kind: slack
      module: ext/slack-channel.js
  observe_events:
    - name: dispatch_complete
      module: ext/dispatch-event.js
```

## Supported Scopes

| Scope | What it opens | Module contract |
|---|---|---|
| `conditions` | Function gate/transition/continue_until conditions | `{ handler: (arg, env) => boolean }` |
| `graph_topologies` | Graph topology templates | `{ expand: (agents) => FlowEdge[] }` |
| `recovery_strategies` | Error recovery strategy names (passes YAML validation) | `{ name, execute }` |
| `recovery_patterns` | Error detection patterns | `{ name, category, match }` — `category` from the built-in vocabulary; `match` callable |
| `notification_channels` | Notification channel kinds | `{ create: (config) => { kind, send, dispose } }` |
| `notification_events` | Notification event types (open string) | *(no module needed — events are open strings)* |
| `observe_events` | Function observe trigger events | `{ handle: (ctx, spec) => string[] }` |

A `recovery_patterns` module is untrusted input. Its `category` must name one of the
built-in recovery categories — `session_error`, `context_window`, `edit_error`,
`json_error`, `empty_response`, `tool_pair`, `guard_violation` — and its `match`
export must be callable; otherwise the module is skipped with a warning instead of
being registered. A matcher result is surfaced only when it is a structurally valid
`RecoveryError` (valid category, string `errorType`, string `message`, numeric
`timestamp`); `null`, `undefined` and any malformed value are treated as no match,
with one warning per adapted pattern rather than per call.

## Module contract example

```javascript
// ext/dispatch-complete.js
export default {
  handler: (arg, env) => {
    // env.sessionID, env.state, env.artifacts available
    return env.state.kv["dispatch_complete"] === true;
  },
};
```

## Safety

- Extension loading failures are caught per-module, logged as warnings, and skipped — never crashes the agent.
- Empty or missing `extensions:` block is a no-op.
- Built-in vocabularies (conditions, topologies, strategies, channels) remain unchanged — extensions are additive.
- Module loading uses dynamic `import()` with caching (same pattern as custom hooks).
