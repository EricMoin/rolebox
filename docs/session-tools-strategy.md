# Session Tools Suite — Implementation Strategy

**Date:** 2026-07-03
**Target:** rolebox v0.17.0
**Objective:** Implement a 10-tool session management suite comprising 4 parity tools (matching omo capabilities) and 6 new tools (exceeding omo), with full unit-test coverage.

---

## 1. Architecture Overview

### 1.1 File Structure

```
src/session/
  types.ts          — Internal types (SessionLinkRecord, AnalyticsResult, etc.)
  tools.ts          — All 10 tool creation functions (tool creators)
  analytics.ts      — Analytics computation engine (pure, no I/O)
  export.ts         — Markdown/JSON session export formatting
  search.ts         — Text search utility across SessionMessage arrays
  linking.ts        — Session-task link persistence (state file)

tests/session/
  tools.test.ts     — Unit tests for all 10 tools (mock client)
  analytics.test.ts — Unit tests for analytics computation
  export.test.ts    — Unit tests for export formatting
  search.test.ts    — Unit tests for text search
  linking.test.ts   — Unit tests for link persistence
```

### 1.2 Integration Point

In `src/plugin-hooks.ts`, add to the `tool:` object alongside dispatch tools:

```typescript
import {
  createSessionListTool, createSessionReadTool, createSessionSearchTool,
  createSessionInfoTool, createSessionAnalyticsTool, createSessionExportTool,
  createSessionTagTool, createSessionResumeTool, createSessionTimelineTool,
  createSessionLinkTool,
} from "./session/tools.ts";

// Inside createPluginHooks:
return {
  tool: {
    // ... existing dispatch tools ...
    session_list: createSessionListTool(client),
    session_read: createSessionReadTool(client),
    session_search: createSessionSearchTool(client),
    session_info: createSessionInfoTool(client),
    session_analytics: createSessionAnalyticsTool(client),
    session_export: createSessionExportTool(client),
    session_tag: createSessionTagTool(client),
    session_resume: createSessionResumeTool(client),
    session_timeline: createSessionTimelineTool(client),
    session_link: createSessionLinkTool(deps),  // needs HookDeps
  },
};
```

**No changes to `HookDeps` needed** — `client` and `dispatchManager` are already present. Only `session_link` requires `deps` (all others take only `client`).

### 1.3 Tool Creation Pattern

All tools follow the existing pattern from `src/dispatch/tools.ts`:

```typescript
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

export function createMyTool(client: PluginInput["client"]) {
  return tool({
    description: "...",
    args: {
      param: z.string().describe("..."),
      optional: z.number().int().min(1).optional().describe("..."),
    },
    async execute(input, context) {
      // context provides: sessionID, messageID, agent, directory, worktree, abort
      // Use context.directory for client call `directory` parameter
      // Return string
    },
  });
}
```

### 1.4 Critical: SDK v2 API Call Pattern

The opencode v2 SDK uses **flat parameter objects** and returns a `RequestResult` envelope. **Every client call must follow this pattern:**

```typescript
// ✅ CORRECT — flat params
const result = await client.session.get({
  sessionID: input.session_id,
  directory: context.directory,   // always include for project scoping
});

// ✅ CORRECT — unwrap the RequestResult envelope
function unwrap<T>(result: { data?: T; error?: unknown }, label: string): T | null {
  if (result.error) {
    log.warn(`API error: ${label}`, { error: result.error });
    return null;
  }
  if (!result.data) {
    log.warn(`No data from: ${label}`);
    return null;
  }
  return result.data as T;
}

// ✅ CORRECT usage pattern in every tool:
const sessionResult = await client.session.get({ sessionID: sid, directory: context.directory });
const session = unwrap(sessionResult, "session.get");
if (!session) return `Error: Could not fetch session ${sid}.`;
```

**Key SDK method signatures (v2):**

| Method | Signature | Returns env status |
|---|---|---|
| `client.session.list({ directory?, search?, limit? })` | flat params | `{ data: { 200: Array<Session> } }` |
| `client.session.get({ sessionID, directory? })` | flat params | `{ data: { 200: Session } }` |
| `client.session.messages({ sessionID, directory?, limit? })` | flat params | `{ data: { 200: { items: Array<SessionMessage> } } }` |
| `client.session.todo({ sessionID, directory? })` | flat params | `{ data: { 200: Array<Todo> } }` |
| `client.session.children({ sessionID, directory? })` | flat params | `{ data: { 200: Array<Session> } }` |
| `client.session.create({ title?, parentID?, agent?, model?, metadata? })` | flat params | `{ data: { 200: Session } }` |
| `client.session.update({ sessionID, title?, metadata? })` | flat params | `{ data: { 200: Session } }` |
| `client.experimental.session.list({ directory?, archived?, limit? })` | flat params | `{ data: { 200: Array<GlobalSession> } }` |

