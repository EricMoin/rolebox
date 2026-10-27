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
  session_focus: true
  recall: true
```

| Field | Default | Meaning |
| --- | --- | --- |
| `inject` | `true` | Include available memory summaries in the system prompt. |
| `max_inject` | `10` | Maximum summaries, from `0` to `100`. |
| `min_relevance` | `medium` | Minimum relevance: `low`, `medium`, or `high`. |
| `scope` | `both` | Summaries from `workspace`, the current `role`, or `both`. |
| `session_focus` | `true` | Keep and inject the agent-curated session-focus entry across dsh compaction (DSH only). |
| `recall` | `true` | Inject the per-turn relevant-memory block built from the latest DSH user prompt (DSH only). |

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

DSH graph workers inherit the parent's authorized memory tools and expose their
native schemas by default. Node `tools` lists no longer restrict access. Memory
operations still follow the role's memory configuration, visibility rules and
host permissions. Use role or host policy when memory writes must be disabled.

For DSH nodes using `toolPresentation.mode: "discover"`, the workflow directs the worker to describe a capability with `graph_worker_tools` and invoke it through that tool's `call` action. In `code` mode, it describes schemas first and invokes capabilities through `graph_worker_code`. The guidance names only memory capabilities the worker is authorized to use.

## Session focus across compaction (DSH)

dsh keeps a long session inside the model's window by replacing older surface history with one model-written summary — automatically when a routed request approaches the window, or on demand through `/compact`. Rolebox never stores that summary: it stays in the session log and the live surface, and it is never copied into memory or the prompt.

Instead, each DSH session keeps **one rolling memory entry the agent curates**. This is the deliberate working-state entry — not a transcript — and it holds only what a continuing agent needs:

- **Title** — `Session focus — <session short>` (the first eight characters of the session id after its `session-` prefix — the prefix alone would make every title read `Session focus — session-`).
- **Tags** — `session-focus`.
- **Category / relevance** — `note` / `high`.
- **Scope** — `role` with the active role's id when a role is active; otherwise `workspace` with `role_id: shared`, visible to every role in the workspace.
- **Content** — the current goal; key facts and decisions; constraints and preferences; what needs attention now; open threads. Concise, with no summary and no transcript.

The next prompt assembly carries a bounded `## Session focus` block with that entry's current content (capped by code point, with longer content marked as truncated), its id, and the `memory_update` tool the session actually holds (the renamed name when a tool collision changed it) — so the model knows exactly which entry to revise. When the session compacts after the entry was last updated, the block asks the agent to refresh the entry before continuing: keep what is still true, add what the compacted context still requires, drop resolved items, and never paste the summary or the transcript. Otherwise it asks for an update only when the goal, constraints or items needing attention change. A role that cannot update still sees the entry's content, without the instruction.

