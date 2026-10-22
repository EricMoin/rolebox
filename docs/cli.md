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

### `install [role]`

Install a role from a role source. The role specifier can be in several formats:

- `rolebox install software-architect` — install latest version, resolved across every configured source
- `rolebox install software-architect@1.0.0` — install specific version
- `rolebox install my-registry:custom-role` — install from a named source
- `rolebox install my-registry:role@2.0.0` — install specific version from a named source

An unprefixed role is looked up in the default source first and then in the remaining
sources in config order; the first source that publishes the role provides both the
version and the tarball, and the lock file records it. A source that cannot be
fetched is skipped with a `Warning:` line and the lookup continues with the next one.
When no source publishes the role the error names the sources that were searched (and
any that could not be reached). When several sources publish the same role,
`rolebox search` prints a note with the `source:role` specs to choose from —
`install` itself takes the default source's copy.

Omit the role specifier to pick a role interactively:

```bash
rolebox install        # Select a source (if multiple) and a role to install
```

After installing, run `rolebox sync opencode` to deploy the role.

### `uninstall [role]`

Remove an installed role and the sync links that point to it, in every sync target; links belonging to other roles, or a real directory at a target path, are left untouched.

```bash
rolebox uninstall software-architect
rolebox uninstall my-registry:software-architect   # One copy when several sources provide it
rolebox uninstall     # Select an installed role to remove (asks for confirmation)
```

A role installed from more than one source must be disambiguated with
`source:role`; a bare role then fails with the list of sources instead of picking
one arbitrarily.

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

Role directories are symlinks into that shared source, so a real directory at a
target path is a divergence: it shadows the shared source and never receives
updates from other platforms. By default `sync` only reports such a directory
and leaves it untouched. To repair it, run `rolebox sync <target> --relink`,
which copies the divergent directory to a timestamped `<role>.backup-<timestamp>`
beside the target before removing it and creating the correct symlink — so local
changes are preserved in the backup.

### `list`

Show all installed roles with versions and their source registries.

```bash
rolebox list
rolebox list --json   # JSON output for scripting
```

### `search [query]`

Search available roles across all configured sources.

```bash
rolebox search                        # List all available roles
rolebox search react                  # Search for roles matching "react"
rolebox search --registry community   # Search one source (comma-separated names allowed)
rolebox search --no-cache             # Bypass registry cache
```

Matches against role names, descriptions, and tags (case-insensitive). Each source is
reported under its own `Results from <source>:` heading, with a per-source warning
when it could not be fetched. When a role is published by more than one selected
source, a note names the `source:role` specs to choose from; when every selected
source failed, the result is reported as unknown rather than empty.

### `update [role]`

Update installed roles to the latest versions available in their sources.

```bash
rolebox update                         # Update all installed roles
rolebox update software-architect      # Update every installed copy of a role
rolebox update my-registry:software-architect   # Update one source's copy
rolebox update --no-cache              # Bypass registry cache
```

A bare role updates every copy (one per source) and each success line names the
source it came from; `source:role` narrows the update to that copy.

### `registry <subcommand>`

Manage role sources. The built-in source (`oh-my-role`) is always available; custom
sources are added on top of it, so searching and installing span every configured
source instead of replacing a single one.

```bash
rolebox registry list                     # Show every effective source
rolebox registry list --json              # JSON output for scripting
rolebox registry add https://github.com/user/my-roles
                                          # Add a source (name defaults to the repo name)
rolebox registry add https://github.com/user/my-roles --name mine --ref v2
                                          # Custom name, and a branch/tag to read
rolebox registry add https://gitlab.com/group/sub/my-roles
                                          # GitLab project (nested groups work)
rolebox registry add https://roles.example.com/acme/registry.yaml
                                          # A plain HTTP server's registry.yaml
rolebox registry add https://github.com/user/my-roles --default
                                          # Make it the default source
rolebox registry remove my-roles          # Remove a custom source
rolebox registry default my-roles         # Make an existing source the default
```

`list` marks each source: `(gitlab)` or `(http)` for a non-GitHub source,
`(ref: <branch>)` when a branch or tag is pinned, `(default)` for the source an
unprefixed role spec resolves from first, and `(built-in)` for the source that ships
with rolebox. The built-in source cannot be removed — `rolebox registry default
oh-my-role` makes it the default again. Removing a source that still has installed
roles warns and names the `rolebox uninstall <source>:<role>` command that removes
them.

