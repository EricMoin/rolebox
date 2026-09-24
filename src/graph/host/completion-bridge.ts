import type {
  OutcomeNaturalSettlementResult,
  OutcomeRuntimeRefusal,
} from "../outcome/runtime.ts";
import type { AcceptanceDecision } from "../outcome/acceptance.ts";
import type { NaturalCompletionSettlement } from "../outcome/natural-completion.ts";
import type { OutcomeGraphState, OutcomeStop } from "../outcome/graph-state.ts";
import type { ProgressReport } from "../outcome/progress.ts";
import type { ReceiptRecord } from "../ledger/types.ts";
import type { HostAttemptBinding, HostCompletionBindingSink } from "./dispatch-host.ts";
import { HostCredentialVault } from "./credential-vault.ts";

// ── The runtime seam ────────────────────────────────────────────────────────

/**
 * The one runtime capability the bridge needs. Structural on purpose: a host
 * passes its `OutcomeGraphRuntime` (or any object with the same method), and a
 * test can drive the bridge without constructing a ledger-backed runtime.
 */
export interface HostCompletionRuntime {
  settleNatural(delivery: unknown, now?: number): OutcomeNaturalSettlementResult;
  /**
   * The HOST-COMPLETION channel (P2 items 6/7): settle an attempt from the
   * host's own durable execution record, WITHOUT the worker's bearer value.
   *
   * OPTIONAL, because the seam is structural: a test double may implement only
   * the bearer channel, and a runtime built before this channel existed has no
   * such method. When it is absent the bridge uses the bearer channel and
   * reports UNBOUND/UNUTHENTICATED honestly rather than assuming a settlement
   * it cannot perform.
   */
  settleHostCompletion?(delivery: unknown, now?: number): OutcomeNaturalSettlementResult;
}

/**
 * WHERE A COMPLETION'S ATTEMPT BINDING COMES FROM AFTER A RESTART (P2 item 6).
 *
 * The bridge's in-process map only holds what THIS process delivered. The
 * durable record of a delivery is the host's execution row — the ONE store's
 * `host_dispatch_executions` table, keyed by the stable effect id derived from
 * the attempt — and this seam is how the bridge reaches it without importing
 * the store. A source answers the binding the host recorded for one attempt, or
 * `undefined` when the host holds no such delivery; it never parses an attempt
 * id and never substitutes the node's current attempt.
 */
export interface HostCompletionBindingSource {
  resolve(attempt: HostCompletionAttempt): HostAttemptBinding | undefined;
}

/**
 * One attempt's CONFIRMED host execution, as the host's durable record holds it
 * — the platform's own execution id, plus its task id when the platform names
 * the two apart.
 */
export interface HostCompletionExecutionRecord {
  readonly executionId: string;
  readonly taskId?: string;
}

/**
 * THE HOST'S OWN FACT ABOUT THE EXECUTION IT CREATED (P2 item 7).
 *
 * A completion observed after a restart cannot be authenticated by a worker
 * bearer the host no longer holds, so it is authenticated by this: the durable
 * row the platform's confirmation wrote, naming the real execution. Absent
 * means the host never confirmed an execution for the attempt — a delivery
 * observation alone is NOT a completion fact — and the bridge settles nothing
 * on that attempt's behalf unless it still holds the bearer value.
 */
export interface HostCompletionExecutionSource {
  executionFor(attempt: HostCompletionAttempt): HostCompletionExecutionRecord | undefined;
}

/**
 * How the bridge obtains the runtime for one settlement.
 *
 * A PROVIDER IS THE REAL-HOST SHAPE, not a convenience: the production entries
 * (`tools/submit-outcome.ts`, `engine/engine-startup.ts`) construct an
 * `OutcomeGraphRuntime` per operation over the graph's saved plan and the
 * shared ledger, and a long-lived host bridge must settle through a runtime
 * built the same way rather than hold one runtime forever. A provider may
 * answer a PROMISE, because opening the host's ledger is asynchronous — which
 * is also why {@link HostDispatchCompletionBridge.complete} is async: the
 * settlement itself stays the runtime's synchronous transaction. An instance is
 * accepted too, for a host that already holds one.
 */
export type HostCompletionRuntimeProvider = () =>
  | HostCompletionRuntime
  | Promise<HostCompletionRuntime>;

