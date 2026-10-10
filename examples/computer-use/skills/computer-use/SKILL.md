---
name: computer-use
description: Observe-act-verify loop for driving the real desktop with the computer_* tools, including dry-run rehearsal and permission troubleshooting
license: MIT
compatibility: opencode pi dsh codex
allowed-tools:
  - computer_screenshot
  - computer_windows
  - computer_click
  - computer_move
  - computer_type
  - computer_key
  - computer_permissions
---

# Computer use

You are driving the user's real desktop. Nothing you deliver can be taken back:
a click, a keystroke or a typed string that reached an application is already
part of the desktop's state. Work slowly, observe before every action, and stop
when you are unsure.

## The loop: observe -> act -> verify

**1. Observe.** Find the target before you touch anything.

- `computer_windows({app?})` lists the visible windows with the id this OS
  uses. Pass `app` to narrow the list.
- `computer_screenshot({window_id?, region?, display?})` captures the screen,
  one window or one rectangle as a PNG. Pass at most one target: `window_id`,
  `region` and `display` are mutually exclusive, and on macOS a `region` cannot
  be combined with `display` (macOS counts displays from 1). The image comes
  back to you on an image-capable route and is also saved under
  `.rolebox/computer/` in the workspace.

The screenshot is in **device pixels**, which are not the coordinates the input
tools take: a 2x retina capture of a 1512x982 screen comes back 3024x1964 px
with `metadata.pixel_scale` 2, and the result's text repeats the scale. **Divide
any x/y you read off the image by `pixel_scale`** before `computer_click` or
`computer_move` — an unconverted pixel coordinate lands at twice the intended
offset. When you need to compute a click position, prefer a full-screen or
`region` capture: a `window_id` capture is a cropped frame with no screen origin.

Read what the screenshot actually shows. Do not plan a click from memory of an
earlier screenshot.

**2. Act.** Use the smallest gesture that moves the task forward.

- `computer_click({x, y, button?, clicks?, window_id?})` — one button at one
  point in screen coordinates, so divide the pixel coordinates you read off a
  screenshot by its `pixel_scale` first. `window_id` targets one X11 window;
  macOS and Windows send input to the focused window instead.
- `computer_move({x, y})` — move the pointer to a screen coordinate without
  clicking.
- `computer_type({text, window_id?})` — type text into the focused window. A
  newline presses Return. The text is never echoed back into the transcript.
- `computer_key({keys, window_id?})` — press one key with optional modifiers,
  modifiers first: `["cmd", "shift", "t"]`, `["ctrl", "c"]`, `["Return"]`.

Type into a window only after you have focused it with a click or a key press.

**3. Verify.** Take a fresh `computer_screenshot` after every meaningful action
and check that the screen changed the way you intended. If it did not, do not
repeat the same gesture blindly — re-observe, work out what the screen is
telling you, and adjust.

## Rehearse with dry_run first

Every tool accepts `dry_run: true`. It returns the exact command the tool would
spawn as JSON (`argv`, `windowsVerbatimArguments`, and `script` for an
interpreter command) and executes nothing.

Rehearse whenever the gesture is risky or the target is uncertain:

- a click that would submit a form, send a message or confirm a dialog
- a `computer_type` containing credentials, a shell command or a URL
- a `computer_key` combination whose effect you cannot predict

`dry_run` shows you the coordinates, the window id, the button and the click
count that would really be used. If the plan does not match what you intended,
fix the arguments and rehearse again — never "try it and see".

## Permissions: check, do not guess

`computer_permissions({dry_run?})` reports whether this system will accept
synthesized input right now and names the grant to fix when it will not.

- On macOS, call it before your first gesture. Input goes through System Events
  and needs **Accessibility** permission for the terminal or agent process that
  launched the host; screenshots need **Screen Recording**. Installing rolebox
  with npm grants neither.
- Follow the remediation text the tool returns verbatim — it names the exact
  System Settings pane and the process that must be granted.
- If a gesture fails with a permission error, call `computer_permissions` and
  report what it says to the user. Do not retry the same gesture in a loop.

## When to stop and ask the user

Stop, report what you observed, and ask before continuing when:

- `computer_permissions` reports that input is not permitted, or the session is
  Wayland (rolebox drives X11 only) or otherwise unsupported;
- the screen does not show what you expected — a different window is focused, a
  dialog you did not anticipate is open, or the desktop changed between calls
  (the desktop is shared; another person or program can move it);
- the next step would destroy data, install or remove software, change system
  settings, send a message, make a payment, or enter credentials;
- you have verified the same action twice and the screen still has not changed.

Prefer one careful verified step over a long unverified sequence.
