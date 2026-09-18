# Codex

> Part of the rolebox documentation. See [README](../README.md) for overview.

Codex is supported through the extension mechanisms Codex exposes: a generated local
plugin marketplace that declares the rolebox MCP server, a stdio MCP server exposing the
canonical rolebox tool surface, and a CLI sync target (`rolebox sync codex`) that writes
the bundle and registers it. There is no Codex plugin process of rolebox's own — every
tool call reaches rolebox over MCP.

Parity is enforced by the Codex tests: `tests/platform/codex-mcp.test.ts` (the protocol
and the canonical tool surface), `tests/platform/codex-platform.test.ts` (path resolution,
the registry descriptor, capabilities and registration detection), and
`tests/cli/codex-sync.test.ts` (the generated bundle and `config.toml` registration). See
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
| `{codexHome}/skills` | Global skills directory exposed to the plugin |
| `{codexHome}/rolebox-marketplace` | Generated local marketplace (plugin bundle) |
| `{codexHome}/config.toml` | Host config carrying the managed registration block |

Codex has no rolebox-owned sessions directory. As on every other harness, a `rolebox/`
directory in the current working directory takes precedence over `{codexHome}/rolebox`
when the MCP server boots.

## Install and use

1. Install rolebox the usual way — `npm install -g rolebox`, or run from a checkout that
   has been built with `bun run build`. The recorded server entry is the built
   `dist/entries/codex.js` artifact.
2. Run the sync target:

   ```bash
   rolebox sync codex
   ```

3. Restart Codex so it re-reads `{codexHome}/config.toml` and the local marketplace.

`rolebox sync codex` also deploys installed roles as symlinks (the same role sync every
target gets), prints the usual `Synced N roles to codex` line, and then reports
`Codex plugin: registered {marketplaceDir} in {configPath}`.

The bundle is written before the registration is attempted, so when registration fails the
command prints both halves — `Codex plugin: wrote the marketplace directory
{marketplaceDir}, but registering it in {configPath} failed: {reason}` — says the sync is
safe to repeat, and re-raises the error rather than printing the success line. A recorded
server entry that does not exist (a source checkout that was never built) does not fail
the sync: the bundle is still written and registered, and a warning names the missing
`dist/entries/codex.js` path and suggests `bun run build`.

## What `rolebox sync codex` writes

| Path | Contents |
|---|---|
| `{codexHome}/rolebox/<role>` | Symlink per installed role pointing at its shared source |
| `{codexHome}/rolebox-marketplace/.agents/plugins/marketplace.json` | Marketplace manifest: name `rolebox`, one `local` plugin source at `./plugins/rolebox` |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/.codex-plugin/plugin.json` | Plugin manifest: name `rolebox`, version read from rolebox's `package.json`, `skills: "./skills/"`, `mcpServers: "./.mcp.json"`, interface metadata |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/.mcp.json` | Starts the rolebox MCP server: `command: "node"`, `args: ["<abs path to dist/entries/codex.js>"]`, `startup_timeout_sec: 60`, `tool_timeout_sec: 600` |
| `{codexHome}/rolebox-marketplace/plugins/rolebox/skills` | Directory symlink to `{codexHome}/skills` |
| `{codexHome}/skills` | Created if missing; this is the directory exposed to the plugin as its `skills/` |
| `{codexHome}/config.toml` | Exactly one managed registration block (below) |

The skill symlinks inside `{codexHome}/skills` are not written by `sync`: the MCP server
writes the `rolebox--<skill>` entries when it boots and resolves the installed roles
(`syncSkillSymlinks`).

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
  cover bytes written straight to fd 1, and a global `console.log` is diverted only where
  the runtime routes it through `process.stdout` — Node does (the generated `.mcp.json`
  launches `command: node`), while Bun writes it to fd 1 natively (the `rolebox` bin's
  shebang selects Bun). An embedder that calls `startCodexMcpServer()` itself gets no
  guard. Diagnostics go to stderr (`[rolebox codex] ...`) and rolebox's own logger writes
  to its log file.
