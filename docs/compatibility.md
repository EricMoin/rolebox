# Compatibility

> Part of the rolebox documentation. See [README](../README.md) for overview.

Works alongside oh-my-openagent. Rolebox roles appear in the agent list and skills are discoverable by the skill tool. No conflicts.

## Development runtime

The CLI, build, test, and CI commands require Node.js 26.4+ and npm. The TUI additionally requires `--experimental-ffi` on Node. Host-loaded plugins run inside their host's runtime. See [Node runtime and development](node-runtime.md).

## Harness versions

Each target has a minimum version, and each minimum is a runtime contract rather than a packaging detail. The README badge reports the dsh line — the binding one.

| Harness | Minimum | Declared by |
| --- | --- | --- |
| [opencode](https://github.com/sst/opencode) 1.x | plugin API `^1.3.0` | the `@opencode-ai/plugin` peer range; loaded through the package root |
| opencode 2.x | CLI and plugin API `2.0.18` | the `@opencode/plugin` peer range; loaded through `rolebox/server` |
| [pi](https://pi.dev) | `0.86.0` | the `@earendil-works/pi-coding-agent` peer range |
| [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) | `0.2.1-alpha.3` | the subagent contract below |
| Codex | none | the integration is an MCP server, so no versioned Codex package is involved |

rolebox's manifest also declares the `@deepseek-ai/cordis` peer (`4.0.2`) its dsh entry is built against.

### Why dsh starts at 0.2.1-alpha.3

rolebox establishes every subagent — a graph worker and a loop round alike — through `ctx.subagents.startActivation(spec)`, and advertises the four `SubagentCapabilities` booleans `agentOptions`, `agentPreset`, `outputSchema` and `depthLimit`. Both parts of that contract landed during the `0.2.1-alpha` line, and neither is present in `0.2.0-rc.x`:

| dsh | `startActivation` | `agentPreset` | `toolFilter` / `persona` |
| --- | --- | --- | --- |
| `0.2.0-rc.2` and earlier | absent | absent | present |
| `0.2.1-alpha.2` | present | absent | present |
| `0.2.1-alpha.3` | present | present | absent |

In `packages/subagent/subagent/src/{types,index,manager}.ts`, everything rolebox reads or writes is byte-identical between `0.2.1-alpha.3` and `0.2.1-alpha.4`, so `0.2.1-alpha.3` is the first release whose contract rolebox implements. `0.2.1-alpha.2` has the activation entry but the older five-boolean capability shape, and on a line before that a dispatch reaches a `startActivation` that does not exist — which is why the minimum is DECLARED rather than merely documented.

`package.json` states it as `engines.dsh: ">=0.2.1-alpha.3"`, so dsh refuses an unsupported line before loading rolebox instead of failing later, at the dispatch seam. dsh's own pre-flight reads `engines.dsh` first — an own range decides alone and peer ranges are then ignored — and otherwise checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range, treating prereleases as participants. An unmet requirement denies the plugin until an exact-version exemption is granted (`dsh plugin allow-version`).

## Pi parity status

Rolebox's Pi extension (`src/entries/pi.ts`) registers the full shared opencode tool surface through `PiLightweightServiceStack`; parity is enforced by `tests/pi-parity.test.ts`.

On Pi, rolebox resolves its directories under the pi config directory (`$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`): roles load from `{cwd}/rolebox` when present, else `~/.pi/agent/rolebox`; global skills resolve from `~/.pi/agent/skills`. Deploy installed roles there with `rolebox sync pi`. The dsh plugin resolves the same layout under `$DSH_HOME` / `~/.dsh` (see [dsh-plugin-contract.md](dsh-plugin-contract.md) §5.1); use `rolebox sync dsh`.

## Codex parity status

Rolebox's Codex integration (`src/platform/adapters/codex/`, served by `rolebox mcp` / `src/entries/codex.ts`) exposes the canonical tool intersection for a harness with no session client and no dispatch backend, plus `load_role_skill` — 18 tools. Parity is enforced by `tests/platform/codex-mcp.test.ts`; `tests/platform/codex-platform.test.ts` covers path resolution and registration detection, and `tests/cli/codex-sync.test.ts` covers the generated plugin bundle.

On Codex, rolebox resolves its directories under the Codex home (`$CODEX_HOME` when set, otherwise `~/.codex`): roles load from `{cwd}/rolebox` when present, else `~/.codex/rolebox`; global skills resolve from `~/.codex/skills`. Deploy installed roles there with `rolebox sync codex`, which also writes the local plugin marketplace and registers it in `~/.codex/config.toml`. See [codex.md](codex.md).

## opencode v2

opencode v2 (CLI `@opencode/cli@2.0.18`, plugin API `@opencode/plugin@2.0.18`) is a separate product from the 1.x line and loads plugins through a different contract. rolebox serves both paths from one package; they are independent, and **the opencode 1.x entry contract, package root shape and every surface it already exposed are unchanged**. What both opencode entries now additionally register is the declared-graph tool face — `graph_declare`, `graph_submit_outcome`, `graph_status`, `graph_audit` and `graph_control` — assembled by a shared host capability layer.

| | opencode 1.x | opencode v2 |
| --- | --- | --- |
| Resolved entry | package root — `dist/entries/opencode.js` (`src/entries/opencode.ts`) | `rolebox/server` — `dist/entries/opencode2.js` (`src/entries/opencode2.ts`) |
| Default export | `{ id, server }` | `{ id, setup }`, built with `Plugin.define` |

opencode v2 resolves a plugin entrypoint as `<package>/server` and only then falls back to the package root, and it does not load 1.x plugins — so the package root keeps the 1.x `{ id, server }` shape and an opencode 1.x install keeps working untouched. A v2 host reaches the v2 entry through the same installed package; no second package or extra install step is involved.

Both entries run the same initialization (log directory, rolebox directories, role bootstrap, project config, skill symlinks) and build the same rolebox service graph; only the host-facing registration differs.

### What opencode v2 gets

- **Tools** — one `editor.add` per canonical tool through `ctx.tool.transform` (`src/entries/opencode2.ts`), the same composed tool set the 1.x entry exposes. Both opencode entries now assemble a declared-graph host capability layer — the shared `src/platform/adapters/opencode/graph-host.ts`, opened for v2 by `src/platform/adapters/opencode2/graph-host.ts` — and register its five bound tools (`graph_declare`, `graph_submit_outcome`, `graph_status`, `graph_audit`, `graph_control`) through `ctx.outcomeGraphTools`, the composition seam that carries a host-assembled face into `buildCanonicalTools` (`src/core/services/tool-service.ts`).
- **Declared-graph tools** — the outcome run path is available to both opencode entries from that host layer: `graph_declare` parses and persists a declaration and starts or resumes it, `graph_submit_outcome` carries a worker's claimed outcome, `graph_status` reads the record back, `graph_audit` inventories the store and `graph_control` applies the trusted lifecycle commands. The store is host-owned and deliberately **outside the workspace**: `graphStoreRoot(getDataDir(), directory)` resolves to `<data-dir>/host/<workspace-hash>` (`src/graph/store/schema.ts`), because a dispatched worker runs with the workspace as its root.
- **A dispatched worker's default graph face is `graph_submit_outcome`.** Workers without a presentation configuration retain the host's existing native tools. On v2, a node can select `native` or `discover` presentation over the parent-authorized tool catalog; discovery adds `graph_worker_tools`. The v2 adapter checks inherited authorization on execution as well as filtering the model's visible schemas. The 1.x entry rejects explicit presentation configuration because its API cannot filter tools independently of permissions. `graph_declare`, `graph_status`, `graph_audit` and `graph_control` remain unavailable to workers, and `graph_submit_outcome` settles only the worker's own attempt. See [worker tools](worker-tools.md) for configuration and host-specific support.
- **Completion detection** — v2 arms the platform's own `ctx.session.wait` once per dispatched session, and the entry feeds the host every session end the event stream reports (`session.idle` → `"ended"`; v2's error carrier `session.execution.failed`, normalized to the canonical `session.error`, → `"errored"`) together with the typed `session.status` state (idle / busy / retry), which is where this platform's activity state comes from. A finished turn is **not** a settlement: the end only makes the host re-read the execution, whose answer may be `completed`, and that reading settles nothing by itself — only the plan's own acceptance of a submission settles an attempt. The 1.x entry has no session-turn-end call, so there its wrapped `event` handler is the only completion channel.
- **Run notifications wake the declaring session** — the entry hands the host a wake-up channel (`notifyClient`) and the host installs the shipped sender (`src/platform/graph-notifications.ts`), so the session that **declared** the graph — the run's recorded invocation origin, which `graph_declare` writes from the declaring tool call's own session — is prompted with the shipped `<system-reminder>[GRAPH COMPLETE]` / `[GRAPH BLOCKED]` render (`src/graph/application/graph-notifications.ts`) instead of polling `graph_status`. `noReply: false` is what resumes the declaring agent's loop rather than delivering text it never reads; v2 maps it to `resume: true` (`src/platform/adapters/opencode2/session.ts`). A notice is produced when the run reaches `phase === "complete"`, when a stopping control or `run.stop` stops the run, when an approval is pending, when a node's required inputs are unavailable, and when a worker launch failed or was refused. The channel is optional: a host with no wake-up channel installs none and reports that in `platformNotes`, and the run is then read through `graph_status`.
- **Explicit degradations** — the host installs no execution query port and no last-turn reader (`derivedOutcomeOf`), so a worker that ends its turn without a submission settles nothing and nothing is read out of its prose; and — unlike dsh and Pi — there is **no boot recovery** (see the limitation below). On the reading side the two opencode platforms differ, and each one's limit is stated rather than implied: the 1.x SDK's `Session` carries no terminal-outcome field, so there the execution reading is **state-only** (the session's own status, plus the typed `session.status` event the entry feeds the host) and rolebox never invents an outcome from it, while v2 has no `session.status` call but does expose the session's own `outcome` through `ctx.session.get({ sessionID })`, which the host reads as a completion or as a failed execution (see the v2 limitation below). An execution with no recorded end whose reads are missing or failed answers `unknown` — never `completed` — naming which read could not answer, and a cancel is answered `requested` or `unsupported`, never `confirmed`.
- **Tool hooks** — `execute.before` recreates the 1.x `{ args }` view over the host's mutable event input and writes mutations back, so the recovery guards that rewrite arguments still apply; `execute.after` rebuilds the 1.x output object `{ title, output, metadata }` from the v2 event's `status` plus `result`/`error` — the tool text (`result.content`, a string or `Content[]`, else `String(result.output ?? "")`) becomes `output`, `result.metadata.title` becomes `title` and `result.metadata` becomes `metadata`; an error becomes `{ title: "", output: error.message, metadata: error.metadata ?? {} }`. Every 1.x consumer of that hook therefore keeps reading the same fields (`output.output` in the recovery guards and tool hooks), rather than falling back to a stringified event.
- **Session hooks** — `prompt` resolves the session's acting agent and forwards it to the 1.x `chat.message` handler alongside the normalized text, which it writes back; `context` maps the system prompt between v2 `SystemPart[]` and rolebox's `string[]` in both directions; `compaction` runs rolebox's compaction hook and carries its block on the compaction request (see the limitation below).
- **Roles and sub-agents** — every resolved role and its recursively nested sub-agents are upserted through `ctx.agent.transform` → `editor.update(id, …)`, with the same prompt/mode/model/description/color/permission assembly the 1.x path uses (`src/platform/adapters/opencode2/agents.ts`). v2's agent editor has no `add`, and `update` upserts from the host's default agent.
- **A session created for a role agent runs that role's model.** opencode v2 does not inherit an agent's model into a session it creates — `SessionCreateInput.model` is what the created session runs, and a session created without one falls back to the host's default model, where the 1.x host resolves the agent's model itself. The entry therefore derives the model of every registered role and sub-agent from the same registration assembly the agent transform writes (`collectOpencode2AgentModels`, `src/platform/adapters/opencode2/agents.ts`) and hands it to the session adapter (`src/entries/opencode2.ts`), which forwards `{ id, providerID, variant? }` on `session.create` (`src/platform/adapters/opencode2/session.ts`). A role that resolves no model is absent from that map, so a session created for it keeps the host default — rolebox never invents a model.
- **An agent is switched only when the session does not already run it.** v2 sets the agent on the session (`switchAgent`), and switching a session that already runs the requested agent appends an `agent-switched` message whose `previous` equals the agent, so both prompt paths read the session's current agent first and skip the redundant switch (`src/platform/adapters/opencode2/session.ts`); a read that is missing or fails, or a session the host answers without an agent, falls back to the unconditional switch this adapter has always made. Only the agent is selected on those paths — never the model — because they also prompt the user's own session (graph notifications, copilot continuations), whose model and variant rolebox must not overwrite.
- **Role skills** — role-local (`SkillScope.Rolebox`) skills are registered with their bodies through `ctx.skill.transform` → `editor.add` (`src/platform/adapters/opencode2/skills.ts`). Globally resolved harness skills are left to the host, a duplicate skill id registers once, and bodies are read eagerly and capped at 64 KiB.
- **`/stop-loop`** — registered through `ctx.command.transform` and delivered as the loop-stop signal in the invoking session (`src/platform/adapters/opencode2/commands.ts`).
- **Event stream** — `ctx.event.subscribe()` is consumed in the background and every event is normalized into the canonical event the 1.x `event` handler reads (`src/platform/adapters/opencode2/event-bridge.ts`); the subscription never blocks setup.
- **Shutdown** — the `Cleanup` that `setup` returns aborts the event relay, disposes every registration and the handler map, and flushes loop, function and signal state (`src/entries/opencode2.ts`).
- **Failure containment** — a registration the host rejects is logged and that one surface is skipped, and a role file that fails to load is logged and leaves the plugin with zero roles. The event stream is contained the same way: a `subscribe` that throws is logged, that stream is skipped and every other surface still registers. `setup` rejects only when the service graph itself cannot be built.

### opencode v2 limitations

- **The plugin session surface is reduced.** v2's plugin session domain exposes create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/context only. Session listing, child-session listing, todos, diff, fork, status polling and compaction are degraded accordingly in `src/platform/adapters/opencode2/session.ts`: `list`, `children`, `todo` and `diff` return empty, `fork` and `status` return null, and `compact` returns false — never throwing. (The declared-graph host's own execution reading does not go through that adapter: it reads the raw session domain and the event stream — see the last limitation below.) The matching tools (`session_list`, `session_diff`, `session_fork`, …) still register but have nothing to report on v2. **A created session cannot be given a parent either:** `SessionCreateInput` has no `parentID` field, so the adapter's `create()` drops it (`src/platform/adapters/opencode2/session.ts`), while the dispatch launcher passes `parentID: parentContext.sessionID` for every task that does not set `noParentInherit` (`src/dispatch/core/task-launcher.ts`, `src/dispatch/core/sync-executor.ts`). On v2 every dispatched session therefore starts without the parent conversation's history — it behaves as if `noParentInherit` were set. Dispatch itself still works, because it needs session create, prompt and interrupt.
- **Agents register in process; there is no agent file sync.** v2's agent editor registers agents live, so rolebox passes no agent-file registrar and writes no agent files (`hasAgentFileSync: false`). Roles reach v2 only through the plugin's own in-process registration.
- **No in-session role switching.** v2 exposes no role picker, so `hasRoleSwitch: false`; `ctx.session.switchAgent` switches the running agent programmatically and is not a user-facing switcher.
- **Compaction context travels on the compaction request, not on `result`.** v2's `SessionCompaction` has no `context` field, so the block the 1.x hook appends to `context` is appended to the compaction request instead as one extra `SystemPart` on the event's mutable `system` array — the same request mutation the `context` hook performs for the agent loop. The compaction summary is still produced by the model: `result` is left untouched, because setting it means "use this compaction and skip the model request" and `SessionCompactionResult.summary` is required, so a synthesized result would replace the session summary instead of annotating it. If another plugin has already set `result`, rolebox does not overwrite it: its `summary` is preserved verbatim and the block is added to `result.metadata["rolebox.context"]` instead. A host that does not read a hook's mutations back drops the block, as it would for the `context` hook.
- **The prompt hook has no agent id, so rolebox resolves one.** v2's `SessionPrompt` carries no agent, and `input.agent` is what scopes a turn in the 1.x handler — role auto-activation, role-scoped `|fn|` validation and the `|loop|` start path all read it, while only the tool-hook contexts, copilot role resolution and the system-transform fallback read the recorded `sessionAgentRegistry`. The prompt hook therefore resolves the acting agent before it runs, asking the host first — `ctx.session.get({ sessionID })`, whose `SessionInfo.agent` is the session's acting agent and is the value `ctx.session.switchAgent` mutates — and falling back to `sessionAgentRegistry`, the mapping a previous turn recorded, only when the host exposes no `get`, rejects the call, or answers without an agent. The lookup is per prompting turn and never cached, so a `switchAgent` between turns is observed on the next one. When neither source answers — an unknown session with no recorded mapping — the turn proceeds with no agent, exactly as it did before, and role-scoped behaviour falls back to the unscoped path.
- **Rewritten system parts are plain text.** The `string[]` view cannot carry v2 `SystemPart` cache hints or metadata, so a part the hook rewrites — or one it appends — becomes `{ type: "text", text }`. Parts the hook leaves untouched are handed back as the original `SystemPart` object, so their cache hint and metadata survive a session request.
- **Tool `ask` is a no-op.** v2's tool context exposes no permission request and the plugin permission domain can only answer one, so a tool that would prompt resolves without prompting.
- **One canonical event has no v2 counterpart.** No v2 event maps to `message.updated`, the dispatch watchdog's progress heartbeat; `session.status` and the part streams remain, and unmapped or unrecognized events normalize to `unknown` with their raw type preserved rather than being dropped.
- **Role bootstrap failures are contained.** A role file that fails to load is logged and the plugin continues with zero roles, where the 1.x entry propagates the same failure.
- **Run notifications are installed, but delivery is a retried pending effect.** Both entries hand the host a wake-up channel (`notifyClient`) and the host installs the shipped sender (`src/platform/graph-notifications.ts`), so the declaring session is prompted as soon as its run reaches a terminal or attention state instead of being left to poll `graph_status`; what is not guaranteed is delivery, because the notice is a durable pending effect retried with a lease (`src/graph/application/graph-notifications.ts`): a platform that rejects the prompt leaves it pending — visible in `graph_status` as an unsettled effect, never reported as delivered, and never given up on — while the run itself is unaffected and completes exactly as it would without the channel.
- **No boot recovery on either opencode entry, unlike dsh and Pi.** The dsh and Pi entries call `recoverDeclaredGraphs()` / `retainAwaitingCompletions()` when their host boots; neither opencode entry does. An opencode plugin loads for **every** CLI invocation of a shared configuration, so an automatic re-dispatch would fire from unrelated commands. A run stranded in an earlier process stays visible in `graph_status` and is re-armed deliberately with `graph_control {command:"retry"}`.
- **v2 has no session status call, but its session state and its session outcome are readable.** v2's plugin session domain has neither the status map nor a per-session status operation — the client's argument-less `active` reports only currently-running sessions (`{[id]: {type: "running"}}`) and is not part of the plugin's session domain at all — so `Opencode2SessionAdapter.status` answers `null` and no adapter read can supply a state. The information is still reachable through the two channels v2 does expose, and the entry reads both: the typed `session.status` event (`{type:"idle"} | {type:"retry"; …} | {type:"busy"}`) is fed to the declared-graph host as the **fresh activity state** (`busy` and `retry` answer running, and the state is never invented from `Session.Info.time.idle`, whose "this session is idle now" reading would be an inference from a field name), and `ctx.session.get({ sessionID })` returns the session's own `outcome` (`"succeeded" | "failed" | "interrupted"`), which the host reads as a completion, or as a failed execution in the platform's own word — reported on the attempt as a failure rather than passed to the completion bridge. What the reading answers is stated, not rounded: an **idle state answers `unknown`** — the turn is over, not that the attempt reached a declared outcome, because a finished turn is not a settled attempt and only the plan's own acceptance of a submission settles one; a **recorded end is reported `completed` for a normal end and `failed` for an errored end or a read terminal outcome of `failed` / `interrupted`**, the platform's own word for the failure (`src/platform/adapters/opencode/graph-host.ts`); a `completed` reading **settles nothing by itself** — it says the execution ended normally, the same reading `observeExecution()` takes from a completed Pi dispatch task (`src/platform/adapters/pi/outcome-dispatch.ts`), so a node that pins no natural completion stays unsettled after its worker's turn ends and until the worker's `graph_submit_outcome` arrives; an execution whose reads are missing or failed answers `unknown` naming the read that could not answer; and a cancel is answered `requested` or `unsupported`, never `confirmed`, because an opencode interrupt reports that a transition was accepted, not that the session is cancelled.

The parity matrix below is the tool surface shared with the 1.x entry; the differences above are host-contract limits, not configuration.

## Parity matrix

| Tool surface | Opencode | Pi | Codex |
| --- | --- | --- | --- |
| hashline_read / hashline_edit | ✓ | ✓ | ✓ |
| memory_write / memory_recall / memory_list / memory_read / memory_update | ✓ | ✓ | ✓ |
| web_search / web_read / web_fetch | ✓ | ✓ | ✓ |
| signal | ✓ | ✓ | ✓ |
| interactive_terminal | ✓ | ✓ | ✓ |
| asset_search / asset_inspect / asset_validate | ✓ | ✓ | ✓ |
| reference_search / load_reference | ✓ | ✓ | ✓ |
| load_role_skill | — (native skill tool) | ✓ | ✓ |
| session_list / session_read / session_search / session_info / session_diff / session_fork | ✓ | ✓ | — (not over MCP) |
| graph_declare / graph_submit_outcome / graph_status / graph_audit / graph_control | ✓ | ✓ | — (no host capability layer) |
| task_search / task_budget / task_graph / task_chronology / task_export (task_retry withheld) | ✓ | ✓ | — (not over MCP) |
| lsp_* (32 tools) | ✓ | ✓ | — (not over MCP) |
| function_graph / skill_compose / context_assemble | ✓ | ✓ | — (not over MCP) |
| asset_hot_reload | ✓ | — (opencode-only) | — (opencode-only) |
| [computer_* (12 tools)](computer-use.md#tools-and-arguments) | — (not registered; the gate only emits deny rules) | ✓ (default on) | ✓ (default on) |
| [browse_* (23 tools)](browser-use.md#tools-and-arguments) | — (not registered; the gate only emits deny rules) | ✓ (when the browseUse gate is on) | ✓ (when the browseUse gate is on) |
| dispatch_* / loop_* | — (withheld) | — (withheld) | — (not over MCP) |
| task_retry | — (withheld) | — (withheld) | — (withheld) |

The graph tools ship with every host that owns an outcome capability layer — dsh, Pi, and both opencode entries (1.x and v2). A dispatched worker's default graph face is `graph_submit_outcome`; command execution uses the host's native tools. Explicit discovery presentation adds `graph_worker_tools`; code presentation on supported hosts also adds `graph_worker_code`. These entries never grant graph control capabilities. See [worker tools](worker-tools.md) for the support matrix.

## Computer use

Rolebox's computer-use family — `computer_screenshot`, `computer_windows`,
`computer_click`, `computer_move`, `computer_type`, `computer_key`,
`computer_permissions`, `computer_scroll`, `computer_drag`, `computer_focus`,
`computer_displays` and `computer_status` — is assembled by the shared `buildCanonicalTools`, which
merges it only when the host asked for it (`src/platform/tool-assembly.ts:146-151`).
DSH, Pi and Codex enable it by default. No role YAML opt-in is needed; optional
role `tools` rules can restrict it. An explicit `computerUse: false` in a host
option, global config, or project config disables the family. DSH namespace
filters and graph workers' inherited parent authorization still apply. Neither
OpenCode entry registers the family.

OS authorization is requested through `computer_permissions` and remains a
separate user-controlled step. DSH/Pi prompt context and Codex MCP initialize
instructions explain the available workflow. The family, per-host image
transport, and platform requirements are documented in [computer-use.md](computer-use.md).

Remaining platform-inherent gaps (hot reload, extensions, recovery engine, TUI) are explicit non-goals on Pi and Codex — see [limitations.md](limitations.md).

## Browser use

Rolebox's browser family — `browse_status`, `browse_open`, `browse_snapshot`,
`browse_read`, `browse_click`, `browse_type`, `browse_press`, `browse_select`,
`browse_drag`, `browse_hover`, `browse_scroll`, `browse_wait`, `browse_eval`,
`browse_screenshot`, `browse_upload`, `browse_downloads`, `browse_dialog`,
`browse_tabs`, `browse_history`, `browse_console`, `browse_network`,
`browse_cookies` and `browse_close` — is the DOM-level counterpart to computer
use: it reads a page as an ARIA-shaped tree and acts on element refs. It is
built on Playwright, an optional peer (`playwright >=1.40.0`) that must resolve
from the rolebox install, and its browser binaries are a separate step
(`npx playwright install chromium`).

The `browseUse` gate is separate from `computerUse` and fail-closed: an explicit
`false` in a host option, global config or project config disables the family,
an explicit `true` registers it even when Playwright is missing (`browse_status`
then reports the gap), and with no setting it is on exactly when Playwright
resolves. DSH, Pi and Codex register the family when the gate is on; DSH
additionally requires its tool-guard seam. Neither OpenCode entry registers it,
though with the gate on they materialize an explicit per-role denial for every
browse tool the role's `tools` map does not grant. Role `tools` rules can
restrict individual tools with exact-over-wildcard precedence, and graph node
grants still apply. The gate is read when the host loads, so a change needs a
restart. Targets, ref semantics, artifacts and limits are documented in
[browser-use.md](browser-use.md).
