/**
 * Graph Execution Engine v2 — Approval Handler
 *
 * Version: 2.0
 * Date: 2026-07-24
 *
 * Pure state-mutation primitives for the `needs_approval` (human-in-the-loop)
 * gate lifecycle. When a `needs_approval` node pauses in the `blocked` state,
 * the human resumes it one of three ways (orchestration-patterns.md §1.3/§1.5):
 *
 * - {@link approveBlockedNode}  — approve → `blocked → completed`; the engine
 *   records an `answer` signal and returns the {@link EdgePayload} so the
 *   caller's forward-data-flow step activates the downstream `on_signal
 *   (answer)` / `always` edges.
 * - {@link rejectBlockedNode}   — reject → `blocked → ready` (re-enter with the
 *   rejection feedback merged into the node's re-execution prompt), or
 *   `blocked → escalate` when there is no loop group to absorb the rejection.
 * - {@link pruneDownstreamSubgraph} + rejected-upstream re-entry — partial
 *   approve → cancel the rejected branches' transitive dependents and re-enter
 *   the rejected upstream nodes `ready` with feedback, so the surviving graph
 *   re-runs only the deltas (orchestration-patterns.md §1.5).
 *
 * These primitives are **pure state-mutation steps**, mirroring the
 * signal-propagation conventions: they mutate node lifecycle status and the
 * frontier only, and never dispatch. Dispatch of re-entered-`ready` nodes (and
 * any downstream activation) is the caller's job (the advance engine's
 * `_dispatchReadyNodes`). Cancellation of pruned nodes touches a
 * `CancelDispatchPort` seam (optional) — structurally satisfied by the
 * `NodeDispatchPort` cancel seam (`engine-advance.ts`).
 *
 * Design references:
 * - `.rolebox/design/orchestration-patterns.md` §1.3 (approval lifecycle),
 *   §1.5 (partial-approval pruning).
 */

import { JoinStrategy, NodeStatus } from "../../constants.ts";
import type { EdgePayload, EngineState, NodeRuntimeState } from "../../types.engine-v2.ts";
import {
  canTransitionNode,
  markCompleted,
  markEscalated,
  markReady,
} from "./node-lifecycle.ts";
import {
  getJoinStrategy,
  getUpstreamNodeIds,
  joinSatisfied,
  readQuorum,
} from "./join-evaluator.ts";
import { addToFrontier, removeFromFrontier } from "./engine-state.ts";
import type { CancelDispatchPort } from "./cascade-canceller.ts";
import { retireCancelledNode } from "./cancellation.ts";
import { recordSignalToLedger } from "./signal-bridge.ts";
import { asRecord } from "./signal-payload.ts";
import {
  deriveNodeArtifacts,
  recordNodeArtifactsAndEvidence,
} from "./recorder.ts";

// ── Report shapes ───────────────────────────────────────────────────────────

/**
 * Result of {@link approveBlockedNode}, and of the public `EngineRuntime
 * .approveNode` (contract C6): the caller learns whether its approval actually
 * took effect instead of having to diff two `status()` snapshots around the
 * call.
 */
export interface ApproveReport {
  /**
   * `true` when the node was actually `blocked` and the approval transitioned
   * it to `completed` — the `answer` signal was recorded and the forward data
   * flow runs. `false` for an idempotent no-op: a replayed approve against an
   * already-resolved node, or an approve against a node that was never
   * `blocked`. A no-op approval performs no graph mutation.
   */
  applied: boolean;
}

/**
 * Project the {@link approveBlockedNode} primitive's return value into the
 * public {@link ApproveReport}. The primitive answers the downstream
 * {@link EdgePayload} (`null` = the node was not `blocked`); the report only
 * needs the fact that the approval was applied.
 */
export function approveReport(edgePayload: EdgePayload | null): ApproveReport {
  return { applied: edgePayload !== null };
}

