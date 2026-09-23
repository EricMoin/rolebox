# Graph Execution Engine v2 — Architecture Map (ARCHIVED)

> **ARCHIVED HISTORY — the runtime this document maps no longer exists.**
> The legacy signal runtime was deleted on 2026-09-23: every module under
> `src/graph/engine/*`, `parser-v2.ts`, `validator-v2.ts`, `serialize.ts`, the
> legacy graph barrel/templates and the legacy construction/execution tools are
> gone. This file is kept only as a historical record of that design; do not
> follow its file paths, and do not treat any "current" claim in it as true of
> today's tree. The shipped architecture is
> [docs/graph-outcome-protocol.md](graph-outcome-protocol.md).

Canonical architecture map of the v2 graph execution engine in
`src/graph/engine/*` (deleted 2026-09-23). All file:line anchors were verified
against the source as it existed at the time of writing; where a range in the
task brief differed from the actual file after reading, the verified line
numbers are used and the correction is noted inline. Anchors were re-verified
against the post-fix tree on 2026-08-24 (review D6: the prior "re-verified on
2026-07-29" claim had drifted on ~60% of anchors).

- Engine version: **2.0** (barrel banner, `src/graph/engine/index.ts`)
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
(`index.ts`).

All 23 modules below live in `src/graph/engine/`.

| # | Module | Responsibility | Key entry points | Anchor |
|---|--------|----------------|------------------|--------|
| 1 | `index.ts` | Public engine API barrel + `EngineRuntime`/`EngineRuntimeImpl` orchestration. Constructs the state, dispatch/budget/signal/persistence seams, and the advance engine; exposes the full lifecycle. | `createEngine`, `EngineRuntimeImpl`, `provision`, `run`, `recover`, `adoptPrior`, `status`, `cancel`, `approveNode`, `rejectNode`, `partialApprove`, `retryNode`, `cancelNodes` | `index.ts` (createEngine), `index.ts` (class), `index.ts` (interface) |
| 2 | `engine-state.ts` | Engine-state factory: the `idle → executing → complete` phase machine, frontier management, node registration, the `advancingLock` re-entrancy guard, loop-group runtime state, budget accumulation, signal-contract injection. | `createEngineState`, `canTransitionPhase`, `transitionPhase`, `provision`, `registerNode`, `computeInDegrees`, `getRootNodeIds`, `addToFrontier`, `removeFromFrontier`, `acquireAdvancingLock`, `releaseAdvancingLock`, `applyBudgetDelta`, `buildSignalContract`, `injectSignalContracts`, `recordConvergenceOutput`, `resetConvergenceTracker`, `incrementLoopTraversal` | `engine-state.ts` (createEngineState), `engine-state.ts` (phase table), `engine-state.ts` (provision) |
| 3 | `engine-advance.ts` | Core signal-driven advancement algorithm. Reacts to terminating signals: transitions node lifecycle, evaluates outbound edges, checks downstream joins, dispatches ready nodes, checks termination — all inside the `_runCriticalSection` lock. | `AdvanceEngine`, `onNodeSignalEmitted`, `dispatchReady`, `register`, `_advance`, `_runCriticalSection`, `_buildEdgePayload`, `_forwardAnswerOnApproval`, `approveNode`, `rejectNode`, `partialApprove`, `retryNode`; ports `NodeDispatchPort`, `GraphBudgetPort` | `engine-advance.ts` (class), `engine-advance.ts` (onNodeSignalEmitted), `engine-advance.ts` (_runCriticalSection) |
| 4 | `engine-persistence.ts` | Unified on-disk store for `EngineState`: write-through atomic save, debounced save, versioned load, serialize/deserialize, dirty-flag helpers. | `EnginePersistence`, `save`, `scheduleSave`, `flush`, `load`, `serializeEngineState`, `deserializeEngineState`, `loadEngineStateFromJson`, `markDirty`, `shouldPersist` | `engine-persistence.ts` (class), `engine-persistence.ts` (serialize), `engine-persistence.ts` (loadEngineStateFromJson) |
| 5 | `engine-recovery.ts` | Crash recovery + dispatch→signal reconcile: reconcile `running` nodes against the dispatch system, shared status→signal mapping, frontier rebuild, state hydration/adoption, stale-lock sweeper. | `mapDispatchStatusToSignal`, `subscribeTaskTermination`, `reconcileEngine`, `rebuildFrontier`, `hydrateEngineState`, `adoptPriorNodeStates`, `clearStaleCriticalSection`, `EngineLockSweeper` | `engine-recovery.ts` (mapping), `engine-recovery.ts` (reconcileEngine), `engine-recovery.ts` (sweeper) |
| 6 | `engine-startup.ts` | Plugin-startup recovery sweep: walks the `.rolebox/state/engine-*.json` store and resumes every interrupted graph via `createEngine` + `recover()`, with per-graph failure isolation. | `recoverInterruptedGraphs`, `RecoveryStartupReport` | `engine-startup.ts` (recoverInterruptedGraphs) |
| 7 | `engine-termination.ts` | Graph-termination checker: transitions `executing → complete` when no active node remains, or fires a quiescent-blocked terminal event; dedupes terminal events. | `checkGraphTermination`, `GraphTerminalEvent`, `TerminationContext` | `engine-termination.ts` (checkGraphTermination) |
| 8 | `signal-bridge.ts` | Read-only seam over the signal subsystem: records a signal into `signalsObserved` + the graph `signalLedger`, then fires terminating-signal listeners. Imports the 8-signal vocabulary from `signal-constants.ts`. | `SignalBridge`, `record`, `onNodeSignalEmitted`, `isTerminating`, `isPausing`, `isHandoff`, `isInfo` | `signal-bridge.ts` (class), `signal-bridge.ts` (record) |
| 9 | `signal-propagation.ts` | The two propagation lanes complementing forward `answer` flow: `propagateRevise` (back-edge re-entry + stuck/cap enforcement) and `propagateEscalate` (worst-signal forward propagation + retry gate). Pure state mutation. | `propagateRevise`, `propagateEscalate`, `SignalPropagationReport` | `signal-propagation.ts` (propagateRevise), `signal-propagation.ts` (propagateEscalate) |
| 10 | `node-lifecycle.ts` | Generic per-node lifecycle state machine. One transition table shared by all nodes; legality is a pure function of `(from, to)`. | `VALID_NODE_TRANSITIONS`, `canTransitionNode`, `transitionNode`, `markNodeBlocked`, `markReady`, `markRunning`, `markCompleted`, `markEscalated`, `markTimedOut`, `markCancelled`, `markDone` | `node-lifecycle.ts` (transition table), `node-lifecycle.ts` (transitionNode) |
| 11 | `join-evaluator.ts` | Join (fan-in) evaluator: pure graph-theoretic fan-in with `all` / `any` / `quorum:N` strategies; evaluates joins, records upstream payloads onto `node.upstreamResults`, identifies revise back-edges. | `resolveJoinStrategy`, `getJoinStrategy`, `isReviseBackEdge`, `getUpstreamNodeIds`, `evaluateJoin`, `joinSatisfied`, `collectUpstreamResults` | `join-evaluator.ts` (evaluateJoin), `join-evaluator.ts` (joinSatisfied) |
| 12 | `loop-group-executor.ts` | Loop-group orchestration: coalesced bounded-cycle step (`executeLoopStep`) deciding the §4.3 soft early-exits (converged / revising / stuck / max_traversals_exhausted / escalating). | `executeLoopStep`, `extractUnresolved`, `LoopOutcome`, `LoopStepReport` | `loop-group-executor.ts` (executeLoopStep) |
| 13 | `cancellation.ts` | Scoped / cascade cancellation primitive: cancel named node ids (loop-targets expand to their full member set) and optionally their transitive downstream. | `cancelNodes`, `expandLoopMembers` | `cancellation.ts` (cancelNodes), `cancellation.ts` (expandLoopMembers) |
| 14 | `cascade-canceller.ts` | Auto-cancellation half of fan-in: retire still-pending upstreams once a convergence node's join resolves (satisfied / failed). | `cancelPendingUpstreams`, `CancelDispatchPort`, `CascadeCancelReport` | `cascade-canceller.ts` (cancelPendingUpstreams) |
| 15 | `node-retry.ts` | Node retry (re-open / re-dispatch): pure `resetNodeForRetry` + engine-facing `retryNode` orchestration. | `resetNodeForRetry`, `retryNode`, `RetryNodeOptions`, `RetryReport` | `node-retry.ts` (resetNodeForRetry), `node-retry.ts` (retryNode) |
| 16 | `approval-handler.ts` | Pure state-mutation primitives for the `needs_approval` gate lifecycle: approve, reject, partial-approve pruning + rejected-upstream re-entry. | `approveBlockedNode`, `rejectBlockedNode`, `pruneDownstreamSubgraph`, `reenterRejectedUpstreams`, `resetRejectedUpstreams`, `mergeRejectionFeedback` | `approval-handler.ts` (approveBlockedNode), `approval-handler.ts` (pruneDownstreamSubgraph) |
| 17 | `approval-payload.ts` | Builds the structured `ApprovalPayload` (node identity, graph context, upstream result summaries) a blocked `needs_approval` node carries for the human. | `buildApprovalPayload`, `ApprovalPayload`, `ApprovalUpstreamResult` | `approval-payload.ts` (buildApprovalPayload) |
| 18 | `recorder.ts` | Runtime recorders (subtask C-RECORD): lifecycle checkpoints, loop round history, node artifacts/evidence — written only from real observed data. | `recordCheckpointForNode`, `recordLoopRound`, `deriveNodeArtifacts`, `deriveNodeEvidence`, `recordNodeArtifactsAndEvidence` | `recorder.ts` (recordCheckpointForNode), `recorder.ts` (recordLoopRound) |
| 19 | `graph-events.ts` | Write-side durable, append-only JSON-lines event log for a graph instance (node dispatch/completion, phase change, budget update). Total — never throws. | `GraphEventRecorder`, `graphEventsHash`, `graphEventsPath`, `GraphEventType` | `graph-events.ts` (class), `graph-events.ts` (hash) |
| 20 | `graph-notify.ts` | Node-completion + graph-terminal notifiers: inject `<system-reminder>`s into the emperor session via the engine's DI seams, with per-run dedupe. | `createGraphNotifier`, `createGraphTerminalNotifier`, `buildGraphCompletionText`, `buildGraphTerminalText` | `graph-notify.ts` (createGraphNotifier), `graph-notify.ts` (createGraphTerminalNotifier) |
| 21 | `dispatch-bridge.ts` | Read-only seam over `DispatchManager`: the engine's only touchpoint into the dispatch subsystem. Executes nodes and builds graph-scoped parent contexts. | `DispatchBridge`, `executeNode`, `graphParentContext`, `DEFAULT_GRAPH_AGENT`, `DispatchParentContext` | `dispatch-bridge.ts` (class), `dispatch-bridge.ts` (executeNode) |
| 22 | `budget-bridge.ts` | Read-only seam over the budget subsystem: graph-level budget check; per-node check is a Phase-7 always-accept stub, invoked through `GraphBudgetPort` as a live pre-dispatch call (`engine-advance.ts::_dispatchNode`). | `BudgetBridge`, `checkGraphBudget`, `getGraphUsage`, `checkNodeBudget` | `budget-bridge.ts` (class), `budget-bridge.ts` (checkNodeBudget stub), `engine-advance.ts` (per-node pre-check call site) |
| 23 | `condition-resolver.ts` | Default `on_condition` edge resolver: evaluates `signal_observed(<type>)` and `artifact_exists(<name>)` against a source node; unknown conditions are false (defensive runtime fallback — execution-mode validation in `validator-v2.ts` check 11 already rejects unknown condition names before dispatch). | `defaultConditionResolver`, `EdgeConditionResolver` | `condition-resolver.ts` (defaultConditionResolver) |

---

## 2. Core mechanisms

### 2.1 Engine lifecycle: `idle → executing → complete`

The engine phase machine is a forward-only linear transition:

```
idle → executing → complete
```

The phase table is defined in `engine-state.ts`:

```ts
const VALID_PHASE_TRANSITIONS: Record<EnginePhase, readonly EnginePhase[]> = {
  idle: [EnginePhase.Executing],
  executing: [EnginePhase.Complete],
  complete: [],
};
```

`src/graph/engine/engine-state.ts` — `canTransitionPhase`:

```ts
export function canTransitionPhase(state: EngineState, to: EnginePhase): boolean {
  return VALID_PHASE_TRANSITIONS[state.phase].includes(to);
}
```

`src/graph/engine/engine-state.ts` — `transitionPhase` (core):

```ts
export function transitionPhase(state: EngineState, to: EnginePhase): void {
  if (!canTransitionPhase(state, to)) {
    throw new Error(`Invalid engine phase transition: ${state.phase} -> ${to}`);
  }
  const from = state.phase;
  const now = Date.now();
  state.phase = to;
  state.updatedAt = now;
  markDirty(state);
  // Emit a phase-change event to the write-side log (no-op when no sink is
  // wired on the state). Never lets a recorder failure corrupt the phase transition.
  try {
    state.phaseEventSink?.(state.graphId, from, to);
  } catch {
    // observability — never breaks the lifecycle transition
  }
}
```

- `canTransitionPhase(state, to)` (`engine-state.ts`) checks legality.
- `transitionPhase(state, to)` (`engine-state.ts`) applies it, marks
  the state dirty, and fires the optional `phaseEventSink`.
- The `idle → executing` hop happens inside `_runCriticalSection`
  (`engine-advance.ts`) — the first advancement critical section moves
  the engine out of `idle`. `dispatchReady()` (`engine-advance.ts`) and
  `_advance` both funnel through this.
- `executing → complete` happens in `checkGraphTermination`
  (`engine-termination.ts`) when no node remains active.

> Note: `node-retry.ts` deliberately writes the phase back to `executing` when
> retrying a terminal graph (`node-retry.ts`) — this is an explicit
> re-open, not a phase-machine transition, since the table has no
> `complete → executing` edge.

### 2.2 Per-node lifecycle state machine

The single generic node state machine is defined by
`VALID_NODE_TRANSITIONS` at `node-lifecycle.ts` (verified):

`src/graph/engine/node-lifecycle.ts` — `VALID_NODE_TRANSITIONS`:

```ts
const VALID_NODE_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  // Normal path
  pending: [NodeStatus.Ready, NodeStatus.Cancelled, NodeStatus.Escalate],
  ready: [NodeStatus.Running, NodeStatus.Cancelled, NodeStatus.Escalate],
  running: [
    NodeStatus.Completed,
    NodeStatus.Escalate,
    NodeStatus.Timeout,
    NodeStatus.Cancelled,
    NodeStatus.Blocked,
  ],
  completed: [NodeStatus.Done, NodeStatus.Ready, NodeStatus.Escalate],
  // Pause path (approval mechanics are Phase 3 — see markNodeBlocked).
  // `blocked → escalate` is the reject-with-no-loop-group lane (Phase 3):
  // when a human rejects a `needs_approval` node that has no loop group to
  // re-open, the rejection escalates instead of re-entering `ready`.
  blocked: [NodeStatus.Completed, NodeStatus.Ready, NodeStatus.Escalate],
  // Error / cancel paths converge on the terminal `done` state
  timeout: [NodeStatus.Done],
  escalate: [NodeStatus.Done, NodeStatus.Ready],
  cancelled: [NodeStatus.Done],
  // Terminal — no further transitions
  done: [],
};
```

| from | legal transitions |
|------|-------------------|
| `pending` | `ready`, `cancelled`, `escalate` |
| `ready` | `running`, `cancelled`, `escalate` |
| `running` | `completed`, `escalate`, `timeout`, `cancelled`, `blocked` |
| `completed` | `done`, `ready`, `escalate` |
| `blocked` | `completed`, `ready`, `escalate` |
| `timeout` | `done` |
| `escalate` | `done`, `ready` |
| `cancelled` | `done` |
| `done` | _(terminal — none)_ |

- `canTransitionNode(from, to)` (`node-lifecycle.ts`) and
  `assertValidNodeTransition` (`node-lifecycle.ts`) enforce legality.
- `transitionNode` (`node-lifecycle.ts`) is the single choke point
  that applies every convenience transition (`markReady`, `markRunning`, …)
  and auto-saves a lifecycle checkpoint via
  `recordCheckpointForNode` (`node-lifecycle.ts`).

`src/graph/engine/node-lifecycle.ts` — `transitionNode` choke-point tail:

```ts
  node.status = to;
  if (state) markDirty(state);

  // Auto-save a lifecycle checkpoint on every status change (subtask C-RECORD).
  // Fires for every transition because ALL convenience transitions funnel
  // through this single choke point. No-ops when state is falsy (standalone
  // construction without an engine) — nothing is fabricated.
  recordCheckpointForNode(state, node, from, to, now);
```

### 2.3 `advancingLock` critical section

The advancement critical section is `AdvanceEngine._runCriticalSection` at
`engine-advance.ts` (verified range).

- The lock lives on `EngineState.advancingLock` (`engine-state.ts`,
  `acquireAdvancingLock` / `releaseAdvancingLock`).
- `_advanceSignal` (`engine-advance.ts`): if the lock is already held,
  the incoming node completion is deferred to `pendingCompletions` and returns
  immediately; otherwise it runs the work inside `_runCriticalSection`.

`src/graph/engine/engine-advance.ts` — `_advanceSignal` (defer-under-lock):

```ts
  private async _advanceSignal(
    nodeId: string,
    signalType: SignalType,
    signalPayload: unknown,
  ): Promise<void> {
    if (!acquireAdvancingLock(this.state)) {
      queuePendingCompletion(this.state, nodeId);
      return;
    }
    return this._runCriticalSection(
      () => this._advance(nodeId, signalType, signalPayload),
      // Subtask 2: contain a throwing advance — log, escalate the affected
      // node, and let the section resolve instead of rejecting (fire-and-forget
      // advancement paths discard the promise with `void`).
      (err) => this._containAdvanceError(nodeId, err),
    );
  }
```

- `_runCriticalSection` (`engine-advance.ts`): ensures the engine is
  `executing`, runs the work, and in `finally` releases the lock, routes the
  write through the two-tier persistence seams (`persistState` for critical,
  `schedulePersistState` for non-critical, `flushPersistState` on terminal)
  only when `isDirty` / `isNonCriticalDirty` (`shouldPersist`/`clearDirty`/
  `shouldPersistNonCritical`/`clearNonCriticalDirty`,
  `engine-persistence.ts`), and drains deferred completions via
  `_drainDeferred` (`engine-advance.ts`).

`src/graph/engine/engine-advance.ts` — `_runCriticalSection` (ensures `executing`, runs work):

```ts
    try {
      if (
        this.state.phase === EnginePhase.Idle &&
        canTransitionPhase(this.state, EnginePhase.Executing)
      ) {
        transitionPhase(this.state, EnginePhase.Executing);
      }
      return await work();
```

`src/graph/engine/engine-advance.ts` — `_runCriticalSection` `finally` (release + two-tier persist gate):

```ts
    } finally {
      releaseAdvancingLock(this.state);
      // Two-tier persistence point (Q2 Option A): only persist when the state
      // was mutated during this critical section. Critical mutations (node
      // lifecycle, phase, frontier, checkpoints, approval) write through
      // synchronously; a section that mutated ONLY non-critical churn
      // (signal-ledger history, budget / tokensConsumed) is routed through the
      // debounced seam. The flags are cleared after the write is handed off. The
      // seams are optional: when absent (no persistence configured) this is a
      // no-op. See engine-persistence.ts dirty-flag helpers.
      if (shouldPersist(this.state) || shouldPersistNonCritical(this.state)) {
```

- This mirrors the proven `coordinator.ts` (defer under lock, drain in `finally`)
  pattern (module doc, `engine-advance.ts`).

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

`src/signal/signal-constants.ts` — `SIGNAL_TYPES` (canonical order):

```ts
export const SIGNAL_TYPES = [
  "answer",
  "need_approval",
  "blocked",
  "need_clarification",
  "handoff",
  "progress",
  "revise_needed",
  "escalate",
] as const;
```

`src/signal/signal-constants.ts` — `SIGNAL_TYPE`:

```ts
export const SIGNAL_TYPE: Record<Uppercase<SignalType>, SignalType> = {
  ANSWER: "answer",
  NEED_APPROVAL: "need_approval",
  BLOCKED: "blocked",
  NEED_CLARIFICATION: "need_clarification",
  HANDOFF: "handoff",
  PROGRESS: "progress",
  REVISE_NEEDED: "revise_needed",
  ESCALATE: "escalate",
};
```

- Vocabulary constants: `SIGNAL_TYPES` / `SIGNAL_TYPE`
  (`signal-constants.ts`), category sets `TERMINATING_SIGNALS`,
`PAUSING_SIGNALS`, `HANDOFF_SIGNALS`,
  `INFO_SIGNALS`, `ALL_SIGNAL_TYPES`.

`src/signal/signal-constants.ts` — category sets:

```ts
/** Signals that satisfy `continue_until` — terminate the node's run. */
export const TERMINATING_SIGNALS = new Set<string>(["answer", "revise_needed", "escalate"]);

/** Signals that trigger a pausing transition (approval / blocked / clarification). */
export const PAUSING_SIGNALS = new Set<string>(["need_approval", "blocked", "need_clarification"]);

/** Signals that route work elsewhere without terminating. */
export const HANDOFF_SIGNALS = new Set<string>(["handoff"]);

/** Informational signals with no state transition. */
export const INFO_SIGNALS = new Set<string>(["progress"]);

/** All 8 signal types — union of the four categories above. */
export const ALL_SIGNAL_TYPES = new Set<string>([
  ...TERMINATING_SIGNALS,
  ...PAUSING_SIGNALS,
  ...HANDOFF_SIGNALS,
  ...INFO_SIGNALS,
]);
```

- Severity ordering for picking which recorded terminating signal to replay:
  `escalate > revise_needed > answer` — `TERMINATING_SIGNALS_BY_SEVERITY`
  (`signal-constants.ts`), consumed by the engine's `_latestTerminating`
  (`engine-advance.ts`).

`src/signal/signal-constants.ts` — severity ordering:

```ts
/**
 * Terminating signals in descending severity order.
 *
 * Used by the completion evaluator so the highest-severity terminating signal
 * wins when multiple were recorded during a sub-agent session.
 */
export const TERMINATING_SIGNALS_BY_SEVERITY = ["escalate", "revise_needed", "answer"] as const;
```

- Synthetic inferred completion: `SYNTHETIC_ANSWER_SIGNAL`
  (`signal-constants.ts`); the completion evaluator infers `answer` with
  `{ __inferred: true }` when a task finishes without calling `signal()`.
- The engine re-exports the vocabulary from `signal-bridge.ts`.
- `need_approval` is special-cased: although `terminating` is false for it, it
  still drives an advancement critical section that transitions the node to
  `blocked` (`engine-advance.ts`, `_pauseForApproval` at
  `engine-advance.ts`).

### 2.5 `EdgePayload` data flow

`_buildEdgePayload` (`engine-advance.ts`) packages a node's terminating
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

`src/graph/engine/engine-advance.ts` — `_buildEdgePayload` return site:

```ts
    return {
      fromNode: source.nodeId,
      fromSignal: signalType,
      result,
      artifacts: source.artifacts ?? deriveNodeArtifacts(source),
      budgetConsumed: {
        tokens: tc.inputTokens + tc.outputTokens,
        cost: tc.cost,
        sessions: source.sessionsSpawned,
      },
    };
```

- On `answer`, the advance engine iterates the source's outbound edges via the
  shared `_forwardActivation` helper (`engine-advance.ts`), applies each
  edge's `data_passthrough` transform (`applyDataMapping`,
  `engine-advance.ts`), records the upstream result via
  `collectUpstreamResults` (`join-evaluator.ts`), and activates a
  satisfied target (`pending → ready`, or `completed → ready` loop re-entry).
