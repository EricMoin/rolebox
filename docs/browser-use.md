# Browser use

Rolebox's `browse_*` family provides 23 tools for semantic browser automation:
a local Playwright browser whose pages are read as an ARIA-shaped tree and
operated through element refs instead of screen coordinates. It is the DOM-level
alternative to the coordinate-driven `computer_*` family when the target is a
web page — `browse_*` names elements and returns page text, so a page can be
operated without knowing where anything sits on screen. The native desktop stays
with [computer use](computer-use.md).

The family is optional because it is built on Playwright, an optional peer
dependency rather than an installed dependency. Importing the module starts no
browser and opens no socket: the tool record registers nothing on its own, and
the driver is imported on the first operation that needs it.

## Install

```sh
npm install playwright
npx playwright install chromium
```

`playwright` must resolve from the rolebox install. The gate resolves it from
rolebox's own module URL, which is the same resolution root the driver's dynamic
import uses, so the module the check finds is the module the driver loads. The
peer range is `playwright >=1.40.0`.

The browser binaries are a second install step. Playwright reads them from
`PLAYWRIGHT_BROWSERS_PATH` when it is set, otherwise from its own per-OS cache;
the guidance names the command rather than guessing a path.

Chromium is the default engine. `browse_open` also accepts `firefox` and
`webkit`, and each needs its own Playwright browser build. `browse_status`
reports the module version and, when `PLAYWRIGHT_BROWSERS_PATH` is set, whether a
Chromium build is present under that path; with the variable unset it reports
the binary state as unknown instead of claiming one.

## The `browseUse` gate

One setting decides whether the family exists for the boot. It is read from
three sources:

- the host plugin option `browseUse` (DSH and Codex take it; Pi resolves the
  gate without a host option);
- the global config key `browseUse` in `~/.config/rolebox/config.yaml`;
- the project config key `browseUse` in `.rolebox/config.json` under the
  workspace.

| Setting | Result |
| --- | --- |
| `false` in any source | Off for that boot, even when another source says `true` |
| `true` in any source and no `false` | On, and registered even when Playwright is missing so `browse_status` can name the dependency and its install command |
| Absent from every source | Auto: on exactly when `playwright` resolves from rolebox |
| A non-boolean value, or an existing but unreadable/malformed config | Off (fail closed) |

An absent file or an absent key is not a setting. Reading the gate only reads
config files: it never creates or modifies one. The gate is resolved once when
the host loads, not per call, so changing any source requires a restart, and a
`browse_*` tool that does not exist on the current boot is not a temporary
failure — the gate decided before the tool surface was built.

## Host support

| Host | Behavior |
| --- | --- |
| DSH | Registers the 23 tools when the gate is on and the host exposes its tool-guard seam, the surface that refuses a call for a role that never granted it. Without the seam, registration is refused rather than exposed unprotected. The gate is applied before `enabledNamespaces`, so a namespace list matching `browse_*` cannot turn the family on. One session manager per plugin boot is closed when the plugin disposes, and the browser workflow block is injected as the `rolebox:browse` prompt context for the tools a role or worker actually has. |
| Pi | Adds the family to its extra tools only when the gate is on, and a browse interceptor seam refuses a per-role call and returns the correction, so a role's `tools:` map is enforced per call. The workflow block is appended to the system transform and to a worker's prompt. |
| Codex | Takes the `browseUse` host option, resolves the same gate, builds the same family, and appends the workflow block to the MCP initialization instructions. |
| OpenCode (v1 and v2) | Registers neither family. With the gate on, role configuration materializes an explicit `false` for every `browse_*` tool the role's `tools:` map does not grant, so the policy is recorded even though no tool is added. |

The injected block is titled **Browser use workflow**. It teaches the
snapshot-then-act loop, points at `browse_read` and `browse_screenshot` for
content, at `browse_console` and `browse_network` for diagnosis, at
`browse_dialog` for a blocking dialog and at `browse_close` for cleanup, and it
states that the local browser can reach a development server on `localhost`.
A host that registered no `browse_*` tool injects nothing.

## Roles and graph nodes

A role's `role.yaml` `tools:` map is the only per-role source. An absent map
allows the family; an exact entry takes precedence over the longest matching
trailing-star prefix; with no matching entry the default is allow. An unresolved
named role is denied until its configuration can be read.

```yaml
tools:
  browse_*: false
  browse_snapshot: true
```

