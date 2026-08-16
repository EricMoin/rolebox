# Graph Execution Engine v2 — Architecture Map

Canonical architecture map of the v2 graph execution engine in
`src/graph/engine/*`. All file:line anchors were verified against the current
source at the time of writing; where a range in the task brief differed from
the actual file after reading, the verified line numbers are used and the
correction is noted inline.

- Engine version: **2.0** (barrel banner, `src/graph/engine/index.ts:1-27`)
- Design reference (intended, not present on disk — see CONFIRMED-GAPS **a**):
  `.rolebox/design/engine-state-machine.md`

---

## 1. Engine module map

The engine is a **role-agnostic primitive**: one `EngineRuntime` owns one
`EngineState` and one signal-driven `AdvanceEngine`, wired together through
injectable seams (`dispatch`, `budget`, `persistence`, `conditionResolver`,
`onNodeCompletion`, `graphEvents`, `onGraphTerminal`). Consumers construct it
via `createEngine()` and drive the lifecycle `provision() → run() →
status()`, with `recover()`, `cancel()`, `approveNode()`/`rejectNode()`/
`partialApprove()`, `retryNode()`, and `cancelNodes()` as the control surface
(`index.ts:107-257`).

All 23 modules below live in `src/graph/engine/`.

| # | Module | Responsibility | Key entry points | Anchor |
|---|--------|----------------|------------------|--------|
| 1 | `index.ts` | Public engine API barrel + `EngineRuntime`/`EngineRuntimeImpl` orchestration. Constructs the state, dispatch/budget/signal/persistence seams, and the advance engine; exposes the full lifecycle. | `createEngine`, `EngineRuntimeImpl`, `provision`, `run`, `recover`, `adoptPrior`, `status`, `cancel`, `approveNode`, `rejectNode`, `partialApprove`, `retryNode`, `cancelNodes` | `index.ts:820` (createEngine), `index.ts:448` (class), `index.ts:107-257` (interface) |
| 2 | `engine-state.ts` | Engine-state factory: the `idle → executing → complete` phase machine, frontier management, node registration, the `advancingLock` re-entrancy guard, loop-group runtime state, budget accumulation, signal-contract injection. | `createEngineState`, `canTransitionPhase`, `transitionPhase`, `provision`, `registerNode`, `computeInDegrees`, `getRootNodeIds`, `addToFrontier`, `removeFromFrontier`, `acquireAdvancingLock`, `releaseAdvancingLock`, `applyBudgetDelta`, `buildSignalContract`, `injectSignalContracts`, `recordConvergenceOutput`, `resetConvergenceTracker`, `incrementLoopTraversal` | `engine-state.ts:147` (createEngineState), `engine-state.ts:107-111` (phase table), `engine-state.ts:300` (provision) |
| 3 | `engine-advance.ts` | Core signal-driven advancement algorithm. Reacts to terminating signals: transitions node lifecycle, evaluates outbound edges, checks downstream joins, dispatches ready nodes, checks termination — all inside the `_runCriticalSection` lock. | `AdvanceEngine`, `onNodeSignalEmitted`, `dispatchReady`, `register`, `_advance`, `_runCriticalSection`, `_buildEdgePayload`, `_forwardAnswerOnApproval`, `approveNode`, `rejectNode`, `partialApprove`, `retryNode`; ports `NodeDispatchPort`, `GraphBudgetPort` | `engine-advance.ts:322` (class), `engine-advance.ts:387` (onNodeSignalEmitted), `engine-advance.ts:482` (_runCriticalSection) |
| 4 | `engine-persistence.ts` | Unified on-disk store for `EngineState`: write-through atomic save, debounced save, versioned load, serialize/deserialize, dirty-flag helpers. | `EnginePersistence`, `save`, `scheduleSave`, `flush`, `load`, `serializeEngineState`, `deserializeEngineState`, `loadEngineStateFromJson`, `markDirty`, `shouldPersist` | `engine-persistence.ts:413` (class), `engine-persistence.ts:258` (serialize), `engine-persistence.ts:534` (loadEngineStateFromJson) |
| 5 | `engine-recovery.ts` | Crash recovery + dispatch→signal reconcile: reconcile `running` nodes against the dispatch system, shared status→signal mapping, frontier rebuild, state hydration/adoption, stale-lock sweeper. | `mapDispatchStatusToSignal`, `subscribeTaskTermination`, `reconcileEngine`, `rebuildFrontier`, `hydrateEngineState`, `adoptPriorNodeStates`, `clearStaleCriticalSection`, `EngineLockSweeper` | `engine-recovery.ts:148` (mapping), `engine-recovery.ts:277` (reconcileEngine), `engine-recovery.ts:564` (sweeper) |
| 6 | `engine-startup.ts` | Plugin-startup recovery sweep: walks the `.rolebox/state/engine-*.json` store and resumes every interrupted graph via `createEngine` + `recover()`, with per-graph failure isolation. | `recoverInterruptedGraphs`, `RecoveryStartupReport` | `engine-startup.ts:127` (recoverInterruptedGraphs) |
| 7 | `engine-termination.ts` | Graph-termination checker: transitions `executing → complete` when no active node remains, or fires a quiescent-blocked terminal event; dedupes terminal events. | `checkGraphTermination`, `GraphTerminalEvent`, `TerminationContext` | `engine-termination.ts:72` (checkGraphTermination) |
| 8 | `signal-bridge.ts` | Read-only seam over the signal subsystem: records a signal into `signalsObserved` + the graph `signalLedger`, then fires terminating-signal listeners. Imports the 8-signal vocabulary from `signal-constants.ts`. | `SignalBridge`, `record`, `onNodeSignalEmitted`, `isTerminating`, `isPausing`, `isHandoff`, `isInfo` | `signal-bridge.ts:63` (class), `signal-bridge.ts:98` (record) |
| 9 | `signal-propagation.ts` | The two propagation lanes complementing forward `answer` flow: `propagateRevise` (back-edge re-entry + stuck/cap enforcement) and `propagateEscalate` (worst-signal forward propagation + retry gate). Pure state mutation. | `propagateRevise`, `propagateEscalate`, `SignalPropagationReport` | `signal-propagation.ts:178` (propagateRevise), `signal-propagation.ts:290` (propagateEscalate) |
| 10 | `node-lifecycle.ts` | Generic per-node lifecycle state machine. One transition table shared by all nodes; legality is a pure function of `(from, to)`. | `VALID_NODE_TRANSITIONS`, `canTransitionNode`, `transitionNode`, `markNodeBlocked`, `markReady`, `markRunning`, `markCompleted`, `markEscalated`, `markTimedOut`, `markCancelled`, `markDone` | `node-lifecycle.ts:59-82` (transition table), `node-lifecycle.ts:122` (transitionNode) |
| 11 | `join-evaluator.ts` | Join (fan-in) evaluator: pure graph-theoretic fan-in with `all` / `any` / `quorum:N` strategies; evaluates joins, merges upstream payloads, identifies revise back-edges. | `resolveJoinStrategy`, `getJoinStrategy`, `isReviseBackEdge`, `getUpstreamNodeIds`, `evaluateJoin`, `joinSatisfied`, `collectUpstreamResults`, `mergeFanInContext` | `join-evaluator.ts:201` (evaluateJoin), `join-evaluator.ts:341` (joinSatisfied) |
| 12 | `loop-group-executor.ts` | Loop-group orchestration: coalesced bounded-cycle step (`executeLoopStep`) deciding the §4.3 soft early-exits (converged / revising / stuck / max_traversals_exhausted / escalating). | `executeLoopStep`, `extractUnresolved`, `LoopOutcome`, `LoopStepReport` | `loop-group-executor.ts:255` (executeLoopStep) |
| 13 | `cancellation.ts` | Scoped / cascade cancellation primitive: cancel named node ids (loop-targets expand to their full member set) and optionally their transitive downstream. | `cancelNodes`, `expandLoopMembers` | `cancellation.ts:223` (cancelNodes), `cancellation.ts:142` (expandLoopMembers) |
| 14 | `cascade-canceller.ts` | Auto-cancellation half of fan-in: retire still-pending upstreams once a convergence node's join resolves (satisfied / failed). | `cancelPendingUpstreams`, `CancelDispatchPort`, `CascadeCancelReport` | `cascade-canceller.ts:119` (cancelPendingUpstreams) |
| 15 | `node-retry.ts` | Node retry (re-open / re-dispatch): pure `resetNodeForRetry` + engine-facing `retryNode` orchestration. | `resetNodeForRetry`, `retryNode`, `RetryNodeOptions`, `RetryReport` | `node-retry.ts:135` (resetNodeForRetry), `node-retry.ts:205` (retryNode) |
| 16 | `approval-handler.ts` | Pure state-mutation primitives for the `needs_approval` gate lifecycle: approve, reject, partial-approve pruning + rejected-upstream re-entry. | `approveBlockedNode`, `rejectBlockedNode`, `pruneDownstreamSubgraph`, `reenterRejectedUpstreams`, `resetRejectedUpstreams`, `mergeRejectionFeedback` | `approval-handler.ts:110` (approveBlockedNode), `approval-handler.ts:219` (pruneDownstreamSubgraph) |
| 17 | `approval-payload.ts` | Builds the structured `ApprovalPayload` (node identity, graph context, upstream result summaries) a blocked `needs_approval` node carries for the human. | `buildApprovalPayload`, `ApprovalPayload`, `ApprovalUpstreamResult` | `approval-payload.ts:138` (buildApprovalPayload) |
| 18 | `recorder.ts` | Runtime recorders (subtask C-RECORD): lifecycle checkpoints, loop round history, node artifacts/evidence — written only from real observed data. | `recordCheckpointForNode`, `recordLoopRound`, `deriveNodeArtifacts`, `deriveNodeEvidence`, `recordNodeArtifactsAndEvidence` | `recorder.ts:58` (recordCheckpointForNode), `recorder.ts:85` (recordLoopRound) |
| 19 | `graph-events.ts` | Write-side durable, append-only JSON-lines event log for a graph instance (node dispatch/completion, phase change, budget update). Total — never throws. | `GraphEventRecorder`, `graphEventsHash`, `graphEventsPath`, `GraphEventType` | `graph-events.ts:128` (class), `graph-events.ts:102` (hash) |
| 20 | `graph-notify.ts` | Node-completion + graph-terminal notifiers: inject `<system-reminder>`s into the emperor session via the engine's DI seams, with per-run dedupe. | `createGraphNotifier`, `createGraphTerminalNotifier`, `buildGraphCompletionText`, `buildGraphTerminalText` | `graph-notify.ts:141` (createGraphNotifier), `graph-notify.ts:260` (createGraphTerminalNotifier) |
| 21 | `dispatch-bridge.ts` | Read-only seam over `DispatchManager`: the engine's only touchpoint into the dispatch subsystem. Executes nodes and builds graph-scoped parent contexts. | `DispatchBridge`, `executeNode`, `graphParentContext`, `DEFAULT_GRAPH_AGENT`, `DispatchParentContext` | `dispatch-bridge.ts:104` (class), `dispatch-bridge.ts:166` (executeNode) |
| 22 | `budget-bridge.ts` | Read-only seam over the budget subsystem: graph-level budget check; per-node check is a Phase-7 stub. | `BudgetBridge`, `checkGraphBudget`, `getGraphUsage`, `checkNodeBudget` | `budget-bridge.ts:45` (class), `budget-bridge.ts:80` (checkNodeBudget stub) |
| 23 | `condition-resolver.ts` | Default `on_condition` edge resolver: evaluates `signal_observed(<type>)` and `artifact_exists(<name>)` against a source node; unknown conditions are false. | `defaultConditionResolver`, `EdgeConditionResolver` | `condition-resolver.ts:54` (defaultConditionResolver) |

