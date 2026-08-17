# CLI Reference

> Part of the rolebox documentation. See [README](../README.md) for overview.

rolebox includes a command-line interface for installing and managing AI agent roles from remote registries.

## Usage

```bash
npx rolebox <command> [options]
```

Or if installed globally:

```bash
rolebox <command> [options]
```

## Commands

### `init [name]`

Scaffold a new role interactively. Creates a ready-to-use directory structure with all necessary files.

```bash
rolebox init                          # Interactive wizard
rolebox init my-role                  # Create role in ./my-role directory
rolebox init my-role -y               # Skip prompts, use defaults
rolebox init my-role -t subagents     # Use a specific template
```

**Templates:**

| Template | Description |
|---|---|
| `minimal` | Just `role.yaml` and `PROMPT.md` |
| `standard` | Role with skills, functions, and references directories |
| `subagents` | Parent role with child sub-agent scaffolding |
| `collaboration` | Multi-agent role with collaboration graph topology |

### `install <role>[@version]`

Install a role from a registry. The role specifier can be in several formats:

- `rolebox install software-architect` — install latest version from default registry
- `rolebox install software-architect@1.0.0` — install specific version
- `rolebox install my-registry:custom-role` — install from named registry
- `rolebox install my-registry:role@2.0.0` — install specific version from named registry

After installing, run `rolebox sync opencode` to deploy the role.

### `uninstall <role>`

Remove an installed role and clean up any symlinks.

```bash
rolebox uninstall software-architect
```

### `sync <target>`

Deploy installed roles to a target tool's configuration directory. Supported targets: `opencode`, `pi`, `dsh`.

```bash
rolebox sync opencode
rolebox sync pi
rolebox sync dsh
```

This creates symlinks from the target's rolebox directory to the installed role:

| Target | Rolebox directory |
| --- | --- |
| `opencode` | `~/.config/opencode/rolebox/{roleId}` (respects `XDG_CONFIG_HOME`) |
| `pi` | `~/.pi/agent/rolebox/{roleId}` (respects `PI_CODING_AGENT_DIR`) |
| `dsh` | `~/.dsh/rolebox/{roleId}` (respects `DSH_HOME`) |

Each symlink points to `~/.local/share/rolebox/roles/{registry}/{roleId}@{version}/`

If a manual role (regular directory) already exists at the target path, it is preserved with a warning.

### `list`

Show all installed roles with versions and their source registries.

```bash
rolebox list
rolebox list --json   # JSON output for scripting
```

### `search [query]`

Search available roles across all configured registries.

```bash
rolebox search               # List all available roles
rolebox search react         # Search for roles matching "react"
rolebox search --no-cache    # Bypass registry cache
```

Matches against role names, descriptions, and tags (case-insensitive).

### `update [role]`

Update installed roles to the latest versions available in their registries.

```bash
rolebox update                         # Update all installed roles
rolebox update software-architect      # Update a specific role
rolebox update --no-cache              # Bypass registry cache
```

### `registry <subcommand>`

Manage registry sources.

```bash
rolebox registry list                    # Show all configured registries
rolebox registry add https://github.com/user/my-roles  # Add a registry
rolebox registry remove my-roles         # Remove a registry (not the default)
```

### `info <role>`

Show detailed information about an installed role, including model config, skills, functions, subagents, collaboration graph, and sync status.

```bash
rolebox info software-architect
rolebox info software-architect --json    # JSON output
rolebox info software-architect --check   # Verify integrity hash
```

### `monitor`

Show runtime dispatch activity, activated functions, and agent workflows for the current project. Reads persisted state files from the project-local `.rolebox/state/` directory. Supports a TUI dashboard (Solid.js + OpenTU) with live-updating status panels, task tables, and function state tracking.

```bash
rolebox monitor                              # TUI dashboard with snapshot of active tasks and functions
rolebox monitor --all                        # Include completed/cancelled tasks
rolebox monitor --json                       # JSON output
rolebox monitor --no-status                  # Hide the status overview panel
rolebox monitor --watch                      # Live-refresh dashboard (1s default interval)
rolebox monitor --watch --interval 5000      # Custom refresh rate
rolebox monitor --watch --json               # NDJSON output (one JSON line per interval)
```

The TUI dashboard shows: active loops, graph workflows, dispatch summary (queue depth, concurrent slots), and concurrency pool health. Use `--no-status` to hide the overview panel.

### `status`

Show overall health of the rolebox installation: version, registries, installed roles with sync status, opencode plugin registration, and skill symlink integrity.

```bash
rolebox status
rolebox status --check-updates   # Also check for newer versions in registries
rolebox status --json            # JSON output for scripting
```

## Configuration

The CLI stores its state in two files:

- `~/.config/rolebox/config.yaml` — registry configuration (default registry: oh-my-role)
- `~/.config/rolebox/rolebox.lock` — installed role manifest with version and integrity tracking
