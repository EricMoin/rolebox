// ── Idle Notification Scheduler ──────────────────────────────────────────
//
// Manages debounced idle notification timers with race-condition prevention.
// Each session gets a version counter so stale timer callbacks (from activity
// that arrived after scheduling) are silently discarded.

import {
  DEFAULT_NOTIFICATION_IDLE_DELAY_MS,
  DEFAULT_NOTIFICATION_ACTIVITY_GRACE_MS,
  DEFAULT_NOTIFICATION_MAX_TRACKED_SESSIONS,
} from "../constants.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("NotificationScheduler");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `NotificationScheduler` with defaults pulled from constants.
 * All fields are optional — omitted fields use the project-level defaults.
 */
export function createScheduler(
  config?: Partial<{
    idleDelayMs: number;
    activityGracePeriodMs: number;
    maxTrackedSessions: number;
  }>,
): NotificationScheduler {
  return new NotificationScheduler({
    idleDelayMs: config?.idleDelayMs ?? DEFAULT_NOTIFICATION_IDLE_DELAY_MS,
    activityGracePeriodMs:
      config?.activityGracePeriodMs ?? DEFAULT_NOTIFICATION_ACTIVITY_GRACE_MS,
    maxTrackedSessions:
      config?.maxTrackedSessions ?? DEFAULT_NOTIFICATION_MAX_TRACKED_SESSIONS,
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class NotificationScheduler {
  // -- internal state ------------------------------------------------------

  private readonly idleDelayMs: number;
  private readonly activityGracePeriodMs: number;
  private readonly maxTrackedSessions: number;

  /** Sessions that have already been notified (prevents re-notification). */
  private notifiedSessions = new Set<string>();

  /** Pending idle timers keyed by session ID. */
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Sessions that had activity since being scheduled for idle notification. */
  private sessionActivitySinceIdle = new Set<string>();

  /** Per-session version counter to prevent stale timer execution. */
  private notificationVersions = new Map<string, number>();

  /** Sessions currently executing a notification (prevents overlap). */
  private executingNotifications = new Set<string>();

  /** Timestamp (ms) when the timer was scheduled — used for grace period. */
  private scheduledAt = new Map<string, number>();

  // -- constructor ---------------------------------------------------------

  constructor(config: {
    idleDelayMs: number;
    activityGracePeriodMs: number;
    maxTrackedSessions: number;
  }) {
    this.idleDelayMs = config.idleDelayMs;
    this.activityGracePeriodMs = config.activityGracePeriodMs;
    this.maxTrackedSessions = config.maxTrackedSessions;
  }

  // -- markSessionActivity -------------------------------------------------

  /**
   * Record that a session had activity. Cancels any pending idle timer for
   * this session (subject to the grace period) and increments the version
   * counter to invalidate any in-flight timer callback.
   *
   * Grace period: if `activityGracePeriodMs > 0` and the timer was scheduled
   * within the last `activityGracePeriodMs` ms, cancellation is skipped —
   * the activity is treated as a late-arriving event that coincided with the
   * scheduling.
   */
  markSessionActivity(sessionID: string): void {
    // ── Grace period check ────────────────────────────────────────────
    if (this.activityGracePeriodMs > 0) {
      const scheduled = this.scheduledAt.get(sessionID);
      if (scheduled !== undefined) {
        const elapsed = Date.now() - scheduled;
        if (elapsed < this.activityGracePeriodMs) {
          log.debug(
            `Grace period active for session ${sessionID} (${elapsed}ms < ${this.activityGracePeriodMs}ms) — skipping cancellation`,
          );
          return;
        }
      }
    }

    // ── Cancel pending timer ───────────────────────────────────────────
    const timer = this.pendingTimers.get(sessionID);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(sessionID);
    }

    // ── Invalidate in-flight callbacks ─────────────────────────────────
    const currentVersion = this.notificationVersions.get(sessionID) ?? 0;
    this.notificationVersions.set(sessionID, currentVersion + 1);
    this.scheduledAt.delete(sessionID);

    // ── Mark activity ──────────────────────────────────────────────────
    this.sessionActivitySinceIdle.add(sessionID);
  }

  // -- scheduleIdleNotification --------------------------------------------

  /**
   * Schedule an idle notification for a session. The notification fires after
   * `idleDelayMs` of inactivity. Multiple guards prevent duplicate scheduling,
   * re-notification, and overlap with an executing notification.
   */
  scheduleIdleNotification(sessionID: string, onFire: () => void): void {
    // ── Guards ─────────────────────────────────────────────────────────
    if (this.notifiedSessions.has(sessionID)) {
      log.debug(`Session ${sessionID} already notified — skipping`);
      return;
    }

    if (this.pendingTimers.has(sessionID)) {
      log.debug(`Session ${sessionID} already has a pending timer — skipping`);
      return;
    }

    if (this.executingNotifications.has(sessionID)) {
      log.debug(
        `Session ${sessionID} is currently executing — skipping schedule`,
      );
      return;
    }

    // ── Register ───────────────────────────────────────────────────────
    this.sessionActivitySinceIdle.delete(sessionID);

    const now = Date.now();
    this.scheduledAt.set(sessionID, now);

    const currentVersion = this.notificationVersions.get(sessionID) ?? 0;
    const nextVersion = currentVersion + 1;
    this.notificationVersions.set(sessionID, nextVersion);

    const timer = setTimeout(() => {
      this.executeNotification(sessionID, nextVersion, onFire);
    }, this.idleDelayMs);

    this.pendingTimers.set(sessionID, timer);

    log.debug(
      `Scheduled idle notification for session ${sessionID} (version ${nextVersion}, delay ${this.idleDelayMs}ms)`,
    );

    // ── Housekeeping ───────────────────────────────────────────────────
    this.cleanupOldSessions();
  }

  // -- executeNotification -------------------------------------------------

  /**
   * Internal callback invoked when the idle timer fires. Guards check for
   * stale version, race conditions, and duplicate notification before
   * calling the user-supplied `onFire` function.
   */
  async executeNotification(
    sessionID: string,
    version: number,
    onFire: () => void,
  ): Promise<void> {
    // ── Guards ─────────────────────────────────────────────────────────
    if (this.executingNotifications.has(sessionID)) {
      log.debug(
        `Session ${sessionID} is already executing a notification — skipping`,
      );
      return;
    }

    if (this.notificationVersions.get(sessionID) !== version) {
      log.debug(
        `Session ${sessionID} version mismatch (expected ${version}, got ${this.notificationVersions.get(sessionID)}) — stale timer, skipping`,
      );
      return;
    }

    if (this.sessionActivitySinceIdle.has(sessionID)) {
      log.debug(
        `Session ${sessionID} had activity since scheduling — cleaning up without firing`,
      );
      this.pendingTimers.delete(sessionID);
      this.scheduledAt.delete(sessionID);
      this.sessionActivitySinceIdle.delete(sessionID);
      return;
    }

    if (this.notifiedSessions.has(sessionID)) {
      log.debug(`Session ${sessionID} already notified — cleaning up timer`);
      this.pendingTimers.delete(sessionID);
      this.scheduledAt.delete(sessionID);
      return;
    }

    // ── Execute ────────────────────────────────────────────────────────
    this.executingNotifications.add(sessionID);
    this.notifiedSessions.add(sessionID);

    try {
      onFire();
    } finally {
      this.executingNotifications.delete(sessionID);
      this.pendingTimers.delete(sessionID);
      this.scheduledAt.delete(sessionID);

      if (this.sessionActivitySinceIdle.has(sessionID)) {
        this.sessionActivitySinceIdle.delete(sessionID);
      }

      // If the version was bumped during execution, activity arrived while
      // the notification was being dispatched — remove from notified so the
      // session can be re-notified on the next idle period.
      const currentVersion = this.notificationVersions.get(sessionID);
      if (currentVersion !== undefined && currentVersion > version) {
        this.notifiedSessions.delete(sessionID);
      }
    }
  }

  // -- cancelSession / deleteSession ---------------------------------------

  /**
   * Cancel a pending timer for a session and remove all associated state.
   */
  cancelSession(sessionID: string): void {
    const timer = this.pendingTimers.get(sessionID);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    this.pendingTimers.delete(sessionID);
    this.notifiedSessions.delete(sessionID);
    this.sessionActivitySinceIdle.delete(sessionID);
    this.notificationVersions.delete(sessionID);
    this.executingNotifications.delete(sessionID);
    this.scheduledAt.delete(sessionID);
  }

  /** Alias for {@link cancelSession}. */
  deleteSession(sessionID: string): void {
    this.cancelSession(sessionID);
  }

  // -- dispose -------------------------------------------------------------

  /**
   * Clear all timers and reset all internal state. Safe to call multiple
   * times. After disposal the scheduler can still be used (state is reset,
   * not frozen).
   */
  dispose(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }

    this.pendingTimers.clear();
    this.notifiedSessions.clear();
    this.sessionActivitySinceIdle.clear();
    this.notificationVersions.clear();
    this.executingNotifications.clear();
    this.scheduledAt.clear();

    log.debug("Scheduler disposed");
  }

  // -- private helpers -----------------------------------------------------

  /**
   * Evict the oldest tracked sessions when the total exceeds
   * `maxTrackedSessions`. Eviction is LRU-style: the insertion order of
   * `notifiedSessions` (which tracks the order sessions were first notified)
   * is used as the eviction queue. Sessions that are currently executing a
   * notification are never evicted.
   *
   * Called automatically on every `scheduleIdleNotification`.
   */
  private cleanupOldSessions(): void {
    const allSessions = new Set<string>();

    for (const id of this.notifiedSessions) allSessions.add(id);
    for (const id of this.pendingTimers.keys()) allSessions.add(id);
    for (const id of this.sessionActivitySinceIdle) allSessions.add(id);
    for (const id of this.notificationVersions.keys()) allSessions.add(id);
    for (const id of this.executingNotifications) allSessions.add(id);
    for (const id of this.scheduledAt.keys()) allSessions.add(id);

    if (allSessions.size <= this.maxTrackedSessions) return;

    const excess = allSessions.size - this.maxTrackedSessions;
    let evicted = 0;

    // First pass: snapshot eviction candidates from notifiedSessions
    // (insertion order ≈ LRU) into a local array BEFORE mutating state,
    // because cancelSession modifies notifiedSessions and other Maps/Sets
    // that are being iterated — concurrent modification risks iteration
    // invalidation or dropped state.
    const toEvict: string[] = [];
    for (const id of this.notifiedSessions) {
      if (evicted >= excess) break;
      if (!this.executingNotifications.has(id)) {
        toEvict.push(id);
        evicted++;
      }
    }

    // Perform evictions after iteration completes.
    for (const id of toEvict) {
      this.cancelSession(id);
    }

    // Second pass (rare): if still over limit, evict sessions that have state
    // but haven't been notified yet (e.g. pending timers that never fired).
    if (evicted < excess) {
      for (const id of allSessions) {
        if (evicted >= excess) break;
        if (
          !this.notifiedSessions.has(id) &&
          !this.executingNotifications.has(id)
        ) {
          this.cancelSession(id);
          evicted++;
        }
      }
    }
  }
}