---

## 2. Core mechanisms

### 2.1 Engine lifecycle: `idle → executing → complete`

The engine phase machine is a forward-only linear transition:

```
idle → executing → complete
```

The phase table is defined in `engine-state.ts:107-111`:

```ts
const VALID_PHASE_TRANSITIONS: Record<EnginePhase, readonly EnginePhase[]> = {
  idle: [EnginePhase.Executing],
  executing: [EnginePhase.Complete],
  complete: [],
};
```

- `canTransitionPhase(state, to)` (`engine-state.ts:114-116`) checks legality.
- `transitionPhase(state, to)` (`engine-state.ts:123-139`) applies it, marks
  the state dirty, and fires the optional `phaseEventSink`.
- The `idle → executing` hop happens inside `_runCriticalSection`
  (`engine-advance.ts:444-449`) — the first advancement critical section moves
  the engine out of `idle`. `dispatchReady()` (`engine-advance.ts:383`) and
  `_advance` both funnel through this.
- `executing → complete` happens in `checkGraphTermination`
  (`engine-termination.ts:108-110`) when no node remains active.

> Note: `node-retry.ts` deliberately writes the phase back to `executing` when
> retrying a terminal graph (`node-retry.ts:181-185`) — this is an explicit
> re-open, not a phase-machine transition, since the table has no
> `complete → executing` edge.

