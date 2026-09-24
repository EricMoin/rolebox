import { randomUUID } from "node:crypto";

import { logWarn } from "../log-warn.ts";
import type {
  OutcomeDispatchEffectKey,
  OutcomeExecutionLookup,
} from "../outcome/dispatch-effects.ts";
import { GraphStore } from "../store/graph-store.ts";
import { GRAPH_STORE_TABLES } from "../store/schema.ts";

// ── Options and record shapes ───────────────────────────────────────────────

/** How long the registry outlives the process that wrote it. */
export type HostExecutionIndexDurability =
  /**
   * The durable host store under `root` (the default): the host can answer for
   * an earlier process's creations, so an unrecorded effect is a real
   * `absent`.
   */
  | "file"
  /**
   * This process only: `created` for what it created, `unknown` for the rest.
   */
  | "memory";

/** The three states one dispatch effect can be in. */
export type HostExecutionState = "pending" | "creating" | "created";

/**
 * What the HOST's platform named the execution it started.
 *
 * A dsh subagent run id, a Pi dispatch task id — the token a recovery can ask
 * the platform about. It is required for `created`: a state that says "the
 * execution exists" without naming it would be a claim the host could not
 * substantiate.
 */
export interface HostExecutionIdentity {
  /** The platform's own id for the started execution. */
  readonly executionId: string;
  /** The platform's task id, when it names the execution and the task apart. */
  readonly taskId?: string;
}

/** What one registry row refused to do, and who asked. */
export type HostExecutionRefusalKind =
  /** A confirmation that did not come from the row's current claim. */
  | "stale-confirmation"
  /** A confirmation naming a DIFFERENT execution than the one recorded. */
  | "conflicting-execution"
  /** A delivery failure that proved nothing about whether an execution exists. */
  | "unproven-failure";

/**
 * The last write one row refused, as the row keeps it.
 *
 * Durable and bounded: the kind, the `(ownerId, generation)` that asked, the
 * execution the write named (when it named one), when it was refused and how
 * many times this row has refused a write. Deliberately no free-form text: the
 * refusal must be diagnosable without becoming a channel for host error strings
 * (which may echo the request they were given).
 */
export interface HostExecutionRefusal {
  readonly kind: HostExecutionRefusalKind;
  /** The owner whose write was refused. */
  readonly ownerId: string;
  /** The generation it presented; 0 when it held no claim at all. */
  readonly generation: number;
  /** The execution id the refused write tried to bind, when it named one. */
  readonly executionId?: string;
  /** Epoch milliseconds of the refusal. */
  readonly at: number;
  /** How many writes this row has refused, including this one. */
  readonly count: number;
}

/** One effect's registry row, as read back. */
export interface HostDispatchExecution {
  readonly graphId: string;
  readonly effectId: string;
  readonly attemptId: string;
  readonly state: HostExecutionState;
  /** The host instance that held (or holds) the create right. */
  readonly ownerId: string;
  /**
   * WHICH CLAIM of that owner this row belongs to (see the module header). Every
   * conditional write names it; a write that names anything else is refused and
   * recorded rather than applied.
   */
  readonly generation: number;
  /** The confirmed host execution, present exactly when `state` is `created`. */
  readonly execution?: HostExecutionIdentity;
  /**
   * When this row's claim was released after a PROVEN not-created, if it was.
   * A released row is `pending` and answers `absent` to every reader — nothing
   * was created and no live claim stands — while keeping its generation, which
   * is what fences a late confirmation from the claim that was released.
   */
  readonly releasedAt?: number;
  /** The last write this row refused, or `undefined` when it refused none. */
  readonly refused?: HostExecutionRefusal;
  readonly claimedAt: number;
  readonly updatedAt: number;
}

/**
 * A delivery's PROOF that no execution was created for one effect.
 *
 * The one value that may release the create right (P2 item 4). It has exactly
 * two producers: the synchronous delivery refusal (the seam's contract is that
 * a delivery throws only BEFORE handing the request to the platform) and the
 * platform's own execution query answering `absent`. An asynchronous rejection
 * or a timeout produces none — the failure is reported and the claim is kept.
 */
export interface HostExecutionNotCreated {
  readonly kind: "not-created";
  /** Why the caller can prove it; host-authored text, never a credential. */
  readonly reason: string;
}