- **Methods**: `initialize`, `ping`, `tools/list`, `tools/call`.
- **initialize**: echoes the client's requested protocol version when it is one of
  `2025-06-18`, `2025-03-26` or `2024-11-05`, and answers `2025-06-18` otherwise;
  advertises `capabilities: { tools: { listChanged: false } }` and
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
  `{ type: "image", data, mimeType }` block holding the base64 payload — `web_fetch` is
  the only tool that produces one today. Only a `type: "file"` attachment whose mime
  starts with `image/` and whose URL is a base64 `data:` URI is converted; every other
  attachment (a PDF, for instance) and every malformed data URI is dropped, keeping its
  existing text line as its only representation. An unknown tool name, invalid arguments,
  and a tool that throws are all `isError` results carrying a correction, not protocol
  errors — only a malformed `tools/call` envelope (no tool name) is a protocol error.
- **Errors**: malformed JSON line → `-32700` (null id); invalid request → `-32600`;
  unknown method → `-32601`; malformed `tools/call` envelope → `-32602`; internal error
  → `-32603`.
- **Ordering and lifetime**: requests are handled strictly one at a time and answered in
  request order; notifications are the one exception (above). `serve()` resolves when
  stdin ends; the server never calls `process.exit`. A boot failure is reported on
  stderr and sets a non-zero exit code.
- **Session id**: `ROLEBOX_SESSION_ID` when set, else a `sessionId` / `sessionID` /
  `session_id` string in the `initialize` `clientInfo`, else `codex`.
- **Context**: `metadata()` and `ask()` are documented no-ops — stdio MCP has no
  per-call metadata seam and no permission callback. Relative paths in tool calls resolve
  against the server process's working directory.

## Tool surface on Codex

The MCP server registers the canonical tool intersection built for a harness with no
session client and no dispatch backend, plus `load_role_skill` — 15 tools:

| Group | Tools |
|---|---|
| Files | `hashline_read`, `hashline_edit` |
| Memory | `memory_write`, `memory_recall`, `memory_list` |
| Web | `web_search`, `web_read`, `web_fetch` |
| Assets and references | `asset_search`, `asset_inspect`, `asset_validate`, `reference_search`, `load_role_skill` |
| Runtime | `signal`, `interactive_terminal` |

## Not supported on Codex yet

- `session_*` tools — the stdio MCP transport exposes no rolebox session client.
- `dispatch_*`, `loop_*`, `task_*` and `graph_*` tools — orchestration needs a dispatch
  backend, which the MCP entry does not construct, so the `graph_*` tools are never
  registered either. No stubs stand in for them.
- Role switching (no in-session active-role switcher).
- TUI (the interactive terminal UI binary is opencode-only).
- Hot reload (`asset_hot_reload` and the hot-reload service).
- The extension loader (the PluginCore `ExtensionService`).
- Hooks-driven activation (`chat.message` / `session.idle` / tool interception) — the MCP
  transport carries no host event stream, so activation happens per MCP call.

## Removing the integration

- `rolebox uninstall <role>` removes an installed role, then sweeps every registered
  sync target — including `{codexHome}/rolebox` — and unlinks each entry that is a
  symlink. The sweep is best-effort and never touches a real directory or file.
- The generated bundle and the managed block are removed by
  `removeCodexPluginBundle(codexHome)` (removes `{codexHome}/rolebox-marketplace`) and
  `unregisterCodexPlugin(configPath)` (removes every managed block — a hand-edited
  duplicate included — restoring the surrounding bytes). Both are exported from
  `src/platform/adapters/codex/plugin-bundle.ts` and the Codex adapter barrel, but **no CLI
  command currently calls them** — today the removal is manual: delete
  `{codexHome}/rolebox-marketplace` and the block between the two `rolebox (managed)`
  marker comments in `{codexHome}/config.toml`. Neither function touches
  `{codexHome}/skills` or `{codexHome}/rolebox`.
