/**
 * dsh platform — the OUTCOME run path's dispatch delivery
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE PLATFORM HALF OF THE HOST DISPATCH ADAPTER (`src/graph/host/dispatch-host.ts`)
 * for the dsh entry. The outcome runtime commits a dispatch effect and then
 * calls the host's `create(request, effect)`; this module is what the dsh host
 * injects as the delivery seam, and it starts exactly one dsh subagent run per
 * attempt:
 *
 * - the run is started through `ctx.subagents.start(agent, request)` — the same
 *   seam the legacy graph dispatch used, with the same parent-resolution
 *   contract (dsh REQUIRES a live parent `Agent` and dereferences it while
 *   composing the child, so an unresolvable parent fails LOUD before the start);
 * - the invocation the run belongs to arrives WITH the delivery (the host's
 *   third argument: the graph's declaring invocation, recorded by the host and
 *   re-supplied on every window that arms a dispatch). The adapter keeps no
 *   session state of its own, so a successor armed by an out-of-band completion
 *   is composed under the same parent as the entry attempt, and a delivery
 *   whose host knows no invocation is refused by name instead of being
 *   attributed to whatever call happens to be running;
 * - the worker's prompt is the plan's own prompt plus the attempt handoff
 *   (`src/graph/host/delivery.ts`), which is the ONE channel the bearer
 *   credential travels over;
 * - the run's `result` promise is observed and translated into a completion
 *   report the host hands to the completion bridge: `completed` is a natural
 *   completion, anything else (aborted / error / max-tokens / refusal / a
 *   rejected result promise) is REPORTED as a failed attempt and settles
 *   nothing — a run that did not reach its authorized outcome has no pinned
 *   completion to fabricate.
 *
 * START FAILURES ARE ASYNCHRONOUS. `deliver` must be synchronous (the host
 * adapter's contract), so a start rejection cannot throw out of it. It is
 * reported through `onStartFailed` with the stable effect key, which lets the
 * host drop the execution-index record it took before delivery — the same
 * "the execution did not start" fact the synchronous-throw path records, so a
 * restart asks the host and gets `absent` instead of guessing.
 *
 * THE PLATFORM PORTS (P2 part 2). The delivery also carries the three platform
 * answers the host layer asks for:
 *
 * - {@link DshOutcomeDelivery.executionQuery} — the execution query (P2 item 5):
 *   the create call's durable `label` IS the stable key
 *   (`graphId + "/dispatch:" + attemptId`), and `ctx.subagents.listChildren`
 *   finds the child carrying it. The listing is asynchronous, so it is read by
 *   the port's `prime` phase before the run path's synchronous window, and a
 *   child that is not found answers `unknown` — never `absent`, because a
 *   live-preferred listing cannot prove non-existence;
 * - {@link DshOutcomeDelivery.observeExecution} — the terminal-state read (P2
 *   item 6). dsh has no durable outcome read, so this answers `unknown` with
 *   that reason and the boot sweep reports the execution as explicitly
 *   unsettled;
 * - {@link DshOutcomeDelivery.watchCompletion} — the re-subscribe half (F4),
 *   which answers `unsupported`: a run's `result` promise belongs to the
 *   process that started it, so a restarted process cannot re-establish the
 *   announcement.
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
  OutcomeExecutionProbe,
  OutcomeExecutionQuery,
} from "../../../graph/outcome/dispatch-effects.ts";
import { dispatchIdempotencyKeyOf } from "../../../graph/outcome/dispatch-effects.ts";
import type {
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./dispatch.ts";
import { DshParentUnresolvedError } from "./dispatch.ts";
import type { DshSubagentStartRequest } from "./agent-registrar.ts";
import type { HostDispatchInvocation } from "../../../graph/host/dispatch-host.ts";
import type { HostExecutionIdentity } from "../../../graph/host/execution-index.ts";
import type {
  HostCompletionWatchPort,
  HostExecutionObservationPort,
} from "../../../graph/host/outcome-host.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";

/**
 * One durable direct-child row, as the dsh subagent listing returns it
 * (contract §4.3 `SubagentListEntry`, structural subset).
 *
 * `label` is the DURABLE creation label the create call carried — for an
 * outcome dispatch it is {@link dispatchIdempotencyKeyOf}, which is what makes
 * the child correlatable with its effect in a later process. `activity` is the
 * listing's own liveness sample and `kind`/`id`/`mode` identify the row;
 * rolebox reads none of them as an outcome.
 */