/** Mint one not-created proof. */
export function hostExecutionNotCreated(reason: string): HostExecutionNotCreated {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error(
      "host-execution-index: a not-created proof needs a non-empty reason — refusing to " +
      "release a create right for an unexplained claim",
    );
  }
  return Object.freeze({ kind: "not-created" as const, reason });
}

/**
 * What recording one confirmation did.
 *
 * - `confirmed` — the row was `creating`, the presented claim is the row's
 *   current one, and it is now `created` with the platform's execution id;
 * - `replayed` — the row was already `created` with the SAME execution id and
 *   the presented claim is current: an idempotent re-report, nothing written;
 * - `conflict` — the row is `created` with a DIFFERENT execution id. Two
 *   executions for one stable effect id is exactly what the registry exists to
 *   prevent, so it is REPORTED (and recorded) rather than overwritten;
 * - `fenced` — the presented claim is not the row's current claim, or the row
 *   was not `creating`. Nothing was written; the refusal is recorded on the row;
 * - `absent` — this host holds no row for the effect. Nothing was written and
 *   nothing recorded: there is no row to record it on.
 */
export type HostExecutionConfirmation =
  | { readonly kind: "confirmed"; readonly execution: HostExecutionIdentity }
  | { readonly kind: "replayed"; readonly execution: HostExecutionIdentity }
  | {
    readonly kind: "conflict";
    readonly recorded: HostExecutionIdentity;
    readonly reported: HostExecutionIdentity;
  }
  | {
    readonly kind: "fenced";
    /** Host-authored: which claim the row carries versus which one asked. */
    readonly reason: string;
    readonly state: HostExecutionState;
    readonly ownerId: string;
    readonly generation: number;
    readonly attemptedOwnerId: string;
    readonly attemptedGeneration: number;
  }
  | { readonly kind: "absent" };

/**
 * The claim one caller OBSERVED, as a release or a report names it.
 *
 * Both the held answer of {@link HostExecutionIndex.claim} and a row read back
 * satisfy it structurally; it exists so a caller can only ever name a claim it
 * actually saw (the store's conditional update then decides whether that claim
 * is still current).
 */
export interface HostExecutionClaimRef {
  readonly ownerId: string;
  readonly generation: number;
}

/**
 * The answer to "may THIS instance create the execution?".
 *
 * `held` is the explicit refusal the create-once rule needs: the effect is
 * owned by another claim or already exists, and this instance must not hand it
 * to the platform again. The `generation` of the CURRENT claim is reported with
 * either answer, so a caller can name the claim it observed (a proven-absent
 * stale claim is released by exactly that `(ownerId, generation)`).
 */
export type HostExecutionClaim =
  | {
    readonly kind: "claimed";
    readonly ownerId: string;
    /** The generation this store minted for the claim. */
    readonly generation: number;
  }
  | {
    readonly kind: "held";
    readonly state: HostExecutionState;
    readonly ownerId: string;
    readonly generation: number;
    readonly execution?: HostExecutionIdentity;
  };

/** Inputs to {@link HostExecutionIndex.open}. */
export interface HostExecutionIndexOptions {
  /** The host-owned directory the store file lives in (created 0700 when absent). */
  readonly root: string;
  /** Defaults to `"file"` (see {@link HostExecutionIndexDurability}). */
  readonly durability?: HostExecutionIndexDurability;
  /**
   * This instance's identity inside the store. Defaults to a fresh random id,
   * so two instances in one process are two owners. The owner id alone is NOT
   * the fence — the store's `owner_generation` is — so two processes configured
   * with the same id still cannot apply each other's writes.
   */
  readonly ownerId?: string;
  /**
   * An ALREADY OPEN workspace store to share.
   *
   * Omitted (the default), this registry opens its own connection to
   * `root` — or a private in-memory store for `durability: "memory"`. A host
   * that assembles several capabilities passes ONE store so all of them address
   * one database and one transaction boundary even in memory mode.
   */
  readonly store?: GraphStore;
  /**
   * How long a `pending` claim stays its owner's before another instance may
   * take it over. A claim that never handed anything to the platform can be
   * abandoned safely, so the lease is what keeps a dead process from blocking a
   * recovery forever. Defaults to one minute.
   */
  readonly leaseMs?: number;
  /** The clock; defaults to `Date.now`. Injected so a lease is testable. */
  readonly now?: () => number;
}

/** The default claim lease. */
export const HOST_EXECUTION_CLAIM_LEASE_MS = 60_000;

