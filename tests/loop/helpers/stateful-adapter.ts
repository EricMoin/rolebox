/**
 * Stateful fake IDispatchAdapter for loop coordinator tests.
 *
 * A realistic, stateful stand-in for the real `DispatchAdapter` (which drives
 * DispatchManager + ISessionClient). Unlike a stateless mock, it tracks every
 * dispatched round, every task's lifecycle status, and its terminated-listener
 * registrations — so tests can drive a loop end-to-end exactly the way the
 * production push chain does:
 *
 *   1. dispatchRound allocates distinct `task-N` / `session-N` ids (incrementing
 *      per call) and records them in `dispatchedTasks` / `dispatchedSessions`.
 *   2. The coordinator registers a fire-once terminated listener per task id;
 *      registration NEVER fires the callback (matching DispatchManager).
 *   3. `completeTask(taskId)` simulates DispatchManager.onTaskTerminated:
 *      marks the task `completed` and invokes its stored listener on a
 *      `setTimeout(0)` tick with status `"completed"` — the listener entry is
 *      then removed (fire-once semantics).
 *   4. `failTask(taskId, reason)` does NOT fire the listener — it only records
 *      the failure so a subsequent `getRoundResult` reports `hadError: true`
 *      with that reason (and `getTaskStatus` reports `error`). Drive
 *      `onWorkerCompleted` directly to advance the coordinator's push chain.
 *   5. `getRoundResult` returns per-task distinct text `Result for task-N`;
 *      `readOriginSummary` returns incrementing `Summary for round N`;
 *      `getLastMessageId` returns incrementing `msg-N`.
 *   6. Every adapter method invocation is appended to `calls` (method + args)
 *      so tests can assert call order, argument values, and counts.
 *
 * Usage:
 *   const { adapter, calls, dispatchedTasks, completeTask } =
 *     createStatefulAdapter();
 *   const c = new LoopCoordinator(adapter);
 *   c.register({ originSessionId: "origin-1", agent: "a", prompt: "p",
 *                mode: "inherit", iterations: 2 });
 *   await settle();                    // self-start kickoff dispatches round 1
 *   expect(dispatchedTasks).toEqual(["task-1"]);
 *   completeTask("task-1");            // fires the registered listener
 *   await settle();                    // push chain advances to round 2
 *   expect(c.getLoopState("origin-1")!.current).toBe(2);
 *
 * `settle` lets chained setTimeout-driven completions drain (alias of the
 * microtask flush used by coordinator.test.ts).
 */

import type { IDispatchAdapter } from "../../../src/loop/dispatch-adapter";

/** Adapter methods that can appear in the calls log. */
export type StatefulAdapterMethod =
  | "dispatchRound"
  | "getRoundResult"
  | "cancelRound"
  | "readOriginSummary"
  | "getLastMessageId"
  | "injectNote"
  | "registerTerminatedListener"
  | "removeTerminatedListener"
  | "getTaskStatus";

/** One recorded adapter invocation: which method, with which arguments. */
export interface StatefulAdapterCall {
  method: StatefulAdapterMethod;
  args: unknown[];
}

/** Everything a test needs to drive and assert a stateful fake loop. */
export interface StatefulAdapterBundle {
  adapter: IDispatchAdapter;
  /** Every adapter method invocation, in call order. */
  calls: StatefulAdapterCall[];
  /** workerTaskId for each dispatchRound call, in order (`task-1`, `task-2`, …). */
  dispatchedTasks: string[];
  /** workerSessionId for each dispatchRound call, in order (`session-1`, …). */
  dispatchedSessions: string[];
  /** Mark a dispatched task completed and fire its fire-once terminated listener. */
  completeTask: (taskId: string) => void;
  /** Record a failure for a task so getRoundResult reports hadError:true. */
  failTask: (taskId: string, reason: string) => void;
}

/**
 * Create a fresh stateful fake adapter plus its control surface.
 * Each call returns an independent instance (isolated state per test).
 */
