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
 *
 * THE PLATFORM PORTS (P2 part 2). The delivery also carries the three platform
 * answers the host layer asks for, all against the manager's own records:
 *
 * - {@link PiOutcomeDelivery.executionQuery} — the execution query (P2 item 5):
 *   the task's `description` IS the stable key
 *   (`graphId + "/dispatch:" + attemptId`), the manager persists it with the
 *   task and restores it at boot, so a restart correlates the effect with the
 *   SAME task. A task it does not hold answers `unknown` — never `absent`,
 *   because a cleaned-up or unrecovered record is not proof of non-existence;
 * - {@link PiOutcomeDelivery.observeExecution} — the terminal-state read (P2
 *   item 6): the task's status, with `completed` separated from the ends that
 *   are NOT completions (`error`, `cancelled`, `timeout` — reported, never
 *   settled as a success);
 * - {@link PiOutcomeDelivery.watchCompletion} — the re-subscribe half (F4):
 *   `DispatchManager.onTaskTerminated`, which fires immediately for a task that
 *   is already terminal, so a restarted process both re-establishes the
 *   announcement and receives the end it missed.
 */

import type {
  OutcomeDispatchEffectKey,
  OutcomeDispatchRequest,
  OutcomeExecutionLookup,
  OutcomeExecutionProbe,
  OutcomeExecutionQuery,
} from "../../../graph/outcome/dispatch-effects.ts";
import { dispatchIdempotencyKeyOf } from "../../../graph/outcome/dispatch-effects.ts";
import type { DispatchInput, DispatchTask } from "../../../dispatch/types.ts";
import { buildAttemptDeliveryPrompt } from "../../../graph/host/delivery.ts";
import type { HostDispatchInvocation } from "../../../graph/host/dispatch-host.ts";
import type { HostExecutionIdentity } from "../../../graph/host/execution-index.ts";
import type {
  HostCompletionWatchPort,
  HostExecutionObservationPort,
} from "../../../graph/host/outcome-host.ts";
import { createSubLogger } from "../../../logger.ts";
import { errorText } from "../../../utils/error-text.ts";

/** One `unknown` execution answer, with the platform's own reason. */
function unknownAnswer(reason: string): OutcomeExecutionLookup {
  return Object.freeze({ kind: "unknown" as const, reason });
}

