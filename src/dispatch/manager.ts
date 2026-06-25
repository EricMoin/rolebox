import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  DispatchInput,
  DispatchTask,
  DispatchManagerConfig,
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { ConcurrencyManager } from "./concurrency.js";
import { GlobalPoller } from "./global-poller.js";
import { SessionMonitor } from "./session-monitor.js";
import { detectCompletion } from "./completion-detector.js";
import { notifyParent } from "./notification.js";

const DEFAULT_CONCURRENCY_KEY = "default";

export class DispatchManager {
  private tasks: Map<string, DispatchTask> = new Map();
  private cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private concurrency: ConcurrencyManager;
  private config: DispatchManagerConfig;
  private client: OpencodeClient;
  private poller: GlobalPoller;
  private sessionMonitor: SessionMonitor;

  constructor(client: OpencodeClient, config?: Partial<DispatchManagerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.concurrency = new ConcurrencyManager(this.config.maxConcurrent);
    this.sessionMonitor = new SessionMonitor();
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

      if (input.run_in_background) {
        await this.client.session.promptAsync({
          path: { id: session.id },
          body: {
            agent: input.subagent,
            parts: [{ type: "text", text: input.prompt }],
          },
        });

        this.poller.registerTask(taskId, session.id);
      }
    } catch (err) {
      task.status = "error";
      task.error = err instanceof Error ? err.message : String(err);
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

    try {
      await this.client.session.abort({
        path: { id: task.sessionId },
      });
    } catch {
      // Session may already be gone
    }

    task.status = "cancelled";
    task.completedAt = new Date();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.poller.unregisterTask(taskId);
    this.sessionMonitor.clearTask(taskId);
    void this.notifyCompletion(task);
    this.scheduleCleanup(taskId);

    return true;
  }

  async getResult(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) return "";

    const messagesResult = await this.client.session.messages({
      path: { id: task.sessionId },
    });

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
    const timer = this.cleanupTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(taskId);
    }
  }

  async notifyCompletion(task: DispatchTask): Promise<void> {
    const remainingCount = [...this.tasks.values()].filter(
      (t) =>
        t.parentSessionId === task.parentSessionId &&
        (t.status === "pending" || t.status === "running"),
    ).length;

    await notifyParent(this.client, task, remainingCount);
  }

  private handleTaskCompleted(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "completed";
    t.completedAt = new Date();
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
    void this.notifyCompletion(t);
  }

  private handleTaskError(taskId: string, error: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "error";
    t.error = error;
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
  }

  private handleTaskTimeout(taskId: string, reason: string): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "timeout";
    t.completedAt = new Date();
    t.error = reason;
    this.concurrency.release(DEFAULT_CONCURRENCY_KEY);
    this.scheduleCleanup(taskId);
  }

  private scheduleCleanup(taskId: string): void {
    const existing = this.cleanupTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.cleanupTask(taskId);
    }, this.config.taskTtlMs);

    this.cleanupTimers.set(taskId, timer);
  }
}
