# Computer use

Rolebox's `computer_*` family provides 12 tools for observing and operating a
native desktop: screenshots, windows, displays, focus, mouse input, text, keys
and diagnostics. Drivers cover macOS, Windows and Linux X11. Wayland is
explicitly unsupported.

A web page is better served by the [browse_* family](browser-use.md): it acts on
the page's DOM through element refs and returns page text, while a coordinate
click depends on the desktop state and the visible window. `computer_*` remains
the tool for the native desktop — application windows, the menu bar, dialogs and
anything with no DOM.

DSH, Pi and Codex expose the family by default. No global configuration or
role YAML opt-in is required. Neither OpenCode entry registers the family. See
[compatibility](compatibility.md#computer-use) for host support.

## Availability and permissions

Tool availability and operating-system permission are separate. The agent can
discover the tools immediately; a permission denial explains the next step,
including `computer_permissions({"request": true})` when the OS supports a
request. The user approves the OS dialog. A request is not proof of approval;
check the resulting input and screen-capture statuses before retrying.

DSH and Pi inject a **Computer use workflow** for the tools actually available
to the current role or worker. Codex supplies the same guidance through MCP
initialization instructions. It covers when desktop interaction is useful,
how to request permission, and how to verify an action against a fresh image.

To disable the family, explicitly set `computerUse: false` in the host option,
the global rolebox config (`~/.config/rolebox/config.yaml`), or the project's
`.rolebox/config.json`. Any explicit false wins over true in another source.
An invalid configured value or unreadable existing config also disables it;
an absent file or absent key leaves the tools enabled. Restart the host after
changing this boot-time setting. DSH's `enabledNamespaces` can further filter
which tools are registered.

Roles may optionally restrict tools:

```yaml
tools:
  computer_drag: false
```

Exact entries take precedence over the longest matching wildcard prefix, then
the default is allow. For example, `computer_*: false` with
`computer_screenshot: true` exposes screenshots for that role while denying
other computer tools. The base agent needs no role selection; an unresolved
named role is refused until its configuration can be resolved. DSH requires
its `ctx.tools.guard` seam to enforce explicit role restrictions.

Graph workers inherit the parent's authorized computer tools with native schemas
shown by default. Node `tools` lists do not restrict access. Use diagnostic and
permission tools alongside observation and the actions the task requires.

Inherited tools remain subject to host registration, role restrictions and OS
permissions. Discovery and code presentation are optional. Explicit policy
restrictions are not OS permission failures: `computer_permissions` does not
change configuration or grant additional capabilities.

Codex MCP has no rolebox per-call approval callback. Its client permissions
and the operating system's own permission checks still apply.

## Workflow

1. Call `computer_status` to inspect planned operations, helper availability and
   the input and screen-capture permission probes. It performs no screenshot, input or permission
   prompt. A planned operation is not proof that the OS will let it run.
2. Check `computer_permissions`. On macOS, `request: true` asks for the OS
   missing Accessibility and Screen Recording permissions. Grant the host application the requested permission,
   restart it when required, and probe again. Screen Recording is separate;
   inspect the separate screen-capture verdict, then inspect the image from `computer_screenshot`.
3. Discover the target with `computer_windows` and `computer_displays`. Focus a
   selected window with `computer_focus`, then take a fresh screenshot. Pass
   its `window_id` on each input call when working with multiple windows.
4. Pass its `screenshot_id` to a pointer tool and choose coordinates in image
   pixels. The tool maps them to the desktop and verifies the captured geometry.
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
| `computer_permissions` | `request?` | Probe input and capture permissions; optionally request missing OS grants |
| `computer_windows` | `app?` | List visible windows and the IDs used by capture/focus |
| `computer_displays` | None | Return JSON display IDs, bounds, scale and primary flag |
| `computer_screenshot` | `window_id?`, `region?`, `display?`, `path?` | Capture a PNG and return an image attachment |
| `computer_focus` | `window_id` | Bring the selected window forward and verify focus, or report refusal |
| `computer_click` | `x`, `y`, `button?`, `clicks?`, `window_id?`, `screenshot_id?` | Click at screen coordinates, or image pixels with `screenshot_id`; button defaults to left, clicks to 1 |
| `computer_move` | `x`, `y`, `window_id?`, `screenshot_id?` | Move the pointer without clicking |
| `computer_type` | `text`, `window_id?` | Type into the focused window, optionally selecting it first |
| `computer_key` | `keys`, `window_id?` | Press modifiers followed by one final key |
| `computer_scroll` | `direction`, `amount?`, `x?`, `y?`, `window_id?`, `screenshot_id?` | Scroll up/down/left/right by 1–100 wheel ticks, default 3; position requires both coordinates and is required with `screenshot_id` |
| `computer_drag` | `from_x`, `from_y`, `to_x`, `to_y`, `duration_ms?`, `window_id?`, `screenshot_id?` | Left-button drag between screen coordinates, or image pixels with `screenshot_id`, over 100–5000 ms, default 500 ms |

`computer_click.button` is `left`, `right` or `middle`; `clicks` is 1 or 2.
`computer_key.keys` is an array such as `["cmd", "shift", "t"]` or
`["Return"]`. Exactly one non-modifier key comes last.
The receiving application decides how far one scroll tick moves content.

### Multiple windows

All six input tools accept `window_id` on macOS, Windows and Linux X11. Use
an ID returned by `computer_windows`; each call brings that window forward and
verifies focus before sending input. Focus and input share one helper command
and one desktop queue slot. A missing, ambiguous or refused target stops the
operation. No window selection is remembered: omitting `window_id` preserves
the current-focus behavior, so repeat the ID on each targeted call.

```json
{"window_id": 42, "text": "First window"}
```

Pass this object to `computer_type`, then use another observed window ID to
type into a second window. Windows discovery includes multiple visible
top-level windows belonging to the same process.

Targeting changes foreground focus; it does not provide background input.
Without `screenshot_id`, pointer coordinates remain absolute screen coordinates
on every platform, including X11, and are not constrained to the window. Use fresh
screen coordinates inside that window for pointer actions. Scrolling without
`x` and `y` uses the current pointer position, which may be outside the target;
supply both coordinates to select where to scroll. Other applications, people
or host processes can still change focus during an operation. Inspect the
resulting UI before continuing.

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
the primary display (X11 falls back to the first monitor if none is marked
primary). X11 enumerates RandR monitors on the current `DISPLAY` screen; it
does not switch to another X screen. Refresh display IDs after reconnecting or
rearranging monitors. macOS capture uses the selected display's actual bounds,
so its selection does not depend on an unrelated screenshot command's numbering.

Every successful tool capture returns `screen_bounds: {x, y, w, h}`, `origin`,
`pixel_scale_x`, `pixel_scale_y`, `displays` and `screenshot_id`. The per-axis
scales are the actual PNG dimensions divided by the captured screen extent.
`pixel_scale` is also present when both axes have the same ratio. PNG density
is not used to guess this mapping. Negative screen origins and fractional
ratios are supported. To convert manually:

```text
screen_x = origin.x + image_x / pixel_scale_x
screen_y = origin.y + image_y / pixel_scale_y
```

For example, pixel `(100, 60)` in a 2× capture of a region beginning at
`(300, 200)` corresponds to screen point `(350, 230)`.

Prefer passing `screenshot_id` and the image pixel coordinates directly:

```json
{"screenshot_id":"<id returned by computer_screenshot>","x":100,"y":60}
```

Use this object with `computer_click` or `computer_move`. `computer_drag` maps
both endpoints from the same image. `computer_scroll` requires `x` and `y`
when using a screenshot. A window screenshot automatically selects its captured
window; an explicit `window_id` must match it. A display or region screenshot
cannot be combined with `window_id`; capture the window first for that workflow.
Points outside the image or in gaps between monitors are refused. Converted
positions are rounded to screen units within the capture's bounds.

Screenshot IDs belong to the current session, workspace and host platform.
They expire after ten minutes; the host retains at most 64 snapshots, and a
host restart clears them. They hold geometry, not permission grants.

### Mixed scaling and moving windows

macOS input uses global screen points. Region/display captures take each
monitor's intersecting rectangle separately and composite those images onto a
uniform canvas, including regions spanning 1× and 2× displays. Window captures
preserve their native raster without shadow padding; the returned per-axis
ratios map that raster to the captured window bounds. Windows uses DPI-aware desktop
pixels for capture and input, so a monitor's 150% UI scale must not be applied
again to screenshot coordinates. X11 uses root-screen pixels; its reported
scale is 1, independently of application toolkit scaling.

Capture samples window bounds and display identities, positions, sizes and
scales before and after taking the image. A detected change fails the capture.
With `screenshot_id`, pointer input checks those facts again after focusing and
before sending input. Moving/resizing a captured window, moving it to another
monitor, changing monitor scaling, reconnecting a display or changing display
order rejects the old screenshot and requires a new one. After recapturing,
the new origin and raster scale are used automatically. Old UI coordinates are
never silently rebased after a layout change.

This check does not lock the desktop or detect every content change, such as a
scroll within an unchanged window. Another process can still intervene after
the check or during a drag; observe the result and use a fresh image.

macOS window capture omits its shadow. Windows window capture copies the visible
window rectangle; X11 captures the visible client area, excluding decorations.
Both include covering windows, so focus first and inspect the image. X11
refuses targets extending outside the current root screen; a region may span
multiple monitors and the gaps between them.

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
| macOS | Built-in `screencapture` via JXA with ImageIO validation and geometry checks. Window captures omit shadows; display/region captures composite monitor tiles at a uniform scale. Quartz sends mouse gestures and Unicode text; System Events handles focus and keyboard shortcuts. Screen Recording, Accessibility and System Events Automation grants belong to the application launching the host. Focus refuses ambiguous window matches. |
| Linux X11 | `xdotool` for input/focus, ImageMagick `import` or `scrot` for capture, and `xrandr` with RandR 1.5 monitor support plus `awk` for geometry. Window-manager support affects focus. |
| Windows | PowerShell with desktop .NET APIs and an interactive desktop session. The OS may refuse foreground activation or input into higher-privilege applications. |
| Wayland / other systems | Explicit refusal; no fallback pretending to provide desktop control. |

`computer_windows` returns tab-separated window IDs and labels, with one entry
per visible window rather than one per application. Its `app` filter
matches owner names on macOS, window titles on X11, and process names or titles
on Windows. Missing OS permission can withhold macOS window titles even though
IDs remain available. Input-permission success does not imply Screen Recording
permission or guarantee every individual input operation. On macOS, a separate
`CGPreflightScreenCaptureAccess` probe reports Screen Recording permission; a
capture is refused if that grant cannot be verified. Other platforms report
that separate permission as unverified when they expose no probe. A PNG file
alone is not proof that protected window contents were captured.

The family controls the native desktop; it does not supply browser DOM
selectors — those belong to the [browse_* family](browser-use.md) — a general
accessibility-tree API, or a transaction spanning multiple calls. Unit tests
cover driver plans, argument validation, queue behavior, authorization and host
image transport. They do not establish live desktop behavior on every operating
system, and tests must not send real mouse or keyboard input to the developer's
desktop.

## Optional macOS desktop smoke test

The normal module test command does not operate the desktop or capture its
contents. Native OS tests are skipped unless explicitly enabled:

```sh
npm test -- tests/computer/
```

For real permission and screenshot checks on an already authorized macOS host,
opt in with `ROLEBOX_CUA_NATIVE_TESTS=1`. The capture tests include the primary
display, a secondary display when connected, and a small spanning region when
adjacent monitors have different scales. These checks do not request permissions
or send desktop input:

```sh
ROLEBOX_CUA_NATIVE_TESTS=1 npm test -- tests/computer/tools.test.ts tests/computer/capture-darwin.test.ts
```

Use the smoke runner below for the complete temporary-window verification.
This opt-in test uses a temporary native application with two windows and records
button, text, scroll and drag events. It exercises the real `computer_*` tools,
including window screenshots, a click mapped through `screenshot_id`, and focus,
and stops at the first failed assertion. With `--commands`, it also verifies
secondary-window clicks, scrolling at the current pointer position, moving the
fixture across displays, stale screenshot rejection, fresh region mapping and
display-gap rejection. It restores the fixture position afterward. Physical
mixed-scale capture is explicitly skipped unless connected displays have
different backing scales; the normal tests cover synthetic 1×/2× composition.
Run both terminals from the repository root. In the first terminal, compile and
start a fresh fixture:

```sh
cua_tmp="$(mktemp -d /tmp/rolebox-cua.XXXXXX)"
swiftc tests/computer/fixtures/macos-cua-app.swift -o "$cua_tmp/macos-cua-app"
printf 'Fixture directory: %s\n' "$cua_tmp"
"$cua_tmp/macos-cua-app" "Rolebox CUA smoke test" "$cua_tmp/state.json" "$cua_tmp/command.json"
```

Keep that process running. In a second terminal, replace the placeholder with
the absolute directory printed above, then explicitly opt in to desktop input:

```sh
cua_tmp=/absolute/path/printed/by/the/first/terminal
node --import tsx scripts/computer-macos-smoke.ts --run --state "$cua_tmp/state.json" --output "$cua_tmp/results" --commands "$cua_tmp/command.json"
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
