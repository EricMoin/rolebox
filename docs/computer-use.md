# Computer use

> Part of the rolebox documentation. See [README](../README.md) for overview.

Rolebox can drive the real desktop: take screenshots, list windows, move the
pointer, click, type text and press keys. It ships that as its own
**computer-use family** — seven tools plus a per-OS driver — and registers it on
dsh, Pi and Codex (on dsh only when the host exposes the guard seam that enforces
the per-role grant). Neither opencode entry registers the family, so on opencode
a role's `computer_*` grant changes nothing: the tools never appear (see
[Policy: off by default](#policy-off-by-default)). The family is **off by
default**: no tool registers until the global gate is on, and even then, on the
hosts that carry a role (dsh and Pi), a role must opt in for itself. Codex is the
exception — its MCP transport carries no role, so the gate alone decides, and
with it on all seven tools are registered and callable with no role opt-in (see
[Codex has no permission prompt](#codex-has-no-permission-prompt)).

Two different things can supply desktop control on dsh, and only one of them
should be enabled at a time — see [Two layers](#two-layers-the-hosts-own-computer-use-and-roleboxs-family).

## Two layers: the host's own computer use, and rolebox's family

### The host's computer use (dsh)

On dsh the harness can supply computer use itself. Its shared service owns a
**single exclusive provider slot**: `ctx.computerUse.register(name)` reserves the
sole registration and rejects any second provider, including another instance of
the same name (`deepseek-harness/docs/subsystems/computer-use.md`). Two **Cua
Driver** providers fill that slot — Cua Driver MCP (an already installed
`cua-driver` connected over MCP) and Cua Driver native (the platform-native
runtime installed with the npm dependency). Both are experimental packages that
require explicit activation, and each supplies its own upstream tool catalog; the
shared service has no common desktop-operation methods and no model-controlled
selector.

On that path a screenshot is a **durable attachment**: an image-capable model
route with an attachment store receives the stored image, and an unsupported
image route receives the MCP image diagnostic
(`deepseek-harness/docs/subsystems/computer-use.md`).

### Rolebox's family (wherever it is registered)

Rolebox ships its **own** tool family instead — `src/computer/` — built from the
same canonical tool factory as every other rolebox tool
(`createComputerTools`, `src/computer/tools.ts:455-464`). Its seven tools are
`computer_screenshot`, `computer_windows`, `computer_click`, `computer_move`,
`computer_type`, `computer_key` and `computer_permissions`, and each one resolves
its command through the facts its own OS declares
(`src/platform/system/types.ts:62-68`, `src/computer/drivers/`).

**This family is the uniform surface.** One tool vocabulary and one set of
arguments work the same way wherever it is registered, so a role or a graph
written against it does not change when it moves between harnesses. dsh and
Codex register it through the shared assembly's `computerUse` option
(`src/platform/tool-assembly.ts:146-151`, `src/entries/dsh.ts:2237-2246`,
`src/entries/codex.ts:138`), and Pi appends the same factory's record to its own
tool set when the gate is on (`src/entries/pi.ts:1243-1244`). Both opencode
entries read the same gate and grant, but only to emit per-role agent-config
rules (`src/prompt/agent-config.ts:119-144`) — neither passes `computerUse` to
the assembly, so neither registers the family. Where a host does not register
the family, a role's `computer_*` grant changes nothing: the tools never appear.

**On dsh, enable only one of the two.** The host provider and rolebox's family
are two independent ways to drive the same desktop with different tool names and
different screenshot transports, and both register into the model-visible tool
set. Mount the host provider and leave rolebox's gate off, or turn the host
provider off and use rolebox's family — not both.

## The seven tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `computer_screenshot` | `window_id?`, `region?`, `display?`, `path?`, `dry_run?`, `timeout_ms?` | Capture the screen, one window or one region as a PNG |
| `computer_windows` | `app?`, `dry_run?` | List the visible windows with this OS's own window id |
| `computer_click` | `x`, `y`, `button?`, `clicks?`, `window_id?`, `dry_run?` | Press a mouse button at absolute screen coordinates |
| `computer_move` | `x`, `y`, `dry_run?` | Move the pointer without clicking |
| `computer_type` | `text`, `window_id?`, `dry_run?` | Type text into the focused window |
| `computer_key` | `keys`, `window_id?`, `dry_run?` | Press one key, optionally with modifiers |
| `computer_permissions` | `dry_run?` | Report whether this system will accept input right now |

The argument shapes are the tools' own zod schemas (`src/computer/tools.ts`).

- **`computer_screenshot`** — `window_id`, `region` and `display` are mutually
  exclusive (`src/computer/drivers/darwin.ts:190-192`,
  `src/computer/drivers/linux.ts:48-50`), a single-window capture selects no
  display (`darwin.ts:193-195`), and on macOS a `region` is refused together with
  `display` (`darwin.ts:196-198`): a region is in global screen coordinates and
  therefore already selects its own display, and `screencapture` ignores `-D`
  when `-R` is given. `display` is the OS's own display identifier: macOS `-D`,
  which counts **from 1** — 1 is the main display, 2 the next, and a value below
  1 is refused (`darwin.ts:199-201`) — an X11 screen number, a Windows
  `Screen.AllScreens` index. It is passed through, never renumbered
  (`src/platform/system/types.ts:98-104`). `timeout_ms` stops one capture
  (default `15000`, `src/computer/exec.ts:23`).
- **`computer_windows`** — one line per window, tab-separated. The id is the
  OS's own — the macOS window number that `screencapture -l` takes, an X11
  window id, or a Windows `MainWindowHandle` (`src/computer/tools.ts:236-266`).
  On macOS and Windows a line is id, process or owner, title; an X11 line is the
  id and the title alone, because that is all `xdotool getwindowname` returns
  (`src/computer/drivers/linux.ts:189-195`). On macOS the listing comes from the
  **window server's own list**, read through `osascript -l JavaScript`
  (`src/computer/drivers/darwin.ts:225-295`), so its ids are real CGWindowIDs
  `screencapture -l` accepts and it needs **no** Accessibility grant: only the
  title column depends on Screen Recording, and it stays empty when macOS
  withholds a window name. `app` narrows the list by platform: on macOS a
  case-insensitive substring of the window **owner's** name
  (`src/computer/drivers/darwin.ts:267-268`), on X11 a match against the window
  **title** (`xdotool search --name`, case-insensitive unless `--case` is given:
  `src/computer/drivers/linux.ts:187`), and on Windows a match against the
  **process name or the title** (`src/computer/drivers/win32.ts:295`). Only macOS
  turns a filter that matches no visible window into an error naming it
  (`src/computer/drivers/darwin.ts:272-274`); on X11 and Windows it lists
  nothing, and the tool answers with the empty listing
  (`src/computer/tools.ts:258-262`).
- **`computer_click`** — `button` is `left` (default), `right` or `middle`, and
  `clicks` is `1` (default) or `2`. `window_id` targets one X11 window;
  macOS and Windows send input to the focused window and refuse a `window_id`
  instead of silently ignoring it (`src/computer/drivers/darwin.ts:185-187`).
- **`computer_move`** — moves the real cursor; it takes no window.
- **`computer_type`** — the text is never echoed back in the result, because it
  may be a password (`src/computer/tools.ts:226-228`); a newline presses Return.
- **`computer_key`** — `keys` is modifiers first and exactly one final key:
  `["cmd", "shift", "t"]`, `["ctrl", "c"]`, `["Return"]`. A modifier in the
  final position, or a second normal key, is refused rather than serialized into
  a combination that would type something else.

### `dry_run`: rehearse the exact command

Every tool takes `dry_run: true`. It returns the **exact spawn vector** the tool
would use as JSON — `{argv, windowsVerbatimArguments, script?}` — with
`metadata.dry_run` set, and executes nothing
(`src/computer/tools.ts:83-95`; the vector comes from the same resolver the real
run uses, `src/computer/exec.ts:91-93`). This is the safe way to see what a
gesture would do — which coordinates, which window id, which button, which
helper binary — before it does anything. Use it first for any input you cannot
take back.

### Screenshots

A capture is written under **`<worktree>/.rolebox/computer/`** as
`<timestamp>-<seq>.png` unless `path` names another file, and the directory is
created `0700` (`src/computer/capture.ts:22-26`, `:46-54`, `:56-64`). The result
carries the PNG twice: as a `data:image/png;base64,...` attachment for an
image-capable model route, and as plain text — `[image: image/png, N bytes]`
plus the saved path — for the transcript (`src/computer/capture.ts:160-172`). The
`metadata` records the PNG's own width, height and byte count, read from its
IHDR, so a helper that wrote a different image cannot make the tool report one
it did not take (`src/computer/capture.ts:116-146`).

**A capture is in device pixels, input is in screen coordinates.** macOS
`screencapture` writes the pixels of the captured screen's backing scale — a
3024x1964 PNG for a 1512x982-point 2x display — and tags the file with that
density. The result reports it as `metadata.pixel_scale` (`2` on that display),
and when it is above 1 the text adds one sentence with the size in pixels, the
scale and the same size in screen coordinates. `computer_click` and
`computer_move` take screen coordinates, so a pixel coordinate read off the
image must be divided by `pixel_scale` before it is clicked
(`src/computer/capture.ts:66-106`). Two further facts follow from the same
flags: a window capture drops the shadow (`screencapture -o`), so its image is
exactly the window frame rather than a frame plus a margin whose pixel (0,0) is
not the window's top-left, and a capture with no target covers **one display**
(on macOS the main display), never a stitched image of every screen
(`src/computer/drivers/darwin.ts:5-21`).

A failure is never a thrown exception and never a silent no-op: the text is one
sentence that starts with `Error:` and names the cause and what to do about it
(`src/computer/tools.ts:5-10`, `src/computer/exec.ts:11-13`).

## Policy: off by default

On a host that carries roles, two independent decisions must both say yes before
a `computer_*` call can reach the desktop: the **global gate** (may this host
offer the family at all?) and the **role grant** (may this role use this tool?).
Both fail closed, and neither one can turn the other on. Codex is the exception:
its MCP transport carries no role and no per-call permission prompt
([Codex has no permission prompt](#codex-has-no-permission-prompt)), so there the
global gate is the whole policy.

### 1. The global gate — `computerUse`, default OFF

The gate is a single resolution point (`src/loader/computer-use-gate.ts:131-171`).
Every source is checked, and the family is enabled only when one of them holds
the boolean `true` (`:24-26`, `:92-94`, `:141`):

1. the **host plugin option** — `computerUse` on a host that already carries
   plugin options: the dsh plugin `Config` (`src/entries/dsh.ts:217-222`) and the
   Codex MCP entry's options (`src/entries/codex.ts:101-112`);
2. the **global rolebox config** — `computerUse: true` in
   `~/.config/rolebox/config.yaml`;
3. the **project config** — `computerUse: true` in
   `{workspace}/.rolebox/config.json`.

Absent everywhere is the default and means off. A non-boolean value — the string
`"true"`, `1`, `{}` — is not enablement, so a config typo fails closed
(`:24-26`). A host option can only ASSERT enablement: it is schema-defaulted, so
`false` is indistinguishable from unset, and it never overrides a user's
explicit config-file opt-in (`:28-32`).

Registration is where the gate is enforced. On dsh the family is refused
independently of — and before — any namespace filter
(`src/platform/adapters/dsh/role-tool-policy.ts:96-112`, applied at
`src/entries/dsh.ts:2100-2103`, `:2266-2269`), and the assembly receives the gate at
`src/entries/dsh.ts:2237-2246`. The Codex entry resolves the same gate and hands
it to the assembly (`src/entries/codex.ts:125-139`), and Pi appends the family to
its tool record only when the gate is on (`src/entries/pi.ts:1243-1244`). On the
opencode entries the same decision is expressed as agent-config tool rules:
each of the seven names a role does not grant is emitted as `false`
(`src/prompt/agent-config.ts:119-144`), which the v2 agent transform turns into a
deny rule (`src/platform/adapters/opencode2/agents.ts:245-253`). Those rules
concern names neither entry registers: the family is absent on opencode, so a
grant there produces no callable tool.

### 2. The role grant — `role.yaml` `tools:`

On dsh and Pi, with the gate on, a call still needs a grant from the **acting
role**. The grant is the role's `tools:` map
(`src/loader/computer-grants.ts:83-100`):

```yaml
tools:
  computer_screenshot: true    # one tool, by exact name
  computer_*: true             # the whole family
```

The vocabulary is exactly those two shapes: an exact name, or the family
wildcard `computer_*` (`:86-88`, `:97-99`). The example role in
[`examples/computer-use/role.yaml`](../examples/computer-use/role.yaml) opts in
with `computer_*: true`, and the skill it loads
([`examples/computer-use/skills/computer-use/SKILL.md`](../examples/computer-use/skills/computer-use/SKILL.md))
teaches the observe → act → verify loop. An absent `tools:` map, a `false`
value, an unrelated key and the generic `"*": true` wildcard are all **not**
grants (`:14-18`) — a generic "everything else" allowance must not hand over
control of the user's screen. A session with no active rolebox role (the base
agent) is denied too, and every denial names the role and the exact line to add
(`:127-159`).

How that grant is enforced depends on what the host offers, and each path fails
closed:

- **dsh** — the family is registered globally, so the decision is a monotonic
  `ctx.tools.guard` installed once at boot: it resolves the session's active role
  and denies an ungranted `computer_*` call before the tool body runs
  (`src/platform/adapters/dsh/role-tool-policy.ts:1-30`, `:163-171`). A host
  without `ctx.tools.guard` cannot enforce the grant at all, so rolebox registers
  nothing there rather than shipping an ungoverned screen-control surface
  (`:26-30`, `:147-161`).
- **Pi** — the tool interceptor runs the same decision before the tool call and
  fails it with the denial reason (`src/platform/adapters/pi/tool-interceptor.ts:120-142`).
- **opencode** — there is nothing to enforce: neither entry assembles the
  family, so the per-role decision is emitted into the agent config as `false`
  entries that deny a tool the host was never given. Whether opencode itself
  turns an agent-config `tools: false` entry into an effective deny is host
  behaviour this repository cannot observe and is **unverified here**.
- **Codex** — see the next section: there is no role to grant anything.

### What does NOT enable computer use

- **`enabledNamespaces: ["*"]` is not the gate.** On dsh that option is an
  allow-list filter over the tools that were already assembled and it matches the
  `computer_` prefix like any other namespace, so the gate is checked
  independently of it (`src/platform/adapters/dsh/role-tool-policy.ts:96-112`;
  the filter itself is `src/entries/dsh.ts:770-795`, applied at `:2104-2107`, `:2270-2273`). `"*"`
  registers everything assembled — including nothing, when the gate is off.
- **A `computer_*` key in `role.yaml` alone is not the gate.** A role grant can
  never turn the family on by itself; on the hosts that carry a role, the gate
  AND the grant are both required (`src/loader/computer-grants.ts:28-30`).
- **Installing rolebox is not the gate.** `npm install` grants no OS permission;
  see [Host requirements](#host-requirements).

### Codex has no permission prompt

The Codex transport is MCP over stdio, where `context.ask()` is a documented
no-op (`src/entries/codex.ts:159-161`) — a tool that would request permission on
another harness runs without a prompt. That transport also carries no role
(`docs/limitations.md`), so no per-role grant can be resolved there and none is
invented: the **global gate is the whole policy on Codex**
(`src/entries/codex.ts:10-22`, `:125-131`). With the gate on, all seven tools are
registered and callable with no role opt-in anywhere in the path. Turn it on
only for a workspace where you are willing to have the desktop driven unattended.

## Graph nodes: the `tools` field

A version-3 graph declaration may grant one node extra host tools beyond the
worker baseline. The field is `tools?: string[]` on the node: exact host tool
names, or trailing-star prefixes (for example `computer_*`)
(`src/graph/compiler/declaration-v3.ts:153-168`). Entries are trimmed, unique and
sorted by the front-end, and **absent means the baseline only** — the worker
baseline is `graph_submit_outcome`, plus `graph_worker_exec` on dsh, and a node
that does not declare the field keeps exactly that baseline and gets no
`computer_*` tool.

A declared grant is a NARROWING of what the node may do, never a widening of the
graph face: those names are host tools, added for that worker's own calls only
(`src/graph/host/tool-binding.ts:79-96`). Matching is fail-closed — an exact name
admits exactly that name and a trailing-star prefix admits every name starting
with the stem, so a bare `*` is the exact name `*` and no single entry grants the
whole host tool surface (`src/graph/host/tool-binding.ts:98-126`).

```yaml
- id: shooter
  tools: ["computer_*"]        # or exact names: computer_screenshot, computer_click
```

```json
{ "id": "shooter", "tools": ["computer_screenshot"] }
```

## Image transport per host

A screenshot travels to the model through the harness's own tool-result
transport, and each host does it differently:

| Host | How an image attachment reaches the model |
| --- | --- |
| Codex (MCP) | Image attachments become MCP `image` content blocks, with the base64 payload and the text block first (`src/platform/adapters/codex/tool-factory.ts:65-92`) |
| opencode v2 | Attachments become v2 `file` content blocks `{type: "file", uri, mime, name?}` after the text block (`src/platform/adapters/opencode2/tool-factory.ts:84-115`). No screenshot travels this path today: neither opencode entry registers a `computer_*` tool |
| Pi | Image attachments become Pi `image` content blocks `{type: "image", data, mimeType}` after the text block (`src/platform/adapters/pi/tool-factory.ts:46-92`) |
| dsh | Needs the host's attachment service: the bytes are committed through `saveImage` and the result carries a durable `ImageAttachmentRef` on an `ImageBlock` (`src/platform/adapters/dsh/attachment.ts`). With no attachment service wired, the image does not travel as an image: the result stays text plus the saved path under `.rolebox/computer/` |

## Host requirements

### macOS

Screenshots use `/usr/sbin/screencapture`, input uses `/usr/bin/osascript`
driving System Events, and the window list runs `osascript -l JavaScript`
against the window server (`src/computer/drivers/darwin.ts:1-43`). Every grant
goes to the **application that launched the host** — the terminal or agent
process — not to rolebox, and not by `npm install`. Which capability needs which
grant:

- **Screen Recording** for `screencapture` to include window contents; without
  it the PNG contains only the desktop wallpaper
  (`src/computer/drivers/darwin.ts:62-63`). It also decides the window *titles*
  `computer_windows` reports: without it the ids and owner names still list and
  the title column is empty.
- **Accessibility** (System Settings > Privacy & Security > Accessibility) for
  **input only** — it is what lets the process synthesize a click, a keystroke or
  a pointer move, through System Events or the `cliclick` helper.
- **Automation for System Events** (System Settings > Privacy & Security >
  Automation) to script it. It is a grant *separate* from Accessibility, so an
  application trusted for one can still fail the other; every input plan carries
  a single remediation sentence naming both
  (`src/computer/drivers/darwin.ts:59-60`, `:170`, `:180`), and the process must
  be restarted after the grant.

`computer_windows` needs **none** of the three: it reads the window server's own
list, which is not System Events and not input
(`src/computer/drivers/darwin.ts:225-295`).

Moving the pointer and a right or middle click use the `cliclick` helper, which
is **not** part of macOS; when it is missing the tool refuses and names the
install command (`brew install cliclick`,
`src/computer/drivers/darwin.ts:35-39`, `:348-349`). `computer_permissions`
reads the Accessibility status (`UI elements enabled`) and returns the
remediation text when it is off (`src/computer/drivers/darwin.ts:356-358`,
`src/computer/tools.ts:400-407`).

### Linux

X11 only, for now. Capture prefers ImageMagick's `import` and falls back to
`scrot` (which cannot address one window); input is `xdotool`
(`src/computer/drivers/linux.ts:1-16`). A **Wayland session is an explicit
refusal**, not a silent failure: `scrot`, `import` and `xdotool` cannot inject
through a Wayland compositor, and rolebox declares no Wayland driver — the tool
says so and names the X11 or Xwayland path
(`src/computer/drivers/linux.ts:36-43`). A missing `import`/`scrot`/`xdotool` is
also an explicit refusal that carries the install hint
(`src/computer/drivers/linux.ts:30-34`, `:76-78`, `:87-89`;
`src/computer/exec.ts:112-119`). `computer_permissions` reports the same two
conditions (`src/computer/drivers/linux.ts:261-283`).

### Windows

Capture and input are PowerShell scripts — System.Drawing for the screen,
System.Windows.Forms for `SendKeys` and the pointer
(`src/computer/drivers/win32.ts:1-21`). PowerShell must be available (the plan
names `powershell` in `requires`, and the executor refuses with a remediation
when it is missing), and the session must be interactive
(`src/computer/drivers/win32.ts:14-17`, `:34-35`, `:378-388`). There is no
per-application permission grant on Windows; `computer_permissions` reports
whether the session is interactive. The Windows key cannot be synthesized
(`src/computer/drivers/win32.ts:150-153`).

### Any other platform

A platform rolebox declares no driver for refuses every call with one sentence
naming the platform and the systems that work
(`src/computer/drivers/unsupported.ts:13-17`,
`src/platform/system/descriptors.ts:36-38`).

## Safety rules

1. **Delivered input cannot be rolled back.** A click, a keystroke or typed text
   that reached an application is already part of the desktop's state; there is
   no undo call (`deepseek-harness/docs/subsystems/computer-use.md`).
2. **The desktop is shared and can change between calls.** Another person, a
   notification or another process can move the window you aimed at. Re-observe
   before acting; never assume the screen still matches an earlier screenshot.
3. **Verify from fresh state.** After an action that was supposed to change
   something, take a new screenshot and check that it did.
4. **Rehearse risky input with `dry_run` first** — anything that submits,
   sends, deletes or confirms.
5. **Stop on a permission refusal.** When `computer_permissions` (or a tool
   failure) reports that input is not permitted, report it and stop; retrying
   the same gesture blindly cannot succeed.
6. **Ask before irreversible or outward-facing steps** — destroying data,
   changing system settings, sending messages, making payments, entering
   credentials.