- The approval-resume path shares the same forward activation via
  `_forwardAnswerOnApproval` → `_forwardActivation`
  (`engine-advance.ts`, shared helper at `engine-advance.ts`).
- Join satisfaction uses `evaluateJoin` / `joinSatisfied`
  (`join-evaluator.ts`).
### 2.6 Persistence model

The persistence model is `EnginePersistence` at `engine-persistence.ts`
(verified range).

- On-disk path: `.rolebox/state/engine-{slug}.json`
  (`engineStatePath`, `engine-persistence.ts`).
- Schema version: `ENGINE_PERSISTENCE_VERSION = 2`
  (`engine-persistence.ts`).

`src/graph/engine/engine-persistence.ts` — `ENGINE_PERSISTENCE_VERSION` / `NON_CRITICAL_DEBOUNCE_MS`:

```ts
/** Schema version of the persisted engine state file. */
export const ENGINE_PERSISTENCE_VERSION = 2 as const;

/** Debounce window for non-critical state writes (ms). See Q2 Option A. */
export const NON_CRITICAL_DEBOUNCE_MS = 500 as const;
```

- `save` (`engine-persistence.ts`): synchronous, atomic
  (`.tmp` + `unlinkSync` + `renameSync`, `_write` at `628`); never throws
  (write failure logs and the engine continues in memory).

