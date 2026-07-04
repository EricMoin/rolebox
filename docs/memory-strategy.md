# Memory Feature — Implementation Strategy

**Date:** 2026-07-04
**Target:** rolebox v0.17.0
**Objective:** Implement a cross-session, cross-role persistent knowledge system with instant memory writes and consolidation-mode memory review, backed by SQLite with full-text search.

---

## 1. Overview

Memory solves the problem that agents lose context when sessions end. Two complementary mechanisms work together:

1. **Instant memory** — working roles proactively call a `memory_write` tool during work to record facts, decisions, preferences, and lessons as they arise.
2. **Consolidation memory** — the user activates `|memory|`, and the current agent enters a memory consolidation mode that reviews project sessions and writes or updates memories in bulk.

The system has two isolation layers: **role-private** memories (visible only to the role that wrote them) and **workspace-shared** memories (visible to all roles in the project).

---

## 2. Design Decisions

All decisions are finalized:

| Decision | Conclusion |
|---|---|
| Scope | Role-private + workspace-shared layer |
| Storage | SQLite via `bun:sqlite`, WAL mode |
| Built-in vs Optional | Approach C: tools built-in for all roles, injection configurable in `role.yaml` |
| Instant write | Working roles proactively call `memory_write` tool |
| Consolidation write | `\|memory\|` function activated by user, current agent executes |
| Writer role | NOT needed — function injection content IS the writer instructions |
| Customization | Override `functions/memory.md` (standard rolebox function override pattern) |
| Injection | Auto-inject `<available_memory>` summary block at session start |
| Visibility | Consolidation can see ALL project sessions (not just current) |
| Trigger | Manual via `\|memory\|` function, no idle/auto-trigger |

---

## 3. Storage

### 3.1 Why SQLite (not Markdown)

Markdown files work well for static references and skills — they are human-readable, git-trackable, and loaded on demand. But memory has fundamentally different requirements:

| Requirement | Markdown | SQLite |
|---|---|---|
| Full-text search with ranking | Manual grep, no ranking | FTS5 with BM25 ranking |
| Multi-dimensional filtering (scope + category + relevance + tags) | Ad-hoc path conventions | Native WHERE clauses |
| Capacity eviction by access recency | Custom script per project | ORDER BY accessed_at + LIMIT |
| Deduplication on write | Grep + parse all files | PRIMARY KEY + ON CONFLICT |
| Access statistics for LRU eviction | Separate stats file | Built-in columns |
| Concurrent read/write | Race conditions | WAL mode, concurrent readers |

`.rolebox/` is runtime state — already gitignored — not source code. SQLite is the right tool for transactional, queryable runtime state.

Bun ships `bun:sqlite` natively — zero additional dependencies.

### 3.2 File Location

```
.rolebox/
└── memory.db          # SQLite single file, WAL mode
```

A new function `memoryDbPath(dir)` in `src/state-paths.ts` derives the path:

```typescript
export function memoryDbPath(dir: string): string {
  return join(dir, ROLEBOX_DIR, "memory.db");
}
```

This follows the existing `stateDirFor(dir)` pattern — a single source of truth so the read side (CLI) and write side (MemoryStore) cannot drift apart.

### 3.3 SQLite Schema

```sql
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,             -- 'workspace' | 'role'
  role_id         TEXT,                      -- writer role; 'shared' when scope='workspace'
  category        TEXT,                      -- 'decision' | 'preference' | 'fact' | 'lesson' | 'note'
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,             -- Markdown body
  tags            TEXT,                      -- JSON array: '["auth","architecture"]'
  relevance       TEXT DEFAULT 'medium',     -- 'high' | 'medium' | 'low'
  created_at      TEXT NOT NULL,             -- ISO 8601
  updated_at      TEXT NOT NULL,
  accessed_at     TEXT,                      -- last recall time
  access_count    INTEGER DEFAULT 0,
  session_id      TEXT,                      -- session that wrote this memory (for traceability)
  source_sessions TEXT                       -- JSON array of session IDs this memory was derived from
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content, tags,
  content='memories',
  content_rowid='rowid'
);

CREATE INDEX idx_scope_role ON memories(scope, role_id);
CREATE INDEX idx_category ON memories(category);
CREATE INDEX idx_accessed ON memories(accessed_at);
CREATE INDEX idx_relevance ON memories(relevance);
```

