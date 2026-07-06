<p align="center">
  <img alt="rolebox — Turn one AI coding assistant into a team of specialists — defined in YAML, no code." src="https://raw.githubusercontent.com/EricMoin/rolebox/main/assets/banner.png" width="640">
</p>

# rolebox

<p align="center">
  An <a href="https://github.com/nicholasgriffintn/opencode">opencode</a> plugin for composable, shareable AI agent teams. Define roles, functions, skills, and collaboration graphs in a single YAML file. Share them across projects like packages. No code required.
</p>

<p align="center">
  <!-- TODO: replace placeholder badge URLs with real shields.io links -->
  <a href="https://www.npmjs.com/package/rolebox"><img alt="npm" src="https://img.shields.io/npm/v/rolebox"></a>
  <a href="#"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/EricMoin/rolebox/ci.yml"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/EricMoin/rolebox"></a>
  <a href="#"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/EricMoin/rolebox"></a>
</p>

<br>

<!-- TODO: add a demo GIF showing multi-agent dispatch in action (e.g. Emperor dispatching to ui + backend subagents in parallel, then validator reviewing results) -->

> **See it in action** — *placeholder for demo GIF showing multi-agent dispatch running in opencode with Emperor orchestrating a team of specialists.*

<br>

---

## Why rolebox?

**No code, just YAML.** A role is one YAML file with a prompt, model, temperature, skills, functions, references, subagents, and collaboration graph. No Node.js boilerplate. No plugin SDK. Just declare.

**Composable teams.** Roles can own sub-agents with their own prompts and models. Built-in collaboration topologies (pipeline, review-loop, star) handle routing — you describe the flow, rolebox runs it.

**Share like packages.** Install pre-built roles from the registry: `rolebox install emperor`. Publish your own. Versioned, tagged, discoverable. Same mental model as npm/pip.

**Self-organizing orchestration.** The Emperor role plans complex work, dispatches to department specialists, and validates results — all from a YAML config. It works like an engineering team lead that never sleeps.

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

---

## ✨ Featured: Emperor

[Emperor](https://github.com/EricMoin/oh-my-role) is a top-level orchestrator that plans, delegates, and validates complex work across a team of specialist sub-agents — without writing any code itself.

```bash
rolebox install emperor
```

Its architecture:

- **3-stage planner** — draft → review → finalize
- **Executor/router** with 6 department workers: `ui`, `backend`, `test`, `data`, `docs`, `quality`
- **Validator** for closed-loop validation
- **Multi-subtask dependency scheduling** — parallel where possible, sequential where not
- **Live risk gate** — high-risk operations require user approval before proceeding
- **2-round revise loop** — per-item re-dispatch with correction budget
- **Budget-bounded concurrency** — respects model pool limits automatically

Emperor NEVER writes code. It reads, routes, and summarizes. Best for complex multi-step work, architecture decisions, refactoring, and anything that needs strategy before execution.

Install it: `rolebox install emperor`, restart opencode, and select Emperor as your agent.

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

## How it Works

| Topic | What | Docs |
|---|---|---|
| **Functions** | Composable behavior modules activated with `\|name\|` syntax. Inject instructions on demand. | [docs/functions.md](docs/functions.md) |
| **Skills** | On-demand knowledge modules loaded via the `skill` tool when needed. | [docs/skills.md](docs/skills.md) |
| **References** | Deep-knowledge documents agents read for domain context. Auto-discovered from directories. | [docs/references.md](docs/references.md) |
| **Subagents** | Child agents with their own prompts, skills, and configs. Dispatch work via `dispatch()` tool. | [docs/subagents.md](docs/subagents.md) |
| **Collaboration Graph** | Define workflow topologies (pipeline, review-loop, star) — rolebox routes automatically. | [docs/collaboration-graph.md](docs/collaboration-graph.md) |
| **Custom Hooks** | JavaScript modules that fire on chat, tool events, and lifecycle events. Phase-aware. | [docs/hooks.md](docs/hooks.md) |
| **Extensions** | Open rolebox's closed vocabularies — custom conditions, topologies, recovery strategies, and more. | [docs/extensions.md](docs/extensions.md) |
| **CLI** | Install, search, update, sync, monitor, and manage roles from the command line. | [docs/cli.md](docs/cli.md) |
| **role.yaml Reference** | Full schema: model config, skills, functions, subagents, dispatch, hooks, permissions. | [docs/role-yaml.md](docs/role-yaml.md) |
| **Dispatch Config** | Dispatch concurrency, budgets, timeouts, queue depth — configure per-role or via env vars. | [docs/dispatch-config.md](docs/dispatch-config.md) |
| **Registry** | Publish your own role registry on GitHub. Share roles with versioning and tags. | [docs/registry.md](docs/registry.md) |
| **Create a Role** | Hand-written role setup, directory structure, and examples (code reviewer with parameterized functions). | [docs/create-a-role.md](docs/create-a-role.md) |
| **Error Handling** | Invalid YAML, missing skills, missing functions — all fail gracefully. | [docs/error-handling.md](docs/error-handling.md) |
| **Limitations** | No role inheritance, no runtime switching, no cross-subagent communication. | [docs/limitations.md](docs/limitations.md) |
| **Compatibility** | Works alongside oh-my-openagent. No conflicts. | [docs/compatibility.md](docs/compatibility.md) |
| **Directory Structure** | Complete file layout reference. | [docs/directory-structure.md](docs/directory-structure.md) |

---

## Community & Contributing

- **Docs:** Read the full reference at [docs/](docs/)
- **Registry:** Browse roles at [oh-my-role](https://github.com/EricMoin/oh-my-role)
- **Discord:** *[add invite link]*
- **Issues & PRs:** Welcome. See the contributing guide for guidelines.

Build roles. Share them. Make your AI assistant work the way you do.

---

## License

MIT &mdash; see the [LICENSE](LICENSE) file.
