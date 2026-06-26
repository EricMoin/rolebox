import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchInput,
  DispatchTask,
  DispatchManagerConfig,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { ConcurrencyManager } from "./concurrency.ts";
import { GlobalPoller } from "./global-poller.ts";
import { SessionMonitor } from "./session-monitor.ts";
import { detectCompletion } from "./completion-detector.ts";
import { notifyParent } from "./notification.ts";

import { TaskStateStore } from "./task-store.ts";
import { debugLog } from "./debug-log.ts";

const DEFAULT_CONCURRENCY_KEY = "default";

export class DispatchManager {
  private tasks: Map<string, DispatchTask> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingNotifications: Set<string> = new Set();
  private cleanedUpTasks: string[] = [];
  private concurrency: ConcurrencyManager;
  private config: DispatchManagerConfig;
  private client: OpencodeClient;
  private poller: GlobalPoller;
  private sessionMonitor: SessionMonitor;
  private store: TaskStateStore;
  private _recovered = false;

  constructor(client: OpencodeClient, config?: Partial<DispatchManagerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.concurrency = new ConcurrencyManager(this.config.maxConcurrent);
    this.sessionMonitor = new SessionMonitor();
    this.store = new TaskStateStore(process.cwd());
    this.poller = new GlobalPoller(client, this.config, {
      completionDetector: detectCompletion,
      sessionMonitor: this.sessionMonitor,
      onTaskCompleted: (taskId) => this.handleTaskCompleted(taskId),
      onTaskError: (taskId, error) => this.handleTaskError(taskId, error),
      onTaskTimeout: (taskId, reason) => this.handleTaskTimeout(taskId, reason),
    });
  }

