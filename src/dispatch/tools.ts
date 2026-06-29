import fs from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { DispatchManager } from "./manager.ts";
import type { DispatchInput, DispatchTask } from "./types.ts";
import { metrics } from "./metrics.ts";
import {
  applyWindow,
  spillToFile,
  formatResultEnvelope,
  DEFAULT_MAX_RESULT_CHARS,
} from "./result-extractor.ts";
import { getDataDir } from "../cli/paths.ts";

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
  resolvedSubagents: Map<string, { parentFullId: string }>,
  _subagentModelKey?: Map<string, string>,
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

      const result = await manager.executeSync(dispatchInput, parentCtx);

      return result;
    },
  });
}

function buildCompletedOutput(
  task: DispatchTask,
  result: { text: string; resultText: string; totalChars: number },
  opts: { maxChars: number; offset?: number; limit?: number; tail?: boolean },
  dir: string,
): string {
  const header = [
    "Task Result\n",
    `Task ID: ${task.id}`,
    `Description: ${task.description || "N/A"}`,
    `Duration: ${formatDuration(task)}`,
    `Session ID: ${task.sessionId}`,
    "",
    "---\n",
  ].join("\n");

  const windowed = applyWindow(result.resultText, opts);

  let spillPath: string | undefined;
  if (result.totalChars > opts.maxChars) {
    spillPath = spillToFile(task.id, result.text, dir);
  }

  const envelope = formatResultEnvelope({
    truncated: windowed.truncated,
    returnedChars: windowed.returnedChars,
    totalChars: windowed.totalChars,
    nextOffset: windowed.nextOffset,
    spilledFile: spillPath,
  });

  return header + windowed.text + "\n" + envelope;
}

export function createDispatchOutputTool(manager: DispatchManager) {
  return tool({
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
        const result = await manager.getResult(input.task_id);
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
        const result = await manager.getResult(input.task_id);
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
          `Description: ${task.description || "N/A"}`,
          `Status: ${task.status}`,
          task.error ? `Error: ${task.error}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const lines = [
        "Task Status\n",
        `Task ID: ${task.id}`,
        `Description: ${task.description || "N/A"}`,
        `Status: ${task.status}`,
        "",
        "Task is still running. Do NOT poll dispatch_output repeatedly.",
        "You will receive a <system-reminder> notification when this task completes.",
        "Wait for the notification, then call dispatch_output to retrieve results.",
      ];

      return lines.join("\n");
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

export function createDispatchMetricsTool() {
  return tool({
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
        fs.writeFileSync(tmpPath, jsonStr, "utf-8");
        fs.renameSync(tmpPath, exportPath);
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
