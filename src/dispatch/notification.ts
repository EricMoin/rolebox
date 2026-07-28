import type { ISessionClient } from "../platform/ports/session-client.ts";
import type { DispatchTask, NotificationPayload } from "./types.ts";
import { createSubLogger } from "../logger.ts";
import { metrics } from "./persistence/metrics.ts";
import { buildReminder, type ReminderField } from "../prompt/reminder.ts";

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

// Markers for `<system-reminder>` messages the dispatch subsystem injects into a
// PARENT session. They re-enter the chat.message hook and must NOT count as
// genuine user turns — otherwise the auto-continue counter resets and loops get
// cancelled (unbounded auto-continue spin). Keep in sync with every
// parent-targeted reminder the subsystem emits.
export const DISPATCH_COMPLETION_MARKER = "[BACKGROUND TASK COMPLETED]";
export const DISPATCH_ALL_COMPLETE_MARKER = "[ALL BACKGROUND TASKS COMPLETE]";
export const DISPATCH_RECOVERY_MARKER = "[RECOVERY: PENDING TASKS DROPPED]";
export const DISPATCH_PROGRESS_MILESTONE_MARKER = "[PROGRESS MILESTONE]";
/**
 * Marker for graph-node-completion reminders injected into the emperor session
 * by the graph notifier (`src/graph/engine/graph-notify.ts`). Like every other
 * parent-targeted reminder, it is part of {@link DISPATCH_NOTIFICATION_MARKERS}
 * so the re-entering chat.message hook recognizes it as a non-user turn and does
 * NOT reset the auto-continue counter.
 */
export const GRAPH_COMPLETION_MARKER = "[GRAPH NODE COMPLETED]";
/**
 * Marker for graph-terminal reminders (GRAPH COMPLETE) injected into the emperor
 * session by the graph terminal notifier (`src/graph/engine/graph-notify.ts`).
 * Like every other parent-targeted reminder, it is part of
 * {@link DISPATCH_NOTIFICATION_MARKERS} so the re-entering chat.message hook
 * recognizes it as a non-user turn.
 */
export const GRAPH_COMPLETE_MARKER = "[GRAPH COMPLETE]";
/**
 * Marker for graph-terminal reminders (GRAPH BLOCKED) injected into the emperor
 * session by the graph terminal notifier (`src/graph/engine/graph-notify.ts`).
 * Distinct from GRAPH_COMPLETE_MARKER so a graph that is blocked-then-resumed-then-completed
 * produces two distinct terminal reminders with different markers.
 */
export const GRAPH_BLOCKED_MARKER = "[GRAPH BLOCKED]";

export const DISPATCH_NOTIFICATION_MARKERS = [
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
  DISPATCH_PROGRESS_MILESTONE_MARKER,
  GRAPH_COMPLETION_MARKER,
  GRAPH_COMPLETE_MARKER,
  GRAPH_BLOCKED_MARKER,
] as const;

export function isDispatchNotification(text: string): boolean {
  return DISPATCH_NOTIFICATION_MARKERS.some((m) => text.includes(m));
}

/** Per-parent-session queue for serializing notification sends. */
const parentQueues = new Map<string, Promise<boolean>>();

/** Tracks taskIds for which a final notification has already been sent. */
const sentFinalNotifies = new Set<string>();

export function clearSentFinalNotifies(): void {
  sentFinalNotifies.clear();
}

export function seedSentFinalNotifies(ids: Iterable<string>): void {
  for (const id of ids) {
    sentFinalNotifies.add(id);
  }
}

export function getSentFinalNotifies(): Set<string> {
  return sentFinalNotifies;
}

export function clearParentQueues(): void {
  parentQueues.clear();
}

export function hasFinalNotifyBeenSent(taskId: string): boolean {
  return sentFinalNotifies.has(taskId);
}

export function enqueueNotify(
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
    // Intermediate: single task completed, more remain
    return buildReminder({
      marker: DISPATCH_COMPLETION_MARKER,
      fields: [
        { label: "task", value: payload.taskId },
        { label: "desc", value: payload.description || "N/A" },
        { label: "dur", value: duration },
        { label: "status", value: payload.status },
      ],
      action: `${payload.remainingTasks} task(s) still in progress. You'll be notified when all complete.`,
    });
  }

  // Final notification
  const fields: ReminderField[] = [
    { label: "task", value: label },
    { label: "dur", value: duration },
  ];

  if (payload.resultText) {
    const MAX_INLINE_CHARS = 4000;
    const truncated = payload.resultText.length > MAX_INLINE_CHARS
      ? payload.resultText.slice(0, MAX_INLINE_CHARS) + "\n\n[... result truncated, use graph_status for full content ...]"
      : payload.resultText;

    return buildReminder({
      marker: DISPATCH_ALL_COMPLETE_MARKER,
      fields,
      action: `Use graph_status(node_id="${payload.taskId}", include_output=true) to retrieve the full result or paginate.`,
      body: ["```result", truncated, "```"].join("\n"),
    });
  }

  return buildReminder({
    marker: DISPATCH_ALL_COMPLETE_MARKER,
    fields,
    action: "All background tasks have finished. You may continue.",
  });
}

/**
 * Send `<system-reminder>` to parent session via `promptAsync`.
 * Serialized per parent session to prevent race conditions.
 * `noReply: true` for intermediate; `noReply: false` for final.
 */
export async function notifyParent(
  client: ISessionClient,
  task: DispatchTask,
  remainingProvider: (() => number) | number,
  opts?: NotifyOpts,
  resultText?: string,
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
      resultText,
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
          await client.prompt(task.parentSessionId, {
            ...(task.parentAgent ? { agent: task.parentAgent } : {}),
            parts: [{ type: "text", text }],
            noReply: false,
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
        await client.prompt(task.parentSessionId, {
          ...(task.parentAgent ? { agent: task.parentAgent } : {}),
          parts: [{ type: "text", text }],
          noReply: true,
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
