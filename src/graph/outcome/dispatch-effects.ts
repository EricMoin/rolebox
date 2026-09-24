import type { PendingEffectRecord } from "../ledger/types.ts";
import type { ResolvedInput } from "./inputs.ts";

// ── The dispatch request ────────────────────────────────────────────────────

/**
 * The provenance of one dispatch, WITHOUT the attempt credential.
 *
 * Every field is runtime provenance: the graph and plan revision the node
 * belongs to, the attempt id the STATE minted, and the plan's own agent/prompt.
 * Nothing here comes from a worker. This is also the shape the ledger persists
 * as a dispatch effect's payload — deliberately credential-free: the durable
 * state records the credential's DIGEST, the host's store holds the value, and
 * every launch is delivered with the credential the store resolves.
 */
export interface OutcomeDispatchTarget {
  readonly graphId: string;
  readonly planRevision: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly prompt: string;
  /**
   * The accepted upstream revisions this attempt was ARMED with, resolved from
   * what the acceptances RECORDED (§3.5, P4 item 5 / A17; D6).
   *
   * PRESENT on every dispatch this build creates, INCLUDING the empty list that
   * says "this node declares no inputs". The binding is therefore DELIVERED from
   * the record written when it was decided, never re-derived from whatever the
   * producing nodes hold at delivery time: a consumer that is re-armed (a loop
   * round, a retry, a re-execution) gets a new binding, bound to the attempt each
   * producer settled, and an already-armed consumer never gets one.
   *
   * ABSENT means the row was written before this build bound inputs to an
   * attempt. It NEVER means "resolve the path later": the runtime refuses to
   * launch that dispatch for a node which DECLARES inputs, rather than starting
   * a node with a hole where its input should be.
   */
  readonly inputs?: readonly ResolvedInput[];
}

/**
 * One node the runtime asks a dispatcher to run: the target plus the attempt
 * credential this worker must present when it submits.
 *
 * THE CREDENTIAL TRAVELS ONLY OVER THIS CHANNEL. It is handed to the dispatch
 * seam (and to nobody else): it is not in `graph_status`, not in the shared
 * `<graph_state>` block, not in the startup sweep's report, not in a receipt,
 * an accepted event or a dispatch-effect payload, and not in any log line the
 * runtime writes. The worker receives it here and passes it back through the
 * submission ingress; the store it is checked against is the runtime's own.
 */
export interface OutcomeDispatchRequest extends OutcomeDispatchTarget {
  /**
   * The bearer credential issued for this attempt. A capability, not an
   * identity: possession proves the holder was handed this attempt's
   * credential (or copied it); it does not prove the original worker is asking.
   */
  readonly credential: string;
}

/**
 * The dispatch seam: how a node is actually started.
 *
 * Deliberately a plain synchronous function rather than the legacy dispatch
 * bridge. Selecting a protocol-aware completion bridge — one that would make an
 * accepted outcome the bridge's single authoritative completion source — is
 * DEFERRED; this slice proves the run path against a scripted seam, and the
 * seam performs no completion interpretation at all.
 *
 * A seam is a host adapter WITHOUT the query half: see
 * {@link OutcomeDispatchAdapter}.
 */
export type OutcomeDispatchSeam = (request: OutcomeDispatchRequest) => void;

// ── The stable effect identity ──────────────────────────────────────────────

/**
 * The stable identity of one dispatch effect, as the host sees it.
 *
 * `effectId` is `"dispatch:" + attemptId` and is written into the ledger in the
 * same transaction as the graph state, so it is the SAME string before and
 * after a crash and in every process that reads the row. The host keys its own
 * dedupe and its lookup on this identity — never on the node id, which a loop
 * round reuses.
 */
export interface OutcomeDispatchEffectKey {
  readonly graphId: string;
  readonly effectId: string;
  readonly attemptId: string;
}

/**
 * The PLATFORM'S OWN NAME for one started execution.
 *
 * A dsh subagent run's id (which the dsh type contract makes equal to the
 * published child session id), a Pi dispatch task's id — the token a recovery
 * can ask the platform about, re-subscribe to, or observe. Declared here
 * STRUCTURALLY rather than imported from the host registry: this module is the
 * outcome-side contract and stays a dependency leaf, and the host's own
 * `HostExecutionIdentity` has exactly this shape, so either value satisfies
 * the other without a conversion.
 */
export interface OutcomeExecutionIdentity {
  /** The platform's own id for the started execution. */
  readonly executionId: string;
  /** The platform's task id, when it names the execution and the task apart. */
  readonly taskId?: string;
}