/** Inputs to {@link HostDispatchCompletionBridge}. */
export interface HostCompletionBridgeOptions {
  /** The runtime (or a provider for one) that settles through `settleNatural`. */
  readonly runtime: HostCompletionRuntime | HostCompletionRuntimeProvider;
  /** The vault that holds the credential the attempt was issued. */
  readonly credentials: HostCredentialVault;
  /** The clock reported to the settlement; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * The host's DURABLE bindings, consulted when this process holds none for an
   * attempt. Omitted means the bridge only knows what it delivered itself —
   * which is exactly the pre-P2 behaviour, and a completion for anything else
   * is reported UNBOUND.
   */
  readonly bindings?: HostCompletionBindingSource;
  /**
   * The host's CONFIRMED executions, read to build a host-authenticated
   * completion fact. Omitted (with the runtime lacking the channel) leaves the
   * bearer channel as the only way to settle.
   */
  readonly executions?: HostCompletionExecutionSource;
}

// ── The report ──────────────────────────────────────────────────────────────

/** One attempt the host says has finished. */
export interface HostCompletionAttempt {
  readonly graphId: string;
  readonly attemptId: string;
}

/**
 * One settlement, as a REPORT — the runtime's result WITHOUT its dispatch
 * channel.
 *
 * `OutcomeNaturalSettlementResult.accepted` carries the `dispatched` requests
 * the acceptance armed, and a dispatch request is the ONE thing that carries an
 * attempt credential (`OutcomeDispatchRequest`). A host does not need them
 * here: its own dispatch adapter was handed every one of them through the
 * delivery seam at the moment the runtime launched it. Republishing them in a
 * report would put a successor's credential back into an arbitrary caller's
 * hands — exactly the exposure the credential-isolation capability exists to
 * close — so the bridge projects the settlement instead, and the projection
 * cannot contain a credential because nothing in it is a dispatch request.
 */
export type HostCompletionSettlement =
  | {
    readonly kind: "refused";
    readonly refusals: readonly OutcomeRuntimeRefusal[];
  }
  | {
    readonly kind: "accepted";
    readonly completion: NaturalCompletionSettlement;
    readonly decision: AcceptanceDecision;
    readonly receipt: ReceiptRecord;
    readonly state: OutcomeGraphState;
    readonly replayed: boolean;
    readonly stop?: OutcomeStop;
    readonly progress?: readonly ProgressReport[];
  }
  | {
    readonly kind: "rejected";
    readonly completion: NaturalCompletionSettlement;
    readonly decision: AcceptanceDecision;
    readonly receipt: ReceiptRecord;
  }
  | {
    readonly kind: "not-committed";
    readonly completion: NaturalCompletionSettlement;
    readonly decision: AcceptanceDecision;
    readonly verdict: Extract<
      OutcomeNaturalSettlementResult,
      { kind: "not-committed" }
    >["verdict"];
  };

/**
 * What one completion produced.
 *
 * `settled` means `settleNatural` RAN; whether it accepted, rejected or
 * refused is the `settlement`'s own answer, never re-interpreted here. The
 * other kinds are the two ways the bridge could not hand the fact over at all.
 */
export type HostCompletionReport =
  | {
    readonly kind: "settled";
    readonly attemptId: string;
    readonly nodeId: string;
    readonly settlement: HostCompletionSettlement;
  }
  | {
    /**
     * No delivery bound this attempt in this host, so there is no node to
     * settle and no reason to trust a parsed attempt id. Reported with the
     * reason; nothing was written.
     */
    readonly kind: "unbound";
    readonly attemptId: string;
    readonly reason: string;
  }
  | {
    /**
     * The attempt is bound, but NOTHING authenticates the completion: the
     * vault cannot produce the credential it was issued (never held, pruned,
     * or a memory-only vault that restarted) AND the host holds no confirmed
     * execution for it. Reported with the reason; nothing was written, and no
     * credential, execution or outcome is invented to make it settle.
     */
    readonly kind: "unauthenticated";
    readonly attemptId: string;
    readonly nodeId: string;
    readonly reason: string;
  };

// ── The bridge ──────────────────────────────────────────────────────────────

/** The host's bridge from an observed completion to `settleNatural`. */
export class HostDispatchCompletionBridge implements HostCompletionBindingSink {
  private readonly runtime: HostCompletionRuntime | HostCompletionRuntimeProvider;
  private readonly credentials: HostCredentialVault;
  private readonly clock: () => number;
  private readonly bindings = new Map<string, HostAttemptBinding>();
  /** The host's durable bindings, read when this process holds none. */
  private readonly durableBindings: HostCompletionBindingSource | undefined;
  /** The host's confirmed executions, read to authenticate a completion. */
  private readonly executions: HostCompletionExecutionSource | undefined;

  constructor(options: HostCompletionBridgeOptions) {
    this.runtime = options.runtime;
    this.credentials = options.credentials;
    this.clock = options.clock ?? (() => Date.now());
    this.durableBindings = options.bindings;
    this.executions = options.executions;
  }