**Field descriptions:**

| Field | Description |
|---|---|
| `id` | Short content-based hash — `shortHash(title + timestamp)`, unique per entry |
| `scope` | `'workspace'` = shared across all roles; `'role'` = private to `role_id` |
| `role_id` | The role that wrote the memory; set to `'shared'` when `scope='workspace'` |
| `category` | Semantic category for filtering: decision, preference, fact, lesson, or note |
| `title` | Short human-readable title (max 200 chars at tool level) |
| `content` | Full Markdown body of the memory |
| `tags` | JSON array of tag strings for cross-cutting categorization |
| `relevance` | Self-declared importance: high / medium / low |
| `created_at` / `updated_at` | ISO 8601 timestamps |
| `accessed_at` | Last time this memory was recalled via `memory_recall` or loaded for injection |
| `access_count` | Total recall count — used for LRU eviction |
| `session_id` | The session that originally wrote this memory (traceability) |
| `source_sessions` | JSON array of session IDs for consolidation-derived memories (tracks which sessions were reviewed) |

**FTS5 trigger setup** — keeps the virtual table in sync with the base table:

```sql
-- INSERT trigger
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

-- DELETE trigger
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

-- UPDATE trigger
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
```

### 3.4 Storage Module

New file: `src/memory/store.ts`

```typescript
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { memoryDbPath, shortHash } from "../state-paths.ts";
import { createSubLogger } from "../logger.ts";
import type { MemoryEntry, MemorySummary } from "../types.ts";

const log = createSubLogger("memory:store");

export interface MemoryListOptions {
  scope?: string;
  category?: string;
  limit?: number;
  sort?: "recent" | "relevance" | "accessed";
}

export interface MemorySearchOptions {
  query: string;
  scope?: string;
  category?: string;
  limit?: number;
}

export class MemoryStore {
  private db: Database;

  constructor(private workspaceDir: string) {
    const path = memoryDbPath(workspaceDir);
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // Execute CREATE TABLE IF NOT EXISTS ... from §3.3
    // Execute FTS5 table creation
    // Execute trigger creation
  }

  write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at" | "accessed_at" | "access_count">): string {
    const id = shortHash(`${entry.title}${Date.now()}`);
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO memories (id, scope, role_id, category, title, content, tags, relevance, created_at, updated_at, session_id, source_sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entry.scope, entry.role_id, entry.category, entry.title, entry.content,
       JSON.stringify(entry.tags ?? []), entry.relevance, now, now, entry.session_id,
       JSON.stringify(entry.source_sessions ?? [])],
    );
    return id;
  }

  read(id: string): MemoryEntry | null { /* ... */ }
  update(id: string, fields: Partial<MemoryEntry>): void { /* ... */ }
  delete(id: string): void { /* ... */ }
  list(options?: MemoryListOptions): MemorySummary[] { /* ... */ }
  search(options: MemorySearchOptions): MemoryEntry[] { /* FTS5 MATCH ... */ }
  touch(id: string): void { /* UPDATE accessed_at=now, access_count++ */ }
  stats(): { total: number; byScope: Record<string, number>; byCategory: Record<string, number> } { /* ... */ }
}
```

**Pattern reference:** Follows the `ArtifactStore` class pattern from `src/function/artifact-store.ts` — constructor takes workspace directory, methods are thin wrappers over storage operations, error handling uses logger.

**Key implementation notes:**

- Only 1 `MemoryStore` instance per session (stored in `HookDeps` or created on demand)
- The `db` field is the single `bun:sqlite` `Database` instance — no pool needed since memory writes are low-frequency
- WAL mode allows concurrent reads from CLI while agent writes
- All write operations are wrapped in `db.transaction()` for atomicity
- FTS5 queries use `SELECT ... FROM memories WHERE rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)`

---

## 4. Tools (Built-in, Available to All Roles)

Four tools registered in the `tool:` object of `src/plugin-hooks.ts` alongside existing dispatch and session tools.

### 4.1 `memory_write`