/**
 * Result of {@link rejectBlockedNode}, and of the public `EngineRuntime
 * .rejectNode` (contract C6).
 *
 * A discriminated union (B16): `actualStatus` exists only on the
 * `already_resolved` branch, so a caller that needs it must first narrow on
 * `kind`. The previous optional-field form made "the reject was a no-op
 * because the node was already resolved" and "a genuine rejection lane"
 * structurally indistinguishable — and a consumer reading `actualStatus`
 * without checking `kind` got `undefined` for every real rejection.
 */
export type RejectReport =
  | { kind: "escalate" }
  | { kind: "revise" }
  | {
      kind: "already_resolved";
      /**
       * The actual node status at the time of the no-op reject (e.g.
       * Completed, Escalate, Done).
       */
      actualStatus: NodeStatus;
    };

/** Result of {@link pruneDownstreamSubgraph}. */
export interface PruneReport {
  /** Nodes cancelled (transitively dependent on rejected results, cannot survive). */
  cancelled: string[];
  /** Downstream nodes that survive on their remaining approved upstream sources. */
  surviving: string[];
}

/** Result of {@link reenterRejectedUpstreams}. */
export interface ReentryReport {
  /** Rejected upstream nodes re-marked `ready` and added to the frontier. */
  reEntered: string[];
}

// ── Approval payload normalization (R6) ─────────────────────────────────────

/** Deepest nesting {@link normalizeApprovalPayload} walks before truncating. */
const MAX_PAYLOAD_DEPTH = 64;

/** Placeholder a cyclic payload reference normalizes to. */
const CIRCULAR_PAYLOAD_MARKER = "[Circular]";

/** Placeholder for a payload nested deeper than {@link MAX_PAYLOAD_DEPTH}. */
const MAX_DEPTH_PAYLOAD_MARKER = "[MaxDepth]";

/** Placeholder for a payload whose own property access throws. */
const UNREADABLE_PAYLOAD_MARKER = "[Unreadable]";

/**
 * JSON-safe value produced by {@link normalizeApprovalPayload}: exactly the
 * subset of `unknown` that survives `JSON.stringify` + `JSON.parse` without
 * loss or a throw.
 */
export type ApprovalJsonValue =
  | string
  | number
  | boolean
  | null
  | ApprovalJsonValue[]
  | { [key: string]: ApprovalJsonValue };

/**
 * Normalize one value, answering `undefined` for the members JSON drops
 * (undefined / function / symbol on an object member) — the caller decides
 * whether to drop or null-placehold them.
 */
function normalizeApprovalValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): ApprovalJsonValue | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // JSON has no NaN / ±Infinity — they serialize to null.
      return Number.isFinite(value) ? value : null;
    case "bigint":
      // Explicitly handled (R6c): a raw BigInt makes JSON.stringify throw.
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      // JSON.stringify drops these as object members and renders null in
      // arrays; the caller applies whichever is right for the position.
      return undefined;
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return null;
  const obj: object = value;
  if (seen.has(obj)) return CIRCULAR_PAYLOAD_MARKER;
  if (depth >= MAX_PAYLOAD_DEPTH) return MAX_DEPTH_PAYLOAD_MARKER;
  seen.add(obj);

  let normalized: ApprovalJsonValue;
  try {
    if (Array.isArray(obj)) {
      normalized = obj.map((item) => {
        const itemValue = normalizeApprovalValue(item, depth + 1, seen);
        return itemValue === undefined ? null : itemValue;
      });
    } else {
      const record = asRecord(obj);
      const toJson = record?.["toJSON"];
      if (record !== undefined && typeof toJson === "function") {
        // Honour `toJSON` the way JSON.stringify does (Date, URL, ...).
        const jsonValue = normalizeApprovalValue(toJson.call(obj), depth + 1, seen);
        normalized = jsonValue === undefined ? null : jsonValue;
      } else {
        const members: Record<string, ApprovalJsonValue> = {};
        for (const [key, item] of Object.entries(record ?? {})) {
          const memberValue = normalizeApprovalValue(item, depth + 1, seen);
          if (memberValue !== undefined) members[key] = memberValue;
        }
        normalized = members;
      }
    }
  } catch {
    // A getter / Proxy / `toJSON` that throws must not escape this function:
    // "never throws" is its contract (R6c), and its caller may be mid-way
    // through preparing an approval.
    normalized = UNREADABLE_PAYLOAD_MARKER;
  }

  // Delete after the walk so a value shared by two branches is duplicated
  // (exactly what JSON.stringify does) instead of being reported as circular.
  seen.delete(obj);
  return normalized;
}

