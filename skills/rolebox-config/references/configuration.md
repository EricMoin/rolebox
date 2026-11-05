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
| `<rolebox-config-home>/config.yaml` | Role registry sources and global feature gates |
| `<rolebox-config-home>/rolebox.lock` | CLI-managed installed versions and integrity |
| `<rolebox-data-home>/roles/<registry>/<role-id>@<version>` | Shared installed role source |
| `<harness-home>/rolebox/<role-id>` | `rolebox sync` link to that source |
| `<harness-home>/role_config.yaml` | Harness-specific model aliases |
| `<workspace>/.rolebox/config.json` | Project default role and feature gates |

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
`ROLEBOX_CODEX_COMMAND` and `ROLEBOX_SESSION_ID` by name. Unset values stay unset;
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

The runtime registers 29 base tools, including six `session_*` and five `graph_*`
tools; gated desktop/browser families add up to 35. Per-call thread identity binds
native role policy and graph submissions. Project `defaultRole` does not select a
native agent or replace the current conversation's prompt. Codex native UI hooks,
hot reload and an in-session role switcher are not installed by this integration.

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
  "defaultRole": "reviewer"
}
```

`reviewer` must be an already-discovered top-level role's directory ID, not its
display name. The role can come from `<workspace>/rolebox/reviewer/role.yaml`
or the synced harness role tree. If the workspace has a `rolebox/` directory,
only that tree is searched. Merge the setting with existing project values;
desktop/browser gates in the same file are independent settings.

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