  /**
   * Record one delivery. Called by the dispatch adapter the moment an execution
   * is handed to the platform, so a completion can name the node it belongs to
   * without parsing the attempt id.
   */
  bind(binding: HostAttemptBinding): void {
    this.bindings.set(bindingKey(binding.graphId, binding.attemptId), binding);
  }

  /**
   * Drop one binding from THIS PROCESS's cache (a host that prunes settled
   * attempts explicitly).
   *
   * IT DOES NOT UNBIND THE ATTEMPT. The durable half is the host's own record,
   * and a pruned cache entry is simply re-read from it (see {@link bindingFor});
   * nothing here can delete a delivery the host recorded.
   */
  forget(attempt: HostCompletionAttempt): void {
    this.bindings.delete(bindingKey(attempt.graphId, attempt.attemptId));
  }

  /**
   * How many bindings this PROCESS's cache holds — a count, never a listing.
   *
   * NOT "how many attempts can still be settled": the durable half (the host's
   * execution records) is not enumerable through this class, and after a restart
   * this number is zero while {@link bindingFor} still answers for every attempt
   * the host recorded.
   */
  get bound(): number {
    return this.bindings.size;
  }

  /**
   * The binding one attempt was dispatched under, from this process's cache or
   * from the host's durable record, or `undefined` when neither holds one.
   *
   * Exposed so the HOST (not this bridge) can re-enter the invocation
   * attribution the attempt was armed under before it settles: the holder is
   * the host's, and the settlement must run under the same attribution the
   * runtime recorded at dispatch, even when the completion is observed later
   * with no invocation in effect.
   */
  bindingFor(attempt: HostCompletionAttempt): HostAttemptBinding | undefined {
    const local = this.bindings.get(bindingKey(attempt.graphId, attempt.attemptId));
    if (local !== undefined) return local;
    // THE DURABLE HALF (P2 item 6). A completion that arrives after the process
    // which dispatched the attempt exited has no entry in the map above, so the
    // binding is rebuilt from the host's OWN record of the delivery — read from
    // durable facts by the injected source, never parsed out of the attempt id
    // and never substituted from the node's current attempt. A source that
    // throws has not answered: the attempt stays unbound and is reported.
    const durable = this.durableBindings;
    if (durable === undefined) return undefined;
    try {
      return durable.resolve(attempt);
    } catch {
      return undefined;
    }
  }

