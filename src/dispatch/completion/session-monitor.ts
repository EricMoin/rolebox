/**
 * Lightweight session existence verifier.
 *
 * Provides secondary existence verification via `client.session.get()`.
 * The legacy `checkSession()` status-map polling and `clearTask()` lifecycle
 * tracking have been removed — those responsibilities moved to the
 * event-driven dispatch pipeline.
 *
 * This module is read-only: it does NOT modify task state,
 * abort sessions, or interact with the manager/poller directly.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";

// ── Public Types ───────────────────────────────────────────────────────

/**
 * Result of a session existence check.
 *
 * Retained for backward compatibility — the `active` / `gone` / `uncertain` /
 * `present_idle` variants were previously produced by the now-removed
 * `checkSession()` method. External consumers may still reference this type.
 */
export interface SessionMonitorResult {
  type: "active" | "gone" | "uncertain" | "present_idle";
  /** The raw status object from the map when present, undefined when absent */
  status?: { type: string };
}

// ── SessionMonitor ─────────────────────────────────────────────────────

export class SessionMonitor {
  /**
   * Secondary existence verification using `client.session.get()`.
   *
   * Called when the event-driven pipeline detects a session may have
   * disappeared. Uses the SDK directly to confirm whether the session
   * truly no longer exists.
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

      if (result.data !== undefined && result.data !== null) {
        return "exists";
      }

      if (result.error !== undefined) {
        if (_isNotFoundError(result.error)) {
          return "missing";
        }
        return "unknown";
      }

      return "unknown";
    } catch (err: unknown) {
      if (_isNotFoundError(err)) {
        return "missing";
      }
      return "unknown";
    }
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

  if (typeof obj.status === "number" && obj.status === 404) return true;

  const resp = obj.response as Record<string, unknown> | undefined;
  if (resp !== undefined && typeof resp === "object") {
    if (typeof resp.status === "number" && resp.status === 404) return true;
  }

  if (typeof obj.name === "string" && /not.?found/i.test(obj.name)) return true;
  if (typeof obj.type === "string" && /not.?found/i.test(obj.type)) return true;

  return false;
}
