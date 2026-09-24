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
 * needs one string uses `dispatchIdempotencyKeyOf`, and BOTH shipped adapters
 * carry exactly that string on the create call (the dsh run's durable label, the
 * Pi task's description). The QUERY PORT is the other half: a host that installs
 * one can have a stranded `creating` effect PROVEN absent and released, or its
 * execution NAMED and adopted, and one that does not answers `unknown` and
 * BLOCKS. Both shipped adapters implement the port and both answer `unknown`
 * rather than `absent` when they cannot prove non-existence.
 *
 * THE PLATFORM'S NAME IS BOUND, NOT JUST REPORTED (F2). A `created` answer that
 * names the execution is recorded on this process's `creating` claim through
 * the SAME conditional write a late confirmation uses (so a foreign claim is
 * never rewritten), and the name stays readable through
 * {@link HostOutcomeDispatch.namedExecutionOf} either way. A process that never
 * saw the create confirmation therefore finds the SAME execution the platform
 * created and never creates a second one — and a platform that cannot prove
 * absence leaves the effect BLOCKED rather than re-created.
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
 *
 * THE INPUT VIEW IS MATERIALIZED HERE, BEFORE ANYTHING IS HANDED OVER (D7). A
 * resolved input names an `artifactId`; a worker with no store cannot turn that
 * into bytes, so this adapter materializes every retained revision into the
 * consumer's own directory — from the content store, digest verified by
 * `input-view.ts`, never from the mutable path the proposal named — and passes
 * the view to the delivery as a fourth argument. Every window that starts an
 * attempt goes through this ONE `create`, so a first dispatch, a successor and a
 * recovery all deliver a real view or none at all.
 *
 * A MATERIALIZATION REFUSAL IS THE SEAM'S OWN THROW. A missing object or a
 * digest that does not verify means the worker would receive a hole where its
 * input should be, so nothing is handed over: the refusal is raised BEFORE
 * `deliver` is called, which releases this claim (the same proof a platform
 * refusal gives) so no execution exists, and leaves the effect row `pending`.
 * Every window reads the same fact: the declaring call receives the refusal
 * itself, and a recovery reports the effect as unsettled work with a
 * `dispatch-failed` refusal — never as a started execution. Materializing again
 * later is safe: the view is content-addressed and published once, so a recovery
 * reuses it instead of duplicating or overwriting it.
 */

import { logWarn } from "../log-warn.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchHost,
  OutcomeDispatchInvocation,
  OutcomeDispatchRequest,
  OutcomeExecutionIdentity,
  OutcomeExecutionLookup,
  OutcomeExecutionProbe,
  OutcomeExecutionQuery,
} from "../outcome/dispatch-effects.ts";
import { dispatchIdempotencyKeyOf } from "../outcome/dispatch-effects.ts";
import type { HostInvocationIdentity } from "../outcome/host-identity.ts";
import {
  HostExecutionIndex,
  hostExecutionNotCreated,
  type HostExecutionClaim,
  type HostExecutionConfirmation,
  type HostExecutionIdentity,
  type HostExecutionNotCreated,
} from "./execution-index.ts";
import {
  InputViewRefusalError,
  materializeInputView,
  type DeliveredInputView,
  type InputDeliveryLocation,
  type InputDeliveryRefusal,
} from "./input-view.ts";

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
  /**
   * THE INPUT VIEW THIS WORKER IS HANDED (D7), materialized by this adapter from
   * the content store. PRESENT exactly when the attempt consumes at least one
   * upstream result — the entries' retained revisions are already real files
   * whose digests were verified, and `undefined` means this node declares no
   * inputs (never "the view could not be made": that dispatch is refused before
   * the delivery is called at all).
   */
  inputView?: DeliveredInputView,
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
export type HostDispatchInvocation = OutcomeDispatchInvocation;

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
   * answers `unknown` for a `creating` effect and blocks.
   *
   * With a port installed, an `absent` answer is a PROOF: it can release a
   * stranded claim so the attempt is created exactly once, and it joins the
   * host's own answer so a lookup never turns "I cannot see" into `absent`. A
   * `created` answer NAMES the execution (F2): the adapter BINDS that name
   * locally when this process still holds the claim, and answers with it either
   * way, so a process that never saw the confirmation finds the SAME execution
   * instead of creating a second one.
   *
   * The port is asked with {@link OutcomeExecutionProbe}: the stable effect key
   * plus the invocation the create carried (read from
   * {@link HostOutcomeDispatchOptions.dispatchInvocation}, the graph's own
   * recorded origin). A platform whose correlation read is asynchronous is
   * primed through {@link HostOutcomeDispatch.primePlatformReadings} before the
   * synchronous run path asks.
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
  /**
   * WHERE A DISPATCH MATERIALIZES ITS INPUTS (D7): the root the retained CONTENT
   * objects live under, and the root per-consumer directories are published in.
   *
   * OMITTED, a dispatch whose node declares inputs is REFUSED
   * (`input-delivery-unavailable`) rather than started with nothing to read: an
   * artifact identity the worker cannot resolve is not delivery, and a silent
   * launch would present the absence as a working input. A node that declares no
   * inputs needs no location and is delivered exactly as before.
   */
  readonly inputDelivery?: InputDeliveryLocation;
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
  /** Where this host's retained objects live and where deliveries are published. */
  private readonly inputDelivery: InputDeliveryLocation | undefined;
  /**
   * THE PLATFORM'S OWN NAMES, as this process has read them (F2).
   *
   * A per-process reading of the platform's answer for effects whose create
   * confirmation this host never recorded — the W4 window. It is NOT a second
   * authority and NOT a durable record: the platform re-answers the same stable
   * question in any process, and the durable execution row (fenced) remains the
   * host's record of what it created. It exists so the boot sweep, the worker
   * binding and the completion authority can name the execution of an attempt
   * whose row is still `creating`.
   */
  private readonly platformExecutions = new Map<string, HostExecutionIdentity>();
  /**
   * Effects whose failed local binding has already been reported, so a lookup
   * repeated by the sweep and by submissions logs the refusal once.
   */
  private readonly unboundReports = new Set<string>();

  constructor(options: HostOutcomeDispatchOptions) {
    this.executions = options.executions;
    this.deliver = options.deliver;
    this.query = options.query;
    this.completions = options.completions;
    this.invocation = options.invocation;
    this.dispatchInvocation = options.dispatchInvocation;
    this.inputDelivery = options.inputDelivery;
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
      // THE VIEW IS MATERIALIZED BEFORE THE PLATFORM SEES ANYTHING (D7), and a
      // refusal is raised from inside this window: it is the same synchronous
      // throw the catch below treats as "nothing was handed over", so the claim
      // is released, the effect row stays pending and no worker is started for
      // an input that could not become a file.
      this.deliver(request, effect, dispatchInvocation, this.inputViewOf(request));
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
   * Materialize one request's bound input view, or raise the structured refusal
   * that stops the dispatch.
   *
   * `undefined` is the honest answer for an attempt that consumes nothing: the
   * node declares no inputs (or declares an empty list), so there is no file to
   * publish and no directory is created. A request that DOES carry inputs and a
   * host with no delivery location is refused by name — the alternative would be
   * starting a worker whose input is an identity it cannot resolve.
   */
  private inputViewOf(request: OutcomeDispatchRequest): DeliveredInputView | undefined {
    const inputs = request.inputs;
    if (inputs === undefined || inputs.length === 0) return undefined;
    const location = this.inputDelivery;
    if (location === undefined) {
      const refusals: InputDeliveryRefusal[] = inputs.map((input) =>
        Object.freeze({
          code: "input-delivery-unavailable" as const,
          from: input.from,
          outcome: input.outcome,
          message:
            "this host was given no input-delivery location, so the retained revisions of " +
            "attempt " +
            JSON.stringify(input.attemptId) +
            " cannot be materialized as files for this node — an artifact identity the worker " +
            "cannot resolve is not delivery, so the attempt is NOT launched",
        }),
      );
      throw new InputViewRefusalError(refusals);
    }
    const materialized = materializeInputView({
      contentStoreRoot: location.contentStoreRoot,
      deliveryRoot: location.deliveryRoot,
      graphId: request.graphId,
      attemptId: request.attemptId,
      inputs,
    });
    if (materialized.kind === "refused") {
      throw new InputViewRefusalError(materialized.refusals);
    }
    return materialized.view;
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
   * Whether an execution for this effect exists, as the host can tell — AND
   * WHICH ONE, when either answerer can name it (F2).
   *
   * THE JOIN OF TWO ANSWERERS, and it is deliberately conservative: the host's
   * own durable registry answers for every create it performed, and the platform
   * query port (when installed) answers for what the platform holds. `created`
   * from either side is a fact; `absent` from EITHER side is a PROOF and wins
   * over the other side's `unknown` (a port that cannot SEE an execution proves
   * nothing, and its `unknown` never overrules a local proof of absence — which
   * is what lets a stranded `creating` claim be released); only when neither side
   * can prove absence is the answer `unknown`. A port that cannot answer
   * therefore never degrades into "absent" — which is what would license a
   * second create.
   *
   * A NAMED `created` IS BOUND LOCALLY WHEN THIS PROCESS STILL OWNS THE CLAIM
   * (F2). The one window where that is possible is the confirmation that never
   * arrived while the claim stayed this process's: the platform's answer is the
   * fact the lost callback would have carried, so recording it is the same write
   * `confirmStarted` performs, and it is the SAME conditional write (the store
   * refuses it for any other claim). A claim this process does NOT hold is never
   * rewritten — the platform's name is cached for the attempt and reported, and
   * the durable row is left exactly as the fence left it. Either way the SAME
   * execution is returned, so the recovery never creates a second one.
   */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    const local = this.namedLocalLookup(effect);
    const platform = this.platformLookup(effect);
    const joined = joinExecutionLookups(local, platform);
    if (joined.kind === "created" && joined.execution !== undefined) {
      this.rememberExecution(effect, joined.execution);
      if (local.kind !== "created") {
        this.bindPlatformExecution(effect, joined.execution);
      }
    }
    return joined;
  }

  /**
   * The execution the platform named for this effect, as this process last read
   * it — or `undefined` when no answer has named one.
   *
   * A READING, NOT A SECOND AUTHORITY: it is the platform's own answer to the
   * stable question, re-derivable by asking again in any process, and it exists
   * so the host's completion path and boot sweep can name the execution of an
   * attempt whose durable row never got the confirmation (the W4 window). The
   * durable row stays the authority for what this host created; this is what the
   * PLATFORM says it created.
   */
  namedExecutionOf(effect: OutcomeDispatchEffectKey): HostExecutionIdentity | undefined {
    return this.platformExecutions.get(effectKeyOf(effect));
  }

  /**
   * Refresh the platform's readings for these probes (the port's `prime`).
   *
   * The host awaits this from its own ASYNCHRONOUS entry points — the
   * declaration seam and the boot sweep — so a platform whose correlation read
   * is asynchronous (dsh lists a parent's children) has its answers ready before
   * the run path's synchronous window opens. A port without `prime`, and a
   * `prime` that fails, both leave every reading unset: the synchronous lookup
   * then answers `unknown` and the effect stays blocked, never guessed. A
   * failure is reported, never propagated into the caller's own result.
   */
  async primePlatformReadings(probes: readonly OutcomeExecutionProbe[]): Promise<void> {
    const prime = this.query?.prime;
    if (prime === undefined || probes.length === 0) return;
    try {
      await prime.call(this.query, probes);
    } catch (error) {
      logWarn(
        "host-dispatch: priming the platform execution readings for " +
          String(probes.length) +
          " effect(s) failed — every reading stays unset, so the next lookup answers " +
          "'unknown' and the affected effects stay blocked rather than being guessed at (" +
          describeError(error) +
          ")",
      );
    }
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
   * THE PROBE CARRIES THE INVOCATION THE CREATE WAS HANDED. A platform that
   * correlates a child with its effect needs the parent (dsh lists a parent's
   * children), and the host already holds that fact per graph — the same
   * recorded origin every dispatch window uses — so the question is asked in the
   * scope the create was made in, never against a control plane at large.
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
    const invocation = this.dispatchInvocation?.(effect.graphId);
    const probe: OutcomeExecutionProbe = Object.freeze({
      effect,
      ...(invocation === undefined ? {} : { invocation }),
    });
    try {
      return query.lookup(probe);
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

  /**
   * The host's OWN answer, with the execution the row records named on it (F2).
   *
   * {@link HostExecutionIndex.lookup} answers the three facts but not the name,
   * and the name is exactly what a recovery needs to find the SAME execution.
   * The row is read here — a read of the host's own durable fact, not a second
   * write — and only a `created` row may name one: the store's own CHECK makes
   * "created without an execution id" unrepresentable, and a row that somehow
   * contradicted that is reported `unknown` rather than named.
   */
  private namedLocalLookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    const answer = this.executions.lookup(effect);
    if (answer.kind !== "created") return answer;
    const row = this.executions.read(effect);
    if (row === undefined || row.state !== "created" || row.execution === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the host registry records effect " +
          JSON.stringify(effect.effectId) +
          " as created but cannot name the execution it records, so the fact cannot be " +
          "reconciled against the platform",
      });
    }
    return Object.freeze({ kind: "created" as const, execution: row.execution });
  }

  /** Remember the platform's own name for one effect's execution. */
  private rememberExecution(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): void {
    this.platformExecutions.set(effectKeyOf(effect), execution);
  }

  /**
   * Try to record the platform's named execution on the LOCAL row.
   *
   * This is a WRITE, so it is the same conditional write `confirmStarted`
   * performs: the row must be THIS process's `creating` claim. An attempt whose
   * confirmation never arrived while the claim stayed ours is therefore bound
   * exactly as a late callback would have bound it; a foreign or superseded
   * claim is refused by the store and NOT rewritten, and the refusal is reported
   * once per effect. Either way the platform's name stays readable through
   * {@link namedExecutionOf}, so the attempt is never re-created.
   */
  private bindPlatformExecution(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): void {
    const key = effectKeyOf(effect);
    // AT MOST ONE ATTEMPT PER EFFECT PER PROCESS. A refused conditional write
    // records a durable refusal on the row, and that record exists to diagnose a
    // STALE CONFIRMATION — not to be raised again by every lookup the sweep and
    // the completion path perform for an effect this process does not own.
    if (this.unboundReports.has(key)) return;
    let verdict: HostExecutionConfirmation;
    try {
      verdict = this.executions.confirmExecution(effect, execution);
    } catch (error) {
      logWarn(
        "host-dispatch: the platform names execution " +
          JSON.stringify(execution.executionId) +
          " for effect " +
          JSON.stringify(effect.effectId) +
          " of graph " +
          JSON.stringify(effect.graphId) +
          ", but binding it locally failed (" +
          describeError(error) +
          ") — the platform's name is kept for the recovery and no second execution is created",
      );
      return;
    }
    if (verdict.kind === "confirmed" || verdict.kind === "replayed") return;
    this.unboundReports.add(key);
    logWarn(
      "host-dispatch: the platform names execution " +
        JSON.stringify(execution.executionId) +
        " for effect " +
        JSON.stringify(effect.effectId) +
        " of graph " +
        JSON.stringify(effect.graphId) +
        ", but this process does not hold the claim that recorded the create (" +
        verdict.kind +
        ") — the durable row is NOT rewritten, the platform's name is kept for the " +
        "recovery, and no second execution is created",
    );
  }
}

