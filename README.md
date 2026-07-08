<p align="center">
  <img alt="rolebox — Turn one AI coding assistant into a team of specialists — defined in YAML, no code." src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/banner.png" width="640">
</p>

# rolebox

<p align="center">
  An <a href="https://github.com/nicholasgriffintn/opencode">opencode</a> plugin that turns one AI coding assistant into a full team of specialists. Define roles, functions, skills, and collaboration graphs in YAML. Share them like packages. No code required.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rolebox"><img alt="npm" src="https://img.shields.io/npm/v/rolebox"></a>
  <a href="#"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/EricMoin/rolebox/ci.yml"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/EricMoin/rolebox"></a>
  <a href="#"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/EricMoin/rolebox"></a>
</p>

<br>

> **See it in action** — *placeholder for demo GIF showing multi-agent dispatch running in opencode with Emperor orchestrating a team of specialists.*

<br>

---

## Your AI Assistant Forgets Everything. rolebox Fixes That.

Every AI coding session starts from scratch. Your assistant doesn't remember yesterday's architecture decision, last week's bug fix, or the convention you established three sessions ago. You repeat yourself. It repeats mistakes. Progress slows.

**rolebox gives your AI a persistent memory.** Across sessions, across projects, your agents remember.

But memory is just the beginning. rolebox transforms a generic chat assistant into a precision tool: a full engineering team that lives in YAML, deploys in seconds, and remembers everything.

---

## What rolebox Gives You

### 🧠 Persistent Memory System

Your AI forgets nothing.

- **SQLite + FTS5** — full-text search across every stored decision, convention, and lesson
- **Workspace vs Role isolation** — share project knowledge across all agents, keep role-specific notes private
- **`|memory|` consolidation mode** — review past sessions, extract durable knowledge, deduplicate, and persist
- **Auto-injection** — relevant memories surface at session start as `<available_memory>`
- **CLI** — `rolebox memory list`, `search`, `export`, `stats`

```bash
# Review the last 5 sessions and persist new knowledge
# (use |memory| mode inside opencode)
# CLI query:
rolebox memory search "database migration strategy"
```

Real result: your architect role remembers the caching strategy it designed last month. No re-explaining. No repetition.

### 🔬 LSP Integration (30+ Tools)

Every language server tool your IDE has, now inside your AI assistant.

| Category | Tools |
|---|---|
| Navigation | go-to-definition, go-to-declaration, go-to-type-def, go-to-implementation, find-references |
| Diagnostics | lsp diagnostics (errors/warnings/hints per file or workspace-wide) |
| Code Actions | quick-fixes, refactorings, organize imports — apply by title |
| Completions | context-aware code completions with docs |
| Formatting | full-document or range format |
| Hover | type signatures, documentation, inline hints |
| Symbols | document symbols, workspace symbols, semantic tokens, folding ranges |
| Hierarchy | call hierarchy (incoming/outgoing), type hierarchy (super/sub types) |
| Inlay Hints | type hints, parameter name hints |
| Document Links | clickable URLs and cross-references |

No plugin per language. One system speaks to every LSP server. Automatic detection.

### ✂️ Hashline Editing — Edits That Never Drift

Line-number-based edits break when the file changes. rolebox uses **content-hash-anchored editing** instead:

- Every line tagged with a content hash — `LINE#HASH`
- Edits match by hash, not position. If the file changes between read and write, the edit targets the *content*, not the line.
- **Multi-edit batching** with snapshot semantics — all edits reference the original file state, applied bottom-up so indices always stay correct
- **SHA-256 version tracking** — detects external modifications before applying

```diff
- #10#aB  oldString      ← fragile, drifts on insert/delete
+ #10#aB|newString       ← hash-anchored, survives edits above
```

### 📬 Desktop Notifications

Never stare at a loading screen again.

- Native OS notifications when tasks complete
- **Idle detection** — only notify when you're away from your keyboard
- **Quiet hours** — scheduled silence (no 2 AM pings)
- **Configurable channels** — system toast, sound, webhook, file, log, or custom commands
- **Event-type filtering** — task complete, question asked, permission required, errors, loop complete
- **Smart throttling** — burst protection so you don't get spammed

```jsonc
// ~/.config/opencode/rolebox/notifications.jsonc (optional)
{
  "channels": { "system_toast": { "enabled": true } },
  "quiet_hours": { "start": "22:00", "end": "08:00" },
  "notify_on": ["dispatch_complete", "error"]
}
```

### 🔄 Session Management (10 Tools)

Your AI's entire work history, searchable and analyzable.