/**
 * Why `value` is not acceptable as an approval payload, or `undefined` when it
 * is (R6a).
 *
 * The public approval entry points accept `unknown`, so this is the trust
 * boundary: a payload that JSON cannot represent — a `bigint` (`JSON.stringify`
 * throws), a function or symbol (silently dropped), a circular reference
 * (throws), or an object member whose read throws — is reported so the caller
 * can reject it BEFORE the state machine runs, instead of half-completing the
 * node. `undefined` is legal (it means "no payload"; the caller falls back to
 * the node's recorded approval summary), and `NaN` / `±Infinity` stay legal
 * because JSON renders them as `null` without throwing — the historical
 * behaviour.
 *
 * Never throws: a payload whose own property access throws is reported as
 * unacceptable rather than propagating the getter's error.
 */
export function approvalPayloadProblem(value: unknown): string | undefined {
  try {
    return jsonPayloadProblem(value, new WeakSet<object>(), "$");
  } catch {
    return "reading the payload threw (a getter or proxy rejected inspection)";
  }
}

/** Recursive worker behind {@link approvalPayloadProblem}. */
function jsonPayloadProblem(
  value: unknown,
  seen: WeakSet<object>,
  path: string,
): string | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
    case "number":
    case "undefined":
      return undefined;
    case "bigint":
      return `a bigint at ${path} (JSON.stringify would throw)`;
    case "function":
      return `a function at ${path} (JSON.stringify drops it)`;
    case "symbol":
      return `a symbol at ${path} (JSON.stringify drops it)`;
    case "object":
      break;
    default:
      return `an unsupported ${typeof value} at ${path}`;
  }
  if (value === null) return undefined;
  const obj: object = value;
  if (seen.has(obj)) return `a circular reference at ${path}`;
  seen.add(obj);

  let problem: string | undefined;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && problem === undefined; i += 1) {
      problem = jsonPayloadProblem(obj[i], seen, `${path}[${i}]`);
    }
  } else {
    for (const [key, item] of Object.entries(asRecord(obj) ?? {})) {
      problem = jsonPayloadProblem(item, seen, `${path}.${key}`);
      if (problem !== undefined) break;
    }
  }

  // Delete after the walk so a value shared by two branches is inspected in
  // both (JSON.stringify duplicates it) instead of being reported as circular.
  seen.delete(obj);
  return problem;
}

/**
 * Normalize an approval payload into a JSON-safe value, WITHOUT throwing — the
 * explicit handling R6(c) asks for.
 *
 * The public approval entry points accept `unknown` (the tool layer parses a
 * JSON argument, but the exported `EngineRuntime` API takes any value), and
 * every later consumer — the per-node `signalsObserved` ledger, the
 * `signalLedger` history, the durable `JSON.stringify` in the persistence
 * layer — assumes JSON data. Rather than reject or throw, this projects the
 * value: `bigint` becomes its decimal string (a raw BigInt makes
 * `JSON.stringify` throw), `undefined` / function / symbol become `null` at
 * the top level and in arrays and are dropped as object members (JSON
 * semantics), a cyclic reference becomes `"[Circular]"`, nesting past
 * {@link MAX_PAYLOAD_DEPTH} becomes `"[MaxDepth]"`, and a payload whose own
 * property read throws becomes `"[Unreadable]"`.
 *
 * The result is therefore safe to record and to persist, and never throws — so
 * it cannot leave the approval half-applied (R6b).
 */
