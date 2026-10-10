# Limitations

> Part of the rolebox documentation. See [README](../README.md) for overview.

- No role inheritance
- No runtime role switching
- Functions persist for the entire session (no per-message deactivation yet)
- No conditional functions based on project context
- Recursive file-based subagent nesting is supported (max depth: 3). `--` is reserved as the parent/child separator.
- `--` is reserved in role IDs (used as the parent/child separator)

## Pi (plugin platform) parity

Tool-surface parity with the opencode plugin is enforced by `tests/pi-parity.test.ts`: the shared opencode tool surface — hashline/memory/web/signal/asset/reference/session/task_* plus memory_update/lsp_*/function_graph/skill_compose/context_assemble — is registered by `PiLightweightServiceStack` on Pi. The graph tools are not part of that shared surface: they come from each host's own outcome capability layer instead — on Pi that layer supplies `graph_declare` / `graph_submit_outcome` / `graph_status` / `graph_audit` / `graph_control` to the stack, and both opencode entries register the same five tools through the composition seam. See [compatibility.md](compatibility.md) for the parity matrix.

- `dispatch_*` / `loop_*` / `task_retry` are intentionally withheld on both platforms: orchestration is graph-only, and bare dispatch/loop calls would bypass the graph engine's budget accounting, approval gates, and loop caps.
- `asset_hot_reload` is opencode-only and is deliberately not forwarded to Pi.

### Platform-inherent gaps (explicit non-goals on Pi)

Pi runs `PiLightweightServiceStack` instead of the full PluginCore service stack, so the following opencode-only subsystems are out of scope on Pi:

- Hot reload (`asset_hot_reload` tool + `HotReloadService`)
- Extensions (the PluginCore `ExtensionService` extension loader)
- Recovery engine (`RecoveryService` / `RecoveryEngine` crash and error-recovery strategies; only graph-engine startup recovery runs on Pi)
- TUI (the interactive terminal UI binary is opencode-only)

## Codex (MCP) parity

The Codex tool surface is pinned by `tests/platform/codex-mcp.test.ts`: the MCP server (`rolebox mcp`) registers the canonical intersection `buildCanonicalTools` assembles for a harness with no session client and no dispatch backend, plus `load_role_skill` — 15 tools. See [compatibility.md](compatibility.md) for the parity matrix and [codex.md](codex.md) for the documented surface.

- `session_*` tools are absent: the stdio MCP transport exposes no rolebox session client.
- `dispatch_*` / `loop_*` / `task_*` are withheld, and the `graph_*` tools are not registered either — the Codex entry builds the canonical tool set without a dispatch manager, so the graph tools are never constructed. No stubs stand in for any of them.
- `asset_hot_reload` is opencode-only and is not on the MCP surface.
- There is no permission prompt on the MCP transport: `context.ask()` is a documented no-op, so a tool that would request permission on another harness (for example `interactive_terminal` open) runs without a prompt.

### Platform-inherent gaps (explicit non-goals on Codex)

Codex drives rolebox purely over MCP instead of the PluginCore service stack, so these opencode-only subsystems are out of scope on Codex:

- Hot reload (`asset_hot_reload` tool + `HotReloadService`)
- Extensions (the PluginCore `ExtensionService` extension loader)
- Recovery engine (`RecoveryService` / `RecoveryEngine`)
- TUI (the interactive terminal UI binary is opencode-only)
- Role switching (no in-session active-role switcher)
- Hooks-driven activation (`chat.message` / `session.idle` / tool interception) — the MCP transport carries no host event stream, so activation happens per MCP call

## hashline_edit concurrency semantics

`hashline_edit` serializes edits to the same file **within a single process** (per-path async mutex covering the full read → validate → compute → recheck → write cycle) and rejects duplicate file paths in one batch, folding them by filesystem identity (dev+inode) so symlink aliases, hardlink aliases, case aliases on case-insensitive filesystems (darwin/win32), and trailing-slash spellings of the same file are all caught.

