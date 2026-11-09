# Configuration and hosts

## Locations

Each harness home has the same rolebox layout:

```text
<harness-home>/
  rolebox/<role-id>/role.yaml
  role_config.yaml
  functions/<function-name>.md
  skills/<skill-name>/SKILL.md
```

| Harness | Home directory, in precedence order |
| --- | --- |
| OpenCode | `$XDG_CONFIG_HOME/opencode`, otherwise `~/.config/opencode` |
| Pi | Non-blank `$PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent` |
| DSH | Non-blank `$DSH_HOME`, otherwise `~/.dsh` |
| Codex | Non-blank `$CODEX_HOME`, otherwise `~/.codex` |

The workspace's `rolebox/`, when present, replaces `<harness-home>/rolebox/` as
the role discovery root. It does not relocate global skills, functions or
`role_config.yaml`. DSH plugin options `roleboxDir` and `skillsDir` can override
those two directories explicitly.

Separate CLI state from runtime role settings:

| File or directory | Purpose |
| --- | --- |
| `<rolebox-config-home>/config.yaml` | Role registry sources, global feature gates and the global `copilot.draft` fallback |
| `<rolebox-config-home>/rolebox.lock` | CLI-managed installed versions and integrity |
| `<rolebox-data-home>/roles/<registry>/<role-id>@<version>` | Shared installed role source |
| `<harness-home>/rolebox/<role-id>` | `rolebox sync` link to that source |
| `<harness-home>/role_config.yaml` | Harness-specific model aliases |
| `<workspace>/.rolebox/config.json` | Project default role, feature gates and the project `copilot.draft` fallback |

`rolebox registry add|remove|default` rewrites only the `registries` key of
`config.yaml` and preserves every other top-level key, including the global
feature gates and the `copilot` block.

Rolebox config home: `$ROLEBOX_CONFIG_DIR`, then `$XDG_CONFIG_HOME/rolebox`, then
`%APPDATA%/rolebox` on Windows or `~/.config/rolebox` on Unix/macOS.
Data home: `$ROLEBOX_DATA_DIR`, then `$XDG_DATA_HOME/rolebox`, then
`%LOCALAPPDATA%/rolebox` on Windows or `~/.local/share/rolebox` on Unix/macOS.
Do not confuse either home with the active harness home.

Synced role paths share their source across harnesses. Editing through one link
changes that shared role. For a project-specific variant, use the workspace role
tree. Avoid editing generated agent files or the lock file by hand.

## CLI operations

Rolebox requires Node.js 26.4 or later. Common commands:

```sh
rolebox list
rolebox search reviewer
rolebox install example-registry:reviewer@1.0.0
rolebox sync opencode
rolebox sync pi
rolebox sync dsh
rolebox sync codex
rolebox config reviewer
rolebox status --json
rolebox info reviewer
```

Use only the sync target the user intends. Installation of a registry role stores
it in the shared source; sync deploys the role to a harness. `config <role>` is an
interactive model configuration command, not an arbitrary configuration setter.
Use `rolebox <command> --help` for flags supported by the installed executable.

Host connection adapters use `rolebox host <harness> <connection> <action>`.
Use `rolebox host --help` to discover supported harnesses, then each group's
`--help` to discover its connections and actions. Currently only
`rolebox host codex desktop prepare` and `rolebox host codex desktop probe` are
implemented; both are experimental Unix commands. Select every level explicitly;
there is no default harness or action, and unknown names fail without falling back
to another adapter. Socket paths, native IPC bindings, permissions and activation
are adapter-specific. This command group does not install roles, synchronize them
or automatically activate a connection. The Codex instructions below describe
the supported configuration and acceptance checks.

A normal sync preserves divergent real role directories. `--relink` explicitly
copies each such directory to a timestamped backup and replaces it with a link.
Use that option only when reconciliation is intended.

Registry entries in `config.yaml`:

