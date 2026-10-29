# Runtime features

## Browser and desktop gates

Global gates live in `<rolebox-config-home>/config.yaml`; project gates live in
`<workspace>/.rolebox/config.json`. DSH also exposes host plugin options. Any
explicit `false` or invalid/unreadable configuration disables that family at
startup; an enablement elsewhere cannot override the veto.

```yaml
computerUse: false
browseUse: false
```

Computer tools are available by default, subject to host and OS permissions.
`computer_status` diagnoses availability and `computer_permissions` checks or
requests OS permissions. Enabling the family does not confer OS permission.

For multiple windows, discover current IDs with `computer_windows`, use
`computer_focus` to bring a window forward for observation, then capture a
fresh image with `computer_screenshot`. All six input tools (`computer_click`,
`computer_move`, `computer_type`, `computer_key`, `computer_scroll` and
`computer_drag`) accept optional `window_id` on macOS, Windows and Linux X11.
Each targeted call focuses and verifies the selected window before sending
input within the same helper command and process-local queue slot. A missing,
ambiguous or refused target stops the operation. Repeat `window_id` on each
call; no selection persists, and omitting it uses the current desktop focus.
Windows discovery includes multiple visible top-level windows per process.

For example, call `computer_type` with `{"window_id":42,"text":"Example"}`
after observing window 42. Targeting brings a window forward; it does not
provide background input or lock out external focus changes. Pointer positions
remain absolute screen coordinates unless `screenshot_id` is supplied;
`window_id` does not
translate or constrain them. Use fresh coordinates inside the target window.
For targeted scrolling, supply both `x` and `y` to place the pointer; omitting
them scrolls at its current position. Windows and X11 window captures copy
visible screen content, including covering windows; X11 excludes decorations.
Focus first and verify the UI after each action. These arguments need no additional role
configuration; restart the host after updating rolebox to load the new schemas.

For multiple monitors, call `computer_displays` for current IDs, bounds, names,
UI scales and primary flags. IDs are 1-based on macOS and 0-based on Windows
and X11; refresh them after changing the display layout. X11 lists RandR
monitors on the current `DISPLAY` screen, not independent X screens. Its
default capture uses the primary monitor, or the first if none is primary.

Every successful `computer_screenshot` returns `screenshot_id`,
`screen_bounds: {x,y,w,h}`, `origin`, `pixel_scale_x`, `pixel_scale_y`, and
`displays`. A uniform ratio is also exposed as `pixel_scale`. Ratios come from
the actual PNG size and captured geometry, including fractional scales and
negative origins. Display UI scale is separate: Windows and X11 input uses
desktop/root pixels (X11 reports scale 1), while macOS uses global screen points.
macOS window capture preserves the native raster and reports its per-axis
ratios to the window bounds. Region/display
capture composites separate monitor intersections onto a uniform canvas, so
global regions may span monitors with different scales.

Pass `{"screenshot_id":"<returned id>","x":100,"y":60}` to `computer_click`
or `computer_move` to use image pixels. `computer_drag` maps both endpoints;
`computer_scroll` requires both coordinates with an ID. The captured window is
selected automatically; any explicit `window_id` must match that window.
Display/region screenshots cannot be combined with `window_id`. Outside-image
points and monitor gaps are refused. Without an ID, coordinates keep their
absolute-screen meaning. Manual conversion is `origin.x + image_x /
pixel_scale_x` and `origin.y + image_y / pixel_scale_y`.

Capture verifies geometry before and after the image. Input with an ID checks
it again after focus: moving/resizing a captured window or changing display
bounds, order, identities or scales requires a fresh screenshot. Recapturing
after a cross-monitor move uses the new origin and scale; stale UI positions
are never silently rebased. IDs are session/workspace/platform scoped, expire
after ten minutes, and the host retains at most 64; restart clears them. This
does not freeze the desktop or detect scrolling/content changes within an
unchanged frame. Observe the UI again after each action.

macOS captures use the built-in `screencapture` through JXA. Window captures
exclude shadows and preserve native raster resolution; display/region captures
compose individual monitor tiles onto a uniform logical canvas. X11 geometry needs `xrandr`
with RandR 1.5 plus `awk`; window geometry also uses `xdotool`. X11 targets must
fit inside the current root screen. Wayland remains unsupported.

