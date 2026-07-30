import type { DispatchInput, DispatchTask, MaterializedResultRef } from "../types.ts";
import type { IConcurrencyManager } from "../concurrency/concurrency.ts";

export type { TaskLifecycleDeps } from "./lifecycle-shared.ts";
import type { TaskLifecycleDeps } from "./lifecycle-shared.ts";

import { getInflightCount, computeDepth, getRequestSessions, leaveRunning } from "./lifecycle-shared.ts";
import { launch as launcherLaunch, reopenForContinuation as launcherReopen } from "./task-launcher.ts";
import { executeSync as syncExecute } from "./sync-executor.ts";
import { cancelTask as cancellationCancel } from "./task-cancellation.ts";
import { getResult as materializerGetResult, materializeResult as materializerMaterialize, materializeAndNotify as materializerNotify } from "../completion/result-materializer.ts";
import {
  evaluateAndComplete as evaluatorEvaluate,
  handleSessionIdle as evaluatorHandleIdle,
  handleSessionStatus as evaluatorHandleStatus,
  handleMessageUpdated as evaluatorHandleMsg,
  handleSessionError as evaluatorHandleErrEvent,
  handleSessionDeleted as evaluatorHandleDeleted,
  handleTaskCompleted as evaluatorHandleCompleted,
  handleTaskError as evaluatorHandleTaskErr,
  handleTaskTimeout as evaluatorHandleTimeout,
} from "../completion/completion-evaluator.ts";

/**
 * Bridge interface for methods accessed by DispatchManager via `(this.lifecycle as any)`.
 */
export interface LifecycleBridge {
  handleTaskCompleted(taskId: string): Promise<void>;
  handleTaskError(taskId: string, error: string): void;
  handleTaskTimeout(taskId: string, reason: string): void;
  materializeResult(taskId: string): Promise<MaterializedResultRef>;
  materializeAndNotify(taskId: string): Promise<void>;
  computeDepth(parentSessionId: string): number;
  getRequestSessions(rootSession: string): number;
  setConcurrencyManager(manager: IConcurrencyManager): void;
  setDirectory(directory: string): void;
}

/** Thin facade that delegates to focused sub-modules. */
export class TaskLifecycleManager implements LifecycleBridge {
  private d: TaskLifecycleDeps;

  constructor(deps: TaskLifecycleDeps) {
    this.d = deps;
  }

  async launch(input: DispatchInput, parentContext: { sessionID: string; agent: string; directory: string }): Promise<DispatchTask> {
    return launcherLaunch(this.d, input, parentContext);
  }

  async executeSync(input: DispatchInput, parentContext: { sessionID: string; agent: string; directory: string }): Promise<string> {
    return syncExecute(this.d, input, parentContext);
  }

  async reopenForContinuation(taskId: string, input: DispatchInput, parentContext: { sessionID: string; agent: string; directory: string }): Promise<DispatchTask> {
    return launcherReopen(this.d, taskId, input, parentContext);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    return cancellationCancel(this.d, taskId);
  }

  async getResult(taskId: string): Promise<{ kind: "ok" | "expired" | "not_found" | "fetch_error"; text: string; resultText: string; hadFence: boolean; totalChars: number; error?: string }> {
    return materializerGetResult(this.d, taskId);
  }

  getInflightCount(parentSessionId: string): number {
    return getInflightCount(this.d, parentSessionId);
  }

  computeDepth(parentSessionId: string): number {
    return computeDepth(this.d, parentSessionId);
  }

  getRequestSessions(rootSession: string): number {
    return getRequestSessions(this.d, rootSession);
  }

  async evaluateAndComplete(taskId: string, trigger: "idle-debounce" | "watchdog-reconcile" | "global-sweep" | "error-event" | "deleted-event", errorDetail?: string): Promise<void> {
    return evaluatorEvaluate(this.d, taskId, trigger, errorDetail);
  }

  async handleSessionIdle(sessionId: string): Promise<void> {
    return evaluatorHandleIdle(this.d, sessionId);
  }

  handleSessionStatus(sessionId: string, statusType: string): Promise<void> {
    return evaluatorHandleStatus(this.d, sessionId, statusType);
  }

  handleMessageUpdated(sessionId: string): void {
    return evaluatorHandleMsg(this.d, sessionId);
  }

  async handleSessionError(sessionId: string, error: unknown): Promise<void> {
    return evaluatorHandleErrEvent(this.d, sessionId, error);
  }

  async handleSessionDeleted(sessionId: string): Promise<void> {
    return evaluatorHandleDeleted(this.d, sessionId);
  }

  async handleTaskCompleted(taskId: string): Promise<void> {
    return evaluatorHandleCompleted(this.d, taskId);
  }
  handleTaskError(taskId: string, error: string): void {
    return evaluatorHandleTaskErr(this.d, taskId, error);
  }

  handleTaskTimeout(taskId: string, reason: string): void {
    return evaluatorHandleTimeout(this.d, taskId, reason);
  }

  async materializeResult(taskId: string): Promise<MaterializedResultRef> {
    return materializerMaterialize(this.d, taskId);
  }

  async materializeAndNotify(taskId: string): Promise<void> {
    return materializerNotify(this.d, taskId);
  }

  leaveRunning(taskId: string): void {
    return leaveRunning(this.d, taskId);
  }

  setConcurrencyManager(manager: IConcurrencyManager): void {
    this.d.concurrency = manager;
  }

  setDirectory(directory: string): void {
    this.d.directory = directory;
  }
}
