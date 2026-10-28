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

The Codex tool surface is pinned by `tests/platform/codex-mcp.test.ts`: the MCP server (`rolebox mcp`) registers the canonical intersection `buildCanonicalTools` assembles for a harness with no session client and no dispatch backend, plus `load_role_skill` — 18 tools. See [compatibility.md](compatibility.md) for the parity matrix and [codex.md](codex.md) for the documented surface.

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

Rolebox's `computer_*` family drives the real desktop and is available by default
on DSH, Pi and Codex (see [compatibility.md](compatibility.md#computer-use)).
Operating-system permissions and these platform limits still apply.

- **No rollback of delivered input.** A click, a keystroke or a typed string
  that reached an application is already part of the desktop's state; there is
  no undo call (`deepseek-harness/docs/subsystems/computer-use.md`). Use
  `dry_run` to see the exact command before a gesture you cannot take back.
- **The desktop is shared.** Another person or process can move it between two
  calls, so a result must be verified from fresh state, never assumed.
- **Permissions belong to the application that launched the host.** On macOS,
  Screen Recording, Accessibility and Automation for System Events are granted
  to the terminal or agent process — not to rolebox — and installing the package
  grants none of them (`src/computer/drivers/darwin.ts:59-63`).
  `computer_permissions` reads this process's own TCC Accessibility trust
  (`AXIsProcessTrusted` through JXA), never the global `UI elements enabled`
  preference, which is a System Events UI-scripting setting and can answer `true`
  while the OS is already blocking input. `request: true` requests missing
  Accessibility and Screen Recording permissions, then probes again; the user
  must approve OS requests and may need to restart the host. A host that is already granted cannot exercise the denial path in a
  test — that needs the grant revoked in System Settings and the host restarted
  — so the fail-closed reading of an empty or unrecognized probe answer is
  covered by unit tests over the verdict, not by a real denial. The window list
  is the exception: it reads the window server's own list and needs no grant at
  all, though its title column stays empty without Screen Recording.
- **Screenshot coordinates need a current snapshot.** Pointer tools map image
  pixels automatically with `screenshot_id`; without it they take absolute
  screen coordinates. Captures report their origin and per-axis pixel scales.
  Window moves/resizes and display changes invalidate guarded input and require
  recapture. This detects geometry changes, not every UI content change, and
  cannot lock out another process after the check or during a drag. IDs expire
  after ten minutes and are scoped to the session, workspace and platform.
- **Capture support has platform limits.** macOS screenshots require Screen Recording
  permission for the application launching the host. Windows and X11 window
  captures include occluding content; focus first. X11 captures client areas
  without decorations, requires RandR 1.5 monitor support, and refuses regions
  outside the current X root screen. See [computer-use.md](computer-use.md#screenshots-and-coordinates).
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
- **Registration is host-side.** dsh, Pi and Codex register the 12 tools
  themselves (`src/entries/dsh.ts:2237-2246`, `src/entries/pi.ts:1244`,
  `src/entries/codex.ts:138`); the two opencode entries enforce the gate and the
  explicit role restrictions as agent-config tool rules
  (`src/prompt/agent-config.ts:119-144`). A host that registers no `computer_*`
  tool shows none to any role, whatever that role's `tools:` map says.
- **Windows needs PowerShell and an interactive session**, and an unlisted
  platform is refused outright
  (`src/computer/drivers/win32.ts:14-17`, `src/computer/drivers/unsupported.ts:13-17`).
- **The Linux and Windows drivers require live desktop validation.** Tests
  cover command plans, fake-helper execution, permission verdicts, cancellation,
  and host transport. They do not establish live behavior on every operating
  system. The separate macOS capture tests require a GUI session and OS grants.
  No test sends real mouse or keyboard input.

## Browser use

Rolebox's `browse_*` family drives a real Playwright browser and exists only
when its `browseUse` gate is on (see
[compatibility.md](compatibility.md#browser-use)). These limits remain:

- **Playwright is optional, so the family can be absent.** With no explicit
  setting the gate is on only when `playwright` resolves from the rolebox
  install. An explicit `browseUse: true` registers the 23 tools even without the
  driver so `browse_status` can report the gap, but every action fails until the
  driver (`npm install playwright`) and a browser build
  (`npx playwright install chromium`) are installed. The gate is read at boot;
  a change needs a restart.
- **The browser has this machine's network reach.** `browse_open` validates
  only that the target is an absolute URL with a scheme a browser can load
  (`http`, `https`, `file`, `about`, `data`); there is no SSRF filter and no
  block list for loopback, private or link-local addresses. That is what makes a
  `localhost` development server a normal target, and it also means a page can
  reach whatever the host can reach.
- **An attached browser belongs to someone else.** `cdp_url` (Chromium only)
  reuses the context of a browser that is already running, so its cookies,
  logins and open tabs are the user's existing state. The family closes only the
  pages it created and never sends `Browser.close` to a browser it did not
  launch, which also means the user can see and change that browser between two
  calls.
- **CDP attachment uses the Node runtime.** The supported CLI/MCP path runs on
  Node.js 26.4+. A host that embeds the plugin in another runtime needs its own
  transport compatibility verification; the Node acceptance suite does not
  establish compatibility for those hosts.
- **Refs are not durable identifiers.** A ref exists only in the snapshot that
  printed it, is per page, is replaced by the next snapshot, and is dropped by
  navigation. An older ref is refused as `stale_ref` rather than resolved
  against whatever element now occupies its place. Iframes are reported as a
  line and not entered, and content inside a shadow root or a canvas has no ref,
  so a page built that way may have to be read with `browse_read` or driven with
  `browse_eval`.
- **A pending dialog blocks every other action on the page.** Only
  `browse_dialog` (and a non-blocking look through `browse_status`) is usable
  until the dialog is accepted or dismissed.
- **No action has rollback, and delivery is not effect.** A click or a
  keystroke that returned successfully changed the page already, and a
  successful call proves only that the browser delivered it. `browse_eval` runs
  arbitrary JavaScript in the page context, with a default 15-second limit.
  Cancelling or timing out an evaluation closes its page to release the session
  queue; reopen it with `browse_open`. Verify a change with a snapshot, a
  read, a console check or a screenshot before reporting it.
- **Artifacts stay in the worktree.** Screenshots and downloads are written
  under `.rolebox/browse/` in owner-only files and directories, a screenshot
  above 32 MiB is refused, and a download's filename is sanitized — but its
  contents are whatever the page served. A capture can show a page that holds
  sensitive data, so treat the directory like the page.
- **Browser builds are per engine, and only Chromium can be checked.**
  `browse_open` accepts `firefox` and `webkit`, and each fails at launch until
  its own Playwright build is installed. `browse_status` reports Chromium's
  presence only when `PLAYWRIGHT_BROWSERS_PATH` names the cache; otherwise the
  binary state is reported as unknown rather than guessed.
- **Codex has no per-call approval and no active role.** On the MCP transport
  the global `browseUse` gate is the whole policy. DSH, Pi and the two OpenCode
  entries additionally apply per-role rules; OpenCode registers no `browse_*`
  tool at all, whatever a role's `tools:` map says.
- **The default test suite never launches a browser.** The family's tests run
  against an in-memory driver, and the live Playwright check is skipped unless
  `ROLEBOX_BROWSE_LIVE=1`. Unit tests establish the tool, session and result
  contracts; they do not establish how any particular site behaves.
