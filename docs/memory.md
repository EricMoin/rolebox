# Persistent memory

Rolebox stores reusable project knowledge in the workspace's `.rolebox/memory.db`. Memories can be shared across roles or private to the role that wrote them.

In DSH, system prompt assembly adds a **Memory workflow** when memory tools are available. It explains when to retrieve past decisions, read a complete entry, verify old conclusions, and save or revise a durable finding. The guidance remains present when the database is empty. It follows the current role and available tools; it does not grant additional permissions.

The same context can include an **Available memory** table of recent summaries. DSH reads the store when assembling the prompt, so later assemblies can reflect memories written during the session. Full contents are retrieved through the tools rather than embedded in every prompt.

## Configuration

Add this optional block to `role.yaml`:

```yaml
memory:
  inject: true
  max_inject: 10
  min_relevance: medium
  scope: both
```

| Field | Default | Meaning |
| --- | --- | --- |
| `inject` | `true` | Include available memory summaries in the system prompt. |
| `max_inject` | `10` | Maximum summaries, from `0` to `100`. |
| `min_relevance` | `medium` | Minimum relevance: `low`, `medium`, or `high`. |
| `scope` | `both` | Summaries from `workspace`, the current `role`, or `both`. |

`inject: false` or `max_inject: 0` disables automatic summaries. It leaves the workflow guidance and permitted tool calls available. A worker with only write capabilities receives guidance without existing memory summaries. A role with no memory tools receives neither block.

Inline subagents support the same configuration. A child without its own `memory` block inherits its parent's block. These settings select summaries; they do not change tool permissions or allow access to another role's private entries.

## Tools and scope

| Tool | Use |
| --- | --- |
| `memory_recall` | Search by keywords before repeating research or creating an entry. Markdown results contain previews; `format: "json"` returns full matching entries. |
| `memory_read` | Read a complete entry by `id`, including `source_sessions`; accepts Markdown or JSON output. |
| `memory_list` | Browse summaries, including IDs, scope, and source sessions. Supports `format: "json"`, `limit`, and `offset` for pagination. |
| `memory_write` | Save a new durable decision, preference, fact, lesson, or note. |
| `memory_update` | Revise an existing entry by ID while preserving valid content and provenance. |

Use `memory_read` after finding a relevant ID, and verify that the entry still applies. Search or browse before creating another entry about the same conclusion. Preserve unresolved disagreements rather than overwriting them solely because their keywords match.

`scope: "workspace"` makes an entry available to roles in this workspace. `scope: "role"` associates it with the current role. Model-facing search, list, read, and update operations enforce this visibility, including reads by ID. With no active role, only workspace memories are visible, and writes must explicitly use `scope: "workspace"`.

Both write and update accept `source_sessions`. Pass the IDs of sessions supplying the evidence; the current session is also recorded automatically. Updates merge source IDs. Source attribution helps later consolidation but does not mean an entire session has already been processed.

Existing entries keep their stored `role_id`. Older DSH entries associated with a session ID are not automatically reassigned to a role; administrative memory CLI access remains available for reviewing those entries.

Keep memories concise and reusable. Do not store transient task progress, raw transcripts, or credentials. A failed tool call is not a successful save.

## DSH graph workers

DSH graph nodes must declare the memory tools they need. A node's tool grant is separate from the role's memory configuration. For example, these node fields grant reading and writing:

```json
{
  "tools": ["memory_recall", "memory_read", "memory_list", "memory_write", "memory_update"]
}
```

In DSH, an omitted or empty `tools` grant provides no extra memory capabilities. Declaring tools still remains subject to the host's available tools and permissions. Use only the read tools for a worker that should consult knowledge without changing it. Pi workers have a different baseline that already includes memory tools.

For DSH nodes using `toolPresentation.mode: "discover"`, the workflow directs the worker to describe a capability with `graph_worker_tools` and invoke it through that tool's `call` action. In `code` mode, it describes schemas first and invokes capabilities through `graph_worker_code`. The guidance names only memory capabilities the worker is authorized to use.

## Optional session consolidation

In DSH, ask directly for a consolidation pass, for example:

```text
Review the five most recent project sessions and save reusable lessons, checking existing memories before writing.
```

When both `session_list` and `session_read`, memory reading, and memory writing or updating are available, the Memory workflow includes instructions for this explicit request. With `memory_list`, it browses JSON pages and checks `source_sessions`; it reads selected sessions, checks for existing conclusions, and saves supported findings with their source session IDs. DSH workers need the session tools in their grant as well as the memory tools.

DSH currently lists available functions without activating their full instructions from `|memory|`. Use the direct request above in DSH. Routine memory guidance does not require a function.

In ordinary OpenCode and Pi sessions, the bundled consolidation function can be made available through `role.yaml`:

```yaml
functions:
  - memory
```

Then request, for example:

```text
|memory| consolidate reusable lessons from project sessions
|memory:recent| review the five most recent sessions
```

The function requires the relevant memory and session tools. Session consolidation is an explicit task; it does not run automatically when a session ends.