```typescript
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

export function createMemoryWriteTool() {
  return tool({
    description: "Write a new memory entry to persistent storage. Memories persist across sessions for future recall.",
    args: {
      title: z.string().min(1).max(200).describe("Short title for this memory"),
      content: z.string().min(1).describe("Memory content in Markdown"),
      category: z.enum(["decision", "preference", "fact", "lesson", "note"]).optional().default("note"),
      scope: z.enum(["workspace", "role"]).optional().default("role").describe("workspace=shared, role=private to current role"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      relevance: z.enum(["high", "medium", "low"]).optional().default("medium"),
    },
    execute(input, context) {
      const store = new MemoryStore(context.directory);
      const id = store.write({
        title: input.title,
        content: input.content,
        category: input.category,
        scope: input.scope,
        role_id: input.scope === "workspace" ? "shared" : (context.agent ?? "unknown"),
        tags: input.tags ?? [],
        relevance: input.relevance,
        session_id: context.sessionID,
        source_sessions: [],
      });
      return `Memory written. ID: ${id}`;
    },
  });
}
```

**Execute logic:**
1. Create `MemoryStore(context.directory)`
2. Generate ID via `shortHash(title + Date.now())`
3. Auto-fill `role_id` from `context.agent`
4. Auto-fill `session_id` from `context.sessionID`
5. Auto-fill `created_at` / `updated_at` as ISO 8601 now
6. Write to SQLite (atomic)
7. Return confirmation with the memory ID

### 4.2 `memory_recall`

```typescript
export function createMemoryRecallTool() {
  return tool({
    description: "Search memories by full-text query with optional filters. Returns ranked results.",
    args: {
      query: z.string().min(1).describe("Full-text search query"),
      scope: z.enum(["workspace", "role", "both"]).optional().default("both"),
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
    },
    execute(input, context) {
      const store = new MemoryStore(context.directory);
      let scopeFilter = input.scope;
      if (scopeFilter === "role" && context.agent) {
        scopeFilter = `role:${context.agent}`;
      } else if (scopeFilter === "both" && context.agent) {
        scopeFilter = `both:${context.agent}`;
      }
      const results = store.search({
        query: input.query,
        scope: scopeFilter,
        category: input.category,
        limit: input.limit,
      });
      for (const r of results) store.touch(r.id);
      if (results.length === 0) return `No memories found matching "${input.query}".`;
      return results.map((r) =>
        `ID: ${r.id}\nTitle: ${r.title}\nCategory: ${r.category} | Relevance: ${r.relevance}\n${r.content.slice(0, 200)}...`
      ).join("\n---\n");
    },
  });
}
```

**Execute logic:**
1. FTS5 MATCH query with scope/category WHERE clause filtering
2. For each result, call `touch()` to update `accessed_at` and `access_count`
3. Return ranked results with title, summary (first 200 chars), category, relevance, ID

### 4.3 `memory_list`

```typescript
export function createMemoryListTool() {
  return tool({
    description: "List memory summaries for browsing or system prompt injection.",
    args: {
      scope: z.enum(["workspace", "role", "both"]).optional().default("both"),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      sort: z.enum(["recent", "relevance", "accessed"]).optional().default("recent"),
    },
    execute(input, context) {
      const store = new MemoryStore(context.directory);
      const summaries = store.list({ scope: input.scope, category: input.category, limit: input.limit, sort: input.sort });
      if (summaries.length === 0) return "No memories found.";
      return summaries.map((s) =>
        `- ${s.title} [${s.category}] (${s.relevance}) — ${s.updated_at}`
      ).join("\n");
    },
  });
}
```

### 4.4 `memory_update`

```typescript
export function createMemoryUpdateTool() {
  return tool({
    description: "Update an existing memory entry. Only provided fields are changed.",
    args: {
      id: z.string().describe("Memory ID to update"),
      title: z.string().optional(),
      content: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      relevance: z.string().optional(),
    },
    execute(input, context) {
      const store = new MemoryStore(context.directory);
      const updates: Record<string, unknown> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.content !== undefined) updates.content = input.content;
      if (input.category !== undefined) updates.category = input.category;
      if (input.tags !== undefined) updates.tags = input.tags;
      if (input.relevance !== undefined) updates.relevance = input.relevance;
      store.update(input.id, updates as any);
      return `Memory ${input.id} updated.`;
    },
  });
}
```