Adding a source validates its `registry.yaml` with a single fetch at the requested
`--ref` before anything is written. The source kind is detected from the URL alone:
a GitHub project (`https://github.com/owner/repo`), a GitLab project (gitlab.com or a
`gitlab`-family host, nested groups included, and a pasted `/-/` route is normalized
to the project root), or a plain HTTP server's `registry.yaml` URL. A URL that
identifies none of those — a bare `owner/repo` on an unknown host, for example — is
refused with a hint naming the recognizable forms; nothing is probed over the
network. The inferred name is the project basename, or the base path of a direct
`registry.yaml` URL. A name that is already configured is rejected (pass `--name` to
choose another one); a manifest that declares a different name than the source only
produces a warning, as does a URL another source already uses (which is how one
repository is pinned to two branches).

### `info [role]`

Show detailed information about an installed role, including model config, skills, functions, subagents, and per-target sync status (opencode, pi, dsh).

```bash
rolebox info software-architect
rolebox info                    # Select an installed role to inspect
rolebox info software-architect --json    # JSON output
rolebox info software-architect --check   # Verify integrity hash
```

Note: `--json` requires an explicit role so the output stays machine-readable.

### `config [role]`

Configure models for a role and its subagents. The role must already be synced (`rolebox sync` first).

```bash
rolebox config software-architect          # Interactive model wizard
rolebox config                             # Select a synced role, then configure
rolebox config software-architect -m gpt-4o # Non-interactive model update
```

Use `--target` (`-t`) to choose which sync target's copy to configure. It
defaults to `opencode` and accepts `opencode`, `pi`, or `dsh`, matching the
`sync` targets above:

| Target | Rolebox directory |
| --- | --- |
| `opencode` (default) | `~/.config/opencode/rolebox/{roleId}` (respects `XDG_CONFIG_HOME`) |
| `pi` | `~/.pi/agent/rolebox/{roleId}` (respects `PI_CODING_AGENT_DIR`) |
| `dsh` | `~/.dsh/rolebox/{roleId}` (respects `DSH_HOME`) |

```bash
rolebox config software-architect --target pi
rolebox config software-architect -t dsh -m gpt-4o
```

In interactive mode (no `--model`), omitting `--target` opens a target-selection
menu instead of silently defaulting to opencode. The choices are registry-driven
(opencode, pi, dsh, and any future platform), and when the role is already
synced to one or more targets only those targets are offered, so you are not
steered into a target where `config` would immediately fail. If the role is not
synced anywhere yet, every valid target is listed. Passing `--target`/`-t`
skips the menu; in the non-interactive `--model` path an omitted target still
defaults to opencode.

### `bench <subcommand>`

Create and run local role benchmarks on dsh. The first implementation evaluates final response text using literal `equals` and `contains` assertions, with a frozen role snapshot and an independent process for each trial. See [Benchmarks on dsh](benchmarks.md) for the suite schema, provider configuration, scoring, and execution boundaries.

```bash
rolebox bench init output-quality
rolebox bench validate output-quality
rolebox bench doctor output-quality
rolebox bench run output-quality --output benchmark-results
rolebox bench watch output-quality --output benchmark-results
rolebox bench report benchmark-results/RUN_ID
rolebox bench report benchmark-results/RUN_ID --format json --output report.json
rolebox bench baseline set main benchmark-results/RUN_ID
rolebox bench watch output-quality --baseline main
rolebox bench compare benchmark-results/CANDIDATE_RUN_ID --baseline main --format html --output comparison.html
```

Configure `target.provider`, `target.model`, and trusted `host.plugins` in the generated `suite.yaml` before running. Replace `RUN_ID` with the directory component printed by `run`.

