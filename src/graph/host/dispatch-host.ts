/**
 * Graph Execution Engine v2 — the host's dispatch-execution adapter
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE HOST IMPLEMENTATION OF THE DISPATCH-EFFECT CONTRACT (D8). The runtime
 * (`src/graph/outcome/runtime.ts`) commits a dispatch effect and the state it
 * belongs to in ONE transaction, then calls this adapter to start the node:
 *
 * - `create(request, effect)` starts one execution, IDEMPOTENTLY per
 *   `(graphId, effectId)`. A second create for an effect this host already
 *   recorded is a NO-OP: it never delivers a second time. That is what makes
 *   "at most one execution" a property of the adapter rather than a hope about
 *   the caller.
 * - `lookup(effect)` answers whether an execution for that stable id exists —
 *   `created`, `absent` or `unknown` — from {@link HostExecutionIndex},
 *   never from a guess.
 *
 * WHERE THE CREDENTIAL GOES. The request this adapter receives is the ONLY
 * carrier of the attempt credential (`OutcomeDispatchRequest`), and it is
 * handed unchanged to the injected `deliver` seam — one attempt, one request,
 * one delivery. The adapter itself keeps no copy, puts none in the execution
 * index (which records effect ids only) and returns nothing that could carry
 * one: a `create` that throws reports the failure, and the runtime sanitizes
 * the text against the request it already holds.
 *
 * WHAT A DELIVERY FAILURE MEANS. If `deliver` throws, the execution did not
 * start, so the effect is UN-RECORDED and the error is rethrown: the ledger row
 * the runtime committed stays `pending`, its later recovery asks this adapter
 * again and creates exactly once from there. The reverse window — a crash
 * between the record and the delivery — is described in
 * `execution-index.ts`: the host prefers a reported attempt over a second
 * execution, because running one attempt twice is the failure the contract
 * exists to prevent.
 *
 * THE INVOCATION TRAVELS WITH THE DELIVERY. A platform starts a worker under a
 * parent invocation (dsh composes the subagent under a live parent session, Pi
 * launches the task under one), and the window that arms a dispatch is not
 * always the declaring call: a successor is armed by an acceptance observed
 * later, out of band. The adapter therefore hands the delivery the host's
 * attribution of the graph's declaring invocation
 * ({@link HostOutcomeDispatchOptions.dispatchInvocation}) as a third argument,
 * so every window names the same parent. A host that knows no origin hands
 * none, and the platform reports the absence instead of guessing one.
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
} from "../outcome/dispatch-effects.ts";
import type { HostInvocationIdentity } from "../outcome/host-identity.ts";
import { HostExecutionIndex } from "./execution-index.ts";

// ── The seam and the completion sink ────────────────────────────────────────

/**
 * How the host actually runs one node.
 *
 * SYNCHRONOUS on purpose, exactly like the runtime's dispatch seam: the
 * contract is "hand the request to the platform", not "wait for the worker".
 * The completion of the attempt arrives later and out of band, through
 * {@link HostCompletionBindingSink} and `completion-bridge.ts`.
 *
 * The platform MUST dedupe on the stable effect id when it can: this adapter
 * never delivers one effect twice in its own lifetime, but a host process that
 * dies inside this call cannot know whether the platform got the request first.
 */
export type HostDispatchDelivery = (
  request: OutcomeDispatchRequest,
  effect: OutcomeDispatchEffectKey,
  invocation?: HostDispatchInvocation,
) => void;

/**
 * The platform invocation a graph's attempt is dispatched under, as the host
 * attributes it.
 *
 * A SESSION, and optionally the agent acting in it. Both components are
 * optional in the type because they carry different weights: the platform needs
 * the session to compose the worker under its parent, while the agent is the
 * attribution a host may additionally declare (D9). The host passes the value
 * it recorded for the GRAPH, so the declaring call, a worker's accepted
 * submission, an observed completion and a boot sweep all name the same parent.
 */
export interface HostDispatchInvocation {
  readonly sessionId?: string;
  readonly agent?: string;
}

/** The attempt identity one delivery is bound to, for the completion bridge. */
export interface HostAttemptBinding {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  /**
   * The HOST INVOCATION the attempt was dispatched under (D9), captured from
   * the host's attribution at the moment the delivery was created — the same
   * identity the runtime recorded on the attempt.
   *
   * It is carried on the binding so a completion observed LATER, when no
   * invocation is in effect any more, can be settled in the attribution of the
   * invocation that dispatched the attempt instead of being refused
   * `host-identity-absent`. Absent means the attempt recorded no identity
   * (the host declared none for that invocation), and nothing fabricates one.
   */
  readonly dispatchIdentity?: HostInvocationIdentity;
}

