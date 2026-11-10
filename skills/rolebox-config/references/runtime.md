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

### Operation videos and timelines

Use `browse_record` and `computer_record` with `action: start`, `status` or `stop`
to record AI tool use as an MP4 plus a synchronized JSONL timeline and local HTML
replay. These tools inherit their family's global/project/host gate, role tool
rules and worker grants; there is no separate recording config or `role.yaml`
field. DSH, Pi and Codex expose them when the corresponding family is registered;
the OpenCode entries do not register either family. Restart the host after
updating rolebox to load the schemas.

Open a browser page first, then call `browse_record` with
`{"action":"start","page":"main","fps":2,"max_duration_ms":120000}`.
The page defaults to the active page at start and stays fixed across tab switches
and navigation. Closed pages stop sampling rather than reopening. For desktop
recording, call `computer_record` with `{"action":"start","window_id":42}`;
select at most one of `window_id`, `region` or `display`, or omit them to capture
the default display. Capturing does not focus a window and keeps the same
platform/occlusion limitations as screenshots. Recording samples do not consume
desktop screenshot IDs. Browser recording samples do not reset idle expiry.

Both tools require `ffmpeg` with `libx264` on the host's `PATH`. Desktop recording
also needs the normal screen-capture helpers and OS authorization; start never
opens an OS permission prompt. Browser recording uses the existing Playwright
driver, including its supported browser engines and CDP sessions. `status` does
not launch or capture. `fps` requests 1–5 sampled screenshots per second, default
2; capture time and the existing operation queues can reduce the rate. There is
no audio, and brief changes between samples may be missed. Encoding preserves
wall-clock intervals and uses a fixed canvas within 1920×1080; stop attempts a
final frame before encoding.

Continue normal tool calls after start, then call `{"action":"stop"}`. The
result contains `video_path`, `timeline_path`, `replay_path` and `directory` under
`.rolebox/<browse|computer>/recordings/<generated-id>/`; `manifest.json` is saved
there too. Open `replay.html` locally to play the video and select a step to seek.
Timeline steps cover calls to the corresponding tool family in that host session
and worktree. They include relative start/end milliseconds (including queue
time), success or an incomplete marker, and safe arguments such as coordinates,
element refs and input lengths. Typed text, raw key contents, arbitrary selectors,
URLs, cookies, evaluated code and raw results are omitted. Video retains visible
content; inspect artifacts before sharing. POSIX directories/files are created
with owner-only permissions.

One recording per family/session/worktree runs at once, with at most four active
recordings per family in a process. Recording persists across turns and stops on
`stop`, capture failure, 256 MiB of raw frames, 5,000 tool steps or
`max_duration_ms` (default 120000; range 1000–600000). Check `status` for automatic
stop reasons. `stop` is idempotent and waits for MP4 encoding, with a 60-second
encoding limit. Failure/cancellation keeps raw frames for recovery. Stop before
closing a target or ending the host. A host restart does not resume live state.
Each family retains 32 recent session records in memory; older completed records
may be forgotten by `status`, while their files remain on disk.
Use the actual `browse_record` name; the browser family is `browse_*`.

## Hooks and recovery

Codex's app-server adapter observes events only for managed worker threads. It does
not install rolebox's `chat.message`, native tool-interception or idle hooks into
UI-owned Codex conversations, and it does not install PluginCore hot reload,
extensions, recovery or a role switcher. Native-agent files and graph execution do
not change that boundary.

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

## Copilot suggestions and automatic continuation

`copilot.draft` generates a possible next human message. Browser modes choose
whether to show it as a hint card or send it automatically to continue the
session. It is a dsh web feature: the host exposes
`POST /rolebox/copilot/suggest` and the dsh web client adds the button. Other
harnesses do not register either half.

Configure it in any of three places; the effective config merges field by field
with the highest source first:

| Precedence | Source | Key |
| --- | --- | --- |
| 1 (highest) | Acting role's `role.yaml` | `copilot.draft` |
| 2 | `<workspace>/.rolebox/config.json` | `copilot.draft` |
| 3 (lowest) | `<rolebox-config-home>/config.yaml` | `copilot.draft` |