Browser tools default to auto-detecting optional Playwright from the rolebox
installation. `browseUse: true` registers them even if the driver is missing so
`browse_status` can explain the gap; `false` disables them. A project dependency
that the rolebox package cannot resolve is insufficient. Use the status tool's
installation guidance rather than assuming the browser executable is present.
These settings are global/project/host options, not `role.yaml` fields.

`browse_eval` runs `expression` in the selected page without automatically waiting
for DOM elements or retrying failures. Its `metadata.code` distinguishes
`script_error` (an identifiable JavaScript exception or rejected Promise) from
`execution_context_destroyed` (navigation or frame detachment), `browser_closed`,
`timeout`, `cancelled`, and `protocol_error` (driver/protocol or unrecognized
failures). Script exceptions are identified by JavaScript error prefixes or page
execution frames; ambiguous errors such as thrown primitives without those
markers remain `protocol_error`. For script errors, fix syntax or page globals;
for null/undefined access, confirm the page and selector with `browse_snapshot`,
wait with `browse_wait`, and guard missing values. Navigation interruptions need
a fresh page observation after navigation finishes. Script errors leave the page
open; timeout/cancellation closes it, so reopen with `browse_open`. Raising
`timeout_ms` does not fix a synchronous script exception. Reserve `browse_status`
for driver availability or persistent protocol failures. This behavior applies
to every harness exposing `browse_eval`; restart the host after updating rolebox.

## Hooks and recovery

Declare custom hooks in `role.yaml`:

```yaml
hooks:
  builtin:
    session_error: true
    bash_file_read_guard: false
  custom:
    - name: quality-check
      description: Check changed files after an edit.
      events: [tool.execute.after]
      module: hooks/quality-check.js
      filter:
        tools: [edit, write, hashline_edit]
      priority: 50
      phase: after
      config:
        severity: warn
```

Hook modules resolve relative to the role directory or from an absolute path.
They use named exports `onChatMessage(ctx, input)`, `onToolBefore(ctx, input)`,
`onToolAfter(ctx, input)`, `onSystemTransform(ctx, input)` and/or
`onEvent(ctx, input)`. Optional `onLoad(ctx)` and `onDispose(ctx)` manage
lifecycle. For example, `hooks/quality-check.js` can export:

```javascript
export async function onToolAfter(ctx, input) {
  if (input.output == null) ctx.inject("The edit returned no output; verify the file before continuing.");
}
```

Supported events are `chat.message`,
`tool.execute.before`, `tool.execute.after`, `system.transform`, and `event`.
`filter.tools` selects tool names, `filter.eventTypes` selects event subtypes.
Lower priorities run earlier; default is 50. Phase is `before` or `after`
built-ins, default `after`. A hook failure is logged independently.

Known `hooks.builtin` keys:

| Default | Keys |
| --- | --- |
| Enabled | `session_error`, `edit_error`, `json_error`, `context_window`, `empty_response` |
| Disabled | `tool_pair_validation`, `write_existing_file_guard`, `bash_file_read_guard`, `webfetch_redirect_guard` |
| Enabled master switch | `recovery` |

Unknown keys warn and have no effect. Loaded roles' flags are combined by the
service; do not assume the block is an isolated per-call policy.

Recovery chain options belong under `hooks.recovery`, not a root `recovery` key:

```yaml
hooks:
  recovery:
    enabled: true
    max_total_attempts: 10
    persist_state: true
    collect_metrics: true
    edit_error:
      chain:
        - strategy: remind_and_retry
          config:
            max_retries: 2
            reminder_text: Re-read the changed file before retrying the edit.
```

Chain categories include `session_error`, `context_window`, `edit_error`,
`json_error`, `empty_response`, `tool_pair`, `guard_violation`. Known strategies
are `retry`, `compact`, `fallback_model`, `abort`, `remind_and_retry`, `truncate`
and `summarize`. Strategies need host support for their action. With multiple
roles, the service uses the first supplied recovery configuration; configure a
consistent policy rather than relying on role discovery order. Disabling
`hooks.builtin.recovery` prevents creating the recovery engine.