```yaml
registries:
  - name: example-registry
    url: https://github.com/example/roles
    ref: main
    default: true
```

The built-in `oh-my-role` registry is available without listing it. Source kind
is inferred from the URL: GitHub repository, GitLab project URL containing `/-/`,
or HTTP `.yaml` manifest. Do not add the retired `kind` field. Prefer
`rolebox registry --help` and the CLI to manipulate registry state.

The same global `config.yaml` holds the lowest-precedence `copilot.draft`
fallback (role > project > global), read once at plugin boot:

```yaml
copilot:
  draft:
    enabled: true
    provider: example-provider
    model: example-model
```

Only `enabled`, `provider`, `model`, `timeout_ms`, `max_chars`, `window_size`
and `transcript_max_chars` are read. `enabled` is three-state — a present
`true`/`false` wins, an absent value inherits from another source, and the final
default is `false`. Fields merge individually. An invalid value warns once and is
treated as absent so a lower source can supply it. Merge the `copilot` key with
existing values; the registries and other keys are independent. Edit this file
and restart the host or reload the plugin; there is no watching.

## Harness registration

Syncing roles and registering the plugin are separate operations, except for
Codex where `rolebox sync codex` also writes and registers a local marketplace.

| Harness | Integration |
| --- | --- |
| OpenCode | Register `rolebox` in the host's `plugin` array; the 2.x server entry is `rolebox/server` |
| Pi | Load the package's Pi extension, `rolebox/pi`, through the host package/extension mechanism |
| DSH | Install the `rolebox` bundle with the host plugin manager; the package ships `dsh/cordis.patch.yml` |
| Codex | Run `rolebox sync codex`, then `codex plugin add rolebox@rolebox` to install or refresh the local cache; restart Codex |

Use the host's own documentation for its installation command and provider
configuration. The built-in skill's synchronization itself does not register a
plugin, enable an MCP server, or install a model provider.

DSH graph and loop workers support published `0.2.1-rc.3` hosts and source hosts
with flattened activation task options, including `0.2.2-rc.1`. No plugin option
selects the activation layout. After updating a locally linked rolebox checkout,
rebuild rolebox and restart DSH so the host loads the updated `dist/` entry.
Graph recovery also supports both host catalog APIs (`listChildren` and
`listDescendants`); it correlates only direct children of the declaring session.
Missing or ambiguous catalog evidence keeps an execution unresolved rather than
automatically launching another worker.

### Codex native agents and session execution

Codex sync creates `<codex-home>/rolebox-marketplace`, a plugin manifest, a skills
link and an MCP configuration launching `dist/entries/codex.js` with Node. It updates
one managed block in `config.toml`, preserving other text, and exports public roles
to `<codex-home>/agents/rolebox--<role-id>.toml`. A fingerprint manifest at
`<codex-home>/rolebox-agents.json` tracks generated files. Unmanaged files, symlinks
and local edits are preserved with warnings; only unchanged tracked files are
updated or removed.

Sync registers and enables the marketplace entry; Codex's plugin installation
populates its cache. Run `codex plugin add rolebox@rolebox` after first sync or to
refresh the bundle. The generated MCP configuration forwards the launching
process's `CODEX_HOME`, `ROLEBOX_CONFIG_DIR`, `ROLEBOX_DATA_DIR`,
`ROLEBOX_CODEX_COMMAND`, `ROLEBOX_SESSION_ID` and `ROLEBOX_CODEX_PARENT_SOCKET`
by name. Unset values stay unset;
their contents are never embedded in the bundle. Restart Codex after changes.
The same whitelist forwards uppercase and lowercase `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY` and `NO_PROXY`, plus `SSL_CERT_FILE`, `SSL_CERT_DIR` and
`NODE_EXTRA_CA_CERTS`. This preserves the model connection's transport settings
for app-server workers; it does not alter the inherited sandbox policy.

