# Codex

> Part of the rolebox documentation. See [README](../README.md) for overview.

Codex is supported through the extension mechanisms Codex exposes: a generated local
plugin marketplace that declares the rolebox MCP server, a stdio MCP server exposing the
canonical rolebox tool surface, and a CLI sync target (`rolebox sync codex`) that writes
the bundle and registers it. There is no Codex plugin process of rolebox's own — every
tool call reaches rolebox over MCP.

Parity is enforced by the Codex tests: `tests/platform/codex-mcp.test.ts` (the protocol
and the entry-point tool surface), `tests/platform/codex-platform.test.ts` (path
resolution, the registry descriptor and capabilities), and `tests/cli/codex-sync.test.ts`
(the generated bundle and `config.toml` registration). See
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
options, an existing correct `skills` symlink is left untouched, and an existing managed
block is replaced in place — no byte outside the block is modified. When the block is
appended for the first time, a single newline separates it from the existing config: a
blank line when the file already ends with one, otherwise it terminates the last line.
A real directory sitting where the `skills` symlink belongs is never destroyed.

## Verify it took effect

- `rolebox status` prints a **Codex Integration** section. Its `Plugin + MCP` line reads
  `registered` once `{codexHome}/config.toml` contains a rolebox marketplace table, a
  `[plugins."rolebox@<marketplace>"]` table, or an `[mcp_servers.rolebox]` table; the
  section also lists the sync target and the per-target synced role count.
- Or inspect the files directly: `{codexHome}/config.toml` contains the managed block,
  and the four generated entries under `{codexHome}/rolebox-marketplace` exist (three
  JSON manifests plus the `skills` symlink).
- `rolebox mcp` (or `node dist/entries/codex.js`) starts the same server the plugin
  starts; its `initialize` result reports `serverInfo.name` `rolebox`.

## The MCP server

The server entry is `rolebox mcp` (which imports `src/entries/codex.ts` and serves until
stdin closes); the package also exports it as `rolebox/codex`
(`dist/entries/codex.js`). Codex starts it from the generated `.mcp.json`.

- **Transport**: newline-delimited JSON-RPC 2.0 on stdin/stdout — one JSON object per
  line. stdout carries protocol messages only; diagnostics go to stderr
  (`[rolebox codex] ...`) and rolebox's own logger writes to its log file.
- **Methods**: `initialize`, `ping`, `tools/list`, `tools/call`.
- **initialize**: echoes the client's requested protocol version when it is one of
  `2025-06-18`, `2025-03-26` or `2024-11-05`, and answers `2025-06-18` otherwise;
  advertises `capabilities: { tools: { listChanged: false } }` and
  `serverInfo: { name: "rolebox", version: <package version> }`.
- **Notifications**: any message without an id is never answered;
  `notifications/initialized` and `notifications/cancelled` are accepted and ignored
  (cancellation of an in-flight call is not wired on this transport).
- **tools/list**: every registered tool as `{ name, description, inputSchema }` with a
  JSON Schema object per tool. The list is always one page — a cursor is tolerated and
  ignored, and no `nextCursor` is returned.
- **tools/call**: `{ name, arguments }` returns
  `{ content: [ { type: "text", text } ], isError?: true }`. An unknown tool name, invalid
  arguments, and a tool that throws are all `isError` results carrying a correction, not
  protocol errors — only a malformed `tools/call` envelope (no tool name) is a protocol
  error.
- **Errors**: malformed JSON line → `-32700` (null id); invalid request → `-32600`;
  unknown method → `-32601`; malformed `tools/call` envelope → `-32602`; internal error
  → `-32603`.
- **Ordering and lifetime**: messages are handled one at a time and answered in request
  order. `serve()` resolves when stdin ends; the process never calls `process.exit`. A
  boot failure is reported on stderr and sets a non-zero exit code.
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
  `unregisterCodexPlugin(configPath)` (removes exactly the managed block, restoring the
  surrounding bytes). Both are exported from `src/platform/adapters/codex/plugin-bundle.ts`
  and the Codex adapter barrel, but **no CLI command currently calls them** — today the
  removal is manual: delete `{codexHome}/rolebox-marketplace` and the block between the
  two `rolebox (managed)` marker comments in `{codexHome}/config.toml`. Neither function
  touches `{codexHome}/skills` or `{codexHome}/rolebox`.