A role does not need to configure the feature: a role-less session (or a role
with no `copilot` block) simply contributes no fields, and the project/global
files can supply everything. All three sources use the same block:

```yaml
copilot:
  draft:
    enabled: true
    provider: example-provider
    model: example-model
    timeout_ms: 4000
    max_chars: 120
    window_size: 40
    transcript_max_chars: 24000
```

The same shape is the `copilot` value in `.rolebox/config.json`:

```json
{
  "copilot": {
    "draft": {
      "enabled": true,
      "provider": "example-provider",
      "model": "example-model"
    }
  }
}
```

| Field | Default | Bounds / requirement |
| --- | --- | --- |
| `enabled` | `false` | Master toggle; three-state: a present `true`/`false` wins, absent inherits, final default off. Boolean strings are coerced. |
| `provider` | — | Required with `model` when enabled; non-empty string. |
| `model` | — | Required with `provider` when enabled; non-empty string. |
| `timeout_ms` | `4000` | Clamped to 200–10000; one model call, no retry. A ceiling, not added latency: the call answers as soon as the provider responds, and a timeout degrades to a silent `none`. |
| `max_chars` | `120` | Clamped to 16–500; draft length, word-boundary preferred. |
| `window_size` | `40` | Clamped to 2–200; recent text-bearing user/assistant messages, plus initial user goal and latest exchange when outside the window. Tool-only messages do not count. |
| `transcript_max_chars` | `24000` | Clamped to 500–128000; total transcript cap, preserving user goal and latest exchange before filling other context. |

The host reads the requested session's available history and selects the window
locally. It retains the first user message, latest user message and latest
assistant reply as additional excerpts when outside that window. Ignored and
synthetic text parts and reasoning are excluded. Within the character cap,
those anchors receive reserved space, recent user constraints take priority
over older assistant progress, and long messages retain both opening and
closing text with a truncation marker and their role label. Whitespace is
collapsed within each message. Only the last 12 tool-result summaries are
eligible, using leftover space up to one eighth of the budget and at most 2000
characters. Content already removed from the host's history cannot be recovered.

Explicit settings still win: an existing `window_size: 8` or
`transcript_max_chars: 4000` retains that smaller budget. Remove those fields to
use the new defaults, or increase them explicitly.

Merge rules: every field resolves independently. An invalid value warns once and
is treated as absent, so a lower-precedence source can still supply it. A role
`enabled: false` overrides an enabled project/global config. Both files are read
once at plugin boot with no watching; an unreadable or malformed file warns and
contributes nothing (it never fails the boot). Restart the host or reload the
plugin after editing a file.

A request also needs the host's `llm` service. Anything missing answers
`disabled` (`not-enabled`, `model-not-configured`, `llm-unavailable`), and the
browser stops asking for that session. The single model call disables reasoning
(`reasoningEffort: "off"`) when the selected route advertises an `off` effort: a
one-line next-message prediction must not pay for chain-of-thought, which spends
seconds before the first token and leaves only a silent `none`. The suggester
reads the route's capability metadata first (a read-only lookup, not a model
call) and omits the field for a route with no reasoning metadata, because the
host rejects an unsupported effort (`UNSUPPORTED_REASONING_EFFORT`) before the
adapter runs; that route then uses the provider's own reasoning default instead
of failing. In automatic modes, an eligible idle session with an empty draft
and no attachments waits 300 ms and posts once. An automatic `none`, timeout or
error is not retried until the next turn; choosing a different automatic mode
can start a fresh attempt for the current idle. A manual click cancels the
pending automatic timer and can ask again.

When no result is open, hover or keyboard-focus Suggest / 建议 to open the
settings panel. This panel alone contains the **Copilot mode / Copilot 模式**
selector and a short description of the selected mode:

