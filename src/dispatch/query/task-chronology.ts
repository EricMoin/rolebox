import { defineTool } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { DispatchTaskStatus } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("task-chronology");

const STATUS_COLUMNS: DispatchTaskStatus[] = [
  "pending",
  "running",
  "completed",
  "awaiting_approval",
  "error",
  "cancelled",
  "timeout",
];
function bucketKey(task: { startedAt: Date; agent: string }, groupBy: "hour" | "day" | "agent"): string {
  switch (groupBy) {
    case "hour": {
      const d = task.startedAt;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hour = String(d.getHours()).padStart(2, "0");
      return `${year}-${month}-${day}T${hour}:00`;
    }
    case "day": {
      const d = task.startedAt;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    case "agent":
      return task.agent;
  }
}

function buildTable(
  buckets: Array<{
    key: string;
    count: number;
    statusCounts: Record<DispatchTaskStatus, number>;
  }>,
  groupBy: "hour" | "day" | "agent",
  fromDate: string | undefined,
  toDate: string | undefined,
): string {
  const lines: string[] = [
    "## Task Chronology",
    "",
    `Grouped by: ${groupBy}`,
    `Range: ${fromDate || "beginning"} to ${toDate || "now"}`,
    "",
  ];

  // Header row
  const header = ["Bucket", "Count", ...STATUS_COLUMNS.map((s) => s.charAt(0).toUpperCase() + s.slice(1))];
  const separator = ["--------", "-------", ...STATUS_COLUMNS.map(() => "---------")];

  lines.push("| " + header.join(" | ") + " |");
  lines.push("| " + separator.join(" | ") + " |");

  for (const b of buckets) {
    const row = [
      b.key,
      String(b.count),
      ...STATUS_COLUMNS.map((s) => String(b.statusCounts[s])),
    ];
    lines.push("| " + row.join(" | ") + " |");
  }

  return lines.join("\n");
}

export function createTaskChronologyTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Show time-bucketed task activity. Returns a markdown table grouped by hour, day, or agent with status distribution counts.",
    args: {
      from_date: z
        .string()
        .optional()
        .describe("ISO 8601 — filter tasks started from this date"),
      to_date: z
        .string()
        .optional()
        .describe("ISO 8601 — filter tasks started until this date"),
      group_by: z
        .enum(["hour", "day", "agent"])
        .optional()
        .default("hour")
        .describe("Bucket grouping"),
    },
    async execute(input) {
      const allTasks = manager.getAllTasks();
      if (allTasks.length === 0) {
        return "No tasks found.";
      }

      // Parse date filters
      const fromDate = input.from_date ? new Date(input.from_date) : undefined;
      const toDate = input.to_date ? new Date(input.to_date) : undefined;

      // Filter by date range
      const filtered = allTasks.filter((task) => {
        if (fromDate && task.startedAt < fromDate) return false;
        if (toDate && task.startedAt > toDate) return false;
        return true;
      });

      if (filtered.length === 0) {
        return "No tasks in the specified date range.";
      }

      const bucketMap = new Map<
        string,
        { count: number; statusCounts: Record<DispatchTaskStatus, number> }
      >();

      for (const task of filtered) {
        const key = bucketKey(task, input.group_by ?? "hour");
        if (!bucketMap.has(key)) {
          bucketMap.set(key, {
            count: 0,
            statusCounts: {
              pending: 0,
              running: 0,
              completed: 0,
              awaiting_approval: 0,
              error: 0,
              cancelled: 0,
              timeout: 0,
            },
          });
        }
        const bucket = bucketMap.get(key)!;
        bucket.count++;
        bucket.statusCounts[task.status]++;
      }
      // Sort: chronologically for hour/day, alphabetically for agent
      const entries = [...bucketMap.entries()];
      if (input.group_by === "agent") {
        entries.sort(([a], [b]) => a.localeCompare(b));
      } else {
        entries.sort(([a], [b]) => a.localeCompare(b));
      }

      const buckets = entries.map(([key, data]) => ({
        key,
        count: data.count,
        statusCounts: data.statusCounts,
      }));

      return buildTable(buckets, input.group_by ?? "hour", input.from_date, input.to_date);
    },
  });
}
