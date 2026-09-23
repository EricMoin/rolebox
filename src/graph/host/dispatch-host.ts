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
 *   `created`, `absent` or `unknown` — from the host's own registry joined
 *   with the platform's query port when one is installed, never from a guess.
 *
 * ONE DISPATCH PATH (P2 item 3). Every window that starts a node's execution
 * goes through the ONE `create` below and therefore takes the same steps in the
 * same order — claim (carrying an owner GENERATION), fence, deliver, and release
 * only WITH A PROOF:
 *
 * | window | what the runtime knows before it calls |
 * | --- | --- |
 * | first dispatch | a state and effect it just committed; nothing was created |
 * | successor | an accepted outcome armed the node; the effect is new |
 * | retry (P3) | a new ATTEMPT, hence a new effect id and a new claim |
 * | recovery after a restart | the effect may have been handed over already, so it asks `lookup` first and `create` only on `absent` |
 *
 * The windows differ in what the RUNTIME knows; the host creates the same way,
 * and the store's conditional writes are the only authority either of them has.
 * A create that finds the effect HELD does not guess: it may adopt a stranded
 * `creating` claim only when the PLATFORM PROVES there is no execution for the
 * stable key (the query port, `OutcomeExecutionQuery`), and it refuses otherwise.
 *
 * ONLY A PROOF RELEASES THE CREATE RIGHT (P2 item 4). The SEAM has two failure
 * channels and they are not equivalent:
 *
 * - a SYNCHRONOUS THROW is the delivery's refusal to hand the request over at
 *   all — the contract below makes that the seam's own proof that nothing was
 *   created — so the claim is released and exactly one later create can follow;
 * - an ASYNCHRONOUS failure (a rejected start, a callback that never arrives, a
 *   timeout) proves nothing. It is reported through the host's own failure
 *   report, which this adapter's registry path implements as a proof-less
 *   release: the claim is KEPT, the row stays `creating`, every lookup answers
 *   `unknown`, and the effect is reported as unresolved — never re-dispatched
 *   blindly.
 *
 * `created` IS STILL ONLY EVER WRITTEN WITH A REAL EXECUTION ID. A timeout or a
 * failure cannot reach it, and the store's own CHECK makes the alternative
 * unrepresentable.
 *
 * IDEMPOTENCY AND CORRELATION (P2 item 5). The create call carries the stable
 * effect identity — `(graphId, effectId)` with `effectId = "dispatch:" + attemptId` —
 * which is the key a platform must dedupe and correlate on; a platform that
 * needs one string uses `dispatchIdempotencyKeyOf`. The QUERY PORT is the other
 * half: a host that installs one can have a stranded `creating` effect PROVEN
 * absent and released, and one that does not answers `unknown` and BLOCKS. The
 * shipped dsh/Pi adapters do not implement the port yet (see
 * `dispatch-effects.ts` and §8.1 of the execution plan), so this build
 * implements the local half only.
 *
 * WHERE THE CREDENTIAL GOES. The request this adapter receives is the ONLY
 * carrier of the attempt credential (`OutcomeDispatchRequest`), and it is handed
 * unchanged to the injected `deliver` seam — one attempt, one request, one
 * delivery. The adapter itself keeps no copy, puts none in the execution index
 * (which records effect ids only) and returns nothing that could carry one: a
 * `create` that throws reports the failure, and the runtime sanitizes the text
 * against the request it already holds.
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

import { logWarn } from "../log-warn.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchHost,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
  OutcomeExecutionQuery,
} from "../outcome/dispatch-effects.ts";
import { dispatchIdempotencyKeyOf } from "../outcome/dispatch-effects.ts";
import type { HostInvocationIdentity } from "../outcome/host-identity.ts";
import {
  HostExecutionIndex,
  hostExecutionNotCreated,
  type HostExecutionClaim,
  type HostExecutionIdentity,
  type HostExecutionNotCreated,
} from "./execution-index.ts";

// ── The seam and the completion sink ────────────────────────────────────────

