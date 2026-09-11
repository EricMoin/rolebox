import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { DispatchManager } from "../dispatch/core/manager.ts";
import type { DispatchInput } from "../dispatch/types.ts";
import { SUMMARY_INPUT_CHAR_CAP } from "./constants.js";

// ── Interface ────────────────────────────────────────────────────────────

/**
 * Narrow contract the loop coordinator uses to drive rounds through
 * DispatchManager. The coordinator must NOT know dispatch internals.
 */
export interface IDispatchAdapter {
  /** Submit a round to a worker agent via DispatchManager. */
  dispatchRound(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
    /** Per-round hard timeout (ms), forwarded to the dispatch watchdog as `timeout_ms`. */
    timeoutMs?: number;
  }): Promise<{ workerTaskId: string; workerSessionId: string }>;

  /** Retrieve the result of a completed worker round. */
  getRoundResult(workerTaskId: string): Promise<{
    text: string;
    hadError: boolean;
    errorReason?: string;
  }>;

  /** Cancel a running worker round. */
  cancelRound(workerTaskId: string): Promise<void>;

  /**
   * Read the latest assistant output from the origin session, up to
   * SUMMARY_INPUT_CHAR_CAP characters.  If `sinceMessageId` is provided,
   * only messages after that ID are considered.
   */
  readOriginSummary(
    originSessionId: string,
    sinceMessageId?: string,
  ): Promise<string>;

  /** Return the ID of the most recent message in a session, or undefined if empty. */
  getLastMessageId(originSessionId: string): Promise<string | undefined>;

  /** Inject a silent progress note into the origin session (noReply:true). */
  injectNote(sessionId: string, text: string): Promise<void>;

  /**
   * Register a one-time listener for when a dispatched worker task enters a
   * terminal state.  The callback is invoked at most once with the task ID and
   * its final status string.  Returns the same callback for convenience.
   */
  registerTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): (taskId: string, status: string) => void;

  /** Remove a previously registered task-terminated listener. */
  removeTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): void;

  /**
   * Read-only query: returns the current lifecycle status of a dispatched task.
   * Returns the status string or undefined if the task ID is unknown.
   */
  getTaskStatus(taskId: string): Promise<string | undefined>;
}

// ── Implementation ────────────────────────────────────────────────────────

export class DispatchAdapter implements IDispatchAdapter {
  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly client: ISessionClient,
    private readonly directory?: string,
  ) {}
  /** Tracks the last message ID processed by readOriginSummary for incremental reads. */
  lastProcessedMessageId?: string;
  async dispatchRound(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
    timeoutMs?: number;
  }): Promise<{ workerTaskId: string; workerSessionId: string }> {
    const dispatchInput: DispatchInput = {
      subagent: input.agent,
      prompt: input.prompt,
      run_in_background: true,
      description: input.description,
      noParentInherit: true,
      ...(input.timeoutMs !== undefined ? { timeout_ms: input.timeoutMs } : {}),
    };

    const task = await this.dispatchManager.launch(dispatchInput, {
      sessionID: input.originSessionId,
      agent: input.agent,
      directory: this.directory ?? process.cwd(),
    });

    return {
      workerTaskId: task.id,
      workerSessionId: task.sessionId,
    };
  }

  async getRoundResult(
    workerTaskId: string,
  ): Promise<{ text: string; hadError: boolean; errorReason?: string }> {
    const result = await this.dispatchManager.getResult(workerTaskId);

    const hadError =
      result.kind !== "ok" || result.error !== undefined;

    return {
      text: result.text,
      hadError,
      errorReason: result.error,
    };
  }

  async cancelRound(workerTaskId: string): Promise<void> {
    await this.dispatchManager.cancelTask(workerTaskId);
  }

  async readOriginSummary(
    originSessionId: string,
    sinceMessageId?: string,
  ): Promise<string> {
    const effectiveSinceId = sinceMessageId ?? this.lastProcessedMessageId;
    const messages = await this.client.messages(originSessionId);
    if (!messages || messages.length === 0) return "";

    let capture = !effectiveSinceId;


    const textParts: string[] = [];

    for (const msg of messages) {
      if (!capture && msg.info?.id === effectiveSinceId) {
        capture = true;
        continue;
      }
      if (!capture) continue;

      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && "text" in part && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }
    }

    let text = textParts.join("");

    if (text.length > SUMMARY_INPUT_CHAR_CAP) {
      text = text.slice(-SUMMARY_INPUT_CHAR_CAP);
    }
    const result = text;
    // Track the last message ID for the next incremental call
    if (messages.length > 0) {
      this.lastProcessedMessageId = messages[messages.length - 1]?.info?.id ?? this.lastProcessedMessageId;
    }
    return result;
  }

  async getLastMessageId(originSessionId: string): Promise<string | undefined> {
    const messages = await this.client.messages(originSessionId);
    if (!messages || messages.length === 0) return undefined;
    return messages[messages.length - 1]?.info?.id;
  }

  async injectNote(sessionId: string, text: string): Promise<void> {
    await this.client.prompt(sessionId, {
      noReply: true,
      fromLoop: true,
      parts: [{ type: "text", text }],
    });
  }

  registerTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): (taskId: string, status: string) => void {
    return this.dispatchManager.onTaskTerminated(taskId, callback);
  }

  removeTerminatedListener(
    taskId: string,
    callback: (taskId: string, status: string) => void,
  ): void {
    this.dispatchManager.removeTaskTerminatedListener(taskId, callback);
  }

  async getTaskStatus(taskId: string): Promise<string | undefined> {
    const task = this.dispatchManager.getTask(taskId);
    return task?.status;
  }
}
