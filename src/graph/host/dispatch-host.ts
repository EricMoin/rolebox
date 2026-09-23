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
 *   `(graphId, effectId)`. The registry's unique key and conditional claim are
 *   what make "at most one execution" a property of the STORE: a second create
 *   — from this process or another one — is told the effect is held and delivers
 *   nothing. `confirmStarted(effect, execution)` records the platform's real
 *   execution id once it is known, which is the only way the registry reports
 *   the effect as `created`.
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
 * start, so the claim is RELEASED and the error is rethrown: the ledger row the
 * runtime committed stays `pending`, its later recovery asks this adapter again
 * and creates exactly once from there. The reverse window — a crash after the
 * request was handed over and before the platform named the execution — is
 * described in `execution-index.ts`: the row stays `creating`, `lookup`
 * answers `unknown`, and the host reports the attempt rather than running it a
 * second time, because running one attempt twice is the failure the contract
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
import {
  HostExecutionIndex,
  type HostExecutionClaim,
  type HostExecutionIdentity,
} from "./execution-index.ts";

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
   * THE THREE STEPS, IN THE ONLY SAFE ORDER. The registry is asked for the
   * create right (`claim`); the row is moved to `creating` BEFORE the platform
   * is handed anything, so the whole window in which the platform may have
   * received the request is recorded as unknown; and the delivery follows. A
   * delivery that THROWS releases the claim — the execution demonstrably did
   * not start — so the next recovery creates it once.
   *
   * AN EFFECT THAT IS HELD IS NOT DELIVERED, AND SAID SO. The previous shape
   * returned silently for an already-recorded effect, which made "another
   * process owns this create" indistinguishable from "nothing to do" at the
   * caller. A held effect now throws with the holder's state, so the runtime
   * reports the effect as unsettled instead of marking it started.
   *
   * CONFIRMATION IS SEPARATE. A synchronous delivery cannot know the platform's
   * execution id, so `create` leaves the row `creating` and
   * {@link confirmStarted} records the host fact when the platform names it. A
   * host that never confirms leaves the effect `unknown` — reported as
   * unsettled, never re-dispatched.
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
    const claim = this.executions.claim(effect);
    if (claim.kind === "held") {
      throw new Error(
        "host-dispatch: refusing to create effect " +
          JSON.stringify(effect.effectId) +
          " for graph " +
          JSON.stringify(effect.graphId) +
          " — " +
          describeHeldClaim(claim) +
          "; a second execution for one stable effect id is exactly what the create-once " +
          "rule forbids, so the request was NOT delivered",
      );
    }
    if (!this.executions.markCreating(effect, claim.ownerId)) {
      throw new Error(
        "host-dispatch: the create right for effect " +
          JSON.stringify(effect.effectId) +
          " was lost to another host process between the claim and the delivery — nothing " +
          "was delivered and the effect is reported rather than started a second time",
      );
    }
    // The platform invocation is read HERE, inside the runtime's dispatch
    // window, and from the GRAPH's recorded origin rather than from the ambient
    // attribution: a successor settled out of band must run under the invocation
    // that declared the graph, not under whoever happens to be acting.
    const dispatchInvocation = this.dispatchInvocation?.(request.graphId);
    try {
      this.deliver(request, effect, dispatchInvocation);
    } catch (error) {
      this.executions.release(effect, claim.ownerId);
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

  /**
   * Record the host execution the platform confirmed for one effect.
   *
   * This is the ONLY way a row becomes `created`, and it takes the platform's
   * real execution/task id: the registry refuses an empty one, so
   * `lookup(...).kind === "created"` always stands for a named host
   * execution. Returns `false` when no delivery of this host was in flight
   * (already confirmed, released, or never created here).
   */
  confirmStarted(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): boolean {
    return this.executions.confirm(effect, execution);
  }

  /** Whether an execution for this effect exists, as the host can tell. */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    return this.executions.lookup(effect);
  }
}

/** One held claim, described for the refusal without quoting a row wholesale. */
function describeHeldClaim(
  claim: Extract<HostExecutionClaim, { kind: "held" }>,
): string {
  if (claim.state === "created") {
    const executionId = claim.execution?.executionId;
    return (
      "a host execution for it already exists" +
      (executionId === undefined ? "" : " (" + JSON.stringify(executionId) + ")")
    );
  }
  if (claim.state === "creating") {
    return (
      "the create request was already handed to the platform and its result is UNKNOWN " +
      "(owner " +
      JSON.stringify(claim.ownerId) +
      ")"
    );
  }
  return (
    "another host process holds the create right (owner " +
    JSON.stringify(claim.ownerId) +
    ")"
  );
}