| Subcommand | Arguments and flags | Behavior |
| --- | --- | --- |
| `init` | `<directory>` | Create a new suite, three example cases, and a starter role; the parent directory must exist |
| `validate` | `<suite>` | Validate the suite, JSONL cases, and self-contained role assets without importing provider plugins |
| `doctor` | `<suite>` | Check installed dsh module resolution and report `pluginsConfigured`; no live provider request |
| `run` | `<suite> [--output <directory>] [--baseline <name>]` | Execute the planned trials and commit results to SQLite; optionally print a historical comparison |
| `watch` | `<suite> [--output <directory>] [--baseline <name>]` | Rerun stable changed revisions after cleanup; compare current results with the baseline pinned at startup |
| `report` | `<run-directory> [--format html\|json] [--output <file>]` | Read saved results and write a standalone HTML report or JSON result plus summary |
| `baseline set` | `<name> <run-directory>` | Capture a complete run and append a baseline revision |
| `baseline show` / `history` | `<name>` | Show the captured summary or preserved revision metadata |
| `baseline list` | None | List the latest revision of every baseline |
| `compare` | `<candidate-run-directory> (--baseline <name> \| --against <baseline-run-directory>) [--format json\|html] [--output <file>]` | Compare saved evidence; default JSON to stdout, optional offline report file |

`<suite>` accepts a directory containing `suite.yaml` or the YAML file itself. Without `run --output`, results are stored under the rolebox data directory's `benchmarks/` subdirectory. Reports default to `report.html` or `report.json` in the saved run directory.

`doctor` reports `liveExecutionVerified: false`; resolvable modules and configured plugins do not prove that credentials or a selected provider/model work. Execution uses `trusted-process` isolation, not an operating-system sandbox, and requires a compatible dsh installation on a system with POSIX process groups. Credentials are passed explicitly through `host.env` and `{ $env: VARIABLE_NAME }` plugin config references.

For runs that reach result reporting, exit codes are `0` when every planned trial passes, `1` for a complete run with task failures, `2` for incomplete results, and `130` for cancellation. Incomplete overall scores and unobserved usage remain `null`.

Watch polls content every 500 ms with a 300 ms debounce, runs the suite's configured plan, and preserves superseded run records. Invalid saves pause execution; unconfirmed worker cleanup stops the watcher. Keep output outside the role directory. Named baselines capture result records in the rolebox data directory; explicit updates preserve history and do not move an active watch's pinned baseline.