| Mode | UI label | Behavior |
| --- | --- | --- |
| `none` | Off / 关闭 | No requests or automatic sends; the suggestion button is disabled, settings stay reachable. |
| `manual` | Manual suggestions / 仅手动建议 | Clicking Suggest generates a hint card. Fill writes the draft; the user sends it. |
| `auto-advise` (default) | Automatic suggestions / 自动建议 | An eligible idle automatically generates a hint card. The user chooses whether to fill and send it. |
| `auto-mated` | Automatic continuation / 全自动接续 | An automatic answer is filled and submitted through the host's normal composer actions. After the next turn, the cycle repeats; no suggestion means it stops. Manual clicks still show a card. |

Full automation must be selected explicitly. Its pill reads Auto continue /
自动接续. It runs in the mounted DSH browser control, not as a host background
job, and has no separate turn budget. It still requires an enabled host config
and a configured model. Host submission admission and failure handling apply;
a failed send is not retried automatically. If the host lacks a composer submit
action, the answer falls back to a hint card.

All other answers appear as a card above the button with the eyebrow
Suggestion / 建议, the text, Fill / 填入 and Dismiss / 忽略. Fill writes the
composer without sending, even in full automation mode. Dismiss writes nothing.
Typing, adding attachments, leaving the plain input phase, a new turn, a
session switch, unmount, Fill and Dismiss clear the card. Dismissal does not
re-ask during the same idle. The card contains only the suggestion and its
Fill / Dismiss actions, with no mode settings. The card takes no focus; hover
settings stay hidden while a suggestion or status card is open. To change the
mode, close the result first with Fill, Dismiss or Escape as applicable, then
hover again or move keyboard focus out of the control and back in.
Loading reads Suggesting / 生成中. Disabled reasons
remain available through the button's accessible description.

Clicking Suggest while a card is visible keeps the existing card mounted and
marks it busy until the replacement arrives. A new suggestion replaces its
text; a `none`/`disabled` result replaces it with a short status card. Starting
a manual request closes hover settings. Fill, Dismiss and Escape close the
result directly and cancel a pending manual replacement, so late answers cannot
reopen it or flash settings underneath. A fresh pointer entry or focus from
outside the control can open settings again. Floating panels use a solid
theme background and no opacity transition.

Changing modes cancels the pending automatic timer and request, drops late
automatic responses and dismisses an automatic card. Switching to `none` also
cancels manual requests and clears manual cards. Other mode changes preserve
manual work and never promote a displayed card or a pending request into an
automatic send. Typing, attachments, an editor revision change, a new turn,
a session switch or unmount invalidates requests before they can fill or send.
Existing text and attachments are never submitted by Copilot.

The pointer can move into the panel without closing it. Tab reaches the native
mode selector, arrow keys choose a mode (Enter confirms where needed), and
Escape closes the panel/card and restores focus. A disabled/loading button's
wrapper remains focusable.

The preference is browser-local, stored in `localStorage` under
`rolebox.copilot.mode`. A valid mode takes precedence over the former
`rolebox.copilot.autoSuggest` key. When the new key is absent, the old string
`false` maps to `manual`; any other old value or no preference maps to
`auto-advise`. An invalid new value also falls back to `auto-advise`, never
full automation. It applies across sessions on the same DSH origin, survives
reloads and synchronizes mounted controls and browser tabs. Blocked storage
still permits a page-local preference. It is not a `role.yaml` or project/global
configuration field and cannot override `copilot.draft.enabled: false`.
Refresh after installing the updated browser bundle; choosing a mode needs
no host restart.

The request body is `{ "session": "<id>", "intent": "auto" | "manual" }`.
`intent` is optional and defaults to `"auto"` (any other present value is a
400). It selects only the prompt's miss rule: an automatic request is
conservative and may answer nothing when the task looks finished, while a
manual request (the button click) looks for a useful continuation of the current
task but may answer nothing when no grounded candidate exists. Both intents
must follow the session's user goal and constraints, with the latest user
instructions and topic changes taking precedence. They must avoid unrelated
tasks, repeating completed work and generic testing/review/refactoring without
an unresolved need. They must not guess facts or preferences only the user
knows; an assistant's optional offer alone is not a new user request. A
transcript without a usable user/assistant exchange returns `none` without a
model call. A manual request that still yields no draft shows a separate
4-second status card — "No suggestion right now" / 暂时没有合适的建议. A manual
`disabled` answer shows the disabled title and reason the same way. Automatic
requests never raise the notice. Typing, a new turn, a session switch, Escape
or unmount clears it; expiry closes it without revealing hover settings.

