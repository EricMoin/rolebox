# Changelog

## 1.6.1

### Bug Fixes

- **Postinstall patch script shipped in the npm package** — `postinstall` runs `scripts/patch-opentui-native-entry.mjs` after install, but `scripts/` was absent from the npm `files` whitelist, so every user install would fail with ENOENT on that step; the exact script path is now whitelisted. Adds the tag-triggered publish workflow (`.github/workflows/publish.yml`) with a package-content verification gate that pins this class of bug (missing postinstall/exports files) from shipping again. (7568a9b)

---

## 1.6.0

### Features

- **Unified turn-end decision pipeline** — Unifies the incumbent function auto-continue as an always-on builtin policy source inside a single `session.idle` pipeline, alongside an opt-in user-heuristic rules source and an opt-in LLM copilot-role verdict source. The builtin source is a byte-identical extraction of the previous continuation phase (`decideContinuation` and `src/function/continuation.ts` untouched, same 25/5 caps, cooldowns, rollback, and `[auto-continue` marker); sources evaluate in strict precedence builtin → rules → LLM with at most one injection per idle, and a rule action `skip` consumes the turn without LLM fallthrough. The LLM verdict runs on a fresh child session with a hard timeout and skips on any failure. Copilot injections carry a `[copilot-auto:` marker registered as synthetic so they never reset continuation counters or cancel loops. No injection budgets or code-level guardrails by design: destructive and HITL caution is advisory prompt guidance, overridable via `llm.guidance`, with the role author's judgment as the control surface. (a626cd6)

### Bug Fixes

- **Graph budgets enforced, crash orphans cancelled, loop caps retired** — Enforces the declared graph- and per-node budget ceilings: a graph-level breach escalates the ready node and cancels stranded pending nodes so the graph reaches complete instead of hanging, and per-termination usage accumulates into `state.budget` totals at `captureNodeUsage` to feed the ceiling check. Crash-window orphaned dispatch sessions are cancelled on recover/adopt (reconcile sweeps the dispatch parent session for a live task and recovery tears it down fire-and-forget), and loop-cap re-entry retirement now surfaces through the completion seam (escalate-signal with a post-`markDone` Done status, no duplicate on replay). (4218ec4)
- **`hashline_edit` lost-update prevention** — Concurrent edits to the same file could silently overwrite each other: each call ran an optimistic version guard against the file at read time, then renamed over whatever was on disk afterwards, so the last rename won and earlier edits were lost with no error; a batch containing the same `filePath` twice had the same silent-overwrite failure. Edits are now serialized within the process by a per-path async mutex held across the whole read → validate → compute → recheck → write cycle (acquired in globally sorted key order to keep overlapping batches deadlock-free, released in reverse order on every path), duplicate paths in one batch are rejected up front with zero side effects, and a best-effort pre-write re-check re-reads every file (canonicalize + recompute version) immediately before writing — any drift from the read-phase version, or a to-be-created file that has appeared, fails the whole batch with zero writes and points back to `hashline_read`. The re-check is explicitly best-effort: it does not lock against other processes, so a change between re-check and rename is not caught, and a batch remains a non-transactional sequence of per-file atomic renames. New `src/hashline/path-lock.ts` + `tests/hashline/path-lock.test.ts` + `tests/hashline/concurrency.test.ts`. (e82d674)
- **Graph control paths and persistence hardened** — Closes the graph-engine audit findings (R1/R2, Y1/Y3/Y4/Y5/Y6/Y7/Y9/Y11/Y12, B1-B3). Approve/reject/partialApprove/retry now acquire the advancing lock before the critical section via `_runControlOperation`; under contention the whole operation defers (bounded macrotask retry) instead of running unlocked and releasing an owner-less lock. `loadEngineStateFromJson` validates node status/joinStrategy and file phase against the vocabularies — out-of-vocabulary values return null (clean start) instead of hydrating and crashing later in `canTransitionNode`. The materialized sidecar is read once at completion time (`_stashResultText`) and stashed on `node.resultText`, carried through DTO/serialize/deserialize/recovery; `_edgeResultText` no longer does disk I/O inside the critical section. The triplicated retire+cancel+refund pattern is consolidated into a shared `retireCancelledNode` helper (the cascade site keeps refund off, preserving current accounting); `recover()` rethrows non-ENOENT load failures (EISDIR) instead of silently re-provisioning completed work; the dead `DispatchBridge` surface (`executeSync`/`getResult`/`getTasksByParent`/`getBudgetTracker` + `DispatchResultPayload`) is dropped; canonicalize is depth-bounded (32) with a stable truncation marker so deeply nested payloads fingerprint without RangeError; and direct `isDirty` writes are routed through `markDirty` with stale doc anchors fixed. (9c8b7f9)
- **Graph-engine review findings resolved** — Addresses the engine code-quality review across P0-P3. `_advance` signal branches are guarded against double-counted traversals and post-terminal re-dispatch, completion is gated on drained `pendingCompletions`, and containment escalates propagate downstream so fan-in joins fail fast instead of hanging. Recovery contracts are closed (live re-check on error tasks, subscription ledger for dispose, checkpoint compensation, markDirty choke-point, `hasRequiredShape` completeness, ENOENT-only clean start) and `EnginePersistence.dispose()` plus a public `clearTerminationSubscriptions()` drop the private-field cast. HITL notifications are exactly-once and observable; session slots are refunded on direct cancel; running-node retries are guarded; escalate budget uses real token/cost; done and cancelled nodes get their own tally buckets. Dead seams are removed (`state.edges`, `mergeFanInContext`, `pendingWrite`, duplicate severity order), the signal vocabulary is single-sourced, empty edge payloads fall back to node result text, and condition-resolver `signal_observed` args are normalized. (3c70950)

### Refactors

- **Graph internals deduplicated and cancels hardened** — `getRootNodeIds` reuses `computeInDegrees` (drift-proofing), `getJoinStrategy` prefers the cached runtime `joinStrategy` field, and the shared `enqueueWithRetry` is extracted behind the three notifier factories. Per-node checkpoint history is capped at 50 entries, `resetConvergenceTracker` throws a descriptive error on unknown group, fire-and-forget `cancelTask` rejections are contained (no unhandled rejection), and the dead `isLoopExhausted` import is dropped from engine-advance. (3b2fb24)

### Documentation

- **Unified turn-end pipeline documented** — Adds `docs/copilot.md` covering the role.yaml copilot block schema, builtin → rules → LLM precedence, LLM-role authoring with the strict JSON verdict contract, the advisory-only guidance design decision, and the synthetic marker contract; the worked example parses cleanly through `parseCopilotConfig`. (b6bb402)
- **Graph architecture anchors refreshed** — Re-verifies all file:line anchors against the post-fix tree and updates the CONFIRMED-GAPS table: gaps c/d/f/g are marked resolved with current evidence, the re-verification date is refreshed, and module-map references are aligned with the engine fixes. (1edf2af)

### Tests

- **Copilot suites added** — Six copilot unit/e2e suites (`tests/copilot-{config,llm,pipeline,prompt,rules,transcript}.test.ts`) plus extended chat-message and pi-chat-activation coverage for the synthetic `COPILOT_MARKER` classification (no continuation-counter reset, no loop cancellation). (ade8978)
- **Review-fix regressions covered** — Regression tests for the engine review fixes: duplicated-signal traversal counting, quiesce-before-drain completion, containment escalate propagation, exactly-once HITL notifications, session-slot refund on cancel, running-node retry guard, escalate budget carry, done/cancelled tally buckets, dispose-cancels-debounce, persistence shape gates, budget stub contract, signal single-source schema, condition-resolver normalization, and JSON-structured status assertions. Includes the new `engine-termination-s5` suite for termination counting and deadlock-guard ordering. (7b94bc3)

---

## 1.5.0

### Breaking Changes

- **Legacy concurrency manager and session budget removed** — The `ConcurrencyManager`/`IConcurrencyManager` subsystem and the `concurrency_policies` extension point are deleted, along with per-request session budget tracking and the graph `max_total_sessions` cap; graph-node concurrency is now engine-managed (frontier, loop `max_traversals`, per-node budgets) instead of slot-based. Removes the `DispatchManagerConfig` fields `maxConcurrent`, `maxQueueDepth`, `syncReservedSlots`, `maxActivePerParent`, `maxTotalSessionsPerRequest`, `retryAfterMs`, `backpressureMaxRetries`, `backpressureMaxDelayMs`, `syncAcquireTimeoutMs` and the `concurrency_policy` factory, drops the `graph_status include_concurrency` argument, and removes the node/graph budget fields `max_sessions` / `max_total_sessions`. (edb764e)

### Features

- **Rolebox monitor panel with status/metrics routes in the dsh web app** — Adds a settings.section monitoring panel backed by two read-only `/rolebox` endpoints: `GET /rolebox/status` composes the live loop census, in-memory engine graph snapshot, session count and per-session active role, and `GET /rolebox/metrics` returns the in-process dispatch metrics snapshot. The role-switch and monitor surfaces now share ONE `/rolebox` prefix registration (the real host webserver rejects duplicate prefix routes), with the monitor route owning `/status` + `/metrics` and delegating `/roles*` to the role-switch handler; `DshPluginStats` gains `monitorRouteRegistered`. (bcf8b20)
- **Role-switch dock filter and auto-collapse** — Adds a keystroke filter row (name + description, case-insensitive) with a clear button and an explicit no-match row; the query survives collapse/expand and resets on session change. The dock now starts collapsed and re-collapses on session change and after a successful switch/clear, keeping the 36px posture above the composer while the status seat and a new current-role dot report the active role. Failed mutations keep the list open with the Retry row, and the name seat becomes `flex:none` so a role's identity never truncates. Covered by a new stateful in-process harness (`tests/platform/dsh-web-ui-dock.test.ts`, 18 tests). (0f552a4)

### Bug Fixes

