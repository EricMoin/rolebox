import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchManagerConfig } from "./config.js";
import type { CompletionSignal, SessionMessageSnapshot, TaskPollState } from "./types.js";
import { detectCompletion } from "./completion-detector.js";
import { SessionMonitor } from "./session-monitor.js";
import {
  MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, DEFAULT_MAX_CONCURRENT,
  MIN_STABILITY_POLLS, MESSAGE_STALENESS_TIMEOUT_MS, SESSION_GONE_TIMEOUT_MS,
} from "./config.js";

export interface GlobalPollerDeps {
  completionDetector: typeof detectCompletion;
  sessionMonitor: SessionMonitor;
  onTaskCompleted: (taskId: string) => void;
  onTaskError: (taskId: string, error: string) => void;
  onTaskTimeout: (taskId: string, reason: string) => void;
}

interface RegisteredTask {
  sessionId: string; pollState: TaskPollState; registeredAt: number;
}

function createPollState(): TaskPollState {
  return {
    consecutiveMissedPolls: 0, stableIdlePolls: 0, lastMessageCount: 0,
    lastProgressUpdate: Date.now(), hasProducedOutput: false,
  };
}

function statusKey(type: string, statusType: string | undefined): string {
  return `${type}:${statusType ?? "none"}`;
}

export class GlobalPoller {
  private client: OpencodeClient;
  private config: DispatchManagerConfig;
  private deps: GlobalPollerDeps;
  private tasks = new Map<string, RegisteredTask>();
  private isRunningFlag = false;
  private isPolling = false;
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  private _intervalMs = MAX_POLL_INTERVAL_MS;
  private _prevStatusKey = new Map<string, string>();

  constructor(
    client: OpencodeClient, config: DispatchManagerConfig, deps: GlobalPollerDeps,
  ) { this.client = client; this.config = config; this.deps = deps; }

  registerTask(taskId: string, sessionId: string): void {
    if (this.tasks.has(taskId)) return;
    this.tasks.set(taskId, { sessionId, pollState: createPollState(), registeredAt: Date.now() });
    if (!this.isRunningFlag) this.start();
  }

  unregisterTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.deps.sessionMonitor.clearTask(taskId);
    this._prevStatusKey.delete(taskId);
    if (this.tasks.size === 0) this.stop();
  }

  getTaskCount(): number { return this.tasks.size; }
  isRunning(): boolean { return this.isRunningFlag; }

  /** Run one poll cycle (exposed for deterministic testing). */
  pollCycle(): Promise<void> { return this._pollCycle(); }

  /** Get a task's poll state for inspection (returns undefined if not registered). */
  getTaskPollState(taskId: string): (TaskPollState & { registeredAt: number }) | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    return { ...t.pollState, registeredAt: t.registeredAt };
  }

  /** Override a task's internal timing for testing timeout scenarios. */
  setTaskTiming(taskId: string, overrides: { registeredAt?: number; lastProgressUpdate?: number; hasProducedOutput?: boolean }): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (overrides.registeredAt !== undefined) t.registeredAt = overrides.registeredAt;
    if (overrides.lastProgressUpdate !== undefined) t.pollState.lastProgressUpdate = overrides.lastProgressUpdate;
    if (overrides.hasProducedOutput !== undefined) t.pollState.hasProducedOutput = overrides.hasProducedOutput;
  }

  /** Reset a task's lastMessageCount to force re-fetch on next cycle (for testing). */
  resetMessageCount(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) t.pollState.lastMessageCount = 0;
  }

  start(): void {
    if (this.isRunningFlag) return;
    this.isRunningFlag = true;
    this._intervalMs = MAX_POLL_INTERVAL_MS;
    this._scheduleNext();
  }

  stop(): void {
    this.isRunningFlag = false;
    if (this._timeoutId !== null) { clearTimeout(this._timeoutId); this._timeoutId = null; }
  }

  private async _pollCycle(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      if (this.tasks.size === 0) { this.stop(); return; }
      const statusResult = await this.client.session.status();
      if (statusResult.error !== undefined) { this._scheduleNext(); return; }
      const statusMap: Record<string, { type: string }> =
        (statusResult.data as Record<string, { type: string }>) ?? {};
      for (const [taskId, task] of this.tasks) {
        try { await this._processTask(taskId, task, statusMap); } catch { /* isolate */ }
      }
      this._adjustInterval();
      if (this.isRunningFlag) this._scheduleNext();
    } catch (err: unknown) {
      console.error("[GlobalPoller] poll cycle error:",
        err instanceof Error ? err.message : err);
      if (this.isRunningFlag) this._scheduleNext();
    } finally { this.isPolling = false; }
  }

  private async _processTask(
    taskId: string, task: RegisteredTask, statusMap: Record<string, { type: string }>,
  ): Promise<void> {
    const now = Date.now();
    const r = this.deps.sessionMonitor.checkSession(taskId, task.sessionId, statusMap);

    if (r.type === "gone") {
      const ex = await this.deps.sessionMonitor.verifyExistence(this.client, task.sessionId);
      if (ex === "missing") {
        this.deps.onTaskError(taskId, "Session disappeared");
        this.unregisterTask(taskId);
      }
      return;
    }

    if (r.type === "active" && (r.status?.type === "busy" || r.status?.type === "retry")) {
      task.pollState.lastProgressUpdate = now;
      task.pollState.stableIdlePolls = 0;
      task.pollState.hasProducedOutput = true;
      return;
    }

    const curKey = statusKey(r.type, r.status?.type);
    const prevKey = this._prevStatusKey.get(taskId);
    this._prevStatusKey.set(taskId, curKey);
    const needsFetch = task.pollState.lastMessageCount === 0 || prevKey !== curKey;

    if (needsFetch) {
      const msgResult = await this.client.session.messages({ path: { id: task.sessionId } });
      if (msgResult.error !== undefined || msgResult.data == null) return;
      const messages = msgResult.data as SessionMessageSnapshot[];
      task.pollState.lastMessageCount = messages.length;
      const sig = this.deps.completionDetector(messages, r.status, task.pollState);
      await this._handleSignal(taskId, task, sig, now, r.type);
    } else if (task.pollState.stableIdlePolls > 0 &&
               task.pollState.stableIdlePolls < MIN_STABILITY_POLLS) {
      task.pollState.stableIdlePolls++;
      if (task.pollState.stableIdlePolls >= MIN_STABILITY_POLLS) {
        this.deps.onTaskCompleted(taskId); this.unregisterTask(taskId);
      }
    }
    task.pollState.lastProgressUpdate = now;
  }

  private async _handleSignal(
    taskId: string, task: RegisteredTask, sig: CompletionSignal,
    now: number, monitorType: string,
  ): Promise<void> {
    switch (sig.type) {
      case "completed": this.deps.onTaskCompleted(taskId); this.unregisterTask(taskId); break;
      case "error": this.deps.onTaskError(taskId, sig.message); this.unregisterTask(taskId); break;
      case "stabilizing": task.pollState.stableIdlePolls++; break;
      case "not_ready": this._checkTimeouts(taskId, task, now, monitorType); break;
    }
  }

  private _checkTimeouts(
    taskId: string, task: RegisteredTask, now: number, monitorType: string,
  ): void {
    const elapsed = now - task.registeredAt;
    if (!task.pollState.hasProducedOutput && elapsed > MESSAGE_STALENESS_TIMEOUT_MS) {
      this.deps.onTaskTimeout(taskId, "Never produced output"); this.unregisterTask(taskId); return;
    }
    if (task.pollState.hasProducedOutput &&
        now - task.pollState.lastProgressUpdate >
          (this.config.staleTimeoutMs ?? MESSAGE_STALENESS_TIMEOUT_MS)) {
      this.deps.onTaskTimeout(taskId, "Task stalled"); this.unregisterTask(taskId); return;
    }
    if (monitorType === "uncertain" && elapsed > SESSION_GONE_TIMEOUT_MS) {
      this.deps.onTaskTimeout(taskId, "Session unresponsive"); this.unregisterTask(taskId); return;
    }
  }

  private _adjustInterval(): void {
    const tc = this.tasks.size;
    const max = this.config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (tc === 0) { this._intervalMs = MAX_POLL_INTERVAL_MS; return; }
    const ratio = tc / max;
    if (ratio >= 0.8) { this._intervalMs = MIN_POLL_INTERVAL_MS; }
    else if (ratio <= 0.2) { this._intervalMs = MAX_POLL_INTERVAL_MS; }
    else {
      this._intervalMs = Math.round(
        MIN_POLL_INTERVAL_MS + (MAX_POLL_INTERVAL_MS - MIN_POLL_INTERVAL_MS) * ((0.8 - ratio) / 0.6));
    }
  }

  private _scheduleNext(): void {
    if (this._timeoutId !== null) { clearTimeout(this._timeoutId); this._timeoutId = null; }
    this._timeoutId = setTimeout(() => { this._timeoutId = null; void this._pollCycle(); }, this._intervalMs);
  }
}
