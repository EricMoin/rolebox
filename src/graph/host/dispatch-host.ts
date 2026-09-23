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
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
} from "../outcome/dispatch-effects.ts";
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
) => void;

/** The attempt identity one delivery is bound to, for the completion bridge. */
export interface HostAttemptBinding {
  readonly graphId: string;
  readonly nodeId: string;
  readonly attemptId: string;
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
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** The host's dispatch-execution adapter for the outcome run path. */
export class HostOutcomeDispatch implements OutcomeDispatchHost {
  private readonly executions: HostExecutionIndex;
  private readonly deliver: HostDispatchDelivery;
  private readonly completions: HostCompletionBindingSink | undefined;

  constructor(options: HostOutcomeDispatchOptions) {
    this.executions = options.executions;
    this.deliver = options.deliver;
    this.completions = options.completions;
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
    try {
      this.deliver(request, effect);
    } catch (error) {
      this.executions.unrecord(effect);
      throw error;
    }
    this.completions?.bind({
      graphId: effect.graphId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
    });
  }

  /** Whether an execution for this effect exists, as the host can tell. */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    return this.executions.lookup(effect);
  }
}