### 2.2 Per-node lifecycle state machine

The single generic node state machine is defined by
`VALID_NODE_TRANSITIONS` at `node-lifecycle.ts:59-82` (verified range; the
task brief's `59-82` matches exactly):

| from | legal transitions |
|------|-------------------|
| `pending` | `ready`, `cancelled`, `escalate` |
| `ready` | `running`, `cancelled` |
| `running` | `completed`, `escalate`, `timeout`, `cancelled`, `blocked` |
| `completed` | `done`, `ready`, `escalate` |
| `blocked` | `completed`, `ready`, `escalate` |
| `timeout` | `done` |
| `escalate` | `done`, `ready` |
| `cancelled` | `done` |
| `done` | _(terminal — none)_ |

- `canTransitionNode(from, to)` (`node-lifecycle.ts:85-87`) and
  `assertValidNodeTransition` (`node-lifecycle.ts:92-99`) enforce legality.
- `transitionNode` (`node-lifecycle.ts:122-166`) is the single choke point
  that applies every convenience transition (`markReady`, `markRunning`, …)
  and auto-saves a lifecycle checkpoint via
  `recordCheckpointForNode` (`node-lifecycle.ts:163`).

### 2.3 `advancingLock` critical section

The advancement critical section is `AdvanceEngine._runCriticalSection` at
`engine-advance.ts:482-518` (verified range).

- The lock lives on `EngineState.advancingLock` (`engine-state.ts:522-539`,
  `acquireAdvancingLock` / `releaseAdvancingLock`).
- `_advanceSignal` (`engine-advance.ts:420-432`): if the lock is already held,
  the incoming node completion is deferred to `pendingCompletions` and returns
  immediately; otherwise it runs the work inside `_runCriticalSection`.
- `_runCriticalSection` (`engine-advance.ts:482-518`): ensures the engine is
  `executing`, runs the work, and in `finally` releases the lock, routes the
  write through the two-tier persistence seams (`persistState` for critical,
  `schedulePersistState` for non-critical, `flushPersistState` on terminal)
  only when `isDirty` / `isNonCriticalDirty` (`shouldPersist`/`clearDirty`/
  `shouldPersistNonCritical`/`clearNonCriticalDirty`,
  `engine-persistence.ts:93,102,127,137`), and drains deferred completions via
  `_drainDeferred` (`engine-advance.ts:529-542`).
- This mirrors the proven `coordinator.ts:397-404` (defer under lock) and
  `450-462` (drain in `finally`) pattern (module doc, `engine-advance.ts:13-19`).

### 2.4 Signal vocabulary

The 8-signal vocabulary is defined exactly once in
`src/signal/signal-constants.ts` (single source of truth):

| Signal | Category | Behavior |
|--------|----------|----------|
| `answer` | terminating | Node completed; forward `answer` data flow runs |
| `revise_needed` | terminating | Reviewer finished; back-edge re-entry / escalate on cap |
| `escalate` | terminating | Unrecoverable failure; worst-signal forward propagation |
| `need_approval` | pausing | `running → blocked`; awaits human |
| `blocked` | pausing | Node awaiting human (engine-side state) |
| `need_clarification` | pausing | Awaits clarification |
| `handoff` | handoff | Routes work elsewhere without terminating |
| `progress` | info | No state transition; observability only |

- Vocabulary constants: `SIGNAL_TYPES` / `SIGNAL_TYPE`
  (`signal-constants.ts:12-36`), category sets `TERMINATING_SIGNALS`
  (`:39`), `PAUSING_SIGNALS` (`:42`), `HANDOFF_SIGNALS` (`:45`),
  `INFO_SIGNALS` (`:48`), `ALL_SIGNAL_TYPES` (`:51-56`).
- Severity ordering for picking which recorded terminating signal to replay:
  `escalate > revise_needed > answer` — `TERMINATING_SIGNALS_BY_SEVERITY`
  (`signal-constants.ts:64`) and the engine's `TERMINATING_SEVERITY`
  (`engine-advance.ts:258-262`).
- Synthetic inferred completion: `SYNTHETIC_ANSWER_SIGNAL`
  (`signal-constants.ts:80-83`); the completion evaluator infers `answer` with
  `{ __inferred: true }` when a task finishes without calling `signal()`.
- The engine re-exports the vocabulary from `signal-bridge.ts:29-37`.
- `need_approval` is special-cased: although `terminating` is false for it, it
  still drives an advancement critical section that transitions the node to
  `blocked` (`engine-advance.ts:361-368`, `_pauseForApproval` at
  `engine-advance.ts:1009-1021`).

### 2.5 `EdgePayload` data flow

`_buildEdgePayload` (`engine-advance.ts:757-778`) packages a node's terminating
signal into the downstream `EdgePayload` shape:

```ts
{
  fromNode: source.nodeId,
  fromSignal: signalType,
  result,                       // string payload, or JSON.stringify
  artifacts: source.artifacts ?? deriveNodeArtifacts(source),  // resolved — gap (f)
  budgetConsumed: { tokens, cost, sessions },
}
```

- On `answer`, the advance engine iterates the source's outbound edges
  (`engine-advance.ts:543-624`), applies each edge's `data_passthrough`
  transform (`applyDataMapping`), records the upstream result via
  `collectUpstreamResults` (`join-evaluator.ts:357-365`), and activates a
  satisfied target (`pending → ready`, or `completed → ready` loop re-entry).
- The approval-resume path shares the same forward activation via
  `_forwardAnswerOnApproval` → `_forwardActivation`
  (`engine-advance.ts:1191-1200`, shared helper at `engine-advance.ts:1212`).
- Join satisfaction uses `evaluateJoin` / `joinSatisfied`
  (`join-evaluator.ts:201-343`).
### 2.6 Persistence model

The persistence model is `EnginePersistence` at `engine-persistence.ts:413-523`
(verified range).

- On-disk path: `.rolebox/state/engine-{slug}.json`
  (`engineStatePath`, `engine-persistence.ts:388-395`).
- Schema version: `ENGINE_PERSISTENCE_VERSION = 2`
  (`engine-persistence.ts:62`).
- `save` (`engine-persistence.ts:431`): synchronous, atomic
  (`.tmp` + `unlinkSync` + `renameSync`, `_write` at `505-523`); never throws
  (write failure logs and the engine continues in memory).
- `load` (`engine-persistence.ts:480`): returns `null` on missing/corrupt/
  version-mismatch (clean start). `loadEngineStateFromJson`
  (`engine-persistence.ts:534-557`) is the version-gated, testable parser.
- `scheduleSave` (debounced, `engine-persistence.ts:445-456`,
  `NON_CRITICAL_DEBOUNCE_MS = 500` at `engine-persistence.ts:65`) and `flush`
  (`engine-persistence.ts:462-475`) are **wired**, not dead code — see
  CONFIRMED-GAPS **d**.
- **Two-tier durability policy (resolved — gap d).** Critical mutations
  (node lifecycle, graph phase, frontier, checkpoint records, approval state)
  write through synchronously via the `persistState` seam; non-critical churn
  (signal-ledger history, budget / per-node `tokensConsumed`) is routed through
  the debounced `schedulePersistState` seam. Both seams are invoked from the
  critical section's `finally` (`engine-advance.ts:501-509`), and a
  flush-on-terminate drains any pending debounced write when the engine reaches
  `complete` (`engine-advance.ts:510-517`). The seams are wired in
  `index.ts:515-521`. The class doc (`engine-persistence.ts:11-32`) documents
  this policy explicitly.
- `serializeEngineState` / `deserializeEngineState`
  (`engine-persistence.ts:198-307`) flatten `Map` fields to JSON-safe records.
- `isDirty` is never serialized — a recovered state always starts clean
  (`engine-persistence.ts:232-234`, `304-306`).
- Write-through is invoked from the critical section's `finally` via the
  `persistState` seam (`engine-advance.ts:501-504`).

### 2.7 Node timeout / liveness monitoring — tiered detection

A `running` node must never hang the graph silently. The engine detects
dead/stalled nodes through **four tiers**, in decreasing immediacy, each with a
documented fallback relationship (node-anomaly-detection feature):

| Tier | Name | Mechanism | Trigger | Result |
|------|------|-----------|---------|--------|
| **Tier 1** | Immediate failure (fast path) | `EngineRuntime.handleFeedSessionEvent` (`engine-advance.ts:1144-1211`, relayed from `index.ts:788`) | Platform liveness feed observes `session.deleted` (`gone` — authoritative) or `session.error` whose dispatch task is genuinely NOT live | Running node escalates immediately through the standard escalate advance (completion seam + ledger signal + cascade cancel) — the abnormal node never blocks graph advancement |
| **Tier 2** | Soft-stall warning | `NodeLivenessMonitor` (`engine-recovery.ts:991-1241`) | Heartbeat-fed running node idle `>= nodeStallWarnMs` (default `min(60s, staleTimeout/2)`) | Classified `stalling`, `stallWarnedAt` stamped, `onNodeStall` seam fires **once per stall episode** (a fresh episode after recovery re-fires) |
| **Tier 3** | Grace escalation (hard stall) | Same `NodeLivenessMonitor` tick | `stalling` node idle `>= stallWarnMs + stallGraceMs` (default grace 30s), capped by the per-node effective deadline `min(budget.timeout_ms, nodeStaleTimeoutMs)` | Marked `timeout` via the shared `markTimedOut` and funnels through the SAME `onStaleNodeTimeout` downstream as Tier 4 (escalate ledger signal + completion seam) |
| **Tier 4** | Wall-clock fallback | `NodeStalenessWatcher` (`engine-recovery.ts:893-989`) | A running node **without** a heartbeat feed (`liveness.lastActivityAt` absent) exceeds its staleness deadline from `startedAt` | Marked `timeout` + `onTimeout` → the same downstream as Tier 3 |

**Fallback / coexistence rules:**

- **Tiers 1–3 require a heartbeat feed** (`node.liveness.lastActivityAt`,
  written by the dispatch-time heartbeat / `recordLivenessHeartbeat` / the
  platform feed). A node WITHOUT a feed is **skipped by the liveness monitor**
  entirely and falls to Tier 4's pure wall-clock deadline
  (`engine-recovery.ts:1146` — "no feed — wall-clock fallback").
- **Tier 2 and Tier 3 are one ladder**: the monitor walks
  `healthy → stalling → stalled(timeout)` as idle grows; a fresh heartbeat
  returns a `stalling` node to `healthy` and re-arms a future episode
  (recovery-then-re-stall re-warns).
- **Tiers 3 and 4 share the same downstream handler** (`onStaleNodeTimeout`,
  `index.ts:721-736`): timeout → `notifyNodeTimeout` completion seam +
  `escalate` ledger signal, so a timed-out upstream cannot silently stall a
  fan-in join regardless of which tier fired.
- **Both monitors are opt-in**, instantiated together beside each other only
  when `nodeStaleTimeoutMs > 0` (`index.ts:684-701`), manually tickable with an
  injected clock for deterministic tests, and stopped on `cancel()` /
  `dispose()`. Without the option, engine behavior is byte-identical to the
  pre-feature engine (no watcher, no monitor, no liveness recording on load).
- **Liveness carrier is OPTIONAL-ADDITIVE**: `NodeRuntimeState.liveness`
  (`types.engine-v2.ts:261-294`) is absent for fresh/old nodes, serializes
  losslessly through `engine-persistence.ts` without a schema bump, and
  `graph_status` renders it only for recorded nodes (always for `running`,
  flag-gated `include_liveness` otherwise) — never fabricated.

The runtime's own monitor internal comments number the monitor-local ladder
"Tier 1 / Tier 2 / Tier 3" (soft / hard / no-feed) — that numbering is scoped
to the monitor class; the four-tier table above is the engine-wide detection
semantics.

---

## 3. CONFIRMED-GAPS table

Each finding was verified against the actual source. **Status key:** `RESOLVED`
= the gap has been fixed in source since the original survey; `PARTIAL` = the
gap is materially reduced but a residual aspect remains; `OPEN` = the gap still
stands as originally described. This table is a live status source, re-verified
against the current tree on 2026-07-29.

| Gap ID | Description | Status | Evidence (file:line) |
|--------|-------------|--------|----------------------|
| **a** | Dangling `.rolebox/design/*` references. The `.rolebox/design/` directory does **not exist** on disk, yet **30 files** (56 references) across `src/` point into it — e.g. every engine module's design-reference header, `types.engine-v2.ts`, `parser-v2.ts`, `validator-v2.ts`, `graph-tools.ts`. (Correction: the brief said "~28 files"; the verified count is **30**.) | **OPEN** | `ls .rolebox/design/` → `No such file or directory`; `rg -l '\.rolebox/design/' src/` → 30 files; representative: `engine-advance.ts:32`, `engine-state.ts:18`, `engine-persistence.ts:24-27` |
| **b** | Legacy v1 graph subsystem still wired. `src/graph/state.ts`, `src/graph/advance.ts`, `src/graph/graph-store.ts` remain live behind the internal `src/graph/legacy-v1.ts` adapter: `graphSessionState` / `advanceGraphForDispatch` are consumed by `hook-service.ts` (setStoreDirectory/recover + registered as a hook dep), `tool-after.ts` (advance-on-dispatch), plus `system-transform.ts`, `chat-message.ts`, `custom/registry.ts`, `composition.ts`, and `resolver/orchestrator.ts`. No v1 module is fully orphaned. | **RESOLVED** | The v1 modules (`src/graph/state.ts`, `advance.ts`, `graph-store.ts`, `converter.ts`, `parser.ts`, `validator.ts`) and the `legacy-v1.ts` adapter were deleted in the Stage 3 decommission. Consumers now import the ported v2 `collaboration-state.ts` / `collaboration-advance.ts` / `collaboration-store.ts` / `collaboration-bridge.ts` modules. `src/graph/` contains only v2 modules + shared helpers. See `docs/graph-legacy-v1-decommission.md`. |
| **c** | Dead `EngineState.edges` field. `createEngineState` initializes `edges: new Map()` at `engine-state.ts:159`, but nothing populates the field during normal execution (edges live on `graphDeclaration.edges`; `snapshotEngineState`/`hydrateEngineState` copy it, but the advance engine never writes it). Still present; no inline annotation marks it dead. | **OPEN** | `engine-state.ts:159` (`edges: new Map()`); only reads at `index.ts:396` (status serialization) and `engine-persistence.ts:278` (persist serialize) — never written by the advance engine |
| **d** | Dead `scheduleSave` / `flush`. **FIXED** — both are now wired as a two-tier durability policy. `scheduleSave` (debounced, `NON_CRITICAL_DEBOUNCE_MS = 500`) is called from the critical section's `finally` for non-critical-only mutations; flush-on-terminate drains any pending debounced write when the engine reaches `complete`. Wired via the `schedulePersistState` / `flushPersistState` seams in `index.ts`. | **RESOLVED** | `engine-advance.ts:501-509` (debounced non-critical branch), `engine-advance.ts:510-517` (flush-on-terminate); `index.ts:515-521` (seam wiring); `engine-persistence.ts:65` (`NON_CRITICAL_DEBOUNCE_MS`), `engine-persistence.ts:445` (`scheduleSave`), `engine-persistence.ts:462` (`flush`), class doc `engine-persistence.ts:11-32` |
| **e** | Signal-ledger bypass. **FIXED** — all four former direct-write sites now route through the shared `recordSignalToLedger` helper (which keeps `node.signalsObserved` and the graph `signalLedger` + timestamped history in sync). The approval-resume answer, the rejection revise_needed, the dispatch race-guard replay, and the approval-payload stash all call it. | **RESOLVED** | `signal-bridge.ts:85` (`recordSignalToLedger`), `approval-handler.ts:135` (answer), `approval-handler.ts:194` (revise_needed), `engine-advance.ts:911` (race-guard), `engine-advance.ts:1019` (approval_payload) |
| **f** | `EdgePayload.artifacts` is always `[]`. **FIXED** — `_buildEdgePayload` no longer hardcodes `artifacts: []`; it populates `source.artifacts ?? deriveNodeArtifacts(source)`. The two former sibling hardcodes (`approval-handler.ts`, `signal-propagation.ts`) are fixed identically. `rg 'artifacts: \[\]' src/graph/engine/` → ZERO matches. | **RESOLVED** | `engine-advance.ts:771` (`artifacts: source.artifacts ?? deriveNodeArtifacts(source)`); `approval-handler.ts:149`; `signal-propagation.ts:389`; consumed by `join-evaluator.ts:379-404` (mergeFanInContext) |
| **g** | Forward-`answer` duplication. **FIXED** — the live-signal `answer` forward-data-flow block and the approval-resume `_forwardAnswerOnApproval` now both delegate to a single shared helper `_forwardActivation`, eliminating the near-identical loops. | **RESOLVED** | `engine-advance.ts:603` (live-signal path calls `_forwardActivation`), `engine-advance.ts:1197` (`_forwardAnswerOnApproval` → `_forwardActivation`), shared helper def at `engine-advance.ts:1212` |
| **h** | Checkpoint last-wins. `recordCheckpointForNode` overwrites `state.checkpoints[node.nodeId]` with the latest snapshot on every transition. **PARTIAL** — the primary `checkpoints` field still holds only the latest status, but an additive `checkpointHistory[nodeId]` append-only list now retains every transition for traceability. | **PARTIAL** | `recorder.ts:75` (`state.checkpoints[node.nodeId] = record`); `recorder.ts:76-84` (`checkpointHistory[nodeId]` append) |
| **i** | `graph_run` rebuilds a fresh engine per call. `graphRun` constructs `createEngine(entry.declaration, {...})` every invocation and relies on `adoptPrior(priorState, { replayAnswers: true })` to carry over prior progress. **PARTIAL** — the rebuild remains, but a mid-flight guard now reuses the live runtime and returns current status WITHOUT re-dispatching when the graph is executing with in-flight nodes (the rebuild path remains only for the legitimate rebuild-after-complete and targeted-retry cases). | **PARTIAL** | `src/graph/tools/graph-tools.ts:934` (`createEngine`), `graph-tools.ts:958` (`adoptPrior`), mid-flight guard at `graph-tools.ts:899-920`, `graph-tools.ts:984` (`registry.set(..., runtime)`) |
| **Phase-7 note** | Per-node budget consumption is now captured at task termination, but with a documented residual gap. `node.tokensConsumed` is populated by `captureNodeUsage` (`engine-recovery.ts:252`) at every dispatch-termination path — the live `subscribeTaskTermination` callback, the recovery `reconcileEngine` terminal branch, and (via the shared seam) the race-guard — by reading the dispatch layer's per-session usage (`DispatchBridge.getSessionUsage` → `BudgetTracker.getSessionUsage(sessionId)`, keyed by `node.dispatchSessionId`). **Residual gaps:** (1) **Replace, not accumulate** — a node that re-dispatches multiple sessions (retry / loop re-entry) reflects only the LAST session's usage, not the cumulative total across sessions (the field is documented as cumulative); (2) **zero-guard** — when the tracker reports all-zero usage (never sampled / reset), the node's value is left untouched, so an adopted prior value is not clobbered; (3) when the dispatch port does not expose `getSessionUsage` (test fakes / a port without the seam), the node reports zero consumption; (4) `BudgetBridge.checkNodeBudget` remains a stub returning `{ exceeded: false }` (`budget-bridge.ts:80`) — per-node CEILING enforcement is still out of scope. | **OPEN (residual gaps stand)** | `engine-recovery.ts:252` (`captureNodeUsage`), `engine-recovery.ts:317,388` (call sites); `dispatch-bridge.ts:164-165` (`getSessionUsage`); `budget-bridge.ts:80-82` (checkNodeBudget stub) |

---

## Appendix — verification notes

- Line ranges in the task brief that were verified as **exact**: node lifecycle
  state machine `node-lifecycle.ts:59-82`, `advancingLock` critical section
  `engine-advance.ts:442-465`, `EdgePayload` build `engine-advance.ts:757-778`,
  persistence model `engine-persistence.ts:413-523`.
- Line ranges corrected from the brief / prior revision (re-verified on
  2026-07-29): the module-map and CONFIRMED-GAPS anchors were updated to the
  current tree — e.g. `_buildEdgePayload` `engine-advance.ts:771` (was `791`),
  `_runCriticalSection` `engine-advance.ts:482`, `EnginePersistence` class
  `engine-persistence.ts:413`, `createEngineState` `engine-state.ts:149`,
  `createEngine` `index.ts:820`. Gap statuses were refreshed (see §3).
- `git status` confirms no source files were modified; only
  `docs/graph-engine-architecture.md` was edited.
