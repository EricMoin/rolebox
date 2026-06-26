import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchTask, NotificationPayload } from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("dispatch:notify");

/** Per-parent-session queue for serializing notification sends. */
const parentQueues = new Map<string, Promise<void>>();

function enqueueNotify(
  parentSessionId: string,
  fn: () => Promise<void>,
): void {
  const prev = parentQueues.get(parentSessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // chain even if previous failed
  next.finally(() => {
    if (parentQueues.get(parentSessionId) === next) {
      parentQueues.delete(parentSessionId);
    }
  });
  parentQueues.set(parentSessionId, next);
}

/**
 * Build `<system-reminder>` XML for a completed background task.
 * Uses intermediate format when tasks remain, final format when all done.
 */
export function buildNotificationText(payload: NotificationPayload): string {
  const label = payload.description || payload.taskId;
  const duration = payload.duration;

  if (payload.remainingTasks > 0) {
    return [
      "<system-reminder>",
      "[BACKGROUND TASK COMPLETED]",
      `**ID:** ${payload.taskId}`,
      `**Description:** ${payload.description || "N/A"}`,
      `**Duration:** ${duration}`,
      `**Status:** ${payload.status}`,
      "",
      `${payload.remainingTasks} task(s) still in progress. You'll be notified when all complete.`,
      "</system-reminder>",
    ].join("\n");
  }

  return [
    "<system-reminder>",
    "[ALL BACKGROUND TASKS COMPLETE]",
    "**Completed:**",
    `- ${label} (${duration})`,
    "",
    "All background tasks have finished. You may continue.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * Send `<system-reminder>` to parent session via `promptAsync`.
 * Serialized per parent session to prevent race conditions.
 * `noReply: true` for intermediate; `noReply: false` for final.
 */
export async function notifyParent(
  client: OpencodeClient,
  task: DispatchTask,
  remainingCount: number,
): Promise<void> {
  const duration = computeDuration(task.startedAt, task.completedAt);

  const payload: NotificationPayload = {
    taskId: task.id,
    description: task.description,
    duration,
    status: task.status,
    remainingTasks: remainingCount,
  };

  const text = buildNotificationText(payload);
  const isTaskFailure = task.status === "error" || task.status === "cancelled" || task.status === "timeout";
  const shouldReply = remainingCount === 0 || isTaskFailure;

  const doNotify = async (): Promise<void> => {
    try {
      await client.session.promptAsync({
        path: { id: task.parentSessionId },
        body: {
          parts: [{ type: "text", text }],
          noReply: !shouldReply,
        },
      });
    } catch (err) {
      log.warn(
        `Failed to notify parent session ${task.parentSessionId} about task ${task.id}`,
        err,
      );
    }
  };

  enqueueNotify(task.parentSessionId, doNotify);
}

function computeDuration(start: Date, end?: Date): string {
  const endTime = end ?? new Date();
  const ms = endTime.getTime() - start.getTime();
  if (ms < 0) return "0s";

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}