export interface DshSubagentChildRow {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly activity?: string;
  readonly mode?: string;
}

/**
 * The listing half of the dsh subagent service (`SubagentRuntime.listChildren`,
 * contract §4.3). Declared here as an OPTIONAL extension rather than on the
 * shared dispatch surface because it is the query port's need alone: a runtime
 * double for the delivery path does not have to provide it, and a runtime
 * without it answers `unknown` instead of correlating.
 */
export interface DshSubagentCatalogLike {
  listChildren?(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly DshSubagentChildRow[]>;
}

/** The dsh subagent surface the outcome dispatch adapter consumes. */
export type DshOutcomeSubagentRuntime = DshSubagentDispatchRuntime &
  DshSubagentCatalogLike;

/** What the platform observed about one attempt. */
export type DshOutcomeSettlement =
  | { readonly kind: "completed"; readonly request: OutcomeDispatchRequest }
  | {
      readonly kind: "failed";
      readonly request: OutcomeDispatchRequest;
      readonly reason: string;
    };

export interface DshOutcomeDeliveryOptions {
  /** `ctx.subagents` — the dsh subagent runtime. */
  readonly subagents: DshOutcomeSubagentRuntime;
  /**
   * Resolve the live parent `Agent` for the graph's invoking session, exactly
   * as the legacy dsh dispatch path did (probe `ctx.agents`).
   */
  readonly parentResolver?: (sessionId: string) => unknown;
  /** Reports one attempt's terminal observation (completion or failure). */
  readonly onSettled: (settlement: DshOutcomeSettlement) => void;
  /**
   * Reports a start that failed asynchronously, with the stable effect key so
   * the host can release the claim it took before delivery.
   */
  readonly onStartFailed: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    reason: string,
  ) => void;
  /**
   * Reports the dsh subagent run the platform actually created, as soon as its
   * id is known. This is the host fact that turns the execution registry's
   * `creating` row into `created`; a host that omits it leaves the effect
   * `unknown` after a restart — reported as unsettled, never re-dispatched.
   */
  readonly onStarted?: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
  ) => void;
  /** Optional logger name override. */
  readonly loggerName?: string;
}

/**
 * The dsh delivery seam. One instance per host process, and STATELESS about
 * invocations: the session a run is composed under arrives with each delivery
 * as the host's own attribution of the graph's declaring invocation.
 */
/** One `unknown` execution answer, with the platform's own reason. */
function unknownAnswer(reason: string): OutcomeExecutionLookup {
  return Object.freeze({ kind: "unknown" as const, reason });
}

export class DshOutcomeDelivery {
  private readonly log;
  /**
   * The child listings this process has read, per parent session, keyed by the
   * parent the create was composed under (F3).
   *
   * The query port primes it before the run path's synchronous window; lookup
   * reads it and nothing else. A parent with no listing has not been asked (or
   * the listing failed), and its probes answer unknown rather than calling an
   * asynchronous control plane from a synchronous question.
   */
  private readonly childListings = new Map<string, readonly DshSubagentChildRow[]>();

  constructor(private readonly opts: DshOutcomeDeliveryOptions) {
    this.log = createSubLogger(opts.loggerName ?? "dsh-outcome-dispatch");
  }

