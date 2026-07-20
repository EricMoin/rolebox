import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { DispatchTask } from "../types.ts";
import { formatDurationBetween } from "./format-utils.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task:export");

export function createTaskExportTool(
  manager: DispatchManager,
  directory: string,
) {
  return defineTool({
    description: "Export a completed task's full result to a file. Rolebox-specific: the opencode platform has no native per-task export mechanism.",
    args: {
      task_id: z.string().describe("Task ID to export"),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .default("markdown")
        .describe("Output format"),
      output_path: z.string().describe("File path relative to project root (worktree)"),
      include_prompt: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include the task prompt in output"),
      include_messages: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include full session messages (not just result fence)"),
    },
    async execute(input, context) {
      const taskId = input.task_id;

      // Step 1: Fetch task metadata
      const task = manager.getTask(taskId);

      // Step 2: Fetch result
      const result = await manager.getResult(taskId);

      // Step 3: Handle error cases
      if (result.kind === "not_found") {
        return `Task not found: ${taskId}`;
      }
      if (result.kind === "expired") {
        return `Task result expired: ${taskId}`;
      }
      if (result.kind === "fetch_error") {
        return `Task result fetch error: ${result.error}`;
      }

      // Step 4: Build metadata — if task is null but result is ok (sidecar survival),
      // construct a minimal metadata object
      const meta: {
        id: string;
        agent: string;
        description: string | undefined;
        status: string;
        startedAt: Date;
        completedAt: Date | undefined;
        prompt: string | undefined;
      } = task
        ? {
            id: task.id,
            agent: task.agent,
            description: task.description,
            status: task.status,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            prompt: task.prompt,
          }
        : {
            id: taskId,
            agent: "unknown",
            description: undefined,
            status: "completed",
            startedAt: new Date(0),
            completedAt: undefined,
            prompt: undefined,
          };

      // Step 5: Build output content
      const resultContent = result.resultText || result.text || "";

      let content: string;
      if (input.format === "json") {
        content = JSON.stringify(
          {
            task_id: meta.id,
            agent: meta.agent,
            description: meta.description ?? null,
            status: meta.status,
            started_at: meta.startedAt.toISOString(),
            completed_at: meta.completedAt?.toISOString() ?? null,
            prompt: input.include_prompt ? (meta.prompt ?? null) : null,
            result: resultContent,
          },
          null,
          2,
        );
      } else {
        // Markdown format
        const duration = meta.completedAt
          ? formatDurationBetween(meta.startedAt, meta.completedAt)
          : "N/A";

        const lines: string[] = [];
        lines.push("# Task Export");
        lines.push("");
        lines.push(`- **Task ID:** ${meta.id}`);
        lines.push(`- **Agent:** ${meta.agent}`);
        lines.push(`- **Description:** ${meta.description || "N/A"}`);
        lines.push(`- **Status:** ${meta.status}`);
        lines.push(`- **Started:** ${meta.startedAt.toISOString()}`);
        lines.push(`- **Completed:** ${meta.completedAt?.toISOString() || "N/A"}`);
        lines.push(`- **Duration:** ${duration}`);
        lines.push("");

        if (input.include_prompt && meta.prompt) {
          lines.push("## Prompt");
          lines.push("");
          lines.push(meta.prompt);
          lines.push("");
        }

        lines.push("## Result");
        lines.push("");
        lines.push(resultContent);

        content = lines.join("\n");
      }

      // Step 6: Resolve output path against worktree
      const fullPath = resolve(
        context.worktree || context.directory || ".",
        input.output_path,
      );

      // Path traversal guard: reject paths that escape the project root
      const root = resolve(context.worktree || context.directory || ".");
      const rel = relative(root, fullPath);
      if (rel.startsWith("..")) {
        return `Error: Path traversal detected — "${input.output_path}" resolves outside the project root`;
      }

      const dir = dirname(fullPath);

      // Step 7: Write atomically
      mkdirSync(dir, { recursive: true });
      const tmpPath = fullPath + ".tmp";
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, fullPath);

      // Step 8: Return confirmation
      return `Exported task ${taskId} to ${fullPath} (${content.length} chars, ${input.format} format)`;
    },
  });
}