export function createStatefulAdapter(): StatefulAdapterBundle {
  const calls: StatefulAdapterCall[] = [];
  const dispatchedTasks: string[] = [];
  const dispatchedSessions: string[] = [];
  /** taskId → current lifecycle status (running/completed/error/cancelled). */
  const taskStatuses = new Map<string, string>();
  /** taskId → fire-once terminated callback registered by the coordinator. */
  const terminatedListeners = new Map<string, (taskId: string, status: string) => void>();
  /** taskId → failure reason recorded via failTask. */
  const failedTasks = new Map<string, string>();

  let taskSeq = 0;
  let msgSeq = 0;
  let summarySeq = 0;

  function completeTask(taskId: string): void {
    if (!taskStatuses.has(taskId)) {
      throw new Error(`stateful-adapter: unknown task "${taskId}" — dispatch it before completing`);
    }
    taskStatuses.set(taskId, "completed");
    const cb = terminatedListeners.get(taskId);
    if (cb) {
      // Fire-once: remove before firing, exactly like DispatchManager's
      // onTaskTerminated registry auto-removes after invocation.
      terminatedListeners.delete(taskId);
      // Async delivery, mimicking the real terminated-event path.
      setTimeout(() => cb(taskId, "completed"), 0);
    }
  }

  function failTask(taskId: string, reason: string): void {
    if (!taskStatuses.has(taskId)) {
      throw new Error(`stateful-adapter: unknown task "${taskId}" — dispatch it before failing`);
    }
    taskStatuses.set(taskId, "error");
    failedTasks.set(taskId, reason);
  }

  const adapter: IDispatchAdapter = {
    async dispatchRound(input: {
      originSessionId: string;
      agent: string;
      prompt: string;
      description?: string;
      timeoutMs?: number;
    }): Promise<{ workerTaskId: string; workerSessionId: string }> {
      calls.push({ method: "dispatchRound", args: [input] });
      taskSeq += 1;
      const workerTaskId = `task-${taskSeq}`;
      const workerSessionId = `session-${taskSeq}`;
      dispatchedTasks.push(workerTaskId);
      dispatchedSessions.push(workerSessionId);
      taskStatuses.set(workerTaskId, "running");
      return { workerTaskId, workerSessionId };
    },

    async getRoundResult(
      workerTaskId: string,
    ): Promise<{ text: string; hadError: boolean; errorReason?: string }> {
      calls.push({ method: "getRoundResult", args: [workerTaskId] });
      if (!taskStatuses.has(workerTaskId)) {
        // Mirrors DispatchManager.getResult for an unknown task (not_found).
        return { text: "", hadError: true, errorReason: `unknown task: ${workerTaskId}` };
      }
      const failureReason = failedTasks.get(workerTaskId);
      if (failureReason !== undefined) {
        return { text: "", hadError: true, errorReason: failureReason };
      }
      return { text: `Result for ${workerTaskId}`, hadError: false };
    },

    async cancelRound(workerTaskId: string): Promise<void> {
      calls.push({ method: "cancelRound", args: [workerTaskId] });
      if (taskStatuses.has(workerTaskId)) {
        taskStatuses.set(workerTaskId, "cancelled");
      }
    },

    async readOriginSummary(
      _originSessionId: string,
      sinceMessageId?: string,
    ): Promise<string> {
      calls.push({ method: "readOriginSummary", args: [_originSessionId, sinceMessageId] });
      summarySeq += 1;
      return `Summary for round ${summarySeq}`;
    },

    async getLastMessageId(_originSessionId: string): Promise<string | undefined> {
      calls.push({ method: "getLastMessageId", args: [_originSessionId] });
      msgSeq += 1;
      return `msg-${msgSeq}`;
    },

    async injectNote(sessionId: string, text: string): Promise<void> {
      calls.push({ method: "injectNote", args: [sessionId, text] });
    },

    registerTerminatedListener(
      taskId: string,
      callback: (taskId: string, status: string) => void,
    ): (taskId: string, status: string) => void {
      calls.push({ method: "registerTerminatedListener", args: [taskId, callback] });
      // Store only — never fire at registration (matches DispatchManager).
      terminatedListeners.set(taskId, callback);
      // Return the SAME callback so the coordinator's removeTerminatedListener
      // call later matches the stored reference.
      return callback;
    },

    removeTerminatedListener(
      taskId: string,
      callback: (taskId: string, status: string) => void,
    ): void {
      calls.push({ method: "removeTerminatedListener", args: [taskId, callback] });
      if (terminatedListeners.get(taskId) === callback) {
        terminatedListeners.delete(taskId);
      }
    },

    async getTaskStatus(taskId: string): Promise<string | undefined> {
      calls.push({ method: "getTaskStatus", args: [taskId] });
      return taskStatuses.get(taskId);
    },
  };

  return { adapter, calls, dispatchedTasks, dispatchedSessions, completeTask, failTask };
}

/** Let chained setTimeout-driven listener deliveries drain. */
export const settle = () => new Promise((r) => setTimeout(r, 0));