- **Pi child session sidecars retained and dispatch state relocated** — Pi subagents spawn as `--no-session` children whose transcript sidecars were unlinked on exit, so `session_read` and escalate-recovery could not inspect completed or failed children; sidecars are now retained with a bounded mtime-based cap and the effective system prompt is persisted beside each transcript, with `PiSessionAdapter` falling back to the retained sidecar when no pi-native session exists. Dispatch state (results, checkpoints, progress) was written to the pi home because the dispatch manager used `dirs.configDir` as its store directory; it now points at the workspace so `.rolebox/state` lands in the project like opencode and dsh. Adds `tests/pi-sidecar-retention.test.ts`. (11a8477)
- **Pi gate dispatch skill echo repaired** — Pi gate subagents spawn as `pi --mode json -p --no-session` children whose first step is loading the gate skill via the skill tool, but pi 0.84.2 ships no `skill` tool and the child re-runs chat-activation + system-transform on top of the `--append-system-prompt`, so the model echoed skill/prompt fragments as its final answer and the gate never ran. Adds a pi-only `load_role_skill` tool returning the full SKILL.md payload with references, a child-process mode guard that skips the double context injection while keeping nested dispatch, a deterministic per-agent tool allowlist, per-pid child dispatch state, and a `<location>` path in the skill block for read-based fallback. (17ea619)
- **Final assistant answer extracted in the dispatch materializer** — `buildAssistantText` previously concatenated every assistant-role text part from the boundary index, so tool-result content misattributed as assistant text (e.g. a skill tool echoing its own SKILL.md prompt) polluted node output; `extractFinalAssistantText` now picks the last assistant message carrying non-empty text, preserving result-fence extraction and falling back to full concat only when no assistant text exists. (6277c8c)
- **Pi session completion guarded and role classification tightened** — `agent_end`/`agent_settled` completed the turn unconditionally, bypassing the `_isFinalTurn` guard that protects the `turn_end` path, so completion fired mid-tool-round-trip; the same guard now applies to both paths, and only an exact `assistant` role is classified as assistant so tool-result messages are never misattributed as assistant text, with `MessageInfo.role` widened to preserve adapter-specific roles. (8c8d4ad)
- **Tool-bearing last messages marked incomplete in detectCompletion** — `detectCompletion` only guarded pending/running tool parts and matched `finish === 'tool-calls'` exactly, while the pi adapter records `finish = 'tool_use'` for a settled tool round-trip; any tool part in the last assistant message now yields `not_ready` and any finish matching `/tool/i` is treated as incomplete, while text-only `end_turn` turns still complete. (6498537)
- **Parent reminders suppressed for graph-scoped dispatch tasks** — Graph nodes dispatch through the background-task path, which notified the parent unconditionally, doubling the graph engine's own reminders and surfacing a different id namespace (`bg_*` vs node id); a graph-scope marker is now threaded through `DispatchInput`/`DispatchTask` and `notifyCompletion`/`notifyParent` are skipped for graph-scoped tasks, with graph completion reported exclusively by the graph notifier. (a52a8c5)
- **terminalNotified persisted across engine rebuilds** — `snapshotEngineState` dropped `state.terminalNotified`, so `adoptPriorNodeStates` received undefined and the persisted-layer exact-once terminal guard was lost on the adopt/rebuild path; the flags object is now shallow-copied so the terminal-claim survives snapshots. (0da1fbf)
- **Answer replay skipped on node retry** — `graph_run(node_id, retry=true)` called `adoptPrior(replayAnswers:true)` before `retryNode`, and the answer replay re-emitted the adopted Completed node's answer through `_checkTermination` while the target was still Completed, firing a premature `[GRAPH COMPLETE]` before the retry opened; retry now adopts with `replayAnswers:false`, making `retryNode` the sole dispatch + termination authority on the retry path. (4141429)
- **False staleness kills stopped and sessions refunded** — Fixes the cascade-failure chain seen in live runs: a false-positive wall-clock staleness kill of a working-but-quiet subagent at 15 min, the opaque deadlock escalation that followed, and per-request session slots never refunded for cancelled/timed-out tasks, which blocked in-place retry after a cascade (`re_dispatched: 0`, session budget exhausted). `NodeStalenessWatcher` now consults dispatch-task liveness via an `isDispatchAlive` probe and skips the wall-clock kill while the task is verifiably live (probe-absent behavior stays byte-identical); timeout and deadlock escalation reasons carry liveness facts and upstream causes (`nodeId` + `errorReason`) instead of generic text; cancelled/timed-out dispatch tasks refund their per-request session slot (idempotent, floored at zero) while completed/escalate/blocked tasks keep counting; and the graph-declared `max_total_sessions` is enforced at the graph pre-dispatch check with a clear per-graph reason, pinned end to end by graph-staleness-cascade-chain tests. (b64b447)
- **Live in-memory engine graphs surfaced in the monitor TUI** — On the opencode platform the engine runs fully in-memory and never writes `engine-*.json`, so the monitor's disk scan showed an empty engine list while graphs were executing; the process `GraphToolSet` is now registered as a live registry source, its runtimes are projected through the same snapshot surface and merged live-wins-by-graphId over the disk scan, stale terminal persisted graphs are gated, and per-node statuses from the 250ms event poll are folded in so node glyphs update between 1s snapshot ticks. (8559208)
- **Running state persisted before the dispatch await** — A node's running transition was only persisted in the section-end finally, after the async dispatch awaited — loop re-entry during the await left disk at completed (false-completed on Pi/dsh); the running transition is now persisted synchronously before dispatch. Also: engine-persistence renames over the destination atomically (no ENOENT read window), fs-util uses unique per-write temp paths so concurrent writers never share a temp file, and recovery-state async writes are generation-guarded so superseded writes abort before their rename. (34d9259)
- **asset_search type normalized to all** — Some models emit the literal string "undefined" for an omitted optional enum, bypassing zod's `default("all")` and filtering against the bogus type — silently returning zero matches; `.catch("all")` and an execute-level guard now make missing/invalid type values always resolve to "all". (1f7b6dd)
- **Gate sentinel skipped in transition condition validation** — `t.when === "gate"` is a sentinel resolved by `phase-machine.ts` to the function's own `gateSatisfied` state, not a named condition, and the validator was reporting unknown-condition errors for legitimate gate transitions; it now skips the sentinel. (da03675)

### Documentation

- **Hot-reload reference-search index documented** — Documents that `reference_search` keeps no module-level cache: its index is a per-tool-instance closure snapshot rebuilt by the dispatch-service restart cascade, so no `invalidateReferenceIndex()` hook is needed, and that the restart is awaited so the reload tool only reports completion once dispatch is fresh — no "Agent not found" race after reload. (8699f5d)

### Tests

- **Adversarial graph construction covered** — Models build graphs incrementally through the graph tools at runtime; these tests pin how the tool layer and engine reject, warn, or degrade on adversarial shapes a model can construct: construction rejection + atomicity, warning pass-through (`dry_run` only), degenerate topologies (empty graph, pure cycle, self-loop, orphan), loop-group pathologies, fan-in/out scale, duplicate edges, and retry-cap semantics, plus a reusable scripted-dispatch test harness. (a252de2)
- **Real multi-round loop execution proven** — Previous loop tests were mock-heavy: coordinator tests cranked `onWorkerCompleted` directly, fakes returned constant results, and the service mock always created session `test-child` — so the suite could pass without the loop actually iterating across fresh sessions. A stateful `IDispatchAdapter` fake (distinct task-N/session-N per dispatch, fire-once terminated listeners, `completeTask`/`failTask` drivers) now drives the suites: real-execution (locks N rounds for N iterations with pairwise-distinct worker sessions and per-round result identity, inherit/fresh seeding), termination-precedence (cap beats `/stop-loop` at the final boundary, mid-loop cancel, `cancelNow`, worker-error phase), execution-timing (async/double/stale listener fires advance exactly once; completions racing the `_advancing` critical section defer), and service-execution (hook-path E2E where `|loop:2|` creates two distinct worker sessions and injects the completion note, locking `timeoutMs` forwarding). Mutation checks (temporary, restored byte-identical) confirmed the new suite fails when listener registration, session freshness, or cap precedence regress — the legacy suite masked all three. (a57da1f)
- **Sidecar full re-read diagnostic test** — RC-C measurement: verifies whether `messages()`/`status()` on dead or recovered Pi sessions re-read and re-parse the entire sidecar JSONL on every call, with an instrumented `readSession` counter and latency breakdown by event count. (e3acf19)

---

## 1.4.0

### Features

- **Interactive role selection for role-targeting commands** — `rolebox install`, `uninstall`, `info`, and `config` now accept an optional role argument: run them without a role (e.g. `rolebox install`) to enter an interactive picker and choose the role from a searchable list instead of remembering the exact role id. `install` lets you pick the registry (when several are configured) and the role from the registry manifest, then asks for confirmation; `uninstall` asks for confirmation before removing; `info --json` requires an explicit role so the JSON output stays machine-readable; non-TTY invocations fail with a friendly hint naming the explicit form. (043314e)
- **Interactive terminal tool with stable pi session ids** — Adds a single multiplexed `interactive_terminal` tool that drives persistent terminal sessions (REPLs, interactive prompts, and full-screen TUIs when a real PTY is available); sessions stay alive across tool calls via a hybrid backend (node-pty when it can be built, otherwise node:child_process pipes), with a `context.ask()`-gated open plus write/read/resize/close/list actions and documented `\uXXXX` keystroke decoding so control keys can reach TUIs. Also fixes pi session-id resolution in the tool factory: pi's tool-execute context exposes no direct sessionID field, so the per-invocation toolCallId fallback made every call look like a different session and broke owner-scoped state such as interactive terminal sessions; the context's sessionManager now supplies a stable session id. (3690bea)
- **Screen snapshot reads and TUI-hardened terminal sessions** — Adds a lightweight VT100/xterm screen emulator (`screen-buffer.ts`) so terminal reads can return the current rendered screen (like tmux capture-pane) instead of the raw repaint stream — the right view for full-screen TUIs; the emulator also auto-answers terminal queries (cursor position, device attributes, window size) that TUIs block on, and feeds a paint-op count used to auto-detect TUI sessions (`auto` read mode). Write now accepts named keys (`<enter>`, `<ctrl+c>`, `<alt+x>`, f1–f12) via the `keys` arg or `<...>` tokens in data with PTY-aware Enter (`\r` vs `\n`), and lifecycle handling is hardened: SIGTERM-then-SIGKILL after a grace period on close, per-owner session caps, caller-requested session ids, Ctrl-D emulated as EOF on the pipe backend, fast-fail on immediate spawn errors, and honest until-timeout reporting instead of silent empty reads. (0d94280)

---

## 1.3.0

### Features

- **All sync targets reported in status and info** — `status` and `info` now iterate the platform registry and report opencode, pi, and dsh as separate sync targets, each with its own sync target dir, synced role count, skill symlink integrity, and (where the host offers a detectable mechanism) integration/registration status; JSON output gains a `targets` array (status) and `syncTargets` array (info) while the legacy top-level `opencode` field is retained for backward compatibility, and hints are registry-driven so only targets actually in use nag. (2310dfd)
- **Pi and dsh as CLI sync targets** — `rolebox sync` previously rejected any target other than opencode, so roles could not be deployed to the other harnesses; it now resolves through the PlatformPaths registry (pi → `~/.pi/agent`, dsh → `$DSH_HOME` / `~/.dsh`) and `uninstall` sweeps symlinks across every sync target, since a role may have been deployed to any harness. (60dd5d3)
- **Pi extension routed through the pi home directory** — The pi extension hardcoded `platformId: "opencode"`, so it borrowed opencode's config tree (`~/.config/opencode`) and never scanned the pi home (`~/.pi/agent`); it now routes through `piPlatformPaths` and honors pi's documented `PI_CODING_AGENT_DIR` override (blank treated as unset, like `DSH_HOME`). (43ff888)

### Bug Fixes

- **Silent notifications delivered immediately on Pi** — `noReply: true` mapped to `deliverAs: "nextTurn"`, and pi 0.84.2 buffers "nextTurn" messages into `_pendingNextTurnMessages` (injected only with the next user prompt), so every silent system reminder (graph node completed, stall, loop progress) surfaced only on a following turn; these now map to `deliverAs: "followUp"` with `triggerTurn: false`, which appends silently and immediately when idle. (ea2e8fd)
- **Native-separator skill filePath on Windows** — `resolveSkills` stored the forward-slash glob pattern as the resolved skill's `filePath`, but consumers use it for real fs access and path joins (dirname, symlink targets, Pi's `resources_discover`) that must agree with join-built native paths on win32; the pattern is now converted back to native separators via a new `toNativePath` helper before being stored. (43149a4)
- **dsh-web-client bundle built before CI test steps** — `dist/` is gitignored, so the dsh-client-modules seam tests (`tests/dsh-plugin.test.ts`) asserted a missing `dist/dsh-web-client.js` on fresh runners; CI now builds the bundle before running tests. (1e49e23)

### Refactors

- **Platform path resolution centralized** — `src/platform/registry.ts` becomes the single source of truth for host platforms, and factory/utils path resolution routes through `resolvePlatformPaths()`, replacing duplicated switch statements; unknown or omitted platform ids still fall back to opencode. (4048be4)

### Documentation

