<p align="center">
  <img alt="rolebox" src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/banner.png" width="640">
</p>

# rolebox

<p align="center">
  An agent-harness plugin — for <a href="https://github.com/sst/opencode">opencode</a>, <a href="https://pi.dev">pi</a>, and <a href="https://www.npmjs.com/package/@deepseek-ai/dsh">dsh</a> —
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

## What it is / why you'd want it

A general coding agent is one agent with one prompt. rolebox turns it into *your* configured team: specialist roles you define in YAML, each with its own prompts, model, skills, and permissions, working the same task together. What they learn survives the session — decisions, conventions, and lessons persist in memory — and a graph execution engine actually runs the team: dispatching each role, carrying results and signals between them, enforcing budgets, loop caps, and approval gates.

---

## The pitch, concretely

- **It remembers your project.** Decisions, conventions, and lessons persist in memory and auto-inject at session start (`<available_memory>`) — you stop re-explaining yourself.
- **Your team, defined by you.** Every specialist is a YAML role with its own prompt, model, skills, and permissions — install one from the registry or write your own.
- **Real concurrency with a ceiling.** Parallel multi-agent dispatch with engine-managed concurrency, per-node budgets, and retries — the team scales without runaway spend.
- **Autonomy you can gate.** Workflows run as an explicit graph with bounded loops, and a node flagged `needs_approval: true` pauses the graph until you approve it.
- **Edits that never drift.** 30+ language-server tools (go-to-definition, diagnostics, references, rename) plus content-hash-anchored editing that survives concurrent file changes.

The graph engine is how the team runs: `graph_create` → `graph_add_node` / `graph_add_edge` → `graph_run` builds an explicit workflow, and `graph_status` reads results back. `graph_run` is non-blocking — you end your turn and the engine wakes you with `[GRAPH COMPLETE]`, or `[GRAPH BLOCKED]` at an approval gate. Architecture and the full toolset: [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md).

---

## Supported harnesses