### 4.5 Tool Registration in `src/plugin-hooks.ts`

```typescript
import {
  createMemoryWriteTool,
  createMemoryRecallTool,
  createMemoryListTool,
  createMemoryUpdateTool,
} from "./memory/tools.ts";

// Inside createPluginHooks, in the tools object:
const tools = {
  // ... existing tools ...
  memory_write: createMemoryWriteTool(),
  memory_recall: createMemoryRecallTool(),
  memory_list: createMemoryListTool(),
  memory_update: createMemoryUpdateTool(),
};
```

All four tools need only `context.directory` and `context.agent` from the execution context — they do **not** require `client` or `HookDeps`. The tools create a `MemoryStore` instance per call, following the lightweight pattern of dispatch tools.

---

## 5. Function: `|memory|`

New built-in function file at `functions/memory.md` (alongside existing `functions/plan.md`, `functions/execute.md`, `functions/loop.md`).

### 5.1 Function Frontmatter

```yaml
---
name: memory
description: Memory consolidation mode — review project sessions and persist memories
params:
  scope: all
---
```

### 5.2 Function Content (Injected Instructions)

The function body instructs the agent to:

1. **Discover sessions:** Use `session_list` to list sessions in this project.
2. **Avoid rework by default:** Skip sessions whose IDs already appear in `source_sessions` of any existing memory. This is the incremental mode.
3. **Check before writing:** Use `memory_recall` with the intended title or key terms to check if a similar memory already exists. If it does, use `memory_update` to merge or revise the existing entry rather than creating a duplicate.
4. **Write new memories:** Use `memory_write` for each distinct piece of knowledge.
5. **Revise existing memories:** Use `memory_update` when new information supersedes or refines an earlier one.
6. **What to remember:**
   - Architecture decisions and their rationale — why was a particular approach chosen?
   - Discovered conventions and patterns — naming, code organization, testing strategy
   - User preferences — stylistic, structural, or workflow preferences expressed by the user
   - Lessons from failures — what broke and why, what to watch for
   - Project architecture facts — dependency structures, module responsibilities, data flow
7. **What NOT to remember:**
   - Trivial conversation or casual chat
   - Temporary debugging steps that did not yield insights
   - Information already captured in code, comments, or documentation
8. **Summarize results** at the end in a single message:
   ```
   Memory consolidation complete.
   Processed N sessions, wrote X new memories, updated Y.
   ```

### 5.3 Activation Syntax

```
|memory|                 # Incremental: process unprocessed sessions
|memory:full|            # Full rescan: all sessions, dedup + merge
|memory:recent|          # Only recent 5 sessions
|memory:session:abc123|  # Only specific session
```

Positional parameters map to the `params` declaration order (`scope`), following the same colon-delimited syntax as `|plan|`, `|loop:3|`, etc. The parameter values (`full`, `recent`, `session:abc123`) are passed into the function content via the existing `applyParams` mechanism in `src/function-resolver.ts`.

### 5.4 Resolution Priority

Follows the standard rolebox function resolution order (same as all other functions):

1. `{roleDir}/functions/memory.md` — role-local override
2. `~/.config/opencode/functions/memory.md` — global user-defined
3. Built-in `functions/memory.md` shipped with rolebox

This is enforced by `resolveFunctions()` in `src/function-resolver.ts` with zero changes — it already checks role-local → global → built-in.

---

## 6. System Prompt Injection

### 6.1 `<available_memory>` Block

At session start, inject a `<available_memory>` block listing memory summaries — same pattern as `buildReferenceBlock` and `buildSkillBlock`.

New function in `src/prompt-builder.ts`:

```typescript
import type { MemorySummary } from "./types.ts";

export function buildMemoryBlock(memories: MemorySummary[]): string {
  if (memories.length === 0) return "";
  return renderSection(
    "available_memory",
    "Memory entries from previous sessions. Use memory_recall to search for specific memories.",
    memories.map((m) => xml("memory", [
      xml("id", [m.id]),
      xml("title", [m.title]),
      xml("category", [m.category]),
      xml("relevance", [m.relevance]),
      xml("updated", [m.updated_at]),
    ])),
  );
}
```

