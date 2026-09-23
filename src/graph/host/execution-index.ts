/**
 * Graph Execution Engine v2 — the host's durable dispatch-execution registry
 *
 * Version: 2.0
 * Date: 2026-09-23
 *
 * THE FACTS HALF OF THE DISPATCH HOST (D8). `src/graph/outcome/dispatch-effects.ts`
 * gives the runtime two answers it cannot derive on its own: create this
 * effect's execution (idempotently per `(graphId, effectId)`) and say whether an
 * execution for that stable id ALREADY EXISTS. This module owns both for a real
 * host, over the workspace's ONE authoritative store
 * ({@link GraphStore}, `src/graph/store/`) — the SAME database that holds the
 * acceptance ledger, so the effect intent and the host's bind to it are rows in
 * one file and one transaction can write both.
 *
 * THIS MODULE IS A FACADE OVER THE STORE'S `host_dispatch_executions` TABLE:
 * the lease, the owner identity and the three-answer lookup policy live here,
 * while the row's shape, its primary key and its conditional transitions live in
 * the store. Every write delegates, so an application service that opens
 * `GraphStore.transaction` can claim, confirm or release in the SAME
 * transaction as the acceptance that authorized the effect.
 *
 * THE THREE STATES, AND WHY TWO WERE NOT ENOUGH. A create is not a single
 * event: the host first takes the right to create, then hands the request to a
 * platform it cannot see into, then (maybe) learns what the platform made. The
 * registry therefore records WHICH of those steps happened:
 *
 * - `pending` — a create right is held and NOTHING has been handed to the
 *   platform. No execution can exist, so a stale claim may be taken over and
 *   the effect is a genuine `absent`.
 * - `creating` — the request WAS handed over and the result is unknown. A crash
 *   here leaves an execution that may or may not exist; `lookup` answers
 *   `unknown` and NEVER `absent`, because a blind retry could run the attempt
 *   twice. This is the state the previous design could not express: it wrote
 *   its "preparing to create" record into the same set as "created", so a fresh
 *   reader answered `created` for an execution nobody had confirmed.
 * - `created` — the platform CONFIRMED the execution and named a real host
 *   execution/task id ({@link HostExecutionIdentity}). The store's own CHECK
 *   constraint makes `created` without an id unrepresentable, so `lookup` can
 *   answer `created` only from a host fact.
 *
 * CROSS-INSTANCE UNIQUENESS IS STRUCTURAL. The primary key
 * `(graph_id, effect_id)` and a conditional `UPDATE ... WHERE owner_id = ?`
 * are what make "only one instance gets the create right" a property of the
 * store rather than of a lock in one process: a second instance's `claim`
 * either loses the conditional update and is told the effect is HELD, or takes
 * over a claim whose lease expired — it is never silently granted a second
 * dispatch. Two processes each keeping an in-memory snapshot and rewriting one
 * file (the previous shape) could not express either guarantee, and the
 * reproduced defect was exactly that: the later writer erased the other's rows.
 *
 * WHAT THE REGISTRY IS NOT. It is not a completion source and not a scheduler:
 * nothing here executes, cancels or settles anything. A confirmed execution is
 * a FACT a recovery may reconcile against, not a promise that the attempt ran.
 */

import { randomUUID } from "node:crypto";

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

/** One effect's registry row, as read back. */
export interface HostDispatchExecution {
  readonly graphId: string;
  readonly effectId: string;
  readonly attemptId: string;
  readonly state: HostExecutionState;
  /** The host instance that held (or holds) the create right. */
  readonly ownerId: string;
  /** The confirmed host execution, present exactly when `state` is `created`. */
  readonly execution?: HostExecutionIdentity;
  readonly claimedAt: number;
  readonly updatedAt: number;
}

/**
 * The answer to "may THIS instance create the execution?".
 *
 * `held` is the explicit refusal the create-once rule needs: the effect is
 * owned by another claim or already exists, and this instance must not hand it
 * to the platform again.
 */
export type HostExecutionClaim =
  | { readonly kind: "claimed"; readonly ownerId: string }
  | {
      readonly kind: "held";
      readonly state: HostExecutionState;
      readonly ownerId: string;
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
   * so two instances in one process are two owners.
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
   * instance already holds it (`claimed`, idempotent), or another
   * claim/execution owns it (`held`). The insert, the read and the conditional
   * takeover all run inside the STORE's transaction — which is the caller's
   * when one is open, so a service can claim in the same boundary that commits
   * the effect.
   */
  claim(effect: OutcomeDispatchEffectKey): HostExecutionClaim {
    const outcome = this.store.claimExecution(
      effect,
      this.ownerId,
      this.now(),
      this.leaseMs,
    );
    return outcome.kind === "claimed"
      ? Object.freeze({ kind: "claimed" as const, ownerId: outcome.ownerId })
      : heldClaim(outcome.row);
  }

  /**
   * Record that the create request is ABOUT TO BE handed to the platform.
   *
   * Called BEFORE the delivery, never after: the row must say `creating` for
   * the whole window in which the platform may have received the request, so a
   * crash inside that window leaves `unknown` rather than a claim that looks
   * safely retryable.
   */
  markCreating(effect: OutcomeDispatchEffectKey, ownerId: string): boolean {
    return this.store.markExecutionCreating(effect, ownerId, this.now());
  }

  /**
   * Record the host execution the platform CONFIRMED.
   *
   * The execution id is required and non-empty: `created` is the one state
   * `lookup` reports as a fact, so it may only be written with the fact — the
   * store's own CHECK makes the alternative unrepresentable. A row that is not
   * in `creating` is not touched (the confirmation belongs to the process
   * whose request was in flight).
   */
  confirm(effect: OutcomeDispatchEffectKey, execution: HostExecutionIdentity): boolean {
    return this.store.confirmExecution(effect, execution, this.now());
  }

  /**
   * Drop this owner's claim after a delivery that THREW: the execution
   * demonstrably did not start, so a later recovery may create it. A `created`
   * row is never released — that execution exists.
   */
  release(effect: OutcomeDispatchEffectKey, ownerId: string): boolean {
    return this.store.releaseExecution(effect, ownerId);
  }

  /**
   * Whether an execution for this effect exists, as the host can tell.
   *
   * A durable store answers for every create this host ever performed, so an
   * effect with no row is `absent`. A memory-only store cannot see an earlier
   * process's rows, so it answers `unknown` for everything it does not hold —
   * never `absent` for what it cannot see.
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
    // pending: nothing was handed to the platform, so no execution can exist.
    if (row.ownerId === this.ownerId || row.claimedAt + this.leaseMs <= this.now()) {
      return Object.freeze({ kind: "absent" as const });
    }
    return Object.freeze({
      kind: "unknown" as const,
      reason:
        "another host process (owner " +
        JSON.stringify(row.ownerId) +
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

/** The explicit refusal the create-once rule needs, as this layer words it. */
function heldClaim(row: HostDispatchExecution): HostExecutionClaim {
  return Object.freeze({
    kind: "held" as const,
    state: row.state,
    ownerId: row.ownerId,
    ...(row.execution === undefined ? {} : { execution: row.execution }),
  });
}