export function normalizeApprovalPayload(value: unknown): ApprovalJsonValue {
  const normalized = normalizeApprovalValue(value, 0, new WeakSet<object>());
  if (normalized !== undefined) return normalized;
  // Top-level undefined / function / symbol: JSON.stringify would answer
  // `undefined` (a type lie for the string-typed `EdgePayload.result`), so
  // answer a stable representation instead.
  return value === undefined ? null : String(value);
}

/**
 * The downstream {@link EdgePayload.result} text for an approval output.
 *
 * Total and non-throwing (R6c). A string is returned verbatim — the historical
 * contract, so an approval note is never JSON-quoted. `null` / `undefined`
 * answer `""` (the historical empty marker). Anything else is normalized first
 * (see {@link normalizeApprovalPayload}) and then serialized, so a function /
 * symbol / BigInt / cyclic payload can no longer answer `undefined` (the
 * declared-`string` lie that left a node `completed` with a downstream
 * activation that could never run) and can no longer throw between the state
 * mutation and the edge emission.
 */
export function approvalResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  const text = JSON.stringify(normalizeApprovalPayload(value));
  return text === undefined ? "" : text;
}

// ── Feedback merging ────────────────────────────────────────────────────────

/**
 * Append rejection feedback to a node's re-execution prompt so the re-run sees
 * why it was rejected. Returns the prompt unchanged when there is no reason.
 */
export function mergeRejectionFeedback(prompt: string, reason?: string): string {
  const text = reason?.trim();
  if (!text) return prompt;
  return `${prompt}\n\n[Rejection feedback]:\n${text}`;
}

// ── Approve primitive ───────────────────────────────────────────────────────

/**
 * Resolve an approval: transition the blocked node to `completed` and record an
 * `answer` signal for it, returning the {@link EdgePayload} the caller should
 * route downstream along the `answer` lane.
 *
 * - The approval's payload (the agent-rendered summary from the `need_approval`
 *   signal, or the caller-provided payload) becomes the node's `answer` output.
 * - `blocked → completed` (completed is a legal blocked exit) marks the node
 *   terminal-success and lets downstream `on_signal(answer)` / `always` edges
 *   activate via the caller's forward-data-flow step.
 *
 * R6 error/state contract:
 *
 * - The caller-supplied payload must be a JSON value. A `bigint`, function,
 *   symbol, circular reference, or an object whose property read throws is
 *   rejected with a `TypeError` BEFORE anything mutates
 *   ({@link approvalPayloadProblem}) — the node keeps its `blocked` status and
 *   no `answer` is recorded. Previously such a payload left the node
 *   `completed` with `EdgePayload.result === undefined`, so the downstream
 *   join could never activate.
 * - An accepted payload is normalized to a JSON-safe value before it is
 *   recorded ({@link normalizeApprovalPayload}), and the downstream `result`
 *   text is built before the node's lifecycle changes — a failure while
 *   preparing the edge payload can therefore never leave the node
 *   `completed` with its downstream activation missing.
 *
 * @returns The downstream {@link EdgePayload}, or `null` when the node was not
 *   actually `blocked` (a no-op guard — approve is idempotent).
 */
