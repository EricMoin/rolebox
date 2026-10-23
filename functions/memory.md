---
name: memory
description: Memory consolidation mode — review project sessions and persist memories
params:
  scope: all
---

You are now in MEMORY CONSOLIDATION mode. Review project sessions, extract durable knowledge, and persist it as structured memories. The `{scope}` parameter determines which sessions to process.

## Mode Selection

The `{scope}` parameter controls what gets processed:

| Value | Behavior |
|---|---|
| `all` (default) | Incremental — prioritize sessions not represented in existing memories |
| `full` | Full rescan — re-process ALL sessions, deduplicate and merge |
| `recent` | Only the 5 most recent sessions |
| `session:<id>` | Only the specified session ID |

## Process

### 1. Discover Existing Memories

Start by running **`memory_list(format="json", limit=100, offset=0)`** to see workspace and current-role memories. Continue with offsets 100, 200, and so on until a page contains fewer than 100 entries, before writing any changes. Inspect `source_sessions` to identify sessions that supplied existing memories, and use **`memory_read(id=...)`** for the full content of entries you may revise.

### 2. Discover Sessions

Use **`session_list`** to list all sessions in this project. The returned session IDs are your candidates for inspection.

### 3. Select Sessions to Process

- **Incremental (default `all`):** Compare each session ID from `session_list` against the existing memories' `source_sessions`. Prioritize unrepresented sessions. A source session is provenance, not proof of a complete consolidation pass: revisit a represented session when it contains newer material or was only partially captured. A session that produced no durable memory may be revisited; do not create an empty memory just to mark it processed.
- **Full (`full`):** Include every session. Before writing, use `memory_recall` to check for existing similar memories and merge instead of duplicating.
- **Recent (`recent`):** Take the 5 most recent sessions from `session_list` by timestamp.
- **Session (`session:<id>`):** Process only the exact session ID provided.

### 4. Read Selected Sessions

For each selected session, use **`session_read`** to examine its content. Focus on substantive exchanges — architecture discussions, bug diagnoses, convention-setting, and user preference signals. Skim past trivial conversation.

### 5. Check Before Writing

Before creating any new memory:

1. Identify the key terms from the knowledge you intend to record.
2. Use **`memory_recall`** with those terms to search for an existing similar memory.
3. If a match exists, read it with **`memory_read`** before deciding. For the same supported conclusion, use **`memory_update`** to merge the useful information and pass the supporting session IDs in `source_sessions`; existing source IDs are retained automatically. A keyword match alone does not justify replacing a conclusion. Preserve unresolved disagreements separately with their evidence.
4. If no match exists, proceed to write.

### 6. Write or Update

- Use **`memory_write`** to create new memories.
- Use **`memory_update`** to revise existing ones when new information supersedes or refines an earlier recording.
- Pass the reviewed session IDs as `source_sessions` on both tools. The current session is recorded automatically; it does not replace the sessions that supplied the evidence.

## What to Remember

Capture knowledge that is valuable across sessions:

- **Architecture decisions and their rationale** — why a particular approach was chosen over alternatives
- **Discovered conventions and patterns** — naming, code organization, testing strategy, style guidelines
- **User preferences** — stylistic, structural, or workflow preferences expressed by the user
- **Lessons from failures** — what broke and why, what to watch for in future work
- **Project architecture facts** — dependency structures, module responsibilities, data flow, key interfaces

## What NOT to Remember

Avoid storing ephemeral or redundant information:

- Trivial conversation or casual chat
- Temporary debugging steps that did not yield insights
- Information already captured in code, comments, or documentation
- Transient state or one-time observations
- Secrets, credentials, or sensitive personal information

## Scope for Memories

When writing, decide whether each piece of knowledge belongs at the workspace level or the role level:

- **`scope: workspace`** — shared knowledge useful to all roles: project facts, architecture decisions, conventions. The `role_id` is set to `shared`.
- **`scope: role`** — role-specific working notes: how this role interprets patterns, role-specific preferences, internal methodology. The `role_id` is set to the current role.

When in doubt, prefer **workspace** scope — it surfaces in all sessions and maximizes the value of the consolidation pass.

## Result Summary

When all selected sessions have been processed, conclude with:

```
Memory consolidation complete.
Processed N sessions, wrote X new memories, updated Y.
```

Replace `N`, `X`, and `Y` with the actual counts from this run.