- **All three harnesses documented** — Adds a harness overview table (opencode / pi / dsh config dirs, role dirs, global skills, env overrides), a full pi extension setup guide, per-harness roles + directory layout sections, and updates the CLI sync reference and model-alias locations. (ff257d7)

### Tests

- **Hand-rolled workspace-cleanup retry in the pi-skills test** — bun's `rmSync` does not honor `maxRetries`/`retryDelay` (the options are parsed but never consumed), so recursive cleanup of the freshly-written test workspace still transiently failed with EBUSY/EPERM on Windows; the retry is now hand-rolled with `Atomics.wait` sync sleeps (runtime-agnostic), warning-and-leaking — not failing the suite — when a Windows AV/handle lock persists. (a990861)
- **CRLF-tolerant frontmatter parsing in the loop orchestrator test** — `loop.md` frontmatter parsing tolerates a CRLF checkout so the test passes on Windows. (ad892ef)
- **Windows EBUSY cleanup retry in the pi-skills test** — recursive workspace removal now retries with `maxRetries`/`retryDelay` to tolerate transient Windows EBUSY/EPERM on just-closed files. (767e663)

---

## 1.2.0

### Features

- **Role-scoped dispatch concurrency** — Composite concurrency keys (`roleId::model`) now resolve per-key limits from the owning root role's merged dispatch config, so each role's `maxConcurrent` / `syncReservedSlots` apply independently instead of sharing one model-level slot; role-scoped configs are rebuilt on every init (hot-reload included) and propagated into lifecycle deps and the concurrency manager. (d446b85)
- **Open-role cross-role dispatch** — A role.yaml can declare itself open (`open: true`, optional exports) and consuming roles declare `open_roles`, which injects an `<available_public_agents>` block into the consumer prompt so its orchestrator can dispatch graph nodes to the open role (or its exposed subagents) via `graph_add_node`; `src/resolver/open-roles.ts` resolves exports to full subagent ids and unknown exports warn rather than fail, with the schema fully backward compatible. (3ea2482)
- **DeepSeek Harness plugin platform** — Ships a Cordis object plugin entry (rolebox/dsh) that boots the full rolebox runtime on dsh services — role discovery, tool registration, graph dispatch, and loop mode — delivered as a dsh profile bundle; adds `dshPlatformPaths` (`$DSH_HOME` or `~/.dsh`), the dsh adapter suite (agent registrar, dispatch, event bridge, hooks, session, tool factory), and a `NodeDispatchPort` dispatch seam so the dsh path dispatches through `DshDispatchAdapter` while the opencode path stays byte-identical. (2b634a8)
- **Web role-switch adapter (loopback HTTP UI + REST API)** — Adds `DshRoleSwitcher` (per-session active-role state) and `DshRoleSwitchWebServer` (node:http, no new dependencies): a self-contained HTML page plus `GET /api/roles`, `GET/DELETE /api/roles/active`, and `POST /api/roles/switch`, all with a stable `{ ok: false, error }` non-2xx contract; wired into the plugin with `webEnabled` / `webHost` / `webPort` config keys (defaults false / 127.0.0.1 / 8787), with bind failure degrading to a warning. (39925d6)
- **Role-switch dock hydration, clear, and retry** — The dsh role-switch dock hydrates the session's persisted active role on mount and on every sessionId change so the highlight and status seat survive reloads and session switches, adds a clear-to-base row that resets the session to the base agent, and a Retry row that re-runs the last failed switch or clear; failed mutations preserve the previous active state and surface the server error on the status seat. (93482a7)
- **Session-level system-prompt contributions** — The main session now sees the switched role's system prompt: dsh composes the model-facing prompt from its systemPrompt registry, and rolebox registers into it via a new `DshSystemPromptAdapter` (rolebox:role section at order 50, rolebox:context at order 0), resolved per-session through the shared `ActiveRoleRef`; the seam is probed structurally and headless profiles warn-degrade and keep booting. (b6e6bac)
- **Active role applied to spawned subagents** — Subagent spawn requests now carry the parent/origin session id, and `DshAgentRegistrar`'s provider consults the shared per-session active-role holder at spawn time, prepending the active role's system prompt and applying its model override (plus the rolebox context block); absent a sessionId or active role, spawns fall back to the definition's own behavior. (e9eb14c)
- **Event-driven node liveness detection** — Heartbeat-based, tiered anomaly detection replaces sole reliance on wall-clock staleness timeouts: session error/gone events escalate a running node immediately, a `NodeLivenessMonitor` raises a single deduped `[GRAPH NODE STALLED]` warning after `stallWarnMs` without heartbeats, nodes stalled past the grace window escalate through the retry path, and the original `NodeStalenessWatcher` is retained as fallback; heartbeats flow from the platform event bridge through a `NodeLivenessFeed` DI seam, `graph_status` gains `include_liveness`, and all additions are optional (no feed ⇒ byte-identical behavior). (fd77f6a)
- **Pi shared hook pipeline, functions, skills, and tool surface** — The Pi extension reaches feature parity with the opencode plugin by routing through the shared rolebox pipeline: `hook-pipeline.ts` assembles the full `HookDeps` and routes `PiEventBridge.emit` → `handleEvent`, chat-activation runs `handleChatMessage` for `|fn|` activation and auto_activate, system-transform injects function/gate/role-memory/graph state into the before_agent_start prompt, tool-interceptor wraps every compiled tool with zod validation and custom-hook phases, skills are registered per role, and the surface is pinned by `tests/pi-parity.test.ts` (69-tool surface). (bd3e687)
- **Filesystem-backed session fork on Pi** — Pi's `fork()` now copies the source session's JSONL to a new id in the same workspace directory, optionally truncating at a given messageID, and returns a fresh `SessionInfo` with `parentID` set; previously it always returned null on Pi. (c23399a)
- **Live graph runtime threaded into the Pi service stack** — The live dispatchManager, graph-notify session client, and engine-state stateDir are passed into `PiLightweightServiceStack` so `graph_*` tools register on the Pi surface and engines persist state under `.rolebox/state`; absent a manager, the legacy stub/override-only surface is unchanged. (700cbca)

### Bug Fixes

- **Config-bearing primary role preferred** — With multiple roles declaring `mode: primary`, the old alphabetical-first pick silently discarded the config-bearing role's dispatch limits (e.g. ai-designer winning over emperor and leaving manager-wide concurrency at defaults); the first config-bearing primary in resolvedRoles order now wins, with a warning when multiple primaries exist. (68cc91f)
- **Per-parent cap lifted for graph node dispatch** — `graphParentContext` now carries `maxActivePerParent: Infinity`, and the task-launcher derives the per-parent cap from the context: a graph's nodes all share `parentSessionId = graphId`, so the dispatch config's per-parent default (3) throttled them merely for sharing that parent, while node concurrency is actually engine-managed. (01c9efa)
- **False-positive node liveness stalls fixed** — The event-driven liveness monitor hard-stalled healthy nodes: dispatched subagent activity never refreshed `lastActivityAt`, so any node running past the 90s warn+grace deadline was escalated and timed out; child-process activity is now relayed as throttled heartbeats, a liveness feed is threaded into the opencode `GraphToolSet`, and a dispatch-liveness probe refreshes quiet-but-alive subagents while hung-but-alive nodes still fall to the wall-clock backstop. (31fe435)
- **Graph engine dispatch and recovery hardening** — A throwing `executeNode` now marks the node terminal (timeout/escalate) while the remaining frontier still dispatches; unhandled promise rejections are eliminated via contained critical sections and caught advancement sites; `graph_run` failure is atomic (no double dispatch, no ghost `[GRAPH COMPLETE]`); state-file hydration is total (invalid v2 files return null and surface in the startup sweep instead of poisoning recovery); and a dangling loop group is closed by clearing `loopGroupId` when the declaration dropped the group. (5a204c8)
- **Graph-engine stall paths eliminated** — Six fixes close windows where a graph could stay in `executing` without advancing: dispatch-layer HITL statuses are bridged into the pausing `need_approval` signal so `[GRAPH BLOCKED]` fires, the runtime deadlock guard is relaxed for never-activatable incoming edges, the stale-node watcher (15 min) and stale-lock sweeper (60 s) are enabled by default, and silent graph-notify no-ops become explicit degradation warnings with a durable `notification_degraded` event marker. (34045e9)
- **Observability overhaul to reflect real engine state** — Fixes the monitor gaps from the engine observability audit: recovery engines gain notification/event seams, checkpointHistory survives hydrate/adopt, `cancel()` is no longer silent, graph notifiers retry 3× instead of being single-shot, node-level `budget.timeout_ms` reaches dispatch tasks, an opt-in `NodeStalenessWatcher` guards zombie running nodes, engine rebuilds dispose orphaned listeners, snapshots deep-clone signal/loop state, json graph view honors `include_output` and pagination, and silent escalations now emit node-completion events. (55e7dfd)
- **Auto-continue counter stopped while graphs execute** — After a non-blocking graph_run, session.idle saw zero dispatches (graph nodes parent to graphId, not the emperor session) so auto-continue fired on every idle and the counter climbed; `GraphToolSet.hasInflightGraphsForSession()` now suppresses auto-continue while the session owns an executing graph, a shared `GraphToolSet` is threaded into `HookDeps` on both assembly paths, and `signal_observed` falls back to `sessionSignalLedger` when the per-function ledger misses. (5b026a5)
- **LSP PATH lookup fallback when Bun is absent** — `Bun.which` is Bun-only, and dsh/pi load the LSP module in a Node.js process without a Bun global; the lookup is now guarded on the Bun global and falls back to a portable PATH+PATHEXT walk, matching the `isBunRuntime()` pattern in `src/memory/db-driver.ts`. (2acb049)

### Refactors

- **Loopback web server replaced with host route + browser client** — The self-contained loopback HTTP server (node:http) is replaced with a prefix route registered on dsh's own host webserver through the optional `webServer` seam, plus a browser `dsh.client` slot plugin that mounts a role-switch dock into `conversation.input.dock`; the REST surface is renamed `/api/*` → `/rolebox/*`, the client is bundled as a CJS ModuleLoader envelope (id `rolebox/dsh`), and the `webEnabled` / `webHost` / `webPort` config keys are removed — the web UI auto-mounts in the web profile, headless profiles register no routes. (f8c5482)

---

## 1.1.0

### Features

- **Narrow-sidebar layout module with truncation helpers** — Adds a pure `src/tui/layout.ts` module (no opentui/solid or solid-js imports) as the single source of truth for narrow-sidebar layout constants and helpers: `SIDEBAR_WIDTH=40`, `RULE_WIDTH_NARROW=28`, `INDENT`, `GLYPH_CELLS=1`, `VALUE_BUDGET=22`, plus `valueBudget()` and `labelValue()` that compose dimmed `label: value` rows and truncate long values to a `SIDEBAR_WIDTH`-derived budget. Ships `tests/tui/layout.test.ts` covering both helpers and edge cases (zero/negative budget, exact-fit, and overflowing values). (9c0468f)

### Bug Fixes