`src/graph/engine/engine-persistence.ts` — `EnginePersistence.save`:

```ts
  save(state: EngineState): boolean {
    this._cancelDebounce();
    return this._write(state);
  }
```

- `load` (`engine-persistence.ts`): returns `null` on missing/corrupt/
  version-mismatch (clean start). `loadEngineStateFromJson`
  (`engine-persistence.ts`) is the version-gated, testable parser.

`src/graph/engine/engine-persistence.ts` — `EnginePersistence.load`:

```ts
  load(graphId: string): EngineState | null {
    const filePath = engineStatePath(this.directory, graphId);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      // ENOENT — first run / never persisted. Clean start.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Anything else means the file EXISTS but is unreadable — treat it as an
      // explicit failure, never as "no state" (an EACCES/EISDIR file is not a
      // clean start; treating it as one would re-execute completed nodes).
      throw err;
    }
    try {
      return loadEngineStateFromJson(raw, filePath);
    } catch {
      // Defensive containment: hydration must never throw past `load()`. A
      // structurally invalid file surfaces as `null` (clean start), never as a
      // crash that would make the graph permanently unrecoverable.
      return null;
    }
  }
```

- `scheduleSave` (debounced, `engine-persistence.ts`,
  `NON_CRITICAL_DEBOUNCE_MS = 500` at `engine-persistence.ts`) and `flush`
  (`engine-persistence.ts`) are **wired**, not dead code — see
  CONFIRMED-GAPS **d**.
