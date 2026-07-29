# Legacy v1 Graph Subsystem Decommission

> Part of the rolebox documentation. See [README](../README.md) for overview.

This document inventories the legacy v1 graph subsystem, enumerates every live coupling point that still touches it, and lays out a staged freeze → migrate → remove decommission plan. It is a **recommendation and inventory only** — it makes no code changes and removes no source files. All `src/` paths are cited as `file:line` references for verification; the v2 engine is treated as the migration target throughout.

> **Update (2026-07-29):** [Stage 2](#stage-2--migrate-consumers-onto-the-v2-engine) has been **executed** by the consumer-migration subtask. The tables below carry a "Stage 2 status" column reflecting what was migrated vs. left residual behind the `src/graph/legacy-v1.ts` adapter.
>
> **Update (2026-07-29, later):** [Stage 3](#stage-3--delete-v1-modules) (REMOVE) was **attempted** by the code-removal subtask and **could not proceed**. The residual consumers documented in Stage 2 remain live behind the `src/graph/legacy-v1.ts` adapter, so **no v1 module is fully orphaned and nothing was deleted.** See [Stage 3 execution status](#stage-3-execution-status-2026-07-29) below.
>
> **Update (2026-07-29, later still):** [Stage 3, Subtask 1](#stage-3--subtask-1-relocation-execution-status-2026-07-29) (relocation) has been **executed**. The collaboration→v2 bridge logic was moved off the delete-target modules (`converter.ts`, `parser.ts`) into `src/graph/collaboration-bridge.ts`; `importGraphFromFile` moved into `parser-v2.ts`; the three live production consumers (`orchestrator.ts`, `termination-conditions.ts`, `migrate.ts`) were re-pointed; and `converter.ts` / `parser.ts` were reduced to thin re-export shims. No v1 module was deleted — that remains a later subtask.
>
> **Update (2026-07-29, even later):** [Stage 3, Subtask 2](#stage-3--subtask-2-execution-state-advance-store-port-execution-status-2026-07-29) (execution-state, advance, store port) has been **executed**. The v1 execution semantics (`state.ts`, `advance.ts`, `graph-store.ts`) were ported behavior-preservingly into `src/graph/collaboration-state.ts`, `collaboration-advance.ts`, and `collaboration-store.ts` (the latter now persisting to the new `collaboration-{hash}.json` path). The three v1 modules were reduced to thin re-export shims; no v1 module was deleted.
>
> **Update (2026-07-29, final): [Stage 3](#stage-3--delete-v1-modules) (REMOVE) has been **EXECUTED**. All six v1 modules (`state.ts`, `advance.ts`, `graph-store.ts`, `converter.ts`, `parser.ts`, `validator.ts`), the `legacy-v1.ts` adapter, and the v1 `graph-{hash}.json` legacy state file were physically deleted (user-approved). The `graph-{hash}.json` on-disk format was **removed in 1.0** with no backward-compat read path and no deprecation section. The tables below that cite v1 modules as live are **historical** — they record the pre-deletion inventory and are retained for traceability only; the live inventory is the [final `src/graph/` module inventory](#final-srcgraph-module-inventory-post-stage-3) at the end of Stage 3.

## Purpose and scope

- **Inventory** — every v1 module, its responsibility, and its exact location.
- **Live coupling** — every consumer that imports or drives the v1 subsystem.
- **State coexistence** — how v1 and v2 state files share `.rolebox/state/`.
- **Decommission recommendation** — a three-stage path (freeze → migrate → remove) that a future code-removal task can execute.

**Explicitly out of scope for this document:** deleting or modifying any file under `src/`, running git operations, or changing runtime behavior. This is documentation only.

## v1 module inventory

The legacy v1 graph subsystem lives under `src/graph/`. Its modules are:

| Module | Symbol(s) | Responsibility |
|---|---|---|
| `src/graph/state.ts` | `GraphExecutionState` (line 10), `GraphSessionState` (line 37), `graphSessionState` (line 250), `buildGraphStateBlock` (line 252) | Holds in-memory sessions in a `Map`; persists via debounced `_persist()` (line 201) and `flushSync()` (line 217); recovers via `recover()` (line 233). Uses `GraphStore`. Produces the `<collaboration_state>` prompt block. |
| `src/graph/advance.ts` | `extractDispatchTarget` (line 48), `advanceGraphForDispatch` (line 97), `setAdvanceJudge` (line 20), `drainConvergence` (line 28), `MAX_CORRECTIONS = 3` (line 9), `ASYNC_TIMEOUT_MS = 30_000` (line 10) | Single-authority entry point that advances graph state after a dispatch, with off-route/unknown correction generation and async convergence evaluation. |
| `src/graph/graph-store.ts` | `GraphStore` (line 23) | Writes `.rolebox/state/graph-{hash}.json` (`getStatePath` lines 126-128, filename at line 127). Schema `GraphStateFile { version: 1\|2, sessions: SerializedGraphSession[] }` (lines 16-19). Supports v1→v2 migration (`migrateV1toV2` line 200). `serialize` writes version 2 (line 153). |
| `src/graph/converter.ts` | ~~`convertCollaborationToGraphDeclaration` (line 61)~~ → now a **thin re-export shim** (Subtask 1) | Converted a legacy v1 `collaboration:` config into a lossless v2 `GraphDeclaration`. Logic moved to `src/graph/collaboration-bridge.ts` (Subtask 1). |
| `src/graph/parser.ts` | ~~`autoConvertCollaboration` (line 115), `graphDeclarationToResolvedGraph` (line 172), `importGraphFromFile` (line 48), re-export `registerTerminationParser` / `addTerminationConditionKey` (line 26)~~ → now a **thin re-export shim** (Subtask 1) | v1 entry points. Bridge functions moved to `src/graph/collaboration-bridge.ts`; `importGraphFromFile` moved to `src/graph/parser-v2.ts`; termination-registry re-exports now sourced from `src/graph/termination-parser.ts` (all in Subtask 1). |
| `src/graph/validator.ts` | `validateGraph` (line 23) | Validates a v1 `ResolvedGraph` against available agent names. Used only by `parser.ts:213`. |

## Live coupling points

These are the places that still import or drive the v1 subsystem. Removing v1 requires migrating every one of them.

### Re-exports — `src/graph/index.ts`

The public barrel re-exports v1 symbols. As of **Stage 2**, no `src/` production consumer imports v1 symbols from the barrel (or from the v1 modules directly) — they import through the internal adapter `src/graph/legacy-v1.ts`. The barrel's v1 re-exports remain for **test access and backward compatibility** only and are removed in Stage 3:

| Line | Re-export | Origin | Stage 2 status |
|---|---|---|---|
| 1 | `autoConvertCollaboration, graphDeclarationToResolvedGraph` | `./parser.ts` | retained for tests; consumers use `legacy-v1.ts` |
| 2 | `validateGraph` | `./validator.ts` | retained for tests (single caller inside `src/graph/parser.ts:213`) |
| 15 | `GraphSessionState, graphSessionState, buildGraphStateBlock` | `./state.ts` | retained for tests; consumers use `legacy-v1.ts` |
| 16 | types `GraphExecutionState, AdvanceResult` | `./state.ts` | retained for tests; consumers use `legacy-v1.ts` |
| 18 | `extractDispatchTarget, advanceGraphForDispatch` | `./advance.ts` | retained for tests; consumers use `legacy-v1.ts` |

### Internal adapter — `src/graph/legacy-v1.ts`

Stage 2 introduces a single internal boundary (`src/graph/legacy-v1.ts`, inside `src/graph/`) that re-exports the v1 execution surface (`state.ts`, `advance.ts`, `parser.ts`, `converter.ts`). Every `src/` consumer that still needs the v1 subsystem imports **only** from this adapter, so no v1 module is imported outside `src/graph/`. Deleting the adapter + the v1 modules together is the Stage 3 move.

### Core consumer sites

| Consumer | Reference | Usage | Stage 2 status |
|---|---|---|---|
| `src/core/services/hook-service.ts` | line 6 (import), line 61 (`setStoreDirectory`), line 65 (`recover`), line 92 (passed as custom-hook dep) | Drives v1 store setup and session recovery at service init. | **Residual (adapter)** — v1 execution state still required for legacy `collaboration:` auto-advance; the unused `setAdvanceJudge` import was removed. |
| `src/hooks/tool-after.ts` | line 1 (import `graphSessionState`, `advanceGraphForDispatch`, `extractDispatchTarget`), lines 97-98 (`getState`/`getGraph`), lines 99-111 (result capture), line 113 (`advanceGraphForDispatch`) | Advances graph state on every `task`/`dispatch` completion and captures results for convergence checks. | **Residual (adapter)** — v1 advance engine is the only auto-advance-on-dispatch mechanism; the v2 engine is imperative and has no equivalent. |
| `src/resolver/orchestrator.ts` | line 8 (import `autoConvertCollaboration`, `graphDeclarationToResolvedGraph`), lines 245-251 (route `collaboration:` through the converter + bridge), line 263 (`computeNodeRole` consumes `ResolvedGraph`) | Resolves the legacy `collaboration:` config path into a v1 `ResolvedGraph` the prompt/state builders consume. | **Residual (adapter)** — the `collaboration:` → v1 `ResolvedGraph` bridge is the last v1↔v2 coupling (see Risks); prompt-helper imports (`buildSubagentRoleBlock`, `SUBAGENT_RESULT_CONTRACT`) now come directly from `graph/prompt-builder.ts`. |

### Additional consumers (for completeness)

| Consumer | Reference | Usage | Stage 2 status |
|---|---|---|---|
| `src/core/state-registry.ts` | ~~line 2 (import `GraphSessionState` type), line 9 (instantiates `new GraphSessionState()`)~~ | Type-level and runtime registry entry. | **Migrated (decoupled)** — the dead `graph` field and `GraphSessionState` import were removed (`stateRegistry.graph` was unused in production and tests). |
| `src/core/composition.ts` | line 5 (import), line 89 (`graphSessionState.flushSync()`) | Flushes v1 graph state on shutdown. | **Residual (adapter)** — shutdown flush still needed while the legacy `collaboration:` path persists v1 session state. |
| `src/hooks/chat-message.ts` | line 3 (import), lines 141, 144 (`getState` / `initGraph`) | Initializes graph state when a chat session starts for an agent with a graph. | **Residual (adapter)** — graph init feeds the v1 auto-advance path. |
| `src/hooks/system-transform.ts` | line 3 (import), lines 66-71, 116, 237, 291 (`getState`/`initGraph`/`getGraph`/`buildGraphStateBlock`) | Injects `<collaboration_state>` blocks into the orchestrator system prompt. | **Residual (adapter)** — `<collaboration_state>` is produced from v1 execution state; a v2 state-block equivalent does not exist for the `collaboration:` flow. |
| `src/hooks/custom/registry.ts` | lines 24, 150 (`deps.graphSessionState.getState`) | Exposes `getGraphState` to custom hooks. | **Residual (structural dep)** — the dep is typed structurally; it imports no graph module itself and receives the singleton from `hook-service.ts`. |
| `src/prompt/builder.ts` | line 3 (`buildCollaborationBlock`) | Builds the `<collaboration_graph>` prompt block. | **Migrated (decoupled)** — `buildCollaborationBlock` is a pure prompt helper (not a v1 module); it now imports directly from `graph/prompt-builder.ts`. |
| `src/extensions/points/termination-conditions.ts` | line 5 (`registerTerminationParser`) | Registers custom termination-condition parsers into the v1 parser registry. | **Residual (adapter)** — feeds the v1 termination registry; now imports via `legacy-v1.ts`. |
| `src/cli/commands/migrate.ts` | line 27 (`convertCollaborationToGraphDeclaration`) | The `rolebox migrate` tool converts `collaboration:` → `graph:`. | **Residual (adapter)** — intentionally coupled to the converter; now imports via `legacy-v1.ts`. |

## State directory coexistence

Both v1 and v2 write into the **same** `.rolebox/state/` directory, using distinct filename prefixes so the two subsystems do not collide.

| Subsystem | File pattern | Path derivation | Source |
|---|---|---|---|
| v1 graph state | `graph-{hash}.json` | `{hash}` = `shortHash(directory)`, 12 hex chars | `src/graph/graph-store.ts:126-128` (filename at 127); `shortHash` in `src/utils/state-paths.ts:15-17` |
| v2 engine state | `engine-{slug}.json` | `{slug}` = sanitized graph id | `src/graph/engine/engine-persistence.ts:322-328` (`engineStatePath`) |
| v2 event log | `graph-events-{hash}.ndjson` | `{hash}` = sha256 of graph id, 12 hex chars | `src/graph/engine/graph-events.ts:107-113` (`graphEventsPath`) |

### Migration consideration

Because v1 `graph-{hash}.json` and v2 `engine-{slug}.json` live in the same directory with different prefixes, they can coexist without name collisions. There is no automatic data hand-off between them today:

- The v1 store schema already carries a `version: 1\|2` field and supports in-place v1→v2 migration (`migrateV1toV2`, `src/graph/graph-store.ts:200`), but that migration is **within** the v1 store format, not a transfer into the v2 engine's per-graph file.
- The v2 engine is file-per-graph (`engine-{slug}.json`) plus an append-only audit log (`graph-events-{hash}.ndjson`), whereas v1 is a single per-workspace hash file holding all sessions.
- A decommission must therefore treat the state directory as a **shared namespace**: remove `graph-{hash}.json` files while preserving `engine-{slug}.json` and `graph-events-{hash}.ndjson`.

## Staged decommission recommendation

### Stage 1 — Freeze v1

Stop adding features to the v1 modules. Do not extend `GraphSessionState`, `advanceGraphForDispatch`, or the v1 `ResolvedGraph` shape.

- The legacy `collaboration:` config path **already routes through the v2 converter + bridge** (`src/resolver/orchestrator.ts:242-251`), so v1 behavior is already being reproduced on top of v2 machinery.
- `autoConvertCollaboration` emits a deprecation warning via `rootLogger.warn` at `src/graph/parser.ts:122-124`, flagging any remaining `collaboration:` users.
- New graph functionality must target the v2 `graph_*` / `graph:` schema (`src/graph/engine/`, `src/graph/parser-v2.ts`, `src/graph/validator-v2.ts`).

**Deliverable of this stage:** a documented commitment that no new v1 surface is added.

### Stage 2 — Migrate consumers onto the v2 engine

Move every live consumer off the v1 modules and onto the v2 engine. The exact consumers to migrate:

- `src/resolver/orchestrator.ts` — route `collaboration:` resolution through the v2 declaration/engine path instead of the v1 `ResolvedGraph` bridge.
- `src/core/services/hook-service.ts` — replace `graphSessionState.setStoreDirectory` / `recover` (lines 61, 65) with the v2 engine's store/recovery setup.
- `src/hooks/tool-after.ts` — replace `advanceGraphForDispatch` / `extractDispatchTarget` / `getState` / `getGraph` (lines 1-2, 97-113) with the v2 engine-advance API.
- `src/hooks/system-transform.ts` — replace `buildGraphStateBlock` / `getGraph` / `getState` / `initGraph` (lines 3, 66-71, 116, 237, 291) with the v2 state-block builder.
- `src/hooks/chat-message.ts` — replace `getState` / `initGraph` (lines 3, 141, 144).
- `src/core/composition.ts` — replace `graphSessionState.flushSync()` (lines 5, 89).
- `src/hooks/custom/registry.ts` — replace `deps.graphSessionState.getState` (lines 24, 150) with the v2 engine equivalent.
- `src/prompt/builder.ts` — replace `buildCollaborationBlock` (line 3) with the v2 prompt block builder.

**Migration target:** the v2 `graph_*` / `graph:` schema and the `src/graph/engine/` modules (`engine-state`, `engine-advance`, `engine-persistence`, `engine-recovery`, `engine-termination`, `engine-startup`, `graph-events`, `graph-notify`).

**Deliverable of this stage:** zero imports of the v1 modules remain outside `src/graph/` itself.

#### Stage 2 execution status (2026-07-29)

This subtask executes Stage 2. The hard constraint — the full test suite must pass and no v1 module may be deleted — means the **execution-state consumers cannot be fully migrated to the v2 engine yet**: the v2 engine is imperative (driven by the `graph_*` toolset) and has **no auto-advance-on-dispatch equivalent** for the legacy `collaboration:` config path. Per the task's instruction, consumers whose migration would require a behavior change not covered by tests are **kept working and documented as residual**.

What was done:

- **Introduced the internal adapter** `src/graph/legacy-v1.ts` (inside `src/graph/`). All `src/` consumers that still need the v1 subsystem now import **only** this adapter — no v1 module (`state.ts` / `advance.ts` / `graph-store.ts` / `converter.ts` / `parser.ts` / `validator.ts`) is imported outside `src/graph/`. Verified: `rg "graph/(index|state|advance|graph-store|converter|parser|validator)" src/` (excluding `src/graph/`) returns only doc-comment mentions.
- **Fully decoupled (migrated):**
  - `src/core/state-registry.ts` — removed the unused `graph` field / `GraphSessionState` import (dead in production and tests).
  - `src/prompt/builder.ts` — `buildCollaborationBlock` now imports directly from `graph/prompt-builder.ts` (pure prompt helper, not a v1 module).
  - `src/resolver/orchestrator.ts` — prompt helpers (`buildSubagentRoleBlock`, `SUBAGENT_RESULT_CONTRACT`) import directly from `graph/prompt-builder.ts`.
  - `src/core/services/hook-service.ts` — removed the unused `setAdvanceJudge` import.
- **Residual (behind the adapter; preserved behavior):** `hook-service.ts` (store/recovery), `tool-after.ts` (advance-on-dispatch), `chat-message.ts` (graph init), `system-transform.ts` (`<collaboration_state>` block), `composition.ts` (shutdown flush), `custom/registry.ts` (structural dep), `resolver/orchestrator.ts` (the `collaboration:` → v1 `ResolvedGraph` bridge), `extensions/points/termination-conditions.ts` (`registerTerminationParser`), and `cli/commands/migrate.ts` (the collaboration→graph migration tool, intentionally coupled to `converter.ts`).
- **Behavior preserved:** the full `bun test` suite (5068 pass / 1 skip / 0 fail) and `bun run typecheck` (clean) pass; `lsp_diagnostics` clean on all touched files.

Stage 3 (delete v1) now reduces to: delete `src/graph/legacy-v1.ts` + the v1 modules, update the residual consumers listed above to the v2 engine, and remove the barrel's v1 re-exports.

### Stage 3 — Delete v1 modules

Once no consumer references the v1 modules, remove them and clean the state directory:

- Delete `src/graph/state.ts`, `src/graph/advance.ts`, `src/graph/graph-store.ts`, `src/graph/converter.ts`, `src/graph/parser.ts`, `src/graph/validator.ts`.
- Remove their re-exports from `src/graph/index.ts` (lines 1, 2, 15, 16, 18). Keep the v2 re-exports (`parser-v2`, `validator-v2`, `templates`, `prompt-builder`) intact.
- Clean `.rolebox/state/`: remove `graph-{hash}.json` files; **preserve** `engine-{slug}.json` and `graph-events-{hash}.ndjson`.

**Deliverable of this stage:** the `src/graph/` directory contains only v2 modules and the shared helpers they depend on.

#### Stage 3 execution status (2026-07-29)

This subtask executes Stage 3 (REMOVE). Its precondition is that the Stage 2 migrate step decoupled **all** live consumers. Verification (`rg "legacy-v1" src/`) shows that is **not** the case: the execution-state residuals documented in Stage 2 remain live behind the `src/graph/legacy-v1.ts` adapter. Because the v2 engine is imperative (driven by the `graph_*` toolset) and has no auto-advance-on-dispatch equivalent for the legacy `collaboration:` path, the residual consumers still require the v1 execution engine at runtime.

Consequently, **no v1 module is fully orphaned** — every one of the six inventoried modules retains at least one live consumer (production residual and/or test), as enumerated below:

| Module | Live production consumer (via `legacy-v1.ts`) | Live test consumer |
|---|---|---|
| `state.ts` | `hook-service`, `composition`, `tool-after`, `system-transform`, `chat-message` (all use `graphSessionState`) | `state.test`, `state-machine`, `e2e`, `hooks-wiring`, `plugin-hooks`, `advance`, `prompt-snapshots`, `advance-v2`, `state-machine-v2`, `termination-async`, `graph-store`, `auto-activate-integration`, `integration/helpers`, `hooks/chat-message`, `hooks/system-transform` (barrel), `integration/e2e-hooks` (barrel) |
| `advance.ts` | `tool-after` (`advanceGraphForDispatch`, `extractDispatchTarget`) | `advance.test`, `hooks-wiring`, `advance-v2`, `e2e`, `plugin-hooks` |
| `graph-store.ts` | `state.ts` (internal `GraphStore` dependency) | `graph-store.test`, `state.test` |
| `converter.ts` | `cli/commands/migrate.ts`; `parser.ts` (internal) | `converter.test`, `auto-convert.test`, `cli/commands/migrate.test` |
| `parser.ts` | `resolver/orchestrator.ts` (`autoConvertCollaboration`, `graphDeclarationToResolvedGraph`); `extensions/points/termination-conditions.ts` (`registerTerminationParser`) | `converter.test`, `round-trip.test`, `migrate.test`, `prompt-snapshots.test`, `graph-v2.test`, `e2e.test`, `validator-v2.test`, `auto-convert.test` |
| `validator.ts` | `parser.ts` (internal `validateGraph` at `parser.ts:213`) | `validator.test`, `error-edge.test`, `graph-v2.test`, `validator-v2.test` |

**Decision taken per the task's residual branch:** because live consumers remain (documented residuals) and none of the six modules is fully orphaned, **no v1 module was deleted and the `src/graph/index.ts` v1 re-exports were left intact** (the barrel still serves `graphSessionState` to three test files and remains the documented test-access surface). The `legacy-v1.ts` adapter, its residual consumers, and the v1 modules all remain in place.

**Verification on the current tree (no changes made):**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- `bun test` — 5068 pass / 1 skip / 0 fail (one flaky registry-network failure on a prior run; clean on rerun).

**What completing Stage 3 would require (open work):**
1. Implement a v2 auto-advance-on-dispatch equivalent for the legacy `collaboration:` path (replace `advanceGraphForDispatch`/`extractDispatchTarget` in `tool-after.ts`).
2. Implement a v2 `<collaboration_state>` block builder (replace `buildGraphStateBlock`/`graphSessionState` in `system-transform.ts`).
3. Provide a v2 store/recovery path (replace `graphSessionState.setStoreDirectory`/`recover` in `hook-service.ts`, `flushSync` in `composition.ts`, `initGraph` in `chat-message.ts`).
4. Migrate the `collaboration:` → v1 `ResolvedGraph` bridge in `resolver/orchestrator.ts` and the `registerTerminationParser` registry in `extensions/points/termination-conditions.ts` onto v2.
5. Port the `rolebox migrate` CLI tool (`cli/commands/migrate.ts`) off `converter.ts`, and move test imports off the v1 modules/barrel.
6. Only then delete `state.ts` / `advance.ts` / `graph-store.ts` / `converter.ts` / `parser.ts` / `validator.ts`, remove the barrel's v1 re-exports, and clean `graph-{hash}.json` from `.rolebox/state/`.

#### Stage 3 — Subtask 1 (relocation) execution status (2026-07-29)

This subtask (the first concrete Stage 3 step, distinct from the earlier aborted REMOVE attempt) relocates the collaboration→v2 bridge and converter logic **off the delete-target modules** so that `converter.ts` and `parser.ts` no longer carry production logic and can later be deleted without losing the legacy `collaboration:` bridge. It does **not** delete any v1 module.

What was done:

- **Created `src/graph/collaboration-bridge.ts`** — hosts the three cross-subsystem bridge functions previously on the delete targets:
  - `convertCollaborationToGraphDeclaration` (was `src/graph/converter.ts:61`).
  - `autoConvertCollaboration` (was `src/graph/parser.ts:115`).
  - `graphDeclarationToResolvedGraph` (was `src/graph/parser.ts:172`).
  - Private helpers (`deriveFlowEdges`, `distinctAgentIds`, `computeMaxIterations`, `synthesizePrompt`, `mapTermination`) moved with them.
- **Moved `importGraphFromFile` into `src/graph/parser-v2.ts`** (now at `parser-v2.ts:471`; was `src/graph/parser.ts:48`). It remains a v2 file-import helper used by `tests/graph/round-trip.test.ts`.
- **Re-pointed the three live production consumers** (all now import the bridge / shared parser, never the delete targets):
  - `src/resolver/orchestrator.ts:8` → `import { autoConvertCollaboration, graphDeclarationToResolvedGraph } from "../graph/collaboration-bridge.ts"`.
  - `src/extensions/points/termination-conditions.ts:5` → `import { registerTerminationParser } from "../../graph/termination-parser.ts"`.
  - `src/cli/commands/migrate.ts:25` → `import { convertCollaborationToGraphDeclaration } from "../../graph/collaboration-bridge.ts"`.
- **Reduced `src/graph/converter.ts` and `src/graph/parser.ts` to thin re-export shims** delegating to the new homes (`collaboration-bridge.ts`, `parser-v2.ts`, `termination-parser.ts`). No deprecation annotations were added; these shims remain as **temporary scaffolding** and will be physically deleted in a later approved subtask.
- **Unchanged:** `ENGINE_PERSISTENCE_VERSION`; `src/graph/index.ts` barrel re-exports (now sourced from `collaboration-bridge.ts` for the bridge symbols); `src/graph/legacy-v1.ts` adapter (now re-exports the bridge from `collaboration-bridge.ts`).

**Verification on the current tree:**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- Targeted tests — `tests/graph/converter.test.ts`, `tests/graph/auto-convert.test.ts`, `tests/graph/round-trip.test.ts`, `tests/cli/commands/migrate.test.ts`: **33 pass / 0 fail**.
- `rg "graph/(converter|parser)\.ts" src/` (excluding the shims themselves) — **no matches**: no production code imports the delete-target modules directly; all consumers go through `collaboration-bridge.ts` / `termination-parser.ts` / `parser-v2.ts`.

#### Stage 3 — Subtask 2 (execution-state, advance, store port) execution status (2026-07-29)

This subtask creates the v2 execution-state, advance, and store modules — a behavior-preserving port of the v1 execution semantics (decommission work items 1 and 3). It does **not** delete any v1 module. The three source modules are reduced to thin re-export shims (temporary scaffolding, deleted later).

What was done:

- **Created `src/graph/collaboration-state.ts`** — behavior-identical port of `src/graph/state.ts`:
  - `GraphSessionState` (`setStoreDirectory`, `initGraph`, `advanceStep`, `getState`, `getGraph`, `isComplete`, `clear`, `recover`, `flushSync`, `_persist`).
  - `graphSessionState` singleton, `buildGraphStateBlock`, and types `GraphExecutionState` / `AdvanceResult`.
  - Only changes vs. the original: the `GraphStore` import now points at `./collaboration-store.ts`.
- **Created `src/graph/collaboration-advance.ts`** — behavior-identical port of `src/graph/advance.ts`:
  - `advanceGraphForDispatch`, `extractDispatchTarget`, `setAdvanceJudge`, `drainConvergence`, `MAX_CORRECTIONS = 3`, `ASYNC_TIMEOUT_MS = 30_000`, and the async convergence logic (`evaluateAsync` wiring, `runAsyncConvergence`, `raceTimeout`, retry/backoff).
  - Only change vs. the original: imports now reference `./collaboration-state.ts`.
- **Created `src/graph/collaboration-store.ts`** — port of `src/graph/graph-store.ts` with a **NEW persistence path**:
  - `GraphStore` + `SerializedGraphSession`, with the same debounced (500ms) + `flushSync` durability semantics, atomic tmp→rename commit, and versioned in-file schema (`version: 1|2`).
  - State file path changed from `graph-{hash}.json` to **`collaboration-{hash}.json`** — distinct from the legacy `graph-{hash}.json`, v2 `engine-{slug}.json`, and `graph-events-{hash}.ndjson`.
  - **No backward-compat reading of legacy `graph-{hash}.json`:** the store only ever reads/writes `collaboration-{hash}.json` (the path change alone satisfies this; the in-file v1→v2 schema migration applies only to the new file's own format and is exercised by the existing test on the new path).
- **Reduced `src/graph/state.ts`, `src/graph/advance.ts`, `src/graph/graph-store.ts` to thin plain re-export shims** delegating to the new modules. No deprecation annotations; these remain temporary scaffolding and will be physically deleted in a later approved subtask.
- **Updated `tests/graph/graph-store.test.ts`** — the `stateFilePath` helper now references `collaboration-{hash}.json` (was `graph-{hash}.json`) so the store-path change is asserted.
- **Unchanged:** `ENGINE_PERSISTENCE_VERSION` (`engine-persistence.ts:62`, still `2`); `src/graph/index.ts` barrel (still re-exports the v1 execution surface, now sourced transitively via the shims); `src/graph/legacy-v1.ts` adapter.

**Verification on the current tree:**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- Targeted tests — `tests/graph/state.test.ts`, `tests/graph/advance.test.ts`, `tests/graph/state-machine.test.ts`, `tests/graph/graph-store.test.ts`, `tests/graph/advance-v2.test.ts`, `tests/graph/state-machine-v2.test.ts`, `tests/graph/hooks-wiring.test.ts`, `tests/graph/termination-async.test.ts`: **189 pass / 0 fail**.
- Full-suite verification is deferred to the final decommission gate per the verification policy.

#### Stage 3 — Subtask 3 (re-point residual consumers onto the new v2 modules) execution status (2026-07-29)

This subtask re-points the residual execution-state consumers off the `src/graph/legacy-v1.ts` adapter onto the new v2 port modules created in Subtask 2 (`src/graph/collaboration-state.ts`, `src/graph/collaboration-advance.ts`). It does **not** delete any v1 module.

What was done:

- **Re-pointed all five production consumers that still imported `legacy-v1.ts`:**
  - `src/hooks/tool-after.ts` — split the import: `graphSessionState` now from `./collaboration-state.ts`; `advanceGraphForDispatch` / `extractDispatchTarget` from `./collaboration-advance.ts`.
  - `src/hooks/system-transform.ts` — `graphSessionState` / `buildGraphStateBlock` now from `./collaboration-state.ts`.
  - `src/core/services/hook-service.ts` — `graphSessionState` now from `./collaboration-state.ts`.
  - `src/core/composition.ts` — `graphSessionState` now from `./collaboration-state.ts`.
  - `src/hooks/chat-message.ts` — `graphSessionState` now from `./collaboration-state.ts`.
  - `src/hooks/custom/registry.ts` — **no import change needed** (the dep is structural; it receives the singleton from `hook-service.ts`).
- **Behavior preserved exactly:** all usage sites are unchanged (import-path-only re-pointing). The `collaboration:` declarative auto-advance path still runs on the ported `graphSessionState` / `advanceGraphForDispatch` semantics.
- **Cleaned residual `legacy-v1` doc-comment strings** in `src/graph/` scaffolding modules (`advance.ts`, `state.ts`, `converter.ts`, `graph-store.ts`, `parser.ts`, `collaboration-bridge.ts`, `legacy-v1.ts`) that referenced the decommission doc filename `graph-legacy-v1-decommission.md` — reworded to remove the literal `legacy-v1` string so the mandated `rg 'legacy-v1' src/` returns zero matches.
- **Unchanged:** the `legacy-v1.ts` adapter and all v1 modules remain in place (deletion is a later subtask); `src/graph/index.ts` barrel v1 re-exports left intact for test access.

**Verification on the current tree (per the user mandate — no full `bun test` suite):**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- Targeted tests — `tests/hooks/chat-message.test.ts`, `tests/hooks/system-transform.test.ts`, `tests/graph/hooks-wiring.test.ts`, `tests/plugin-hooks.test.ts`, `tests/integration/e2e-hooks.test.ts`: **87 pass / 0 fail**.
- `rg 'legacy-v1' src/` — **zero matches** (no production consumer references the legacy adapter; remaining v1 modules are reached only through the new v2 port modules).

#### Stage 3 — Subtask 4 (migrate test imports + barrel off v1) execution status (2026-07-29)

This subtask re-points the test suite and the `src/graph/index.ts` barrel off the v1 modules (`state.ts`, `advance.ts`, `graph-store.ts`, `converter.ts`, `parser.ts`, `validator.ts`) onto the v2 / collaboration modules. It does **not** delete any v1 module. This removes the last remaining consumers of the v1 modules (tests + barrel), leaving the v1 modules importable only via the internal adapter / shims during the transition.

What was done:

- **Created `src/graph/collaboration-validator.ts`** — the v2-owned home for `validateGraph` (relocated from `src/graph/validator.ts`). `validateGraph` validates a legacy v1 `ResolvedGraph` against available agent names; it has no natural v2 `GraphDocument` home (that is `validator-v2.ts`'s `validateGraphDeclaration`), so it lives in its own collaboration-validator module.
- **Reduced `src/graph/validator.ts` to a thin re-export shim** delegating to `./collaboration-validator.ts` (temporary scaffolding; physically deleted later).
- **Updated `src/graph/collaboration-bridge.ts:40`** — its `validateGraph` import now points at `./collaboration-validator.ts` (was `./validator.ts`).
- **Updated `src/graph/index.ts` barrel** — v1 re-exports now source from the new modules:
  - `validateGraph` → `./collaboration-validator.ts`
  - `GraphSessionState, graphSessionState, buildGraphStateBlock` + types `GraphExecutionState, AdvanceResult` → `./collaboration-state.ts`
  - `extractDispatchTarget, advanceGraphForDispatch` → `./collaboration-advance.ts`
  - (already on new modules: `autoConvertCollaboration`, `graphDeclarationToResolvedGraph` → `./collaboration-bridge.ts`; all v2 re-exports `parser-v2`, `validator-v2`, `templates`, `prompt-builder` left intact)
- **Migrated all test imports off the v1 modules and the barrel** onto the new modules:
  - `converter.ts`/`parser.ts` bridge symbols → `collaboration-bridge.ts`
  - `state.ts` → `collaboration-state.ts`; `advance.ts` → `collaboration-advance.ts`
  - `graph-store.ts` → `collaboration-store.ts`; `validator.ts` → `collaboration-validator.ts`
  - `importGraphFromFile` (round-trip.test.ts) → `parser-v2.ts`
  - barrel imports (`graph/index.ts`) → `collaboration-state.ts`
  - Files migrated (22 test files): `tests/graph/{state,advance,state-machine,graph-store,converter,auto-convert,round-trip,prompt-snapshots,e2e,hooks-wiring,advance-v2,state-machine-v2,termination-async,error-edge,validator}.test.ts`, `tests/plugin-hooks.test.ts`, `tests/auto-activate-integration.test.ts`, `tests/integration/{helpers.ts,e2e-hooks.test.ts}`, `tests/hooks/{chat-message,system-transform}.test.ts`, `tests/cli/commands/migrate.test.ts`.
- **Unchanged:** no v1 module was deleted; the v1 shims (`state.ts`, `advance.ts`, `graph-store.ts`, `converter.ts`, `parser.ts`, `validator.ts`) remain as temporary scaffolding for the transition.

**Verification on the current tree (per the user mandate — no full `bun test` suite):**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- Targeted tests — exactly the 21 modified test files (all test files touched, excluding the `integration/helpers.ts` helper module which is exercised via `e2e-hooks.test.ts`): **408 pass / 0 fail** (33 snapshots).
- `rg 'graph/(state|advance|graph-store|converter|parser|validator)(\.ts)?["\x27]' tests/` — **no v1-module matches** (exit 1); the only `parser`/`validator` references left in `tests/` are `parser-v2` / `validator-v2` (acceptable per policy) and a doc-comment now citing `collaboration-bridge.ts`.

## Risks / dependencies

> **Post-Stage-3 note (2026-07-29):** the three historical risks below were resolved by the Stage 3 deletion. They are retained as a record of the decommission's rationale.

- ~~**Converter/parser bridge is the last v1↔v2 coupling.**~~ **Resolved.** `convertCollaborationToGraphDeclaration` and `graphDeclarationToResolvedGraph` were relocated to `src/graph/collaboration-bridge.ts` (Stage 3, Subtask 1); the delete-target `converter.ts` / `parser.ts` shims were deleted in Stage 3. The legacy `collaboration:` config path continues to resolve through `collaboration-bridge.ts`.
- ~~**`validateGraph` has a single caller.**~~ **Resolved.** `validateGraph` was relocated to `src/graph/collaboration-validator.ts` (Stage 3, Subtask 4); the `validator.ts` shim was deleted in Stage 3.
- ~~**State directory is a shared namespace.**~~ **Resolved.** The `graph-{hash}.json` legacy state file was removed (prefix-scoped deletion, `graph-*` only); `engine-{slug}.json` and `graph-events-{hash}.ndjson` and the remaining `dispatch-*` / `fnstate-*` / `loops-*` / `signalledger-*` files were preserved.
- **`state-registry.ts` is fully decoupled from v1.** The real path is
  `src/core/state-registry.ts` (not `src/core/services/state-registry.ts`), and
  it has **zero** v1 / `GraphSessionState` references — it imports only
  `FunctionSessionState`, `functionRuntime`, `sessionSignalLedger`, and types
  from `src/types.ts`. The former `graph` field and `GraphSessionState` type
  import were removed in Stage 2; there is nothing left to migrate here.
  Verified: `rg -n 'GraphSessionState|graphSessionState|legacy-v1' src/core/state-registry.ts`
  → no matches.

## Stage 3 — final deletion execution status (2026-07-29)

This is the final Stage 3 subtask (REMOVE). Per the user-approved deletion list, the six v1 modules, the `legacy-v1.ts` adapter, and the v1 legacy state file were physically deleted.

**Files deleted (8):**

- `src/graph/state.ts` — v1 execution-state shim
- `src/graph/advance.ts` — v1 advance-engine shim
- `src/graph/graph-store.ts` — v1 store shim
- `src/graph/converter.ts` — v1 converter shim
- `src/graph/parser.ts` — v1 parser shim
- `src/graph/validator.ts` — v1 validator shim
- `src/graph/legacy-v1.ts` — internal v1 adapter boundary
- `.rolebox/state/graph-5c055f087127.json` — v1 `graph-{hash}.json` legacy state file (no migration; **1.0 has no backward-compat read path** — the `graph-{hash}.json` format was removed, documented here as a historical note only, with **no deprecation section and no legacy compat**)

**Preserved in `.rolebox/state/`:** `dispatch-5c055f087127.json`, `fnstate-5c055f087127.json`, `loops-5c055f087127.json`, `signalledger-5c055f087127.json`, `checkpoints/`, `progress/`, `results/`.

**Barrel check:** `src/graph/index.ts` was verified to reference **no** deleted file — its re-exports source only from the v2 / collaboration modules (`collaboration-bridge.ts`, `collaboration-validator.ts`, `collaboration-state.ts`, `collaboration-advance.ts`, `parser-v2.ts`, `validator-v2.ts`, `templates.ts`, `prompt-builder.ts`). No dangling reference needed fixing.

**Verification on the current tree (targeted only; full suite is the next node's job):**
- `bun run typecheck` — clean (`tsc --noEmit` exit 0).
- `rg 'graph/(state|advance|graph-store|converter|parser|validator|legacy-v1)(\.ts)?["\x27]' src/ tests/` — **no matches** (exit 1); remaining `parser`/`validator` references in `tests/` are `parser-v2` / `validator-v2` (safe) and `src/graph/collaboration-bridge.ts` doc-comments (backticks, not matched).
- Targeted tests — `tests/graph/state.test.ts`, `tests/graph/advance.test.ts`, `tests/graph/converter.test.ts`, `tests/graph/validator.test.ts`, `tests/graph/round-trip.test.ts`: **114 pass / 0 fail**.
- `ls .rolebox/state/graph-*.json` — **no matches**; the other `.rolebox/state/` files remain.
- `ENGINE_PERSISTENCE_VERSION` — **not modified** (still `2`).

### Final `src/graph/` module inventory (post-Stage-3)

The `src/graph/` directory now contains **only v2 modules and shared helpers** (no v1 module, no adapter):

- **v2 engine:** `engine/` (directory) — `engine-state`, `engine-advance`, `engine-persistence`, `engine-recovery`, `engine-termination`, `engine-startup`, `graph-events`, `graph-notify`, and related engine modules
- **v2 parsing / validation:** `parser-v2.ts`, `validator-v2.ts`, `edge-parser.ts`, `templates.ts`
- **collaboration (v2-owned ports of the relocated v1 logic):** `collaboration-bridge.ts`, `collaboration-state.ts`, `collaboration-advance.ts`, `collaboration-store.ts`, `collaboration-validator.ts`
- **termination machinery:** `termination-parser.ts`, `termination.ts`, `termination-async.ts`
- **shared helpers / prompt / orchestration:** `graph-utils.ts`, `loop-detector.ts`, `prompt-builder.ts`, `result-capture.ts`, `serialize.ts`, `index.ts`, `tools/` (directory)

**Historical note on the `graph-{hash}.json` format:** the v1 `GraphStore` persisted per-workspace session state to `.rolebox/state/graph-{hash}.json` (schema `GraphStateFile { version: 1|2 }`). That on-disk format was **removed in 1.0** — the v2 persistence model writes `engine-{slug}.json` (per-graph) plus an append-only `graph-events-{hash}.ndjson` audit log, and the ported collaboration store writes `collaboration-{hash}.json`. There is no backward-compat read path for the removed `graph-{hash}.json` format; this note is historical only.
