/**
 * Progress tools: dispatch_progress and dispatch_stream.
 *
 * - `dispatch_progress` — called by subagents to emit incremental progress
 *   events during task execution. Crosses 25/50/75/100% thresholds to
 *   send milestone notifications to the parent session.
 * - `dispatch_stream` — called by parent sessions to query accumulated
 *   progress events for a running task.
 */

import { defineTool, type CanonicalToolContext } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { ProgressEvent } from "../types.progress.ts";
import { createSubLogger } from "../../logger.ts";
import { DISPATCH_PROGRESS_MILESTONE_MARKER } from "../notification.ts";

const log = createSubLogger("dispatch:progress-tools");

// ── Milestone thresholds ────────────────────────────────────────────────

const MILESTONE_THRESHOLDS = [25, 50, 75, 100] as const;

/** Per-task set of already-emitted milestone thresholds. */
const emittedThresholds = new Map<string, Set<number>>();

/**
 * Determine which milestones a percentage crosses that have not yet been
 * emitted for the given task. Returns the newly crossed thresholds in
 * ascending order.
 */
function findNewMilestones(taskId: string, percentage: number): number[] {
  let emitted = emittedThresholds.get(taskId);
  if (!emitted) {
    emitted = new Set();
    emittedThresholds.set(taskId, emitted);
  }

  const newMilestones: number[] = [];
  for (const t of MILESTONE_THRESHOLDS) {
    if (percentage >= t && !emitted.has(t)) {
      newMilestones.push(t);
      emitted.add(t);
    }
  }
  return newMilestones;
}

/**
 * Build a `<system-reminder>` progress milestone text.
 */
function buildMilestoneText(
  taskId: string,
  percentage: number,
  stage: string,
  message: string,
  description?: string,
): string {
  const label = description || taskId;
  return [
    "<system-reminder>",
    DISPATCH_PROGRESS_MILESTONE_MARKER,
    `**Progress Milestone:** ${percentage}%`,
    `**Task ID:** ${taskId}`,
    `**Description:** ${label}`,
    `**Stage:** ${stage}`,
    `**Message:** ${message}`,
    "",
    "This is an incremental progress update — the task is still running.",
    "Use dispatch_stream(task_id=\"" + taskId + "\") to retrieve all progress events.",
    "</system-reminder>",
  ].join("\n");
}

/** Clean up emitted-threshold tracking for a task (called when progress is cleared). */
export function clearEmittedThresholds(taskId: string): void {
  emittedThresholds.delete(taskId);
}

/** Clean up all emitted-threshold tracking (for testing or reset). */
export function clearAllEmittedThresholds(): void {
  emittedThresholds.clear();
}

// ── Tool 1: dispatch_progress ──────────────────────────────────────────

export function createDispatchProgressTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Emit a progress event during task execution. Subagents call this to report " +
      "incremental progress (stage, percentage, message) back to the parent session. " +
      "When percentage crosses 25/50/75/100% thresholds, a milestone notification " +
      "is also sent to the parent session.",
    args: {
      task_id: z
        .string()
        .describe("The task ID to report progress for"),
      percentage: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Optional completion percentage (0–100). When absent, progress is reported " +
          "without a percentage milestone",
        ),
      stage: z
        .string()
        .min(1)
        .describe("Current stage label (e.g., 'researching', 'implementing', 'verifying')"),
      message: z
        .string()
        .min(1)
        .describe("Human-readable progress message"),
    },
    async execute(input, _context: CanonicalToolContext) {
      const store = manager.getProgressStore();
      const task = manager.getTask(input.task_id);

      // Create the progress event
      const event: ProgressEvent = {
        task_id: input.task_id,
        percentage: input.percentage,
        stage: input.stage,
        message: input.message,
        timestamp: new Date().toISOString(),
      };

      store.addProgressEvent(input.task_id, event);

      // Check milestone thresholds
      if (input.percentage !== undefined) {
        const newMilestones = findNewMilestones(input.task_id, input.percentage);
        for (const milestone of newMilestones) {
          const desc = task?.description || task?.prompt?.slice(0, 60);
          const text = buildMilestoneText(
            input.task_id,
            milestone,
            input.stage,
            input.message,
            desc,
          );

          // Send the milestone notification to the parent session
          // Uses manager internal client — fire-and-forget, errors are logged
          manager.sendProgressMilestone(input.task_id, text).catch((err) => {
            log.warn("Failed to send progress milestone", {
              taskId: input.task_id,
              milestone,
              err,
            });
          });
        }
      }

      // Build confirmation message
      const pctPart = input.percentage !== undefined ? ` (${input.percentage}%)` : "";
      return `Progress recorded: ${input.stage}${pctPart}`;
    },
  });
}

// ── Tool 2: dispatch_stream ────────────────────────────────────────────

export function createDispatchStreamTool(manager: DispatchManager) {
  return defineTool({
    description:
      "Query accumulated progress events for a running or completed task. " +
      "Returns events in chronological order. Optionally filter to events " +
      "after an ISO timestamp to support incremental polling.",
    args: {
      task_id: z
        .string()
        .describe("The task ID to query progress events for"),
      since: z
        .string()
        .optional()
        .describe(
          "Optional ISO 8601 timestamp — only returns events after this timestamp. " +
          "Useful for incremental polling to avoid re-fetching already-seen events.",
        ),
    },
    async execute(input, _context: CanonicalToolContext) {
      const store = manager.getProgressStore();
      const stream = store.getProgressStream(input.task_id, input.since);

      if (stream.length === 0) {
        const task = manager.getTask(input.task_id);
        if (!task) {
          return `No progress events found for task '${input.task_id}'. The task may not exist or progress data may have been cleaned up.`;
        }
        return `No progress events since the given timestamp for task '${input.task_id}'.`;
      }

      // Format as a markdown table
      const rows: string[] = [
        `## Progress Events for \`${input.task_id}\``,
        "",
        "| Timestamp | Stage | % | Message |",
        "|-----------|-------|---|---------|",
      ];

      for (const evt of stream) {
        const shortTs = evt.timestamp.replace("T", " ").slice(0, 23);
        const pct = evt.percentage !== undefined ? String(evt.percentage) : "—";
        // Escape pipe characters in message
        const safeMsg = evt.message.replace(/\|/g, "\\|");
        rows.push(`| ${shortTs} | ${evt.stage} | ${pct} | ${safeMsg} |`);
      }

      rows.push("");
      rows.push(`_${stream.length} event(s) returned._`);
      return rows.join("\n");
    },
  });
}
