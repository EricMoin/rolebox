import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk";
import type { DispatchManagerConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";

export class SessionPoller {
  private client: OpencodeClient;
  private config: DispatchManagerConfig;
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private taskStartTimes = new Map<string, number>();
  private lastProgress = new Map<string, number>();

  constructor(client: OpencodeClient, config?: Partial<DispatchManagerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(
    taskId: string,
    sessionId: string,
    onComplete: (taskId: string) => void,
    onError: (taskId: string, error: string) => void,
    onTimeout: (taskId: string) => void,
  ): void {
    if (this.intervals.has(taskId)) return;

    const now = Date.now();
    this.taskStartTimes.set(taskId, now);
    this.lastProgress.set(taskId, now);

    const timer = setInterval(() => {
      void this._poll(taskId, sessionId, onComplete, onError, onTimeout);
    }, this.config.pollIntervalMs);

    this.intervals.set(taskId, timer);
  }

  stop(taskId: string): void {
    const timer = this.intervals.get(taskId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.intervals.delete(taskId);
    }
    this.taskStartTimes.delete(taskId);
    this.lastProgress.delete(taskId);
  }

  stopAll(): void {
    for (const taskId of this.intervals.keys()) {
      this.stop(taskId);
    }
  }

  isPolling(taskId: string): boolean {
    return this.intervals.has(taskId);
  }

  private async _poll(
    taskId: string,
    sessionId: string,
    onComplete: (taskId: string) => void,
    _onError: (taskId: string, error: string) => void,
    onTimeout: (taskId: string) => void,
  ): Promise<void> {
    try {
      const statusResult = await this.client.session.status();
      if (statusResult.error !== undefined) return;

      const statusMap = statusResult.data;
      if (statusMap === undefined || statusMap === null) return;

      const status: SessionStatus | undefined = statusMap[sessionId];
      if (status === undefined) return;

      const now = Date.now();
      const startedAt = this.taskStartTimes.get(taskId) ?? now;
      const elapsed = now - startedAt;
      const last = this.lastProgress.get(taskId) ?? now;

      if (elapsed > this.config.minRuntimeMs && now - last > this.config.staleTimeoutMs) {
        onTimeout(taskId);
        this.stop(taskId);
        return;
      }

      if (status.type === "busy" || status.type === "retry") {
        this.lastProgress.set(taskId, now);
        return;
      }

      if (elapsed < this.config.minRuntimeMs) return;

      const hasOutput = await this._hasAssistantOutput(sessionId);
      if (hasOutput) {
        onComplete(taskId);
        this.stop(taskId);
      }
    } catch (err) {
      console.error(
        `[SessionPoller] poll error for task ${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async _hasAssistantOutput(sessionId: string): Promise<boolean> {
    try {
      const msgResult = await this.client.session.messages({
        path: { id: sessionId },
      });

      if (msgResult.error !== undefined) return false;

      const messages = msgResult.data;
      if (messages === undefined || messages === null) return false;

      for (const msg of messages) {
        if (msg.info.role !== "assistant") continue;
        for (const part of msg.parts) {
          if (part.type === "text" && part.text.trim().length > 0) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}