/**
 * How the host actually runs one node.
 *
 * SYNCHRONOUS on purpose, exactly like the runtime's dispatch seam: the
 * contract is "hand the request to the platform", not "wait for the worker".
 *
 * THE TWO FAILURE CHANNELS, AND WHAT THEY MEAN. A delivery that throws
 * SYNCHRONOUSLY declares that it did NOT hand the request to the platform: the
 * adapter treats that as the proof it needs to release the create right. A
 * delivery that may have handed the request over and then failed — a rejected
 * start promise, a timeout, a lost callback — MUST NOT throw for it; it reports
 * the failure through the host's asynchronous failure report, which carries no
 * proof and therefore keeps the claim. Throwing synchronously for a failure
 * that may have created something is the one way to make this seam lie.
 *
 * THE PLATFORM SHOULD DEDUPE ON THE STABLE KEY WHEN IT CAN (the second
 * argument, or its `dispatchIdempotencyKeyOf` spelling): this adapter never
 * delivers one effect twice in its own lifetime, and it only ever re-delivers a
 * claim the platform PROVED empty, but no local rule can speak for a request a
 * dead process may have handed over.
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
  /**
   * The PLATFORM'S own answer about whether an execution exists for one stable
   * effect id (P2 item 5). Optional: a host that cannot ask the platform
   * answers `unknown` for a `creating` effect and blocks, which is the honest
   * behaviour and the one the shipped entries have today.
   *
   * With a port installed, an `absent` answer is a PROOF: it can release a
   * stranded claim so the attempt is created exactly once, and it joins the
   * host's own answer so a lookup never turns "I cannot see" into `absent`.
   */
  readonly query?: OutcomeExecutionQuery;
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
  readonly dispatchInvocation?: (graphId: string) => HostDispatchInvocation | undefined;
}

// ── The adapter ─────────────────────────────────────────────────────────────

/** The host's dispatch-execution adapter for the outcome run path. */
export class HostOutcomeDispatch implements OutcomeDispatchHost {
  private readonly executions: HostExecutionIndex;
  private readonly deliver: HostDispatchDelivery;
  private readonly query: OutcomeExecutionQuery | undefined;
  private readonly completions: HostCompletionBindingSink | undefined;
  private readonly invocation: (() => HostInvocationIdentity | undefined) | undefined;
  private readonly dispatchInvocation:
    | ((graphId: string) => HostDispatchInvocation | undefined)
    | undefined;

  constructor(options: HostOutcomeDispatchOptions) {
    this.executions = options.executions;
    this.deliver = options.deliver;
    this.query = options.query;
    this.completions = options.completions;
    this.invocation = options.invocation;
    this.dispatchInvocation = options.dispatchInvocation;
  }

  /**
   * Start one effect's execution, at most once per `(graphId, effectId)`.
   *
   * THE ONE DISPATCH PATH (see the module header): first dispatch, successor,
   * retry and recovery all take these steps, in this order.
   *
   * 1. CLAIM. The store's unique key hands the create right to exactly one
   *    claimant and mints the GENERATION that claim's later writes must present.
   * 2. ADOPT ONLY ON A PROOF. An effect that is held is normally not delivered.
   *    The one exception is a `creating` claim the PLATFORM proves has no
   *    execution: the stale claim is released by the claim the caller observed,
   *    and the effect is claimed again. No proof means the create refuses.
   * 3. FENCE, THEN DELIVER. The row is moved to `creating` BEFORE the platform
   *    is handed anything, and only by this claim's `(owner, generation)`; a
   *    claim that lost the right cannot deliver.
   * 4. RELEASE ONLY WITH A PROOF. A synchronous delivery refusal means nothing
   *    was handed over, so that claim (and only that claim) is released —
   *    re-creating once, later, is then safe. An asynchronous failure takes the
   *    other channel and keeps the claim.
   * 5. BIND. The completion binding is recorded for the attempt this delivery
   *    created, so a completion observed later can be settled.
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
    let claim = this.executions.claim(effect);
    if (claim.kind === "held") {
      const adopted = this.adoptStrandedEffect(effect, claim);
      if (adopted === undefined) {
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
      claim = adopted;
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
      // THE SEAM'S PROOF, AND ONLY THE SEAM'S: a synchronous throw is the
      // delivery refusing to hand the request over (see HostDispatchDelivery),
      // so this claim — the one that just fenced this delivery — may be
      // released and a later recovery creates the attempt exactly once. The
      // release is conditional on (owner, generation): if another process has
      // taken the row over in the meantime, nothing is released.
      this.executions.release(
        effect,
        claim.ownerId,
        hostExecutionNotCreated(
          "the delivery refused synchronously, before handing the request to the platform",
        ),
      );
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
   * `lookup(...).kind === "created"` always stands for a named host execution.
   *
   * FENCED. The confirmation is applied only if THIS process still holds the
   * claim that marked the effect `creating` — the store's conditional update
   * names `(owner_id, owner_generation)`. A LATE confirmation from an expired
   * owner (a claim that was released and re-taken, or a process restarted under
   * the same owner id) writes nothing, is reported as `false`, and is recorded on
   * the row as a refusal; the host's own execution index exposes the full verdict
   * (`HostExecutionIndex.confirmExecution`) for a caller that reports it.
   *
   * Returns `false` when the row is not this claim's `creating` row — already
   * confirmed, released, fenced, or never created here.
   */
  confirmStarted(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): boolean {
    return this.executions.confirm(effect, execution);
  }