- **In-process safety**: concurrent `hashline_edit` calls to the same file cannot lost-update each other — they serialize, and the stale caller fails with a version-mismatch error. Overlapping multi-file batches acquire locks in a global sorted order, so they cannot deadlock.
- **External / cross-process changes** are only caught by a best-effort pre-write re-check: each file's content version is recomputed immediately before writing and compared to the version observed during the read phase (to-be-created files must still be absent). A file changed between that re-check and the rename (a small window) is not detected — this is **not** a strict cross-process CAS. On any detected conflict the whole batch fails with zero writes; re-run `hashline_read` and retry.
- **A batch is not a cross-file transaction**: temp files for all members are staged first and then committed. Hardlinked (in-place) members are written in the COMMIT phase after all temp files are staged, so a staging failure leaves zero writes; a commit-phase (rename) failure can still leave earlier files updated and later files untouched. In-place writes remain non-atomic. Writes are not fsync-durable; they protect against torn/partial writes within the process, not power loss. On a write failure, the error names the failed file and states which files were and were not written.
- **All `hashline_edit` failure results start with `Error:` and identify the affected file** — including pre-write re-check I/O errors such as `EISDIR` — so a caller never has to guess which file or phase a failure came from.
- **Ambiguous fuzzy anchor corrections are rejected, not silently resolved**: when multiple hash-equal candidate lines carry *differing* content (a width-2 hash collision), the edit fails with an explicit re-read error instead of picking the nearest line; same-position collisions remain accepted by the position+hash anchor contract.

## Computer use

Rolebox's `computer_*` family drives the real desktop. It is off by default
(see [compatibility.md](compatibility.md#computer-use)), and these are the
limits it does not hide.

- **No rollback of delivered input.** A click, a keystroke or a typed string
  that reached an application is already part of the desktop's state; there is
  no undo call (`deepseek-harness/docs/subsystems/computer-use.md`). Use
  `dry_run` to see the exact command before a gesture you cannot take back.
- **The desktop is shared.** Another person or process can move it between two
  calls, so a result must be verified from fresh state, never assumed.
- **Permissions belong to the application that launched the host.** On macOS,
  Screen Recording, Accessibility and Automation for System Events are granted
  to the terminal or agent process — not to rolebox — and installing the package
  grants none of them (`src/computer/drivers/darwin.ts:53-57`).
- **It does not convert coordinates for the caller.** A capture reports the
  ratio of device pixels to screen points the file itself states, as
  `metadata.pixel_scale` plus one text sentence when it is above 1
  (`src/computer/capture.ts:66-106`); the family never rewrites a coordinate, so
  a caller that read a pixel position off a screenshot must divide it by that
  scale before `computer_click` or `computer_move`, which take screen
  coordinates.
- **A window capture carries no screen origin.** `screencapture -l` with `-o`
  returns exactly the window's frame in device pixels, so a pixel in that image
  cannot be turned into a screen coordinate without the window's own bounds,
  which the result does not report; it is for reading content. Use a full-screen
  or `region` capture when the goal is to compute a click position
  (`src/computer/drivers/darwin.ts:5-21`).
- **Linux is X11 only.** A Wayland session is an explicit refusal — `scrot`,
  `import` and `xdotool` cannot inject through a Wayland compositor, and
  rolebox declares no Wayland driver (`src/computer/drivers/linux.ts:36-43`) —
  and a missing `import`/`scrot`/`xdotool` is an explicit refusal naming the
  install (`src/computer/drivers/linux.ts:30-34`,
  `src/computer/exec.ts:112-119`).
- **Codex has no permission prompt and no role.** On the MCP transport
  `context.ask()` is a documented no-op (see
  [Codex (MCP) parity](#codex-mcp-parity)) and no rolebox role is active
  (`src/entries/codex.ts:10-22`), so the global `computerUse` gate is the whole
  policy there: there is no per-call approval and no per-role grant to fall back
  on.
- **A screenshot needs an image-capable model route.** Each host translates the
  image attachment its own way
  ([computer-use.md](computer-use.md#image-transport-per-host)); on dsh the bytes
  must be committed through the host attachment service, and with no attachment
  service wired the model gets the text line plus the saved path under
  `.rolebox/computer/` instead of an image.
- **Registration is host-side.** dsh, Pi and Codex register the seven tools
  themselves (`src/entries/dsh.ts:2237-2246`, `src/entries/pi.ts:1244`,
  `src/entries/codex.ts:138`); the two opencode entries enforce the gate and the
  per-role grant as agent-config tool rules
  (`src/prompt/agent-config.ts:119-144`). A host that registers no `computer_*`
  tool shows none to any role, whatever that role's `tools:` map says.
- **Windows needs PowerShell and an interactive session**, and an unlisted
  platform is refused outright
  (`src/computer/drivers/win32.ts:14-17`, `src/computer/drivers/unsupported.ts:13-17`).
- **The Linux and Windows drivers are unit-tested here, not exercised against a
  live desktop.** Every tool test that does not capture the screen runs through
  `dry_run` and asserts the plan the driver built; on macOS two tests perform one
  real, input-free screenshot (`tests/computer/capture-darwin.test.ts:45-86`,
  `:88-97`). No test synthesizes real mouse or keyboard input
  (`src/computer/tools.ts:12-15`).