## Copilot continuation

Copilot is opt-in per root role:

```yaml
copilot:
  enabled: true
  rules:
    - id: wait-for-user
      match:
        contains: waiting for user input
      action: skip
    - id: continue-work
      match:
        contains: work remains
      action: continue
      reply: Continue the authorized task and verify the result.
```

The pipeline evaluates built-in active-function continuation first, ordered
Copilot rules second, and an optional LLM verdict last. First matching rule
wins; `pattern` is a regex and `contains` is case-insensitive. If both are
present they must both match. `skip` consumes the decision with no injection or
LLM fallback; `continue`, `blocked` and `done` inject their reply/default reply.
Disabling Copilot leaves built-in function continuation in place.

An optional `copilot.llm` block names a resolved private subagent:

```yaml
copilot:
  enabled: true
  llm:
    role: reviewer--continuation-judge
    max_verdict_timeout_ms: 30000
    transcript:
      window_size: 20
      max_chars: 8000
      include_tools: true
```

Create that judge subagent before enabling this block. `guidance`, if supplied,
replaces the default advisory guidance entirely. The judge uses a fresh child
session; unknown role, timeout or failed verdict skips the LLM decision without
retry. Copilot requires host idle/message hooks and is not installed into native
Codex conversations by the MCP server.

## Notifications

Set `ROLEBOX_NOTIFICATIONS_CONFIG` to a YAML file containing the notification
block directly, without a `notifications:` wrapper:

```yaml
enabled: true
mainSessionOnly: true
idleDelayMs: 1500
channels:
  - kind: system_toast
    enabled: true
events:
  approval_pending:
    enabled: true
  idle:
    enabled: false
quietHours:
  enabled: true
  timezone: Asia/Shanghai
  ranges:
    - start: "23:00"
      end: "08:00"
throttle:
  windowMs: 3000
  maxPerWindow: 3
```

Global defaults enable notifications but supply no channels. Channel kinds are
`system_toast`, `sound` (`soundPath`), `custom_command` (`command`, optional
`passAsStdin`, `env`), `webhook` (`url`, optional `headers`, `timeoutMs`), `file`
(`path`) and `log` (optional `level`). Keep URLs/headers with credentials in
environment placeholders such as `{env:NOTIFICATION_URL}`. Configure external
delivery only within the user's requested scope.

Events include `idle`, `question`, `permission`, `error`, `dispatch_complete`,
`dispatch_progress`, `loop_complete`, `approval_pending`, `session_deleted` and
custom names. Per-event settings include `enabled`, `channels`, `titleTemplate`,
`messageTemplate`, `throttle` and `quietHoursOverride`. `questionToolNames`
customizes detection. A quiet-hours range can specify `days: [Mon, Tue]`.
`ROLEBOX_NOTIFICATIONS_ENABLED=false` or `0` disables the global configuration.

Programmatic role notification configuration replaces scalar defaults and the
channel list, merging events by key. The current YAML role loader drops a
`notifications:` field, so use the global file for file-authored roles. Do not
claim a per-role YAML notification override will work in this version.

## Extensions

The extension registry supports custom conditions, graph topologies, recovery
strategies/patterns, notification channels and observe events. It is additive;
module failures are logged and skipped. However, the current YAML role loader
does not retain `extensions`, so merely adding an `extensions:` block to a role
file does not register modules. A working programmatic integration is required.
Do not invent a file configuration workaround or edit rolebox internals as part
of an ordinary configuration task; explain this limitation if the user needs it.

## LSP

Rolebox selects language servers by file extension and project markers and starts
them lazily. Put the relevant server executable on the host process's `PATH`:

| Languages | Executable |
| --- | --- |
| TypeScript / JavaScript | `typescript-language-server` |
| Python | `pyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| C / C++ | `clangd` |
| Java | `jdtls` |
| Ruby | `solargraph` |
| Shell | `bash-language-server` |
| Lua | `lua-language-server` |
| Kotlin | `kotlin-lsp` |

There is no general `lsp:` block in `role.yaml`. Use `lsp_diagnostics` on a real
project file, when registered, and host logs for discovery/startup failures. Install/configure
the server through its own supported mechanisms, then restart the host if its
environment was changed.