/**
 * What asking the host whether an execution exists answered.
 *
 * `created` and `absent` are FACTS the host stands behind; `unknown` is the
 * honest answer when it cannot tell (an unreachable control plane, a store it
 * does not own, a lookup that is not implemented). The three answers are what
 * lets a recovery say "already started", "definitely not started" or
 * "unresolved" instead of guessing between the last two.
 *
 * A `created` ANSWER NAMES THE EXECUTION WHENEVER THE ANSWERER CAN (F2). The
 * name is what lets a process that never saw the create confirmation find the
 * SAME execution the platform created instead of creating a second one; every
 * producer in this build that can name it does (the host adapter enriches its
 * own registry's answer, and both shipped platform ports answer with the
 * platform's id). The field is optional only because the host registry's own
 * inner answer is older than the named one; a caller that NEEDS the identity
 * treats its absence as "not named" and blocks rather than guessing.
 */
export type OutcomeExecutionLookup =
  | {
    readonly kind: "created";
    /** The platform's own name for the execution, when the answerer has it. */
    readonly execution?: OutcomeExecutionIdentity;
  }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The platform invocation a create was handed, as the host attributes it.
 *
 * A SESSION, and optionally the agent acting in it. The outcome adapters hand
 * the same value to the delivery seam, so the invocation a platform stored with
 * the create is the one the probe carries back to it. Structural twin of the
 * host's `HostDispatchInvocation` (see the module header on the dependency
 * direction).
 */
export interface OutcomeDispatchInvocation {
  readonly sessionId?: string;
  readonly agent?: string;
}

/**
 * What a platform is asked about, and everything it needs to correlate the
 * question with the create call it is being asked about.
 *
 * `effect` is the stable key the create carried (see
 * {@link dispatchIdempotencyKeyOf} for its one-string spelling); `invocation`
 * is the parent invocation the create was handed, present only when the host
 * has one recorded — a platform that needs the parent to find the child (dsh
 * lists a parent's children) answers `unknown` for a question that names none,
 * rather than searching a control plane it cannot scope.
 */
export interface OutcomeExecutionProbe {
  readonly effect: OutcomeDispatchEffectKey;
  readonly invocation?: OutcomeDispatchInvocation;
}

/**
 * The PLATFORM'S own answer about one dispatch effect (P2 item 5).
 *
 * TWO PHASES, because the run path is synchronous and a platform's correlation
 * call may not be (see the module header):
 *
 * - {@link OutcomeExecutionQuery.prime} refreshes the readings for the probes
 *   the next synchronous window will ask about. The host awaits it from its own
 *   asynchronous entry points — the declaration seam and the boot sweep — so a
 *   platform that lists, scans or reads asynchronously has its answer ready
 *   before the run path asks. Optional: a platform whose reads are synchronous
 *   does not need it.
 * - {@link OutcomeExecutionQuery.lookup} answers for one probe from the
 *   readings this process holds. It is the run path's only question, so it must
 *   be synchronous and total: a probe with no primed reading, an unreadable
 *   control plane and an ambiguous correlation all answer `unknown`.
 *
 * `absent` is a PROOF and only a proof releases the create right: a platform
 * that cannot establish that an execution it cannot find never existed answers
 * `unknown`, and the effect stays blocked.
 */
export interface OutcomeExecutionQuery {
  /** The synchronous answer the run path reads. */
  lookup(probe: OutcomeExecutionProbe): OutcomeExecutionLookup;
  /** Refresh the readings for these probes; awaited before the sync window. */
  prime?(probes: readonly OutcomeExecutionProbe[]): Promise<void>;
}

/**
 * The host adapter that executes dispatch effects.
 *
 * `create` is idempotent per `(graphId, effectId)` (at most one execution);
 * `lookup` answers whether an execution for that id exists, and says
 * `unknown` rather than guessing.
 */
export interface OutcomeDispatchHost {
  /** Start this effect's execution. Idempotent per `(graphId, effectId)`. */
  create(request: OutcomeDispatchRequest, effect: OutcomeDispatchEffectKey): void;
  /** Whether an execution for this effect already exists. */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup;
}

/** Every shape the runtime accepts as a dispatcher: a seam or a host. */
export type OutcomeDispatchAdapter = OutcomeDispatchSeam | OutcomeDispatchHost;

