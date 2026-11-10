# Copilot: Suggestions and Automatic Continuation

> Part of the rolebox documentation. See [README](../README.md) for overview.

Copilot generates a possible next human message. Its four browser modes control whether it stays off, suggests only on request, automatically shows a **hint card**, or automatically sends a generated message to continue the session. The default remains automatic suggestions; full automation requires choosing **Automatic continuation**.

This replaced the former turn-end decision pipeline (heuristic `rules` and the LLM `llm` verdict). Those modes are **removed**; see [Removed turn-end modes](#removed-turn-end-modes). Built-in function auto-continuation is a separate policy and is unchanged.

## Where it runs

Composer draft suggestions are a **dsh web** feature:

- the **host half** (`src/copilot/draft/`, `src/copilot/config.ts`, `src/copilot/config-sources.ts`, `src/platform/adapters/dsh/copilot-suggest.ts`, `src/platform/adapters/dsh/web-copilot-route.ts`) resolves the acting role, composes the role/project/global config, reads the transcript and makes the one-shot model call;
- the **browser half** (`src/platform/adapters/dsh/web-ui/suggest-dock.tsx`) is the composer tool-row pill — a sparkle glyph plus a short label — that watches the session and shows the hint card;

No other host (opencode, Pi, Codex) registers the button or the route. A dsh profile without the host `llm` service still boots; a fully configured suggestion request then answers `disabled` with reason `llm-unavailable`, and the button stops asking for that session.

## How it works

1. The browser watches the session. It is eligible when the agent is **not running**, the input phase is `plain`, the draft is **empty**, no attachments are present, the session is not blank and not a subagent conversation.
2. In `auto-advise` or `auto-mated`, an eligible idle (including after a turn ends or a session mounts) waits **300 ms** and makes **one** `POST /rolebox/copilot/suggest` request with `intent: "auto"`. A `none` answer or cancelled schedule is final until the next turn or a different automatic mode is selected. In every mode except `none`, clicking the button sends `intent: "manual"` and cancels a pending automatic timer.
3. On the host, the suggester:
   - resolves `roleId = activeRole(session) ?? defaultRoleId` and composes the effective `copilot.draft` config from the role, project and global sources (see [Configuration precedence](#configuration-precedence)); a role-less session still gets the project/global fallback;
   - answers `disabled` when the enable flag, `provider`, `model` or the host `llm` service is missing;
   - selects recent conversation from the session's available history, preserving the initial user goal, latest user request and latest assistant reply within `transcript_max_chars` (see [Context selection](#context-selection));
   - answers `none` without a model call when no usable user/assistant exchange exists;
   - makes **exactly one** model call, bounded by `timeout_ms` (default `4000` ms), with provider-neutral request options and **reasoning disabled** (`reasoningEffort: "off"`) when the selected route advertises that effort; there is no retry;
   - sanitizes the answer to at most `max_chars` characters. An empty answer, the literal `[none]` marker, a timeout, an abort or a provider error all become `none` (never an error shown to the user).
4. The browser re-reads the **latest** state before applying the answer — the draft must still be empty, the phase still `plain`, the session still idle and the same, and the component still mounted. Anything else drops the answer.
5. In `auto-mated`, an automatic answer calls `inputActions.setDraft(text)` and `inputActions.submit()` through the host's normal composer pipeline. Other answers, including manual requests in full automation mode, appear as a **hint card** with an eyebrow (`Suggestion` / `建议`), the wrapped text, **Fill** (`填入`) and **Dismiss** (`忽略`). Fill writes the draft without sending; Dismiss drops it.

The pill reads **Suggest** (`建议`), **Auto continue** (`自动接续`) in full automation mode, or **Suggesting** (`生成中`) while a request is in flight. It has three states — `idle`, `loading` and `disabled`. A ready card gives it an accent background. When no result is open, hover or keyboard focus shows only the mode selector and one short description of the selected mode. State explanations are not shown in this panel. Disabled reasons remain available through the button's accessible description. The control stays mounted in every state.

### The hint card

Answers that are not automatically submitted are stored in component state and shown above the suggestion button while the composer is plain, empty and attachment-free, the session is idle, and Copilot is on. The card shows the eyebrow **Suggestion** (`建议`), the suggestion text wrapped to about 300px, and two `<button>` actions:

| Action | Effect |
| --- | --- |
| **Fill** (`填入`) | Calls `inputActions.setDraft(text)` once and closes the card. |
| **Dismiss** (`忽略`) | Closes the card and writes nothing. |

The card takes no focus and does not block the composer: its buttons are ordinary buttons reachable by pointer or Tab, and nothing is focused automatically. It is announced as a group labelled by the eyebrow and uses `aria-live="polite"`.

The card contains only the suggestion and its Fill / Dismiss actions. It has no mode selector, and the separate settings panel stays hidden while the result is open.

The card clears on Fill, Dismiss, typing, adding attachments, leaving the plain input phase, a new turn, a session change or unmount. Fill and Dismiss close the floating content directly; they do not expose the hover settings underneath. They also cancel a pending replacement request, so a late answer cannot reopen the card. Dismissal does not ask again for the same idle.

Clicking Suggest while a card is visible keeps that card mounted and marks it busy until the replacement arrives. A new suggestion replaces its text; a `none` or `disabled` answer replaces it with a brief status card. Starting a manual request closes the hover settings. After a result closes, a new pointer entry or keyboard focus from outside the control can open settings again. All floating panels have a solid theme background and appear/disappear without an opacity transition.

### Choose a Copilot mode

The **Copilot mode** (`Copilot 模式`) selector belongs exclusively to the hover/keyboard-focus settings panel. If a suggestion or status card is open, close it first with Fill, Dismiss or Escape as applicable, then hover again or move keyboard focus out of the control and back in. Tab reaches the native select, arrow keys choose a mode (Enter confirms where required by the browser), and Escape closes the panel/card and returns focus to the control. The pointer can cross into the panel without closing it. When the button is disabled or loading, its wrapper remains focusable.

| Stored value | UI label | Behavior |
| --- | --- | --- |
| `none` | Off / 关闭 | Disables manual and automatic requests and sends; settings stay available. |
| `manual` | Manual suggestions / 仅手动建议 | Clicking Suggest shows a card. The user fills and sends it. |
| `auto-advise` (default) | Automatic suggestions / 自动建议 | Automatically shows a suggestion card after each turn. The user fills and sends it. |
| `auto-mated` | Automatic continuation / 全自动接续 | Automatically generates, fills and submits a next message after each turn. Manual clicks still show a card. |

Changing modes cancels pending automatic timers and requests, drops late automatic answers and dismisses automatic cards. `none` also cancels manual requests and dismisses manual cards. Other mode changes preserve manual requests and cards; those are never promoted into automatic sends. Choosing another automatic mode can start a fresh request for the current eligible idle, without reusing an earlier card or pending answer.

Full automation uses the conservative `auto` intent. When the model returns `none`, times out or errors, it stops for that idle; the next turn or an explicit mode change can trigger another attempt. There is no separate turn budget. Submission uses the same host admission and error handling as a normal composer send; a failed send is not retried by Copilot. Hosts without `inputActions.submit` fall back to a reviewable card. This runs while the browser control is mounted, not as a host background job.

The preference is stored in browser `localStorage` under `rolebox.copilot.mode`, applies across sessions on the same DSH origin, survives reloads and synchronizes mounted controls and tabs. A valid new value takes precedence over the old `rolebox.copilot.autoSuggest` key. With no new key, old `false` maps to `manual`; other old values or no preference map to `auto-advise`. An invalid new mode also defaults to `auto-advise`. Migration never selects full automation. Blocked storage still permits a page-local setting. This is not a role/project/global config field and cannot override `copilot.draft.enabled: false`. Refresh after installing the updated browser bundle; mode changes need no host restart.

### Request intent: `auto` vs `manual`

The JSON body's optional `intent` field says **why** the browser asked. It changes only the prompt's `[none]` miss rule; the model call, its bounds and its single-attempt contract are identical for both.

| `intent` | Sent by | `[none]` rule |
| --- | --- | --- |
| `auto` (default when the field is absent) | the automatic 300 ms idle timer | Conservative: the model may answer nothing when the agent is still working, the task is finished, or only the user can know. |
| `manual` | a click on the suggestion button | Looks for a useful continuation of the current task, including after a completed exchange, but may answer `[none]` when no grounded candidate exists. A completed task does not require a follow-up. |

Both intents require suggestions to follow the session's user goal and constraints. The latest user instructions and topic changes take precedence over earlier context. The prompt rejects unrelated tasks, repeated completed work and generic testing/review/refactoring without an unresolved need. It also tells the model to abstain when answering would require guessing facts or preferences only the user knows; an assistant's optional offer alone does not establish a new user request.

A manual ask that still yields no draft shows a separate status card for about **4 seconds** — **No suggestion right now** (`暂时没有合适的建议`) with the body *Try again after the next turn, or type your own message.* (`可以等下一轮再试，或直接输入你的内容。`). A manual `disabled` answer shows the disabled title and reason the same way. Automatic requests never raise a notice. The status card takes no focus and does not replace the hover settings' content. Typing, a new turn, a session switch, Escape or unmount clears it immediately; expiry closes it without revealing settings.

### Context selection

The host reads the available message history of the requested session and applies the window locally. `window_size` counts text-bearing user/assistant messages, so tool-only messages and reasoning do not crowd out the conversation. Ignored and synthetic text parts are excluded. The first user message, latest user message and latest assistant reply are retained as additional excerpts when outside the recent window.

The total text stays within `transcript_max_chars`, including role labels and tool summaries. When it is too long, the selector reserves room for those three anchors, prioritizes recent user constraints, then fills with recent assistant messages. Long messages retain their opening and closing text with an explicit truncation marker; role labels survive. Whitespace is collapsed so a multiline quote cannot become another role-labeled message.

Tool results are supporting evidence: only the most recent 12 summaries are eligible, using leftover space up to one eighth of the total budget and at most 2000 characters. History already removed by the host is unavailable; this feature does not recover earlier compacted content.

### Cancellation

Every request carries an `AbortController`. Editing, an editor revision change, adding attachments, leaving the plain phase, starting a turn, switching sessions or unmounting invalidates pending requests. Mode changes also invalidate automatic work; `none` invalidates manual work too. The client checks the latest session/input state and the request's original mode before writing or sending. The host aborts its model call when the HTTP client goes away. A late answer is never applied.

## Route contract

`POST /rolebox/copilot/suggest` with JSON body `{ "session": "<id>", "intent": "auto" | "manual" }` (body capped at 8192 bytes). `intent` is optional and defaults to `"auto"`; when present it must be exactly `"auto"` or `"manual"`.

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ ok: true, status: "suggested", text, model, ms }` | One draft, the route's model id, and the elapsed milliseconds. |
| 200 | `{ ok: true, status: "none" }` | Nothing sensible to suggest. Do not retry this idle automatically; a manual ask shows a transient notice instead. |
| 200 | `{ ok: true, status: "disabled", reason }` | The feature is off for this session's role/profile. The client remembers this per session id and stops asking. |
| 400 | `{ ok: false, error }` | Malformed JSON, a missing/empty `session`, or an `intent` that is neither `auto` nor `manual`. |
| 404 | `{ ok: false, error }` | Unknown session. |
| 405 | `{ ok: false, error }` | Known path, non-POST method. |
| 413 | `{ ok: false, error }` | Request body over the cap. |
| 500 | `{ ok: false, error }` | Unexpected failure. |

`disabled` reasons are stable strings: `not-enabled`, `model-not-configured`, `llm-unavailable`. A `none` answer may carry an internal reason (`transcript-unavailable`, `insufficient-context`, `timeout`, `stream-error`, `empty-draft`, `aborted`) but the HTTP body is just `{ ok: true, status: "none" }`.

The route is composed into the plugin's single `/rolebox` web-server registration; it owns the exact `/rolebox/copilot/suggest` path for every method (so a non-POST reaches its documented `405`) and lets every other request fall through to the role-switch route.

## Config Reference

The block is parsed by `parseCopilotDraftFragment` and composed by `composeCopilotConfig` (`src/copilot/config.ts`); `parseCopilotConfig` is the single-role compatibility wrapper. The types live in `src/copilot/types.ts` and the role field lands on `RoleConfig.copilot` (`src/types.core.ts`). A role configures it in `role.yaml`:

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

Only the `draft` block is read. `draft: {}` is valid and is treated as absent, so a lower-precedence source (or the defaults) supplies every field.

| Field | Type | Default | Clamp / requirement |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master toggle. Boolean strings (`"true"` / `"false"`) are coerced; an invalid value warns and is treated as absent. |
| `provider` | string | — | Optional override, but a request needs it together with `model`. Non-empty string; invalid values warn and are treated as absent. |
| `model` | string | — | Optional override, but a request needs it together with `provider`. Non-empty string; invalid values warn and are treated as absent. |
| `timeout_ms` | number | `4000` | Clamped to `200`–`10000`. Hard deadline for the one model call; the call answers as soon as the provider responds, so this is a ceiling, not added latency. |
| `max_chars` | number | `120` | Clamped to `16`–`500`. Upper bound on the suggested draft, applied at a word boundary when possible. |
| `window_size` | number | `40` | Clamped to `2`–`200`. Recent text-bearing user/assistant messages, plus the initial user goal and latest exchange when outside the window. Tool-only messages do not count. |
| `transcript_max_chars` | number | `24000` | Clamped to `500`–`128000`. Total transcript cap; preserves user goal and latest exchange before filling other context. |

Numeric strings are coerced; non-numeric values warn and are treated as absent. A non-object `copilot` block or `draft` value warns and contributes no fields. The parser always returns a fresh object and never mutates the frozen defaults.

Explicit values still override the defaults. Configurations that set the former `window_size: 8` or `transcript_max_chars: 4000` keep those smaller budgets; remove those fields to use the larger defaults, or increase them explicitly.

### Configuration precedence

A role does not have to configure `copilot.draft`: the effective config is
composed from three sources, highest precedence first.

| Precedence | Source | Shape |
| --- | --- | --- |
| 1 (highest) | The acting role's `role.yaml` | `copilot.draft` |
| 2 | Project file `<workspace>/.rolebox/config.json` | top-level `copilot.draft` |
| 3 (lowest) | Global file `<rolebox-config-home>/config.yaml` | top-level `copilot.draft` |

The global path is the same `config.yaml` the CLI uses (`getConfigPath()`):
`$ROLEBOX_CONFIG_DIR/config.yaml`, else `$XDG_CONFIG_HOME/rolebox/config.yaml`,
else `~/.config/rolebox/config.yaml` (`%APPDATA%/rolebox/config.yaml` on
Windows). That file is shared with the CLI registry list: `rolebox registry
add`, `remove` and `default` rewrite only the `registries` key, so the
`copilot` block (and the other global keys) survive those writes.

Project JSON:

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

Global YAML:

```yaml
copilot:
  draft:
    enabled: true
    provider: example-provider
    model: example-model
```

Composition rules:

- **Field-level merge.** Each field is resolved independently: a higher source
  that sets only `model` still inherits `provider`, `enabled` and the bounded
  fields from lower sources.
- **`enabled` is three-state.** A present `true` or `false` wins; an absent
  `enabled` inherits from the next source. The final default is `false`, so the
  feature stays off until some source enables it. A role `enabled: false`
  therefore overrides an enabled project or global config.
- **Invalid values are absent.** An invalid field value warns once and is
  ignored, exactly as if it were not written, so a lower source can supply it.
- **Role-less sessions still work.** When no role resolves for a session (or the
  resolved id is not in the catalog), the role contributes no fields and the
  project/global sources alone decide the config.
- **Read once at boot.** Both files are read once when the plugin starts; there
  is no file watching. Missing files contribute nothing. An unreadable or
  malformed file warns and contributes nothing, so it never fails the boot.
  Restart the host (or reload the plugin) after editing either file.

### What makes the feature run

All of these are required for a suggestion:

1. the effective `copilot.draft.enabled` is `true` (from the role, project or global source);
2. `provider` and `model` are both set by some source;
3. the dsh host has mounted its `llm` service;
4. the session can be read (unknown sessions answer `404`).

Anything missing yields `disabled` with the corresponding reason — never an error in the composer.

## Privacy

Selected excerpts from the requested session — recent text-bearing messages plus its initial user goal and latest exchange, with brief tool summaries when space permits — are sent to the **configured provider/model** to build one suggestion. Their total length is capped at `transcript_max_chars`; anchor excerpts can come from before the recent `window_size` messages. That provider is the one named in the effective `copilot.draft` config, not necessarily the model running the session. Rolebox does not persist the draft request or transcript copy. Suggestions remain in the card/composer until submitted; in `auto-mated`, automatic answers are submitted as normal user messages and become part of the host session history. Leave `enabled` off (the default) on roles or projects whose transcripts must not leave for another provider.

## Limitations

- **Cards remain manual.** Fill writes editable text without sending, including for manual requests in full automation mode. There is no inline completion or per-token streaming into the editor.
- **Full automation is browser-local.** It requires explicitly selecting `auto-mated`, an enabled host config and a mounted browser control. Existing text and attachments are never sent by Copilot.
- **One suggestion per idle and selected mode.** An automatic `none` is not retried until the next turn. A manual click or a change to another automatic mode can ask again within the same idle.
- **One bounded call, provider-neutral options.** Each suggestion is a single model call bounded by `timeout_ms` and a fixed output-token cap; there is no retry. The request carries only options that every supported provider route accepts — in particular no stop sequences — because a host adapter that rejects an unsupported option fails the call before the model runs. Reasoning is explicitly disabled (`reasoningEffort: "off"`) when the selected route advertises an `off` effort: a one-line next-message prediction must not pay for chain-of-thought. The suggester reads the route's capability metadata first (a read-only lookup, not a model call) and omits the field for a route with no reasoning metadata, because the host rejects an unsupported effort (`UNSUPPORTED_REASONING_EFFORT`) before the adapter runs; such a route keeps the provider's own reasoning default instead of failing.
- **Silent misses are normal.** A timeout, abort, provider error or empty answer produces no draft and no visible error. An automatic miss is completely silent; a manual miss raises only its short transient notice.
- **Model and provider are config, not a live picker.** Changing a role takes effect on the next request after the role config is reloaded; the project/global files are read once at boot, so restart the host (or reload the plugin) after editing them.
- **dsh web only.** The route and button are not registered on opencode, Pi or Codex.
- **`disabled` is sticky per session.** Once the host answers `disabled` for a session, the button stops asking for that session until the page reloads.

## Removed turn-end modes

The former `copilot.enabled`, `copilot.rules` and `copilot.llm` top-level keys (heuristic rules and the LLM verdict role) were removed together with the turn-end decision pipeline (`src/copilot/pipeline.ts` now runs only the built-in continuation source; `src/copilot/rules.ts`, `llm.ts` and `prompt.ts` are gone).

- Legacy keys are **ignored with one warning per key** (`copilot.<key> was removed; use copilot.draft`); parsing never throws.
- `copilot.draft` replaces them for the composer-suggestion feature.
- **Built-in function auto-continuation is unchanged.** It remains a separate policy driven by active functions (`continue_until`, `shouldContinue` handlers) and is not configured through `copilot`.
