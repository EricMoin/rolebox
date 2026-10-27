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
| Codex | Run `rolebox sync codex`; restart Codex to read its managed registration |

Use the host's own documentation for its installation command and provider
configuration. The built-in skill's synchronization itself does not register a
plugin, enable an MCP server, or install a model provider.

Codex sync creates `<codex-home>/rolebox-marketplace`, a plugin manifest, a skills
link and an MCP configuration launching the installed `dist/entries/codex.js`
with Node. It updates one managed block in `config.toml`, preserving other text.
The rolebox MCP server supplies tools and resources, but does not control Codex's
native role selection, prompts, models, subagent sessions or execution hooks.

DSH plugin settings include `roleboxDir`, `skillsDir`, `defaultRole`, `activeRole`,
`computerUse`, `browseUse`, `enabledNamespaces` and `spawnProviderName`.
`activeRole` selects the role for new sessions without a persisted selection;
`defaultRole` promotes a role to primary. `enabledNamespaces` accepts tool names
or prefixes and `!` exclusions, for example `["*", "!web"]`. It selects registered
tools and does not grant host permissions. `onSpawn` is a programmatic function,
not a YAML value. No plugin-owned web host or port option exists.

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
| Codex | Does not use project `defaultRole` to switch Codex's native agent, model or prompt. The rolebox MCP server supplies tools/resources only. |

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
