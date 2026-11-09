# Codex

> Part of the rolebox documentation. See [README](../README.md) for overview.

Rolebox integrates with Codex through native custom-agent files, a generated local
plugin marketplace, and a stdio MCP server. Public roles become native Codex agents;
private children remain scoped rolebox execution targets. The MCP runtime supplies
session tools and the declared-graph engine. A lazy Codex app-server handles model
requests; its workers' native tools use a separate sandboxed exec-server.

Parity is enforced by the Codex tests: `tests/platform/codex-mcp.test.ts` (the protocol
and the canonical tool surface), `tests/platform/codex-platform.test.ts` (path resolution,
the registry descriptor, capabilities and registration detection), and
`tests/cli/codex-sync.test.ts` (the generated bundle and `config.toml` registration).
Tests under `tests/platform/adapters/codex/` cover native-agent mapping, app-server
transport, session projection and graph execution using local protocol fixtures. They
do not establish live model or operating-system sandbox behavior. Opt-in live
acceptance is described below. See
[compatibility.md](compatibility.md) for the harness matrix and
[limitations.md](limitations.md) for the non-goals.

## Codex home resolution

The Codex home resolves as `$CODEX_HOME` when it is set and non-blank, otherwise
`~/.codex`; a blank value is treated as unset. It is read at call time, not captured at
module load, so a redirected `CODEX_HOME` applies to the next command.