That role may snapshot a page and nothing else: the exact `browse_snapshot`
entry wins over the `browse_*` prefix, and every other browse tool is denied.
Prefix matching also covers future members of the family.

Graph nodes still declare the tools they need in their node `tools` array. For a
web step, include observation and the actions the step needs, plus `browse_close`
so the worker releases the browser:

```json
{
  "tools": ["browse_status", "browse_open", "browse_snapshot",
    "browse_click", "browse_type", "browse_close"]
}
```

Node grants remain subject to host registration and role restrictions. A
declaration cannot enable an unregistered family, override a denied capability
or turn a gate that is off on.

## Workflow

1. Call `browse_status` when the driver itself is in doubt. It reports the
   Playwright module and version, the browser binary state, the session count,
   this session's pages and any pending dialog. It never launches a browser, so
   it is safe before the first action and after a driver error.
2. Call `browse_open` to create or reuse the named page, optionally navigating
   to a URL. The page defaults to the session's active page, initially `main`;
   a missing page is created and an existing one is reused. `browser`,
   `headless`, `cdp_url` and `viewport` only apply before this session's browser
   has launched — close the session first to change them.
3. Call `browse_snapshot` to read the page and obtain element refs. Refs come
   only from a snapshot.
4. Act on those refs with `browse_click`, `browse_drag`, `browse_type`, `browse_press`,
   `browse_select`, `browse_hover`, `browse_scroll` or `browse_upload`, and use
   `browse_wait` when the next step depends on text, an element or a URL
   appearing.
5. Re-snapshot after any navigation or DOM change. A ref from an older snapshot
   is refused as stale; do not retry it.
6. Use `browse_read` for page content and `browse_screenshot` when layout or an
   image matters. Use `browse_console` and `browse_network` before guessing at a
   broken page: a JavaScript error explains a click that did nothing.
7. Use `browse_tabs` to list, create, select or close pages in the session, and
   `browse_close` when the browsing task is finished.

A successful action proves only that the action was delivered. Verify with a
snapshot, a read, a console check or a screenshot before reporting that the page
changed.

## Tools and arguments

Every result is structured. A failure is a one-sentence
`Error: <cause>; <next step>.` result with `metadata.error = true` and
`metadata.code` from a closed set (`stale_ref`, `ambiguous_target`,
`dialog_open`, `driver_unavailable`, `timeout` and others), so a model can branch
on the code. Every result also carries `driver`, `action`, `session`, `page`,
`url` and `title`, so results from different actions correlate across a turn.

| Tool | Key arguments | Purpose |
| --- | --- | --- |
| `browse_status` | None | Report driver availability and version, browser binary state, the session count, this session's pages and any pending dialog; never launches a browser |
| `browse_open` | `url?`, `page?`, `browser?`, `headless?`, `cdp_url?`, `viewport?`, `wait_until?`, `timeout_ms?` | Launch or attach to a browser and create or reuse a named page, optionally navigating |
| `browse_snapshot` | `page?`, `selector?`, `full?`, `max_chars?` | Walk the page into an ARIA-shaped text tree and assign fresh element refs; the only source of refs |
| `browse_read` | `page?`, `format?`, `selector?`, `max_chars?` | Read the page as markdown, text, HTML, a link list or markdown tables |
| `browse_click` | `target`, `page?`, `button?`, `click_count?`, `modifiers?`, `position?`, `delay_ms?`, `repeat?`, `interval_ms?`, `force?`, `timeout_ms?` | Click one element once or repeatedly; refs are validated and a target matching several elements is refused |
| `browse_drag` | `from`, `to`, `page?`, `from_position?`, `to_position?`, `steps?`, `force?`, `timeout_ms?` | Press on one element, move, and release on another; positions inside either element make canvases and sliders usable |
| `browse_type` | `target`, `text`, `page?`, `clear?`, `submit?`, `timeout_ms?` | Type into an input, textarea or contenteditable element; the text is never echoed in the result |
| `browse_press` | `key`, `target?`, `page?`, `timeout_ms?` | Press one key or chord on the target, or on the focused element when no target is given |
| `browse_select` | `target`, `values`, `page?`, `timeout_ms?` | Select one or more option values (or labels) in a `<select>` element |
| `browse_hover` | `target`, `page?`, `position?`, `modifiers?`, `hold_ms?`, `force?`, `timeout_ms?` | Move the pointer over an element to reveal hover menus and tooltips |
| `browse_scroll` | `target?`, `to?`, `at?`/`at_position?`, `delta_x?`/`delta_y?`, `modifiers?`, `page?`, `timeout_ms?` | Scroll an element into view, jump to an edge, or wheel at a chosen point |
| `browse_wait` | exactly one of `text?`, `selector?`, `url?`, plus `state?`, `page?`, `timeout_ms?` | Wait until text, a visible element or a URL fragment appears |
| `browse_eval` | `expression`, `page?`, `max_chars?`, `timeout_ms?` | Evaluate a JavaScript expression in the page and return its value |
| `browse_screenshot` | `page?`, `selector?`, `full_page?`, `path?`, `format?`, `quality?`, `timeout_ms?` | Capture a PNG or JPEG, save it under `.rolebox/browse` and return it as an image attachment |
| `browse_upload` | `target`, `paths`, `page?` | Attach existing files to an `<input type=file>` element |
| `browse_downloads` | `page?`, `clear?` | List the downloads saved under `.rolebox/browse/downloads` since the last read |
| `browse_dialog` | `action`, `prompt_text?`, `page?` | Accept or dismiss the dialog currently blocking the page |
| `browse_tabs` | `action`, `page?`, `url?` | List, create, select or close the session's named pages |
| `browse_history` | `action`, `page?`, `timeout_ms?` | Go back, forward or reload; every navigation drops the page's refs |
| `browse_console` | `page?`, `level?`, `limit?`, `clear?` | Read console messages, page errors and dialog events since the last read |
| `browse_network` | `page?`, `filter?`, `method?`, `status?`, `failed_only?`, `limit?`, `clear?` | Read request, response and failure records since the last read |
| `browse_cookies` | `action`, `name?`, `value?`, `url?`/`domain?`+`path?`, `secure?`, `http_only?`, `same_site?`, `expires?`, `page?` | Read, write or clear cookies in the session's browser context |
| `browse_close` | `page?`, `all?` | Close one page, or the whole browser session |