Privacy: selected excerpts from this session, including initial/latest user
messages and the latest assistant reply even when outside `window_size`, plus
recent dialogue and brief tool summaries within `transcript_max_chars`, are
sent to the configured `provider`/`model` — which may differ from the model
running the session.

The old top-level `copilot.enabled`, `copilot.rules` and `copilot.llm` turn-end
decision modes were removed. They are ignored with one warning per key; use
`copilot.draft` instead. Built-in function auto-continuation is unchanged and
independent of `copilot`.

## Codex session and worker runtime

The six Codex session tools browse native threads through app-server, with
workspace filtering and paginated turns/items. `session_diff` shows recorded file
patches. `session_fork` requires host sandbox metadata and a completed turn boundary:
use a turn ID or that turn's final message ID, never a message in the middle of a
turn. Live todos and execution state require events from an app-server this adapter
owns; another process's thread may report `notLoaded` here and remains unknown.
Token/cost telemetry is not supplied by this adapter.

Fatal transport failure rejects pending calls and terminates the app-server process
tree. MCP close, `SIGINT` and `SIGTERM` also clean up managed descendants. These
local actions do not establish a native turn outcome: absent a terminal event, the
execution remains unknown. The adapter does not automatically restart the transport
or retry a worker.

Per-call `_meta.threadId` supplies thread identity; `_meta.sessionId` may be shared
by forks and is not a worker identity. Legacy connection identity remains usable
for standalone tools but cannot execute graph tools. Native role attribution reads
the thread's `agentRole`; attributed roles narrow rolebox tool calls. Global
browser/desktop gates still control registration, and OS permissions still apply.

Codex graph declarations report `parent_notification.available`. A verified shared
app-server connection lets the parent end its turn; graph completion or attention
then delivers tool output to that host and starts a new parent turn if idle.
The durable outbox retries unavailable delivery with the same notification ID.
Delivery never starts another app-server or cold-resumes an external UI thread.
Missing or unowned shared connections report unavailable rather than promising a
wake-up. `ROLEBOX_CODEX_PARENT_SOCKET` selects an absolute socket path, defaults to
discovery under the Codex home, and accepts `off` to disable this channel.