| Path | Purpose |
|---|---|
| `$CODEX_HOME` or `~/.codex` | Codex home (rolebox's `configDir` for this target) |
| `{codexHome}/rolebox` | Sync target: one symlink per installed role |
| `{codexHome}/agents` | Generated public native-agent TOML files |
| `{codexHome}/rolebox-agents.json` | Fingerprints of managed native-agent files |
| `{codexHome}/skills` | Global skills directory exposed to the plugin |
| `{codexHome}/rolebox-marketplace` | Generated local marketplace (plugin bundle) |
| `{codexHome}/config.toml` | Host config carrying the managed registration block |

Codex has no rolebox-owned sessions directory. As on every other harness, a `rolebox/`
directory in the current working directory takes precedence over `{codexHome}/rolebox`
when the MCP server boots. Workspace roles generate native files under
`{cwd}/.codex/agents` and a `{cwd}/.codex/rolebox-agents.json` manifest; they are never
exported into the global agent directory. CLI sync deploys the installed global role
tree. Restart Codex after the MCP boot generates project agents so its native catalog
can discover them.

## Install and use

1. Install rolebox the usual way — `npm install -g rolebox`, or run from a checkout that
   has been built with `npm run build`. The recorded server entry is the built
   `dist/entries/codex.js` artifact.
2. Run the sync target:

   ```bash
   rolebox sync codex
   codex plugin add rolebox@rolebox
   ```

3. Restart Codex so it re-reads `{codexHome}/config.toml`, the local marketplace and
   native agents. Ask it to delegate using a generated public agent such as
   `rolebox--reviewer`.

The second command installs or refreshes Codex's local plugin cache. Marketplace
registration and `enabled = true` alone do not populate a fresh cache. Project
native agents also require the project to be trusted in Codex; rolebox does not
change that trust setting.

Session browsing requires `codex app-server` on `PATH`, or an executable path in
`ROLEBOX_CODEX_COMMAND`. Delegated execution and session forks additionally require
Codex to supply its per-call thread identity, opaque sandbox state and sandbox launcher.
The protocol was checked against Codex `0.166.0-alpha.5.1`; support is capability-based,
with no Codex npm dependency or numeric minimum enforced by rolebox. Older hosts can
still use standalone tools, but a missing execution capability produces an explicit
tool error. Updating Codex and restarting the MCP connection is the supported remedy.

`rolebox sync codex` also deploys installed roles as symlinks (the same role sync every
target gets), prints the usual `Synced N roles to codex` line, and then reports
`Codex plugin: registered {marketplaceDir} in {configPath}`.

The bundle is written before the registration is attempted, so when registration fails the
command prints both halves — `Codex plugin: wrote the marketplace directory
{marketplaceDir}, but registering it in {configPath} failed: {reason}` — says the sync is
safe to repeat, and re-raises the error rather than printing the success line. A recorded
server entry that does not exist (a source checkout that was never built) does not fail
the sync: the bundle is still written and registered, and a warning names the missing
`dist/entries/codex.js` path and suggests `npm run build`.

## What `rolebox sync codex` writes

| Path | Contents |
|---|---|
| `{codexHome}/rolebox/<role>` | Symlink per installed role pointing at its shared source |
| `{codexHome}/agents/rolebox--<role-id>.toml` | Native public role: name, description, instructions and supported model/feature settings |
| `{codexHome}/rolebox-agents.json` | Managed filenames and content fingerprints |
| `{codexHome}/rolebox-marketplace/.agents/plugins/marketplace.json` | Marketplace manifest: name `rolebox`, one `local` plugin source at `./plugins/rolebox` |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/.codex-plugin/plugin.json` | Plugin manifest: name `rolebox`, version read from rolebox's `package.json`, `skills: "./skills/"`, `mcpServers: "./.mcp.json"`, interface metadata |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/.mcp.json` | Starts the rolebox MCP server: `command: "node"`, `args: ["<abs path to dist/entries/codex.js>"]`, `startup_timeout_sec: 60`, `tool_timeout_sec: 600` |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/skills` | Directory symlink to `{codexHome}/skills` |
| `{codexHome}/skills` | Created if missing; this is the directory exposed to the plugin as its `skills/` |
| `{codexHome}/config.toml` | Exactly one managed registration block (below) |

`sync` also writes the built-in `rolebox-config` skill link inside
`{codexHome}/skills`. The MCP server writes the role-specific `rolebox--<skill>`
entries when it boots and resolves the installed roles (`syncSkillSymlinks`).

The MCP configuration explicitly forwards `CODEX_HOME`, `ROLEBOX_CONFIG_DIR`,
`ROLEBOX_DATA_DIR`, `ROLEBOX_CODEX_COMMAND` and `ROLEBOX_SESSION_ID` when they are
set in the launching Codex process. Codex filters a stdio server's environment;
these entries keep the server and its app-server children on the same home and
rolebox data/configuration directories. Values are inherited at launch, never
copied into the generated JSON.
It also forwards upper/lowercase `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
`NO_PROXY`, plus `SSL_CERT_FILE`, `SSL_CERT_DIR` and `NODE_EXTRA_CA_CERTS`, so
delegated app-server connections retain the parent's proxy and certificate setup.

Native-agent sync is idempotent and preserves unmanaged files, symlinks and local edits.
It updates or removes a generated agent only while its content matches the recorded
fingerprint. A collision or edited stale file is preserved with a warning. Edit
`role.yaml`, sync again, and restart Codex rather than editing generated TOML.

The managed block written to `config.toml` is:

```toml
# >>> rolebox (managed) — do not edit; `rolebox sync codex` rewrites this block >>>
[marketplaces.rolebox]
source_type = "local"
source = "{codexHome}/rolebox-marketplace"
[plugins."rolebox@rolebox"]
enabled = true
# <<< rolebox (managed) <<<
```

Sync is idempotent. Every generated file is rewritten with identical bytes for identical
options, an existing correct `skills` symlink is left untouched, and existing managed
blocks are replaced in place — no byte outside the block is modified. When the block is
appended for the first time, a single newline separates it from the existing config: a
blank line when the file already ends with one, otherwise it terminates the last line.
A real directory sitting where the `skills` symlink belongs is never destroyed.

Duplicate blocks left behind by a hand-edit are repaired rather than duplicated: the first
is replaced with the fresh block and every later one is removed. A start marker without a
matching end marker is refused with an error naming the config file and both markers — the
file is left untouched, and the stray marker has to be deleted by hand before the next
sync. The marketplace path is emitted as a TOML basic string, with the `\b`, `\t`, `\n`,
`\f`, `\r`, `\"` and `\\` short escapes and `\uXXXX` for every other control
character, so a home directory containing them cannot produce an unparseable
`config.toml`.

## Native roles and private subagents

For an ordinary role ID `reviewer`, the public native name is `rolebox--reviewer`.
Unusual or long IDs receive a stable sanitized name with a digest suffix; use the
generated file's `name`. Codex's native agent selection applies that role's prompt
and supported model settings. It does not switch an existing root conversation or
apply project `defaultRole` automatically.

Nested roles keep canonical IDs such as `reviewer--researcher`. They are held as
runtime descriptors and are excluded from Codex's global native-agent discovery.
The owning role can name its direct children in `graph_declare`; unrelated roles and
unattributed root conversations cannot launch those private children. Recursive
descriptors retain deeper child IDs, but graph workers cannot recursively delegate
or control graphs. Deeper private descendants therefore have no general launch path
through this integration's normal native-agent/graph workflow.

Bare native model IDs, including aliases resolving to them, map directly. A
`provider/model` value maps only when its provider matches the effective inherited
Codex provider. The CLI/native-file sync does not know that provider and inherits the
parent model with a warning for qualified values. Managed graph workers read their
parent's provider and can apply a matching qualified model. Rolebox never changes the
provider or installs credentials. `variant` maps to `model_reasoning_effort` for
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`; the selected
model must support the value. Managed workers inherit the parent's effort when no
role variant is set. Unsupported variants and sampling settings are omitted with
warnings.

Native files may disable supported feature groups such as shell, apps, plugins,
memories and permission requests. They cannot widen sandbox or approval policy or
provide arbitrary native per-tool permissions. Exact or trailing-star permission
denials disable matching feature groups even when `tools` explicitly grants an alias.
Rolebox's own MCP calls additionally
enforce the attributed role's `tools` rules and `permission.deny`; the worker's
dedicated outcome-submission channel remains available.

## Verify it took effect

- `rolebox status` prints a **Codex Integration** section. Its `Plugin + MCP` line reads
  `registered` once `{codexHome}/config.toml` registers rolebox in any of the spellings
  Codex accepts: a marketplace table (`[marketplaces.rolebox]` or
  `[marketplaces."rolebox"]`), a plugin table (`[plugins."rolebox@<marketplace>"]`), or
  an MCP server registration — `[mcp_servers.rolebox]`, or an inline
  `rolebox = { ... }` entry inside a `[mcp_servers]` table. Blank and comment lines are
  skipped, whitespace around dotted keys is tolerated, quoted key segments are accepted,
  and a trailing comment on the header is ignored; the section also lists the sync target
  and the per-target synced role count. Detection is a line-oriented scan rather than a
  TOML parse, so multi-line strings are not understood: a rolebox table header written
  inside one still counts as registered.
- Or inspect the files directly: `{codexHome}/config.toml` contains the managed block,
  and the four generated entries under `{codexHome}/rolebox-marketplace` exist (three
  JSON manifests plus the `skills` symlink).
- `rolebox mcp` (or `node dist/entries/codex.js`) starts the same server the plugin
  starts; its `initialize` result reports `serverInfo.name` `rolebox`.

### Parent wake-up acceptance

Run `npm run test:codex:wake` from the checkout with a current Codex CLI available
on `PATH` (or selected by `ROLEBOX_CODEX_COMMAND`). It starts an isolated real
app-server with a loopback model fixture and a real graph store. The parent turn
ends while a fixture worker remains in flight; accepting that worker's outcome
then delivers the durable notification and produces a second completed parent turn.
The probe also checks that the notification reached the model and that disconnecting
the notifier preserves the shared host. It uses no real model credentials or paid
inference and does not establish that an unrelated desktop stdio session is reachable.

### Authenticated end-to-end acceptance

After building and syncing this checkout, run:

```bash
ROLEBOX_CODEX_LIVE=1 npm run test:codex:e2e
```

The harness uses the installed CLI, the synchronized bundle and existing Codex
authentication in an isolated home and temporary trusted project. It requires a
real native custom-role spawn, keeps the private child out of native discovery,
and runs two sequential private workers with accepted outcomes and a retained
artifact handoff. It verifies the native declaring thread against the ledger and
exercises all six session tools, including a completed-turn fork. Its explicit
client accepts only the fixture's named rolebox tool approvals; managed workers
retain the runtime's default refusal of interactive requests.

The default test uses `workspace-write` with its network restrictions intact.
Alongside graph completion it requires a private worker's out-of-workspace native
patch and command write to be denied, and a connection to a reachable loopback
canary to fail. The host checks the canary, retained probe and worker transcript.
`ROLEBOX_CODEX_E2E_SANDBOX` can select another mode for separate diagnostics; only
the workspace-write run performs these denial checks. The override affects the
temporary test thread.

The harness removes its temporary workspace and writes a sanitized result to
`.rolebox/evidence/codex-live-e2e.json`, including the built server digest and
tested permission mode. Live acceptance is opt-in and is not part of `npm test`.

## The MCP server

The server entry is `rolebox mcp` (which imports `src/entries/codex.ts` and serves until
stdin closes); the package also exports it as `rolebox/codex`
(`dist/entries/codex.js`). Codex starts it from the generated `.mcp.json`. Importing the
module never starts the server or reads stdin, but it is not free of module-level side
effects: the module-level logger opens its log file and installs its `exit`, `SIGINT`
and `SIGTERM` flush handlers on first evaluation.

- **Transport**: newline-delimited JSON-RPC 2.0 on stdin/stdout — one JSON object per
  line. stdout is a protocol-only channel: the entry captures the real
  `process.stdout.write` for the server and redirects everything written to
  `process.stdout` afterwards — a third-party library logging to stdout, or a console
  bound to `process.stdout` — to stderr, so stray output cannot corrupt the stream. That
  guarantee covers writes through `process.stdout` after the guard is installed (both
  `rolebox mcp` and a direct `node dist/entries/codex.js` go through it); it does not
  cover bytes written straight to fd 1, and Node routes global `console.log` through
  `process.stdout`, so it is diverted as well. Both the generated `.mcp.json` and
  the `rolebox` executable use Node.js. An embedder that calls `startCodexMcpServer()` itself gets no
  guard. Diagnostics go to stderr (`[rolebox codex] ...`) and rolebox's own logger writes
  to its log file.
- **Methods**: `initialize`, `ping`, `tools/list`, `tools/call`.
- **initialize**: echoes the client's requested protocol version when it is one of
  `2025-06-18`, `2025-03-26` or `2024-11-05`, and answers `2025-06-18` otherwise;
  advertises `tools: { listChanged: false }` and
  `experimental: { "codex/sandbox-state": {} }` capabilities, plus
  `serverInfo: { name: "rolebox", version: <package version> }`.
- **Notifications**: any message without an id is never answered. Notifications are
  handled the moment they arrive instead of queueing behind the in-flight request, so
  `notifications/cancelled` aborts the running call it names — `requestId`, string or
  number — passing its `params.reason` (default `cancelled by client`) to the abort
  signal the tool context carries. A cancellation for an id that is not in flight, and
  every other notification including `notifications/initialized`, is a no-op. The server
  does not abandon the call: it still finishes with whatever the tool body returns or
  throws and still gets a normal response.
- **tools/list**: every registered tool as `{ name, description, inputSchema }` with a
  JSON Schema object per tool. The list is always one page — a cursor is tolerated and
  ignored, and no `nextCursor` is returned.
- **tools/call**: `{ name, arguments }` returns
  `{ content: [ { type: "text", text }, ... ], isError?: true }`. The first block is
  always the tool's text output; an image attachment then arrives as an MCP
  `{ type: "image", data, mimeType }` block holding the base64 payload. Only a
  `type: "file"` attachment whose mime
  starts with `image/` and whose URL is a base64 `data:` URI is converted; every other
  attachment (a PDF, for instance) and every malformed data URI is dropped, keeping its
  existing text line as its only representation. An unknown tool name, invalid arguments,
  and a tool that throws are all `isError` results carrying a correction, not protocol
  errors — only a malformed `tools/call` envelope (no tool name) is a protocol error.
- **Errors**: malformed JSON line → `-32700` (null id); invalid request → `-32600`;
  unknown method → `-32601`; malformed `tools/call` envelope → `-32602`; internal error
  → `-32603`.
- **Ordering and lifetime**: ordinary requests are handled one at a time and answered
  in request order. `graph_wait` starts after earlier ordinary requests finish, but
  stays pending independently so later queries and `graph_control` can run; its response
  can arrive out of order. Notifications also bypass the queue (above). When stdin
  ends, pending waits are cancelled and queued responses drain before `serve()` closes
  the graph/session runtime and its app-server process trees.
  `SIGINT` and `SIGTERM` also release those descendants. A fatal transport failure
  terminates its process tree and rejects pending calls. Cleanup or connection loss
  does not establish a native turn outcome. The server never calls `process.exit`;
  a boot failure is reported on stderr and sets a non-zero exit code.
- **Thread identity**: host-supplied `tools/call.params._meta.threadId` takes precedence.
  `_meta.sessionId` can be shared by forked threads and is not a worker identity.
  Legacy clients fall back to `ROLEBOX_SESSION_ID`, then a `sessionId` / `sessionID` /
  `session_id` in initialize `clientInfo`, then a connection-specific `codex:<id>`.
  Legacy identity is insufficient to execute graph tools. Native role attribution
  reads the thread's `agentRole`; a stale generated role fails closed.
- **Context**: incoming `_meta` carries host identity and execution authority, separate
  from model-controlled tool arguments. Outgoing `metadata()` and MCP `ask()` remain
  no-ops; there is no rolebox permission-dialog callback. Relative paths resolve
  against the server process's working directory.

## Tool surface on Codex

The MCP server registers 30 base tools. With both optional families enabled, it
registers 65; role and host policies can further restrict execution.

| Group | Tools |
|---|---|
| Files | `hashline_read`, `hashline_edit` |
| Memory | `memory_write`, `memory_recall`, `memory_read`, `memory_list`, `memory_update` |
| Web | `web_search`, `web_read`, `web_fetch` |
| Assets and references | `asset_search`, `asset_inspect`, `asset_validate`, `reference_search`, `load_reference`, `load_role_skill` |
| Runtime | `signal`, `interactive_terminal` |
| Sessions | `session_list`, `session_read`, `session_search`, `session_info`, `session_diff`, `session_fork` |
| Graphs | `graph_declare`, `graph_submit_outcome`, `graph_wait`, `graph_status`, `graph_audit`, `graph_control` |
| Desktop, enabled by default | 12 `computer_*` tools, subject to the global gate and OS permissions |
| Browser, enabled by its gate | 23 `browse_*` tools, with optional Playwright support |

## Sessions and graph execution

Session tools read native Codex threads through app-server, including paginated turn
and item history. Queries default to the current workspace. `session_diff` returns
recorded native file patches, not current file contents. `session_fork` accepts a
completed turn ID or its final message ID; it rejects an in-progress turn or a
mid-turn truncation. Live todos and execution state are available only where this
adapter owns the app-server events. Another process's loaded UI thread can report
`notLoaded` here, which remains unknown rather than being treated as idle.

`graph_declare` uses the shared declared-graph application, ledger and acceptance
rules. The host records each actual worker thread before prompting it. Workers submit
through app-server dynamic-tool callbacks bound to their owning connection, thread,
turn and attempt; a model-supplied identity cannot replace that binding. Explicit
outcomes require accepted `graph_submit_outcome` decisions. A normal end, a failed
turn and an interrupted turn are distinct facts. An interrupt acknowledgment reports
`requested` until Codex reports an interrupted terminal event. An interrupt requested
while `turn/start` is pending is queued and sent once its turn ID is known; queuing
does not confirm interruption.
If an attempt is stopped while its thread is being created, the late acknowledgment
records the thread without starting a model turn.

A fatal connection failure stops the app-server process tree, but an execution with
no native terminal event remains `unknown`. Local shutdown likewise does not invent
a failed, completed or interrupted turn. Initialization failure also closes the
app-server. There is no automatic transport restart or worker retry.

For a delegated launch, rolebox preserves the original opaque
`_meta["codex/sandbox-state"]` and uses the executable in
`_meta["codex/sandbox-launcher"]` to launch `codex exec-server` through
`codex sandbox`. App-server's model requests remain in the host control process.
The executor's native command and filesystem operations remain inside the original
OS policy, including disabled network access under default `workspaceWrite`.
Worker turns declare `externalSandbox` to Codex because the executor already
enforces that OS policy; this prevents a second sandbox from being applied inside
the first. The original opaque policy, not that declaration, remains the execution
boundary.

An authenticated, single-client loopback relay carries only executor RPCs between
app-server and the sandboxed stdio executor. Each worker turn is explicitly bound to
that environment; a missing binding or transport failure refuses execution, with
no local fallback or automatic executor restart. The CLI must support `exec-server`,
`environment/add` and thread/turn environment selection. Missing launch metadata
refuses execution. Changed authority gets a separate runtime; existing workers keep
their original authority. Forks defer goal continuation and their later turns use
the mandatory executor binding.

Managed workers disable plugins, apps, MCP servers, hooks, notifications, memories,
hosted web/image tools, goals, shell snapshots, permission requests and recursive
agents. MCP inventory is checked before model startup, including all pages; only
explicitly disabled servers with empty tool/resource catalogs are accepted.
Interactive approval requests are rejected rather than approved automatically.

The worker's dynamic rolebox tools are `graph_submit_outcome` and allowed role-scoped
resource readers. File edits, shell commands and other task operations use native
Codex tools inside the inherited sandbox. Mutating outer-process tools such as
`hashline_edit` and `interactive_terminal` are not exposed through that callback.
Only native worker presentation is supported; `discover` and `code` are refused.

After `graph_declare`, inspect `parent_notification.available`. When `true`, the
adapter has verified that the parent thread is already loaded in the shared
app-server. End the current turn while workers run; do not hold `graph_wait` or
poll status. The durable graph notifier submits `[GRAPH COMPLETE]` / `[GRAPH BLOCKED]`
as `turn/start.toolOutput` to that same host. An idle parent starts a new turn;
an active parent receives the output in its existing turn. Delivery uses stable
notification IDs and retry leases. An uncertain RPC acknowledgment may result in
repeat delivery, so notifications identify themselves for deduplication by the
receiver. The notification asks the parent to inspect committed status once and
continue or report the result.

The connection auto-discovers `<codex-home>/app-server-control/app-server-control.sock`
at startup. `ROLEBOX_CODEX_PARENT_SOCKET` accepts an absolute custom socket path or
`off`; an explicit value takes precedence. The adapter only uses existing Unix
WebSocket listeners and checks `thread/loaded/list` before declaration and delivery.
It never starts another server or cold-resumes the parent. Closing rolebox closes
its client socket, not the shared host. Unavailable delivery stays in the durable
outbox for retry.

For a CLI main session, start `codex app-server --listen unix://`, then connect the
main client with `codex --remote unix://`. For a custom path, use
`--listen unix:///path/to/control.sock`, `--remote unix:///path/to/control.sock` and
`ROLEBOX_CODEX_PARENT_SOCKET=/path/to/control.sock` for that same host. A desktop
stdio session does not acquire this capability merely because another daemon was
started; without its own shared endpoint it reports `available: false`. See
[Desktop launch adapter](#desktop-launch-adapter-experimental) for a desktop-owned
host, or [Desktop shared host](#desktop-shared-host-experimental) for an external
daemon and its desktop-tool limitation.

When the notification channel is unavailable, call `graph_wait` with the returned
`graph_id` as a fallback instead of repeatedly polling `graph_status`.
The tool waits for the entire selected run to complete,
stop, or need attention, then returns `{ graph_id, run_id, status, reason, notices,
graph }`. `graph` is the committed JSON status snapshot, with accepted output
included by default and node prompts omitted. Ordinary intermediate node completion
does not return the wait. Continue dependent work only when `status` is `complete`;
handle `attention` or `stopped` results before proceeding. An approval pause, failed
attempt, unavailable inputs, or a completed execution without a settled outcome can
require attention.

`run_id` is optional and pins the current run when waiting starts; an explicit ID
can select an archived run. A retry does not redirect an existing wait to another
run. `timeout_ms` is an integer from `1` to `540000`, default `540000`, below the
generated plugin's 600-second MCP tool timeout. On `status: "timeout"`, call
`graph_wait` again with the returned graph and run IDs. Set `include_output: false`
to omit accepted data from the snapshot. Only the declaring session can wait;
workers cannot use this tool. Committed changes wake waits in-process, with a
one-second server-side check covering other processes and execution observations.

Cancelling the tool, ending the MCP input, or closing the runtime releases waits
with `status: "cancelled"`; it does not cancel graph execution. Use `graph_control`
for explicit lifecycle changes and `graph_status` for targeted inspection. Waiting
keeps the current turn open. Without a verified parent channel, a new stdio
app-server cannot wake an external UI-owned chat after that turn ends.
Restart Codex after updating the installed plugin so its
tool inventory and entry instructions refresh. Boot does not redispatch persisted
work automatically. Lost execution ownership remains unknown;
the adapter retains uncertain create claims rather than creating another worker.
Attempt credential values are not retained durably. Node `max_input_tokens`,
`max_output_tokens` and `max_cost_usd` budgets are refused because this adapter does
not collect measured token/cost usage. Execution-count budgets and node timeouts
remain supported. A positive node `timeout_ms` starts at attempt delivery, including
thread/turn startup time. Its watchdog records a durable timeout control for that
exact attempt and requests interruption; it does not confirm cancellation. Zero
disables the timeout, and expiry never retries the attempt automatically.

### Desktop launch adapter (experimental)

`rolebox host codex desktop prepare` prepares a separate startup executable selected
through the desktop's internal `CODEX_CLI_PATH` override. On Unix with
`process.execve` support, it hands its PID to the original CLI, preserving the
desktop as that CLI's direct parent. A child relay retains the desktop's stdio
and forwards its JSON-RPC messages to the original CLI's Unix WebSocket listener.
The relay sends no additional initialization and preserves client metadata,
requests, responses and notifications. The original host receives the desktop's
MCP environment and launches its bundled tools itself.

Desktop implementation and its internal process modules live together under
`platform/adapters/codex/desktop`; `entries/` holds the public harness entries.
The generated executable and JSON contain absolute paths into the installed
build. When upgrading from the earlier experimental `dist/entries/codex-desktop-*`
layout, prepare a replacement at a new output path and select it with
`CODEX_CLI_PATH` before reopening the desktop. Rebuilding the package alone does
not migrate previously generated files.

Create a configuration using the current desktop's original executables:

```json
{
  "codexPath": "/path/to/desktop-runtime/codex",
  "nodePath": "/path/to/desktop-runtime/node",
  "desktopExecutable": "/path/to/desktop/main-executable",
  "socketPath": "/path/to/private/desktop-control.sock",
  "logPath": "/path/to/private/desktop-launcher.jsonl",
  "startupTimeoutMs": 15000,
  "maxMessageBytes": 104857600
}
```

All paths must be absolute; the three executables must exist and be executable.
Use a short socket path inside an owner-only directory. `startupTimeoutMs`
defaults to `15000`, accepts `100`–`60000`, and only bounds listener startup.
The relay's readiness handshake is capped at the smaller of that value and five
seconds. Graph execution has no launcher-imposed deadline. `maxMessageBytes` defaults to
100 MiB and accepts `1024`–`104857600`; it bounds each JSONL message and incoming
WebSocket message. Partial lines are buffered without repeated copies; outgoing
text fragments are at most 1 MiB and wait for the previous write callback before
another is queued. stdin stays paused while those messages are draining. The
100 MiB default retains support for large desktop requests; lower it when a
smaller message limit fits the workload. The adapter
records event codes and process IDs without logging protocol contents or startup
arguments. Keep the prepared executable and its adjacent JSON in a private
directory. Preparation refuses an existing output directory unless it is owned
by the invoking user with owner-only permissions. The JSON is owner-readable/writable only.

On the checked macOS desktop, prepare and activate with:

```sh
rolebox sync codex
codex plugin add rolebox@rolebox
rolebox host codex desktop prepare --config /path/to/launcher-input.json \
  --output /path/to/private/codex-desktop
launchctl setenv CODEX_CLI_PATH /path/to/private/codex-desktop
launchctl unsetenv CODEX_APP_SERVER_WS_URL
```

Save any existing values first. Finish active turns and background graphs, fully
quit the desktop and reopen the same chat. If moving from an external daemon,
disable any per-login job that restores its URL; stop that host only after its
clients and workers are idle. On the checked desktop build `26.1103.60933`, the
URL takes precedence over the startup adapter.
The adapter sets `ROLEBOX_CODEX_PARENT_SOCKET` on its original host, which the
rolebox MCP inherits. It converts only a direct stdio `app-server` invocation
from the configured desktop parent with the desktop originator. Worker launches,
inspection commands, subcommands and explicit non-stdio transports pass through.
The activation gate requires `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` to equal
`Codex Desktop`, as supplied by the desktop, and the parent's resolved executable
to match `desktopExecutable`. Do not set that variable to force activation from
another process. In `native_passthrough` events, `desktopParent: false` means the
parent check failed; `parentCheck` is `matched`, `different_executable` or
`unresolved` (for example, `ps` returned a bare command name). With
`desktopParent: true` and `desktopOriginator: false`, the caller is another desktop
invocation. `startupInspection: true` identifies the configuration probe. A
matching parent and originator can still pass through inspection commands,
subcommands or explicit non-stdio transports. No process arguments are logged.

The installed rolebox plugin must forward `ROLEBOX_CODEX_PARENT_SOCKET` in its
`.mcp.json` `env_vars`. `sync` updates the marketplace source; `plugin add`
refreshes the installed cache. An older cache can restore desktop tools while
still returning `parent_notification.available: false` for graphs. Reload the
MCP configuration or restart after refreshing it, then check the capability again.
The checked app-server accepts `config/mcpServer/reload` with omitted parameters
on an initialized app-server connection. This reload covers loaded threads in
that host; finish active turns and graph executions first. It applies the updated
MCP environment without restarting the desktop. Hosts without this method need
a full desktop restart.
Keep unrelated plugin sections outside rolebox's managed `config.toml` markers
before syncing; everything between those markers is regenerated.

An already-running terminal or restart helper can still inherit the old external
URL after `launchctl unsetenv`. On macOS, explicitly supply the next app's startup
environment when reopening it:

```sh
open --env CODEX_CLI_PATH=/path/to/private/codex-desktop \
  --env CODEX_APP_SERVER_WS_URL= --env CODEX_APP_SERVER_USE_LOCAL_DAEMON= \
  -a /path/to/desktop.app
```

Check that the desktop selects its stdio frontend and that the launcher records
`desktop_shared_start`, `native_cli_exec` and `relay_connected`. A
`native_passthrough` event with `startupInspection: true` only establishes that
the desktop ran its configuration probe; it does not establish a shared launch.
When opening an existing local chat through a deep link, specify
`codex://threads/THREAD_ID?hostId=local` after the host is ready. A link without
`hostId` depends on the desktop's host catalog being ready to resolve the chat.

An existing socket is refused rather than removed or adopted. After a crash,
verify that no process owns it before removing a stale socket or selecting a new
path. EOF on the desktop protocol or a lost relay connection stops only the
relay's own host. Closing a secondary graph notification client preserves it.
The relay sends SIGTERM, waits for its original parent to exit and escalates to
SIGKILL after 500 ms only if it is still that process's child. Post-readiness
fatal errors record `relay_runtime_failed` and use the same cleanup. Forced
termination can leave a stale socket; the launcher still refuses to delete or
adopt an existing socket automatically. Only `PATH`, `TMPDIR`, `TMP` and `TEMP`
are forwarded to the relay. The original CLI retains the desktop environment,
including the native MCP bindings.

This uses internal desktop startup options and needs validation after desktop
updates. Native IPC authorization remains enforced by the desktop. Verify the
original CLI's parent, a working native `codex_app` call in the same chat, and a
real graph completion after the main turn ends. A reachable socket or a successful
MCP handshake alone does not establish desktop-tool recovery. If ownership is
unavailable, `graph_wait` remains the fallback.

On macOS desktop `26.1103.60933` with CLI `0.167.0-alpha.3.2`, the adapter preserved
the original CLI as the desktop's direct child, and the same chat discovered 50
native `codex_app` tools. Native `read_thread` and `list_threads` calls succeeded;
the current desktop log recorded no peer rejection. This verifies those read
operations; write operations were not exercised by the acceptance probe.
After refreshing the rolebox cache and reloading MCP, a new real teacher node
continued its 65-second delay after the main turn ended. Its accepted `done`
outcome automatically started a new turn in that same desktop chat. The live
probe used no `graph_wait` or status polling; `graph_status` was read once after
the completion notification. A native `read_thread` call also succeeded in the
woken turn. This verifies desktop tools and graph wake together on that build.

`npm run build && npm run test:codex:launcher` runs the original CLI with an isolated
home and loopback model fixture. `ROLEBOX_CODEX_COMMAND` selects that CLI;
`ROLEBOX_CODEX_DESKTOP_NODE` optionally selects the launcher runtime. It verifies
PID preservation, stdio forwarding, a second client, graph-triggered continuation
after parent completion, notifier disconnection and desktop-EOF cleanup. It
checks for missing/stale launcher build entries before creating its temporary
home or model server, and uses a short socket path with `?` and `#` to verify
literal Unix path handling in the selected CLI. It does not exercise native
desktop IPC authorization or use real model credentials.

For rollback, restore the previous `CODEX_CLI_PATH` and
`CODEX_APP_SERVER_WS_URL` values, or unset them if previously absent, remove any
per-login adapter setup, and fully restart the desktop. Restore an external daemon
setup when that was the previous configuration. The generated files alone have
no effect on an already-running desktop.

### Desktop shared host (experimental)

The macOS desktop build checked with bundled CLI `0.167.0-alpha.3.2` accepts
`CODEX_APP_SERVER_WS_URL`. Its WebSocket client supports a Unix socket URL, so
the desktop and rolebox can share the control socket without a TCP listener.
This is an internal desktop option, not a stable cross-version interface. This
section connects the desktop to an external daemon; the
[launch adapter](#desktop-launch-adapter-experimental) instead keeps the host
under the desktop process.

Use the same CLI build as the desktop runtime:

```sh
codex -c features.code_mode_host=true app-server daemon start
rolebox_codex_home="${CODEX_HOME:-$HOME/.codex}"
launchctl setenv CODEX_APP_SERVER_WS_URL \
  "ws+unix://localhost${rolebox_codex_home}/app-server-control/app-server-control.sock:/rpc"
```

Finish active turns, fully quit the desktop app, then reopen the same chat.
The desktop must load that chat in the shared server. Rolebox discovers the
existing socket when its MCP process starts and verifies ownership through
`graph_declare.parent_notification.available`. Neither starting the daemon nor
setting the URL alone establishes that ownership. The retained
`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` path requires empty startup overrides;
the automatic desktop MCP override prevents that path in this build.

Acceptance was checked with an existing desktop chat and a real rolebox worker:
the main turn ended while the node was running, the worker's `done` outcome was
accepted, and `[GRAPH COMPLETE]` started a new turn in the same chat. No
`graph_wait`, status polling, or test chat was used to keep the parent alive.

**Desktop-tool limitation:** in this shared configuration, the bundled
`codex_app` MCP server failed because the daemon did not receive
`CODEX_APP_TOOLS_PIPE_PATH`. Its chat-management and automation tools were
unavailable; rolebox graph execution and native command tools remained usable.
Passing the current pipe and desktop Node runtime through the adapter allowed
MCP initialization, but `tools/list` failed with `-32603`. The desktop recorded
`dynamic_app_tools_peer_rejected reason=untrusted-process-ancestry`. An isolated
app-server launching the original MCP produced the same native rejection without
loading a real chat. The supplied Node had the same signing team as the desktop;
the native process-ancestry check still rejected this launch chain. This setup
therefore does not provide full desktop-tool parity. Rejection occurs when the
desktop accepts the native socket, before it dispatches a tool request. Related upstream reports cover the
[daemon-selection guard](https://github.com/openai/codex/issues/41014) and
[shared-host app-tool binding](https://github.com/openai/codex/issues/47425).

The `launchctl` environment lasts for the login session. A persistent setup
needs a user LaunchAgent that starts the daemon and sets the URL before the
desktop launches. To restore the normal desktop connection, remove that
per-login setup if installed, run the following, and fully restart the desktop:

```sh
launchctl unsetenv CODEX_APP_SERVER_WS_URL
```

This changes the next desktop launch; it does not stop the shared daemon or its
other clients. Recheck ownership and actual wake delivery after a host update.

#### Desktop IPC bridge probe

`rolebox host codex desktop probe` tests the adapter's connection to the original
bundled `codex_app` MCP. Supply a JSON binding from the current desktop launch:

```json
{
  "pluginRoot": "/path/to/codex-app-tools",
  "nodePath": "/path/to/desktop-runtime/node",
  "pipePath": "/path/to/current-desktop.sock"
}
```

`pluginRoot` contains the desktop's original `.mcp.json`; `nodePath` is its
`CODEX_MCP_NODE_PATH`. The current desktop main-process log records `pipePath`
in `dynamic_app_tools_listening`. Select the log for the current desktop process
and refresh this binding after a desktop restart. The probe requires a private
Unix socket owned by the invoking user and uses the original bundle's launcher
and environment whitelist.

```sh
rolebox host codex desktop probe --binding /path/to/binding.json \
  --thread THREAD_ID --socket /path/to/app-server-control.sock \
  --peer-log /path/to/current-desktop-main.log --report /path/to/report.json
```

`--thread` defaults to `CODEX_THREAD_ID`; `--socket` uses the same discovery as
parent notifications. `--timeout-ms` bounds the MCP handshake, discovery and read
to one deadline, from `1` through `60000`, default `10000`. The optional peer log
only contributes complete rejection lines appended during this attempt. It is
opened before probing and identified through its descriptor; a replacement log
is not treated as evidence. Failed handshakes may wait up to another 500 ms for
the host's log flush. Reports contain stages and reason codes, not pipe paths,
environment values or chat contents.

`--max-response-bytes` bounds each MCP JSONL response line independently of the
launcher's `maxMessageBytes`: default `16777216` (16 MiB), range
`1024`–`104857600`. It accepts coalesced lines separately and buffers fragmented
UTF-8 until a full line is available. A response exceeding this limit reports
`response_too_large`, rather than `invalid_protocol`.

stdout and `--report` use the same JSON structure:

```json
{
  "bridge": {
    "status": "ready",
    "stage": "tools/call",
    "code": "verified",
    "toolCount": 1,
    "readOnlyToolVerified": true
  },
  "parentNotificationAvailableAfter": true,
  "hostConfigurationChanged": false
}
```

`bridge.status` is `ready` or `blocked`; `stage` is `parent`, `binding`,
`initialize`, `tools/list` or `tools/call`. `code` is a stable diagnostic:
`verified`, `parent_unavailable`, `invalid_binding`, `invalid_timeout`,
`invalid_response_limit`, `cancelled`, `timeout`, `process_unavailable`,
`transport_closed`, `invalid_protocol`, `response_too_large`, `ipc_closed`,
`host_context_missing`, `mcp_refused`, `read_tool_unavailable`,
`read_result_unverified`, `peer_rejected`, `invalid_request` or `probe_failed`.
MCP refusals can add numeric `mcpErrorCode`; verified fresh log evidence adds
`peerRejection: { reason, timestamp }`. Counts are integers and the remaining
flags are booleans. `parentNotificationAvailableAfter` is a fresh ownership check
after probing; it is independent of bridge success. `hostConfigurationChanged`
is always false. The report file is owner-readable/writable only, including when
overwriting an existing file.

The probe verifies shared-host ownership, initializes MCP, discovers all tool
pages, and calls only `read_thread` for the selected chat. Exit `0` and
`readOnlyToolVerified: true` mean that connection read the correct chat. Exit `2`
means blocked. Exit `1` covers command/input/report failures; those need not
produce a JSON report. `peer_rejected` requires a new desktop rejection event, while an
IPC closure without that evidence remains `ipc_closed` or `transport_closed`.
The command does not install a host configuration override or restore the
desktop's native tool inventory. A successful probe is a prerequisite for that
separate integration. On the checked build it stops at native ancestry rejection,
leaving the existing graph notification channel configured as before.

## Not supported on Codex yet

- `dispatch_*`, `loop_*`, `task_*`, `lsp_*`, `function_graph`, `skill_compose` and
  `context_assemble`; use the registered graph tools for orchestration.
- Role switching (no in-session active-role switcher).
- TUI (the interactive terminal UI binary is opencode-only).
- Hot reload (`asset_hot_reload` and the hot-reload service).
- The extension loader (the PluginCore `ExtensionService`).
- Hooks-driven activation (`chat.message` / `session.idle` / tool interception) in native
  UI conversations. Managed worker events do not install PluginCore hooks into Codex.

## Removing the integration

- `rolebox uninstall <role>` removes an installed role, then sweeps every registered
  sync target — including `{codexHome}/rolebox` — and removes the links that point at
  that role. Links belonging to other roles are left alone, and the sweep is
  best-effort: it never touches a real directory or file.
  Re-run `rolebox sync codex` and restart Codex to remove unchanged generated native
  files for roles that are no longer installed; edited files remain preserved.
- The generated bundle and the managed block are removed by
  `removeCodexPluginBundle(codexHome)` (removes `{codexHome}/rolebox-marketplace`) and
  `unregisterCodexPlugin(configPath)` (removes every managed block — a hand-edited
  duplicate included — restoring the surrounding bytes). Both are exported from
  `src/platform/adapters/codex/plugin-bundle.ts` and the Codex adapter barrel, but **no CLI
  command currently calls them** — today the removal is manual: delete
  `{codexHome}/rolebox-marketplace` and the block between the two `rolebox (managed)`
  marker comments in `{codexHome}/config.toml`. Neither function touches
  `{codexHome}/skills` or `{codexHome}/rolebox`.