/**
 * The generation a caller presents when it holds no claim at all.
 *
 * Zero is unreachable for a real row (`CHECK (owner_generation >= 1)`), so a
 * confirmation or release from a process that never claimed the effect is
 * refused by the store's own predicate instead of becoming an application-level
 * special case.
 */
const NO_CLAIM_GENERATION = 0;

// ── The registry ────────────────────────────────────────────────────────────

/**
 * The host's record of the dispatch executions it has created, addressed by the
 * stable effect identity the runtime derives from the attempt
 * (`dispatch:<attemptId>`, scoped by graph).
 */
export class HostExecutionIndex {
  private readonly store: GraphStore;
  private readonly durability: HostExecutionIndexDurability;
  private readonly leaseMs: number;
  private readonly now: () => number;
  /**
   * The claims THIS process took, by effect key — the generation each write
   * must present. It is a token, never authority: the store's row decides
   * whether the token is still the current claim, and this map is empty after a
   * restart (a fresh process's confirmation is fenced, not applied).
   */
  private readonly claims = new Map<string, number>();
  /** This instance's owner id inside the store. */
  readonly ownerId: string;

  private constructor(
    store: GraphStore,
    durability: HostExecutionIndexDurability,
    options: HostExecutionIndexOptions,
  ) {
    this.store = store;
    this.durability = durability;
    this.leaseMs = options.leaseMs ?? HOST_EXECUTION_CLAIM_LEASE_MS;
    this.now = options.now ?? (() => Date.now());
    this.ownerId = options.ownerId ?? randomUUID();
  }

  /** Open one registry over `root`, reading the durable store when present. */
  static open(options: HostExecutionIndexOptions): HostExecutionIndex {
    const durability = options.durability ?? "file";
    const store =
      options.store ??
      (durability === "memory" ? GraphStore.openMemory() : GraphStore.openFile(options.root));
    return new HostExecutionIndex(store, durability, options);
  }

  /**
   * Take the right to create this effect's execution, or be told it is held.
   *
   * ONE transaction, THREE outcomes: the effect is new (`claimed`), this
   * instance already holds it (`claimed`, idempotent, same generation), or
   * another claim/execution owns it (`held`). The insert, the read and the
   * conditional takeover all run inside the STORE's transaction — which is the
   * caller's when one is open, so a service can claim in the same boundary that
   * commits the effect. A claim released after a PROVEN not-created is taken
   * over immediately, without waiting for its lease.
   */
  claim(effect: OutcomeDispatchEffectKey): HostExecutionClaim {
    const outcome = this.store.claimExecution(
      effect,
      this.ownerId,
      this.now(),
      this.leaseMs,
    );
    if (outcome.kind === "held") return heldClaim(outcome.row);
    this.claims.set(claimKeyOf(effect), outcome.generation);
    return Object.freeze({
      kind: "claimed" as const,
      ownerId: outcome.ownerId,
      generation: outcome.generation,
    });
  }

  /**
   * Record that the create request is ABOUT TO BE handed to the platform.
   *
   * Called BEFORE the delivery, never after: the row must say `creating` for
   * the whole window in which the platform may have received the request, so a
   * crash inside that window leaves `unknown` rather than a claim that looks
   * safely retryable.
   *
   * FENCED BY THIS PROCESS'S OWN CLAIM. The generation is the one the store
   * minted for the claim THIS index took; a process that holds no claim (a
   * fresh instance, or one whose claim was taken over) cannot mark anything
   * creating, and neither can a caller naming another owner — the store's
   * conditional update is the decider. Returns `false` when the row did not
   * become this claim's `creating` row.
   */
  markCreating(effect: OutcomeDispatchEffectKey, ownerId: string): boolean {
    const key = claimKeyOf(effect);
    const generation = this.claims.get(key);
    if (generation === undefined || ownerId !== this.ownerId) return false;
    const marked = this.store.markExecutionCreating(
      effect,
      ownerId,
      generation,
      this.now(),
    );
    // The claim this process held is not the row's current one any more
    // (another process took it over): the token is dropped so every later write
    // from here is refused rather than applied to somebody else's row.
    if (!marked) this.claims.delete(key);
    return marked;
  }

  /**
   * Record the host execution the platform CONFIRMED.
   *
   * The boolean view of {@link confirmExecution}: `true` exactly when the row
   * now reads `created` with this execution — a confirmation that was written
   * now, or the idempotent re-report of the one already recorded.
   */
  confirm(effect: OutcomeDispatchEffectKey, execution: HostExecutionIdentity): boolean {
    return isRecorded(this.confirmExecution(effect, execution));
  }