  async launch(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<DispatchTask> {
    const taskId = `bg_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

    const task: DispatchTask = {
      id: taskId,
      sessionId: "",
      parentSessionId: parentContext.sessionID,
      status: "pending",
      agent: input.subagent,
      prompt: input.prompt,
      description: input.description,
      startedAt: new Date(),
      progress: { lastUpdate: new Date(), toolCalls: 0 },
    };

    this.tasks.set(taskId, task);

    debugLog("launch", taskId, `agent=${input.subagent} bg=${input.run_in_background} desc="${input.description ?? ""}"`);

    await this.concurrency.acquire(DEFAULT_CONCURRENCY_KEY);

    try {
      const createResult = await this.client.session.create({
        body: {
          parentID: parentContext.sessionID,
        },
        query: {
          directory: parentContext.directory,
        },
      });

      const session = createResult.data;
      if (!session) {
        throw new Error("Failed to create session: empty response");
      }
      task.sessionId = session.id;
      task.status = "running";
      task.progress.lastUpdate = new Date();
      this.persistState();

      debugLog("launch", taskId, `session created: ${session.id}`);

      if (input.run_in_background) {
        await this.client.session.promptAsync({
          path: { id: session.id },
          body: {
            agent: input.subagent,
            parts: [{ type: "text", text: input.prompt }],
          },
        });

        debugLog("launch", taskId, "promptAsync sent — registering with poller");
        this.poller.registerTask(taskId, session.id);
      }
    } catch (err) {
      task.status = "error";
      task.error = err instanceof Error ? err.message : String(err);
      debugLog("launch", taskId, `ERROR: ${task.error}`);
      this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
      this.scheduleCleanup(taskId);
    }

    return task;
  }

  async executeSync(
    input: DispatchInput,
    parentContext: { sessionID: string; agent: string; directory: string },
  ): Promise<string> {
    const createResult = await this.client.session.create({
      body: {
        parentID: parentContext.sessionID,
      },
      query: {
        directory: parentContext.directory,
      },
    });

    const session = createResult.data;
    if (!session) {
      throw new Error("Failed to create session: empty response");
    }

    const promptResult = await this.client.session.prompt({
      path: { id: session.id },
      body: {
        agent: input.subagent,
        parts: [{ type: "text", text: input.prompt }],
      },
    });

    const response = promptResult.data;
    if (!response) {
      return "";
    }

    const text = response.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");

    return text;
  }

  getTask(taskId: string): DispatchTask | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByParent(parentSessionId: string): DispatchTask[] {
    const result: DispatchTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === parentSessionId) {
        result.push(task);
      }
    }
    return result;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Don't cancel tasks that have already reached a terminal state
    if (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "timeout" ||
      task.status === "cancelled"
    ) {
      debugLog("cancelTask", taskId, `already in terminal status ${task.status} — skipping`);
      return false;
    }

    // Don't cancel tasks while a notification is in-flight
    if (this.pendingNotifications.has(taskId)) {
      debugLog("cancelTask", taskId, `has in-flight notification — skipping`);
      return false;
    }

    try {
      await this.client.session.abort({
        path: { id: task.sessionId },
      });
    } catch (err) {
      debugLog("cancelTask", taskId, `Session cancel failed (may already be gone): ${err instanceof Error ? err.message : String(err)}`);
    }

    task.status = "cancelled";
    task.completedAt = new Date();
    this.persistState();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.poller.unregisterTask(taskId);
    this.sessionMonitor.clearTask(taskId);
    void this.notifyCompletion(task);
    this.scheduleCleanup(taskId);

    return true;
  }

  async getResult(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) {
      if (this.cleanedUpTasks.includes(taskId)) {
        return ""; // Task was cleaned up after completion — result no longer available
      }
      return ""; // Task never existed
    }

    const messagesResult = await this.client.session.messages({
      path: { id: task.sessionId },
    });

    if (messagesResult.error !== undefined) {
      return `[Error retrieving task output: ${JSON.stringify(messagesResult.error)}]`;
    }

    const messages = messagesResult.data ?? [];

    const textParts: string[] = [];
    for (const msg of messages) {
      if (msg.info.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (part.type === "text") {
          textParts.push(
            (part as { type: "text"; text: string }).text,
          );
        }
      }
    }

    return textParts.join("");
  }

  cleanupTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.persistState();
    this.cleanedUpTasks.push(taskId);
    if (this.cleanedUpTasks.length > 500) {
      this.cleanedUpTasks.shift();
    }
    const timer = this.cleanupTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(taskId);
    }
  }

  private persistState(): void {
    this.store.save(this.tasks);
  }

  private restoreState(): void {
    const loaded = this.store.load();
    if (!loaded) return;
    for (const [taskId, task] of loaded) {
      this.tasks.set(taskId, task);
    }
  }

  /**
   * Set the workspace directory used for multi-instance state file isolation.
   * Must be called before recover() if the default process.cwd() is wrong.
   */
  setStoreDirectory(directory: string): void {
    this.store = new TaskStateStore(directory);
  }

  async recover(): Promise<void> {
    if (this._recovered) return;
    this._recovered = true;

    this.restoreState();

    const runningTasks: DispatchTask[] = [];
    const toRemove: string[] = [];

    for (const [taskId, task] of this.tasks) {
      switch (task.status) {
        case "pending":
          toRemove.push(taskId);
          break;
        case "running":
          runningTasks.push(task);
          break;
        case "completed":
        case "error":
        case "timeout":
        case "cancelled":
          this.scheduleCleanupFromRecovery(taskId, task);
          break;
      }
    }

    // Remove silent pending tasks
    for (const id of toRemove) {
      this.tasks.delete(id);
    }

    // Verify each running task's session
    for (const task of runningTasks) {
      try {
        const result = await this.client.session.get({
          path: { id: task.sessionId },
        });
        if (result.data) {
          this.concurrency.forceOccupy("default");
          this.poller.registerTask(task.id, task.sessionId);
          debugLog("recover", task.id, `session ${task.sessionId} alive — re-registered`);
        } else {
          task.status = "error";
          task.error = "Session lost after process restart";
          task.completedAt = new Date();
          this.scheduleCleanup(task.id);
          debugLog("recover", task.id, "session gone after restart");
        }
      } catch {
        task.status = "error";
        task.error = "Session verification failed after restart";
        task.completedAt = new Date();
        this.scheduleCleanup(task.id);
      }
    }

    if (toRemove.length > 0 || runningTasks.length > 0) {
      this.persistState();
    }
  }

  private scheduleCleanupFromRecovery(taskId: string, task: DispatchTask): void {
    if (!task.completedAt) {
      this.scheduleCleanup(taskId);
      return;
    }
    const elapsed = Date.now() - new Date(task.completedAt).getTime();
    const remaining = Math.max(this.config.taskTtlMs - elapsed, 0);
    if (remaining === 0) {
      this.cleanupTask(taskId);
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupTask(taskId);
    }, remaining);
    this.cleanupTimers.set(taskId, timer);
  }

  async notifyCompletion(task: DispatchTask): Promise<void> {
    const remainingCount = [...this.tasks.values()].filter(
      (t) =>
        t.parentSessionId === task.parentSessionId &&
        (t.status === "pending" || t.status === "running"),
    ).length;

    this.pendingNotifications.add(task.id);
    try {
      await notifyParent(this.client, task, remainingCount);
    } finally {
      this.pendingNotifications.delete(task.id);
    }
  }

  async handleSessionIdle(sessionId: string): Promise<void> {
    let targetTask: DispatchTask | undefined;
    let targetTaskId: string | undefined;

    for (const [taskId, task] of this.tasks) {
      if (task.sessionId === sessionId && task.status === "running") {
        targetTask = task;
        targetTaskId = taskId;
        break;
      }
    }

    if (!targetTask || !targetTaskId) return;

    const elapsed = Date.now() - targetTask.startedAt.getTime();
    if (elapsed < 3000) {
      debugLog("event", targetTaskId, `session.idle too early (${elapsed}ms), deferring`);
      return;
    }

    try {
      debugLog("event", targetTaskId, "session.idle received — validating output");

      const msgResult = await this.client.session.messages({
        path: { id: sessionId },
      });

      const messages = (msgResult.data ?? []) as Array<{
        info: { role: string; finish?: string; error?: unknown };
        parts: Array<{ type: string; state?: string; text?: string }>;
      }>;

      let hasAssistantOutput = false;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.info.role === "assistant") {
          const hasText = m.parts.some(p => p.type === "text" && p.text && p.text.length > 0);
          const hasToolResult = m.parts.some(p => p.type === "tool");
          const hasPendingTools = m.parts.some(p => p.type === "tool" && (p.state === "pending" || p.state === "running"));

          if (hasPendingTools) {
            debugLog("event", targetTaskId, "session.idle but tools still pending — skipping");
            return;
          }

          if (hasText || hasToolResult) {
            hasAssistantOutput = true;
          }
          break;
        }
      }

      if (!hasAssistantOutput) {
        debugLog("event", targetTaskId, "session.idle but no assistant output yet — skipping");
        return;
      }

      debugLog("event", targetTaskId, "session.idle validated — completing task");
      this.poller.unregisterTask(targetTaskId);
      this.handleTaskCompleted(targetTaskId);
    } catch (err) {
      debugLog("event", targetTaskId, "handleSessionIdle error: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private handleTaskCompleted(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.status !== "pending" && t.status !== "running") return;
    debugLog("lifecycle", taskId, "✓ COMPLETED");
    t.status = "completed";
    t.completedAt = new Date();
    this.persistState();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
    void this.notifyCompletion(t);
  }

  private handleTaskError(taskId: string, error: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.status !== "pending" && t.status !== "running") return;
    debugLog("lifecycle", taskId, `✗ ERROR: ${error}`);
    t.status = "error";
    t.error = error;
    t.completedAt = new Date();
    this.persistState();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
    void this.notifyCompletion(t);
  }

  private handleTaskTimeout(taskId: string, reason: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.status !== "pending" && t.status !== "running") return;
    debugLog("lifecycle", taskId, `⏱ TIMEOUT: ${reason}`);
    t.status = "timeout";
    t.completedAt = new Date();
    t.error = reason;
    this.persistState();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
    void this.notifyCompletion(t);
  }

  private scheduleCleanup(taskId: string): void {
    const existing = this.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      if (this.pendingNotifications.has(taskId)) {
        this.scheduleCleanup(taskId);
        return;
      }
      this.cleanupTask(taskId);
    }, this.config.taskTtlMs);

    this.cleanupTimers.set(taskId, timer);
  }
}