export function approveBlockedNode(
  state: EngineState,
  node: NodeRuntimeState,
  payload?: unknown,
): EdgePayload | null {
  if (node.status !== NodeStatus.Blocked) return null;

  // Derive the answer output from the caller payload, else the agent-rendered
  // `need_approval` summary, else a plain accept marker.
  const raw = node.signalsObserved["need_approval"];
  // R6(a): the caller-supplied payload is the trust boundary — reject a
  // non-JSON value BEFORE the state machine runs, so an unacceptable payload
  // leaves the node exactly as it was (previously the node was marked
  // `completed` and the downstream activation silently never happened). The
  // node's own recorded `need_approval` summary is engine data, not caller
  // input, so it is normalized rather than rejected — a malformed recorded
  // summary must not make a node permanently unapprovable.
  if (payload !== undefined) {
    const problem = approvalPayloadProblem(payload);
    if (problem !== undefined) {
      throw new TypeError(
        `approveBlockedNode: the approval payload for node "${node.nodeId}" is not a JSON value — ` +
          `${problem}. The approval was NOT applied. Pass a JSON-serializable payload ` +
          `(string, number, boolean, null, array, or plain object).`,
      );
    }
  }

  const answerOutput =
    payload !== undefined
      ? payload
      : typeof raw === "string" && raw.length > 0
        ? raw
        : "approved";

  // R6(a): normalize the payload ONCE, before anything mutates. The public
  // entry points accept `unknown` (a published-package surface — narrowing the
  // parameter would break existing direct callers and the tool layer), so the
  // explicit normalization here is the trust boundary: every later consumer
  // (the per-node ledger, the `signalLedger` history, the durable
  // `JSON.stringify`) can safely serialize the recorded value.
  const normalizedOutput = normalizeApprovalPayload(answerOutput);
  // R6(b): build the downstream `result` text BEFORE `markCompleted`. The
  // normalizer is total so this cannot throw today, but the ordering IS the
  // contract: a serialization failure must leave the node untouched instead of
  // `completed` with its forward data flow never emitted (which strands every
  // downstream join forever).
  const resultText = approvalResultText(answerOutput);

  // Record the synthetic `answer` signal through the shared ledger write path
  // (observability only — no listener firing, which would re-enter the
  // advancement critical section). The caller drives the forward answer flow.
  recordSignalToLedger(state, node.nodeId, "answer", normalizedOutput, "approval");
  // Ensure the node's genuinely produced artifacts are recorded before the
  // EdgePayload is built, so the downstream node's upstreamResults carry them
  // (same data-flow gap as _buildEdgePayload — subtask C-RECORD).
  recordNodeArtifactsAndEvidence(state, node);
  markCompleted(state, node);

  const tc = node.tokensConsumed;
  return {
    fromNode: node.nodeId,
    fromSignal: "answer",
    result: resultText,
    artifacts: node.artifacts ?? deriveNodeArtifacts(node),
    budgetConsumed: {
      tokens: tc.inputTokens + tc.outputTokens,
      cost: tc.cost,
      sessions: node.sessionsSpawned,
    },
  };
}

// ── Reject primitive ────────────────────────────────────────────────────────

/**
 * Resolve a rejection on a blocked `needs_approval` node.
 *
 * - No loop group → the rejection has nowhere to re-enter; the node escalates
 *   with the rejection reason (`blocked → escalate`, added Phase 3). This keeps
 *   the graph from proceeding with un-reviewed changes (safety-first timeout /
 *   reject behavior, §1.3).
 * - Loop group present → the node re-enters `ready` (blocked → ready) with the
 *   rejection feedback merged into its re-execution prompt, so it (and the loop
 *   that feeds it) re-runs. Callers that want the loop group's upstream nodes
 *   re-entered as well reuse `propagateRevise` (signal-propagation.ts) on the
 *   feeding convergence node.
 *
 * Pure state mutation — never dispatches. Re-entered-`ready` nodes are added to
 * the frontier for the caller's `_dispatchReadyNodes` step.
 *
 * @returns {@link RejectReport} describing the lane taken.
 */