  /**
   * Record the host execution the platform CONFIRMED, and say what happened.
   *
   * THE ONE CONDITIONAL WRITE. It presents this process's claim (or the
   * no-claim generation) and the store decides: the row must be `creating`,
   * owned by this owner, at this generation. A confirmation from an expired
   * owner — or from a process that never claimed the effect — writes NOTHING,
   * is reported as `fenced`, and is recorded on the row for diagnosis. The
   * execution id is required and non-empty: `created` is the one state a lookup
   * reports as a fact, so the store refuses to write it without the fact.
   */
  confirmExecution(
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ): HostExecutionConfirmation {
    const generation = this.claims.get(claimKeyOf(effect)) ?? NO_CLAIM_GENERATION;
    const verdict = this.store.confirmExecution(
      effect,
      this.ownerId,
      generation,
      execution,
      this.now(),
    );
    if (verdict.kind === "fenced" || verdict.kind === "conflict") {
      logWarn(describeRefusal(effect, verdict, this.ownerId));
    }
    return verdict;
  }

  /**
   * Report a delivery failure for this claim.
   *
   * WITH a proof the claim is RELEASED — the effect is `pending` and `absent`
   * again, and a later recovery may create it exactly once. WITHOUT a proof
   * nothing is released: the row keeps `creating` (every lookup answers
   * `unknown`), the failure is recorded on the row as `unproven-failure`, and
   * this returns `false`. An asynchronous rejection or a timeout is the
   * proof-less case, and it must not license a second create.
   *
   * The two-argument form is what the host's asynchronous failure report calls;
   * it is deliberately the SAFE form.
   */
  release(
    effect: OutcomeDispatchEffectKey,
    ownerId: string,
    proof?: HostExecutionNotCreated,
  ): boolean {
    const key = claimKeyOf(effect);
    const generation = this.claims.get(key) ?? NO_CLAIM_GENERATION;
    if (proof === undefined) {
      this.store.recordUnprovenFailure(effect, ownerId, generation, this.now());
      logWarn(
        "execution-index: the delivery of effect " +
        JSON.stringify(effect.effectId) +
        " failed WITHOUT proving that no execution was created, so the create right is KEPT " +
        "— the row stays 'creating', every lookup answers 'unknown', and the effect is " +
        "reported as unresolved instead of being re-dispatched",
      );
      return false;
    }
    const released = this.store.releaseExecution(
      effect,
      ownerId,
      generation,
      proof,
      this.now(),
    );
    if (released) this.claims.delete(key);
    return released;
  }

  /**
   * Release a claim this process does NOT hold, after the platform PROVED it is
   * stranded: the platform's execution query answered `absent` for this stable
   * effect id, so no execution exists for the claim and re-creating is safe.
   *
   * The write names the claim the caller OBSERVED (`held.ownerId`,
   * `held.generation`) and the store applies it only while that is still the
   * row's claim — a claim taken over in between loses the conditional update
   * and the caller refuses instead of releasing somebody else's live claim.
   */
  releaseStale(
    effect: OutcomeDispatchEffectKey,
    held: HostExecutionClaimRef,
    proof: HostExecutionNotCreated,
  ): boolean {
    const released = this.store.releaseExecution(
      effect,
      held.ownerId,
      held.generation,
      proof,
      this.now(),
    );
    if (released) this.claims.delete(claimKeyOf(effect));
    return released;
  }

