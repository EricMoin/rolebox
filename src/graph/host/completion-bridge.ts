/**
 * Graph Execution Engine v2 — the host's dispatch completion bridge
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE PROTOCOL-AWARE BRIDGE THE RUN PATH WAS WAITING FOR. `settleNatural`
 * (`src/graph/outcome/runtime.ts`) settles one attempt from its COMPLETION
 * FACT — no outcome, no payload, no evidence list: the outcome is the plan's
 * pinned authorization, and the settlement runs through the SAME acceptance
 * core, the same declared gates, the same reducer and the same atomic
 * receipt/event/state/effects transaction as a worker's own submission. What
 * was missing was the host side that watches a dispatched attempt reach its end
 * and hands that fact over. This is it.
 *
 * WHAT THE BRIDGE DOES, IN ORDER. The host's dispatch adapter
 * (`dispatch-host.ts`) reports every binding it creates; when the platform
 * says the attempt finished, `complete()`
 *
 * 1. resolves the BINDING the host recorded at delivery (graph, node, attempt)
 *    — a completion for an attempt this host never dispatched is REPORTED, not
 *    guessed: the attempt id is never parsed and the node's current attempt is
 *    never substituted;
 * 2. resolves the attempt's credential from {@link HostCredentialVault} — the
 *    one place it exists, since the state body records only its digest. A
 *    credential the vault cannot produce is REPORTED and the attempt is NOT
 *    settled with a fabricated one;
 * 3. calls `settleNatural({ nodeId, attemptId, credential })` and returns its
 *    result VERBATIM. The bridge adds no policy, no retry and no reinterpretation:
 *    an unauthorized node, a declared gate that did not pass and a settlement
 *    that was already committed are the runtime's own answers, and its caller
 *    decides what to do with them.
 *
 * THE CREDENTIAL IS DELIVERED, NEVER REPORTED. It travels from the vault into
 * the settlement envelope — the same channel the runtime requires — and appears
 * in no field of the report this bridge returns. The report names the attempt.
 *
 * IDEMPOTENT BY THE LEDGER, NOT BY A FLAG HERE. A completion observed twice
 * (a platform that re-announces a terminal event) derives the same
 * content-addressed submission key and the ledger REPLAYS its receipt: no second
 * settlement, no second accepted event, no state advance. The bridge therefore
 * keeps its bindings and answers the replay rather than dropping the second
 * observation.
 *
 * A FAILED ATTEMPT IS NOT A COMPLETION. This bridge settles an attempt that
 * REACHED the outcome its plan authorized. A worker that errored or was
 * cancelled has no pinned completion, and inventing one would fabricate a
 * result the run never produced; the host's failure policy (retry, cancel,
 * report) stays outside the outcome protocol.
 */

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
       * The attempt is bound, but the host's credential vault cannot produce
       * the credential it was issued (never held, pruned, or a memory-only
       * vault that restarted). Reported with the reason; nothing was written.
       */
      readonly kind: "credential-unavailable";
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

  constructor(options: HostCompletionBridgeOptions) {
    this.runtime = options.runtime;
    this.credentials = options.credentials;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Record one delivery. Called by the dispatch adapter the moment an execution
   * is handed to the platform, so a completion can name the node it belongs to
   * without parsing the attempt id.
   */
  bind(binding: HostAttemptBinding): void {
    this.bindings.set(bindingKey(binding.graphId, binding.attemptId), binding);
  }

  /** Drop one binding (a host that prunes settled attempts explicitly). */
  forget(attempt: HostCompletionAttempt): void {
    this.bindings.delete(bindingKey(attempt.graphId, attempt.attemptId));
  }

  /** How many attempts this host can still settle. A count, never a listing. */
  get bound(): number {
    return this.bindings.size;
  }

  /**
   * The binding one attempt was dispatched under, or `undefined` when this
   * host dispatched no execution for it.
   *
   * Exposed so the HOST (not this bridge) can re-enter the invocation
   * attribution the attempt was armed under before it settles: the holder is
   * the host's, and the settlement must run under the same attribution the
   * runtime recorded at dispatch, even when the completion is observed later
   * with no invocation in effect.
   */
  bindingFor(attempt: HostCompletionAttempt): HostAttemptBinding | undefined {
    return this.bindings.get(bindingKey(attempt.graphId, attempt.attemptId));
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
    const binding = this.bindings.get(
      bindingKey(attempt.graphId, attempt.attemptId),
    );
    if (binding === undefined) {
      return Object.freeze({
        kind: "unbound" as const,
        attemptId: attempt.attemptId,
        reason:
          "this host dispatched no execution for graph " +
          JSON.stringify(attempt.graphId) +
          " attempt " +
          JSON.stringify(attempt.attemptId) +
          " in this process, so there is no recorded node to settle — the attempt id is " +
          "never parsed and no node's current attempt is substituted",
      });
    }
    const credential = this.credentials.resolve({
      graphId: attempt.graphId,
      nodeId: binding.nodeId,
      attemptId: binding.attemptId,
    });
    if (credential === undefined) {
      return Object.freeze({
        kind: "credential-unavailable" as const,
        attemptId: binding.attemptId,
        nodeId: binding.nodeId,
        reason:
          "the host credential vault holds no credential for this attempt (a memory-only " +
          "vault loses them across a restart, and a pruned one forgets them), so the " +
          "completion is NOT settled with a fabricated credential",
      });
    }
    const runtime = await (typeof this.runtime === "function"
      ? this.runtime()
      : this.runtime);
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