- **Two-tier durability policy (resolved — gap d).** Critical mutations
  (node lifecycle, graph phase, frontier, checkpoint records, approval state)
  write through synchronously via the `persistState` seam; non-critical churn
  (signal-ledger history, budget / per-node `tokensConsumed`) is routed through
  the debounced `schedulePersistState` seam. Both seams are invoked from the
  critical section's `finally` (`engine-advance.ts`), and a
  flush-on-terminate drains any pending debounced write when the engine reaches
  `complete` (`engine-advance.ts`). The seams are wired in
  `index.ts`. The class doc (`engine-persistence.ts`) documents
  this policy explicitly.
- `serializeEngineState` / `deserializeEngineState`
  (`engine-persistence.ts`) flatten `Map` fields to JSON-safe records.
- `isDirty` is never serialized — a recovered state always starts clean
  (`engine-persistence.ts`).
- Write-through is invoked from the critical section's `finally` via the
  `persistState` seam (`engine-advance.ts`).

### 2.7 Node timeout / liveness monitoring — tiered detection

A `running` node must never hang the graph silently. The engine detects
dead/stalled nodes through **four tiers**, in decreasing immediacy, each with a
documented fallback relationship (node-anomaly-detection feature):

| Tier | Name | Mechanism | Trigger | Result |
|------|------|-----------|---------|--------|
| **Tier 1** | Immediate failure (fast path) | `EngineRuntime.handleFeedSessionEvent` (`engine-advance.ts`, relayed from `index.ts`) | Platform liveness feed observes `session.deleted` (`gone` — authoritative) or `session.error` whose dispatch task is genuinely NOT live | Running node escalates immediately through the standard escalate advance (completion seam + ledger signal + cascade cancel) — the abnormal node never blocks graph advancement |
| **Tier 2** | Soft-stall warning | `NodeLivenessMonitor` (`engine-recovery.ts`) | Heartbeat-fed running node idle `>= nodeStallWarnMs` (default `min(60s, staleTimeout/2)`) | Classified `stalling`, `stallWarnedAt` stamped, `onNodeStall` seam fires **once per stall episode** (a fresh episode after recovery re-fires) |
| **Tier 3** | Grace escalation (hard stall) | Same `NodeLivenessMonitor` tick | `stalling` node idle `>= stallWarnMs + stallGraceMs` (default grace 30s), capped by the per-node effective deadline `min(budget.timeout_ms, nodeStaleTimeoutMs)` | Marked `timeout` via the shared `markTimedOut` and funnels through the SAME `onStaleNodeTimeout` downstream as Tier 4 (escalate ledger signal + completion seam) |
| **Tier 4** | Wall-clock fallback | `NodeStalenessWatcher` (`engine-recovery.ts`) | A running node **without** a heartbeat feed (`liveness.lastActivityAt` absent) exceeds its staleness deadline from `startedAt` | Marked `timeout` + `onTimeout` → the same downstream as Tier 3 |