- **Graph `graph_run` idempotency for completed graphs** — A redundant `graph_run` (no `node_id`) on an already-complete graph now short-circuits (phase Complete, no Ready/Running/Blocked/Pending node), returning the current status instead of rebuilding a fresh engine and re-firing `[GRAPH COMPLETE]` on every re-run; targeted retry (`node_id` + `retry`/`modify_prompt`) stays exempt and still fires exactly one new COMPLETE. Also reuses the graph-create-captured sticky invoking-session id across mid-flight rebuilds so the graph-notify emperor-session resolver never degrades to a no-op seam. (60f19df)
- **Loop-convergence forwarding, self-loop re-entry, and non-loop cascade-cancel** — Answer forwarding now depends on loop outcome: `_forwardActivation` only runs when the loop step outcome is `converged`, so a downgraded answer (revising/stuck/max-traversals-exhausted) no longer wrongly forward-activates downstream nodes while the loop is still churning. `_forwardActivation` skips self-loop edges so a single-point always self-loop can never re-enter itself even when built bypassing validation. Non-loop fan-in now cascade-cancels still-pending sibling upstreams (mirroring the loop-group executor), guarded by a shared-upstream check so an upstream still needed by another unresolved downstream is never retired. (1213f1e)
- **Ready→escalate transition and frontier cleanup** — The budget pre-check in `_dispatchNode` calls `markEscalated` on a Ready node before `markRunning`, but `ready → escalate` was not a legal transition, so an over-budget graph threw `Invalid node transition: ready -> escalate` and stranded the node in Ready. `ready` now allows `[Running, Cancelled, Escalate]`, and an escalated budget-exceeded node is removed from the frontier so it does not linger as a stale ready entry. Adds a legal-transition assertion and a regression test. (1e3483e)
- **Runtime deadlock detection for rootless/unprotected graphs** — A graph where every node has in-degree ≥ 1 and no loop-group protection used to provision with an empty frontier, dispatch nothing, and sit in Executing forever because `checkGraphTermination` tallied Pending nodes as scheduler-active. It now separates Ready/Running from Pending and adds a deadlock terminal: an Executing graph with pending node(s), no Running/Ready/Blocked node, no escalated/timeout error, and an empty `pendingCompletions` queue escalates every pending node (`graph deadlock: no active upstream can satisfy pending node(s)`) and completes. Negative tests confirm no false trigger on normal or blocked graphs. (f2447da)
- **Validator loop-group root alignment with the engine + overlap rejection** — `checkLoopGroupRoots` now applies the same intra-loop-group always-edge exclusion as the engine's `computeInDegrees`/`getRootNodeIds` (inline helper, respecting the no-import-from-engine layering rule), so always-cycle loop groups are accepted instead of being misrejected as unreachable deadlocks. A new fatal `checkLoopGroupOverlap` rule rejects any node appearing in more than one loop group, surfacing the single-slot `loopGroupId` overwrite ambiguity. (7a5beef)
- **Dispatch liveness and in-flight-tool guards against false terminal/idle states** — The completion detector evaluates the tool-in-flight guard before idle/error/completed decisions so a transient error or stale status never latches a terminal result while a model tool is still running. The completion evaluator re-verifies session liveness (existence + status + recent message activity) before committing an error/deleted/fetch-failure transition and cancels the idle debounce when a tool is in flight. Engine recovery/advance skip a stale `error` escalate when the authoritative task read still shows the task live (running/pending/awaiting_approval) and re-subscribe so a genuine later termination still advances the node. Pi adapters return `busy` (not idle) while the last message has a pending/running tool part; monitor + TUI derive the effective engine phase as executing whenever any node is running, eliminating false idle/running flicker. (d491090)
- **LSP `Bun.which` PATH lookup** — The LSP server-binary PATH lookup now uses `Bun.which` to silence Windows stderr noise. (bff4377)
- **CI frozen-lockfile install** — CI now installs with `--frozen-lockfile` and the stale `bun.lock` is refreshed. (03e8545)
- **Windows portability fixes** — Resolves 161 Windows-only test failures while keeping macOS/Linux green: skill-resolver joins no longer produce backslash patterns that never match fast-glob's forward-slash match set (skills now resolve on win32), `getDataDir`/`getConfigDir` honor `XDG_*` on the win32 branch, the document manager emits RFC-8089 file URIs (drive-letter colon no longer percent-encoded), frontmatter parsing normalizes CRLF bodies, quarantine derives dest filenames from backslash paths correctly, and directory symlinks are created with an explicit type to avoid EPERM on un-elevated win32. Adds shared helpers (`toPosixPath`, junction-aware `createDirSymlink`/`createFileSymlink`/`isSymlink`) and platform-neutral test hardening. (bbe8309)
- **Windows skill resolution and symlink portability** — `resolveSkills` normalizes candidate patterns via `toPosixPath` before passing them to fast-glob (which only officially supports forward-slash patterns), so skills no longer resolve to nothing on win32 and `<available_skills>` blocks plus subagent skill symlinks are preserved. Win32 junction/file symlink targets are normalized to native separators with `path.win32.resolve`, and win32-hardened test fixtures are added. (7bafd04)
- **Test-module isolation against shared-process mock leakage** — A plain `bun test` run (no `--isolate`) shares one module registry across files, and `mock.module` has no un-mock API, so a prior file's paths/registry-client mock shadowed the real modules for later files (23 failures). Real modules are now loaded through cache-busted `?real` query-string specifiers in the paths mock helper, `paths.test.ts`, and `install-realtime.test.ts`; the full suite passes 0 failures under both commands. (e3114f8)
- **TUI sidebar-state tsc fixes** — Resolves four pre-existing type errors in `src/tui/state.tsx` surfaced by the TUI typecheck gate while validating the narrow-sidebar redesign: `new Set<string>()` (TS2769), `LoopSnapshot.fnName` cast to `{ fnName?: string }` (TS2339), `dispatchSummary.errors` → `dispatchSummary.error` matching the `DispatchSummary` field (TS2551), and `createSidebarRenderer` ctx typed as `TuiSlotContext` with `tc()` casting `ctx.theme.current` to `ThemeColors` (TS2769). (9b52659)

### Refactors

- **Vertical-stack narrow-sidebar layout and 1-cell glyphs** — The TUI is restructured for opencode's sidebar slot so information stacks vertically (one primary fact per row; secondary facts move to dimmed, indented rows with lowercase `label: ` prefixes; long values truncated via the new layout module): `renderDispatchRow`/`renderFunctionLine` become primary glyph+agent rows with secondary duration/liveness, description, progress stage, and session rows; graph/engine renderers list one node per row with iteration, `terminationReason`, `liveSignal`, and budget on their own rows; the loop line splits into an agent row and an N/M + bar progress row; the header rule width narrows to `RULE_WIDTH_NARROW` (28); pulse concurrency active/limit and queue depth move off the health line onto a dim secondary row; TaskDetail splits status into glyph+agent/duration/liveness and `[← Back]` becomes `[Back]`; MetricsPanel/RecoveryStatus/FilterBar split into one-fact-per-row. All status glyphs shrink to a single display cell (no wide/emoji/arrow glyphs): `G_RUNNING ▸→•`, `G_PENDING ●→·`, `G_GATED ⏸→·`, `G_SUB └─→·`, `G_STALLED ⚠→!`, `G_FN` dropped (function lines convey state via color). (7e34e6d)

### Tests

- **Environment-dependent test gating** — LSP auto-detection tests are gated on `typescript-language-server` availability and real-server integration tests on the opencode binary (new `hasOpencode` helper mirroring `hasTar`), so the CI suite passes on runners without developer-machine binaries; the fetch-failure escalation test is de-flaked by replacing a never-resolving messages mock with an immediate `TimeoutError` rejection. (db060e1)
- **Test-file isolation under `bun --isolate`** — The core suite now runs with `--isolate` so each test file gets a fresh module registry, making cross-file `mock.module` leakage structurally impossible. The `@opentui/core`-dependent TUI leg is split into a separate non-isolated CI step (it performs a top-level await that fails under `--isolate`), with order-independence guards and randomized-order fuzz legs added; the `test` script chains `test:core && test:tui`. (d93f7a4)
- **Drop cache-busted module imports** — With `bun test --isolate` guaranteeing a per-file module registry, the cache-busted dynamic imports that existed to bypass `mock.module` leakage are replaced with plain static imports of the real modules; the now-redundant paths mock re-registration and `afterEach` restore logic is removed, and `paths-mock.ts` becomes a simple static-import full-surface factory. (c8bfb62)
- **CLI cache test fresh `Response` per fetch** — A `Response` body can only be consumed once; a single hoisted Response made the TTL cache test fail for the wrong reason if the cache ever missed on the second fetch. The test now builds a fresh `Response` per fetch call instead. (e40917c)
- **Order-independent signal-session-survival tests** — The module-level `sessionSignalLedger` is a shared singleton; each test now uses its own session ID and records exactly the signals it asserts on, so no test reads state written by a sibling test. The block is now order-independent under `bun test --randomize` (intra-file test-order shuffling). (e887b21)

---

## 1.0.0

### Breaking Changes

- **v1 graph subsystem decommission** — The v1 graph execution subsystem is removed. `src/graph/parser.ts` is deleted and the `advance` / `state` / `graph-store` / `converter` / `parser` / `validator` modules are ported into `collaboration-*` modules (`collaboration-advance` / `collaboration-state` / `collaboration-store` / `collaboration-bridge` / `collaboration-validator`), persisted to the new `collaboration-{hash}.json` state path. The orchestrator, migration, and termination-conditions consumers are re-pointed, the v1 barrel re-exports are removed, and 22 test files are migrated off v1 imports. See `docs/graph-legacy-v1-decommission.md`.
- **Graph-first orchestration / tool-surface consolidation** — Subagent collaboration now routes through the v2 graph engine (`graph_create` / `graph_add_node` / `graph_run`). The bare model-facing `dispatch_*` / `loop_*` tools and the checkpoint / budget / concurrency / query suites are retired in favor of a thin `task_*` compatibility layer (`task-tools.ts`), and the `function_state` tool is removed. Graph orchestration enforces budget accounting, approval gates, and loop caps on every dispatch.

### Features