/**
 * Where the adapter reports the bindings it created, so the host can settle an
 * attempt when its worker completes. Optional: a host that drives completion
 * another way (or not at all) passes none, and the adapter only dispatches.
 */
export interface HostCompletionBindingSink {
  bind(binding: HostAttemptBinding): void;
}

/** Inputs to {@link HostOutcomeDispatch}. */
export interface HostOutcomeDispatchOptions {
  /** The host's durable record of what it created (see `execution-index.ts`). */
  readonly executions: HostExecutionIndex;
  /** The platform call that starts one node. */
  readonly deliver: HostDispatchDelivery;
  /** Optional completion-binding sink, for a host that settles completions. */
  readonly completions?: HostCompletionBindingSink;
  /**
   * The host's invocation attribution at delivery time, read once per created
   * execution and recorded on the binding. Optional: a host that declares no
   * invocation identity passes none and every binding carries none.
   */
  readonly invocation?: () => HostInvocationIdentity | undefined;
  /**
   * The invocation the platform dispatches this GRAPH's attempts under, read
   * once per created execution and handed to {@link HostDispatchDelivery}. It is
   * a per-graph fact (the declaring invocation), not "whoever is acting now":
   * the successor armed by a completion must be started under the same parent as
   * the entry attempt, and the completion is observed when no tool call is in
   * effect. Optional: a host that keeps no such record passes none, and the
   * platform reports the unnamed dispatch instead of inventing a parent.
   */
  readonly dispatchInvocation?: (
    graphId: string,
  ) => HostDispatchInvocation | undefined;
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** The host's dispatch-execution adapter for the outcome run path. */
export class HostOutcomeDispatch implements OutcomeDispatchHost {
  private readonly executions: HostExecutionIndex;
  private readonly deliver: HostDispatchDelivery;
  private readonly completions: HostCompletionBindingSink | undefined;
  private readonly invocation: (() => HostInvocationIdentity | undefined) | undefined;
  private readonly dispatchInvocation:
    | ((graphId: string) => HostDispatchInvocation | undefined)
    | undefined;

  constructor(options: HostOutcomeDispatchOptions) {
    this.executions = options.executions;
    this.deliver = options.deliver;
    this.completions = options.completions;
    this.invocation = options.invocation;
    this.dispatchInvocation = options.dispatchInvocation;
  }

  /**
   * Start one effect's execution, at most once per `(graphId, effectId)`.
   *
   * A recorded effect is NOT delivered again — that is the idempotency rule the
   * contract states, enforced here rather than assumed of the caller. An
   * unrecorded one is recorded FIRST (so a crash inside the delivery leaves the
   * attempt reported rather than re-dispatched) and un-recorded when the
   * delivery throws (so the execution that did not start can be created once by
   * the next recovery).
   */
  create(request: OutcomeDispatchRequest, effect: OutcomeDispatchEffectKey): void {
    if (effect.graphId !== request.graphId || effect.attemptId !== request.attemptId) {
      throw new Error(
        "host-dispatch: refusing to create effect " +
          JSON.stringify(effect.effectId) +
          " for a request that names graph " +
          JSON.stringify(request.graphId) +
          " attempt " +
          JSON.stringify(request.attemptId) +
          " — the effect key and the request must describe the same execution",
      );
    }
    if (this.executions.has(effect)) return;
    this.executions.record(effect);
    // The platform invocation is read HERE, inside the runtime's dispatch
    // window, and from the GRAPH's recorded origin rather than from the ambient
    // attribution: a successor settled out of band must run under the invocation
    // that declared the graph, not under whoever happens to be acting.
    const dispatchInvocation = this.dispatchInvocation?.(request.graphId);
    try {
      this.deliver(request, effect, dispatchInvocation);
    } catch (error) {
      this.executions.unrecord(effect);
      throw error;
    }
    // The identity is read HERE, synchronously inside the runtime's dispatch
    // window: it is the host's own attribution of the invocation that armed
    // this attempt, and the runtime recorded the same value on the state entry.
    const dispatchIdentity = this.invocation?.();
    this.completions?.bind({
      graphId: effect.graphId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      ...(dispatchIdentity === undefined ? {} : { dispatchIdentity }),
    });
  }

  /** Whether an execution for this effect exists, as the host can tell. */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    return this.executions.lookup(effect);
  }
}