### 1.5 Conflict Strategy with omo

The 4 parity tools use the **same names** as omo's tools: `session_list`, `session_read`, `session_search`, `session_info`. Rolebox already coexists with omo (per README). Each tool's description signals superiority:
- `session_list`: "List sessions with filtering, tokens, cost, and model info. More detailed than basic session listing tools."
- `session_read`: "Read session messages with type filtering, pagination, and expanded tool calls."
- etc.

### 1.6 Logging

All modules use the existing pattern:
```typescript
import { createSubLogger } from "../logger.ts";
const log = createSubLogger("session-tools");  // or "session-links", "session-export", etc.
```

---

## 2. Internal Types (`src/session/types.ts`)

```typescript
export interface SessionLinkRecord {
  taskId: string;
  sessionId: string;
  createdAt: string;  // ISO 8601
}

export interface AnalyticsResult {
  sessions: number;
  dateRange: { earliest: string; latest: string };
  tokens: { total: number; input: number; output: number; reasoning: number };
  cost: number;
  toolDistribution: Record<string, number>;      // tool name → call count
  modelBreakdown: Record<string, number>;         // model ID → session count
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

export interface TimelineBucket {
  time: string;       // ISO bucket label
  count: number;
  tokens: number;
  cost: number;
}

export interface SearchMatch {
  sessionId: string;
  sessionTitle: string;
  matchText: string;           // the matched line
  contextBefore: string[];     // ±N messages around match
  contextAfter: string[];
}

export type ExportFormat = "markdown" | "json";

export interface TagResult {
  tags: string[];
}
```

---

## 3. Tool Specifications

### 3.1 `session_list` — List Sessions (Parity, Enhanced)

**Zod args:**
```typescript
{
  project_path: z.string().optional().describe("Filter by project directory"),
  from_date: z.string().optional().describe("ISO 8601 — filter sessions from this date"),
  to_date: z.string().optional().describe("ISO 8601 — filter sessions until this date"),
  agent: z.string().optional().describe("Filter by agent name"),
  search: z.string().optional().describe("Search in session titles"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  include_archived: z.boolean().optional().describe("Include archived sessions"),
  include_message_count: z.boolean().optional().default(false).describe("Fetch message counts (slower)"),
}
```

**Execute:** Call `client.session.list({ directory: context.directory, search: input.search, limit: input.limit })`. If `include_archived`, also call `client.experimental.session.list({ archived: true, limit: input.limit })`. Filter client-side by `from_date`/`to_date` (compare against `time.updated`), and by `agent`. If `include_message_count` is true, fetch messages for each session in parallel (capped at 20 concurrent) to get message counts. Format output as table:

```
| Session ID | Title | Agent | Model | Msgs | Created | Updated | Tokens In | Tokens Out | Cost |
```
Omit the Msgs column unless `include_message_count` is true. Use "N/A" for missing token/cost fields.

**Exceeds omo:** Richer columns (tokens, cost, model), cross-project archived support, optional message counts.

### 3.2 `session_read` — Read Session Messages (Parity, Enhanced)

**Zod args:**
```typescript
{
  session_id: z.string().describe("Session ID to read"),
  include_todos: z.boolean().optional().default(false).describe("Include todo list"),
  include_transcript: z.boolean().optional().default(false).describe("Include child session list"),
  limit: z.number().int().min(1).max(200).optional().describe("Max messages to return"),
  message_type: z.enum(["user","assistant","tool","all"]).optional().default("all"),
  offset: z.number().int().min(0).optional().default(0).describe("Skip first N messages"),
}
```

**Execute:** Call `client.session.get({ sessionID: input.session_id, directory: context.directory })` for metadata. Call `client.session.messages({ sessionID: input.session_id, directory: context.directory, limit: input.limit })` for messages — unwrap `result.data[200].items`. Filter by `message_type` (user/assistant/tool/all), apply offset/limit pagination. Render tool calls expanded with args/result (truncated to 2000 chars). Conditionally fetch `client.session.todo()` and `client.session.children()`.