`src/graph/engine/engine-recovery.ts` — `NodeLivenessMonitor` constructor (default stall thresholds):

```ts
  constructor(private readonly opts: NodeLivenessMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? SWEEPER_INTERVAL_MS;
    this.nodeStaleTimeoutMs = opts.nodeStaleTimeoutMs;
    this.stallWarnMs =
      opts.stallWarnMs ?? Math.min(60_000, this.nodeStaleTimeoutMs / 2);
    this.stallGraceMs = opts.stallGraceMs ?? 30_000;
  }
```

**Fallback / coexistence rules:**

- **Tiers 1–3 require a heartbeat feed** (`node.liveness.lastActivityAt`,
  written by the dispatch-time heartbeat / `recordLivenessHeartbeat` / the
  platform feed). A node WITHOUT a feed is **skipped by the liveness monitor**
  entirely and falls to Tier 4's pure wall-clock deadline
  (`engine-recovery.ts` — "no feed — wall-clock fallback").
- **Tier 2 and Tier 3 are one ladder**: the monitor walks
  `healthy → stalling → stalled(timeout)` as idle grows; a fresh heartbeat
  returns a `stalling` node to `healthy` and re-arms a future episode
  (recovery-then-re-stall re-warns).
- **Tiers 3 and 4 share the same downstream handler** (`onStaleNodeTimeout`,
  `index.ts`): timeout → `notifyNodeTimeout` completion seam +
  `escalate` ledger signal, so a timed-out upstream cannot silently stall a
  fan-in join regardless of which tier fired.