Output:

```xml
<available_memory>
Memory entries from previous sessions. Use memory_recall to search for specific memories.
  <memory>
    <id>auth-jwt-decision</id>
    <title>Auth uses JWT with refresh tokens</title>
    <category>decision</category>
    <relevance>high</relevance>
    <updated>2026-07-04T10:30:00Z</updated>
  </memory>
</available_memory>
```

Only summaries (id, title, category, relevance, updated_at) are injected — not full content — to minimize token consumption. The agent uses `memory_recall` to retrieve full content when needed, the same UX pattern as references.

### 6.2 Injection Configuration

In `role.yaml`, add an optional `memory` block:

```yaml
memory:
  inject: true           # default true — auto-inject <available_memory> block at session start
  max_inject: 10         # default 10 — max summaries to inject
  min_relevance: medium  # default medium — only inject relevance >= this
  scope: both            # default both — which scope to inject (role|workspace|both)
```

When `inject: false` or no `memory` block is configured, the block is not injected. The tools (`memory_write`, `memory_recall`, etc.) remain available regardless of this setting — only the auto-injection of the summary block is controlled.

### 6.3 Integration into `handleSystemTransform`

In `src/hooks/system-transform.ts`, add memory injection to the existing `handleSystemTransform` function. The injection runs after the reference/skill blocks (which are built in `buildAgentPrompt` / handled separately) and before the function blocks. The logic:

1. Read the current role's memory config from the role's `RoleConfig.memory` field (with sensible defaults)
2. If `inject !== false`, create a `MemoryStore(deps.dir)`
3. Call `store.list()` with the configured scope, min_relevance, and max_inject filters
4. Build the block via `buildMemoryBlock()`
5. Push to `output.system`

```typescript
// In handleSystemTransform, after existing reference/skill injection and before function blocks:

if (agentId) {
  const role = resolvedRoles.find((r) => r.id === agentId);
  const memConfig = role?.config?.memory ?? { inject: true, max_inject: 10, min_relevance: "medium", scope: "both" };
  
  if (memConfig.inject !== false) {
    try {
      const { MemoryStore } = await import("../memory/store.ts");
      const store = new MemoryStore(deps.dir);
      const memories = store.list({
        scope: memConfig.scope,
        limit: memConfig.max_inject ?? 10,
        minRelevance: memConfig.min_relevance,
      });
      const block = buildMemoryBlock(memories);
      if (block) {
        output.system.push(block);
      }
    } catch (err) {
      log.warn("Failed to inject memory block", { error: String(err) });
    }
  }
}
```

This follows the exact same pattern as how references, skills, and functions are currently injected — pushing to `output.system` at the right point in the transform pipeline.

### 6.4 Access to RoleConfig

The `handleSystemTransform` function currently receives agent ID via `input.agent` and has access to `deps.roleFunctionsMap` and `deps.roleGraphMap`. To resolve memory configuration, it needs access to the resolved role objects. Two options:

- **Option A (preferred):** Store resolved roles in `HookDeps` as a new field `roleMap: Map<string, ResolvedRole>`, initialized in `createPluginHooks()` where all resolved roles are available.
- **Option B:** Store the memory config map directly: `roleMemoryConfigMap: Map<string, MemoryConfig>`, initialized similarly.

Option A is more reusable if other role-level config needs to be accessed in `handleSystemTransform` later.

---

## 7. Type Definitions

Add to `src/types.ts`:

```typescript
/** Memory configuration in role.yaml */
export interface MemoryConfig {
  inject?: boolean;        // default: true
  max_inject?: number;     // default: 10
  min_relevance?: string;  // default: "medium"
  scope?: string;          // default: "both"
}

/** A memory entry returned by list/search/store.read */
export interface MemoryEntry {
  id: string;
  scope: string;
  role_id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  relevance: string;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  session_id: string | null;
  source_sessions: string[];
}

/** A memory summary for injection (lighter weight — no full content) */
export interface MemorySummary {
  id: string;
  title: string;
  category: string;
  relevance: string;
  updated_at: string;
}
```

Add `memory?: MemoryConfig;` to the existing `RoleConfig` interface:

```typescript
export interface RoleConfig {
  // ... existing fields ...
  /** Memory configuration for cross-session persistent knowledge */
  memory?: MemoryConfig;
}
```

---

## 8. File Structure

```
src/memory/
├── store.ts           — MemoryStore class (SQLite CRUD + FTS, WAL mode)
├── tools.ts           — 4 tool creation functions (memory_write, memory_recall, memory_list, memory_update)
├── inject.ts          — buildMemoryBlock + injection logic (optional: extracted from prompt-builder.ts)
└── types.ts           — MemoryConfig, MemoryEntry, MemorySummary (or add to src/types.ts)

functions/
└── memory.md          — Built-in |memory| function

tests/memory/
├── store.test.ts      — SQLite CRUD, FTS search, capacity management, concurrent access
└── tools.test.ts      — Tool tests with mock MemoryStore

src/state-paths.ts     — Add memoryDbPath(dir) function
src/prompt-builder.ts  — Add buildMemoryBlock()
src/types.ts           — Add MemoryConfig, MemoryEntry, MemorySummary; add memory to RoleConfig
src/hooks/deps.ts      — Add roleMap: Map<string, ResolvedRole>
src/hooks/system-transform.ts — Add memory injection block
src/plugin-hooks.ts    — Register 4 memory tools, populate roleMap in deps
```

---

## 9. CLI Commands

Add a `memory` subcommand to `src/cli/`, following the existing citty-based command pattern (same as `monitor.ts`, `list.ts`, etc.):

```bash
rolebox memory list [--scope workspace|role|both] [--category <cat>] [--limit N]
rolebox memory show <id>
rolebox memory search <query> [--scope ...] [--limit N]
rolebox memory delete <id>
rolebox memory export [--format markdown|json] [--output <path>]
rolebox memory clean [--max-age-days N] [--min-relevance low]  # Eviction
rolebox memory stats                                              # Count, scope distribution, category breakdown
```

The CLI resolves the project root by looking for `.rolebox/` in current or parent directories (same pattern as `monitor-reader.ts:resolveProjectRoot`), then opens the SQLite database at `memoryDbPath(projectRoot)`.

```typescript
// Conceptual structure — src/cli/commands/memory.ts
import { defineCommand } from "citty";
import { resolveProjectRoot } from "./monitor-reader.ts";
import { MemoryStore } from "../../memory/store.ts";

export const memoryCommand = defineCommand({
  meta: { name: "memory", description: "Manage cross-session memories" },
  subCommands: {
    list: defineCommand({ /* ... */ }),
    show: defineCommand({ /* ... */ }),
    search: defineCommand({ /* ... */ }),
    delete: defineCommand({ /* ... */ }),
    export: defineCommand({ /* ... */ }),
    clean: defineCommand({ /* ... */ }),
    stats: defineCommand({ /* ... */ }),
  },
});
```

### CLI Implementation Notes

- All subcommands share the same `MemoryStore` initialization from the resolved project root
- `rolebox memory stats` returns: total count, count by scope, count by category, count by relevance, total tags
- `rolebox memory export --format markdown` renders each entry as a Markdown section
- `rolebox memory export --format json` writes JSON array
- `rolebox memory clean` with no args shows a dry-run of what would be deleted; add `--yes` to execute
- Error handling follows existing CLI pattern: log errors, print user-friendly messages, exit non-zero on failure

---

## 10. Capacity Management

### 10.1 Eviction Strategy

The eviction mechanism keeps the database bounded and relevant:

- **Manual trigger:** `rolebox memory clean` CLI command initiates cleanup
- **Eviction criteria** (configurable by CLI flags):
  - `access_count = 0 AND accessed_at < (now - max_age_days)` → delete (never recalled, older than threshold)
- **Relevance downgrade:** if `accessed_at < (now - 30 days)` and relevance is `high`, downgrade to `medium`; if `medium`, downgrade to `low`. Low-relevance entries with no recent access are prime eviction candidates.
- **Default limits:** max 500 memories per scope (each workspace scope + each role scope), configurable via env var.
- **Lazy auto-eviction:** auto-eviction runs opportunistically on `memory_write`, checking every 10 writes (`writeCount % 10 === 0`), not on every write.

