# Computer use

Rolebox's `computer_*` family provides 12 tools for observing and operating a
native desktop: screenshots, windows, displays, focus, mouse input, text, keys
and diagnostics. Drivers cover macOS, Windows and Linux X11. Wayland is
explicitly unsupported.

The family is off by default. dsh, Pi and Codex register it after the global gate
is enabled; dsh and Pi additionally require an active role with an explicit tool
grant. Neither OpenCode entry registers the family. See
[compatibility](compatibility.md#computer-use) for host support.

## Enable the tools

Set the boolean `computerUse: true` in the global rolebox config
(`~/.config/rolebox/config.yaml`), or add it to the project's
`.rolebox/config.json`:

```json
{ "computerUse": true }
```

The dsh plugin option and Codex MCP entry option also accept `computerUse: true`.
Any one of these sources enables the family. An absent value, a non-boolean
value, or a host option set to `false` does not enable it; a host option set to
`false` does not override an enabled config file. Restart the host after changing
the boot-time gate.

On dsh and Pi, grant the required tools in the active role's `role.yaml`:

```yaml
tools:
  computer_status: true
  computer_permissions: true
  computer_windows: true
  computer_displays: true
  computer_screenshot: true
  computer_focus: true
  computer_click: true
```

The family wildcard is available when a role needs the full surface. An exact
`false` overrides it:

```yaml
tools:
  computer_*: true
  computer_drag: false
```

An absent map, an inactive or unknown role, and the generic `"*": true` wildcard
do not grant computer use. An exact `true` can grant a tool even when the family
wildcard is `false`. dsh requires its monotonic `ctx.tools.guard` seam; when the
host lacks that seam, rolebox refuses to register the family.

### Codex has no permission prompt

The Codex MCP transport has no active rolebox role and no per-call permission
callback. Its global gate is the complete rolebox policy: enabling it makes all
12 tools available. OS permissions still apply.

## Workflow

1. Call `computer_status` to inspect planned operations, helper availability and
   the input and screen-capture permission probes. It performs no screenshot, input or permission
   prompt. A planned operation is not proof that the OS will let it run.
2. Check `computer_permissions`. On macOS, `request: true` asks for the OS
   Accessibility prompt. Grant the host application the requested permission,
   restart it when required, and probe again. Screen Recording is separate;
   inspect the separate screen-capture verdict, then inspect the image from `computer_screenshot`.
3. Discover the target with `computer_windows` and `computer_displays`. Focus a
   selected window with `computer_focus`, then take a fresh screenshot.
4. Choose coordinates from the screenshot using its scale and screen origin.
   Use `dry_run: true` to inspect a command without executing it when useful.
5. Perform one action and inspect a fresh screenshot to verify the result.
   Scrolling, focus changes and dragging can invalidate earlier coordinates.

All real operations are serialized within one host process. This prevents
rolebox calls in that process from interleaving, but does not lock out a person,
another application or another host process. Delivered input has no rollback.

## Tools and arguments

Every tool accepts optional `dry_run` and `timeout_ms`. The timeout is an integer
from **1 to 120000 ms**, defaults to **15000 ms**, and includes time spent waiting
in the desktop queue. Cancellation removes queued work before execution and
stops an active helper. A failed or interrupted drag attempts to release the
mouse button before the queue continues. Cleanup is best effort; forcibly
terminating the host cannot guarantee release.

| Tool | Additional arguments | Behavior |
| --- | --- | --- |
| `computer_status` | None | Diagnose operations, helpers and input permission without capturing or sending input |
| `computer_permissions` | `request?` | Probe input permission; optionally request the OS grant |
| `computer_windows` | `app?` | List visible windows and the IDs used by capture/focus |
| `computer_displays` | None | Return JSON display IDs, bounds, scale and primary flag |
| `computer_screenshot` | `window_id?`, `region?`, `display?`, `path?` | Capture a PNG and return an image attachment |
| `computer_focus` | `window_id` | Bring the selected window forward and verify focus, or report refusal |
| `computer_click` | `x`, `y`, `button?`, `clicks?`, `window_id?` | Click at absolute screen coordinates; button defaults to left, clicks to 1 |
| `computer_move` | `x`, `y` | Move the pointer without clicking |
| `computer_type` | `text`, `window_id?` | Type into the focused or supported target window |
| `computer_key` | `keys`, `window_id?` | Press modifiers followed by one final key |
| `computer_scroll` | `direction`, `amount?`, `x?`, `y?` | Scroll up/down/left/right by 1–100 wheel ticks, default 3; optional pointer position requires both coordinates |
| `computer_drag` | `from_x`, `from_y`, `to_x`, `to_y`, `duration_ms?` | Left-button drag between absolute coordinates over 100–5000 ms, default 500 ms |

`computer_click.button` is `left`, `right` or `middle`; `clicks` is 1 or 2.
`computer_key.keys` is an array such as `["cmd", "shift", "t"]` or
`["Return"]`. Exactly one non-modifier key comes last. `window_id` on click,
type and key is X11-only; macOS and Windows reject it, so focus first there.
The receiving application decides how far one scroll tick moves content.

### Dry runs

For operation tools, `dry_run: true` returns the exact spawn plan as JSON
(`argv`, `windowsVerbatimArguments`, and an optional `script`) without running
it. When applicable, the report also includes a separate capture-permission
probe and a drag-release cleanup plan. `computer_status` instead returns its diagnostic plan without checking the
filesystem or executing the permission probe. Dry runs do not verify helpers,
OS grants or the current target.

Normal `computer_type` results report the character count without repeating the
text. Its **dry-run command contains the text in plaintext**, so do not dry-run
secrets.

## Screenshots and coordinates

By default captures are saved under the session workspace's
`.rolebox/computer/` as timestamped PNGs. The dedicated directory and capture files are owner-only
on POSIX systems. A custom `path` may be absolute or workspace-relative; rolebox
does not change the permissions of an existing custom parent directory. The
result includes the path, PNG dimensions, byte count, an image attachment and
coordinate metadata. Images above 32 MiB are refused; capture a smaller region.

A screenshot accepts one target: a window, a region (`{x, y, w, h}` in screen
coordinates), or a display. Consult `computer_displays` for valid display IDs:
macOS IDs start at 1; Windows and X11 IDs start at 0. An untargeted capture covers
one display. X11 display entries describe X screens, which have separate
coordinate spaces; they are not a list of RandR monitors. Capturing another X
screen does not switch input to it: input uses the host's `DISPLAY` screen. To
control another X screen, start the host with `DISPLAY` pointing to that screen.

Image pixels and input coordinates can differ. When both `pixel_scale` and the
screen `origin` are known, convert a pixel position with:

```text
screen_x = origin.x + image_x / pixel_scale
screen_y = origin.y + image_y / pixel_scale
```

For example, pixel `(100, 60)` in a 2× capture of a region beginning at
`(300, 200)` corresponds to screen point `(350, 230)`.

Region captures report their origin. Window and explicitly selected display
captures currently report `origin: null`: establish their screen bounds before
clicking; dividing by scale alone is insufficient. A macOS PNG with no reliable
density has no known `pixel_scale`, so establish the scale before conversion.
A macOS window capture omits its shadow to keep the image aligned with its frame.

### Image transport per host

| Host | Model-visible screenshot |
| --- | --- |
| Codex MCP | Text followed by an inline MCP image block |
| Pi | Text followed by a Pi image content block; metadata stays in details |
| dsh | Image bytes saved through the mounted attachment service, then rendered as durable image refs |
| OpenCode v1/v2 | This family is not registered |

On dsh without an attachment service, the result remains text plus the saved
path. The model route must support images; a successful file capture alone does
not establish that the model received pixels.

## Platform behavior and limits

| Platform | Driver requirements and limits |
| --- | --- |
| macOS | Built-in `screencapture` and JXA/AppleScript. Quartz sends mouse gestures and Unicode text; System Events handles focus and keyboard shortcuts. Screen Recording, Accessibility and System Events Automation grants belong to the application launching the host. Focus refuses ambiguous window matches. |
| Linux X11 | `xdotool` for input/focus, ImageMagick `import` or `scrot` for capture, and `xdpyinfo`/`awk` for display discovery. Window-manager support affects focus. |
| Windows | PowerShell with desktop .NET APIs and an interactive desktop session. The OS may refuse foreground activation or input into higher-privilege applications. |
| Wayland / other systems | Explicit refusal; no fallback pretending to provide desktop control. |

`computer_windows` returns tab-separated window IDs and labels. Its `app` filter
matches owner names on macOS, window titles on X11, and process names or titles
on Windows. Missing OS permission can withhold macOS window titles even though
IDs remain available. Input-permission success does not imply Screen Recording
permission or guarantee every individual input operation. On macOS, a separate
`CGPreflightScreenCaptureAccess` probe reports Screen Recording permission; a
capture is refused if that grant cannot be verified. Other platforms report
that separate permission as unverified when they expose no probe. A PNG file
alone is not proof that protected window contents were captured.

The family controls the native desktop; it does not supply browser DOM
selectors, a general accessibility-tree API or a transaction spanning multiple
calls. Unit tests cover driver plans, argument validation, queue behavior,
authorization and host image transport. They do not establish live desktop
behavior on every operating system, and tests must not send real mouse or
keyboard input to the developer's desktop.

## Optional macOS desktop smoke test

The normal module test command does not operate the desktop or capture its
contents. Native OS tests are skipped unless explicitly enabled:

```sh
bun test --isolate tests/computer/
```

For the additional real permission and main-display screenshot checks on an
already authorized macOS host, opt in with `ROLEBOX_CUA_NATIVE_TESTS=1`.
These checks do not request permissions:

```sh
ROLEBOX_CUA_NATIVE_TESTS=1 bun test --isolate tests/computer/tools.test.ts tests/computer/capture-darwin.test.ts
```

Use the smoke runner below for the complete temporary-window verification.
This opt-in test uses a temporary native application with two windows and records
button, text, scroll and drag events. It exercises the real `computer_*` tools,
including window screenshots and focus, and stops at the first failed assertion.
Run both terminals from the repository root. In the first terminal, compile and
start a fresh fixture:

```sh
cua_tmp="$(mktemp -d /tmp/rolebox-cua.XXXXXX)"
swiftc tests/computer/fixtures/macos-cua-app.swift -o "$cua_tmp/macos-cua-app"
printf 'Fixture directory: %s\n' "$cua_tmp"
"$cua_tmp/macos-cua-app" "Rolebox CUA smoke test" "$cua_tmp/state.json"
```

Keep that process running. In a second terminal, replace the placeholder with
the absolute directory printed above, then explicitly opt in to desktop input:

```sh
cua_tmp=/absolute/path/printed/by/the/first/terminal
bun scripts/computer-macos-smoke.ts --run --state "$cua_tmp/state.json" --output "$cua_tmp/results"
```

The runner requires granted Accessibility and Screen Recording permissions;
it does not request them. macOS grants belong to the application launching the
runner, such as the terminal or agent host, so granting a different application
does not authorize this run. Restart that host when macOS requires it. Keep the
fixture visible and avoid interacting with the desktop during the test; the
runner checks its foreground window before sending input.

Inspect `results/report.json`, `results/before.png` and `results/after.png`.
The report records tool results without image base64 and the fixture's observed
events. Use a new fixture for each run. Close its primary window, or press
Ctrl-C in the first terminal, to quit; the runner does not close it. After
inspecting the results, remove the generated temporary directory:

```sh
rm -rf -- "${cua_tmp:?}"
```

## Two layers: the host's own computer use, and rolebox's family

A dsh profile may also mount a host-owned CUA provider. That provider has its own
tools and lifecycle, separate from rolebox's family. Enable one control surface
at a time to avoid competing input paths. Rolebox's process-local queue cannot
serialize another provider's actions.

The implementation lives in [src/computer](../src/computer/); the shared gate
and role decision are in [computer-use-gate.ts](../src/loader/computer-use-gate.ts)
and [computer-grants.ts](../src/loader/computer-grants.ts). Host registration and
image transport are implemented by the platform entries and adapters.
