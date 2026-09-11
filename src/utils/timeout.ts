// ── Timeout Guard Utility ──────────────────────────────────────────
//
// Provides a reusable `withTimeout` wrapper to protect external client
// API calls from hanging indefinitely.
//
// Timeout is configurable via:
//   1. `ROLEBOX_CLIENT_TIMEOUT_MS` environment variable
//   2. The `DEFAULT_TIMEOUT_MS` constant (30s fallback)

import type { Logger } from "tslog";

/**
 * Default timeout for external client API calls (30 seconds).
 * Override with `ROLEBOX_CLIENT_TIMEOUT_MS` env var.
 */
export const DEFAULT_TIMEOUT_MS = (() => {
  const env = process.env.ROLEBOX_CLIENT_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 30_000;
})();

/**
 * Wraps a promise with a timeout guard.
 *
 * - If the promise settles within `ms`: returns the resolved value.
 * - If the timeout fires first: logs a warning with `label` and returns `null`.
 * - If the underlying promise rejects: re-throws the error (caller's
 *   existing try/catch handles it).
 *
 * @param promise - The promise to guard.
 * @param ms      - Timeout in milliseconds.
 * @param label   - Human-readable label for log messages.
 * @param log     - Logger instance used to emit warning on timeout.
 * @returns The resolved value, or `null` if the timeout elapsed.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  log: Logger<any>,
): Promise<T | null> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("TIMEOUT:")) {
      log.warn(`[timeout] ${label} timed out after ${ms}ms`);
      return null;
    }
    // Non-timeout error — re-throw so the caller's existing catch handles it
    throw err;
  }
}