export function rejectBlockedNode(
  state: EngineState,
  node: NodeRuntimeState,
  reason?: string,
): RejectReport {
  if (node.status !== NodeStatus.Blocked) {
    // Idempotent guard: replaying a reject on an already-resolved node is a
    // no-op. Return an accurate `actualStatus` so callers can distinguish a
    // genuine rejection from a stale replay.
    return { kind: "already_resolved", actualStatus: node.status };
  }

  const reasonText = typeof reason === "string" && reason.trim() ? reason.trim() : "rejected";
  // Record the synthetic `revise_needed` signal through the shared ledger write
  // path (observability only — no listener firing, which would re-enter the
  // advancement critical section). The caller drives the re-entry / escalate.
  recordSignalToLedger(state, node.nodeId, "revise_needed", reasonText, "approval");

  if (!node.loopGroupId) {
    markEscalated(state, node, reasonText);
    removeFromFrontier(state, node.nodeId);
    return { kind: "escalate" };
  }

  node.prompt = mergeRejectionFeedback(node.prompt, reasonText);
  markReady(state, node);
  addToFrontier(state, node.nodeId);
  return { kind: "revise" };
}

// ── Partial-approve primitives ──────────────────────────────────────────────

/**
 * Phase 1 + Phase 2 of the partial-approval algorithm (orchestration-patterns.md
 * §1.5): find every node transitively downstream of a rejected upstream branch
 * and cancel those that cannot survive on their remaining approved sources
 * alone.
 *
 * - Phase 1 BFS: collect nodes transitively reachable from any rejected node
 *   along `always` / `on_signal(answer)` edges, excluding the approval node
 *   itself (it stays put to re-render).
 * - Phase 2: for each downstream node, cancel it when it has no surviving
 *   approved upstream, or when its join cannot be met by approved sources alone
 *   (`all` needs every feeder; `quorum:N` needs N). `any` joins survive on a
 *   single approved source. Nodes that depend on a mix of approved + rejected
 *   upstream are **not** cancelled — they enter a partial-await and re-join once
 *   the rejected source re-executes and re-answers (§1.5 rule 2).
 *
 * Cancelled nodes transition `pending | ready | running → cancelled → done`
 * (reusing the cascade-canceller lifecycle pattern) and, when a cancel seam is
 * present, their dispatch tasks are torn down fire-and-forget (never awaited).
 *
 * @param rejectedNodeIds   Upstream branches the human rejected.
 * @param approvalNodeId    The `needs_approval` node issuing the partial verdict.
 * @param dispatchPort      Optional cancellation seam (task teardown).
 */
export function pruneDownstreamSubgraph(
  state: EngineState,
  rejectedNodeIds: string[],
  approvalNodeId: string,
  dispatchPort?: CancelDispatchPort,
): PruneReport {
  const rejected = new Set(rejectedNodeIds);
  if (rejected.size === 0) return { cancelled: [], surviving: [] };

  // Precondition guard: pruning only makes sense when the approval node is
  // indeed a `needs_approval` gate. A non-gate node has no human-decision
  // lifecycle and partial-approval semantics do not apply — return early
  // with an empty result to avoid corrupting the graph.
  const approvalNode = state.nodes.get(approvalNodeId);
  if (!approvalNode || !approvalNode.needsApproval) {
    return { cancelled: [], surviving: [] };
  }

  // ── Phase 1: transitive downstream of every rejected node ─────────────────
  const downstream = new Set<string>();
  const queue = [...rejected];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of state.graphDeclaration.edges) {
      if (edge.from !== current) continue;
      // Only answer-forward lanes carry a rejected branch's effect downstream.
      const activates =
        edge.type === "always" ||
        (edge.type === "on_signal" && (edge.signal_filter ?? []).includes("answer"));
      if (!activates) continue;
      if (edge.to === approvalNodeId) continue; // approval node re-renders, not cancelled
      if (downstream.has(edge.to)) continue;
      downstream.add(edge.to);
      queue.push(edge.to);
    }
  }

  // ── Phase 2: cancel nodes that cannot survive on approved sources alone ────
  const cancelled: string[] = [];
  const surviving: string[] = [];

  for (const nodeId of downstream) {
    const node = state.nodes.get(nodeId);
    if (!node) continue;

    // Approved upstreams = feeders not in the rejected set (topology view — a
    // still-pending approved feeder may yet answer).
    const upstreamIds = getUpstreamNodeIds(state, node);
    const approvedCount = upstreamIds.filter((id) => !rejected.has(id)).length;
    const strategy = getJoinStrategy(state, node);

    if (shouldCancel(approvedCount, upstreamIds.length, strategy)) {
      cancelNode(state, node, dispatchPort);
      cancelled.push(nodeId);
    } else {
      surviving.push(nodeId);
    }
  }

  return { cancelled, surviving };
}

