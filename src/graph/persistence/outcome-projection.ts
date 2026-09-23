/**
 * Graph persistence — the LIVE projection of a declared graph's run
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * A declared (outcome-protocol) graph has TWO durable records: the engine-state
 * container the plan is bound to (`engine-<slug>.json`, written once by
 * `graph_declare`) and the acceptance ledger, where every dispatch, settlement,
 * receipt, event and effect is committed. The ledger is the authority for what
 * the run DID; the engine-state container is what every operator surface reads
 * (`graph_status` over the session or persisted scope, `scanPersistedStates`,
 * the drain audit's state view).
 *
 * Before this module existed the container was never updated after the
 * declaration, so a graph that had already completed still rendered as
 * `idle` with every node `pending`: the status surface contradicted the ledger.
 * This module closes that gap the only way it can close honestly — it DERIVES
 * the container from the two facts it is allowed to read:
 *
 *   - the graph's own persisted record (the plan binding, the compiled plan,
 *     the execution-protocol identity and the declared per-node fields such as
 *     agent, prompt and join) — carried through UNCHANGED;
 *   - the run's persisted outcome state (phase, per-node status, loop traversal
 *     counters) — overlaid on top.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It writes no credential (the outcome state
 * records only a digest, and nothing here reads it), it invents no node, no
 * attempt id and no dispatch task id, and it never fabricates a state for a
 * graph whose record it cannot load: every failure path returns `false` and
 * leaves the file exactly as it was. The projection is a derived VIEW — losing
 * it costs an operator nothing the ledger does not still hold — so a failed
 * write is reported by its boolean, never by throwing into a settlement that
 * already committed.
 *
 * THE PHASE VOCABULARY IS NARROWER THAN THE RUN'S. `EnginePhase` has `idle`,
 * `executing` and `complete`; an outcome run can also be `stopped`. A stopped
 * run is terminal and projects as `complete` here, and the stop itself (its
 * declared reason and round) stays where it is written: the ledger, which
 * `graph_audit` reports. Nothing here re-labels a stop as a success.
 *
 * Dependency direction: this module depends on the persistence layer and on the
 * outcome state's TYPE only, so the host layer, the submission ingress and the
 * tools layer may all call it without a cycle.
 */

import { readFileSync } from "node:fs";

import { EnginePhase, NodeStatus } from "../../constants.ts";
import type { EngineState, LoopGroupRuntimeState, NodeRuntimeState } from "../../types.engine-v2.ts";
import type {
  OutcomeGraphPhase,
  OutcomeGraphState,
  OutcomeNodeStatus,
} from "../outcome/graph-state.ts";
import { OUTCOME_PROTOCOL } from "../protocol/execution-protocol.ts";
import {
  DEFAULT_STORAGE_FORMAT_REGISTRY,
  EnginePersistence,
  engineStatePath,
  loadEngineStateForResume,
} from "./engine-persistence.ts";

// ── The overlay ─────────────────────────────────────────────────────────────

/** The engine node status one outcome node status projects to. */
const PROJECTED_NODE_STATUS: Readonly<Record<OutcomeNodeStatus, NodeStatus>> =
  Object.freeze({
    pending: NodeStatus.Pending,
    dispatched: NodeStatus.Running,
    settled: NodeStatus.Completed,
  });

/**
 * The engine phase one outcome phase projects to.
 *
 * `stopped` maps to `complete` because `EnginePhase` has no separate terminal
 * member and a stopped run takes no further step; the stop's own reason is
 * recorded in the ledger and reported by `graph_audit`, never rewritten here.
 */
const PROJECTED_PHASE: Readonly<Record<OutcomeGraphPhase, EnginePhase>> =
  Object.freeze({
    ready: EnginePhase.Idle,
    executing: EnginePhase.Executing,
    complete: EnginePhase.Complete,
    stopped: EnginePhase.Complete,
  });

/**
 * Overlay one outcome run's recorded progress onto the container its plan is
 * bound to.
 *
 * PURE and total: every node the container declares keeps its identity, agent,
 * prompt, join and budget, and only its lifecycle position is replaced by what
 * the run recorded. A node the run does not mention (impossible for a state
 * verified against the plan, tolerated here) is carried through untouched, and
 * an attempt id is NEVER written into the container's dispatch-task slot — the
 * two are different identities and conflating them would be a fabrication.
 */
export function projectOutcomeEngineState(
  base: EngineState,
  state: OutcomeGraphState,
  now: number,
): EngineState {
  const recorded = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const nodes = new Map<string, NodeRuntimeState>();
  for (const [id, node] of base.nodes) {
    const live = recorded.get(id);
    if (live === undefined) {
      nodes.set(id, node);
      continue;
    }
    const status = PROJECTED_NODE_STATUS[live.status];
    if (status === node.status) {
      nodes.set(id, node);
      continue;
    }
    nodes.set(id, {
      ...node,
      status,
      ...(status === NodeStatus.Completed &&
      live.settledAt !== undefined &&
      node.completedAt === undefined
        ? { completedAt: live.settledAt }
        : {}),
    });
  }

  const loopGroups = new Map<string, LoopGroupRuntimeState>();
  for (const [id, group] of base.loopGroups) {
    const traversals = state.loopTraversals[id];
    loopGroups.set(
      id,
      traversals === undefined || traversals === group.traversalCount
        ? group
        : { ...group, traversalCount: traversals },
    );
  }

  return {
    ...base,
    phase: PROJECTED_PHASE[state.phase],
    nodes,
    loopGroups,
    updatedAt: Math.max(base.updatedAt, now),
    isDirty: false,
    isNonCriticalDirty: false,
  };
}

// ── The write ───────────────────────────────────────────────────────────────

/**
 * Write one run's progress back into its graph's persisted record.
 *
 * The record is re-read through the SAME structured loader every other reader
 * uses, so this writer can only ever produce a file its own reader accepts: a
 * record that is absent, not valid, bound to another protocol, or bound to a
 * different plan revision than the state names is left UNTOUCHED and reported
 * with `false`. The write itself is the store's atomic replace.
 *
 * Never throws: a settlement that already committed must not fail because an
 * operator view could not be refreshed.
 */
export function persistOutcomeProjection(
  workspaceDir: string,
  state: OutcomeGraphState,
  now: number = Date.now(),
): boolean {
  const path = engineStatePath(workspaceDir, state.graphId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  const loaded = loadEngineStateForResume(
    raw,
    path,
    DEFAULT_STORAGE_FORMAT_REGISTRY,
  );
  if (loaded.kind !== "valid") return false;
  if (loaded.executionProtocol !== OUTCOME_PROTOCOL) return false;
  if (loaded.state.graphId !== state.graphId) return false;
  const boundPlan = loaded.state.compiledPlan;
  if (boundPlan !== undefined && boundPlan.planRevision !== state.planRevision) {
    return false;
  }
  const projected = projectOutcomeEngineState(loaded.state, state, now);
  return new EnginePersistence(workspaceDir).save(projected);
}
