<p align="center">
  <img alt="rolebox" src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/banner.png" width="640">
</p>

# rolebox

<p align="center">
  An <a href="https://github.com/sst/opencode">opencode</a> plugin
  with persistent memory, multi-agent dispatch, LSP integration, and engineering-team workflows.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rolebox"><img alt="npm" src="https://img.shields.io/npm/v/rolebox"></a>
  <a href="https://github.com/EricMoin/rolebox/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/EricMoin/rolebox/ci.yml"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/EricMoin/rolebox"></a>
  <a href="https://github.com/EricMoin/rolebox"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/EricMoin/rolebox"></a>
  <a href="https://www.npmjs.com/package/rolebox"><img alt="npm downloads" src="https://img.shields.io/npm/dm/rolebox"></a>
</p>

<p align="center">
  <img alt="Emperor orchestrator planning, dispatching, and validating work across specialist sub-agents" src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/gifs/emperor-dispatch.gif" width="720">
</p>

<p align="center">
  <em>The Emperor orchestrator plans, dispatches to specialists, and validates the result — no code written by the orchestrator itself.</em>
</p>

---

> **Upgrading from 0.x.x?** rolebox 1.x replaced the 0.x execution model. In 0.x, workflows were declared in `role.yaml` (`collaboration:` block with built-in topologies like `pipeline`, `review-loop`, `star`) and routed automatically by the v1 graph machinery. In 1.x, workflows are **imperatively built and run on a graph execution engine** — you call `graph_create` → `graph_add_node` / `graph_add_edge` → `graph_run` and observe results with `graph_status`. The v1 collaboration auto-advance machinery was decommissioned (the legacy task-query surface survives as a thin `task_*` compatibility layer). See [Graph execution engine](#graph-execution-engine) and [docs/graph-legacy-v1-decommission.md](docs/graph-legacy-v1-decommission.md).

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

Create your first role:

```bash
rolebox init my-agent -y
```

A ready-to-use role directory is created in `~/.config/opencode/rolebox/my-agent/`. Restart opencode and pick the agent from your agent list.

To install the Emperor orchestrator:

```bash
rolebox install emperor
```

---

## Why rolebox

- **Persistent memory** — SQLite + FTS5 stores decisions, conventions, and lessons across sessions. Workspace-scoped or role-private. Relevant memories auto-inject at session start via `<available_memory>`.
- **Multi-agent dispatch** — define specialist roles in YAML and dispatch them in parallel with concurrency control and budget tracking. The Emperor orchestrator handles planning, delegation, validation, and revision across a team of sub-agents — without writing code.
- **LSP integration and hashline editing** — 30+ language server tools (go-to-definition, diagnostics, references, rename, completions) available inside your assistant. Content-hash-anchored editing replaces fragile line numbers so edits survive concurrent file changes.

---

## Graph execution engine

Introduced in 1.0, the graph execution engine is how rolebox now runs multi-agent workflows. Instead of a single orchestrator deciding who to dispatch to and when, you **build an explicit graph of nodes and edges** and the engine executes it: nodes are dispatched to sub-agents, edges carry results and signals between them, and the engine tracks budget, approval gates, and loop caps on every dispatch.

The engine is driven by an imperative toolset — `graph_create`, `graph_add_node`, `graph_add_edge`, `graph_add_loop`, `graph_run`, `graph_status`, `graph_cancel`, `graph_approve` — registered in `src/graph/tools/index.ts`. The underlying engine lives in `src/graph/engine/*` (see [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md)).

### Concepts

- **Nodes** — role-agnostic `{agent, prompt}` tuples. `graph_add_node` registers one worker node; structural validation is atomic (an invalid node is rejected without mutating the graph).
- **Edges** — directed edges define data flow and signal routing. Edge `type` is one of:
  - `always` — activate the target when the source completes,
  - `on_signal` — activate on a specific signal type (requires `signal_filter`, e.g. `["revise_needed"]`),
  - `on_condition` — activate when a named condition evaluates true (requires `condition`).
- **Loop groups** — `graph_add_loop` declares a bounded cycle of nodes with a hard `max_traversals` cap and optional soft termination conditions (`converged`, `stuck`, `result_matches`, `timeout_ms`, `signal`, …). Loops re-dispatch within the same engine state (`mode: "inherit"`); per-round session isolation is not supported — use a separate graph per round.
- **Approval gates** — a node with `needs_approval: true` pauses the graph at that node. The engine emits `[GRAPH BLOCKED]`; the human resolves it with `graph_approve(graph_id, node_id, action)` where `action` is `approve` (continue) or `reject` (re-enter the node with feedback when it belongs to a loop group, otherwise escalate).
- **Observability** — `graph_status` queries node, loop, or graph state: `format=tree` renders the node dependency tree, `scope=persisted` reads graphs hydrated from the on-disk engine-state store, `include_output` returns materialized node results, and `include_history` / `stream` surface loop rounds and signal events. Persisted state lives in `.rolebox/state/engine-*.json` plus an append-only `graph-events-*.ndjson` event log.

### Usage

`graph_run` is **non-blocking** — it dispatches ready root nodes and returns immediately with `phase`, `active_nodes`, and `pending_nodes`. End your turn after `graph_run`; the engine emits a `[GRAPH COMPLETE]` system-reminder when all nodes finish (or `[GRAPH BLOCKED]` when a node awaits approval). On the next turn, read results once via `graph_status(graph_id, include_output=true)`.

```text
1. graph_create(name="review-workflow")                 → { graph_id: "review-workflow", ... }
2. graph_add_node(graph_id="review-workflow", id="writer",
     agent="emperor--jinyiwei--ui", prompt="Build the component")
3. graph_add_node(graph_id="review-workflow", id="reviewer",
     agent="emperor--jinyiwei--test", prompt="Review the result")
4. graph_add_edge(graph_id="review-workflow",
     from="writer", to="reviewer", type="always")
5. graph_run(graph_id="review-workflow")                → non-blocking; end your turn
6. [GRAPH COMPLETE] system-reminder arrives
7. graph_status(graph_id="review-workflow", include_output=true)   → read results once
```

Loop groups and approval gates compose on top of the same node/edge model:

```text
graph_add_loop(graph_id="review-workflow", id="revise", nodes=["writer", "reviewer"],
  max_traversals=3, termination={ any_of: [{ signal: "revise_needed" }] })
graph_add_node(graph_id="review-workflow", id="finalize",
  agent="emperor--jinyiwei--docs", prompt="Finalize", needs_approval=true)
graph_approve(graph_id="review-workflow", node_id="finalize", action="approve")
```

See [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md) for the full engine architecture map and [docs/graph-legacy-v1-decommission.md](docs/graph-legacy-v1-decommission.md) for how the v1 subsystem was replaced.

---

## Loop mode

Run the same task across fresh sessions and iterate automatically — useful for refinement passes, batch fixes, and self-correcting workflows.

<p align="center">
  <img alt="rolebox loop mode running the same task across fresh sessions" src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/gifs/loop-mode.gif" width="720">
</p>

---

## Features at a glance

- **Dispatch system** — parallel background execution with concurrency control, budget tracking, task retry, and dependency graphs. See [docs/dispatch-config.md](docs/dispatch-config.md).
- **Graph execution engine** — explicit node/edge workflows with non-blocking `graph_run`, signal- and condition-based edges, bounded loop groups, and approval gates. See [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md).
- **Desktop notifications** — native OS notifications with idle detection, quiet hours, event filtering, and smart throttling. See [docs/hooks.md](docs/hooks.md).
- **Session management** — 10 tools for searching, exporting, forking, diffing, and inspecting session history. See [docs/session-tools-strategy.md](docs/session-tools-strategy.md).
- **Function state machine** — functions have active, gated, and dormant phases with evidence observation and artifact tracking. See [docs/functions.md](docs/functions.md).
- **Context assembly** — cross-domain search across memory, assets, tasks, and sessions with token-bounded result blocks.
- **Asset management** — hot-reload roles, skills, and references at runtime; asset search, inspection, validation, and composition analysis.

---

## Comparison: opencode vs + rolebox

| Capability | Raw opencode | + rolebox |
|---|---|---|
| **Persistent memory** | ❌ Sessions start blank | ✅ SQLite + FTS5, auto-inject past decisions |
| **Multi-agent teams** | ❌ Single agent | ✅ YAML-defined specialists, parallel dispatch |
| **LSP integration** | ❌ No language server access | ✅ 30+ tools (go-to-def, references, rename, diagnostics…) |
| **Hashline editing** | ❌ Line-number based | ✅ Content-hash anchored — edits never drift |
| **Background dispatch** | ❌ Sequential | ✅ Real concurrency with budget tracking |
| **Hot-reload assets** | ❌ Restart required | ✅ Edit YAML, reload instantly |

---

## CLI Reference

| Command | Description |
|---|---|
| `rolebox init <name>` | Scaffold a new role directory |
| `rolebox install <name>` | Install a role from the registry |
| `rolebox status` | List all installed roles and their status |
| `rolebox info <name>` | Detailed role inspection |
| `rolebox sync` | Sync installed roles with registry |
| `rolebox monitor` | Live dispatch metrics dashboard (TUI) |
| `rolebox memory search <query>` | Full-text search across persistent memory |
| `rolebox --version` | Show version |

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

## Model Alias Configuration

Roles published on the [oh-my-role registry](https://github.com/EricMoin/oh-my-role) often use placeholder model names (e.g. `PLACEHOLDER`, `YOUR_MODEL_HERE`) instead of real provider/model identifiers. Rather than editing each role's `role.yaml` manually, you can define local alias mappings once.

Create or edit `~/.config/opencode/role_config.yaml` (same directory as your `opencode.jsonc`):

```yaml
model_aliases:
  PLACEHOLDER: hfai/deepseek-v4-pro-max
  YOUR_MODEL_HERE: anthropic/claude-opus-4
  # key = placeholder string from role.yaml
  # value = provider/model_id for your actual model
```

### How resolution works

At role load time, each `model:` field goes through a non-destructive fallback chain:

1. **Known models first** — if the value matches a model already configured in your `opencode.jsonc` provider list, it passes through unchanged.
2. **Alias lookup** — if not known, rolebox checks `model_aliases` in `role_config.yaml`. When a match is found, the mapped value is used (single-hop — no recursive chaining).
3. **Passthrough with warning** — if neither matches, the original value is preserved and a warning is logged. Loading never fails because of an unrecognized model.

This resolution covers both the role-level `model` field and all subagent `model` fields, including inherited values.

### Error handling

- **Missing config file** — treated as an empty alias map; no error.
- **Malformed YAML** — warns and falls back to empty aliases; loading continues.
- **Invalid alias entries** (empty keys, non-string values, empty values) — skipped with a warning; valid entries in the same file still apply.

### Hot-reload

Edits to `role_config.yaml` take effect on the next hot-reload cycle or role bootstrap. No process restart is required for the primary runtime. For CLI tools that bypass the bootstrap path, a restart is needed.

---

## Docs Index

| Topic | Docs |
|---|---|
| Create a Role | [docs/create-a-role.md](docs/create-a-role.md) |
| role.yaml Reference | [docs/role-yaml.md](docs/role-yaml.md) |
| Directory Structure | [docs/directory-structure.md](docs/directory-structure.md) |
| Functions | [docs/functions.md](docs/functions.md) |
| Skills | [docs/skills.md](docs/skills.md) |
| References | [docs/references.md](docs/references.md) |
| Subagents | [docs/subagents.md](docs/subagents.md) |
| Collaboration Graph | [docs/collaboration-graph.md](docs/collaboration-graph.md) |
| Graph Engine Architecture | [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md) |
| Graph v1 Decommission | [docs/graph-legacy-v1-decommission.md](docs/graph-legacy-v1-decommission.md) |
| Memory Strategy | [docs/memory-strategy.md](docs/memory-strategy.md) |
| CLI | [docs/cli.md](docs/cli.md) |
| Session Tools | [docs/session-tools-strategy.md](docs/session-tools-strategy.md) |
| Dispatch Config | [docs/dispatch-config.md](docs/dispatch-config.md) |
| Custom Hooks | [docs/hooks.md](docs/hooks.md) |
| Extensions | [docs/extensions.md](docs/extensions.md) |
| Registry | [docs/registry.md](docs/registry.md) |
| Error Handling | [docs/error-handling.md](docs/error-handling.md) |
| Limitations | [docs/limitations.md](docs/limitations.md) |
| Compatibility | [docs/compatibility.md](docs/compatibility.md) |

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT &mdash; see the [LICENSE](LICENSE) file.