With no entry yet, the block states the create recipe instead: `memory_write` with title `Session focus — <short>` (the session id's first eight characters after `session-`, so the title identifies the session), tags `["session-focus"]`, category `note`, relevance `high`, scope `role` when a role is active and `workspace` otherwise, and the content sections above. After a compaction it is phrased as an urgent instruction to write the entry before continuing; otherwise as a standing convention. An entry whose content is blank is treated as one to fill: the block names its id and the `memory_update` call instead of asking for a duplicate.

Writing and updating are permission-gated, and the block never bypasses them: the create recipe appears only when `memory_write` is authorized by the role's `tools` map and registered in the session, and the update instruction only when `memory_update` is. Displaying the block needs neither `memory_read` nor any write — rolebox reads the store in-process — so a session allowed only to read memory still sees its focus entry. A session without an absolute workspace is skipped, and DSH graph-worker sessions are skipped: their continuity comes from the dispatch prompt and their grants, not the role's memory policy.

Everything is fail-soft: a store failure, a missing session or an unreadable event log renders no block and never fails the prompt assembly. No memory is written automatically; only the agent writes or updates the entry.

Use `session_focus: false` to opt out for a role:

```yaml
memory:
  session_focus: false
```

## Turn recall (DSH)

A session-start memory table stops matching the work as the conversation moves on. On every turn, DSH assembles one more bounded block — `## Relevant memory` — from the entries that match the **message the turn is working on**. That prompt reaches recall directly: DSH's agent loop claims a step's user message out of the inbox *before* it appends it to the session log, so rolebox's `agent/pre-step` listener hands the same step's admitted message — its stable message id and text — to the recall provider, and the step's context refresh renders from it. This is what makes the first turn work, when the message is not logged yet, and what keeps later turns on the current prompt instead of the previous one; the session log's newest user-authored message is only the fallback for a render with no handoff, such as a session restored from disk. The handoff listener is registered even when the host exposes no LLM, because the handoff never depends on the query scout.

Recall runs inside prompt assembly, opens the workspace store, and searches with a query built from the user's own prompt. The query is not the whole message. A line labelled `Question:`, `Q:`, `Task:`, `Request:`, `问题:`, `任务:` or `请求:` supplies the text from the last such line through the end; otherwise a long prompt (more than 400 characters) whose final blank-line paragraph contains `?` or `？` supplies that paragraph; only when neither applies does the whole message count. The extracted text is tokenized with English function words (`this`, `the`, `what`, `are`, …) dropped, while domain words such as `memory`, `code` or an entity name stay, and the deduplicated list is capped at 24 terms with Han-script bigrams placed first so a Chinese entity is never starved by a Latin preamble. This is what keeps a long instruction prompt searchable: the budget used to fill with its first words (`this`, `is`, `a`, `controlled`, …), leaving the entities the question actually named — an English sentinel code and a Chinese `蓝鲸哨兵` value among them — never searched. The block injects the matching entries' **content**, not just their titles: each entry is listed as its title, its id, its scope and its relevance, followed by an indented excerpt of the content. The block also tells the agent to name an entry (title or id) whenever a retrieved memory changes what it does or says, so the user can see what was remembered. Only a message the user actually authored counts — injected runtime context, model selections, compaction checkpoints and rolebox notices never pose as a prompt — and a prompt that yields fewer than two search terms (or a search with no hits) produces no block. The block is capped in entries (three) and code points (3000), and each render is cached per session, prompt message and role, so the rest of one turn reuses it instead of reopening the store.

Recall uses the same role visibility as the tools: a role sees workspace entries plus its own role-scoped entries, and never another role's private ones. Entry content is read in-process, so the block needs no `memory_read`; when `memory_read` or `memory_recall` is both authorized for the role and registered in the session, the block names those real tool names in its read/search hint. A missing or relative workspace, a store failure and every other error render no block and never fail prompt assembly. No memory is written, and the block never duplicates the session-focus entry.

CJK search is fixed in the same index. FTS5's `unicode61` tokenizer treats a whole run of Han characters as one token, so `记忆机制` never matched `记忆机制需要保存关键点` and `压缩` never matched `上下文压缩后…`. The index now stores the original title, content and tags unchanged **plus** the deduplicated two-character bigrams of every Han run (a single-character run indexes as itself), and a Chinese query is rewritten to the same bigrams joined with `OR`. A two-character term therefore matches inside a longer phrase, while Latin, number and explicit FTS queries behave exactly as before. This affects `memory_recall` too, not only turn recall. The tool keeps its own contract: a query with no Han characters is still passed through byte-for-byte with its explicit FTS syntax intact, and the prompt extraction and function-word filtering above apply only to turn recall and its query scout.

DSH graph-worker sessions are skipped: their continuity comes from the dispatch prompt and their tool grant, not the role's memory policy. Use `recall: false` to opt out for a role:

```yaml
memory:
  recall: false
```

Turn recall has two tiers. The deterministic tier above always runs first. An optional one-shot LLM **query scout** can widen the search when the user's own words miss: it asks the step's own provider/model route for a small JSON object of three to six project concepts likely relevant to the prompt's extracted question (not its instruction preamble), then the recall provider searches with those queries too and merges the hits round-robin with the deterministic ones (deterministic first hit, then the scout hits, then the next deterministic hit, and so on). The model only returns search terms — it never sees a memory entry, and no memory is written.

`memory.recall_mode` controls the scout:

```yaml
memory:
  recall_mode: auto   # auto (default), always, or deterministic
```

- `auto` (default) scouts only when workspace memory is large — at least 20 stored entries — **and** the deterministic search is weak, finding fewer than two entries. The probe grades the same prompt-tuned query the deterministic tier searches with, so it measures the extracted question rather than the instruction preamble. Small workspaces and well-matched prompts stay deterministic-only, so the cost lands where the deterministic tier is most likely to miss.
- `always` scouts on every new human prompt.
- `deterministic` never scouts; turn recall stays exactly the lexical search described above.

The scout is one `llm.stream` call bound by a 3-second hard deadline and a 600-token output cap, sent to the step's own provider and model route. That route is resolved the way the host resolves it: the step's model selection when the installed host provides one, otherwise the session's last routed request header, otherwise the agent's creation options. A host that exposes none of them still gets the prompt handed to recall — only the scout is skipped. The scout runs on DSH's async `agent/pre-step` waterfall just before the step is admitted, and only when that step carries a new human prompt — later steps of a tool loop do not trigger it, and the extracted question is truncated before it is sent. The call is fail-open: a timeout, an abort, a provider error, invalid JSON or an empty query list yields no offer, and the turn continues with the deterministic block unchanged. A failed, timed-out or unparseable scout is logged with one closed, content-free reason (`timeout`, `aborted`, `stream-error`, `empty-stream`, `invalid-json` or `empty-queries`) alongside the session and prompt keys — never the prompt, the model's output or the queries — so a live miss is diagnosable while the deterministic recall continues. The offered queries apply to that exact admitted message only, are trimmed to short terms and capped at five, and the rendered block is still bounded and cached. The scout never changes the step's messages. Graph-worker sessions, DSH subagent sessions, roles with `recall: false` and roles with `recall_mode: deterministic` skip it entirely.

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
