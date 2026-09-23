/**
 * Pi platform — the OUTCOME run path's dispatch delivery
 *
 * Version: 1.0
 * Date: 2026-09-23
 *
 * THE PLATFORM HALF OF THE HOST DISPATCH ADAPTER for the Pi entry. The outcome
 * runtime commits a dispatch effect and calls the host's `create(request,
 * effect)`; this module delivers that request to the Pi dispatch manager:
 *
 * - `manager.launch(input, parentContext)` starts one background task for the
 *   plan's agent, with the plan's own prompt plus the attempt handoff
 *   (`src/graph/host/delivery.ts`) — the one channel the bearer credential
 *   travels over;
 * - the task's terminal transition is observed through
 *   `manager.onTaskTerminated`: `completed` is a natural completion, every
 *   other status is REPORTED as a failed attempt (no completion to fabricate);
 * - a launch that rejects before any task exists is reported with the stable
 *   effect key through `onStartFailed`, so the host drops the execution-index
 *   record — the same "the execution did not start" fact a synchronous throw
 *   records.
 *
 * The task is deliberately NOT marked `graphScoped`: the legacy graph engine
 * suppressed the dispatch manager's parent notification because its own graph
 * notifier reported node completion, and the outcome run path has no such
 * notifier, so the manager's normal completion notice stays the orchestrator's
 * visibility into a finished attempt.
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../../graph/outcome/dispatch-effects.ts";
import type { DispatchInput, DispatchTask } from "../../../dispatch/types.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";

/** What the platform observed about one attempt. */
export type PiOutcomeSettlement =
  | { readonly kind: "completed"; readonly request: OutcomeDispatchRequest }
  | {
      readonly kind: "failed";
      readonly request: OutcomeDispatchRequest;
      readonly reason: string;
    };

/**
 * The Pi dispatch port this delivery needs: start one background task and be
 * told when it reaches a terminal status. The real `DispatchManager`
 * satisfies it structurally, so the adapter is testable without one.
 */
export interface PiOutcomeDispatchPort {
  launch(
    input: DispatchInput,
    parentContext: {
      sessionID: string;
      agent: string;
      directory: string;
      graphScoped?: boolean;
    },
  ): Promise<DispatchTask>;
  onTaskTerminated(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): unknown;
}

export interface PiOutcomeDeliveryOptions {
  /** The Pi dispatch port that starts and tracks the worker task. */
  readonly manager: PiOutcomeDispatchPort;
  /** Reports one attempt's terminal observation (completion or failure). */
  readonly onSettled: (settlement: PiOutcomeSettlement) => void;
  /** Reports a launch that failed asynchronously, with its stable effect key. */
  readonly onStartFailed: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    reason: string,
  ) => void;
  /** The workspace directory dispatched tasks run against. */
  readonly directory: string;
  /** Optional logger name override. */
  readonly loggerName?: string;
}

/** Terminal dispatch statuses that are NOT a natural completion. */
const NON_COMPLETION_STATUSES: ReadonlySet<string> = new Set<string>([
  "error",
  "cancelled",
  "timeout",
]);

/** The Pi delivery seam, one per host process. */
export class PiOutcomeDelivery {
  private readonly log;
  private parentSessionId: string | undefined;
  private parentAgent: string | undefined;
  /** request per launched task id, so a terminal callback can name the attempt. */
  private readonly attempts = new Map<string, OutcomeDispatchRequest>();

  constructor(private readonly opts: PiOutcomeDeliveryOptions) {
    this.log = createSubLogger(opts.loggerName ?? "pi-outcome-dispatch");
  }

  /**
   * Name the invocation a graph's attempts belong to. Set by the host before it
   * resumes (or first-executes) a declared graph and cleared after; the
   * dispatch happens inside that window.
   */
  setInvocation(sessionId: string | undefined, agent: string | undefined): void {
    this.parentSessionId = sessionId;
    this.parentAgent = agent;
  }

  deliver = (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
  ): void => {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === undefined || parentSessionId.length === 0) {
      throw new Error(
        "Pi outcome dispatch: no invoking session is in effect for graph " +
          JSON.stringify(request.graphId) +
          " — a dispatched attempt needs the session its task is launched under",
      );
    }
    const launched = this.opts.manager.launch(
      {
        subagent: request.agent,
        prompt: buildAttemptDeliveryPrompt(request),
        run_in_background: true,
        description:
          request.graphId + ":" + request.nodeId + "#" + request.attemptId,
      },
      {
        sessionID: parentSessionId,
        agent: this.parentAgent ?? "",
        directory: this.opts.directory,
      },
    );
    void Promise.resolve(launched).then(
      (task) => {
        this.attempts.set(task.id, request);
        this.opts.manager.onTaskTerminated(task.id, (taskId, status) => {
          const observed = this.attempts.get(taskId);
          this.attempts.delete(taskId);
          if (observed === undefined) return;
          this.opts.onSettled(
            status === "completed"
              ? { kind: "completed", request: observed }
              : {
                  kind: "failed",
                  request: observed,
                  reason:
                    "the Pi dispatch task ended with status " +
                    JSON.stringify(status) +
                    (NON_COMPLETION_STATUSES.has(status) ? "" : " (not a completion)"),
                },
          );
        });
      },
      (err: unknown) => {
        this.log.warn("Pi outcome dispatch: launch rejected", {
          graphId: request.graphId,
          attemptId: request.attemptId,
          error: errorText(err),
        });
        this.opts.onStartFailed(request, effect, errorText(err));
      },
    );
  };
}