CLI sync exports the installed global role tree. When the MCP server boots with a
workspace `rolebox/` tree, it instead generates that tree's public native agents
under `<workspace>/.codex/agents/` and its manifest under `<workspace>/.codex/`.
Codex must trust the project before loading its native agent configuration;
rolebox does not grant project trust.
It does not export project roles globally. Restart Codex after generation to refresh
the native catalog. For an ordinary ID `reviewer`, ask Codex to delegate using
`rolebox--reviewer`. Unusual IDs have a stable sanitized name and suffix;
use the generated TOML `name`.

Private children remain canonical runtime targets such as `reviewer--researcher`.
They are not exported into Codex's global native-agent discovery. Use them through
the owning role's graph; see [Roles](roles.md#codex-role-mapping) and
[Orchestration](orchestration.md#codex-execution).

Session browsing uses a lazy `codex app-server` process. `ROLEBOX_CODEX_COMMAND`
optionally names its executable when `codex` is not on `PATH`; it is a single
executable path, not a shell command. Graph execution and session forks require
host-supplied `_meta.threadId`, `_meta["codex/sandbox-state"]` and
`_meta["codex/sandbox-launcher"]`. The MCP handshake opts into that Codex extension.
The host's launcher and original opaque policy determine delegated execution.
Model requests remain in app-server; native command/filesystem tools use a separate
sandboxed `exec-server` selected for every worker turn. The authenticated loopback
transport is host-owned, bound to that authority and removed on runtime close;
it grants no network access to worker commands. Codex must support `environment/add`
and acknowledge the selected thread environment; no local execution fallback is
used. The executable override does not replace execution authority. Missing capability
refuses the operation, so update Codex and restart its MCP connection. The protocol
was checked against `0.166.0-alpha.5.1`; rolebox enforces capabilities rather than a
numeric Codex version.

Graph parent notifications use an existing shared app-server Unix socket. With
`ROLEBOX_CODEX_PARENT_SOCKET` unset or blank, startup discovers
`<codex-home>/app-server-control/app-server-control.sock` if it exists. Set an
absolute path to select another socket, or `off` to disable parent notifications.
An explicit path takes precedence over discovery. This does not start a daemon,
resume an external thread, or expose a new listener. The selected server must
already own the loaded parent thread; `graph_declare.parent_notification.available`
reports the actual per-session probe. A missing socket, refused connection or
unowned thread selects the `graph_wait` fallback.

For a CLI parent, start `codex app-server --listen unix://` and connect the main
client with `codex --remote unix://`. Custom sockets require the same path on the
server, main client and `ROLEBOX_CODEX_PARENT_SOCKET`. Starting another server does
not attach an already-running desktop stdio conversation. That conversation stays
in fallback mode until its host provides a shared connection. Refresh the plugin
with `rolebox sync codex` and `codex plugin add rolebox@rolebox`, then restart Codex
to load the environment whitelist and new entry instructions.

The runtime registers 30 base tools, including six `session_*` and six `graph_*`
tools; gated desktop/browser families add up to 35. Per-call thread identity binds
native role policy and graph submissions. Project `defaultRole` does not select a
native agent or replace the current conversation's prompt. Codex native UI hooks,
hot reload and an in-session role switcher are not installed by this integration.

#### Desktop launch adapter (experimental)

`rolebox host codex desktop prepare` prepares a separate Unix startup executable for
the desktop's internal `CODEX_CLI_PATH` override. It requires a Node runtime with
`process.execve`, and the original desktop CLI with Unix WebSocket support.
It hands its PID to that CLI so the desktop remains the direct parent. A relay
retains the desktop's stdio, forwarding its unchanged protocol messages to the
CLI's Unix listener. The original host inherits desktop MCP bindings and starts
the original bundled tools. Native desktop IPC authorization remains enforced.

The launcher and relay are internal adapter processes, built under
`dist/platform/adapters/codex/desktop/`. Generate their paths with `prepare`
rather than writing them into a wrapper manually. Earlier experimental builds
placed those processes under `dist/entries/codex-desktop-*`; existing generated
executables and JSON retain those absolute paths after a rebuild. Prepare a new
output path and select it with `CODEX_CLI_PATH` before the next desktop launch
when upgrading from that layout.

Create an input JSON using the current desktop's original executable paths:

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

All paths are absolute; the three executables must exist and be executable.
Use a short socket path in an owner-only directory. `startupTimeoutMs` accepts
`100`–`60000` milliseconds, default `15000`; it bounds startup, not graph duration.
The relay readiness handshake is capped at the smaller of this value and five
seconds; the Unix listener uses the configured startup deadline.
`maxMessageBytes` accepts `1024`–`104857600`, default 100 MiB, and bounds each
JSONL message and incoming WebSocket message. Partial lines are buffered without
repeated copies. Outgoing text frames are at most 1 MiB; each waits for the
previous write callback, with stdin paused while queued messages drain. The
default supports large desktop requests; select a lower limit for smaller
workloads. Logs contain event codes and process IDs, excluding protocol contents
and launch arguments.

```sh
rolebox sync codex
codex plugin add rolebox@rolebox
rolebox host codex desktop prepare --config /path/to/launcher-input.json \
  --output /path/to/private/codex-desktop
launchctl setenv CODEX_CLI_PATH /path/to/private/codex-desktop
launchctl unsetenv CODEX_APP_SERVER_WS_URL
```

The preparation command writes a new executable and its owner-only adjacent JSON,
refusing existing outputs; it does not activate them. The output directory must
be owned by the invoking user with owner-only permissions, including when it
already exists. Keep both files there. Save previous launch environment values before activation. Finish all
active turns and background graphs, fully quit the desktop, then reopen the same
chat. Disable any per-login job that restores an external daemon URL; stop that
daemon only after its clients and workers are idle. `CODEX_APP_SERVER_WS_URL`
selects the external transport before the startup executable is used on the
checked desktop build `26.1103.60933`.

Refresh both the marketplace source and the installed plugin cache as shown
above. Keep unrelated plugin sections outside rolebox's managed `config.toml`
markers before syncing; that entire block is regenerated. The installed rolebox `.mcp.json` must include
`ROLEBOX_CODEX_PARENT_SOCKET` in `env_vars`. With an older cache, desktop tools
can work while graph declarations still report `parent_notification.available:
false`. Reload MCP configuration or restart the desktop after refreshing the
cache, then verify that per-chat capability again.
The checked app-server supports `config/mcpServer/reload` with omitted parameters
on an initialized connection to that same app-server. The reload affects its
loaded threads, so finish active turns and graphs first. It refreshes MCP's
environment without restarting the desktop. Use a full restart on hosts without
that method; this is an app-server request, not a rolebox MCP request.

An existing terminal or restart helper can retain the previous URL in its own
environment. When reopening on macOS, explicitly supply the app's new environment:

```sh
open --env CODEX_CLI_PATH=/path/to/private/codex-desktop \
  --env CODEX_APP_SERVER_WS_URL= --env CODEX_APP_SERVER_USE_LOCAL_DAEMON= \
  -a /path/to/desktop.app
```

Verify the desktop selected its stdio frontend and the launcher recorded
`desktop_shared_start`, `native_cli_exec` and `relay_connected`. A
`native_passthrough` event with `startupInspection: true` covers only the desktop's
configuration probe, not its actual host launch.
For an existing local chat, open
`codex://threads/THREAD_ID?hostId=local` after host initialization. Omitting
`hostId` relies on the desktop's host catalog resolving that chat at launch.

Only the configured desktop's direct stdio `app-server` launch with the desktop
originator is converted. Workers, inspection commands, subcommands and explicit
non-stdio transports pass through to the original CLI. The host receives
`ROLEBOX_CODEX_PARENT_SOCKET`; the rolebox MCP's environment whitelist forwards it.
It verifies the declaring chat's loaded ownership before notification delivery.
Do not set that variable to another host or `off` when testing wake delivery.
The desktop must supply `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop`, and
the parent's resolved executable must match `desktopExecutable`. Do not set the
originator yourself to force another process through this gate. For
`native_passthrough`, `desktopParent: false` means the parent check failed;
`parentCheck` is `matched`, `different_executable` or `unresolved` (including a
bare command name from `ps`). `desktopParent: true` with
`desktopOriginator: false` identifies a different desktop invocation.
`startupInspection: true` means only configuration inspection ran; inspection,
subcommands and non-stdio transports can pass through even when both gates match.

Existing sockets are refused without deletion or attachment. Verify that a socket
is stale before removing it after a crash, or select a new private socket path.
Desktop EOF or relay loss stops only its own original host; disconnecting a
notification client leaves that host running. SIGTERM is followed by SIGKILL
after 500 ms only while the relay is still that host's child; the relay waits for
parent exit. Fatal errors after readiness log `relay_runtime_failed` and follow
the same cleanup. Forced termination can leave a stale socket, which is still
refused at startup. The relay inherits only `PATH`, `TMPDIR`, `TMP` and `TEMP`;
the original CLI retains the desktop's MCP bindings and other environment.
These internal desktop options
require revalidation after updates. Verify an actual native `codex_app` tool in
the same chat and graph completion starting a new main turn after the previous
turn ends. Startup or MCP initialization alone does not establish tool recovery.
Use `graph_wait` when `parent_notification.available` is false.

The checked macOS desktop `26.1103.60933` with CLI `0.167.0-alpha.3.2` discovered
50 native `codex_app` tools in the same chat. Native `read_thread` and
`list_threads` calls succeeded with the original CLI directly parented by the
desktop; its log recorded no peer rejection. Other native tool operations still
require their normal host permissions and were not individually exercised.
After the installed cache refresh and MCP reload, a new real teacher worker
remained in its 65-second delay when the main turn ended. Its accepted `done`
outcome started a new turn in the same desktop chat. The live probe used neither
`graph_wait` nor status polling; one `graph_status` read followed the notification.
A native `read_thread` call in the woken turn still succeeded. `graph_wait`
remains the fallback when the declaring chat's notification probe is unavailable.

For rollback, restore the previous `CODEX_CLI_PATH` and
`CODEX_APP_SERVER_WS_URL` values, unsetting values that were previously absent.
Remove any per-login adapter setup and fully restart the desktop. Restore the
external daemon setup if it was the previous mode. Environment changes apply
to the next launch; deleting generated files does not update a running host.

#### Desktop shared host (experimental)

The macOS desktop build checked with bundled CLI `0.167.0-alpha.3.2` accepts
`CODEX_APP_SERVER_WS_URL`. This internal host option has no cross-version
guarantee. This external-daemon mode differs from the desktop-owned launch adapter
above. Use the same CLI build as the desktop runtime:

```sh
codex -c features.code_mode_host=true app-server daemon start
rolebox_codex_home="${CODEX_HOME:-$HOME/.codex}"
launchctl setenv CODEX_APP_SERVER_WS_URL \
  "ws+unix://localhost${rolebox_codex_home}/app-server-control/app-server-control.sock:/rpc"
```

Finish active turns, fully quit the desktop, and reopen the same chat. Its
WebSocket client connects directly to the Unix control socket, without a TCP
listener. Rolebox discovers that existing socket at MCP startup. Continue using
`graph_declare.parent_notification.available` as the per-chat capability check;
the URL alone does not establish loaded ownership. An actual desktop chat and
real graph worker were verified: after the main turn ended, accepted graph
completion started a new turn in that same chat without `graph_wait` or status
polling. The retained `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` branch requires empty
startup overrides, so the automatic desktop MCP override prevents it in this
build.

This configuration has a desktop-tool limitation. In the checked build, the
shared daemon did not receive `CODEX_APP_TOOLS_PIPE_PATH`, and the bundled
`codex_app` MCP server failed to start. Its chat-management and automation tools
were unavailable; rolebox graphs and native command tools remained usable. Full
desktop-tool support also requires native IPC authorization. On the checked
build, passing the current pipe and desktop Node through the adapter allowed MCP
initialization, but `tools/list` failed with `-32603`; the desktop logged
`untrusted-process-ancestry`. An isolated app-server launching the original MCP
produced the same native rejection without loading a real chat. The runtime's
signing team matched the desktop, so providing the address and signed runtime
alone did not establish an accepted process ancestry.
The desktop rejects the native socket before dispatching a tool request.

The launch environment lasts for the current login session. For persistence,
a user LaunchAgent must start the daemon and set the URL before the desktop
launches. To restore the normal desktop connection, remove that per-login setup
if installed, run `launchctl unsetenv CODEX_APP_SERVER_WS_URL`, then fully restart
the desktop. This does not stop the shared daemon or its other clients. Recheck
actual wake delivery after host updates.

##### Desktop IPC bridge probe

The experimental `rolebox host codex desktop probe` command tests an explicit desktop
binding. Create a JSON file with these three fields:

```json
{
  "pluginRoot": "/path/to/codex-app-tools",
  "nodePath": "/path/to/desktop-runtime/node",
  "pipePath": "/path/to/current-desktop.sock"
}
```

Use the current desktop's original plugin bundle and `CODEX_MCP_NODE_PATH`.
Its main-process log records the pipe in `dynamic_app_tools_listening`; select
the log for the current desktop process. The pipe must be a private Unix socket
owned by the invoking user. Refresh the binding after a desktop restart. The
adapter starts the original launcher, forwards its declared environment whitelist,
and sets only the explicit pipe and Node bindings.

```sh
rolebox host codex desktop probe --binding /path/to/binding.json \
  --thread THREAD_ID --socket /path/to/app-server-control.sock \
  --peer-log /path/to/current-desktop-main.log --report /path/to/report.json
```

The thread defaults to `CODEX_THREAD_ID`; the socket uses parent notification
discovery when omitted. `--timeout-ms` is one MCP probe deadline in milliseconds,
`1`–`60000`, default `10000`. The probe checks shared-host ownership, initializes
MCP, discovers tool pages and calls only `read_thread` for that chat. Exit `0`
requires a verified read of the same chat; exit `2` reports a blocked stage.
Exit `1` covers command errors, including invalid input JSON or report write
failure, and need not produce JSON. `--max-response-bytes` accepts
`1024`–`104857600`, default `16777216` (16 MiB), independently of the launcher's
message limit. The bridge frames coalesced responses separately and keeps partial
UTF-8 intact. An oversized line reports `response_too_large`; malformed JSON or
framing reports `invalid_protocol`.
`peer_rejected` requires a newly appended complete desktop log line. The reader
opens the log before probing and identifies that descriptor, ignoring replacement
files and incomplete lines. After a refused handshake it allows up to another
500 ms for log flush. Without that evidence, an IPC closure is not classified as
a native authorization failure.

The optional report contains reason codes and counts, excluding binding paths,
environment values and chat contents. stdout uses the same schema as the
owner-only `--report` file:

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

`status` is `ready` or `blocked`. `stage` is `parent`, `binding`, `initialize`,
`tools/list` or `tools/call`. Stable codes are `verified`, `parent_unavailable`,
`invalid_binding`, `invalid_timeout`, `invalid_response_limit`, `cancelled`,
`timeout`, `process_unavailable`, `transport_closed`, `invalid_protocol`,
`response_too_large`, `ipc_closed`, `host_context_missing`, `mcp_refused`,
`read_tool_unavailable`, `read_result_unverified`, `peer_rejected`,
`invalid_request` and `probe_failed`. MCP refusals can add numeric
`bridge.mcpErrorCode`; fresh native rejection evidence adds
`bridge.peerRejection: { reason, timestamp }`. `toolCount` is an integer; the
other flags are booleans. `parentNotificationAvailableAfter` checks current
loaded ownership after probing, independently of bridge success.
`hostConfigurationChanged` is always false. The command closes its own MCP child and
leaves host configuration untouched. A successful probe does not register the
desktop's native tool catalog. In the checked build, ancestry rejection prevents
that integration; the existing graph notification connection remains usable.

### DSH settings

DSH plugin settings include `roleboxDir`, `skillsDir`, `defaultRole`, `activeRole`,
`computerUse`, `browseUse`, `enabledNamespaces` and `spawnProviderName`.
`activeRole` selects the role for new sessions without a persisted selection;
`defaultRole` promotes a role to primary. `enabledNamespaces` accepts tool names
or prefixes and `!` exclusions, for example `["*", "!web"]`. It selects registered
tools and does not grant host permissions. `onSpawn` is a programmatic function,
not a YAML value. No plugin-owned web host or port option exists.

The 32 `lsp_*` tools are included by default. Include `lsp` in an explicit
namespace allow-list to keep them, or use `["*", "!lsp"]` to exclude the family.
See [LSP runtime setup](runtime.md#lsp) for server installation, session workspace
scope and verification calls.

## Model aliases

Place aliases in `<harness-home>/role_config.yaml`:

```yaml
model_aliases:
  IMPLEMENTATION_MODEL: example-provider/model-name
  REVIEW_MODEL: example-provider/review-model
```

Use `model: IMPLEMENTATION_MODEL` in role definitions. Resolution is known host
catalog ID first, then a single alias lookup, then unchanged passthrough with a
log hint. Alias chains are not followed. An unrecognized value need not fail
loading, so confirm the host can actually resolve and use the final model.
Aliases apply to root and child models. They refresh on role bootstrap/reload.

For Codex native agent files, use aliases that resolve to bare native model IDs.
A qualified `provider/model` can be projected only when the inherited Codex provider
is known and matches. CLI/native-file sync inherits the parent model with a warning
when it cannot establish that match. Managed graph workers can read their parent's
effective provider. This mapping never registers a provider or changes its credentials.

## Project defaults, automatic activation and reload

Setting a role's mode to `primary` and activating it for a new session are
different operations. First identify the harness; there is no universal
project-scoped automatic-activation setting across the supported hosts.

For OpenCode's project-level role promotion, write
`<workspace>/.rolebox/config.json`:

```json
{
  "defaultRole": "reviewer",
  "copilot": {
    "draft": {
      "enabled": true,
      "provider": "example-provider",
      "model": "example-model"
    }
  }
}
```

`reviewer` must be an already-discovered top-level role's directory ID, not its
display name. The role can come from `<workspace>/rolebox/reviewer/role.yaml`
or the synced harness role tree. If the workspace has a `rolebox/` directory,
only that tree is searched. Merge the setting with existing project values;
desktop/browser gates and the `copilot` key in the same file are independent
settings.

The project `copilot.draft` block is the middle precedence layer for DSH
composer draft suggestions: the acting role's `copilot.draft` wins per field,
then this project block, then the global `config.yaml` block. Only DSH reads it;
the same JSON file's `defaultRole` is read by OpenCode. The copilot files are read
once at plugin boot (no watching), and an invalid value is treated as absent so a
lower source can supply it. See [Runtime](runtime.md#composer-draft-suggestions-copilot).

| Harness | Effective behavior |
| --- | --- |
| OpenCode 1.x / 2 | Reads project `defaultRole`, promotes that role to `primary`, and demotes other primaries to `all`. This does not set the host's default-agent selection or force a switch in an existing conversation. |
| DSH | Does not read project `defaultRole` for role selection. The rolebox plugin's `defaultRole` promotes role mode; its `activeRole` activates a valid primary role for a new root session without a saved selection. |
| Pi | Does not read project `defaultRole`. Select with `/role <role-id>`; the role switcher restores the saved choice when that session resumes. A fresh session without a saved choice is not automatically activated by this JSON file. |
| Codex | Does not use project `defaultRole` to switch an existing native agent, model or prompt. Public roles are generated native agents selected through Codex; private children launch through the owning role's graph. |

For DSH automatic activation, set the existing rolebox loader row's `config`
in the intended DSH profile to include:

```yaml
activeRole: reviewer
```

This is plugin configuration for that profile, not a key in
`.rolebox/config.json`. The role must exist and be switchable as a primary role.
Saved session choices, including an explicit clear to the base agent, take
precedence; dispatched child and team sessions retain their assigned roles.
This option does not provide a per-project role mapping when a profile serves
multiple projects. Explain that limitation instead of inventing a project
`activeRole` field or claiming `auto_activate` selects a role: `auto_activate`
activates functions inside an already-selected role.

Project settings are read at initialization. Restart after editing them. Verify
the active role in a new session; restoring an existing session can preserve its
previous selection. Some
hosts reload roles and aliases automatically; restart when their reload behavior
is unavailable or unclear. Native skill catalogs may also require a host reload.

## DSH Web UI

Rolebox and Logs appear as session Conversation view tabs after Chat and
Trajectory. The monitor keeps the original monitoring layout: attention status,
selected graph topology and node ledger, workspace session roster, loops and
metrics. The graph picker switches among the current session's graphs and
preserves the selected graph during refresh. Session changes load that session's
graphs and loops without showing the previous session's snapshot.

The monitor keeps the existing ledger layout and fills the available Conversation
width. The Conversation owns vertical scrolling: mouse-wheel and keyboard page
scrolling work over the ledger, topology and expanded records. Session and task
identifiers, graph names, status text, role labels, errors and metric readings
wrap to the available column width. Progress and distribution strips fit narrow
columns even with many nodes or buckets. Wide topology figures and expanded
native records keep their own horizontal scrollbar without blocking vertical
wheel scrolling.
Its topology is a read-only diagram. Workspace sessions and dispatch metrics
retain their original scope. Settings → Rolebox still manages loaded roles and role reloads; it points
to the Rolebox Conversation tab for monitoring. No additional role fields are
required. Restart DSH and refresh the web page after updating the built bundle.
On narrow headers, DSH may place additional views in More.

## Logs and diagnosis

`rolebox logs` reads rolebox's structured logs; `rolebox monitor` opens the TUI.
Useful startup variables:

| Variable | Meaning |
| --- | --- |
| `ROLEBOX_LOG_LEVEL` | File threshold; default `info` |
| `ROLEBOX_LOG_CONSOLE_LEVEL` | Console threshold; default `warn` |
| `ROLEBOX_LOG_LEVEL_<CHANNEL>` | Per-channel threshold; uppercase and replace punctuation with `_`, e.g. `ROLEBOX_LOG_LEVEL_GRAPH_HOST` |
| `ROLEBOX_LOG_DIR` | Explicit log directory override |
| `ROLEBOX_LOG_MAX_BYTES` | Rotation threshold; default 10485760 |
| `ROLEBOX_LOG_RETAIN` | Rotated copies retained; default 3 |
| `ROLEBOX_NO_WELCOME` | Suppress installation welcome output; skill synchronization still runs |

Legacy `ROLEBOX_LOG_FILE` selects a single output file and takes precedence over
directory selection on the writer. Explicit CLI read options can select another
log source. Read `rolebox logs --help` before choosing filters or pruning logs.
