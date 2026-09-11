import type { PluginCoreLike } from "./service.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("service-supervisor");

/**
 * Per-service restart tracking state.
 * Captures attempt count, timing, backoff, and final degradation flag.
 */
export interface ServiceRestartState {
  attempts: number;
  firstAttemptTime: number;
  lastAttemptTime: number;
  backoffUntil: number;
  status: "ok" | "backoff" | "permanently_degraded";
}

/**
 * Default supervisor configuration constants.
 * - maxRestartsPerWindow:   max restart attempts before permanent degradation
 * - windowMs:               sliding time window for counting attempts
 * - baseBackoffMs:          initial backoff duration (doubles per attempt)
 * - backoffFactor:          exponential multiplier applied per failed attempt
 * - maxBackoffMs:           ceiling for backoff duration
 */
export const SUPERVISOR_DEFAULTS = {
  maxRestartsPerWindow: 3,
  windowMs: 60_000,
  baseBackoffMs: 1_000,
  backoffFactor: 2,
  maxBackoffMs: 30_000,
} as const;

/**
 * Micro-kernel supervisor that governs service restart discipline.
 *
 * Implements sliding-window rate limiting, exponential backoff, and
 * permanent degradation to prevent restart storms. Every public method
 * is wrapped in try/catch so the supervisor itself never causes a crash
 * (always-bootable principle).
 */
export class ServiceSupervisor {
  private states = new Map<string, ServiceRestartState>();
  private core: PluginCoreLike;

  constructor(core: PluginCoreLike) {
    this.core = core;
  }

  /**
   * Attempt a supervised restart of the named service.
   *
   * Rules (in order):
   *  1. permanently_degraded → no-op.
   *  2. In backoff (now < backoffUntil) → skip + log.debug.
   *  3. Window expired (now - firstAttemptTime > windowMs) → reset budget.
   *  4. Under budget (attempts < maxRestartsPerWindow) → call core.restartService().
   *     - Success → reset tracking.
   *     - Failure → increment attempts, apply backoff or mark degraded.
   *  5. All errors within the supervisor are caught — never propagate.
   */
  async tryRestart(name: string): Promise<void> {
    try {
      const now = Date.now();
      let state = this.states.get(name);

      // 1. Permanently degraded → no-op
      if (state?.status === "permanently_degraded") return;

      // 2. In backoff window → skip
      if (state?.status === "backoff" && now < state.backoffUntil) {
        log.debug("Service in backoff, skipping restart", {
          name,
          backoffUntil: new Date(state.backoffUntil).toISOString(),
        });
        return;
      }

      // 3. Sliding window expired → reset attempt budget
      if (state && now - state.firstAttemptTime > SUPERVISOR_DEFAULTS.windowMs) {
        state.attempts = 0;
        state.firstAttemptTime = now;
      }

      // Create tracking state on first encounter
      if (!state) {
        state = {
          attempts: 0,
          firstAttemptTime: now,
          lastAttemptTime: now,
          backoffUntil: 0,
          status: "ok",
        };
        this.states.set(name, state);
      }

      // 4. Guard: if already at max attempts, mark degraded and bail
      if (state.attempts >= SUPERVISOR_DEFAULTS.maxRestartsPerWindow) {
        state.status = "permanently_degraded";
        log.error("Service exceeded max restart attempts, permanently degraded", {
          name,
          attempts: state.attempts,
          windowMs: SUPERVISOR_DEFAULTS.windowMs,
        });
        return;
      }

      // 5. Attempt the restart
      try {
        await this.core.restartService(name);
        // Success → reset tracking
        state.attempts = 0;
        state.status = "ok";
      } catch (err) {
        state.attempts++;
        state.lastAttemptTime = now;

        if (state.attempts >= SUPERVISOR_DEFAULTS.maxRestartsPerWindow) {
          state.status = "permanently_degraded";
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error("Service permanently degraded after exhausting restart attempts", {
            name,
            attempts: state.attempts,
            lastError: errMsg,
            windowMs: SUPERVISOR_DEFAULTS.windowMs,
          });
        } else {
          state.status = "backoff";
          state.backoffUntil = now + Math.min(
            SUPERVISOR_DEFAULTS.baseBackoffMs *
              Math.pow(SUPERVISOR_DEFAULTS.backoffFactor, state.attempts),
            SUPERVISOR_DEFAULTS.maxBackoffMs,
          );
        }
      }
    } catch {
      // 6. Supervisor internal errors NEVER propagate (always-bootable principle)
    }
  }

  /**
   * Return the current restart tracking state for a service.
   * When no tracking record exists, returns a default 'ok' state.
   */
  getStatus(name: string): ServiceRestartState {
    return (
      this.states.get(name) ?? {
        attempts: 0,
        firstAttemptTime: 0,
        lastAttemptTime: 0,
        backoffUntil: 0,
        status: "ok",
      }
    );
  }
}
