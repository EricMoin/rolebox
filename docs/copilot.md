# Copilot: Unified Turn-End Decision Pipeline

> Part of the rolebox documentation. See [README](../README.md) for overview.

Copilot is an opt-in subsystem that decides, at `session.idle`, whether to inject a user message on the human's behalf to keep the workflow moving, or hand control back to the human. It is configured per-role via the `copilot:` block in `role.yaml`.

## Overview

Every time a session goes idle, rolebox runs a single turn-end decision pipeline (`src/copilot/pipeline.ts`, invoked from the `session.idle` handler in `src/hooks/event-handler.ts`). The pipeline evaluates up to three policy sources in strict precedence order:

1. **Builtin function-continuation source** (`src/copilot/sources/builtin.ts`) — always evaluated first, always active. This is the incumbent auto-continue policy: active functions with unmet completion conditions (`continue_until`, `shouldContinue` handlers) get a `[auto-continue N/M for fn]` reminder injected, subject to `decideContinuation` caps. If it injects, the pipeline stops.
2. **User heuristic rules** (`src/copilot/rules.ts`) — opt-in. Declarative `match`/`action` rules over the last assistant text.
3. **LLM role verdict** (`src/copilot/llm.ts`, `prompt.ts`, `transcript.ts`) — opt-in. A configured subagent role reviews a transcript of the tail window and returns a strict JSON verdict.

Sources 2 and 3 are gated behind `copilot.enabled` (default `false`). When a session's role has no copilot config, or copilot is disabled, **only the builtin source runs — byte-identical legacy behavior** (`pipeline.ts:18-19, 115-116`).

### Invariants

- **At most one injection per `session.idle`.** Each source returns as soon as it injects; the next source runs only when the previous one declined (`pipeline.ts:22-26`).
- **First actionable decision wins.** Builtin first, then rules, then LLM.
- **`skip` consumes the decision.** A rule with action `skip` injects nothing *and* blocks the LLM fallthrough (`pipeline.ts:123-130`).

## Config Reference

The `copilot:` block is parsed by `parseCopilotConfig` (`src/copilot/config.ts`). The type definitions live in `src/copilot/types.ts` and the field lands on `RoleConfig.copilot` (`src/types.core.ts:145`).

```yaml
copilot:
  enabled: false            # master toggle
  rules: []                 # ordered list; first match wins
  llm:                      # optional; absent = heuristic-only path
    role: <subagent-id>     # required
    max_verdict_timeout_ms: 30000
    guidance: <string>      # optional; replaces the default advisory text
    transcript:
      window_size: 20
      max_chars: 8000
      include_tools: true
```

### Field reference

| Field | Type | Default | Semantics |
|---|---|---|---|
| `enabled` | boolean | `false` | Master toggle. When false, only the builtin continuation source runs. Strings are coerced (`"true"` → `true`); invalid values warn and fall back to the default. |
| `rules` | array | `[]` | Ordered rule list. Evaluated in order; the **first matching rule wins**. Malformed entries are skipped with a warning; duplicate `id`s are dropped (first occurrence kept). |

#### Rule entry

| Field | Type | Default | Semantics |
|---|---|---|---|
| `id` | string | required | Unique rule identifier. Missing/blank id → rule skipped with a warning. |
| `match` | object | required | At least one of `pattern` / `contains` must be set, otherwise the rule is skipped. When both are set, **both must match (AND)**. |
| `match.pattern` | string | — | Regex matched against the model's last assistant text. Invalid regexes warn and the offending rule is skipped; evaluation never throws (`rules.ts:110-116`). |
| `match.contains` | string | — | Case-insensitive substring check against the last assistant text. |
| `action` | enum | required | One of `continue` \| `skip` \| `blocked` \| `done` (`COPILOT_ACTIONS`, `types.ts:4`). Unknown values → rule skipped with a warning. |
| `reply` | string | per-action default | Custom reply text injected for `continue`/`blocked`/`done`. Never used for `skip`. |

Per-action default replies (`DEFAULT_RULE_REPLIES`, `rules.ts:30-37`):

| Action | Default reply | Effect |
|---|---|---|
| `continue` | `Continue.` | Inject the reply and stop the pipeline. |
| `skip` | *(never injected)* | Consume the turn: no injection, no LLM fallthrough. |
| `blocked` | `Blocked — end turn.` | Inject the reply and stop the pipeline. |
| `done` | `Produce final output now.` | Inject the reply and stop the pipeline. |

#### `llm` block

