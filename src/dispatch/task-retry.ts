import { tool, type ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";
import type { DispatchManager } from "./manager.ts";
import type { DispatchInput } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("search:task-retry");

/** Set of dispatch task statuses considered terminal (no longer in-flight). */
const TERMINAL_STATUSES = new Set(["completed", "error", "cancelled", "timeout"]);

export function createTaskRetryTool(dispatchManager: DispatchManager) {
  return tool({
    description:
      "Retry a failed dispatch task — reopens the original session for continuation via DispatchManager.reopenForContinuation(). Only tasks in a terminal state (completed, error, cancelled, timeout) can be retried. The original session is reused so all prior context is preserved. Rolebox-specific: opencode has no native retry mechanism for dispatched sub-agent tasks.",
    args: {
      task_id: z
        .string()
        .min(1)
        .describe("ID of the task to retry"),
      modify_prompt: z
        .string()
        .optional()
        .describe("Optional text to prepend to the original task prompt before retrying"),
      reset_budget: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Reset budget counter for this retry (default false). " +
          "When true, the retry does not count toward the parent session's dispatch budget limit.",
        ),
    },
    async execute(input, context: ToolContext) {
      const { task_id, modify_prompt } = input;

      // Step 1: Look up the original task
      const task = dispatchManager.getTask(task_id);
      if (!task) {
        return `Task \`${task_id}\` not found. It may have been cleaned up or never existed.`;
      }

      // Step 2: Validate that the task is in a terminal (retryable) state
      if (!TERMINAL_STATUSES.has(task.status)) {
        return (
          `Task \`${task_id}\` is still ${task.status}. ` +
          `Cancel it first before retrying.`
        );
      }

      // Step 3: Build the new DispatchInput from the original task
      const prompt = modify_prompt
        ? modify_prompt + "\n" + task.prompt
        : task.prompt;

      const dispatchInput: DispatchInput = {
        subagent: task.agent,
        prompt,
        run_in_background: true,
        description: task.description,
        timeout_ms: task.timeoutMs,
      };

      // Step 4: Build parentContext from the tool's execution context
      const parentContext = {
        sessionID: context.sessionID,
        agent: context.agent,
        directory: context.directory,
      };

      // Step 5: Call reopenForContinuation
      try {
        const retriedTask = await dispatchManager.reopenForContinuation(
          task_id,
          dispatchInput,
          parentContext,
        );

        log.debug(
          `task_retry id=${task_id} status=${retriedTask.status} agent=${retriedTask.agent}`,
          { tag: "task-retry", taskId: task_id },
        );

        return formatRetryResult(retriedTask);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`task_retry failed for id=${task_id}: ${message}`, {
          tag: "task-retry",
          taskId: task_id,
        });
        return `Failed to retry task \`${task_id}\`: ${message}`;
      }
    },
  });
}

/**
 * Format the retried task state into a readable markdown block.
 */
function formatRetryResult(task: {
  id: string;
  status: string;
  agent: string;
  sessionId: string;
}): string {
  const lines: string[] = [
    `## Task Retry Result: \`${task.id}\``,
    "",
    `- **Task ID**: \`${task.id}\``,
    `- **Status**: ${task.status}`,
    `- **Agent**: \`${task.agent}\``,
    `- **Session ID**: \`${task.sessionId}\``,
    "",
  ];

  if (task.status === "running") {
    lines.push("The task has been reopened successfully and is now running in the background.");
  } else if (task.status === "error") {
    lines.push(
      "The task could not be started — no concurrency slot was available. " +
      "Try again later when other tasks have completed.",
    );
  } else {
    lines.push(`Task ended with status: ${task.status}.`);
  }

  return lines.join("\n");
}