| Tool | What it does |
|---|---|
| `session_list` | List all sessions, filter by date range or project |
| `session_read` | Full transcript with model, cost, and token metadata |
| `session_search` | Full-text search across every message in every session |
| `session_info` | Token usage breakdown, cost, tool frequencies, model distribution |
| `session_diff` | Unified diff of all file changes in a session |
| `session_branch` / `fork` | Branch a session at any message — like git for conversations |
| `session_changes` | Full file change history per message |
| `session_inspect` | Comprehensive analytics dashboard |

### 🚀 Dispatch System

Run multiple agents in parallel. Track everything.

- **Background execution** with real concurrency control (model-pool semaphores)
- **Budget tracking** per request — token/cost limits enforced automatically
- **Task retry** with full context preservation — failed tasks resume where they left off, not from scratch
- **Task dependency graphs** — visualize parent-child dispatch trees
- **Chronology views** — time-bucketed activity by hour, day, or agent
- **Metrics & observability** — real-time counters, gauges, histograms
- **Watchdog** — stale task detection and orphan prevention
- **Result extraction** — structured artifact fences (` ```result `)

### ⚙️ Function State Machine

Functions aren't just injected prompts — they have lifecycle.

- **Phase-based activation** — `active`, `gated`, `dormant` states
- **Evidence observation** — functions track which verification tags are satisfied
- **Artifact tracking** — produced/consumed file status
- **Transition conditions** — state graphs with conditional activation
- **Continuation counting** — bounded retry loops

See [docs/functions.md](docs/functions.md) for the full spec.

### 🧩 Context Assembly

One tool to search everything: memory + assets + tasks + sessions.

- Cross-domain search across 4 knowledge stores
- Token-bounded context blocks — automatically truncated to fit budget
- Intelligent relevance ranking with priority boosting
- Configurable source selection (any combination of memory, assets, tasks, sessions)

### 📦 Asset Management

Roles, skills, functions, references — all hot-reloadable at runtime.

- **Hot-reload** — edit a skill or role YAML, reload without restart
- **Asset search** — find any skill, function, or reference by keyword across all roles
- **Asset inspect** — view complete frontmatter metadata for any asset
- **Asset validation** — dependency checking, broken reference paths, unknown conditions
- **Skill composition analysis** — detect conflicts and reference deduplication across skill combinations

```bash
rolebox status          # Check all roles and their status
rolebox info <name>     # Detailed role inspection
rolebox sync            # Sync installed roles with registry
rolebox monitor         # Live dispatch metrics dashboard (TUI)
```

---

## What rolebox Adds to opencode

| Capability | Raw opencode | + rolebox |
|---|---|---|
| **Persistent memory** | ❌ Sessions start blank | ✅ SQLite + FTS5, auto-inject past decisions |
| **Multi-agent teams** | ❌ Single agent | ✅ YAML-defined specialists, parallel dispatch |
| **LSP integration** | ❌ No language server access | ✅ 30+ tools (go-to-def, references, rename, diagnostics…) |
| **Hashline editing** | ❌ Line-number based | ✅ Content-hash anchored — edits never drift |
| **Desktop notifications** | ❌ None | ✅ Native OS, quiet hours, idle detection, throttling |
| **Session analytics** | ❌ Basic session list | ✅ 10 tools: search, export, fork, diff, inspect |
| **Background dispatch** | ❌ Sequential | ✅ Real concurrency with budget tracking |
| **Task dependency graphs** | ❌ Flat | ✅ Visualize parent-child dispatch trees |
| **Function state machine** | ❌ Static prompts | ✅ Phased lifecycle with evidence & transitions |
| **Context assembly** | ❌ Manual | ✅ Cross-domain search (memory + assets + tasks + sessions) |
| **Hot-reload assets** | ❌ Restart required | ✅ Edit YAML, reload instantly |
| **Asset validation** | ❌ None | ✅ Dependency & integrity checks |
| **Shareable role registry** | ❌ None | ✅ npm-style `rolebox install <name>` |
| **Orchestrator (Emperor)** | ❌ None | ✅ Plan → dispatch → validate → revise loop |

---

## Quick Start

```bash
cd ~/.config/opencode && npm install rolebox
```

Add to `opencode.jsonc`:

```jsonc
{
  "plugin": ["rolebox"]
}
```

**Create your first role in 30 seconds:**

```bash
rolebox init my-agent -y
```

A ready-to-use role directory lands in `~/.config/opencode/rolebox/my-agent/`. Restart opencode and pick it from your agent list.

**Install the Emperor orchestrator:**

```bash
rolebox install emperor
```

---

## ✨ Featured: Emperor — Your AI Engineering Lead

[Emperor](https://github.com/EricMoin/oh-my-role) is a top-level orchestrator that plans, delegates, and validates complex work across a team of specialist sub-agents — without writing any code itself.

```bash
rolebox install emperor
```

### How it works:

1. You describe what you need (in plain English)
2. Emperor **plans** the work (3-stage: draft → review → finalize)
3. **Dispatches** subtasks to specialists (`ui`, `backend`, `test`, `data`, `docs`, `quality`) in parallel where possible
4. **Validates** every result — closed-loop verification
5. **Revises** if needed — 2-round re-dispatch with correction budget
6. **Reports back** with a structured summary

### Architecture:

- **3-stage planner** — draft, review, finalize — catches plan flaws before execution
- **6 department workers** — `ui`, `backend`, `test`, `data`, `docs`, `quality`
- **Multi-subtask dependency scheduling** — parallelization where possible, sequential where not
- **Budget-bounded concurrency** — respects model pool limits automatically
- **Live risk gate** — destructive operations flagged for user approval

Emperor NEVER writes code. It reads, routes, and summarizes. Best for complex multi-step work, architecture decisions, refactoring, and anything that needs strategy before execution.

---

## Role Gallery

Pre-built roles available from the [oh-my-role registry](https://github.com/EricMoin/oh-my-role):

| Role | What it does |
|---|---|
| **emperor** | Top-level orchestrator — plans, delegates, validates complex work across a specialist team |
| **software-architect** | System design, trade-off analysis, ADRs, C4 models, and architecture reviews |
| **react-frontend** | React/Next.js component design, state management, and frontend architecture |
| **ai-designer** | AI application design with humane UX gates, interaction modeling, and design system creation |
| **tauri** | Desktop app development with Tauri v2 — IPC, plugins, window management, system tray |
| **dart-flutter** | Cross-platform mobile and desktop Flutter development with full gate review pipeline |

Install any role with `rolebox install <name>` and restart opencode.

---

## Full Feature Reference

| Topic | What | Docs |
|---|---|---|
| **Functions** | Composable behavior modules with state machine lifecycle. Activated with `\|name\|` syntax. | [docs/functions.md](docs/functions.md) |
| **Skills** | On-demand knowledge modules. Only load what you need, when you need it. | [docs/skills.md](docs/skills.md) |
| **References** | Deep-knowledge documents agents read for domain context. Auto-discovered. | [docs/references.md](docs/references.md) |
| **Subagents** | Child agents with their own prompts, skills, models. Dispatch via `dispatch()` tool. | [docs/subagents.md](docs/subagents.md) |
| **Collaboration Graph** | Workflow topologies (pipeline, review-loop, star) — rolebox routes automatically. | [docs/collaboration-graph.md](docs/collaboration-graph.md) |
| **Custom Hooks** | JavaScript modules that fire on chat, tool, and lifecycle events. Phase-aware. | [docs/hooks.md](docs/hooks.md) |
| **Extensions** | Open rolebox's closed vocabularies — custom conditions, topologies, recovery strategies. | [docs/extensions.md](docs/extensions.md) |
| **Memory Strategy** | How persistent memory works across sessions with FTS5 search. | [docs/memory-strategy.md](docs/memory-strategy.md) |
| **Session Tools** | Full session management tool reference with usage patterns. | [docs/session-tools-strategy.md](docs/session-tools-strategy.md) |
| **CLI** | Install, search, update, sync, monitor, manage roles. | [docs/cli.md](docs/cli.md) |
| **role.yaml Reference** | Full schema: model config, skills, functions, subagents, dispatch, hooks, permissions. | [docs/role-yaml.md](docs/role-yaml.md) |
| **Dispatch Config** | Concurrency, budgets, timeouts, queue depth — per-role or env vars. | [docs/dispatch-config.md](docs/dispatch-config.md) |
| **Registry** | Publish your own role registry on GitHub. Share with versioning and tags. | [docs/registry.md](docs/registry.md) |
| **Create a Role** | Hand-written role setup, directory structure, examples. | [docs/create-a-role.md](docs/create-a-role.md) |
| **Error Handling** | Invalid YAML, missing skills, missing functions — all fail gracefully. | [docs/error-handling.md](docs/error-handling.md) |
| **Limitations** | No role inheritance, no runtime switching, no cross-subagent communication. | [docs/limitations.md](docs/limitations.md) |
| **Compatibility** | Works alongside oh-my-openagent. No conflicts. | [docs/compatibility.md](docs/compatibility.md) |
| **Directory Structure** | Complete file layout reference. | [docs/directory-structure.md](docs/directory-structure.md) |

---

## Community & Contributing

- **Docs:** Full reference at [docs/](docs/)
- **Registry:** Browse roles at [oh-my-role](https://github.com/EricMoin/oh-my-role)
- **Discord:** *[add invite link]*
- **Issues & PRs:** Welcome. See the contributing guide for guidelines.

Build roles. Share them. Make your AI assistant work the way you do.

---

## License

MIT &mdash; see the [LICENSE](LICENSE) file.