**Format:**
```
## Session: {title} ({session_id})
Agent: {agent} | Model: {model.id} | Created: {time.created}
---
[{timestamp}] user: {text}
[{timestamp}] assistant: {text}
  [{timestamp}] → tool: {toolName}
    args: {JSON}
    result: {truncated}
```

**Exceeds omo:** message_type filter, offset/limit pagination, tool call expansion.

### 3.3 `session_search` — Search Sessions (Parity, Enhanced)

**Zod args:**
```typescript
{
  query: z.string().min(1).describe("Search query"),
  session_id: z.string().optional().describe("Limit to specific session"),
  case_sensitive: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(50).default(20).describe("Max results"),
  include_context: z.boolean().optional().default(true).describe("Include ±2 surrounding messages"),
}
```

**Execute:** If `session_id` provided, fetch that one session's messages. Otherwise, fetch `client.session.list({ limit: 50, directory: context.directory })`, then fetch messages for each in parallel (capped at 10 concurrent). Call `searchMessages()` utility (from `src/session/search.ts`). Sort results by session recency. If `include_context`, include ±2 surrounding messages.

**Format:**
```
## Search Results for: "{query}"
---
### Session: {title} ({id})
  [{timestamp}] {role}: ...**{matched}**...
    context: ...
```

**Exceeds omo:** Cross-session search, context window around matches.

### 3.4 `session_info` — Session Metadata (Parity, Enhanced)

**Zod args:**
```typescript
{
  session_id: z.string().describe("Session ID"),
  include_todos: z.boolean().optional().default(true),
  include_messages: z.boolean().optional().default(false),
}
```

**Execute:** Call `client.session.get({ sessionID: input.session_id, directory: context.directory })`. Conditionally `client.session.todo()` and `client.session.children()`. If `include_messages`: fetch first message.

**Format:** Detailed metadata block with token breakdown, cost, share URL, parent, file changes, todo completion stats, child sessions table.

**Exceeds omo:** Token breakdown, cost, share URL, file changes, children table.

### 3.5 `session_analytics` — Analytics Dashboard (NEW)

**Zod args:**
```typescript
{
  session_id: z.string().optional().describe("Analyze specific session instead of all"),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  group_by: z.enum(["day","week","model","agent"]).optional().default("day"),
  format: z.enum(["summary","json"]).optional().default("summary"),
}
```

**Execute:** Fetch `client.session.list({ limit: 100, directory: context.directory })`. If `session_id` given, fetch that one session. Filter by `from_date`/`to_date` on `time.updated`. For message-level analytics, fetch messages for qualifying sessions in parallel — **capped at 20 sessions, batched in chunks of 5**. If more than 20 sessions qualify, sample the 20 most recent and warn: `"Analyzing {total} sessions. Message-level data limited to 20 most recent."`. Call `computeAnalytics()` (from `src/session/analytics.ts`). Return summary report or JSON.

**Exceeds omo:** Token trends, tool call distribution, model usage breakdown, time-bucketed views.

### 3.6 `session_export` — Export Session (NEW)

**Zod args:**
```typescript
{
  session_id: z.string().describe("Session ID to export"),
  format: z.enum(["markdown","json"]).optional().default("markdown"),
  include_todos: z.boolean().optional().default(true),
  include_transcript: z.boolean().optional().default(true),
  output_path: z.string().optional().describe("File path relative to project root"),
}
```

**Execute:** Fetch `client.session.get()`, `client.session.messages()`, conditionally `client.session.todo()` and `client.session.children()`. Call `formatSessionMarkdown()` or `formatSessionJson()` from `src/session/export.ts`. If `output_path` provided: resolve against `context.worktree`, write atomically (`.tmp` + `renameSync`), return confirmation. Otherwise return formatted string inline.

**Exceeds omo:** Not available in omo. Enables offline viewing, sharing, archiving.

### 3.7 `session_tag` — Tag/Bookmark Sessions (NEW)

**Zod args:**
```typescript
{
  session_id: z.string().describe("Session ID"),
  tags: z.array(z.string().max(100)).optional().describe("Tags to add"),
  list: z.boolean().optional().default(false).describe("List current tags"),
  remove: z.array(z.string()).optional().describe("Tags to remove"),
}
```

**Execute:** Fetch `client.session.get({ sessionID: input.session_id, directory: context.directory })` to read current `metadata.rolebox_tags` (JSON string array). If `list === true`: return current tags. If `tags` provided: merge (deduplicate), persist via `client.session.update({ sessionID: input.session_id, metadata: { rolebox_tags: mergedTags } })`. If `remove` provided: filter out, persist.