### 10.2 Configurable Parameters

| Parameter | Default | Env Var |
|---|---|---|
| Max entries per scope | 500 | `ROLEBOX_MEMORY_MAX_ENTRIES` |
| Relevance downgrade window | 30 days | — |
| Auto-eviction check interval | Every 10 writes | — |
| Default eviction max age | 180 days | — |

---

## 11. Implementation Plan (14 Subtasks)

### Phase 1: Core Storage

**Subtask 1** — Add `memoryDbPath()` to `src/state-paths.ts`.

**Subtask 2** — Implement `src/memory/store.ts`:
- `MemoryStore` class with constructor, `ensureSchema()`, schema DDL
- Methods: `write`, `read`, `update`, `delete`, `list`, `search`, `touch`, `stats`
- WAL mode, FTS5 triggers, atomic transactions

**Subtask 3** — Add types to `src/types.ts`:
- `MemoryConfig`, `MemoryEntry`, `MemorySummary` interfaces
- `memory?: MemoryConfig` to `RoleConfig`

### Phase 2: Tools

**Subtask 4** — Implement `src/memory/tools.ts`:
- `createMemoryWriteTool` — writes with auto-generated ID, role/session metadata
- `createMemoryRecallTool` — FTS5 search with scope/category filters, touch on recall
- `createMemoryListTool` — filtered/sorted listing
- `createMemoryUpdateTool` — partial field merge

**Subtask 5** — Wire tools into `src/plugin-hooks.ts`:
- Import 4 tool creators
- Register in the `tools` object alongside existing dispatch/session tools

### Phase 3: Injection

**Subtask 6** — Implement `buildMemoryBlock()` in `src/prompt-builder.ts`:
- Format `<available_memory>` XML block with summaries
- Follow same pattern as `buildReferenceBlock`, `buildSkillBlock`

**Subtask 7** — Add memory injection to `handleSystemTransform` in `src/hooks/system-transform.ts`:
- Read `MemoryConfig` from resolved role
- Create `MemoryStore`, call `store.list()`, build block, push to `output.system`

**Subtask 8** — Wire `ResolvedRole` access into `HookDeps`:
- Add `roleMap: Map<string, ResolvedRole>` to `HookDeps`
- Populate in `createPluginHooks()` from the resolved roles array

### Phase 4: Function

**Subtask 9** — Create `functions/memory.md`:
- Built-in `|memory|` function with frontmatter and consolidation instructions
- Includes session discovery, dedup check, write/update logic, result summary

### Phase 5: CLI

**Subtask 10** — Implement `rolebox memory` CLI subcommands:
- `src/cli/commands/memory.ts` with `list`, `show`, `search`, `delete`, `export`, `clean`, `stats`
- Register subcommand in the main CLI entrypoint

### Phase 6: Testing

**Subtask 11** — `tests/memory/store.test.ts`:
- CRUD operations (write, read, update, delete)
- FTS5 search ranking and filtering
- Touch and access_count tracking
- List with scope, category, sort filters
- Capacity eviction (max entries enforcement)
- Concurrent read/write stability

**Subtask 12** — `tests/memory/tools.test.ts`:
- All 4 tools with mock `MemoryStore`
- Happy path for each tool
- Edge cases: empty results, missing IDs, duplicate writes
- Schema validation (title empty, category invalid, etc.)

**Subtask 13** — Injection test and regression test:
- Verify `<available_memory>` block format via `buildMemoryBlock()`
- Verify `handleSystemTransform` injection with mocked store
- Ensure existing tests (`bun test`) pass with zero regressions

### Phase 7: Verification

**Subtask 14** — Full verification pass:
- `bun test tests/memory/` passes all suites
- `tsc --noEmit` passes with zero errors
- `bun test` (full test suite) passes with no regressions
- Manual validation: memory written via tool is persisted, retrieved, searchable

---

## 12. Dependency Graph