- **Graph Execution Engine v2** — A new `src/graph/engine/*` subsystem implements node lifecycle, join evaluation (`any` / `quorum` / `all`), condition resolution, signal propagation, cascade cancellation, node retry, an approval handler, a loop-group executor, and engine persistence / recovery / startup. Added the v1→v2 converter, `parser-v2`, `serialize`, and `validator-v2`, plus the imperative `graph_*` toolset (`graph_create` / `graph_add_node` / `graph_add_edge` / `graph_add_loop` / `graph_run` / `graph_status` / `graph_cancel` / `graph_approve`) backed by `graph_status` flags and the `JoinStrategy` / `EnginePhase` / `NodeStatus` constants. See `docs/graph-engine-architecture.md`.
- **Graph monitoring (engine write-side event log)** — The graph execution engine now records an append-only, durable NDJSON event log (`graph-events-{hash}.ndjson`) for every write-side transition it performs — node dispatch, node terminal transition (`answer` / `revise_needed` / `escalate` / `timeout`), engine phase change, and cumulative budget update. `GraphEventRecorder` is a total (never-throws), no-op-safe seam: with no `stateDir` configured no recorder is constructed and the engine behaves exactly as before. The recorder's phase/budget sinks are registered on construction so the engine's pure transition functions reach it without an import cycle.
- **Graph terminal notification seam** — The engine exposes an `onGraphTerminal` callback that fires exactly once per terminal transition (`GRAPH COMPLETE` / `GRAPH BLOCKED`), wired through a `graph-notify` platform seam that injects `<system-reminder>` markers into the orchestrator session to wake result collection. Per-node completion is surfaced through the engine node-completion seam and notifier.
- **Engine v2 signal-ledger origin tracking and two-tier persistence** — Engine state records a signal-ledger origin-source discriminator and terminal-state dedupe, persists via a debounced non-critical save plus flush-on-terminate (two-tier durability), captures per-node usage at termination paths, and re-uses the live runtime mid-flight in `graph_run`.
- **Prior-state adoption for incremental graph rebuild** — `adoptPriorNodeStates()` copies a prior engine run's per-node progress onto a freshly provisioned state so the imperative `graph_*` toolset can rebuild the engine after every mutation without resetting completed/running nodes; `EngineRuntime.adoptPrior()` reconciles adopted running nodes against the dispatch system and replays answer forward-flow.
- **Bounded backstop and node result capture for gated functions** — `signal(type="blocked")` sets a `blockedAt` + default 2-minute timeout that force-unblocks on expiry, and dispatch notifications / HITL approvals reset gated functions to active; `_captureNodeResult()` reads the dispatch task result onto node runtime state after completion (`answer` / `revise_needed` / approval paths).
- **Data-mapping fields include-whitelist** — `DataMapping.fields` adds a top-level JSON key include-whitelist (`keepJsonKeys`) applied before the existing exclude/key-stripping transform during edge data passthrough.
- **Terminal-state checker extraction** — Terminal-state detection is extracted into a shared `engine-termination` module with an exposed `resetTerminalDedupe`, consolidating COMPLETE/BLOCKED firing logic.
- **Monitor reads engine graphs and graph events** — `monitor` now surfaces the engine (v2) persisted state (`engine-*.json`) as rich `EngineGraphSnapshot`s (phase, per-node lifecycle, budget, frontier, loop groups, checkpoints) via `readEngineGraphs`, and reads back the last N graph events from the event log via `readGraphEvents`. Both are wired unfiltered into `MonitorSnapshot` (`engineGraphs` / `graphEvents`) — engine graphs are multi-agent primitives whose `graphId` never equals a dispatch task's `sessionId`, so the legacy live-session filter is deliberately not applied to them.
- **CLI Graphs panel and TUI sidebar activity** — The monitor renderer gained a `Graphs` panel (phase glyph, per-status node counts, budget/frontier, and recent node signals correlated by `graphId`), emitted between Orchestration and Tasks. The TUI sidebar surfaces engine-graph activity with per-node status glyphs, live signal from graph events, and cumulative budget, plus an incremental `GraphEventPoll` that maps NDJSON event lines onto `graph_node_start` / `graph_node_end` / `graph_signal` events with a monotonic per-file offset (no double-emits, no re-reads). `GraphNodeSnapshot` exposes `dispatchTaskId` / `dispatchSessionId`, and the TUI session scope is supplemented with engine-graph dispatch session IDs.
- **Loop tree-worker infrastructure** — The loop coordinator gains ancestor-chain prompt-fingerprint dedup, a `MAX_TREE_WORKER_SESSIONS` (30) registration-time budget, recursive `cancelNow()` cascade to child loops, a `CONSECUTIVE_STALE_THRESHOLD` (2) stall guard, and new `LoopState` fields (`objective`, `promptFingerprint`, `parentLoopId`, `consecutiveStaleRounds`).
- **Loop store v3 with backward compatibility** — The loop store accepts schema versions 1–3 (was strict v1), auto-migrates v1/v2 records by filling absent optional fields, and persists the new v3 fields.
- **`loop_start` and loop management tools** — `loop_start` (renamed from `createLoopTool`) gains required `prompt` / optional `objective` args and is registered as a canonical tool, alongside `loop_status` / `loop_output` / `loop_history` / `loop_list` management tools wired into `ToolService` with graceful degradation when `LoopService` is unavailable.
- **Pi 0.81.x JSON event vocabulary + loop integration** — `process-session` handles the Pi 0.81.x event vocabulary (`message_start` / `update` / `end`, `turn_end`, `tool_execution_*`) and drives completion from `turn_end` instead of process exit (fixing indefinitely-idling children); the loop coordinator is wired into the Pi extension with persistence, recovery, lifecycle handlers, `/stop-loop`, and child model resolution.
- **In-session role switching via `/role`** — Pi (which has no native agent picker) now surfaces rolebox roles as switchable primary agents via a `/role` command, selector UI, and `Ctrl+Shift+R` shortcut, gated by the `hasRoleSwitch` capability and driven by the `AgentDefinition` registry.
- **Active-agent ref for dispatch direct-child gate** — A shared mutable `activeAgentRef` bridges Pi's platform model (which never populates `context.agent`) to the dispatch tool's direct-child gate; it is seeded from `ROLEBOX_ACTIVE_AGENT` and passed as an external `getEffectiveAgent` resolver so nested sub-agent dispatch resolves correctly.
- **Session-level signal ledger** — Signals recorded by `signal-tool` now survive even in bare subagent sessions with no active functions via `SessionSignalLedger`; completion evaluation and engine recovery fall back to the ledger, and a `SYNTHETIC_ANSWER_SIGNAL` marker distinguishes framework-generated signals from real sub-agent signals.
- **Centralized signal constants** — The signal-type vocabulary (`SIGNAL_TYPES`, `TERMINATING_SIGNALS`, `PAUSING_SIGNALS`, `HANDOFF_SIGNALS`, `INFO_SIGNALS`, `SignalType`) is extracted into `src/signal/signal-constants.ts` as a single source of truth shared by `signal-tool` and the engine signal bridge.
- **Platform-agnostic memory db driver + async factory** — `MemoryStore` is refactored to a static async `create()` factory behind a `DatabaseDriver` interface (Bun uses `bun:sqlite`, Node uses `node:sqlite` via dynamic import), with `zod` as an explicit dependency; all callers (7 CLI memory commands, context-assemble, system-transform) are converted to the async pattern.
- **Platform-agnostic fs utils** — New `readTextFile()` / `fileExists()` helpers in `src/utils/fs.ts` backed by `node:fs/promises` replace `Bun.file()` callers, `Bun.hash()` is replaced with `node:crypto` `sha1`, and `Bun.spawn` / `Bun.which` are replaced with `node:child_process` in the registry client, ensuring cross-runtime portability.
- **`rolebox migrate` CLI command** — A new `migrate` command backed by the registry client for running migrations.
- **Install/update progress output** — `rolebox install` and `rolebox update` now emit live download progress (`DownloadProgress` renderer): named phases (`resolving` / `downloading` / `verifying` / `extracting` / `installing` / `done`) with a determinate byte-progress bar on interactive TTYs (via `response.body` streaming) or throttled plain lines in degraded mode (non-TTY, `CI`, `TERM=dumb`). New `--quiet` / `-q`, `--verbose` / `-v`, and `--no-progress` flags on both commands, honoring `NO_COLOR`. See `docs/audit-progress-ui.md`.
- **Role path / env overrides** — `getDataDir` / `getConfigDir` now honor `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` env overrides ahead of platform defaults, with explicit win32 (`%LOCALAPPDATA%` / `%APPDATA%`) and darwin branches, plus writability pre-checks (`ensureWritableDir`) that fail with an actionable message. `roleId` / `registry` / `version` are validated by `assertSafePathSegment` (rejects path separators, `..` traversal, leading dots, Windows-invalid characters and reserved device names), closing the arbitrary-delete/traversal vector into `rmSync`. See `docs/audit-install-update-platform.md`.
- **Hardened download + atomic install** — `downloadRole` now streams the tarball to disk with a per-attempt timeout (`AbortController`) and bounded retry with exponential backoff, detects truncated bodies via `Content-Length`, and validates extracted entries against zip-slip / path-traversal escaping the extract dir. Install/update extract into a temp location first and atomically swap into place (with rollback: a failed new-version install leaves the previously-installed version and lock intact). Manifest-declared integrity digests are now verified when present. See `docs/audit-install-update-platform.md`.
- **CI platform matrix** — `.github/workflows/ci.yml` now runs the typecheck + TUI build + `bun test` suite across `[ubuntu-latest, macos-latest, windows-latest]` (previously ubuntu-only). Real-tar tests skip gracefully via `hasTar()` on hosts without `tar`.

### Bug Fixes

- **Dispatch fast-fail on null prompt result** — A `null` return from `client.prompt()` (Pi spawn failure) now transitions the task to `error` immediately — releasing the concurrency slot, notifying the parent — instead of leaving it `running` forever; the opencode session adapter's HTTP 204-void contract is corrected so a successful async prompt is no longer misread as a spawn failure.
- **Pi dispatch completion through the event bridge** — Synthetic `session.idle` / `session.error` events are emitted on Pi child-process exit / spawn failure so the dispatch completion pipeline triggers immediately instead of waiting for the watchdog timeout.
- **Terminating signals preserved across dispatch→engine bridge** — Real signal types (e.g. `revise_needed`) from loop-group sub-agents are now passed through the dispatch→engine bridge instead of being collapsed to `completed`, so loop back-edges keyed on `revise_needed` activate correctly.
- **Loop entry deadlock from revise back-edges** — `join-evaluator` excludes revision back-edges from in-degree on the first loop-group traversal so a loop entry node with only a `revise_needed` back-edge satisfies its join instead of deadlocking.
- **Always-edge loop-group traversal bound and pure-cycle deadlock** — Always-edge re-entries in a loop group consume a traversal (escalating at the cap), intra-loop-group always-edges are excluded from in-degree during provisioning so pure cycles (A⇄B) no longer deadlock, and `__inferred` synthetic answers prevent downgrade to `revise_needed` infinite spin.
- **Graph lifecycle robustness** — `provision()` routes root nodes through `markReady`, retry records a checkpoint before resetting downstream nodes, `Cancelled→Done` transitions use `markDone`, approval replay returns `already_resolved` with `actualStatus`, and `adopt-prior` re-runs in-degree reconciliation to demote stale-ready nodes.
- **Loop `Done` status for termination** — Loop-group termination paths (`max_traversals` exhausted, stuck) use `markDone` instead of `markEscalated`, giving clean Done/Done separation, with per-node traversal counting for diagnostics.
- **Memory/fs semantics** — `MemoryStore` `run()` spreads zero-arg params, and `fileExists` rethrows on unprobeable paths instead of silently reporting `false` (only `ENOENT` means absent).
- **Memory delete non-interactive confirmation** — `rolebox memory delete` requires `--yes` when stdin is not a TTY instead of blocking on `prompt()`.
- **Timer `unref` to prevent event-loop hang** — All guard/heartbeat/sweeper timers (watchdog, health monitor, coordinator, budget sampler, completion orchestrator, progress store, throttle) use a safe `unref()` pattern compatible with Node.js and Bun.

### Refactors

- **v1 graph → collaboration module port** — v1 execution semantics are ported into `collaboration-*` modules under a new `collaboration-{hash}.json` path, with consumers, the orchestrator, migration, and termination-conditions re-pointed and v1 shims removed.
- **EngineState threaded through lifecycle** — `EngineState` is threaded through the graph lifecycle with dirty-flag persistence, and convergence stuck-detection is consolidated into `propagateRevise`; event sinks move from module globals to `EngineState` instance fields, and `materializedAt` changes from ISO string to epoch ms.
- **Memory async factory refactor** — All `MemoryStore` callers migrate from synchronous `new MemoryStore()` to the async `MemoryStore.create()` factory, and the memory clean command switches its direct SQL query to the cross-runtime `createDatabase()`.
- **TUI error-logging cleanup** — Empty catch blocks in the TUI event bridge are replaced with `console.warn` logging so headless-mode failures are diagnosable.

### Documentation

- **Graph Engine v2 architecture** — Added `docs/graph-engine-architecture.md` documenting the v2 engine design, two-tier persistence, and recovery.
- **v1 graph decommission** — Added `docs/graph-legacy-v1-decommission.md` covering the v1 subsystem removal and the `collaboration-*` migration.
- **Subagent `graph_run` instructions** — Subagent guidance updated to describe `graph_run` as non-blocking: dispatch ready nodes, end the turn, and await the `[GRAPH COMPLETE]` / `[GRAPH BLOCKED]` system-reminder before reading results via `graph_status`.