Defaults: `browse_open` uses Chromium, headless, `domcontentloaded` and a
1440x900 viewport. `browse_click` clicks the left button once unless `button`,
`click_count` or `repeat` says otherwise. `browse_drag` interpolates ten pointer
moves unless `steps` says otherwise. `browse_hover` targets the element centre
unless `position` says otherwise. `browse_type` replaces the field content unless
`clear: false`; `browse_scroll` wheels 600 CSS pixels vertically unless a delta
is given; `browse_console` and `browse_network` return at most 100 recent entries
each (maximum 1,000). `browse_snapshot` caps its text at 20,000 characters
(maximum 100,000); `browse_read` and `browse_eval` at 20,000 (maximum 200,000).
Where a tool accepts `timeout_ms`, the default is 15,000 ms for an action,
30,000 ms for navigation, history and screenshots and 5,000 ms for
`browse_wait`, and it is never allowed above 120,000 ms.

`browse_eval` defaults to 15,000 ms. A timeout or cancellation closes its page
to stop unfinished JavaScript and release the session queue; reopen the page
with `browse_open`. Calls cancelled while queued do not run. An action already
delivered to the browser cannot be undone.

### Pages

Every page-bound tool accepts `page`, a name of at most 40 characters; without
it the call uses the session's active page, initially `main`. One session holds
at most eight pages and every operation for a session runs through a single
serialized queue, so two calls cannot interleave on one browser. A session is
closed after ten minutes without activity, releasing its pages and their refs.

## Targets

Every element action takes one `target` string, parsed as exactly one of:

- a ref from the latest `browse_snapshot` — `e12` or `@e12`;
- `css=<selector>`;
- `text=<text>`; a bare string with no known prefix is also text;
- `role=<role>` with an optional `[name="<name>"]`, where escaped quotes are
  allowed and the role is compared case-insensitively;
- `label=`, `placeholder=`, `alt=`, `title=` or `testid=`.

Whitespace around the target and around a prefixed value is ignored. An empty
target, an empty value and an unrecognized prefix are `invalid_target` — a
mistyped `href=` is never treated as text. A target that matches several
elements — a text, role, label or CSS target, for example — is
`ambiguous_target` rather than a silent first match: take a ref from a snapshot
and act on that. A ref is checked against the page's current
snapshot before any driver call, and a ref that is not in it is `stale_ref`.

## Gestures