/**
 * Dispatch statuses that END an execution (the manager's own terminal set,
 * `src/dispatch/core/manager.ts` `TERMINAL_STATUSES` plus the async-dispatch
 * `awaiting_approval` pause, which is NOT an end).
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>([
  "completed",
  "error",
  "cancelled",
  "timeout",
]);

/** A terminal status that is a COMPLETION, as opposed to an end that is not. */
const COMPLETION_STATUSES: ReadonlySet<string> = new Set<string>(["completed"]);

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
  /**
   * One task's current record (`DispatchManager.getTask`). Optional on this
   * port because the delivery seam does not need it; the observation and watch
   * ports answer `unknown`/`"unsupported"` when it is absent, which is the
   * honest degradation for a manager that cannot be read.
   */
  getTask?(taskId: string): DispatchTask | undefined;
  /**
   * Every task the manager currently holds (`DispatchManager.getAllTasks`).
   *
   * THE CORRELATION SOURCE AFTER A RESTART. The manager restores its task
   * records from its own persisted state, but it does NOT rebuild the
   * per-parent index (`parentTasksIndex`) on recovery — `addToParentIndex` runs
   * at launch only, and `restoreState` repopulates `tasks` alone — so
   * `getTasksByParent` is empty in a process that recovered rather than
   * launched. Reading the whole (restored) registry and matching the stable
   * key is what makes the query work in BOTH processes.
   */
  getAllTasks?(): DispatchTask[];
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

  /**
   * THE PLATFORM EXECUTION QUERY PORT (P2 item 5 / F3).
   *
   * Pi's dispatch manager keeps a task record per dispatched worker, restored
   * from its own persisted state at boot, so the correlation question can be
   * answered SYNCHRONOUSLY — no priming phase is needed for this platform. The
   * probe's stable key ({@link dispatchIdempotencyKeyOf}) is the string the
   * create call carried as the task's `description`, and the manager's own
   * records are the only place the answer comes from.
   *
   * WHAT IT ANSWERS, AND WHAT IT REFUSES TO. Exactly one task carrying the key
   * IS the execution: `created`, naming the task id (the dispatch task IS the
   * execution on Pi, so `executionId` and `taskId` are the same value). Two
   * tasks carrying it are AMBIGUOUS; no task — and a manager whose task TTL has
   * already cleaned the record, or whose recovery could not read its store —
   * answers `unknown`. It NEVER answers `absent`: a task the manager does not
   * hold is not a proof that no execution exists, and only a proof may release a
   * create right.
   */
  readonly executionQuery: OutcomeExecutionQuery = Object.freeze({
    lookup: (probe: OutcomeExecutionProbe): OutcomeExecutionLookup => {
      const allTasks = this.opts.manager.getAllTasks;
      if (allTasks === undefined) {
        return unknownAnswer(
          "this Pi dispatch port exposes no task listing, so a dispatch task cannot be " +
            "correlated with the effect that created it",
        );
      }
      const key = dispatchIdempotencyKeyOf(probe.effect);
      let tasks: readonly DispatchTask[];
      try {
        tasks = allTasks.call(this.opts.manager);
      } catch (error) {
        return unknownAnswer(
          "the Pi dispatch manager's task listing failed (" +
            errorText(error) +
            "), so whether an execution exists for effect " +
            JSON.stringify(probe.effect.effectId) +
            " cannot be established",
        );
      }
      const matches = tasks.filter((task) => task.description === key);
      if (matches.length === 1) {
        const task = matches[0];
        if (task !== undefined) {
          return Object.freeze({
            kind: "created" as const,
            execution: Object.freeze({ executionId: task.id, taskId: task.id }),
          });
        }
      }
      if (matches.length > 1) {
        return unknownAnswer(
          "more than one dispatch task carries the stable key " +
            JSON.stringify(key) +
            " — an ambiguous correlation cannot say which execution belongs to effect " +
            JSON.stringify(probe.effect.effectId),
        );
      }
      return unknownAnswer(
        "the Pi dispatch manager holds no task carrying the stable key " +
          JSON.stringify(key) +
          " — a task it already cleaned up after its TTL, or one its recovery could not " +
          "read, is not evidence of absence, so the effect stays blocked",
      );
    },
  });

  /**
   * THE PLATFORM EXECUTION OBSERVATION PORT (P2 item 6 / F3).
   *
   * The manager's own task record IS the platform's answer: `completed` is a
   * completion fact; `error`/`cancelled`/`timeout` are ENDS that are NOT
   * completions and are reported as such (plan §3.4: a failed run is never
   * settled as a successful outcome); a task still `pending`/`running`/
   * `awaiting_approval` is running; a task the manager does not hold — including
   * one its TTL cleanup already removed — is `unknown`, never rounded into an
   * end.
   */
  readonly observeExecution: HostExecutionObservationPort = (
    execution: HostExecutionIdentity,
  ) => {
    const getTask = this.opts.manager.getTask;
    const taskId = execution.taskId ?? execution.executionId;
    if (getTask === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "this Pi dispatch port exposes no per-task read, so the state of dispatch task " +
          JSON.stringify(taskId) +
          " cannot be established",
      });
    }
    let task: DispatchTask | undefined;
    try {
      task = getTask.call(this.opts.manager, taskId);
    } catch (error) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the Pi dispatch manager's task read failed (" +
          errorText(error) +
          "), so the state of dispatch task " +
          JSON.stringify(taskId) +
          " cannot be established",
      });
    }
    if (task === undefined) {
      return Object.freeze({
        kind: "unknown" as const,
        reason:
          "the Pi dispatch manager holds no record of dispatch task " +
          JSON.stringify(taskId) +
          " (it may have been cleaned up after its TTL, or lost by a failed recovery), " +
          "so whether it has ended cannot be established",
      });
    }
    if (!TERMINAL_STATUSES.has(task.status)) {
      return Object.freeze({ kind: "running" as const });
    }
    if (COMPLETION_STATUSES.has(task.status)) {
      return Object.freeze({ kind: "completed" as const });
    }
    return Object.freeze({
      kind: "failed" as const,
      reason:
        "the Pi dispatch task ended with status " +
        JSON.stringify(task.status) +
        (task.error === undefined || task.error.length === 0
          ? ""
          : " (" + task.error + ")"),
    });
  };

  /**
   * THE PLATFORM COMPLETION WATCH PORT (F4).
   *
   * `DispatchManager.onTaskTerminated` IS the platform's durable announcement
   * channel: it is keyed by task id, it fires once, and it fires IMMEDIATELY
   * (via microtask) for a task that is already terminal — so re-subscribing
   * after a restart both re-establishes the live notification and delivers the
   * end that already happened. THE ANNOUNCEMENT IS NOT AN OUTCOME and this port
   * does not pretend it is: it tells the host to look again, and the host
   * VERIFIES the end against {@link PiOutcomeDelivery.observeExecution} — the
   * manager's own task record the announcement was written to — so only a
   * `completed` read is settled, through the one completion bridge. An
   * `error`/`cancelled`/`timeout` announcement is reported as an unsettled
   * attempt, exactly as the sweep's own `failed` branch reports it.
   *
   * A task the manager cannot name is NOT watchable — the manager's listener
   * registration is silently a no-op for an unknown id — so that answers
   * `"unsupported"` and the host reports the execution as unwatched rather than
   * waiting on a callback that can never come.
   */
  readonly watchCompletion: HostCompletionWatchPort = (entry, onEnded) => {
    const taskId = entry.taskId ?? entry.executionId;
    const getTask = this.opts.manager.getTask;
    if (getTask === undefined) return "unsupported";
    let known: DispatchTask | undefined;
    try {
      known = getTask.call(this.opts.manager, taskId);
    } catch {
      return "unsupported";
    }
    if (known === undefined) return "unsupported";
    this.opts.manager.onTaskTerminated(taskId, () => onEnded());
    return "watching";
  };

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
        // THE STABLE IDEMPOTENCY KEY IS THE TASK DESCRIPTION (P2 item 5). The
        // manager persists a task's description with its record and recovers it
        // at boot, so the key the platform stored is exactly the string
        // {@link PiOutcomeDelivery.executionQuery} matches on later —
        // `graphId + "/dispatch:" + attemptId`, derived by the one function both
        // sides use. (Pi does not DEDUPE on it: at-most-once remains the host's
        // fenced create right, and the description is the correlation, not the
        // fence.)
        description: dispatchIdempotencyKeyOf(effect),
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