As a fallback, Codex's `graph_wait` holds the current tool call until its selected
run completes, stops or needs attention. Use it instead of polling status when the
parent notification channel is unavailable.
It returns a committed snapshot and accepted output; only `status: "complete"`
permits dependent work. Timeout defaults to 540000 ms; renew a timed-out wait with
its returned graph/run IDs. Cancelling a wait or closing the MCP connection releases
the wait without issuing graph control. It cannot wake an ended UI turn. See
[Codex orchestration](orchestration.md#codex-execution) for fields and limits.

The MCP `ask()` callback remains unavailable for standalone tools. Managed graph
workers reject fresh interactive approval/input requests and use native task tools
inside the inherited sandbox. Their outer-process dynamic face contains only
outcome submission and allowed scoped resource reads. They do not receive
`hashline_edit`, interactive terminal, desktop or browser tools through that face.
Cancellation during a pending turn start is queued until the turn ID arrives;
`requested` is distinct from Codex's interrupted confirmation. A positive node
`timeout_ms` includes launch time, records timeout control for the exact attempt and
requests interruption. Zero disables the watchdog, and expiry never retries work.
See [Orchestration](orchestration.md#codex-execution) for graph result collection,
cancellation and restart behavior.

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

OpenCode, Pi and DSH expose the same 32 `lsp_*` tools. The Codex integration does
not expose this family. Rolebox selects the server by file extension and starts
it on the first file operation; the server reads the workspace's project
configuration. Servers are not installed automatically. Put the relevant
executable on the host process's `PATH`:

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

There is no general `lsp:` block in `role.yaml`. Install/configure the server
through its own supported mechanisms, then restart the host if its environment
was changed. TypeScript/JavaScript also needs a TypeScript installation that
`typescript-language-server` can resolve.

On DSH the family is enabled by default. `enabledNamespaces: ["lsp"]` registers
only LSP tools; `["*", "!lsp"]` excludes them. Exact names such as `lsp_hover`
also work. This is the normal plugin namespace filter, not an LSP-specific
setting. A host-owned name uses the usual `rb_` collision fallback (for example
`rb_lsp_hover`); use the names actually discovered in the session. Restart DSH
after changing the plugin's registration settings.

DSH keeps separate language-server processes, open documents and diagnostic
caches per session workspace. The host working-directory service takes
precedence, then the latest `working-directory/change` event, then the session
header's `cwd`; calls without session workspace metadata fall back to the
process working directory. Sessions in the same workspace share its servers.
The service tracks sessions that have used LSP. Changing one of those sessions'
workspaces transfers its reference; `session/disposed` releases it. When the last
such session leaves a workspace, it is retired immediately, even if no further
tool is called. Accepted calls finish on that generation before its documents,
diagnostic state and child processes are closed. Other sessions using the same
workspace keep their shared servers. Calls without a known session retain a
workspace only while their calls are in flight. Plugin unload releases all
remaining workspaces and waits for their cleanup.

Cleanup drains accepted calls first; ordinary LSP requests can each take up to
30 seconds to time out. The shutdown request has a separate two-second deadline,
followed by SIGTERM and, if the process remains alive for another two seconds,
SIGKILL. This bounds shutdown negotiation, not the total time spent draining a
tool that performs several requests. Failed or timed-out initialization also
awaits this termination sequence before another start can use that language.
Three consecutive startup failures require `lsp_restart_server`; a successful
initialization resets the failure count, so healthy restarts do not accumulate
past crashes. In-flight requests are cancelled when their server shuts down.

Start with `lsp_servers` to inspect discovery without launching a process, then
call `lsp_hover` or `lsp_diagnostics` with an absolute project file path. For
example, `lsp_hover` accepts:

```json
{"filePath":"/path/to/project/src/index.ts","line":0,"character":0}
```

Positions are zero-based UTF-16 line/character offsets. Document synchronization,
requests and diagnostic caches use the same canonical file URI, including
Windows drives, UNC paths and reserved filename characters. Equivalent file URI
encodings returned by a server are normalized before diagnostics are cached.

File diagnostics use pull diagnostics when advertised, otherwise they wait for
the server's publication after synchronization. The initial read has a five-second
budget. A missing result is reported as unavailable, without claiming the file
is clean. For the same document version, another wait is suppressed for 30 seconds;
a publication is visible immediately, and an edit, restart or cooldown expiry
allows a new attempt. Quickfix tools wait for current diagnostics before building
their context; if diagnostics remain unavailable, the context is explicitly empty.
Closing a document removes its cached diagnostics and ignores late publications.
Without `filePath`,
`lsp_diagnostics` reads the workspace's cached diagnostics. `lsp_workspace_symbols`
queries servers already started in that workspace, so use a file tool first.
`lsp_restart_server` takes a detected `languageId` such as `typescript`; the next
file call reopens its document in the replacement process.

Individual operations depend on the server's advertised capabilities. An
unsupported operation reports that limitation. Capabilities are negotiated at
initialization; dynamic capability registration is not implemented or advertised.
Rename returns an edit preview;
formatting and execute-code-action tools can write files. Use host logs for
discovery, startup and protocol failures.

DSH graph workers inherit parent-authorized LSP tools, including the file-writing
`lsp_format_document`, `lsp_format_range` and `lsp_execute_code_action` tools.
There is no additional default LSP write gate. To exclude these from the inherited
worker catalog, set `tools` on the acting parent role, for example:

```yaml
tools:
  lsp_format_document: false
  lsp_format_range: false
  lsp_execute_code_action: false
```

These policies also match `rb_` collision aliases by their canonical names.
Node `tools` lists are legacy metadata and cannot grant a denied tool; native,
discovery and code presentation use the same inherited authorization.