/** One effect's map key, spelled the same way the registry spells it. */
function effectKeyOf(effect: OutcomeDispatchEffectKey): string {
  return effect.graphId + "\u0000" + effect.effectId;
}

/** One caught value, described without quoting host text wholesale. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.name + ": " + error.message : typeof error;
}

/**
 * Two answers about one effect, combined so that neither side can invent a
 * create the other one knows about.
 *
 * - `created` from EITHER side is a fact and wins;
 * - when BOTH say `created`, the answer that NAMES the execution wins (F2): the
 *   caller needs the platform's own id to find the SAME execution, and a local
 *   answer that names it is preferred because it is this host's own durable row;
 * - `absent` from EITHER side is a PROOF and wins over the other side's
 *   `unknown`. The host's durable registry proves it by construction — every
 *   handover first writes the create-right row, so "no row" (or a released,
 *   expired or own pending claim) means nothing was ever handed to the platform.
 *   The platform proves it by its own contract (see `dispatch-effects.ts`), and
 *   a local `unknown` is overruled by it — which is what lets a stranded
 *   `creating` claim be released. A platform that merely cannot SEE an
 *   execution proves nothing: its `unknown` never overrules a local `absent`,
 *   because that would block a create the host has already proven safe;
 * - with both sides unable to tell, the `unknown` is kept — with the LOCAL
 *   reason when the local side could not tell (`another host process holds the
 *   create right` is more specific than "the port could not answer");
 * - with no port at all the local answer is the answer, exactly as before.
 */
function joinExecutionLookups(
  local: OutcomeExecutionLookup,
  platform: OutcomeExecutionLookup | undefined,
): OutcomeExecutionLookup {
  if (platform === undefined) return local;
  if (local.kind === "created" && platform.kind === "created") {
    return local.execution !== undefined ? local : platform;
  }
  if (local.kind === "created") return local;
  if (platform.kind === "created") return platform;
  if (local.kind === "absent") return local;
  if (platform.kind === "absent") return platform;
  return local;
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