- **Both monitors are opt-in**, instantiated together beside each other only
  when `nodeStaleTimeoutMs > 0` (`index.ts`), manually tickable with an
  injected clock for deterministic tests, and stopped on `cancel()` /
  `dispose()`. Without the option, engine behavior is byte-identical to the
  pre-feature engine (no watcher, no monitor, no liveness recording on load).
- **Liveness carrier is OPTIONAL-ADDITIVE**: `NodeRuntimeState.liveness`
  (`types.engine-v2.ts`) is absent for fresh/old nodes, serializes
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
against the current tree on 2026-08-24.

| Gap ID | Description | Status | Evidence (file:line) |
|--------|-------------|--------|----------------------|
| **a** | Dangling `.rolebox/design/*` references. The `.rolebox/design/` directory does **not exist** on disk, yet **30 files** (56 references) across `src/` point into it — e.g. every engine module's design-reference header, `types.engine-v2.ts`, `parser-v2.ts`, `validator-v2.ts`, `graph-tools.ts`. (Correction: the brief said "~28 files"; the verified count is **30**.) | **OPEN** | `ls .rolebox/design/` → `No such file or directory`; `rg -l '\.rolebox/design/' src/` → 30 files; representative: `engine-advance.ts`, `engine-state.ts`, `engine-persistence.ts` |
| **b** | Legacy v1 graph subsystem still wired. `src/graph/state.ts`, `src/graph/advance.ts`, `src/graph/graph-store.ts` remain live behind the internal `src/graph/legacy-v1.ts` adapter: `graphSessionState` / `advanceGraphForDispatch` are consumed by `hook-service.ts` (setStoreDirectory/recover + registered as a hook dep), `tool-after.ts` (advance-on-dispatch), plus `system-transform.ts`, `chat-message.ts`, `custom/registry.ts`, `composition.ts`, and `resolver/orchestrator.ts`. No v1 module is fully orphaned. | **RESOLVED** | The v1 modules (`src/graph/state.ts`, `advance.ts`, `graph-store.ts`, `converter.ts`, `parser.ts`, `validator.ts`) and the `legacy-v1.ts` adapter were deleted. The ported intermediate modules were also removed in the subsequent declarative-subsystem cleanup, so consumers now use only the v2 engine modules. `src/graph/` contains only v2 modules + shared helpers. |
| **c** | Dead `EngineState.edges` field. `createEngineState` initialized `edges: new Map()` at `engine-state.ts`, but nothing populated the field during normal execution (edges live on `graphDeclaration.edges`; `snapshotEngineState`/`hydrateEngineState` copied it, but the advance engine never wrote it). **FIXED** — the dead field was deleted (D3, subtask 14): the type member and its initialization are gone, and all four carry paths were stripped — `serializeEngineState` no longer writes an `edges` key, `deserializeEngineState` no longer hydrates one, `snapshotEngineState` no longer clones the map, `hydrateEngineState` no longer copies it. Backward compat: legacy v2 files that still carry a top-level `edges` extra key pass the required-shape gate (the key is optional in `EnginePersistenceFile` and is tolerated then ignored — never hydrated back onto a live state). `provision()`'s redundant re-assignment of `status = Pending` for non-root nodes was removed alongside (registerNode already assigns it). | **RESOLVED** | `types.engine-v2.ts` (field removed from `EngineState`); `engine-state.ts` (`createEngineState` — no `edges`), `engine-state.ts` (`provision` — no redundant `Pending`); `engine-persistence.ts` (`EnginePersistenceFile.edges?:` read-compat only), `engine-persistence.ts` (serialize — no edges write), `engine-persistence.ts` (deserialize — no edges hydrate), `engine-persistence.ts` (`hasRequiredShape` — edges not required); `index.ts` (`snapshotEngineState` — no edges clone); `engine-recovery.ts` (`hydrateEngineState` — no edges copy) |
| **d** | Dead `scheduleSave` / `flush`. **FIXED** — both are now wired as a two-tier durability policy. `scheduleSave` (debounced, `NON_CRITICAL_DEBOUNCE_MS = 500`) is called from the critical section's `finally` for non-critical-only mutations; flush-on-terminate drains any pending debounced write when the engine reaches `complete`. Wired via the `schedulePersistState` / `flushPersistState` seams in `index.ts`. `dispose()` additionally cancels the debounce timer and drops the pending write so a replaced runtime's stale state can never overwrite the successor's (05-F1/M14). | **RESOLVED** | `engine-advance.ts` (debounced non-critical branch), `engine-advance.ts` (flush-on-terminate); `index.ts` (seam wiring); `engine-persistence.ts` (`NON_CRITICAL_DEBOUNCE_MS`), `engine-persistence.ts` (`scheduleSave`), `engine-persistence.ts` (`flush`), class doc `engine-persistence.ts`; `index.ts` (`dispose` — cancels timer, drops pending write) |
| **e** | Signal-ledger bypass. **FIXED** — all four former direct-write sites now route through the shared `recordSignalToLedger` helper (which keeps `node.signalsObserved` and the graph `signalLedger` + timestamped history in sync). The approval-resume answer, the rejection revise_needed, the dispatch race-guard replay, and the approval-payload stash all call it. | **RESOLVED** | `signal-bridge.ts` (`recordSignalToLedger`), `approval-handler.ts` (answer), `approval-handler.ts` (revise_needed), `engine-advance.ts` (race-guard), `engine-advance.ts` (approval_payload) |
| **f** | `EdgePayload.artifacts` is always `[]`. **FIXED** — `_buildEdgePayload` no longer hardcodes `artifacts: []`; it populates `source.artifacts ?? deriveNodeArtifacts(source)`. The two former sibling hardcodes (`approval-handler.ts`, `signal-propagation.ts`) are fixed identically. `rg 'artifacts: \[\]' src/graph/engine/` → ZERO matches. | **RESOLVED** | `engine-advance.ts` (`artifacts: source.artifacts ?? deriveNodeArtifacts(source)`); `approval-handler.ts`; `signal-propagation.ts`; consumed via `collectUpstreamResults` (`join-evaluator.ts`) onto `node.upstreamResults` |
| **g** | Forward-`answer` duplication. **FIXED** — the live-signal `answer` forward-data-flow block and the approval-resume `_forwardAnswerOnApproval` now both delegate to a single shared helper `_forwardActivation`, eliminating the near-identical loops. | **RESOLVED** | `engine-advance.ts` (live-signal path calls `_forwardActivation`), `engine-advance.ts` (`_forwardAnswerOnApproval` → `_forwardActivation`), shared helper def at `engine-advance.ts` |
| **h** | Checkpoint last-wins. `recordCheckpointForNode` overwrites `state.checkpoints[node.nodeId]` with the latest snapshot on every transition. **PARTIAL** — the primary `checkpoints` field still holds only the latest status, but an additive `checkpointHistory[nodeId]` append-only list now retains every transition for traceability. | **PARTIAL** | `recorder.ts` (`state.checkpoints[node.nodeId] = record`); `recorder.ts` (`checkpointHistory[nodeId]` append) |
| **i** | `graph_run` rebuilds a fresh engine per call. `graphRun` constructs `createEngine(entry.declaration, {...})` every invocation and relies on `adoptPrior(priorState, { replayAnswers: true })` to carry over prior progress. **PARTIAL** — the rebuild remains, but a mid-flight guard now reuses the live runtime and returns current status WITHOUT re-dispatching when the graph is executing with in-flight nodes (the rebuild path remains only for the legitimate rebuild-after-complete and targeted-retry cases). | **PARTIAL** | `src/graph/tools/graph-tools.ts` (`createEngine`), `graph-tools.ts` (`adoptPrior`), mid-flight guard at `graph-tools.ts`, `graph-tools.ts` (`registry.set(..., runtime)`) |
| **Phase-7 note** | Per-node budget consumption is now captured at task termination, but with a documented residual gap. `node.tokensConsumed` is populated by `captureNodeUsage` (`engine-recovery.ts`) at every dispatch-termination path — the live `subscribeTaskTermination` callback, the recovery `reconcileEngine` terminal branch, and (via the shared seam) the race-guard — by reading the dispatch layer's per-session usage (`DispatchBridge.getSessionUsage` → `BudgetTracker.getSessionUsage(sessionId)`, keyed by `node.dispatchSessionId`). **Residual gaps:** (1) **Replace, not accumulate** — a node that re-dispatches multiple sessions (retry / loop re-entry) reflects only the LAST session's usage, not the cumulative total across sessions (the field is documented as cumulative); (2) **zero-guard** — when the tracker reports all-zero usage (never sampled / reset), the node's value is left untouched, so an adopted prior value is not clobbered; (3) when the dispatch port does not expose `getSessionUsage` (test fakes / a port without the seam), the node reports zero consumption; (4) `BudgetBridge.checkNodeBudget` is a live port member (`GraphBudgetPort`, `engine-advance.ts`) invoked pre-dispatch (`engine-advance.ts`) but remains an always-accept stub returning `{ exceeded: false }` (`budget-bridge.ts`) — per-node CEILING enforcement is still out of scope. | **OPEN (residual gaps stand)** | `engine-recovery.ts` (`captureNodeUsage`), `engine-recovery.ts` (call sites); `dispatch-bridge.ts` (`getSessionUsage`); `budget-bridge.ts` (checkNodeBudget stub), `engine-advance.ts` (per-node pre-check) |