| Field | Type | Default | Semantics |
|---|---|---|---|
| `role` | string | required | Subagent id of the copilot decision-maker. Must be a **resolved subagent** at runtime; an unknown role warns once (per role id) and the LLM source is skipped (`llm.ts:106-109`). Missing role → the whole `llm` block is ignored with a warning. |
| `max_verdict_timeout_ms` | number | `30000` | Hard timeout for the verdict round-trip (child-session create + prompt). On timeout, the verdict is treated as a failure → skip. Numeric strings are coerced. |
| `guidance` | string | built-in advisory text | **Replaces the entire default GUIDANCE block verbatim** (replace-if-present semantics). See [LLM-role mode](#llm-role-mode). |
| `transcript` | object | all defaults | Transcript window config. `transcript: {}` is valid and yields all defaults. |
| `transcript.window_size` | number | `20` | Number of most recent messages fed to the verdict LLM. |
| `transcript.max_chars` | number | `8000` | Hard cap on transcript length; **tail-truncated** (most recent content kept) when exceeded (`transcript.ts:90-92`). |
| `transcript.include_tools` | boolean | `true` | When true, tool results are appended as brief one-line summaries; when false, tool parts are dropped entirely (`transcript.ts:81-86`). |

Non-object input at any level (e.g. `copilot:` given a string, `rules:` given an object) falls back to defaults with a warning. The parser always returns a fresh object with fresh arrays; the frozen defaults (`DEFAULT_COPILOT_CONFIG`, `DEFAULT_COPILOT_LLM_CONFIG`, `DEFAULT_COPILOT_TRANSCRIPT_CONFIG`) are never shared or mutated (`config.ts:32-57`).

## Precedence

The pipeline (`pipeline.ts:93-168`) runs exactly this order for one idle:

```
a. BUILTIN  → if it injects, STOP
b. RULES    → first matching rule:
                 skip           → consume the turn (no injection, no LLM fallthrough)
                 continue|blocked|done → inject reply, STOP
c. LLM      → advance:true  → inject replyText
              advance:false → hand control back (no injection)
              null (any failure) → no injection
```

- When the role has no copilot config, or `enabled` is false, only the builtin source runs.
- The rules source reuses the handler-precomputed last assistant text when present, and only pays for a lazy `messages` read when copilot is enabled (`pipeline.ts:177-184`).
- Copilot-sourced injections are wrapped via `buildReminder` and stamped with `COPILOT_MARKER`; the builtin source keeps its own existing `[auto-continue` marker.

## LLM-Role Mode

### Authoring the decision-maker role

`llm.role` names a rolebox subagent that acts as the copilot decision-maker. It must be a resolved subagent (`resolvedSubagents`, built by `buildSubagentLineage` in `src/dispatch/factory.ts:78-113`). The role's system prompt should instruct it to act as a conservative continuation judge: read the transcript, decide whether the agent genuinely needs a nudge to finish, and reply with the verdict JSON.

### The verdict exchange

The exchange happens on a **fresh child session** (`parentID` = origin sid) — the origin session's transcript is never touched: `prompt`/`promptSync` are only ever called on the child (`llm.ts:9-13, 113-124`). The flow:

1. Resolve `role` against the resolved subagent registry; unknown role → skip (warn-once).
2. Create a child session, then `promptSync` the verdict prompt with an `AbortSignal` firing after `max_verdict_timeout_ms`.
3. Parse the verdict from the **last text part** of the response.
4. Abort the child session best-effort in all cases (`llm.ts:153-159`).

There is **no retry** — a single attempt per idle (`llm.ts:21`).

### Transcript-prompt structure

`buildVerdictPrompt` (`src/copilot/prompt.ts:66-77`) assembles four sections:

1. **Role-identity header** — names the session and states the task ("decide whether to inject a user message on the human's behalf... or hand control back to the human").
2. **GUIDANCE (advisory)** — the default advisory text, or `llm.guidance` replacing it wholesale.
3. **TRANSCRIPT** — the role-labeled transcript from `assembleTranscript`: `user: <text>` / `assistant: <text>` lines, plus `[tool <name>] completed: <detail>` / `[tool <name>] error: <detail>` summaries when `include_tools` is true (`transcript.ts:64-87`).
4. **VERDICT CONTRACT** — the exact JSON reply shape.

### Default advisory GUIDANCE

```text
When the assistant is asking for human approval (HITL / approval-pending) or is about to perform a destructive operation (delete, overwrite, force-push, reset, migration), prefer hand_to_user.
When the assistant is blocked on a trivial confirmation or asks "should I continue?", you may advance with a short, factual reply if you are confident.
Never fabricate facts, tool results, or user intent; never answer questions that need the human's own knowledge.
```

### Verdict contract

The role must reply with exactly one JSON object, nothing else:

```json
{"advance": true|false, "replyText": "<text to inject as the user message, only if advance>"}
```

- `advance: true` → `replyText` is injected as the user message.
- `advance: false` → hand control back to the human (no injection).

Parsing tolerates fenced blocks (` ```json … ``` `) and surrounding prose by extracting the first well-formed JSON object (string- and nesting-aware scan, `llm.ts:195-236`), then applies **strict type validation**: `advance` must be a boolean and `replyText` must be a string. Anything else — unparseable JSON, wrong types, empty/non-text response, timeout, launch failure — collapses to `null`, which the pipeline treats as **skip this idle** (`llm.ts:16-21`). A failed LLM ask never blocks the pipeline.

### Guidance is advisory — a design decision

**State explicitly: `guidance` is ADVISORY — there is no code-level enforcement.** The pipeline deliberately contains no pattern-blocking of destructive operations, no HITL gate, and no guardrail logic (`prompt.ts:4-16`, `llm.ts:19-21`). The verdict LLM acts freely on the guidance text; the role author's judgment is the control surface. This is a deliberate design decision (removing code-level destructive-op blocking and trusting the role's instructions), not an omission.