  /**
   * Settle the attempt the host observed finishing.
   *
   * The envelope is exactly `{ nodeId, attemptId, credential }` — the closed
   * shape `settleNatural` reads — so no outcome, payload or evidence can be
   * smuggled through the completion channel; the outcome is the plan's pinned
   * authorization.
   *
   * ASYNC ONLY AT THE EDGES: resolving the binding and the credential is
   * synchronous, obtaining the runtime may await the host's store, and the
   * settlement itself is the runtime's own synchronous acceptance transaction.
   */
  async complete(attempt: HostCompletionAttempt): Promise<HostCompletionReport> {
    const binding = this.bindingFor(attempt);
    if (binding === undefined) {
      return Object.freeze({
        kind: "unbound" as const,
        attemptId: attempt.attemptId,
        reason:
          "neither this process nor the host's durable record holds a delivery binding for " +
          "graph " +
          JSON.stringify(attempt.graphId) +
          " attempt " +
          JSON.stringify(attempt.attemptId) +
          ", so there is no recorded node to settle — the attempt id is never parsed and no " +
          "node's current attempt is substituted",
      });
    }
    const runtime = await (typeof this.runtime === "function"
      ? this.runtime()
      : this.runtime);
    // THE HOST'S OWN FACT IS TRIED FIRST (P2 items 6/7, §3.3): a completion the
    // host can authenticate from its durable execution record is settled
    // WITHOUT the worker's bearer value, which is the only way a completion
    // observed after a restart — when the shipped vault keeps no credential
    // value at all — can settle the attempt the host really created.
    const authentication = this.hostAuthenticationOf(binding, runtime);
    if (authentication.kind === "host-execution") {
      const settlement = authentication.settle(
        Object.freeze({
          nodeId: binding.nodeId,
          attemptId: binding.attemptId,
          executionId: authentication.execution.executionId,
        }),
        this.clock(),
      );
      return Object.freeze({
        kind: "settled" as const,
        attemptId: binding.attemptId,
        nodeId: binding.nodeId,
        settlement: reportSettlement(settlement),
      });
    }
    const credential = this.credentials.resolve({
      graphId: binding.graphId,
      nodeId: binding.nodeId,
      attemptId: binding.attemptId,
    });
    if (credential === undefined) {
      return Object.freeze({
        kind: "unauthenticated" as const,
        attemptId: binding.attemptId,
        nodeId: binding.nodeId,
        reason:
          "the host credential vault holds no credential for this attempt (a memory-only " +
          "vault loses them across a restart, and a pruned one forgets them) and " +
          authentication.reason +
          " — so the completion is NOT settled with a fabricated credential and NOT settled " +
          "against an execution the host did not confirm",
      });
    }
    const settlement = runtime.settleNatural(
      Object.freeze({
        nodeId: binding.nodeId,
        attemptId: binding.attemptId,
        credential,
      }),
      this.clock(),
    );
    return Object.freeze({
      kind: "settled" as const,
      attemptId: binding.attemptId,
      nodeId: binding.nodeId,
      settlement: reportSettlement(settlement),
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * How this completion can be authenticated, and why not when it cannot.
   *
   * TWO DISJOINT PROOFS, and the durable one is preferred because it is the only
   * one a restart can still rely on. It answers with the host's confirmed
   * execution when the record exists AND the runtime offers the channel; every
   * other case carries the reason the report names, so an unauthenticated
   * completion is diagnosable instead of a bare refusal.
   */
  private hostAuthenticationOf(
    binding: HostAttemptBinding,
    runtime: HostCompletionRuntime,
  ):
    | {
      readonly kind: "host-execution";
      readonly execution: HostCompletionExecutionRecord;
      /**
       * The runtime's host-completion entry, bound to ITS runtime instance.
       * Binding it here is what lets the caller invoke it without a
       * non-null assertion: the method needs its own `this`, and a detached
       * reference would silently lose it.
       */
      readonly settle: (
        fact: unknown,
        now: number,
      ) => OutcomeNaturalSettlementResult;
    }
    | { readonly kind: "none"; readonly reason: string } {
    const settleHostCompletion = runtime.settleHostCompletion;
    if (settleHostCompletion === undefined) {
      return Object.freeze({
        kind: "none" as const,
        reason:
          "this runtime offers no host-completion channel, so the host's own execution record " +
          "cannot authenticate it",
      });
    }
    const source = this.executions;
    if (source === undefined) {
      return Object.freeze({
        kind: "none" as const,
        reason:
          "this host exposes no execution record, so there is no host fact to authenticate against",
      });
    }
    let execution: HostCompletionExecutionRecord | undefined;
    try {
      execution = source.executionFor({
        graphId: binding.graphId,
        attemptId: binding.attemptId,
      });
    } catch {
      return Object.freeze({
        kind: "none" as const,
        reason:
          "the host's execution record could not be read, so there is no host fact to " +
          "authenticate against",
      });
    }
    if (
      execution === undefined ||
      typeof execution.executionId !== "string" ||
      execution.executionId.length === 0
    ) {
      return Object.freeze({
        kind: "none" as const,
        reason:
          "the host holds no CONFIRMED execution for it, so there is no host fact to " +
          "authenticate against (a delivery observation alone is not a completion)",
      });
    }
    return Object.freeze({
      kind: "host-execution" as const,
      execution,
      settle: (fact: unknown, now: number) =>
        settleHostCompletion.call(runtime, fact, now),
    });
  }
}

// ── Primitives ──────────────────────────────────────────────────────────────

/**
 * Project one runtime settlement into the credential-free report shape.
 *
 * The `dispatched` list is dropped ON PURPOSE (see
 * {@link HostCompletionSettlement}); every other field is carried over
 * untouched, so the report still says exactly what the runtime decided, what it
 * persisted and whether the ledger replayed a receipt.
 */
function reportSettlement(
  settlement: OutcomeNaturalSettlementResult,
): HostCompletionSettlement {
  switch (settlement.kind) {
    case "refused":
      return Object.freeze({
        kind: "refused" as const,
        refusals: settlement.refusals,
      });
    case "rejected":
      return Object.freeze({
        kind: "rejected" as const,
        completion: settlement.completion,
        decision: settlement.decision,
        receipt: settlement.receipt,
      });
    case "not-committed":
      return Object.freeze({
        kind: "not-committed" as const,
        completion: settlement.completion,
        decision: settlement.decision,
        verdict: settlement.verdict,
      });
    case "accepted":
      return Object.freeze({
        kind: "accepted" as const,
        completion: settlement.completion,
        decision: settlement.decision,
        receipt: settlement.receipt,
        state: settlement.state,
        replayed: settlement.replayed,
        ...(settlement.stop === undefined ? {} : { stop: settlement.stop }),
        ...(settlement.progress === undefined
          ? {}
          : { progress: settlement.progress }),
      });
  }
}

/** One binding's map key: graph + attempt, joined unambiguously. */
function bindingKey(graphId: string, attemptId: string): string {
  return graphId + "\u0000" + attemptId;
}