---

## 4. Authored surface — the public graph toolset

§1–§3 describe the engine internals. This section describes the surface an
agent or role actually drives to author a workflow: the toolset registered in
`src/graph/tools/index.ts` (implementations in `src/graph/tools/graph-tools.ts`).

### 4.1 The toolset

| Tool | Purpose |
|------|---------|
| `graph_create` | Open a graph registry slot; returns the `graph_id` every later call needs |
| `graph_add_node` | Register one worker node |
| `graph_add_edge` | Add a directed edge (data flow + signal routing) |
| `graph_add_loop` | Declare a bounded cycle over existing nodes |
| `graph_run` | Dispatch ready roots (non-blocking), or validate structure with `dry_run` |
| `graph_status` | Query node / loop / graph state |
| `graph_cancel` | Cancel the whole graph, one node, or one loop group (`cascade` propagates downstream) |
| `graph_approve` | Resolve a `needs_approval` gate (`approve` / `reject`) |

### 4.2 Nodes

Nodes are **role-agnostic `{agent, prompt}` tuples**. `graph_add_node` takes
`graph_id`, `id`, `agent`, `prompt`, plus optional `completion_condition`
(a named condition that auto-completes the node), `needs_approval`, `join`
(fan-in strategy: `all` / `any` / `quorum`), and `budget`
(`max_input_tokens` / `max_output_tokens` / `max_cost_usd` / `timeout_ms`).
Structural validation is **atomic** — an invalid node is rejected without
mutating the graph. `timeout_ms: 0` is the documented per-node opt-out sentinel
that disables the staleness watchdog; only negative values are rejected.

### 4.3 Edges