  /**
   * Whether an execution for this effect exists, as the host can tell.
   *
   * A durable store answers for every create this host ever performed, so an
   * effect with no row is `absent`. A memory-only store cannot see an earlier
   * process's rows, so it answers `unknown` for everything it does not hold —
   * never `absent` for what it cannot see. A released row answers `absent` to
   * everyone: by the proof that released it, nothing was created.
   */
  lookup(effect: OutcomeDispatchEffectKey): OutcomeExecutionLookup {
    const row = this.read(effect);
    if (row === undefined) {
      if (this.durability === "file") {
        return Object.freeze({ kind: "absent" as const });
      }
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "this host keeps its execution registry in memory only, so it cannot say whether " +
          "graph " +
          JSON.stringify(effect.graphId) +
          " already had an execution for effect " +
          JSON.stringify(effect.effectId) +
          " created by an earlier process",
      });
    }
    if (row.state === "created") {
      if (row.execution !== undefined) {
        return Object.freeze({ kind: "created" as const });
      }
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the host registry records effect " +
          JSON.stringify(effect.effectId) +
          " as created but carries no host execution id, so the fact cannot be " +
          "reconciled against the platform",
      });
    }
    if (row.state === "creating") {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the host handed effect " +
          JSON.stringify(effect.effectId) +
          " to the platform and has no confirmation naming the execution it created, so " +
          "whether it exists is UNKNOWN — a blind retry could run the attempt twice",
      });
    }
    // pending: released under a proof, or a claim that never handed anything to
    // the platform. Neither can have an execution, so the answer is `absent` —
    // for the releaser, for another owner, and for a reader of a dead claim's
    // expired lease alike.
    if (
      row.releasedAt !== undefined ||
      row.ownerId === this.ownerId ||
      row.claimedAt + this.leaseMs <= this.now()
    ) {
      return Object.freeze({ kind: "absent" as const });
    }
    return Object.freeze({
      kind: "unknown" as const,
      reason:
        "another host process (owner " +
        JSON.stringify(row.ownerId) +
        ", claim " +
        String(row.generation) +
        ") holds the create right for effect " +
        JSON.stringify(effect.effectId) +
        " and has not yet handed it to the platform",
    });
  }

  /** One effect's row, or `undefined`. */
  read(effect: OutcomeDispatchEffectKey): HostDispatchExecution | undefined {
    return this.store.readExecution(effect);
  }

  /** Whether this effect has a row at all (any state). */
  has(effect: OutcomeDispatchEffectKey): boolean {
    return this.read(effect) !== undefined;
  }

  /** How many effects this host has rows for. A count, never a listing. */
  get size(): number {
    const row = this.store.get(
      `SELECT COUNT(*) AS total FROM ${GRAPH_STORE_TABLES.executions}`,
    );
    const total = row?.["total"];
    return typeof total === "number" ? total : 0;
  }

  /** Close the underlying store connection. Idempotent. */
  close(): void {
    this.store.close();
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * The table this registry writes, as the STORE names it.
 *
 * Exported because a reader of the host layer may want the durable name; the
 * registry itself addresses it through the store's table map, so the name has
 * one definition.
 */
export const HOST_EXECUTION_TABLE = GRAPH_STORE_TABLES.executions;

/** The in-process key of one effect's claim: graph and effect, never the node. */
function claimKeyOf(effect: OutcomeDispatchEffectKey): string {
  return effect.graphId + "\u0000" + effect.effectId;
}

/** Whether a confirmation's verdict means the row now reads `created`. */
function isRecorded(verdict: HostExecutionConfirmation): boolean {
  return verdict.kind === "confirmed" || verdict.kind === "replayed";
}

/** The explicit refusal the create-once rule needs, as this layer words it. */
function heldClaim(row: HostDispatchExecution): HostExecutionClaim {
  return Object.freeze({
    kind: "held" as const,
    state: row.state,
    ownerId: row.ownerId,
    generation: row.generation,
    ...(row.execution === undefined ? {} : { execution: row.execution }),
  });
}

/**
 * One refused confirmation, worded for the log.
 *
 * Ids and claim generations only: this is a warning about a WRITE, and it must
 * not become the channel a credential or a host error string travels over.
 */
function describeRefusal(
  effect: OutcomeDispatchEffectKey,
  verdict: Extract<HostExecutionConfirmation, { kind: "fenced" | "conflict" }>,
  attemptedOwnerId: string,
): string {
  if (verdict.kind === "conflict") {
    return (
      "execution-index: refusing to rebind effect " +
      JSON.stringify(effect.effectId) +
      " of graph " +
      JSON.stringify(effect.graphId) +
      " from the execution it already records (" +
      JSON.stringify(verdict.recorded.executionId) +
      ") to " +
      JSON.stringify(verdict.reported.executionId) +
      " — two executions for one stable effect id is what this registry exists to prevent; " +
      "the recorded fact is unchanged and the attempt was reported"
    );
  }
  return (
    "execution-index: refused a confirmation of effect " +
    JSON.stringify(effect.effectId) +
    " of graph " +
    JSON.stringify(effect.graphId) +
    " from owner " +
    JSON.stringify(attemptedOwnerId) +
    " claim " +
    String(verdict.attemptedGeneration) +
    " — the row belongs to owner " +
    JSON.stringify(verdict.ownerId) +
    " claim " +
    String(verdict.generation) +
    " in state " +
    JSON.stringify(verdict.state) +
    "; the stale attempt was recorded on the row and nothing was written"
  );
}