### Tests

- **Graph terminal notification end-to-end** — Added `tests/graph/engine-terminal.test.ts` verifying the `onGraphTerminal` seam fires exactly once per terminal type with correct `graphId` / phase / node-status summaries.
- **Graph monitoring end-to-end chain** — Added a cross-cutting integration test (`tests/monitor/graph-monitoring-chain.test.ts`) driving the real write-side primitives (`GraphEventRecorder` + `EnginePersistence`) through the full pipeline: readers (`engineGraphs` / `graphEvents` snapshot fields) → `renderHuman` Graphs panel → TUI `GraphEventPoll` and `computeFilteredActivity`.
- **Loop integration updates** — Integration tests updated for same-origin loop exclusivity semantics (nested-loop rejection → `loop already active for this session`).
- **Memory async factory tests** — Memory test helpers and setup blocks converted to the async `MemoryStore.create()` pattern.
- **Real download/extraction coverage** — Added `tests/cli/commands/install-realtime.test.ts` exercising the real (non-mocked) `downloadRole` → `tar xzf` → atomic-place path through `install()`, plus new win32-branch unit tests for `paths.ts` (`%LOCALAPPDATA%` / `%APPDATA%` resolution and `getRolePath` sanitization under a simulated platform via the `getPlatform` / `setPlatformForTest` seam). Real-tar tests across `registry-client.test.ts`, `download-progress-streaming.test.ts`, and the new command-level test are guarded by `tests/helpers/tar.ts` and skip gracefully on hosts without `tar`.

### Resolved vs deferred audit gaps

The `install`/`update` cross-platform and progress audits are substantially addressed. Resolved: download timeout + retry + streaming (F4.1, F4.2, F4.3), zip-slip-safe extraction validation (F4.5), temp-dir leak cleanup (F4.6), atomic install with rollback (F4.7), `ROLEBOX_DATA_DIR` / `ROLEBOX_CONFIG_DIR` overrides + writability pre-checks (F2.1, F3.1, F3.2), roleId/registry sanitization (A4, F4.9), macOS path branch (F1.1), the CI platform matrix (F5.1), and the Windows path-branch test coverage (F5.3). Deferred: verifying a computed integrity against a previously-pinned lock value on update (F4.4 — computed digests are recorded and compared against manifest-declared values only), and a Windows symlink copy-fallback for `sync` (F2.3 / A11). Full findings and severities: `docs/audit-install-update-platform.md` and `docs/audit-progress-ui.md`.

---

## 0.24.0

### Breaking Changes

- **`task_*` → `dispatch_*` tool rename** — All dispatch introspection tools renamed: `task_search` → `dispatch_search`, `task_status` → `dispatch_status`, `task_output` → `dispatch_output`, `task_concurrency` → `dispatch_concurrency`, `task_chronology` → `dispatch_chronology`, `task_export` → `dispatch_export`, `task_budget` → `dispatch_budget`, `task_graph` → `dispatch_graph`, `task_retry` → `dispatch_retry`. Old names preserved via deprecation aliases.

### Features

- **Priority scheduling and HITL approval gate** — Dispatch tasks now support priority-based scheduling. Human-in-the-loop approval gate: workers signal `need_approval`, tasks pause in `awaiting_approval` state, emperor can `dispatch_approve` or `dispatch_reject`.
- **Dispose lifecycle and O(1) inflight wiring** — New `dispose()` lifecycle method on dispatch manager for clean shutdown. Inflight tracking refactored from O(n) scans to O(1) `inflightByParent` map lookups.
- **Signal tool wired into function state machine** — The `signal` tool now integrates with the function state machine, enabling signal-based state transitions (`answer`, `revise_needed`, `need_approval`, etc.).
- **Model alias fallback resolution** — Resolver now supports model alias fallback at load time, allowing roles to reference model aliases that resolve to concrete models.
- **JSON output format for query/search tools** — `dispatch_search`, `asset_search`, `reference_search`, `memory_recall`, and `session_search` now support a `format` parameter (`markdown` or `json`) for machine-parseable output.

### Performance

- **Incremental hot-reload with change classification** — Hot-reload now classifies file changes and only rebuilds what changed, avoiding full reloads on minor edits.
- **Streaming sidecar result windows** — Large dispatch results are now streamed from disk in windows instead of loading entirely into memory.
- **Batch fast-glob and parallel subagent resolution** — Resolver batches `fast-glob` calls and parallelizes subagent resolution for faster startup.
- **Asset search index cache** — Asset search results are cached with async file check and LRU guard, eliminating redundant filesystem scans.

### Bug Fixes

- **Stale lock recovery and error suppression** — Resolved stale lock recovery blocking, silent error suppression, and continuation rollback issues in core services.
- **Loop deadlock prevention** — Added 30s lock sweeper for `_advancing` deadlock prevention in loop coordinator.
- **Parent-task index and budget persistence** — Added parent-task index, fixed budget persistence across restarts, and debounced loop store writes.
- **Checkpoint FIFO cap and serialization** — Fixed checkpoint FIFO cap enforcement, incremental `readOriginSummary`, and serialization edge cases.
- **Abort worker sessions and concurrency queue** — Fixed abort handling for worker sessions and concurrency queue promotion logic.
- **Path-traversal, recursion guard, dead params** — Hardened `dispatch_*` tools against path traversal, added recursion guard, removed dead parameters, and added security tests.
- **EXDEV cross-device rename** — Fixed `EXDEV` cross-device rename errors in CLI install/update by using copy+delete fallback.
- **Postinstall guard for CI** — Guarded postinstall script against missing `dist/` directory in CI environments.

### Refactors

- **Platform abstraction updates** — Extended platform ports with model/compact interfaces, added event bridge, updated adapters. Decoupled core services from SDK types via event canonicalization. Updated recovery, resolver, and utilities for platform abstraction.
- **Deprecation infrastructure** — Added deprecation infrastructure for tools, removed old aliases, improved tool descriptions.

### Documentation

- **README restructure** — Restructured README for readability and added demo GIFs.

### Tests

- **Platform abstraction tests** — Updated test suites for platform abstraction changes.

---

## 0.23.2

### Bug Fixes

- **README banner image** — Use HEAD ref for banner image to support all branches.

---

## 0.23.1

### Bug Fixes

- **CLI package.json path** — Resolve package.json path from correct depth in compiled binary.

---

## 0.23.0

### Features

- **TUI mouse interactions** — Click-to-select sessions, task rows, and filter options in the monitor. Keybindings updated to `Ctrl+` prefix to avoid conflicts.
- **TUI filters, metrics panel, and live event bridge** — New filter bar (session ID, status, agent), real-time metrics panel, and event-driven live updates in `rolebox monitor`.
- **Dispatch checkpoint and progress** — New checkpoint persistence (`dispatch_checkpoint`) and progress reporting (`dispatch_progress`) tools integrated into lifecycle hooks. Progress data displayed in both CLI and TUI. Failed tasks can be retried with checkpoint context automatically injected.
- **Project-level config** — `rolebox` now loads `.rolebox/config.json` from the project root to set a default role per project.

### Bug Fixes

- **SSRF guard improvements** — Block link-local (`169.254.x.x`) addresses in `web_fetch` in addition to existing private/localhost blocks. Applied to `web_read` (page-read tool) as well.
- **Loop idle bridging** — Replace poll-based idle detection with push-chain driven by `onTaskTerminated` event, eliminating the polling window between loop rounds.
- **Hot-reload stability** — Break infinite self-triggering loop and eliminate `EEXIST` symlink errors during asset reload.
- **Function merging** — Merge role-defined functions with built-in defaults instead of replacing them, preserving default capabilities when roles specify custom functions.
- **Memory validation** — Validate `category` and `relevance` fields in `memory_write` and `memory_update` with Zod enum at runtime instead of accepting arbitrary values.
- **Dispatch error hardening** — Robust error handling in sync dispatch and dispatch output tools; log watchdog errors and clean up emitted thresholds when a task leaves.
- **Dispatch adapter** — Accept configurable directory path in `DispatchAdapter` constructor instead of hard-coding.
- **TUI** — Restore missing `onCleanup` closing brace accidentally dropped during refactoring.
- **Core reliability** — Fix cleanup and race-condition gaps across dispatch, loop, signal, and notification subsystems.

### Refactors

- **Hashline engine** — Per-file content-hash versioning, hashWidth auto-escalation based on line count, trailing newline preservation, and exact-match echo for better editing stability. New `src/shared/hashline/` module.
- **TUI layout** — Compact activity rows (dense session layout), reduced filter bar to 2 lines, inline session IDs to save vertical space.
- **TUI keyboard removal** — Remove all keyboard interaction code, replaced by mouse-click interactions.
- **Codebase coupling** — Reduce coupling and duplication across dispatch, monitor, and tool registration for improved maintainability.

### Tests

- **Full lifecycle integration test** — End-to-end `pi` (plan-incomplete) scenario covering plan creation, partial execution, checkpoint, and cross-session resume.
- **Dispatch, graph, and loop edge cases** — Coverage for checkpoint and progress unit/integration tests, dispatch notification recovery, graph visualization edge cases, and loop coordination.
- **Integration tests** — End-to-end tests for dispatch, loop coordination, signal tool, and cross-session behavior.
- **Hooks pipeline** — Test coverage for the hooks/lifecycle pipeline.
- **Core services, CLI, LSP, and session** — Coverage for core service initialization, CLI command parsing, LSP integration, and session lifecycle.
- **Asset tools and validation** — Test coverage for asset inspection, search, validation, and hot-reload.
- **Web tools** — Test coverage for web fetching and reading tools, including SSRF guard behavior.


## 0.22.0

### Features

- **`web_fetch` tool** — New content-fetching tool with multiple rendering backends: browser (Playwright), crawlee, Jina Reader, and Mozilla Readability article extraction. Includes built-in SSRF protection, MIME detection, metadata extraction, and Cloudflare challenge retry. New `src/web/web-fetch.ts` and supporting modules.
- **Platform abstraction layer** — New ports-and-adapters architecture decoupling core logic from opencode platform dependencies. `ISessionClient` interface enables testable, swappable session backends. New `src/platform/` module.
- **`plan_incomplete` condition** — New function state machine condition supporting cross-session resume. Detects unchecked plan steps and gates execution flow accordingly.
- **Signal tool and observation infrastructure** — Universal out-of-band signal tool (`|signal|`) for state transitions (completion, approval, handoff, escalation) without embedding signals in text content. New `src/signal/` module.
- **Postinstall welcome banner** — ASCII wordmark displayed after `npm install` for a polished first-run experience.

### Bug Fixes

- **Test mock pollution** — Resolve 20 test failures caused by mock state leaking between test cases and incorrect parameter access patterns.
- **Import path resolution** — Fix remaining stale import paths after module restructuring to prevent runtime resolution failures.
- **Function spec caching** — Rebuild `fnSpecMap` per invocation to avoid stale function specification references across sessions.
- **Cyclic dependency detection** — Throw `DescriptiveCycleError` on circular service dependencies with clear diagnostic output instead of silent hang.

### Refactors

- **Session migration** — Migrate from `OpencodeClient` to `ISessionClient` interface, enabling platform-agnostic session management.
- **Tool migration** — Migrate all tools from legacy `tool()` to `defineTool()` for consistent tool definition patterns.
- **Module decomposition** — Split oversized modules into focused subdirectories across dispatch, core, CLI, and types packages:
  - Dispatch: split `task-lifecycle.ts` god file into focused modules
  - Core: consolidate service files into `core/services` with composition module
  - CLI: consolidate CLI commands into subdirectories
  - Types: extract domain-specific types into `loader/types` and `memory/types`
