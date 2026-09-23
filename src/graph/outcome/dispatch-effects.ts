/**
 * Graph Execution Engine v2 — Dispatch-effect execution contract (D8)
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE HOST ADAPTER FOR DISPATCH EFFECTS (docs/graph-outcome-protocol.md
 * § "State, storage, and effects" and the D8 section): the create channel the
 * outcome runtime already had, plus the one fact only the host can supply —
 * whether an execution for a stable effect id HAS ALREADY BEEN CREATED.
 *
 * WHY A QUERY IS PART OF THE CONTRACT. A dispatch effect is committed
 * atomically with the state it belongs to, and the create call happens after
 * that commit. A process that dies inside that window leaves an effect the
 * ledger records and the runtime cannot resolve on its own: the execution may
 * or may not exist. Neither pre-marking the effect "started" before the create
 * (the previous design) nor re-issuing the create blindly answers that
 * question — one hides a never-created execution, the other can duplicate a
 * created one. The host is the only party that knows, so the runtime asks it.
 *
 * THE CONTRACT, IN FULL:
 *
 * - `create(request, effect)` starts the node's execution. It MUST be
 *   IDEMPOTENT per `(effect.graphId, effect.effectId)`: calling it twice for
 *   one effect must yield AT MOST ONE execution. The effect id is stable
 *   across processes and is derived from the attempt id, so a host that keys
 *   its own records on it satisfies this by construction.
 * - `lookup(effect)` answers whether an execution for that stable id exists:
 *   `created` (it does), `absent` (it does not, and the host can tell),
 *   or `unknown` (the host cannot answer, with a `reason`). A host that
 *   cannot guarantee an answer MUST say `unknown` rather than guess: the
 *   runtime treats `unknown` as "needs reconciliation" and never converts it
 *   into a launch or into a silent success.
 *
 * A PLAIN SEAM IS STILL ACCEPTED, AND IT ANSWERS `unknown`. Passing a bare
 * `(request) => void` keeps every existing wiring and test working, and it is
 * exactly the degenerate host that can create but cannot be queried: a
 * recovery that would need to know whether the create already happened reports
 * the effect instead of re-issuing it. The restriction is honest and is
 * documented at every entry (`dispatch-unreconciled`).
 *
 * THE PLATFORM QUERY PORT (P2 item 5). `lookup` above is the runtime's
 * question; {@link OutcomeExecutionQuery} is the PLATFORM'S OWN answer, and it
 * is a separate seam because a host can hold durable records of what it created
 * and still be unable to ask the platform about an execution whose create
 * outcome it never saw. Only the platform can prove that a stranded `creating`
 * effect has no execution — and only a PROOF of that may release the create
 * right and license one more create (P2 item 4). A host that has no such port
 * omits it, and every effect whose create outcome is unknown stays `unknown`
 * and is BLOCKED: never blind-retried.
 *
 * WHAT A PORT MUST ANSWER FOR. The SAME stable correlation key the create
 * carried: {@link OutcomeDispatchEffectKey.graphId} plus
 * {@link OutcomeDispatchEffectKey.effectId} (`"dispatch:" + attemptId`), or the
 * one-string spelling {@link dispatchIdempotencyKeyOf} when the platform needs
 * a single token (a task label, a query argument). A platform that cannot
 * correlate that key with certainty — no listing, no per-task lookup, a control
 * plane it does not own — MUST answer `unknown`, and the effect stays blocked.
 * `absent` is a proof, not a guess.
 *
 * THIS BUILD IMPLEMENTS THE LOCAL HALF. `HostOutcomeDispatch` accepts a port
 * and joins its answer with the host's own registry, and it uses an `absent`
 * answer to release a stranded claim. Neither shipped platform adapter supplies
 * one yet: dsh has `ctx.subagents.listChildren` and Pi has
 * `dispatchManager.getTask`, but nothing maps a stable effect id onto them, so
 * the shipped hosts answer `unknown` for a `creating` row and block. That
 * platform half is an open P2 gap named in
 * `docs/graph-v3-execution-plan.md` §8.1.
 *
 * Dependency leaf except for the request type: this module imports nothing at
 * runtime, so the runtime, the recovery seam and any adapter may depend on it
 * without a cycle.
 */

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
 * What asking the host whether an execution exists answered.
 *
 * `created` and `absent` are FACTS the host stands behind; `unknown` is the
 * honest answer when it cannot tell (an unreachable control plane, a store it
 * does not own, a lookup that is not implemented). The three answers are what
 * lets a recovery say "already started", "definitely not started" or
 * "unresolved" instead of guessing between the last two.
 */
export type OutcomeExecutionLookup =
  | { readonly kind: "created" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

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
 * The PLATFORM'S answer about the execution of one stable effect identity
 * (P2 item 5): the port a host needs to turn "the create outcome is unknown"
 * into a FACT it can act on.
 *
 * It answers for the same stable key the create call carried — see the module
 * header for the full contract. `absent` is a proof; a platform that cannot
 * correlate the key answers `unknown` and the effect stays blocked.
 */
export type OutcomeExecutionQuery = (
  effect: OutcomeDispatchEffectKey,
) => OutcomeExecutionLookup;

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
