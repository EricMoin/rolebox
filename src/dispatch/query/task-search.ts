import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { DispatchTask } from "../types.ts";
import { readResultSidecar, extractResultBlock, resultSidecarPath } from "../completion/result-extractor.ts";
import { formatDuration } from "./format-utils.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task:search");

export function createTaskSearchTool(
  dispatchManager: DispatchManager,
  directory: string,
) {
  return defineTool({
    description:
      "Search dispatch task history by query text, status, agent, or date range. Searches task prompt, description, and agent name. Returns a markdown table of matching tasks with status, duration, and optional result preview. Rolebox-specific: the opencode platform has no native task search with status/query filtering.",
    args: {
      query: z
        .string()
        .min(1)
        .describe("Search query — matched against task prompt, description, and agent name (case-insensitive substring)"),
      status: z
        .enum(["pending", "running", "completed", "awaiting_approval", "error", "cancelled", "timeout"])
        .optional()
        .describe("Filter by task status"),
      agent: z
        .string()
        .optional()
        .describe("Filter by sub-agent name (exact match)"),
      parent_session: z
        .string()
        .optional()
        .describe("Only search tasks dispatched from this parent session ID"),
      from_date: z
        .string()
        .optional()
        .describe("ISO 8601 — only tasks started after this date"),
      to_date: z
        .string()
        .optional()
        .describe("ISO 8601 — only tasks started before this date"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
      include_result: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include a truncated preview of the task result text (first 200 chars)"),
    },
    async execute(input) {
      const tasks = dispatchManager.getAllTasks();

      if (tasks.length === 0) {
        return "No dispatch tasks found.";
      }

      const query = input.query.toLowerCase();

      // Filter by query (search prompt, description, agent)
      let filtered = tasks.filter((t) => {
        const searchText = [
          t.prompt ?? "",
          t.description ?? "",
          t.agent ?? "",
        ].join(" ").toLowerCase();
        return searchText.includes(query);
      });

      // Filter by status
      if (input.status) {
        filtered = filtered.filter((t) => t.status === input.status);
      }

      // Filter by agent
      if (input.agent) {
        filtered = filtered.filter((t) => t.agent === input.agent);
      }

      // Filter by parent session
      if (input.parent_session) {
        filtered = filtered.filter((t) => t.parentSessionId === input.parent_session);
      }

      // Filter by date range (compare against startedAt)
      if (input.from_date) {
        const fromMs = new Date(input.from_date).getTime();
        if (!isNaN(fromMs)) {
          filtered = filtered.filter((t) => t.startedAt.getTime() >= fromMs);
        }
      }
      if (input.to_date) {
        const toMs = new Date(input.to_date).getTime();
        if (!isNaN(toMs)) {
          filtered = filtered.filter((t) => t.startedAt.getTime() <= toMs);
        }
      }

      // Sort by startedAt descending (most recent first)
      filtered.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

      // Apply limit
      const limited = filtered.slice(0, input.limit ?? 20);

      if (limited.length === 0) {
        return `No tasks matching "${input.query}".`;
      }

      // Format output
      const header = "| Task ID | Agent | Status | Started | Duration | Description |" +
        (input.include_result ? " Result Preview |" : "") +
        "\n|---|---|---|---|---|---|" +
        (input.include_result ? "---|" : "");

      const rows = limited.map(async (t) => {
        const duration = formatDuration(t);
        const desc = (t.description ?? t.prompt ?? "").slice(0, 60);
        let row = `| ${t.id} | ${t.agent} | ${t.status} | ${formatDate(t.startedAt)} | ${duration} | ${desc} |`;
        if (input.include_result) {
          const preview = await getResultPreview(t, directory);
          row += ` ${preview} |`;
        }
        return row;
      });

      const resolvedRows = await Promise.all(rows);

      return `## Task Search Results: "${input.query}"\n\nFound ${filtered.length} matching task(s)${filtered.length > limited.length ? ` (showing first ${limited.length})` : ""}.\n\n${header}\n${resolvedRows.join("\n")}`;
    },
  });
}
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function getResultPreview(task: DispatchTask, directory: string): Promise<string> {
  try {
    // Try to read from sidecar if result was materialized
    if (task.result?.sidecarPath) {
      const text = readResultSidecar(task.result.sidecarPath);
      if (text) {
        const extracted = extractResultBlock(text);
        const preview = extracted.result.slice(0, 200);
        return preview.length === 200 ? preview + "..." : preview;
      }
    }
    // Fallback: try the standard sidecar path
    const sidecarPath = resultSidecarPath(task.id, directory);
    const text = readResultSidecar(sidecarPath);
    if (text) {
      const extracted = extractResultBlock(text);
      const preview = extracted.result.slice(0, 200);
      return preview.length === 200 ? preview + "..." : preview;
    }
    return "(no result)";
  } catch (err) {
    log.warn("Failed to read result preview", { taskId: task.id, error: String(err) });
    return "(error reading result)";
  }
}