- **Registry robustness** — Improve download stability with consistent output directories and tar integrity checks.
- **Type safety** — Replace `as any` casts with typed bridge interfaces across dispatch module.

### Tests

- **Platform abstraction tests** — Test suite for `ISessionClient` interface and platform adapter behavior.
- **State-gc tests** — Garbage collection tests for state management, graceful degradation renaming, and expanded path mock coverage.

---

## 0.21.0

### Features

- **Crash recovery architecture** — New supervisor module with init resilience and startup health checks. Integrates with the health monitor to provide degraded startup defense — the plugin starts in reduced-capability mode rather than crashing outright. New `src/core/supervisor.ts`.
- **`rolebox config` CLI command** — Interactive model selection for roles without manually editing YAML. Lets you pick models from available providers in a guided flow.
- **`dispatch_status` tool** — Proactive liveness checks for running background tasks. Returns status, duration, last activity, tool call count, and output availability without blocking.
- **Dispatch failure escalation** — Running tasks with consecutive fetch failures are now escalated to error state automatically. Configurable via `consecutiveFetchFailures` in `TaskEventState`.
- **Dispatch eventState persistence** — `TaskEventState` (including fetch failure counts) now persists across save/load cycles, surviving plugin restarts.
- **TUI task liveness indicators** — `rolebox monitor` surfaces stalled tasks with warning badges and activity indicators. Session-scoped refresh wired into the refresh cycle.
- **P2 dispatch and asset tools** — New tools for deeper introspection:
  - `task_concurrency` — Real-time concurrency slot status per key
  - `task_chronology` — Time-bucketed task activity by hour/day/agent
  - `task_export` — Export completed task results to file
  - `skill_compose` — Analyze skill combinations for conflicts
  - `asset_hot_reload` — Trigger hot-reload without restart
  - `context_assemble` — Cross-domain search across memory/assets/tasks/sessions
- **Search and introspection tools** — Full suite of search and query tools:
  - `task_search` — Search dispatch task history by query/status/agent/date
  - `task_budget` — Query token/cost consumption and remaining quota
  - `task_graph` — Visualize dispatch task dependency trees
  - `task_retry` — Retry failed tasks with context preservation
  - `asset_search` — Search skills/functions/references by keyword
  - `asset_inspect` — View complete frontmatter for any asset
  - `asset_validate` — Check dependency integrity across all roles
  - `reference_search` — Full-text search across reference documents
  - `function_state` — Query function state machine (phases, gates, evidence)
  - `function_graph` — Visualize function dependency and state-machine graphs
- **Logo rebrand** — New isometric cube logo with Space Grotesk font and sky-blue accent, conveying the "box" metaphor visually.

### Bug Fixes

- **Function parser** — Support function activation (`|name|`) at start of any line, not just after whitespace.
- **Stale lock recovery** — Reclaim stale state locks instead of blocking indefinitely; stop swallowing silent errors during lock acquisition.
- **Dispatch notification deduplication** — Prevent duplicate `system-reminder` notifications from intermediate tasks in multi-level dispatch chains.
- **Dispatch cancel-before-abort** — Cancel tasks before abort signal to prevent completed-status race conditions.
- **Dispatch retry on inflight siblings** — Retry final notifications even when sibling tasks are still inflight, preventing notification loss.
- **Monitor sidecar path** — Fall back to rebuilt sidecar path in `--tail` mode when stored path is empty.
- **Monitor stale filtering** — Filter stale functions/graphs by live dispatch sessions only, preventing phantom entries.
- **Hot-reload failure resilience** — Preserve existing state on reload failure and return structured error results instead of crashing.
- **TUI session scope** — Wire `buildSessionScope` to refresh cycle so session-scoped activity updates in real time.

### Refactors

- **Module decomposition** — Decompose oversized source files into focused single-responsibility modules across dispatch, session, and core packages.
- **SearchService dissolution** — Dissolve the monolithic SearchService and colocate tools directly by domain (dispatch tools live in `src/dispatch/`, asset tools in `src/asset/`, etc.).

### Documentation

- **README rewrite** — Complete README overhaul showcasing all major features (Memory, LSP, Hashline, Notifications, Session Management, Dispatch, Function State Machine, Context Assembly, Asset Management) with comparison table against raw opencode.

### Tests

- **Crash recovery integration tests** — New test suite covering supervisor startup, degraded mode entry, and health monitor integration.

---

## 0.20.0

### Features

- **Persistent memory system** — SQLite-backed persistent memory store with CLI tools (`rolebox memory` commands) and automatic prompt injection for cross-session knowledge retention. New `src/memory/` module (store, tools).
- **Microkernel architecture (P0–P3)** — Complete architectural refactor introducing:
  - **P0**: Service pattern + unified extension points
  - **P1**: Event bus + state isolation across services
  - **P2+P3**: Capability-based security, full role hot-reload pipeline, health monitor, and pluggable concurrency adapter
- **Full role hot-reload** — Real-time role reload on file changes with stable handler reference, debounced file watcher (300ms), and module cache invalidation. No opencode restart required. New `src/core/hot-reload-service.ts`.
- **Token/cost budget management** — Configurable budget limits for multi-agent dispatch: total sessions, input/output tokens, and cost per request and per session. Model pool limits are respected automatically. New `dispatch_budget` tool and `src/dispatch/budget-tracker.ts`.
- **Session compaction** — Runtime state injection via compaction hook during dispatch lifecycle, preserving session continuity. New `src/hooks/compaction.ts`.
- **TUI dashboard** — Redesigned `rolebox monitor` with Solid.js + OpenTU TUI rendering, proper screen refresh and layout management. New `src/tui/` module and `./tui` package export path.
- **Status Overview Panel** — New status panel in `rolebox monitor` showing active loops, graph workflows, dispatch summary, and concurrency pool health. Use `--no-status` to hide.
- **Monitor improvements** — `sessionId` field added to task snapshots for task-to-session tracing; fnstate active function filtering fixed (gated/active phases included, complete excluded); default watch interval reduced from 2s to 1s.

### Bug Fixes

- **hooks system.transform** — Fallback to `sessionAgentRegistry` when agent ID is undefined in `system.transform` hook context, preventing errors during prompt assembly.
- **Hot-reload test reliability** — Replace brittle `setTimeout` waits with polling-based `waitForRestart` utility in hot-reload service tests, eliminating flakiness.

### Refactors


- **Microkernel architecture** — Full P0–P3 decomposition into service pattern with event bus, state isolation, capability security, and pluggable concurrency adapters.
## 0.19.0

### Features

- **Comprehensive monitoring system** — `rolebox monitor` rebuilt from a simple task list into a full observability dashboard:
  - **Metrics persistence bridge** — In-process `MetricsRegistry` now flushes to `.rolebox/state/metrics-{hash}.json` via a new `MetricsPersister` class (atomic writes, NDJSON ring-buffer event log capped at 100KB). Integrated into `DispatchManager` lifecycle (persist/flush/dispose).
  - **Recovery metrics bridge** — `RecoveryMetricsCollector` snapshots are now embedded in the persisted metrics file via a provider callback wired in `plugin-hooks.ts`, making recovery chain data (attempts, successes, aborted/exhausted, by-category, by-strategy, error-type frequency) visible to the monitor.
  - **Metrics panel** — Counter totals (dispatch_total, completed, error, cancelled, timeout, rejected, backpressure_retry), gauge snapshots (inflight_tasks, concurrency_active/queued/limit), and histogram summaries (task_duration_ms, queue_wait_ms with avg/p50/p95) rendered in the CLI.
  - **Filtering & sorting** — `--agent=<pattern>` (case-insensitive substring), `--status=<list>` (comma-separated), `--sort=<field>` (status/agent/duration/started).
  - **Task detail view** — `--task-id=<id>` one-shot mode with `--offset`/`--limit` pagination for full result sidecar text.
  - **Incremental diff watch** — Watch mode now updates only changed lines via ANSI cursor positioning instead of full-screen clear. Tracks added/removed/changed tasks with a `diff: +N ~M -N` summary. SIGWINCH triggers full redraw. `--full-redraw` falls back to old behavior.
  - **Notification display** — `--show-notifications` reveals quiet-hours status, throttle stats, and recent events.
  - **Export** — `--export=json|prometheus|summary` with `--output=<path>`. Prometheus format includes HELP/TYPE lines, labeled metrics, and histogram buckets with `le=` labels.
- **Plugin-style extension system** — Users can now extend rolebox with custom conditions, graph topologies, notification channels, and hooks via a registry-based extension API. New `src/extensions/` module with loader and type-safe registries.
- **Configurable error recovery framework** — YAML-configurable error recovery system with provider-agnostic error pattern detection (7+ patterns), 7 built-in recovery strategies (retry, compact, fallback_model, etc.), recovery strategy chains (try A → B → C → abort), state persistence across restarts, metrics collection, 5 error-recovery hooks (default ON: session, edit, JSON, context, empty), and 4 guard hooks (default OFF). Extensible via `RecoveryStrategy` interface and `PatternRegistry`.
- **Custom hook registration** — Users can declare hooks in `role.yaml` that subscribe to agent lifecycle events (`chat.message`, `tool.execute.before/after`, `system.transform`, `event`). Each hook is a JS/TS module with typed handlers, configurable phase (before/after built-in), priority-based ordering, and tool/event filtering.
- **Notification manager** — Full notification subsystem integrated with session lifecycle: multi-channel delivery (terminal, file, system), quiet hours, throttling, scheduling, and content formatting. New `src/notifications/` module (12 files).

### Bug Fixes

- **dispatch_output on running tasks** — Replace the successful text response ("Task is still running") with an Error throw when `dispatch_output` is called on a running/pending task, preventing the LLM from entering a polling loop. Three layers of defense: primary tool throw, tool-before guard, tool-after correction injection.

### Refactors

- **Notifications enums → const objects** — Convert enums to const objects for extensibility, enabling the extension system to register new notification channels.
- **Metrics `reset()` fix** — `MetricsRegistry.reset()` now also clears `coreCounters`/`coreGauges`, fixing a state leak across test runs.

## 0.18.0

### Features

- **Model repetition prevention** — Added validation gate that detects and rejects model output that repeats the same or similar content consecutively. Prevents echo/loop patterns in agent responses, improving output quality and reducing wasted token usage.

## 0.17.0

### Features

- **Session management tools** — 6 new tools for session introspection: `session_list`, `session_read`, `session_search`, `session_info`, `session_diff`, `session_fork`. New `src/session/` module.
- **Available functions prompt block** — System prompt now includes an `<available_functions>` block listing activated functions and their descriptions.
- **Sync dispatch session continuation** — Sync dispatch tasks can now use `session_id` to continue a previous session, preserving conversation history. Previously only background tasks supported this.
- **Language Server Protocol integration** — Full LSP client with 30+ tools covering completions, diagnostics, hover, go-to-definition, references, rename, code actions, formatting, document symbols, workspace symbols, folding ranges, inlay hints, call hierarchy, type hierarchy, semantic tokens, selection ranges, signature help, and code lenses. (Client manager, document manager, server detection, position translation — ~4,375 lines)
- **Hash-anchored edit system** — New `hashline_read` and `hashline_edit` tools with configurable hash width (2-4 chars, auto-escalates by file size), SHA-256 file version guard for staleness detection, Myers diff re-anchoring, fuzzy anchor recovery with offset auto-correction, and atomic writes (temp+rename). 13 source modules, 5 test suites (251 tests).
- **Inline result text in completion notification** — The final "all tasks complete" system-reminder now includes result text inline (truncated at 4000 chars), so the orchestrator sees results directly without needing `dispatch_output`.
- **Output-gated observe specs** — `ObserveSpec` gains a `when_output` gate that conditionally fires based on tool output content (`contains?`, `not_contains?`). Also suppresses `requires_evidence` auto-mark when an output-gated observe covers the same tool+evidence pair.