| Harness | Config directory | Roles directory | Global skills | Env override |
|---|---|---|---|---|
| [opencode](https://github.com/sst/opencode) | `~/.config/opencode` | `~/.config/opencode/rolebox` | `~/.config/opencode/skills` | `XDG_CONFIG_HOME` |
| [pi](https://pi.dev) | `~/.pi/agent` | `~/.pi/agent/rolebox` | `~/.pi/agent/skills` | `PI_CODING_AGENT_DIR` |
| [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) | `~/.dsh` | `~/.dsh/rolebox` | `~/.dsh/skills` | `DSH_HOME` |

On every harness a `rolebox/` directory in the **current working directory** takes precedence over the global roles directory; registry roles install with `rolebox install <name>` and deploy with `rolebox sync <opencode|pi|dsh>`. Jump to setup: [opencode](#opencode) · [pi](#pi) · [dsh](#dsh)

---

## 60-second install

### opencode

```bash
cd ~/.config/opencode && npm install rolebox
mkdir -p ~/.config/opencode/rolebox && cd ~/.config/opencode/rolebox && rolebox init my-agent -y
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["rolebox"] }
```

### pi

```bash
pi install npm:rolebox     # project-local instead: pi install -l npm:rolebox
mkdir -p ~/.pi/agent/rolebox && cd ~/.pi/agent/rolebox && rolebox init my-agent -y
# from a checkout instead: add "extensions": ["/path/to/rolebox/dist/pi-extension.js"] to ~/.pi/agent/settings.json
```

### dsh

```bash
dsh plugin --profile <name> add rolebox    # installs the bundle into that profile
mkdir -p ~/.dsh/rolebox && cd ~/.dsh/rolebox && rolebox init my-agent -y   # $DSH_HOME/rolebox if set
```

Restart the harness. A non-bundle dsh install instead needs one `- insert:` row naming the profile-relative `./node_modules/rolebox/dist/dsh-plugin.js` in the profile's `cordis.patch.yml` — see [examples/dsh/cordis.patch.yml](examples/dsh/cordis.patch.yml). Profile patch semantics, the web role-switch dock, and the `/rolebox` REST surface are documented in [docs/dsh-plugin-contract.md](docs/dsh-plugin-contract.md).

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

## See it work

**Loop mode** runs the same task across N fresh sessions: `|loop:N|` executes real multi-round iterations, each round dispatching the task to a fresh worker session and reporting its own outcome — useful for refinement passes, batch fixes, and self-correcting workflows.

<p align="center">
  <img alt="rolebox loop mode running the same task across fresh sessions" src="https://raw.githubusercontent.com/EricMoin/rolebox/HEAD/assets/gifs/loop-mode.gif" width="720">
</p>

---

## Role gallery

| Role | What it does |
|---|---|
| **emperor** | Top-level orchestrator — plans, delegates, validates complex work across a specialist team |
| **software-architect** | System design, trade-off analysis, ADRs, C4 models, and architecture reviews |
| **react-frontend** | React/Next.js component design, state management, and frontend architecture |
| **ai-designer** | AI application design with humane UX gates, interaction modeling, and design system creation |
| **tauri** | Desktop app development with Tauri v2 — IPC, plugins, window management, system tray |
| **dart-flutter** | Cross-platform mobile and desktop Flutter development with full gate review pipeline |

Install any role from the [oh-my-role registry](https://github.com/EricMoin/oh-my-role) with `rolebox install <name>` and restart your harness.

---

## CLI reference

| Command | Description |
|---|---|
| `rolebox init <name>` | Scaffold a new role directory |
| `rolebox install [name]` | Install a role from the registry (picker when omitted) |
| `rolebox status` | List installed roles and their status |
| `rolebox info [name]` | Inspect one role in detail (picker when omitted) |
| `rolebox sync <target>` | Deploy installed roles to `opencode` / `pi` / `dsh` |
| `rolebox config [name]` | Configure a role's models (`--target` selects the harness) |
| `rolebox monitor` | Runtime dashboard (TUI): loops, graph workflows, dispatch |
| `rolebox memory search <query>` | Full-text search across persistent memory |
| `rolebox --version` | Show version |

---

## Model Alias Configuration

Registry roles often ship placeholder model names; map them once in `role_config.yaml` — `~/.config/opencode/role_config.yaml`, `~/.pi/agent/role_config.yaml`, or `~/.dsh/role_config.yaml` (the harness config directory). Unrecognized values pass through unchanged with a warning. Full resolution chain, error handling, and hot-reload: [docs/model-aliases.md](docs/model-aliases.md).

---

> **Upgrading from 0.x.x?** rolebox 1.x replaced the 0.x execution model. Workflows are now built and run **imperatively on a graph execution engine** — `graph_create` → `graph_add_node` / `graph_add_edge` → `graph_run` — instead of being declared in `role.yaml`. See [docs/graph-engine-architecture.md](docs/graph-engine-architecture.md).

---

## Docs index

| Topic | Docs | Topic | Docs | Topic | Docs |
|---|---|---|---|---|---|
| Create a Role | [create-a-role.md](docs/create-a-role.md) | role.yaml Reference | [role-yaml.md](docs/role-yaml.md) | Directory Structure | [directory-structure.md](docs/directory-structure.md) |
| Functions | [functions.md](docs/functions.md) | Copilot (Turn-End) | [copilot.md](docs/copilot.md) | Skills | [skills.md](docs/skills.md) |
| References | [references.md](docs/references.md) | Subagents | [subagents.md](docs/subagents.md) | Graph Engine | [graph-engine-architecture.md](docs/graph-engine-architecture.md) |
| Memory Strategy | [memory-strategy.md](docs/memory-strategy.md) | Model Aliases | [model-aliases.md](docs/model-aliases.md) | CLI | [cli.md](docs/cli.md) |
| Session Tools | [session-tools-strategy.md](docs/session-tools-strategy.md) | Dispatch Config | [dispatch-config.md](docs/dispatch-config.md) | Custom Hooks | [hooks.md](docs/hooks.md) |
| Extensions | [extensions.md](docs/extensions.md) | Registry | [registry.md](docs/registry.md) | Error Handling | [error-handling.md](docs/error-handling.md) |
| Limitations | [limitations.md](docs/limitations.md) | Compatibility | [compatibility.md](docs/compatibility.md) | dsh Plugin Contract | [dsh-plugin-contract.md](docs/dsh-plugin-contract.md) |
| dsh Provider Notes | [dsh-provider-notes.md](docs/dsh-provider-notes.md) | Install/Update Audit | [audit-install-update-platform.md](docs/audit-install-update-platform.md) | CLI Output Audit | [audit-progress-ui.md](docs/audit-progress-ui.md) |

---

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT &mdash; see the [LICENSE](LICENSE) file.
