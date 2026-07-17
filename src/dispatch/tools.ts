import { writeFileSync, renameSync } from "node:fs";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "./core/manager.ts";
import type { DispatchInput, DispatchTask } from "./types.ts";
import { metrics } from "./persistence/metrics.ts";
import { DEFAULT_MAX_RESULT_CHARS } from "./completion/result-extractor.ts";
import { getDataDir } from "../cli/paths.ts";
import { parentContextFromTool, buildCompletedOutput } from "./tool-helpers.ts";



export function createDispatchTool(
  manager: DispatchManager,
  resolvedSubagents: Map<string, { parentFullId: string }>,
  _subagentModelKey?: Map<string, string>,
) {
  return defineTool({
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
      timeout_ms: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Per-task timeout in milliseconds. Overrides the background default timeout. Only applies to background tasks.",
        ),
    },
    async execute(input, context) {
      if (!resolvedSubagents.has(input.subagent)) {
        const available = [...resolvedSubagents.keys()].join(", ");
        return `Invalid subagent: '${input.subagent}'. Available subagents: ${available}`;
      }

      const entry = resolvedSubagents.get(input.subagent);
      if (entry && entry.parentFullId !== context.agent) {
        const availableChildren = [...resolvedSubagents.entries()]
          .filter(([, v]) => v.parentFullId === context.agent)
          .map(([k]) => k);
        return `Subagent '${input.subagent}' is not a direct child of your agent '${context.agent}'. You can only dispatch to your direct children: ${availableChildren.join(", ") || "(none)"}`;
      }

      const parentCtx = parentContextFromTool(context);

      const dispatchInput: DispatchInput = {
        subagent: input.subagent,
        prompt: input.prompt,
        run_in_background: input.run_in_background,
        description: input.description,
        session_id: input.session_id,
        timeout_ms: input.timeout_ms,
      };

      if (input.run_in_background) {
        const task = input.session_id
          ? await manager.reopenForContinuation(input.session_id, dispatchInput, parentCtx)
          : await manager.launch(dispatchInput, parentCtx);

        if (task.status === "error" && task.error) {
          return [
            "Background task could not be launched.\n",
            `Task ID: ${task.id}`,
            `Description: ${input.description || "N/A"}`,
            "",
            `${task.error}`,
          ].join("\n");
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

      try {
        const result = await manager.executeSync(dispatchInput, parentCtx);
        return result;
      } catch (error) {
        return [
          "Sync dispatch failed.\n",
          `Subagent: ${input.subagent}`,
          `Description: ${input.description || "N/A"}`,
          "",
          `${(error as Error).message}`,
        ].join("\n");
      }
    },
  });
}