### Refactors

- **LSP server detection order** — Check for binary in PATH before scanning project files, avoiding unnecessary filesystem traversal.
- **Derive inflight count from tasks map** — Removed the fragile `inflightByParent` map (maintained via inc/dec at every terminal path) and replaced it with authoritative derivation from the tasks map. `notifyCompletion` now accepts an explicit remaining count.

## 0.15.0

### Breaking Changes

- **Loop rewrite**: The `|loop|` semantics have been rewritten. Every round (including the first) now runs in a child worker session dispatched through the dispatch system. The main session becomes a pure orchestrator that summarizes each round for the user. The summary also seeds the next round (inherit mode). The old LoopManager sequential state machine has been removed and replaced by LoopCoordinator.

### Features

- Implement LoopCoordinator with phased state machine (idle → running → summarizing) and cancellation support
- Wire LoopCoordinator into event-handler and plugin lifecycle, replacing the old LoopManager
- Harden LoopCoordinator with persistence, cancelNow, and failure recovery
- Add `loop` to DEFAULT_FUNCTIONS — available in every role without explicit declaration
- Gate loop activation on functionSessionState to prevent spurious activations
- Refine loop cancellation: only cancel on user message after round 1, then further restricted to explicit `/stop-loop` command only
- Propagate agent identity through dispatch notifications and continuation flow
- Add evidence-based continuation gating — auto-continue now requires dispatch completion evidence
- Gate loop activation on functionSessionState in chat-message hook
- Add orchestrator integration tests and remove dead LoopManager code

### Bug Fixes

- Fix CLI optional positional args: mark `role` (update), `query` (search), and `name` (init) as `required: false` — citty defaults positional args to required, causing `rolebox update` and `rolebox search` without arguments to fail
- Fix dispatch-manager: notify parent session when a task errors while running
- Fix dispatch-adapter: make readOriginSummary `sinceMessageId` boundary exclusive
- Fix event-handler: replace `break` with flag to allow loop advance after suppression
- Fix loop coordinator test assertion to match boundary tracking
- Fix plugin-hooks: exclude dispatch completion reminders from auto-continue counter reset
- Add safer gate to terminate loop

### Refactors

- Add LoopPhase model, IDispatchAdapter interface, and unified-seed constants for LoopCoordinator
- Extract `bridgeLoopAdvance` helper in event-handler
- Extract `failSession` method and use in event-handler
- Extract `resolveMaxBytes` helper in logger
- Extract hook handlers into `src/hooks/` module
- Extract `collectAllFunctions` helper and hoist dynamic imports
- Extract magic strings to constants and consolidate duplicate utilities

## 0.14.0

### Features

- Add loop system with sequential state machine (LoopManager), configurable modes (fixed, until, forever, while), and per-loop counters
- Add loop param parsing and validation with defaults, clamping, and alias resolution
- Add loop state persistence store with save/load and version migration
- Add summarizer session with configurable timeout, token cap, and fallback
- Wire loop activation, cancellation, and function exclusions into plugin hooks
- Add idle round-advance, error handling, session.error routing, and recovery notes for loop
- Add round timeout watchdog and spawn retry for background dispatch
- Add `--tail`/`-t` flag to monitor command to show last N characters of each completed task's output

### Bug Fixes

- Prevent unbounded auto-continue spin: exclude auto-continue reminder messages from continuation counter reset in chat.message hook

## 0.13.0

### Features

- Add loop termination conditions: `timeout_ms`, `converged`, `result_matches`, `stuck` — configurable via `any_of`/`all_of` composition
- Add v2 graph state machine with per-loop counters, sync termination, and structured `terminationReason`
- Add gated prompt blocks and two-phase bridge with correction budget for review-loop workflows
- Add SCC (strongly connected component) loop detection and termination parsing
- Add sync/async termination evaluators, template edge locks, and persistence
- Wire two-phase loop termination into runtime hooks
- Add shared `state-paths` utility module with deterministic hash/path functions, migrate callers
- Add monitor command enhancements: scan all state files, resolve project root up-tree

### Bug Fixes

- Normalize workspace directory in plugin hooks for consistent state paths
- Skip creating empty agent/skill directories during sync

### Documentation

- Update README with state directory description and loop termination examples

## 0.12.0

### Features

- Add `configureLogDirectory` to logger for project-local `.rolebox` logging

### Bug Fixes

- Add gone-gate for non-existent sessions in dispatch evaluate loop
- Treat absent session status as idle-equivalent in completion detector

### Refactors

- Migrate state storage from `XDG_DATA_HOME` to project-local `.rolebox`

## 0.11.0

### Features

- Add `monitor` command — runtime dispatch dashboard with human-readable and JSON output, active/pending/error task filtering (`--all`), error detail display, live-refresh watch mode (`--watch`, `--interval`), and active function tracking with agent resolution
- Add `monitor-reader` module: reads dispatch, fnstate, and graph state files into a unified `MonitorSnapshot`, resolves agent IDs from graph and dispatch session mappings
- Add `state-hash` utility: deterministic directory-to-hash for state file naming

## 0.10.0

### Features

- Redesign dispatch subsystem: event-driven TaskWatchdogManager replaces GlobalPoller, per-model concurrency isolation, backpressure with bounded FIFO queue, session continuation, state persistence v2 with debounced writes, crash recovery
- Add dispatch task state persistence (TaskStateStore) with schema v3/v4: result refs, outbox, sidecar, LRU cleanup, state-file locks
- Add dispatch metrics: in-process MetricsRegistry with counters, gauges, histograms; lifecycle metrics; dispatch_metrics tool; sync task metrics; snapshot export
- Add dispatch output: getResult extraction with timeout, subagent result contract, output pagination, spill-to-file, materialize-before-notify, cache-first retrieval
- Add dispatch configuration: role-level `dispatch:` block merging with env vars (`ROLEBOX_DISPATCH_*`)
- Add dispatch completion detection with finish-reason analysis, session-monitor for gone detection
- Add dispatch error recovery: allocate-concurrent with timeout, single-authority CAS completion gate, atomic per-parent in-flight counter, stall timeout
- Add dispatch session.idle event handling and permission transformation
- Add collaborative graph advancements: idempotent advanceStep, structured args advancement, single-authority advancer, unicode agent name support, disconnected subgraph validation
- Add graph runtime state persistence and recovery via plugin hooks
- Add unified logger module (tslog) with file transport, log rotation, lazy initialization, prompt size monitoring
- Add init summary logging with actionable context

### Bug Fixes

- Fix dispatch: prevent cleanup during in-flight notifications, notify parent on failure, terminal-status guards for cancelTask/lifecycle handlers, bounded cleanedUpTasks FIFO buffer, unhandled rejection in enqueueNotify
- Fix dispatch: double-completion race via CAS gate, executeSync under concurrency/timeout/abort control
- Fix graph: advanceStep edge selection with deferred state cleanup, lazy-init graph state in system.transform, clamp negative max_iterations to 0
- Fix dispatch: recovery notification and inflight rebuild, unify terminal cleanup with leaveRunning
- Fix sync: add logging to silent catch blocks, fallback to opencode config dir when workspace-level config is unavailable

### Refactors

- Restructure src/ into domain subdirectories (dispatch, graph, cli, prompt)
- Move tests from src/ to tests/ directory
- Extract constants, XML DOM builder utilities, shared test helpers
- Migrate all resolvers, loaders, and CLI logging to tslog
- Rewrite graph advancer to single-authority pattern

### Documentation

- Update README with init, info, status commands, References system, dispatch config, dispatch env vars

## 0.9.0

### Features

- Add `status` command — rolebox health dashboard with sync status, plugin registration, skill symlink integrity
- Add `info` command — detailed role inspection with model config, skills, functions, subagents, collaboration graph, sync status, and optional integrity hash verification (`--check`)
- Add `--no-cache` flag to `search` and `update` commands to bypass registry cache

## 0.7.0

### Features

- Add `init` command — interactive role scaffolding with 4 templates
- Add scaffold templates: `minimal` (role.yaml + PROMPT.md), `standard` (+ skills/functions/references dirs), `subagents` (+ subagent scaffolding), `collaboration` (+ collaboration graph topology)

## 0.6.0

### Features

- Add References system: auto-discovered `references/` directories (recursive .md discovery), explicit declarations in role.yaml, skill-specific references, frontmatter description extraction
- Add Collaboration Graph system: define multi-agent workflows with pipeline/review-loop/star topologies or custom flow edges, runtime state tracking, prompt injection, automatic graph advancement
- Add graph persistence: state files, session recovery, role config integration
- Add `<available_references>` and `<collaboration_graph>` XML blocks to agent prompts

### Documentation

- Add collaboration graph section to README with topology descriptions, custom flow examples, and runtime behavior

## 0.5.1

### Features

- Add SubAgentConfig and ResolvedSubAgent types
- Add subagent parsing, file-based and inline declaration, auto-discovery from `subagents/` directory
- Add config inheritance: subagents inherit model, color, variant, temperature, top_p, permission, tools from parent
- Add subagent naming convention: `{parentId}--{childId}` (`--` separator reserved)
- Add `<available_subagents>` XML block injection into parent prompt
- Add subagent skills and functions support with rolebox-- prefix symlinks
- Wire subagents into plugin lifecycle with dispatch/output/cancel tools
- Add team-lead example and E2E tests

### Bug Fixes

- Fix subagent skill path resolution, type safety, naming, and duplicate detection

## 0.5.0

### Features

- Add automatic version check on CLI startup — checks npm registry for newer release, caches result for 24 hours, displays colored update notice
- Never blocks CLI — version check uses 3s timeout, all failures silently swallowed

## 0.4.1

### Bug Fixes

- Add .js extensions for ESM compatibility (NodeNext module resolution)

## 0.4.0

### Features

- Add CLI skeleton with citty framework
- Add config manager: `~/.config/rolebox/config.yaml` with multi-registry support
- Add registry client: fetches role manifests from GitHub-based registries
- Add CLI commands: `list` (installed roles), `search` (registry search), `update` (role updates), `registry` (registry management)
- Add `sync` command — deploys installed roles to opencode via symlinks
- Add lock file (`rolebox.lock`) for version and integrity tracking

## 0.3.1

### Bug Fixes

- Export plugin as PluginModule format for opencode compatibility

## 0.3.0

### Features

- Add parameterized function support: positional (`|review:security,strict|`) and key-value (`|review focus=security severity=strict|`) syntax
- Add parameter substitution in function resolver — params fall back to declared defaults
- Wire parameterized function calls into plugin hooks

### Documentation

- Update README and function docs for parameterized functions

## 0.2.0

### Features

- Add Functions system: composable behavior modules activated via `|name|` syntax
- Add function type definitions, resolver, parser, and session state modules
- Add function resolution priority: role-local > global > built-in
- Add built-in functions: `plan` (codebase investigation + structured plan), `execute` (step-by-step implementation with verification)
- Add `functions` and `disable_functions` fields to role.yaml
- Add function hooks integration for dynamic injection into system prompt
- Add comprehensive test suite for function system

## 0.1.2

### Bug Fixes

- Fallback to opencode config directory when workspace-level config is unavailable