Historical comparisons check suite/plan, route, and runtime compatibility. Deltas require complete comparable runs; unknown usage remains unknown. `compare` exits `0` for complete comparable evidence regardless of score direction, and `2` for incomplete, incompatible, or unverified evidence. It does not perform a statistical regression gate. Watch has no cumulative cost budget. See [baseline semantics](benchmarks.md#comparing-role-edits-with-a-baseline).

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

### `logs`

Read the rolebox log files: answer the records a query matches, list the files on disk, and prune rotated copies. The pipeline itself — the two audiences, the record shape, the environment variables and the `jq` recipes — is documented in [logging.md](logging.md).

```bash
rolebox logs                                    # the last 100 records, newest first
rolebox logs --level warn --channel graph:host  # warn and above, one channel
rolebox logs --since 2h --text timeout          # the last two hours mentioning "timeout"
rolebox logs --graph g-42 --json | jq .         # one raw JSON record per line
rolebox logs --follow                           # stream new records, Ctrl-C to stop
rolebox logs files                              # channel, rotation, size and mtime
rolebox logs prune --dry-run                    # what would be removed, and how much that frees
rolebox logs prune --max-total-bytes 50000000   # keep the whole log directory under ~50 MB
```

| Flag | Meaning |
| --- | --- |
| `--level <level>` | Lowest level to show: `warn` shows warn, error and fatal (a threshold, like `ROLEBOX_LOG_LEVEL`) |
| `--channel <a,b>` | Only these channels, exact match |
| `--code <a,b>` | Only these event codes, exact match |
| `--graph <id>` / `--session <id>` | Only records whose scope carries that id |
| `--since <time>` / `--until <time>` | Time window: a duration (`30s`, `10m`, `2h`, `1d`, `1w`), an ISO 8601 instant, or epoch milliseconds |
| `--limit <n>` | How many records to show (default: 100) |
| `--order <asc\|desc>` | Newest first (`desc`, the default) or oldest first |
| `--text <substring>` | Case-insensitive substring looked for in the message, the channel, the code and the field values |
| `--log-dir <path>` | Read from exactly this directory instead of the resolved log directory. It beats `ROLEBOX_LOG_FILE`, so the files listed, read and pruned are the ones in `<path>`; without the flag the resolved chain applies, and `ROLEBOX_LOG_FILE` makes the one file it names the source |
| `--json` | One raw JSON record per line, for `jq` |
| `--follow`, `-f` | Stream records written after the command starts (does not replay history; `--limit`/`--order` do not apply; a source with no files yet is waited for, like `tail -f`, and the first record written is delivered) |

**Exit codes.** `0` for any answer — including "no records matched" and a source that does not exist yet, where the command names the location it actually read (the directory, or the one file `ROLEBOX_LOG_FILE` names) and how to point it elsewhere — and `1` only for an argument the command cannot honour, reported with the usage line. Records go to stdout; the notes about the answer (an empty result, a truncation at `--limit`, skipped malformed lines) go to stderr, so `--json` stays parseable.

**`rolebox logs files`** lists every log file with the channel its name spells, its rotation (`active`, `.1`, `.2`, …), its size and its modification time. The active file of a channel is the one being written. The heading names the source that was read: the `--log-dir` directory, or — when `ROLEBOX_LOG_FILE` names one file and no `--log-dir` was given — that file.

**`rolebox logs prune`** removes rotated copies only — an active `<channel>.log` is never a candidate, and the report says so. It acts inside the source it names (`--log-dir`, else the resolved chain), so it can never remove a file outside it. Three gates apply. `--keep <n>` is how many of a channel's newest rotated copies stay (default: the writer's `ROLEBOX_LOG_RETAIN` as this process sees it, else 3), and `--days <n>` is how old by mtime a candidate must additionally be. `--max-total-bytes <n>` is a byte budget for the whole source: after the other two gates, the oldest surviving rotated copies go until every log file left (active files included) fits — it may reach inside the kept window, but never past `--days` and never at an active file, and the report says whether the budget was met. `--dry-run` reports what would go and removes nothing. The relation between the flags and the write-side variables, with measured boundaries, is in [logging.md](logging.md#files-and-pruning).

### `status`

Show overall health of the rolebox installation: version, registries, installed roles, and — for **every** registered platform (opencode, pi, dsh, and any future harness) — its sync target, per-target synced role count, host integration/registration status, and skill symlink integrity.

```bash
rolebox status
rolebox status --check-updates   # Also check for newer versions in registries
rolebox status --json            # JSON output for scripting
```

The set of reported platforms is driven by the platform registry
(`src/platform/registry.ts`); each harness contributes a descriptor declaring
its paths and how to detect that rolebox is registered with the host tool. The
JSON output includes a `targets` array (one entry per platform) alongside the
legacy `opencode` field retained for backward compatibility.

## Configuration

The CLI stores its state in two files:

- `~/.config/rolebox/config.yaml` — role sources (the built-in `oh-my-role` source plus any you add)
- `~/.config/rolebox/rolebox.lock` — installed role manifest with version and integrity tracking

```yaml
registries:
  - name: oh-my-role
    url: https://github.com/EricMoin/oh-my-role
    default: true
  - name: mine
    url: https://github.com/user/my-roles
    ref: v2          # optional: branch or tag for registry.yaml and the role tarballs
  - name: static-roles
    url: https://roles.example.com/acme/registry.yaml   # a plain HTTP server's manifest
```

A source's kind is detected from its `url`; there is no `kind` setting.

The built-in `oh-my-role` source is available even when the file does not list it, and
an entry that does list it keeps its own `url` and `ref`. A custom source with
`default: true` takes over the default slot; otherwise the built-in is the default.
An unprefixed `rolebox install <role>` consults the sources in that order — default
first, then the order in the file; `rolebox update` works from the lock file instead
(see above). `registries: []` opts out entirely, the built-in included:
`rolebox registry list` reports that no source is configured, `rolebox install` and
the interactive pickers stop with `No registries configured`, and a search has no
source to look in — it reports that it found no roles rather than falling back to
the built-in silently. See [registry.md](registry.md) for the
per-source `ref` and resolution rules, and for the GitHub/GitLab/HTTP source kinds
and the layout a plain HTTP server must serve.
