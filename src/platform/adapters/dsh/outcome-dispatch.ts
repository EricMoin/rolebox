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
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../../graph/outcome/dispatch-effects.ts";
import type {
  DshSubagentDispatchRuntime,
  DshSubagentResult,
} from "./dispatch.ts";
import { DshParentUnresolvedError } from "./dispatch.ts";
import type { DshSubagentStartRequest } from "./agent-registrar.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";

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
  readonly subagents: DshSubagentDispatchRuntime;
  /**
   * Resolve the live parent `Agent` for the graph's invoking session, exactly
   * as the legacy dsh dispatch path did (probe `ctx.agents`).
   */
  readonly parentResolver?: (sessionId: string) => unknown;
  /** Reports one attempt's terminal observation (completion or failure). */
  readonly onSettled: (settlement: DshOutcomeSettlement) => void;
  /**
   * Reports a start that failed asynchronously, with the stable effect key so
   * the host can drop the execution-index record it took before delivery.
   */
  readonly onStartFailed: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    reason: string,
  ) => void;
  /** Optional logger name override. */
  readonly loggerName?: string;
}

/**
 * The dsh delivery seam. One instance per host process; `setParentSession`
 * names the session a resume's dispatches belong to (the graph's declaring
 * invocation) before the host enters the synchronous dispatch window.
 */
export class DshOutcomeDelivery {
  private readonly log;
  private parentSessionId: string | undefined;

  constructor(private readonly opts: DshOutcomeDeliveryOptions) {
    this.log = createSubLogger(opts.loggerName ?? "dsh-outcome-dispatch");
  }

  /**
   * Name the session whose subagents this graph's attempts run under. Set by
   * the host immediately before it resumes (or first-executes) a declared
   * graph and cleared after; the dispatch happens inside that window.
   */
  setParentSession(sessionId: string | undefined): void {
    this.parentSessionId = sessionId;
  }

  /**
   * The host dispatch adapter's `deliver`: start ONE dsh subagent run.
   *
   * Synchronous prefix, asynchronous tail. Everything that can refuse the
   * start without starting anything (no provider, no parent session, no
   * resolvable live parent) throws HERE, so the host adapter un-records the
   * effect and the ledger row stays `pending` for the next recovery.
   */
  deliver = (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
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
    const parentSessionId = this.parentSessionId;
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
      label: request.graphId + ":" + request.nodeId + "#" + request.attemptId,
      prompt: [{ type: "text", text: buildAttemptDeliveryPrompt(request) }],
      parent,
      signal: controller.signal,
      sessionId: parentSessionId,
    };
    // The start itself is a promise; the delivery contract is synchronous. A
    // rejection is reported as a failed start (nothing was observed running).
    void Promise.resolve(this.opts.subagents.start(agent, startRequest)).then(
      (run) => {
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