/**
 * Whether a downstream node must be cancelled given its surviving approved
 * upstream count. Mirrors §1.5 Phase 2: zero approved sources, an `all` join
 * (a rejected feeder exists, so "all" can never be met from approved alone), or
 * a `quorum:N` that can no longer be reached. `any` survives on one approved
 * source.
 */
function shouldCancel(
  approvedCount: number,
  upstreamTotal: number,
  strategy: ReturnType<typeof getJoinStrategy>,
): boolean {
  if (upstreamTotal === 0) return false;
  if (approvedCount === 0) return true;
  // Contract C1: the quorum count is read through the shared
  // {@link readQuorum} accessor — the SAME accessor `evaluateJoin` uses — so
  // the join-evaluation and cancellation lanes can never interpret a strategy
  // differently (R3: a bare `"quorum"` string used to resolve to `all` here
  // and `false`/"any" in `shouldCancel`, i.e. two opposite semantics for one
  // value). `undefined` means the strategy carries no quorum count.
  const quorum = readQuorum(strategy);
  if (quorum !== undefined) return approvedCount < quorum;
  if (strategy === JoinStrategy.All) return true;
  // "any" — at least one approved source survives.
  return false;
}

/**
 * Re-enter the rejected upstream nodes `ready` with the rejection feedback so
 * they re-execute and re-answer, which re-satisfies the approval node's join.
 * Only nodes currently transitionable to `ready` are re-entered (completed →
 * ready; never a still-running or terminal node).
 */
export function reenterRejectedUpstreams(
  state: EngineState,
  rejectedNodeIds: string[],
  reason?: string,
): ReentryReport {
  const report: ReentryReport = { reEntered: [] };
  for (const nodeId of rejectedNodeIds) {
    const node = state.nodes.get(nodeId);
    if (!node || !canTransitionNode(node.status, NodeStatus.Ready)) continue;
    node.prompt = mergeRejectionFeedback(node.prompt, reason);
    markReady(state, node);
    addToFrontier(state, nodeId);
    report.reEntered.push(nodeId);
  }
  return report;
}

/**
 * Clear the rejected sources from an approval node's accumulated upstream
 * results and recompute its join satisfaction, so the approval node re-waits
 * for the rejected branches to re-execute and re-answer before it re-renders.
 * Returns the recomputed join verdict via `node.joinSatisfied`.
 */
export function resetRejectedUpstreams(
  state: EngineState,
  node: NodeRuntimeState,
  rejectedNodeIds: string[],
): void {
  for (const id of rejectedNodeIds) {
    node.upstreamResults.delete(id);
  }
  node.joinSatisfied = joinSatisfied(state, node);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Cancel a node's lifecycle (`pending | ready | running → cancelled → done`) and,
 * when a cancel seam is present and the node carries a dispatch task, tear it
 * down fire-and-forget (never awaited). Delegates to the shared
 * {@link retireCancelledNode} primitive with the M10 session-slot refund ON —
 * a RUNNING node with a live dispatch task decrements the graph-level
 * `sessionsSpawned` counter synchronously (the termination callback
 * `engine-recovery.ts:416` bails on the now-`done` node, so without this the
 * partial-approve prune lane would leak the slot — same rationale as
 * `cancelOne` in `cancellation.ts`).
 */
function cancelNode(
  state: EngineState,
  node: NodeRuntimeState,
  dispatchPort?: CancelDispatchPort,
): void {
  retireCancelledNode(
    state,
    node,
    `cancelled by partial-approval pruning at "${state.graphId}"`,
    { refund: true, dispatchPort },
  );
}