  /**
   * THE PLATFORM EXECUTION QUERY PORT (P2 item 5 / F3).
   *
   * `prime` reads the child listing of every parent the probes name — the
   * graphs' recorded declaring invocations — once per call, so the answers are
   * ready before the run path asks. `lookup` then correlates a probe with a
   * child by the DURABLE LABEL the create carried
   * ({@link dispatchIdempotencyKeyOf}), which is the one string both sides
   * derive from the stable effect identity.
   *
   * WHAT IT ANSWERS, AND WHAT IT REFUSES TO. A child carrying that label IS the
   * execution: `created`, naming the child session id, which the dsh contract
   * makes equal to the subagent run id the delivery would have confirmed. Two
   * children with the label are AMBIGUOUS, and no child means `unknown` — never
   * `absent`. dsh's listing is live-preferred (without session persistence a
   * child that finished while no process was listening is not listed), so a
   * missing child cannot prove the execution never existed, and only a proof may
   * release a create right.
   */
  readonly executionQuery: OutcomeExecutionQuery = Object.freeze({
    lookup: (probe: OutcomeExecutionProbe): OutcomeExecutionLookup => {
      const listing = this.opts.subagents.listChildren;
      if (listing === undefined) {
        return unknownAnswer(
          "this dsh build exposes no ctx.subagents.listChildren, so a subagent run cannot " +
            "be correlated with the dispatch effect that created it",
        );
      }
      const parentSessionId = probe.invocation?.sessionId;
      if (parentSessionId === undefined || parentSessionId.length === 0) {
        return unknownAnswer(
          "the graph's declaring invocation is not recorded (or names no session), so there " +
            "is no parent whose children could be listed for effect " +
            JSON.stringify(probe.effect.effectId),
        );
      }
      const children = this.childListings.get(parentSessionId);
      if (children === undefined) {
        return unknownAnswer(
          "no child listing has been read for the declaring invocation in this process — the " +
            "platform query port is primed by the host's own recovery window before the run " +
            "path asks, and an unprimed question is never answered on a guess",
        );
      }
      const label = dispatchIdempotencyKeyOf(probe.effect);
      const matches = children.filter(
        (child) => child.kind === "child" && child.label === label,
      );
      if (matches.length === 1) {
        const child = matches[0];
        if (child !== undefined) {
          return Object.freeze({
            kind: "created" as const,
            execution: Object.freeze({ executionId: child.id }),
          });
        }
      }
      if (matches.length > 1) {
        return unknownAnswer(
          "more than one child of session " +
            JSON.stringify(parentSessionId) +
            " carries the stable label " +
            JSON.stringify(label) +
            " — an ambiguous correlation cannot say which execution belongs to effect " +
            JSON.stringify(probe.effect.effectId),
        );
      }
      return unknownAnswer(
        "no listed child of session " +
          JSON.stringify(parentSessionId) +
          " carries the stable label " +
          JSON.stringify(label) +
          " — dsh's listing is live-preferred (a child that finished while no process was " +
          "listening, or one in a profile without session persistence, is not listed), so " +
          "this is NOT a proof that no execution exists and the effect stays blocked",
      );
    },
    prime: async (probes: readonly OutcomeExecutionProbe[]): Promise<void> => {
      const listing = this.opts.subagents.listChildren;
      if (listing === undefined) return;
      const parents = new Set<string>();
      for (const probe of probes) {
        const parentSessionId = probe.invocation?.sessionId;
        if (parentSessionId !== undefined && parentSessionId.length > 0) {
          parents.add(parentSessionId);
        }
      }
      for (const parentSessionId of parents) {
        try {
          const children = await listing.call(this.opts.subagents, parentSessionId);
          this.childListings.set(parentSessionId, Object.freeze([...children]));
        } catch (error) {
          // An unreadable listing is NOT an empty one: the parent's reading is
          // dropped, so its probes answer unknown and stay blocked.
          this.childListings.delete(parentSessionId);
          this.log.warn("dsh outcome dispatch: child listing failed", {
            parentSessionId,
            error: errorText(error),
          });
        }
      }
    },
  });

  /**
   * THE PLATFORM EXECUTION OBSERVATION PORT (P2 item 6 / F3).
   *
   * IT ANSWERS `unknown`, AND THAT IS THE HONEST ANSWER. The dsh runtime's
   * public surface has no durable outcome read: `listChildren` reports a
   * child's live/inactive activity, and the dsh contract states explicitly that
   * activity neither encodes a durable outcome (a continuable child may be
   * inactive and still resumable). A run's `result` promise lives in the
   * process that started it, so after that process exits the outcome is not
   * readable from dsh at all. Rolebox therefore refuses to round "not resident"
   * into "finished": the boot sweep reports every confirmed execution it cannot
   * observe as an explicit `completion-unsettled` refusal and names it in
   * `awaitingCompletion`, which is the observable block the plan requires.
   */
  readonly observeExecution: HostExecutionObservationPort = (
    execution: HostExecutionIdentity,
  ) =>
    Object.freeze({
      kind: "unknown" as const,
      reason:
        "the dsh subagent runtime has no durable outcome read for execution " +
        JSON.stringify(execution.executionId) +
        " (a run's result lives in the process that started it, and the child listing's " +
        "activity does not encode an outcome), so whether it has ended cannot be established",
    });

