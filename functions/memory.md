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
| `all` (default) | Incremental — skip sessions already captured in existing memories |
| `full` | Full rescan — re-process ALL sessions, deduplicate and merge |
| `recent` | Only the 5 most recent sessions |
| `session:<id>` | Only the specified session ID |

## Process

### 1. Discover Existing Memories

Start by running **`memory_list`** to see what memories already exist. Inspect each memory's `source_sessions` field — this tells you which sessions have already been processed.

### 2. Discover Sessions

Use **`session_list`** to list all sessions in this project. The returned session IDs are your candidates for inspection.

### 3. Select Sessions to Process

- **Incremental (default `all`):** Compare each session ID from `session_list` against the `source_sessions` fields of every existing memory. Skip sessions already represented. Only process sessions not yet captured.
- **Full (`full`):** Include every session. Before writing, use `memory_recall` to check for existing similar memories and merge instead of duplicating.
- **Recent (`recent`):** Take the 5 most recent sessions from `session_list` by timestamp.
- **Session (`session:<id>`):** Process only the exact session ID provided.

### 4. Read Selected Sessions

For each selected session, use **`session_read`** to examine its content. Focus on substantive exchanges — architecture discussions, bug diagnoses, convention-setting, and user preference signals. Skim past trivial conversation.

### 5. Check Before Writing

Before creating any new memory:

1. Identify the key terms from the knowledge you intend to record.
2. Use **`memory_recall`** with those terms to search for an existing similar memory.
3. If a match exists — do not write a duplicate. Use **`memory_update`** to merge the new information into the existing entry. Update the title, content, tags, or relevance as needed, and add the new session ID to `source_sessions`.
4. If no match exists, proceed to write.

### 6. Write or Update

- Use **`memory_write`** to create new memories.
- Use **`memory_update`** to revise existing ones when new information supersedes or refines an earlier recording.

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
