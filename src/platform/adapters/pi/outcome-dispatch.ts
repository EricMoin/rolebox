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
 *   records;
 * - the invocation the task is launched under arrives WITH the delivery (the
 *   host's third argument: the graph's declaring invocation, recorded by the
 *   host and re-supplied on every window that arms a dispatch). The adapter
 *   keeps no session state of its own, so a successor armed by an out-of-band
 *   completion is launched under the same parent as the entry attempt, and a
 *   delivery whose host knows no invocation is refused by name instead of
 *   being attributed to whatever call happens to be running.
 *
 * The task carries NO notification-suppression marker: the deleted legacy
 * graph engine turned off the dispatch manager's parent notification because
 * its own notifier reported node completion, and the outcome run path has no
 * such notifier, so the manager's normal completion notice stays the
 * orchestrator's visibility into a finished attempt.
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
} from "../../../graph/outcome/dispatch-effects.ts";
import type { DispatchInput, DispatchTask } from "../../../dispatch/types.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import type { HostDispatchInvocation } from "../../../graph/host/dispatch-host.ts";
import type { HostExecutionIdentity } from "../../../graph/host/execution-index.ts";
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
    parentContext: { sessionID: string; agent: string; directory: string },
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
  /**
   * Reports the dispatch task the platform actually created, as soon as its id
   * is known. This is the host fact that turns the execution registry's
   * `creating` row into `created`; a host that omits it leaves the effect
   * `unknown` after a restart — reported as unsettled, never re-dispatched.
   */
  readonly onStarted?: (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    execution: HostExecutionIdentity,
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

/**
 * The Pi delivery seam, one per host process, and STATELESS about invocations:
 * the session a task is launched under arrives with each delivery as the host's
 * own attribution of the graph's declaring invocation.
 */
export class PiOutcomeDelivery {
  private readonly log;
  /** request per launched task id, so a terminal callback can name the attempt. */
  private readonly attempts = new Map<string, OutcomeDispatchRequest>();

  constructor(private readonly opts: PiOutcomeDeliveryOptions) {
    this.log = createSubLogger(opts.loggerName ?? "pi-outcome-dispatch");
  }

  deliver = (
    request: OutcomeDispatchRequest,
    effect: OutcomeDispatchEffectKey,
    invocation?: HostDispatchInvocation,
  ): void => {
    const parentSessionId = invocation?.sessionId;
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
        agent: invocation?.agent ?? "",
        directory: this.opts.directory,
      },
    );
    void Promise.resolve(launched).then(
      (task) => {
        this.attempts.set(task.id, request);
        // The platform named the task, so the host can record the execution it
        // created; the terminal callback below may then settle against a
        // `created` row instead of an unknown one.
        this.opts.onStarted?.(request, effect, {
          executionId: task.id,
          taskId: task.id,
        });
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