Edges are directed and carry both data flow and signal routing. `type` is one of:

- `always` — activate the target when the source completes;
- `on_signal` — activate on a specific signal type (requires `signal_filter`,
  e.g. `["revise_needed"]`);
- `on_condition` — activate when a named condition evaluates true (requires
  `condition`).

Optional per-edge controls: `retry` (auto-retry on escalate, with `backoff_ms`)
and the `data_passthrough_include` / `data_passthrough_exclude` /
`data_passthrough_max_chars` triple that bounds what crosses the edge.

### 4.4 Loop groups

`graph_add_loop(graph_id, id, nodes, max_traversals, mode?)` declares a set of
existing nodes as a **bounded cycle** with a hard `max_traversals` cap (the only
required numeric field; `>= 1`). Rounds re-dispatch within the **same engine
state** (`mode: "inherit"`); per-round session isolation is **not supported** —
`mode: "fresh"` returns an explicit error naming the alternative path (a
separate graph per round).

The authored API has **no loop-level termination/timeout parameter**. Early exit
is engine behavior, not configuration: a loop member that signals `answer` exits
the loop on the **`converged`** path (only the forward `answer` data flow runs,
and no traversal is consumed), while a loop that repeatedly emits the same
convergence output escalates with reason **`stuck`** after
`CONSECUTIVE_STALE_THRESHOLD` (= 2) identical traversals. For a time bound, use
the per-node `budget.timeout_ms` (§4.2). See §2.6 / `loop-group-executor.ts`
for the full outcome table.

### 4.5 Approval gates

A node with `needs_approval: true` pauses the graph at that node and the engine
emits `[GRAPH BLOCKED]`. The gate is resolved with
`graph_approve(graph_id, node_id, action)`:

- `action: "approve"` — the node completes (`blocked → completed`) and its
  forward `answer` data flow resumes the graph automatically;
- `action: "reject"` — the node re-enters with the supplied reason when it
  belongs to a loop group, otherwise it escalates.

Both directions are idempotent — a decision on an already-resolved node is a
no-op.

### 4.6 Observability

`graph_status` takes `graph_id` / `node_id` / `loop_id` targets and reports
with no target at all (listing every graph). Useful switches: `format`
(`summary` | `tree` | `json`), `scope` (`session` | `persisted` | `all`),
`include_output` (materialized node results), `include_history` + `round`,
`include_progress` / `include_budget` / `include_loops` / `include_metrics`,
`pending_approvals` ("awaiting human" view), `stream` + `since`, and the
`max_chars` / `offset` / `tail` pagination triple.

Persisted state lives in `.rolebox/state/engine-{slug}.json` per graph, alongside
the append-only `.rolebox/state/graph-events-*.ndjson` event log (see §2.6 for
the persistence model).

### 4.7 Usage protocol (non-blocking)

`graph_run` is **non-blocking** — it dispatches ready root nodes and returns
immediately with `phase`, `active_nodes`, and `pending_nodes`. End your turn
after `graph_run`; the engine emits a `[GRAPH COMPLETE]` system-reminder when
all nodes finish (or `[GRAPH BLOCKED]` when a node awaits approval). On the next
turn, read results once via `graph_status(graph_id, include_output=true)`.
Polling `graph_status` is a fallback only.

```text
1. graph_create(name="review-workflow")                 → { graph_id: "review-workflow", ... }
2. graph_add_node(graph_id="review-workflow", id="writer",
     agent="emperor--jinyiwei--ui", prompt="Build the component")
3. graph_add_node(graph_id="review-workflow", id="reviewer",
     agent="emperor--jinyiwei--test", prompt="Review the result")
4. graph_add_edge(graph_id="review-workflow",
     from="writer", to="reviewer", type="always")
5. graph_run(graph_id="review-workflow")                → non-blocking; end your turn
6. [GRAPH COMPLETE] system-reminder arrives
7. graph_status(graph_id="review-workflow", include_output=true)   → read results once
```

Loop groups and approval gates compose on top of the same node/edge model:

```text
graph_add_loop(graph_id="review-workflow", id="revise",
  nodes=["writer", "reviewer"], max_traversals=3)
graph_add_node(graph_id="review-workflow", id="finalize",
  agent="emperor--jinyiwei--docs", prompt="Finalize", needs_approval=true)
graph_run(graph_id="review-workflow")                          → [GRAPH BLOCKED] at "finalize"
graph_approve(graph_id="review-workflow", node_id="finalize", action="approve")
```

---

## Appendix — verification notes

- Line ranges in the task brief that were verified as **exact** (still valid
  on 2026-08-24): node lifecycle state machine `node-lifecycle.ts`,
  `executeLoopStep` `loop-group-executor.ts`, `buildApprovalPayload`
  `approval-payload.ts`.
- Line ranges corrected from the brief / prior revision (re-verified on
  2026-08-24 after the P0–P3 fix subtasks shifted the tree): the module-map and
  CONFIRMED-GAPS anchors were updated to the current tree — e.g.
  `_buildEdgePayload` `engine-advance.ts`, `_runCriticalSection`
  `engine-advance.ts`, `EnginePersistence` class `engine-persistence.ts`,
  `createEngineState` `engine-state.ts`, `createEngine` `index.ts`,
  `checkGraphTermination` `engine-termination.ts`. Gap statuses were
  refreshed (see §3): **c** → RESOLVED (D3), **d** → RESOLVED + dispose
  semantics (M14), **f** → RESOLVED, **g** → RESOLVED; **a** and the Phase-7
  note remain OPEN (per review §四 cross-check).
- This revision touched comments only (no behavior change): the `index.ts`
  barrel header (Phase-3/Phase-1 stub notes → implemented surface),
  `SignalBridge.record` `@param state` (required, not optional), and the
  `graph_add_edge` `data_passthrough_exclude` / `data_passthrough_max_chars`
  descriptions in `src/graph/tools/index.ts` (implemented, not shape-compat).
- `git status` at review time confirmed no source files were modified; only
  `docs/reviews/` was untracked. The 2026-08-24 doc refresh + comment fixes
  are the sole working-tree changes from subtask 16 (P4 docs).
