/**
 * Session existence monitor — tracks session disappearance from the global
 * status map and provides secondary existence verification via session.get().
 *
 * This module is read-only + tracking: it does NOT modify task state,
 * abort sessions, or interact with the poller/manager directly.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";
import { MIN_SESSION_GONE_POLLS } from "./config.js";

// ── Public Types ───────────────────────────────────────────────────────

/**
 * Result of a {@link SessionMonitor.checkSession} call.
 *
 * - `"active"`:     sessionId present in the status map → reset counter
 * - `"gone"`:       exceeded MISSED_POLL threshold → trigger recovery logic
 * - `"uncertain"`:  absent from map but not enough consecutive misses yet
 * - `"present_idle"`: placeholder for future use when idle-but-present
 */
export interface SessionMonitorResult {
  type: "active" | "gone" | "uncertain" | "present_idle";
  /** The raw status object from the map when present, undefined when absent */
  status?: { type: string };
}

// ── SessionMonitor ─────────────────────────────────────────────────────

export class SessionMonitor {
  /**
   * Per-task count of consecutive polls where the session was absent
   * from the global status map.  Only incremented for tasks that are
   * currently being polled.
   */
  private consecutiveMissedPolls: Map<string, number> = new Map();

  // ── Primary check (status-map based) ────────────────────────────────

  /**
   * Check a session's status from the global status map, tracking
   * consecutive disappearances per task.
   *
   * @param taskId     The dispatch task ID (used for per-task tracking)
   * @param sessionId  The opencode session ID to look up
   * @param statusMap  The global status map returned by `client.session.status()`
   * @returns A structured result indicating presence, absence, or uncertainty
   */
  checkSession(
    taskId: string,
    sessionId: string,
    statusMap: Record<string, { type: string }>,
  ): SessionMonitorResult {
    const status = statusMap[sessionId];

    // 1. Session present in status map → reset counter, return active
    if (status !== undefined) {
      this.consecutiveMissedPolls.delete(taskId);
      return { type: "active", status };
    }

    // 2. Session NOT in map → increment missed poll counter
    const current = this.consecutiveMissedPolls.get(taskId) ?? 0;
    const missed = current + 1;
    this.consecutiveMissedPolls.set(taskId, missed);

    // 3. Below threshold → uncertain (maybe a transient polling gap)
    if (missed < MIN_SESSION_GONE_POLLS) {
      return { type: "uncertain" };
    }

    // 4. Threshold reached → session is considered gone
    return { type: "gone" };
  }

  // ── Secondary verification (SDK-based) ──────────────────────────────

  /**
   * Secondary existence verification using `client.session.get()`.
   *
   * This is the authoritative check triggered after {@link checkSession}
   * returns `"gone"`.  It calls the SDK directly to determine whether
   * the session truly no longer exists.
   *
   * @param client     The opencode SDK client
   * @param sessionId  The session ID to verify
   * @returns
   *   - `"exists"`:  session.get returned data (session still alive)
   *   - `"missing"`: 404 or not-found error (session deleted)
   *   - `"unknown"`: network error, unexpected response, can't determine
   */
  async verifyExistence(
    client: OpencodeClient,
    sessionId: string,
  ): Promise<"exists" | "missing" | "unknown"> {
    try {
      const result = await client.session.get({ path: { id: sessionId } });

      // Success path — data exists, session is alive
      if (result.data !== undefined && result.data !== null) {
        return "exists";
      }

      // Error path — check for 404 / not-found
      if (result.error !== undefined) {
        if (_isNotFoundError(result.error)) {
          return "missing";
        }
        // Unexpected error type (400, etc.) → can't determine
        return "unknown";
      }

      // No data AND no error — unexpected response shape
      return "unknown";
    } catch (err: unknown) {
      // Network / transport-level errors → don't assume session is gone
      if (_isNotFoundError(err)) {
        return "missing";
      }
      return "unknown";
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Reset tracking state for a task (called on completion / cancellation). */
  clearTask(taskId: string): void {
    this.consecutiveMissedPolls.delete(taskId);
  }
}

// ── Internal Helpers ───────────────────────────────────────────────────

/**
 * Check whether an error value represents a 404 / not-found response.
 *
 * Supports both thrown errors (caught in try/catch) and structured
 * error objects returned in the `{ error }` property of the SDK result.
 */
function _isNotFoundError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== "object") return false;

  const obj = err as Record<string, unknown>;

  // Check for a numeric status code (common in Axios / fetch errors)
  if (typeof obj.status === "number" && obj.status === 404) return true;

  // Check for nested response.status (Axios-style)
  const resp = obj.response as Record<string, unknown> | undefined;
  if (resp !== undefined && typeof resp === "object") {
    if (typeof resp.status === "number" && resp.status === 404) return true;
  }

  // Check for OpenAPI SDK error type (has a name or type field indicating "not found")
  if (typeof obj.name === "string" && /not.?found/i.test(obj.name)) return true;
  if (typeof obj.type === "string" && /not.?found/i.test(obj.type)) return true;

  return false;
}
