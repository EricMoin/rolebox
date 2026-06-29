# Changelog

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