```
[1] state-paths ──────────────────────────────┐
                                               │
[3] types ─────────────────────────────────────┤
                                               │
[2] store.ts ────────────────────────────────┐ │
 ├── [4] tools.ts ───────┐                   │ │
 └── [6] prompt-builder  │                   │ │
                         │                   │ │
[5] WIRING (plugin-hooks)┤ ←── [4]           │ │
                         │                   │ │
[7] system-transform ────┤ ←── [6] + [8] deps│ │
[8] deps ────────────────┘                   │ │
                                             │ │
[9] functions/memory.md ─────────────────────┘ │
                                               │
[10] CLI ─────────────────────────────────────┐ │
                                              │ │
[11] store.test ──────────────────────────────┤─[2]
[12] tools.test ──────────────────────────────┤─[4]
[13] injection regression ────────────────────┤─[7]
                                              │
[14] VERIFY ──────────────────────────────────┘ (all tests + tsc)
```

**Critical path:** [3] → [2] → [4] → [5] → [13] → [14] (6 steps)
**Max parallelism:** Subtasks 1 and 3 run in parallel; Subtasks 6 and 7 have dependency via [8], run after phase 2; Subtasks 11-13 run in parallel.

---

## 13. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| SQLite WAL contention with high-concurrency dispatch | Medium | WAL mode handles concurrent reads without blocking; writes are serialized but memory writes are low-frequency (one per meaningful event, not per tool call) |
| Memory injection bloating system prompt | Medium | Only inject summaries (id + title + category + relevance), not full content; configurable `max_inject` (default 10) and `min_relevance` (default `medium`) limits injection size |
| Memory DB file not in `.gitignore` | Low | `.rolebox/` is already gitignored (verify in existing `.gitignore`); document this explicitly in README |
| FTS5 availability in bun:sqlite | Low | Bun bundles SQLite with FTS5 enabled by default; verify in tests with a smoke test (`CREATE VIRTUAL TABLE test_fts USING fts5(content)`) |
| Memory write by untrusted subagent | Low | All writes go through the tool layer with Zod schema validation; `scope` field prevents cross-role pollution (role-private cannot be read by another role) |
| `\|memory\|` function reading large number of sessions | Medium | Incremental mode by default (skip sessions already in `source_sessions` of existing memories); `session_read` has pagination via the `limit` parameter |
| Memory tool name collision with other plugins | Low | Namespaced names (`memory_write`, `memory_recall`, etc.); rolebox runs as a single plugin so internal collision is the only risk, and these names are unique within rolebox |
| Schema migration for future updates | Low | Use `PRAGMA user_version` to track schema version; add migration logic in `ensureSchema()` to handle forward-compatible changes |

---

## 14. Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ROLEBOX_MEMORY_MAX_ENTRIES` | Max memories per scope (workspace + each role) | 500 |
| `ROLEBOX_MEMORY_DB_PATH` | Override memory.db path (for testing, alternative locations) | (auto from workspace via `memoryDbPath`) |

---

## 15. Acceptance Criteria

1. **4 memory tools** registered in `src/plugin-hooks.ts`: `memory_write`, `memory_recall`, `memory_list`, `memory_update`
2. **`\|memory\|` function file** exists at `functions/memory.md` with correct frontmatter and consolidation instructions
3. **`<available_memory>` block** injected at session start when `memory.inject !== false`, using `buildMemoryBlock()` in `src/prompt-builder.ts`
4. **`tsc --noEmit`** passes with zero errors
5. **`bun test tests/memory/`** passes (store.test.ts + tools.test.ts, minimum 20+ test cases)
6. **SQLite DB** created at `.rolebox/memory.db` with correct schema (WAL mode, FTS5, indexes, triggers)
7. **FTS5 search** returns ranked results ordered by relevance
8. **`rolebox memory`** CLI subcommands work: list, show, search, delete, export, clean, stats
9. **Memory config** parsed from `role.yaml` with correct defaults (`inject: true`, `max_inject: 10`, `min_relevance: medium`, `scope: both`)
10. **No regression** in existing tests: `bun test tests/dispatch/`, `bun test tests/session/`, `bun test tests/plugin-hooks.test.ts` all pass
11. **MemoryStore** uses the same logging pattern: `import { createSubLogger } from "../logger.ts"; const log = createSubLogger("memory:store");`
12. **`memoryDbPath(dir)`** function added to `src/state-paths.ts` for single-source-of-truth path derivation