/**
 * One adapter, seen through one interface: a create call that always receives
 * the stable effect identity, and a lookup that always answers.
 *
 * A bare seam is the degenerate host: its `lookup` is `unknown` with a fixed
 * reason, which is what makes the "the host cannot be queried" case a REPORT
 * rather than an exception or a silent launch.
 */
export interface NormalizedOutcomeDispatch {
  create(request: OutcomeDispatchRequest, effect: OutcomeDispatchEffectKey): void;
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup;
}

/**
 * The one adapter a runtime holds, or `undefined` when none was injected.
 *
 * `undefined` is NOT a no-op dispatcher: the run path refuses with
 * `dispatch-unavailable` before it writes anything, because a no-op would let
 * the runtime record an execution it never started.
 */
export function normalizeOutcomeDispatch(
  adapter: OutcomeDispatchAdapter | undefined,
): NormalizedOutcomeDispatch | undefined {
  if (adapter === undefined) return undefined;
  if (typeof adapter === "function") {
    return Object.freeze({
      create: (request: OutcomeDispatchRequest) => adapter(request),
      lookup: (): OutcomeExecutionLookup =>
        Object.freeze({
          kind: "unknown" as const,
          reason:
            "the injected dispatcher is a bare seam: it can create an execution but cannot " +
            "answer whether one already exists",
        }),
    });
  }
  return Object.freeze({
    create: (request: OutcomeDispatchRequest, effect: OutcomeDispatchEffectKey) =>
      adapter.create(request, effect),
    lookup: (effect: OutcomeDispatchEffectKey) => adapter.lookup(effect),
  });
}

// ── Stable identities ───────────────────────────────────────────────────────

/**
 * The effect id one attempt's dispatch is recorded under.
 *
 * THE ONE SPELLING. The first dispatch, a successor dispatch and a recovery all
 * name the same row with this function, so an effect written by one path is the
 * effect another path reconciles — never a second row for the same attempt.
 */
export function dispatchEffectIdOf(attemptId: string): string {
  return "dispatch:" + attemptId;
}

/** The stable identity a host dedupes and looks up by. */
export function dispatchEffectKeyOf(
  graphId: string,
  attemptId: string,
): OutcomeDispatchEffectKey {
  return Object.freeze({
    graphId,
    effectId: dispatchEffectIdOf(attemptId),
    attemptId,
  });
}

/**
 * The stable idempotency key of one dispatch, as ONE string.
 *
 * For a platform whose create call and whose execution query take a single
 * token (a task label, a lookup argument) rather than the key's parts. It is
 * derived from the SAME two fields the key is, so a platform that stores this
 * string can correlate the create with the query, and it names an EFFECT rather
 * than a worker: it carries no credential and no caller identity.
 *
 * Deterministic: the same effect always spells this the same way, in every
 * process, before and after a crash.
 */
export function dispatchIdempotencyKeyOf(effect: OutcomeDispatchEffectKey): string {
  return effect.graphId + "/" + effect.effectId;
}

/**
 * The unsettled effects that make RE-EXECUTING a run unsafe (P3 item 2).
 */
export function blockingReexecutionEffectsOf(
  effects: readonly PendingEffectRecord[],
  facts: {
    /**
     * The attempts whose cancellation the PLATFORM CONFIRMED. This is the one fact
     * that clears an unsettled dispatch whose execution the run decided to abandon:
     * the platform's own confirmation is what says the external task is over. It is
     * passed in rather than derived from \`effects\`, because a confirmed cancellation
     * is a TERMINAL cancel effect and therefore not in the unsettled set at all.
     */
    readonly cancelled: ReadonlySet<string>;
    /**
     * The attempts the run records as in flight. OMITTED means the run's state could
     * not be verified against the executing plan, which makes the rule CONSERVATIVE:
     * an unsettled dispatch then blocks unless its cancellation was confirmed.
     */
    readonly inFlight?: ReadonlySet<string>;
    /** The attempts the run records as settled, when the state could be verified. */
    readonly settled?: ReadonlySet<string>;
  },
): readonly PendingEffectRecord[] {
  const blocking: PendingEffectRecord[] = [];
  for (const effect of effects) {
    if (effect.kind !== "dispatch") continue;
    if (facts.cancelled.has(effect.attemptId)) continue;
    if (facts.inFlight === undefined || facts.settled === undefined) {
      blocking.push(effect);
      continue;
    }
    if (facts.settled.has(effect.attemptId)) continue;
    if (!facts.inFlight.has(effect.attemptId)) continue;
    blocking.push(effect);
  }
  return Object.freeze(blocking);
}