  /**
   * THE PLATFORM COMPLETION WATCH PORT (F4) — unsupported on dsh.
   *
   * A dsh subagent run's terminal announcement is its `result` promise, held by
   * the process that called `start`. There is no durable subscription a
   * restarted process could re-establish — `ctx.subagents` exposes no "tell me
   * when this run ends" for a child this process did not start — so this port
   * says so, and the host REPORTS the executions it cannot keep observing
   * instead of pretending they are covered.
   */
  readonly watchCompletion: HostCompletionWatchPort = () => "unsupported";

  /**
   * The host dispatch adapter's `deliver`: start ONE dsh subagent run.
   *
   * Synchronous prefix, asynchronous tail. Everything that can refuse the
   * start without starting anything (no provider, no invoking session, no
   * resolvable live parent) throws HERE, so the host adapter un-records the
   * effect and the ledger row stays `pending` for the next recovery.
   */
  deliver = (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    invocation?: HostDispatchInvocation,
  ): void => {
    const agent = request.agent;
    if (this.opts.subagents.getProvider) {
      const provider = this.opts.subagents.getProvider(agent);
      if (!provider) {
        const known = this.opts.subagents.list?.() ?? [];
        throw new Error(
          "dsh outcome dispatch: no subagent provider registered for agent " +
            JSON.stringify(agent) +
            " (registered: " +
            (known.length > 0 ? known.join(", ") : "none") +
            ")",
        );
      }
    }
    const parentSessionId = invocation?.sessionId;
    if (parentSessionId === undefined || parentSessionId.length === 0) {
      throw new Error(
        "dsh outcome dispatch: no invoking session is in effect for graph " +
          JSON.stringify(request.graphId) +
          " — a dispatched attempt needs the live parent its subagent run is composed under",
      );
    }
    const parent = this.opts.parentResolver?.(parentSessionId);
    if (parent === undefined || parent === null) {
      throw new DshParentUnresolvedError(parentSessionId);
    }

    const controller = new AbortController();
    const startRequest: DshSubagentStartRequest = {
      // THE STABLE IDEMPOTENCY KEY IS THE CREATE CALL'S LABEL (P2 item 5). dsh
      // persists a run's label in the child's durable descriptor and
      // `listChildren` reads it back, so the key the platform stored is exactly
      // the string {@link DshOutcomeDelivery.executionQuery} asks for later —
      // `graphId + "/dispatch:" + attemptId`, derived by the one function both
      // sides use. (dsh does not DEDUPE on it: at-most-once remains the host's
      // fenced create right, and the label is the correlation, not the fence.)
      label: dispatchIdempotencyKeyOf(effect),
      prompt: [{ type: "text", text: buildAttemptDeliveryPrompt(request) }],
      parent,
      signal: controller.signal,
      sessionId: parentSessionId,
    };
    // The start itself is a promise; the delivery contract is synchronous. A
    // rejection is reported as a failed start (nothing was observed running).
    void Promise.resolve(this.opts.subagents.start(agent, startRequest)).then(
      (run) => {
        // The platform named the execution, so the host can record the fact it
        // created. Reported before the result is observed: a completion that
        // arrives immediately still finds a `created` row.
        this.opts.onStarted?.(request, effect, { executionId: run.id });
        void Promise.resolve(run.result).then(
          (result: DshSubagentResult) => {
            this.opts.onSettled(
              result.stopReason === "completed"
                ? { kind: "completed", request }
                : {
                    kind: "failed",
                    request,
                    reason:
                      "the dsh subagent run ended with stopReason " +
                      JSON.stringify(result.stopReason),
                  },
            );
          },
          (err: unknown) => {
            this.opts.onSettled({
              kind: "failed",
              request,
              reason: "the subagent run result rejected: " + errorText(err),
            });
          },
        );
      },
      (err: unknown) => {
        this.log.warn("dsh outcome dispatch: subagent start rejected", {
          graphId: request.graphId,
          attemptId: request.attemptId,
          error: errorText(err),
        });
        this.opts.onStartFailed(request, effect, errorText(err));
      },
    );
  };
}
