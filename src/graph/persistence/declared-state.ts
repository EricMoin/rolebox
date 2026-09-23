/**
 * Graph persistence — the container a DECLARED (outcome-protocol) graph is
 * bound to.
 *
 * A v3 declaration compiles to a plan; the plan is persisted inside the same
 * version-2 engine-state container every record in the store uses, so the
 * existing loader gates (storage format, execution protocol, plan binding and
 * compiled-plan verification) apply to it unchanged. This module owns the two
 * container-building primitives that survived the legacy runtime's deletion:
 * creating an empty container and registering one pending node per compiled
 * node. The value semantics are the legacy factory's — a new state is `idle`
 * with empty collections, and a node starts `pending` with a zeroed usage
 * record and its declared join resolved through the shared
 * {@link resolveJoinStrategy} leaf.
 */

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { GraphDeclaration, NodeConfig } from "../../types.graph-v2.ts";
import type {
  EngineState,
  GraphBudgetState,
  NodeRuntimeState,
} from "../../types.engine-v2.ts";
import { resolveJoinStrategy } from "../join-strategy.ts";

/** Returns a freshly zeroed graph-level budget state. */
function emptyGraphBudget(): GraphBudgetState {
  return { sessionsSpawned: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
}

/**
 * Create a fresh {@link EngineState} in the `idle` phase for the given graph
 * declaration. The `nodes` map is empty until {@link registerNode} runs.
 */
export function createEngineState(
  graphDeclaration: GraphDeclaration,
  graphId: string,
): EngineState {
  const now = Date.now();
  return {
    phase: EnginePhase.Idle,
    graphId,
    graphDeclaration,
    nodes: new Map(),
    loopGroups: new Map(),
    frontier: [],
    budget: emptyGraphBudget(),
    signalLedger: new Map(),
    startedAt: now,
    updatedAt: now,
    advancingLock: false,
    isDirty: false,
    isNonCriticalDirty: false,
    pendingCompletions: [],
  };
}

/**
 * Register a single node from its declaration into `state.nodes` as a fresh
 * `NodeRuntimeState` (status `pending`). Throws on duplicate node ID — node
 * IDs must be unique within a graph.
 */
export function registerNode(
  state: EngineState,
  config: NodeConfig,
): NodeRuntimeState {
  if (state.nodes.has(config.id)) {
    throw new Error(`Duplicate node id in graph "${state.graphId}": ${config.id}`);
  }
  const now = Date.now();
  const node: NodeRuntimeState = {
    nodeId: config.id,
    agent: config.agent,
    prompt: config.prompt,
    needsApproval: config.needs_approval ?? false,
    status: NodeStatus.Pending,
    signalsObserved: {},
    sessionsSpawned: 0,
    tokensConsumed: { inputTokens: 0, outputTokens: 0, cost: 0 },
    upstreamResults: new Map(),
    // Propagate the node's declared join (default "all") into the runtime field
    // via the same resolver the outcome reducer uses, so they can never diverge.
    joinStrategy: resolveJoinStrategy(config.join),
    joinSatisfied: false,
    traversalCount: 0,
    startedAt: now,
    retryCount: 0,
    // Shallow-copy the declared per-node budget into runtime state. Absent when
    // the node declared no budget — OPTIONAL-ADDITIVE. The clone keeps later
    // config mutation from leaking into the runtime carrier.
    ...(config.budget ? { budget: { ...config.budget } } : {}),
  };
  state.nodes.set(config.id, node);
  state.updatedAt = now;
  return node;
}
