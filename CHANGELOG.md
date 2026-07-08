# Changelog

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
