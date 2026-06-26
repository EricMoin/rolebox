import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { DispatchManager } from "./manager.ts";
import type { DispatchInput, DispatchTask } from "./types.ts";

function formatDuration(task: DispatchTask): string {
  const end = task.completedAt ?? new Date();
  const ms = end.getTime() - task.startedAt.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}

function parentContextFromTool(context: {
  sessionID: string;
  agent: string;
  directory: string;
}) {
  return {
    sessionID: context.sessionID,
    agent: context.agent,
    directory: context.directory,
  };
}

export function createDispatchTool(
  manager: DispatchManager,
  resolvedSubagents: Map<string, string>,
  graphAdvancer?: (agentId: string) => void,
) {
  return tool({
    description:
      "Dispatch work to a subagent. Run synchronously or in the background.",
    args: {
      subagent: z.string().describe("The subagent to dispatch to"),
      prompt: z.string().describe("The task prompt for the subagent"),
      run_in_background: z
        .boolean()
        .describe("Whether to run the task in the background"),
      description: z
        .string()
        .optional()
        .describe("Human-readable description of the task"),
      session_id: z
        .string()
        .optional()
        .describe(
          "Task ID from a previous dispatch to re-prompt and continue work",
        ),
    },
    async execute(input, context) {
      if (!resolvedSubagents.has(input.subagent)) {
        const available = [...resolvedSubagents.keys()].join(", ");
        return `Invalid subagent: '${input.subagent}'. Available subagents: ${available}`;
      }

      const parentCtx = parentContextFromTool(context);

      const dispatchInput: DispatchInput = {
        subagent: input.subagent,
        prompt: input.prompt,
        run_in_background: input.run_in_background,
        description: input.description,
        session_id: input.session_id,
      };

      if (input.session_id) {
        const existing = manager.getTask(input.session_id);
        if (!existing) {
          return `Task '${input.session_id}' not found. Provide a valid task ID from a previous dispatch call.`;
        }
      }

      if (input.run_in_background) {
        const task = await manager.launch(dispatchInput, parentCtx);

        if (graphAdvancer) {
          graphAdvancer(input.subagent);
        }

        return [
          "Background task launched.\n",
          `Task ID: ${task.id}`,
          `Session ID: ${task.sessionId}`,
          `Description: ${input.description || "N/A"}`,
          "",
          "You will receive a <system-reminder> notification when this task completes.",
          "Do NOT call dispatch_output to poll — wait for the notification first.",
          "Use dispatch_output(task_id=\"" + task.id + "\") only AFTER receiving the <system-reminder>.",
        ].join("\n");
      }

      const result = await manager.executeSync(dispatchInput, parentCtx);

      if (graphAdvancer) {
        graphAdvancer(input.subagent);
      }

      return result;
    },
  });
}

export function createDispatchOutputTool(manager: DispatchManager) {
  return tool({
    description:
      "Retrieve output from a completed background task. Only call AFTER receiving a <system-reminder> notification for the task. Do NOT use this to poll for status.",
    args: {
      task_id: z
        .string()
        .describe("The task ID returned by the dispatch tool"),
      block: z
        .boolean()
        .optional()
        .default(false)
        .describe("Wait for the task to complete before returning"),
      timeout: z
        .number()
        .optional()
        .default(60000)
        .describe("Maximum wait time in milliseconds when blocking"),
    },
    async execute(input) {
      const task = manager.getTask(input.task_id);
      if (!task) {
        return `Task '${input.task_id}' not found.`;
      }

      if (task.status === "completed") {
        const content = await manager.getResult(input.task_id);
        return [
          "Task Result\n",
          `Task ID: ${task.id}`,
          `Description: ${task.description || "N/A"}`,
          `Duration: ${formatDuration(task)}`,
          `Session ID: ${task.sessionId}`,
          "",
          "---\n",
          content,
        ].join("\n");
      }

      if (
        task.status === "error" ||
        task.status === "cancelled" ||
        task.status === "timeout"
      ) {
        return [
          `Task ${task.status.toUpperCase()}`,
          "",
          `Task ID: ${task.id}`,
          `Description: ${task.description || "N/A"}`,
          `Status: ${task.status}`,
          task.error ? `Error: ${task.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (!input.block) {
        return [
          "Task Status\n",
          `Task ID: ${task.id}`,
          `Description: ${task.description || "N/A"}`,
          `Status: ${task.status}`,
          "",
          "Task is still running. Do NOT poll dispatch_output repeatedly.",
          "You will receive a <system-reminder> notification when this task completes.",
          "Wait for the notification, then call dispatch_output to retrieve results.",
        ].join("\n");
      }

      const deadline = Date.now() + input.timeout;
      while (Date.now() < deadline) {
        const current = manager.getTask(input.task_id);
        if (!current) {
          return `Task '${input.task_id}' was cleaned up before completion.`;
        }

        if (current.status === "completed") {
          const content = await manager.getResult(input.task_id);
          return [
            "Task Result\n",
            `Task ID: ${current.id}`,
            `Description: ${current.description || "N/A"}`,
            `Duration: ${formatDuration(current)}`,
            `Session ID: ${current.sessionId}`,
            "",
            "---\n",
            content,
          ].join("\n");
        }

        if (
          current.status === "error" ||
          current.status === "cancelled" ||
          current.status === "timeout"
        ) {
          return [
            `Task ${current.status.toUpperCase()}`,
            "",
            `Task ID: ${current.id}`,
            `Description: ${current.description || "N/A"}`,
            `Status: ${current.status}`,
            current.error ? `Error: ${current.error}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const final = manager.getTask(input.task_id);
      const finalStatus = final?.status ?? "unknown";
      return `Timeout waiting for task '${input.task_id}'. Task is still ${finalStatus}.`;
    },
  });
}

export function createDispatchCancelTool(manager: DispatchManager) {
  return tool({
    description: "Cancel a running background task.",
    args: {
      task_id: z
        .string()
        .describe("The task ID returned by the dispatch tool"),
    },
    async execute(input) {
      const cancelled = await manager.cancelTask(input.task_id);
      if (!cancelled) {
        return `Task '${input.task_id}' not found.`;
      }
      return `Task '${input.task_id}' cancelled.`;
    },
  });
}