**Persistence:** Uses opencode's built-in session `metadata` field with the namespaced key `rolebox_tags`. No custom state file needed.

**Exceeds omo:** Not available in omo.

### 3.8 `session_resume` — Resume Context from Previous Session (NEW)

**Zod args:**
```typescript
{
  session_id: z.string().describe("Source session to resume from"),
  agent: z.string().optional().describe("Agent for the new session"),
  include_summary: z.boolean().optional().default(true),
}
```

**Execute:** Fetch source session via `client.session.get()` and `client.session.messages()`. Extract last 3 assistant messages for context. Create new session via `client.session.create({ parentID: input.session_id, title: "Resume: ${sourceTitle}", agent: input.agent })`. If `include_summary` and source has a `summary` object, store summary in `metadata.resume_context`. Do NOT call `promptAsync` — just create and return the ID. The calling agent sends the first message naturally.

```
Resumed session created.
Source: {source_session_id}
New session: {new_session_id}
```

**Exceeds omo:** Not available in omo. Enables continuity across sessions.

### 3.9 `session_timeline` — Activity Timeline (NEW)

**Zod args:**
```typescript
{
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  group_by: z.enum(["day","hour","week"]).optional().default("day"),
  project_path: z.string().optional(),
}
```

**Execute:** Fetch `client.session.list({ limit: 200, directory: context.directory })`. Filter by `from_date`/`to_date` on `time.created`. Group into time buckets (ISO hour/day/week labels). Build activity matrix: count sessions, sum tokens, sum cost per bucket. Format as Markdown table. If fewer than 2 buckets: return `"Not enough sessions in range to build timeline."`.

**Exceeds omo:** Not available in omo. Visualizes session patterns over time.

### 3.10 `session_link` — Link Dispatch Tasks to Sessions (NEW)

**Zod args:**
```typescript
{
  task_id: z.string().optional().describe("Dispatch task ID"),
  session_id: z.string().optional().describe("Session ID to link"),
  list_linked: z.boolean().optional().default(false).describe("List all links"),
}
```

**Execute (3 modes):**
1. `list_linked`: Call `listAllLinks(deps.dir)`, format as table.
2. `task_id` only: Verify task exists via `deps.dispatchManager.getTask()`, then `getLinksForTask()`.
3. Both `task_id` and `session_id`: `saveLink()` with confirmation.

Require at least one of `task_id` or `list_linked` (Zod `.refine()`).

**Persistence:** `.rolebox/state/session-links.json` using atomic write pattern (write to `.tmp`, then `renameSync`). See §4.2.

**Tool signature:** Takes `HookDeps` (not just `client`) because it needs `dispatchManager` and `dir`.

**Exceeds omo:** Not available in omo. Bridges rolebox's dispatch and session domains.

---

## 4. State Management

### 4.1 Session Tag Persistence

Uses opencode's built-in `client.session.update()` with `metadata.rolebox_tags` (JSON string array). Key is namespaced (`rolebox_tags`) to avoid collision. No custom persistence file needed.

```typescript
await client.session.update({
  sessionID: sessionId,
  metadata: { rolebox_tags: ["important", "review-later"] },
});
```

### 4.2 Session-Task Link Persistence (`src/session/linking.ts`)

```typescript
// State file: .rolebox/state/session-links.json
// Format: SessionLinkRecord[]

export function saveLink(taskId: string, sessionId: string, linkDir: string): void;
export function removeLink(taskId: string, linkDir: string): void;
export function getLinksForTask(taskId: string, linkDir: string): SessionLinkRecord[];
export function getLinksForSession(sessionId: string, linkDir: string): SessionLinkRecord[];
export function listAllLinks(linkDir: string): SessionLinkRecord[];
```