A click is one pointer gesture: `button` chooses left, right or middle,
`click_count` is 1, 2 or 3, `modifiers` holds Alt/Control/Meta/Shift, and
`position` picks a point inside the element instead of its centre. `delay_ms`
holds the button down before releasing it (long press), while `repeat` performs
separate clicks with `interval_ms` between them. A double-click is therefore
`click_count: 2` in one call, not two calls: two calls deliver two independent
`click` events with `detail: 1`.

`browse_drag` presses on `from`, moves in `steps` interpolated moves and releases
on `to`. `from_position` and `to_position` are points inside each element, so a
canvas can be dragged from one pixel to another and a slider can be moved to a
value. `browse_hover` accepts the same `position` and `modifiers`, plus `hold_ms`
to keep the pointer there for a delayed hover effect. `browse_scroll` can wheel
at `at`/`at_position` instead of wherever the pointer was left, hold `modifiers`
(for example Control to zoom) and jump to `to: "top"` or `to: "bottom"`.

Clicks, hovers, drags and wheels go through the browser's real input pipeline
rather than synthetic DOM events, so pointer capture, CSS `:hover` and native
drag-and-drop work the way they do for a person at the machine. The trade-off is
that a gesture cannot span tool calls: there is no mouse-down in one call and
mouse-up in another, and a drag is always one source and one destination.

## Snapshots and refs

A snapshot walks the page into an ARIA-shaped text tree and prints one line per
element, `- <role> "<name>" [ref=eN] [attr...]`, indented two spaces per printed
level. `full` also prints text leaves, `selector` restricts the walk to one CSS
subtree, and `max_chars` stops the walk with a `[... truncated: N more nodes]`
marker without cutting a printed line in half.

Refs are assigned in DOM order to actionable elements only, using disjoint
numeric ranges so another snapshot or page cannot reuse an earlier ref. The walker stamps
`data-rolebox-ref="eN"` onto each element it gives a ref, and clears the markers
a previous snapshot left before assigning new ones, so a snapshot owns the ref
namespace it replaces. The consequences are worth stating plainly:

- a snapshot replaces the page's previous refs; older refs are not reused;
- any navigation (`browse_open` with a URL, `browse_tabs` with a URL,
  `browse_history`) drops the page's refs, because the DOM they named is gone;
- a ref that is not in the current snapshot is refused as `stale_ref` before a
  Playwright call, and an element that disappeared after the snapshot is
  translated from `element_not_found` into `stale_ref`;
- an iframe is reported as a line and is not entered, so content inside it has
  no ref; the walker reads the light DOM, so content inside a shadow root or a
  canvas has no ref either;
- refs are per page: two pages of one session each have their own.

The snapshot skips `script`, `style`, `template`, `noscript`, `aria-hidden`
subtrees, hidden elements and `input[type=hidden]`, and derives the accessible
name from `aria-labelledby`, `aria-label`, `<label>`, `alt`, `placeholder`,
`title` and then text content.

## Files and artifacts

- **Screenshots** are written to `<worktree>/.rolebox/browse/` as UTC-stamped
  `<timestamp>-<seq>.png` (or `.jpg`) files. The directory is owner-only and the
  files are owner-only on POSIX systems. A custom `path` must stay inside the
  worktree and must end in an extension that matches the format (`.png` for
  `png`, `.jpg`/`.jpeg` for `jpeg`). Symbolic links below the worktree root are
  refused, including in the default capture directory. A capture over 32 MiB is refused as
  `too_large` instead of producing an unusable base64 payload.
- **Downloads** are saved automatically under
  `<worktree>/.rolebox/browse/downloads`, and `browse_downloads` reports each
  file's name, status, byte count and saved path. The per-page buffer keeps the
  last 100 entries, and `clear` defaults to `false` so a finished download stays
  visible until the page is closed.
- **Uploads** read existing files: relative paths resolve against the worktree,
  absolute paths are used as given, and a path that is not an existing regular
  file fails with `file_not_found` before the browser is touched.

A screenshot result carries the saved path, the byte count, the PNG dimensions
and an image attachment. On DSH the attachment is committed through the host
attachment service; with no service wired the model receives the text line and
the saved path instead of pixels.

## Security and limits

- **The browser runs on this machine with this machine's network reach.** A
  `browse_open` URL is validated only as an absolute URL with a scheme a browser
  can load (`http`, `https`, `file`, `about`, `data`); there is no SSRF filter
  and no block list for loopback, private or link-local addresses. That is
  deliberate — a development server on `127.0.0.1` or `localhost` is a normal
  target — and it means a page can reach whatever the host can reach.
