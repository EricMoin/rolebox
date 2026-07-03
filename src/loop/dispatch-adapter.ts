import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchManager } from "../dispatch/manager.ts";
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
}

// ── Implementation ────────────────────────────────────────────────────────

export class DispatchAdapter implements IDispatchAdapter {
  constructor(
    private readonly dispatchManager: DispatchManager,
    private readonly client: OpencodeClient,
  ) {}

  async dispatchRound(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    description?: string;
  }): Promise<{ workerTaskId: string; workerSessionId: string }> {
    const dispatchInput: DispatchInput = {
      subagent: input.agent,
      prompt: input.prompt,
      run_in_background: true,
      description: input.description,
    };

    const task = await this.dispatchManager.launch(dispatchInput, {
      sessionID: input.originSessionId,
      agent: input.agent,
      directory: process.cwd(),
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
    const messagesResult = await this.client.session.messages({
      path: { id: originSessionId },
    });

    const messages = (messagesResult as {
      data?: Array<{
        info?: { role?: string; id?: string };
        parts?: Array<{ type: string; text?: string }>;
      }>;
    }).data;

    if (!messages || messages.length === 0) return "";

    let capture = false;
    if (!sinceMessageId) {
      capture = true;
    }

    const textParts: string[] = [];

    for (const msg of messages) {
      if (!capture && msg.info?.id === sinceMessageId) {
        capture = true;
        continue;
      }
      if (!capture) continue;

      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }
    }

    let text = textParts.join("");

    if (text.length > SUMMARY_INPUT_CHAR_CAP) {
      text = text.slice(-SUMMARY_INPUT_CHAR_CAP);
    }

    return text;
  }

  async getLastMessageId(originSessionId: string): Promise<string | undefined> {
    const messagesResult = await this.client.session.messages({
      path: { id: originSessionId },
    });
    const messages = (
      messagesResult as { data?: Array<{ info?: { id?: string } }> }
    ).data;
    if (!messages || messages.length === 0) return undefined;
    return messages[messages.length - 1]?.info?.id;
  }

  async injectNote(sessionId: string, text: string): Promise<void> {
    await this.client.session.promptAsync({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text }],
      },
    });
  }
}