export function createDispatchOutputTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Retrieve output from a completed background task. Call ONLY after receiving the task's <system-reminder> completion notification. There is no blocking mode — never poll this tool to wait for a task to finish.",
    args: {
      task_id: z
        .string()
        .describe("The task ID returned by the dispatch tool"),
      max_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(DEFAULT_MAX_RESULT_CHARS)
        .describe(
          "Maximum characters to return in the inline result body. Results larger than this are spilled to a file.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Start position in the result text (0-based)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Maximum characters to return from offset, capped at max_chars.",
        ),
      tail: z
        .boolean()
        .optional()
        .describe(
          "Return the last max_chars characters of the result instead of a window from offset.",
        ),
    },
    async execute(input, context) {
      const dir = context?.directory ?? getDataDir();

      const task = manager.getTask(input.task_id);

      if (!task) {
        let result;
        try {
          result = await manager.getResult(input.task_id);
        } catch (err) {
          return [
            "Task Result Error",
            "",
            `Task ID: ${input.task_id}`,
            `Error reading result: ${(err as Error).message}`,
          ].join("\n");
        }
        if (result.kind === "expired") {
          return [
            "Task Expired",
            "",
            `Task ID: ${input.task_id}`,
            "This task was cleaned up before its result could be retrieved.",
          ].join("\n");
        }
        if (result.kind === "not_found") {
          return [
            "Task Not Found",
            "",
            `No task found with ID: ${input.task_id}`,
          ].join("\n");
        }
        // fetch_error or sidecar survival — treat as completed with whatever text we have
        return buildCompletedOutput(
          { id: input.task_id } as DispatchTask,
          result,
          {
            maxChars: input.max_chars ?? DEFAULT_MAX_RESULT_CHARS,
            offset: input.offset ?? 0,
            limit: input.limit,
            tail: input.tail,
          },
          dir,
        );
      }

      if (task.status === "completed") {
        let result;
        try {
          result = await manager.getResult(input.task_id);
        } catch (err) {
          return [
            "Task Result Error",
            "",
            `Task ID: ${task.id}`,
            `Description: ${task.description ?? "N/A"}`,
            `Error reading result: ${(err as Error).message}`,
          ].join("\n");
        }
        return buildCompletedOutput(
          task,
          result,
          {
            maxChars: input.max_chars ?? DEFAULT_MAX_RESULT_CHARS,
            offset: input.offset ?? 0,
            limit: input.limit,
            tail: input.tail,
          },
          dir,
        );
      }

      if (
        task.status === "error" ||
        task.status === "cancelled" ||
        task.status === "timeout"
      ) {
        const statusLabel = {
          error: "Task Error",
          cancelled: "Task Cancelled",
          timeout: "Task Timeout",
        }[task.status];
        return [
          statusLabel,
          "",
          `Task ID: ${task.id}`,
          `Description: ${task.description ?? "N/A"}`,
          `Status: ${task.status}`,
          task.error ? `Error: ${task.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      return `Task still running — run dispatch_output after <system-reminder>

Task ID: ${task.id}
Description: ${task.description ?? "N/A"}
Status: ${task.status}

Do NOT call dispatch_output again. You will receive a <system-reminder>
notification when this task completes. Call dispatch_output only AFTER
receiving that notification.`;
    },
  });
}

export function createDispatchCancelTool(manager: DispatchManager) {
  return defineTool({
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

export function createDispatchApproveTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Approve a human-in-the-loop task that is paused awaiting approval. " +
      "Transitions the task to completed and notifies the parent. " +
      "Only tasks in 'awaiting_approval' state can be approved.",
    args: {
      task_id: z
        .string()
        .describe("The task ID of the awaiting_approval task to approve"),
    },
    async execute(input) {
      const approved = await manager.approveTask(input.task_id);
      if (!approved) {
        return [
          "Task could not be approved.",
          "",
          `Task ID: ${input.task_id}`,
          "Ensure the task exists and is in 'awaiting_approval' state.",
        ].join("\n");
      }
      return [
        "Task approved and completed.",
        "",
        `Task ID: ${input.task_id}`,
        "The parent session has been notified.",
      ].join("\n");
    },
  });
}

export function createDispatchRejectTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Reject a human-in-the-loop task that is paused awaiting approval. " +
      "Transitions the task to error with the provided reason. " +
      "Only tasks in 'awaiting_approval' state can be rejected.",
    args: {
      task_id: z
        .string()
        .describe("The task ID of the awaiting_approval task to reject"),
      reason: z
        .string()
        .optional()
        .describe("Optional reason for the rejection"),
    },
    async execute(input) {
      const rejected = await manager.rejectTask(input.task_id, input.reason);
      if (!rejected) {
        return [
          "Task could not be rejected.",
          "",
          `Task ID: ${input.task_id}`,
          "Ensure the task exists and is in 'awaiting_approval' state.",
        ].join("\n");
      }
      return [
        "Task rejected.",
        "",
        `Task ID: ${input.task_id}`,
        input.reason ? `Reason: ${input.reason}` : "",
        "The parent session has been notified.",
      ].filter(Boolean).join("\n");
    },
  });
}

export function createDispatchMetricsTool() {
  return defineTool({
    description:
      "Retrieve runtime metrics snapshot for the dispatch subsystem — counters, gauges, and histograms. Returns a human-readable summary or JSON. Optionally exports the snapshot JSON to a file.",
    args: {
      format: z
        .enum(["summary", "json"])
        .optional()
        .default("summary")
        .describe("Output format: 'summary' for human-readable, 'json' for machine parsing"),
      export_path: z
        .string()
        .optional()
        .describe("Optional file path to write the snapshot JSON atomically. Falls back to ROLEBOX_METRICS_EXPORT env var."),
    },
    async execute(input) {
      const snap = metrics.snapshot();
      const jsonStr = JSON.stringify(snap, null, 2);

      // Export to file if requested (arg takes precedence over env var)
      const exportPath = input.export_path || process.env.ROLEBOX_METRICS_EXPORT;
      if (exportPath) {
        const tmpPath = exportPath + ".tmp";
        writeFileSync(tmpPath, jsonStr, "utf-8");
        renameSync(tmpPath, exportPath);
      }

      if (input.format === "json") {
        return jsonStr;
      }

      // Build human-readable summary
      const lines: string[] = ["## Dispatch Metrics", ""];

      // Counters
      const counterKeys = Object.keys(snap.counters);
      if (counterKeys.length > 0) {
        lines.push("### Counters");
        for (const key of counterKeys) {
          lines.push(`  ${key}: ${snap.counters[key].value}`);
        }
        lines.push("");
      }

      // Gauges
      const gaugeKeys = Object.keys(snap.gauges);
      if (gaugeKeys.length > 0) {
        lines.push("### Gauges");
        for (const key of gaugeKeys) {
          lines.push(`  ${key}: ${snap.gauges[key].value}`);
        }
        lines.push("");
      }

      // Histograms
      const histKeys = Object.keys(snap.histograms);
      if (histKeys.length > 0) {
        lines.push("### Histograms");
        for (const key of histKeys) {
          const h = snap.histograms[key];
          lines.push(`  ${key}: count=${h.count} sum=${h.sum}`);
          const bucketEntries = Object.entries(h.buckets).filter(([, v]) => v > 0);
          if (bucketEntries.length > 0) {
            for (const [b, v] of bucketEntries) {
              lines.push(`    ≤${b}ms: ${v}`);
            }
          }
        }
        lines.push("");
      }

      if (counterKeys.length === 0 && gaugeKeys.length === 0 && histKeys.length === 0) {
        lines.push("  (no metrics recorded — ROLEBOX_METRICS may be disabled)");
        lines.push("");
      }

      lines.push("Labels follow low-cardinality conventions (agent id, status, concurrency key).");
      return lines.join("\n");
    },
  });
}

export function createDispatchBudgetTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Retrieve token/cost budget status for the current dispatch request. " +
      "Shows configured limits, current usage, remaining budget, and percentage used. " +
      "The orchestrator agent can call this to check remaining budget before dispatching more tasks.",
    args: {
      parent_session_id: z
        .string()
        .optional()
        .describe("Parent session ID to query budget for (defaults to current session)"),
    },
    async execute(input, context) {
      const parentSessionId = input.parent_session_id || context.sessionID;
      return manager.getBudgetStatus(parentSessionId);
    },
  });
}
