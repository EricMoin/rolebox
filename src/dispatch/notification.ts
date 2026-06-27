import type { OpencodeClient } from "@opencode-ai/sdk";
import type { DispatchTask, NotificationPayload } from "./types.ts";
import { createSubLogger } from "../logger.ts";
import { metrics } from "./metrics.ts";

const log = createSubLogger("dispatch:notify");

// ── Retry / idempotency constants ───────────────────────────────────

export const NOTIFY_MAX_RETRIES = 3;
export const NOTIFY_BASE_DELAY_MS = 500;
export const NOTIFY_MAX_DELAY_MS = 5000;

export interface NotifyOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Per-parent-session queue for serializing notification sends. */
const parentQueues = new Map<string, Promise<boolean>>();

/** Tracks taskIds for which a final notification has already been sent. */
const sentFinalNotifies = new Set<string>();

export function clearSentFinalNotifies(): void {
  sentFinalNotifies.clear();
}

export function clearParentQueues(): void {
  parentQueues.clear();
}

export function hasFinalNotifyBeenSent(taskId: string): boolean {
  return sentFinalNotifies.has(taskId);
}

function enqueueNotify(
  parentSessionId: string,
  fn: () => Promise<boolean>,
): Promise<boolean> {
  const prev = parentQueues.get(parentSessionId) ?? Promise.resolve(true);
  const next = prev.then(() => fn(), () => fn()).catch((err) => {
    metrics.counter("notify_failed_total").inc();
    log.warn("notify chain error", err instanceof Error ? err.message : String(err));
    return false;
  });
  next.finally(() => {
    if (parentQueues.get(parentSessionId) === next) {
      parentQueues.delete(parentSessionId);
    }
  });
  parentQueues.set(parentSessionId, next);
  return next;
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
  remainingProvider: (() => number) | number,
  opts?: NotifyOpts,
): Promise<boolean> {
  const maxRetries = opts?.maxRetries ?? NOTIFY_MAX_RETRIES;
  const baseDelayMs = opts?.baseDelayMs ?? NOTIFY_BASE_DELAY_MS;
  const maxDelayMs = opts?.maxDelayMs ?? NOTIFY_MAX_DELAY_MS;

  const isTaskFailure = task.status === "error" || task.status === "cancelled" || task.status === "timeout";

  const doNotify = async (): Promise<boolean> => {
    const remainingCount = typeof remainingProvider === "function"
      ? remainingProvider()
      : remainingProvider;
    const duration = computeDuration(task.startedAt, task.completedAt);

    const payload: NotificationPayload = {
      taskId: task.id,
      description: task.description,
      duration,
      status: task.status,
      remainingTasks: remainingCount,
    };

    const text = buildNotificationText(payload);
    const shouldReply = remainingCount === 0 || isTaskFailure;

    if (shouldReply) {
      if (sentFinalNotifies.has(task.id)) {
        return true;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await client.session.promptAsync({
            path: { id: task.parentSessionId },
            body: {
              parts: [{ type: "text", text }],
              noReply: false,
            },
          });
          metrics.counter("notify_sent_total").inc();
          sentFinalNotifies.add(task.id);
          return true;
        } catch (err) {
          lastError = err;
          if (attempt < maxRetries) {
            metrics.counter("notify_retry_total").inc();
            const delay = Math.min(
              baseDelayMs * Math.pow(2, attempt),
              maxDelayMs,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      metrics.counter("notify_failed_total").inc();
      log.warn(
        `Failed to notify parent session ${task.parentSessionId} about task ${task.id}`,
        lastError,
      );
      return false;
    } else {
      try {
        await client.session.promptAsync({
          path: { id: task.parentSessionId },
          body: {
            parts: [{ type: "text", text }],
            noReply: true,
          },
        });
        metrics.counter("notify_sent_total").inc();
        return false;
      } catch (err) {
        metrics.counter("notify_failed_total").inc();
        log.warn(
          `Failed to notify parent session ${task.parentSessionId} about task ${task.id}`,
          err,
        );
        return false;
      }
    }
  };

  return enqueueNotify(task.parentSessionId, doNotify);
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