- **Cookies and logins live for the session's browser context.** A launched
  browser gets a fresh in-memory context; nothing is written to a profile
  directory, and the cookies disappear when the session closes. Cookies are
  shared by every page of that context, which is what makes `browse_cookies`
  useful for restoring a login.
- **An attached browser is shared and left running.** `cdp_url` attaches to a
  Chromium that is already listening (Chromium only, and only before this
  session's browser has launched). The driver reuses the existing context so
  cookies and logins survive, closes only the pages it created, and never sends
  `Browser.close` to a browser it did not launch. A launched Chromium keeps
  Playwright's Chromium sandbox enabled and the automation-controlled feature
  flag disabled.
- **A new window a page opens is not adopted.** A `target="_blank"` link or
  `window.open` creates a page in the same browser context, but the session
  tracks only the named pages it created itself: the new page is absent from
  `browse_tabs` and `browse_status`, has no refs or buffers, and no `page`
  argument addresses it. Open the destination itself with `browse_open` or
  `browse_tabs action=new` instead of following a popup.
- **A pending dialog blocks the page.** At most one dialog is pending per page;
  every other action on that page refuses with `dialog_open` until
  `browse_dialog` accepts or dismisses it. `browse_status` reports the dialog
  without blocking.
- **Actions have no rollback.** A click, a keystroke or a submitted form has
  already changed the page. `browse_eval` runs arbitrary JavaScript in the page
  context, and a page can do anything its own origin allows.
- **Browser builds are per engine.** `firefox` and `webkit` fail at launch until
  their build is installed, and `browse_status` can only verify Chromium's
  presence, and only when `PLAYWRIGHT_BROWSERS_PATH` names the cache.
- **The family is a local tool surface with no per-call approval.** Codex MCP
  has no permission callback and no active rolebox role, so the global gate is
  the whole policy there; DSH, Pi and OpenCode additionally apply role
  restrictions.

## Tests

The browser-family tests run without a browser:

```sh
npm test -- tests/browse/
```

That slice drives the tools, the session manager and the result layer against an
in-memory driver from `tests/browse/fixtures/`, so the default suite never
launches Playwright, opens a socket or touches a real page.

The live smoke test is skipped unless explicitly enabled:

```sh
ROLEBOX_BROWSE_LIVE=1 npm test -- tests/browse/playwright-live.test.ts
```

It drives the production launch path with headless Chromium — a `data:` page,
snapshot refs, a click by ref, a fill by ref and a PNG screenshot — and closes
the browser in a `finally` path. Unit tests establish the tool, session and
result contracts; they do not establish how a particular site behaves.

The full-surface live suite is gated the same way:

```sh
ROLEBOX_BROWSE_LIVE=1 npm test -- tests/browse/live-e2e.test.ts
```

It starts a fixture site on an ephemeral loopback port and drives all 23 tools
through the real Playwright driver and a headless browser — snapshot refs, click,
drag, type, press, select, hover, scroll, read, screenshot, console, network, tabs,
history, cookies, a dialog, a download and an upload — and disposes each session
in a `finally` path. It is opt-in for the same reason as the smoke test, and it
states its gaps rather than asserting them: the fixture's `target="_blank"` link
is never clicked, and no test enters an iframe.

Select another installed engine with `ROLEBOX_BROWSE_ENGINE=firefox` or
`ROLEBOX_BROWSE_ENGINE=webkit` when running `live-e2e.test.ts`. The fixture checks
both HTTP failures and transport failures through the normalized network log;
engines can report the same refused connection differently.

Build before running the complete live slice, which also exercises the actual
Node MCP subprocess, Pi and dsh tool adapters, session isolation, cancellation,
idle cleanup and CDP attachment ownership:

```sh
npm run test:browse:e2e
```

The runner builds once, runs module and host regression checks, then executes
each live suite in its own process, including the 23-tool acceptance suite on
all three engines. It also checks production and test types. Keeping native
browser transports separate from module mocks avoids interference between
these suites; a failed suite remains a nonzero result and does not stop the
remaining checks from running.

The acceptance runner uses Node.js for the MCP process and the external CDP browser owner. It checks that closing rolebox's connection preserves external pages and cookies and lets the MCP process exit cleanly.

The implementation lives in [src/browse](../src/browse/); the gate and the role
decision are in [browse-use-gate.ts](../src/loader/browse-use-gate.ts) and
[browse-grants.ts](../src/loader/browse-grants.ts).