  /**
   * Whether an execution for this effect exists, as the host can tell.
   *
   * THE JOIN OF TWO ANSWERERS, and it is deliberately conservative: the host's
   * own durable registry answers for every create it performed, and the platform
   * query port (when installed) answers for what the platform holds. `created`
   * from either side is a fact; `unknown` from either side (with the other side
   * not confirming `created`) is the answer; `absent` requires BOTH to say that
   * no execution exists. A port that cannot answer therefore never degrades into
   * "absent" — which is what would license a second create.
   */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    return joinExecutionLookups(this.executions.lookup(effect), this.platformLookup(effect));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * A held effect this process may still create, or `undefined` when it may not.
   *
   * Exactly one case qualifies: the row is `creating` and the PLATFORM proves
   * there is no execution for the stable key. That is the crash window's other
   * half after an unproven failure (a claim kept `creating` forever otherwise),
   * and the proof is what makes re-creating safe. A `created` row is an execution
   * that exists; a `pending` row is a live claim whose own lease decides — neither
   * is adopted here.
   */
  private adoptStrandedEffect(
    effect: OutcomeDispatchEffectKey,
    held: Extract<HostExecutionClaim, { kind: "held" }>,
  ): Extract<HostExecutionClaim, { kind: "claimed" }> | undefined {
    if (held.state !== "creating") return undefined;
    const proof = this.proofOfAbsence(effect);
    if (proof === undefined) return undefined;
    if (!this.executions.releaseStale(effect, held, proof)) return undefined;
    const reclaimed = this.executions.claim(effect);
    return reclaimed.kind === "claimed" ? reclaimed : undefined;
  }

  /**
   * The proof that no execution exists for this effect, from the PLATFORM only.
   *
   * `undefined` without a port, when the port cannot answer, and when the port
   * answers `created` — an unanswerable question is never a proof, and a platform
   * that reports an execution is not asked to prove one does not exist.
   */
  private proofOfAbsence(
    effect: OutcomeDispatchEffectKey,
  ): HostExecutionNotCreated | undefined {
    const answer = this.platformLookup(effect);
    if (answer === undefined || answer.kind !== "absent") return undefined;
    return hostExecutionNotCreated(
      "the platform's execution query reports no execution for " +
        dispatchIdempotencyKeyOf(effect),
    );
  }

  /**
   * The platform's own answer, or `undefined` when no port is installed.
   *
   * A port that THROWS has not answered: the failure is reported as `unknown`
   * (never as `absent`, and never as a proof), with a message that says the port
   * itself failed rather than quoting host text — the request carries an attempt
   * credential and a platform error string is exactly the kind of place one could
   * surface.
   */
  private platformLookup(
    effect: OutcomeDispatchEffectKey,
  ): OutcomeExecutionLookup | undefined {
    const query = this.query;
    if (query === undefined) return undefined;
    try {
      return query(effect);
    } catch {
      logWarn(
        "host-dispatch: the platform execution query for effect " +
          JSON.stringify(effect.effectId) +
          " of graph " +
          JSON.stringify(effect.graphId) +
          " threw — reporting the create outcome as UNKNOWN (its message is not quoted: the " +
          "request carries an attempt credential)",
      );
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the platform's execution query threw, so whether an execution exists for this " +
          "effect cannot be established",
      });
    }
  }
}

/**
 * Two answers about one effect, combined so that neither side can invent a
 * create the other one knows about.
 *
 * - `created` from EITHER side is a fact and wins;
 * - `absent` from the PLATFORM wins over a local `unknown`/`absent`: the port's own
 *   contract makes that answer a proof, and it is what lets a stranded
 *   `creating` claim be adopted (or a memory-blind registry be told the truth);
 * - a platform that cannot tell keeps `unknown` — with the LOCAL reason when the
 *   local side is the one that could not tell (`another host process holds the
 *   create right` is more specific than "the port could not answer");
 * - with no port at all the local answer is the answer, exactly as before.
 */
function joinExecutionLookups(
  local: OutcomeExecutionLookup,
  platform: OutcomeExecutionLookup | undefined,
): OutcomeExecutionLookup {
  if (local.kind === "created") return local;
  if (platform === undefined) return local;
  if (platform.kind === "created") return platform;
  if (platform.kind === "absent") return platform;
  return local.kind === "unknown" ? local : platform;
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
      ", claim " +
      String(claim.generation) +
      ")"
    );
  }
  return (
    "another host process holds the create right (owner " +
    JSON.stringify(claim.ownerId) +
    ", claim " +
    String(claim.generation) +
    ")"
  );
}