**Persistence pattern** (same as `src/dispatch/task-store.ts`):
1. Read existing data from file (or start with `[]` if file doesn't exist)
2. Mutate in-memory
3. Write atomically: `writeFileSync(tmpPath, json); renameSync(tmpPath, targetPath)`

Uses `stateDirFor(dir)` from `src/state-paths.ts` for directory resolution.

### 4.3 No Other Custom State

All other tools (search, analytics, export, timeline) are stateless — they fetch data on demand and return formatted results.

---

## 5. Utility Specifications

### 5.1 `src/session/search.ts`

```typescript
export function searchMessages(
  sessionId: string,
  sessionTitle: string,
  messages: SessionMessage[],
  query: string,
  caseSensitive: boolean,
): SearchMatch[];
```

Searches `SessionMessageUser` (text field) and `SessionMessageAssistant` (content parts with `type: "text"`). Excludes shell output, synthetic, compaction, and agent/model-switched messages. Returns matches with session metadata, matched text, and context window.

### 5.2 `src/session/analytics.ts`

```typescript
export function computeAnalytics(
  sessions: Session[],
  messagesBySession: Map<string, SessionMessage[]>,
): AnalyticsResult;
```

Pure synchronous function — no I/O. Computes: token totals (from `Session.tokens` and `SessionMessageAssistant.tokens`), cost aggregation, tool call frequency (count `type: "tool"` content parts), model usage breakdown, duration stats (from `time.created` to `time.updated`). Handles empty input gracefully (returns zeroes).

### 5.3 `src/session/export.ts`

```typescript
export function formatSessionMarkdown(
  session: Session,
  messages: SessionMessage[],
  todos?: Todo[],
  children?: Session[],
): string;

export function formatSessionJson(
  session: Session,
  messages: SessionMessage[],
  todos?: Todo[],
  children?: Session[],
): string;
```

Markdown format: `# {title}` header, metadata block, `## Messages` section with timestamped entries, tool calls in fenced code blocks. JSON: standard `JSON.stringify` with all data.

---

## 6. Implementation Plan (22 Subtasks)

### Phase 1: Scaffolding
**Subtask 1** — Create `src/session/` directory, `types.ts`, and a barrel `tools.ts` with empty exports.

### Phase 2: Utilities (parallel-ready)
**Subtask 2** — Implement `src/session/linking.ts` (link persistence store).
**Subtask 3** — Implement `src/session/search.ts` (text search over SessionMessages).
**Subtask 4** — Implement `src/session/analytics.ts` (analytics computation).
**Subtask 5** — Implement `src/session/export.ts` (markdown/JSON formatting).

### Phase 3: Tools (parallel-ready)
**Subtask 6** — `createSessionListTool` (parity, enhanced).
**Subtask 7** — `createSessionReadTool` (parity, enhanced).
**Subtask 8** — `createSessionSearchTool` (parity, enhanced) — depends on Subtask 3.
**Subtask 9** — `createSessionInfoTool` (parity, enhanced).
**Subtask 10** — `createSessionAnalyticsTool` (new) — depends on Subtask 4.
**Subtask 11** — `createSessionExportTool` (new) — depends on Subtask 5.
**Subtask 12** — `createSessionTagTool` (new).
**Subtask 13** — `createSessionResumeTool` (new).
**Subtask 14** — `createSessionTimelineTool` (new).
**Subtask 15** — `createSessionLinkTool` (new) — depends on Subtask 2.

### Phase 4: Integration
**Subtask 16** — Wire all 10 tools into `src/plugin-hooks.ts`.

### Phase 5: Testing
**Subtask 17** — `tests/session/tools.test.ts` (integration tests for all tools, mock client).
**Subtask 18** — `tests/session/analytics.test.ts`.
**Subtask 19** — `tests/session/export.test.ts`.
**Subtask 20** — `tests/session/search.test.ts`.
**Subtask 21** — `tests/session/linking.test.ts`.

### Phase 6: Verification
**Subtask 22** — Full test suite run (`bun test tests/session/`), `tsc --noEmit`, regression check on existing tests.

---

## 7. Dependency Graph

```
[1] Scaffolding
 ├── [2] linking ──────────────────────────────┐
 ├── [3] search ──────────────────────────┐    │
 ├── [4] analytics ──────────────────┐    │    │
 └── [5] export ────────────────┐    │    │    │
                                │    │    │    │
 [6] list ──────────────────────┤    │    │    │
 [7] read ──────────────────────┤    │    │    │
 [8] search ────────────────────┤───[3]   │    │
 [9] info ──────────────────────┤    │    │    │
[10] analytics ─────────────────┤───[4]   │    │
[11] export ────────────────────┤───[5]   │    │
[12] tag ───────────────────────┤    │    │    │
[13] resume ────────────────────┤    │    │    │
[14] timeline ──────────────────┤    │    │    │
[15] link ──────────────────────┤────────┘───[2]
                                │
[16] WIRING ────────────────────┤ (all tools)
                                │
[17] tools.test ────────────────┤───[16]
[18] analytics.test ────────[4]─┤
[19] export.test ───────────[5]─┤
[20] search.test ───────────[3]─┤
[21] linking.test ──────────[2]─┤
                                │
[22] VERIFY ────────────────────┘ (all tests + tsc)
```

**Critical path:** [1] → [3] → [8] → [16] → [17] → [22] (6 steps)
**Max parallelism:** Subtasks 2-5 run in parallel; Subtasks 6-15 run in parallel (modulo utility deps).

---

## 8. Test Plan

### 8.1 Test Pattern
Following `tests/dispatch/tools.test.ts`: Use `bun:test` (`describe`, `it`, `expect`, `mock`), mock `OpencodeClient` stubs for all session methods, test each tool for happy path, empty results, error handling, edge cases.

### 8.2 Mock Client Factory
```typescript
function makeMockClient(overrides?: Partial<Record<string, Function>>): OpencodeClient {
  return {
    session: {
      list: mock(() => Promise.resolve({ data: { 200: [...sessions] } })),
      get: mock(() => Promise.resolve({ data: { 200: makeSession() } })),
      messages: mock(() => Promise.resolve({ data: { 200: { items: [...messages] } } })),
      todo: mock(() => Promise.resolve({ data: { 200: [...todos] } })),
      children: mock(() => Promise.resolve({ data: { 200: [...children] } })),
      create: mock(() => Promise.resolve({ data: { 200: makeSession() } })),
      update: mock(() => Promise.resolve({ data: { 200: makeSession() } })),
      ...overrides,
    },
    experimental: {
      session: {
        list: mock(() => Promise.resolve({ data: { 200: [...globalSessions] } })),
      },
    },
  } as unknown as OpencodeClient;
}
```

### 8.3 Minimum Test Cases per Tool
- **session_list:** basic list, date filtering, agent filtering, empty results, include_archived, include_message_count
- **session_read:** full transcript, user-only filter, pagination offset/limit, todo inclusion, tool call expansion
- **session_search:** single-session search, cross-session search, case sensitivity, context inclusion, no results
- **session_info:** full metadata, no todos, no children, archived status
- **session_analytics:** summary format, JSON format, single session, empty input, sampling warning
- **session_export:** markdown inline, JSON inline, file write, file write atomicity
- **session_tag:** list existing, add new (deduplicate), remove, reject long tags
- **session_resume:** successful resume, missing source session, no messages in source
- **session_timeline:** day grouping, hour grouping, week grouping, too few buckets
- **session_link:** list all, link task+session, unlink, invalid task, query by task, query by session

### 8.4 Utility Module Tests
- **analytics.test.ts:** empty input, single session, multi-session, tool distribution accuracy, model breakdown, duration stats, all-zero edge case
- **export.test.ts:** markdown structure, JSON validity, tool call rendering, special characters, todos/children rendering
- **search.test.ts:** user message match, assistant message match, case sensitivity, non-text message skipping, multi-match, empty results
- **linking.test.ts:** save/read roundtrip, remove, atomicity (no .tmp), corrupted JSON handling, filtering by task/session, empty store

---

## 9. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Tool name collision with omo | Medium | Same names but richer descriptions; rolebox already coexists with omo per README |
| SDK API changes between opencode versions | Medium | Pin peer dependency `@opencode-ai/plugin@^1.3.0`; wrap all client calls in error-unwrapping pattern |
| Large session message volume causing memory pressure | Low | Cap parallel fetches (20 sessions, batched 5 at a time); paginate with limit params |
| `metadata.rolebox_tags` conflict with other plugins | Low | Namespaced key; other plugins unlikely to use same key |
| `experimental.session.list` API deprecation | Low | Use `include_archived` as an optional flag; if the endpoint changes, fall back to v1 session.list with archived check |
| session_resume parentID conflicts | Low | parentID is optional — new session is standalone even if parent is deleted |

---

## 10. Environment Variables

None required. All configuration is via tool parameters.

---

## 11. Acceptance Criteria

1. All 10 tools registered as `plugin.tool` hooks in `src/plugin-hooks.ts`
2. `tsc --noEmit` passes with zero errors
3. `bun test tests/session/` passes all 5 test files (minimum 40+ test cases)
4. `bun test tests/dispatch/` and `bun test tests/plugin-hooks.test.ts` pass with no regressions
5. All client API calls use correct v2 flat parameter signatures with `directory: context.directory`
6. All client API calls unwrap the `RequestResult` envelope with error handling
7. `session_link` tool uses `HookDeps`; all other 9 tools use only `PluginInput["client"]`
8. Atomic file writes use `.tmp` + `renameSync` pattern
9. Logger sub-loggers created for each module