Deliberately absent by design: injection budgets, session caps, copilot cooldowns, and hard guardrails — the continuation caps live only in the builtin source (`decideContinuation`, `{ globalMaxTurns: 25, perFnMax: fn.continue_max ?? 5 }`, `builtin.ts:149-153`).

## Marker and Synthetic-Injection Classification

Copilot-injected prompts re-enter the plugin through `chat.message` as user-role messages. The marker constant (`src/copilot/constants.ts:18`):

```ts
export const COPILOT_MARKER = "[copilot-auto:";
```

Injected replies are wrapped via `buildReminder` with the marker payload naming the source (`pipeline.ts:195-205`):

- `[copilot-auto: rule:<rule-id>]` — a user rule injected the reply
- `[copilot-auto: llm]` — the LLM verdict injected the reply

`isSyntheticInjection` (`src/hooks/chat-message.ts:27-31`, mirrored at `src/platform/adapters/pi/chat-activation.ts:86-92`) matches on this prefix. Classification matters because synthetic re-entries must NOT:

- **Reset `continuationCount` / `cooldownUntilTurn`** — resetting would defeat the builtin continuation caps and enable unbounded auto-continue spin (`chat-message.ts:200-210`).
- **Enter `userMessagedSessions`** — they are not genuine user turns (`chat-message.ts:64-66`).
- **Cancel active loops** — loop cancellation is triggered by real user messages only (`chat-message.ts:67-69`).

## Worked Example

A complete `copilot:` block (rules + llm) that parses cleanly through `parseCopilotConfig`:

```yaml
copilot:
  enabled: true
  rules:
    - id: done-marker
      match:
        contains: "[done]"
      action: done
      reply: "Wrap up and emit the final result."
    - id: ends-with-question
      match:
        pattern: '\?\s*$'
      action: blocked
    - id: stalled
      match:
        pattern: "as of my last knowledge"
        contains: "I cannot"
      action: continue
    - id: inconclusive
      match:
        contains: "inconclusive"
      action: skip
  llm:
    role: copilot-verdict
    max_verdict_timeout_ms: 15000
    guidance: "Prefer hand_to_user when the assistant requests human approval or is about to perform a destructive operation."
    transcript:
      window_size: 10
      max_chars: 4000
      include_tools: true
```

Semantics of this block:

- `done-marker` — when the assistant text contains `[done]`, inject the custom reply and stop; no LLM ask.
- `ends-with-question` — when the text ends with `?`, inject `Blocked — end turn.` and stop (returns control to the human).
- `stalled` — when the text both matches the pattern AND contains `I cannot` (AND semantics), inject `Continue.` and stop.
- `inconclusive` — consumes the turn without injection and without LLM fallthrough.
- When no rule matches, the `copilot-verdict` role is asked on a fresh child session with a 15 s timeout, the custom `guidance` replacing the default advisory text, and a 10-message / 4000-char transcript including tool summaries.

The verdict role (`copilot-verdict`) must be declared as a subagent of the role and instructed to reply with the strict JSON contract: `{"advance": true|false, "replyText": "..."}`.
