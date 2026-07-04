import type { DispatchManagerConfig } from "./config.ts";
import { createSubLogger } from "../logger.ts";

// ── Public types ───────────────────────────────────────────────────────────

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface BudgetCheckResult {
  exceeded: boolean;
  reason?: string;
}

// ── BudgetTracker ──────────────────────────────────────────────────────────

/**
 * Ephemeral in-memory tracker for token and cost budgets across dispatched
 * sessions within a single plugin lifecycle.
 *
 * Tracks two levels:
 * - **Request-level**: cumulative usage across all dispatched sessions sharing
 *   the same parent session ID (the "root" request).
 * - **Session-level**: per-session usage for individual dispatched sessions.
 *
 * Budget limits come from DispatchManagerConfig and are checked by the
 * caller (DispatchManager) before launching new tasks and during periodic
 * sampling.
 *
 * Thread-safe for single-process use (no locks needed — in-memory Maps).
 * State is NOT persisted to disk; it resets on plugin restart.
 */
export class BudgetTracker {
  private log = createSubLogger("budget");

  /** Per-parent-session cumulative usage (request-level budgets). */
  private requestUsage = new Map<string, UsageRecord>();

  /** Per-dispatch-session usage (session-level budgets). */
  private sessionUsage = new Map<string, UsageRecord>();

  /** The active config used for budget limit checks. */
  private config: DispatchManagerConfig;

  constructor(config: DispatchManagerConfig) {
    this.config = config;
  }

  /**
   * Update the config reference (called when config changes at runtime).
   */
  setConfig(config: DispatchManagerConfig): void {
    this.config = config;
  }

  /**
   * Record token/cost usage for a dispatched session.
   *
   * @param sessionId       The dispatched session ID
   * @param parentSessionId The parent (request) session ID
   * @param tokens          Input and output token counts
   * @param cost            Estimated or actual cost in USD
   */
  recordUsage(
    sessionId: string,
    parentSessionId: string,
    tokens: { input: number; output: number },
    cost: number,
  ): void {
    // Update per-session usage (accumulate — multiple samples)
    const existingSession = this.sessionUsage.get(sessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    existingSession.inputTokens += tokens.input;
    existingSession.outputTokens += tokens.output;
    existingSession.cost += cost;
    this.sessionUsage.set(sessionId, existingSession);

    // Update per-request usage (accumulate)
    const existingRequest = this.requestUsage.get(parentSessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    existingRequest.inputTokens += tokens.input;
    existingRequest.outputTokens += tokens.output;
    existingRequest.cost += cost;
    this.requestUsage.set(parentSessionId, existingRequest);

    this.log.debug(
      `recordUsage session=${sessionId.slice(0, 12)} parent=${parentSessionId.slice(0, 12)} ` +
      `in=${tokens.input} out=${tokens.output} cost=${cost.toFixed(6)}`,
      { tag: "budget", taskId: sessionId },
    );
  }

  /**
   * Get cumulative usage for a request (parent session).
   */
  getRequestUsage(parentSessionId: string): UsageRecord {
    return this.requestUsage.get(parentSessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
  }

  /**
   * Get cumulative usage for a specific dispatched session.
   */
  getSessionUsage(sessionId: string): UsageRecord {
    return this.sessionUsage.get(sessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
  }

  /**
   * Check whether the request-level budget has been exceeded for the given
   * parent session. Returns { exceeded: true, reason } if any configured
   * limit is breached.
   */
  isRequestBudgetExceeded(parentSessionId: string): BudgetCheckResult {
    const usage = this.getRequestUsage(parentSessionId);

    if (this.config.maxInputTokensPerRequest !== undefined &&
        usage.inputTokens >= this.config.maxInputTokensPerRequest) {
      return {
        exceeded: true,
        reason: `Request input token budget exhausted: ${usage.inputTokens} >= ${this.config.maxInputTokensPerRequest}`,
      };
    }

    if (this.config.maxOutputTokensPerRequest !== undefined &&
        usage.outputTokens >= this.config.maxOutputTokensPerRequest) {
      return {
        exceeded: true,
        reason: `Request output token budget exhausted: ${usage.outputTokens} >= ${this.config.maxOutputTokensPerRequest}`,
      };
    }

    if (this.config.maxCostPerRequest !== undefined &&
        usage.cost >= this.config.maxCostPerRequest) {
      return {
        exceeded: true,
        reason: `Request cost budget exhausted: ${usage.cost.toFixed(6)} >= ${this.config.maxCostPerRequest}`,
      };
    }

    return { exceeded: false };
  }

  /**
   * Check whether the per-session budget has been exceeded for the given
   * dispatched session. Returns { exceeded: true, reason } if any configured
   * limit is breached.
   */
  isSessionBudgetExceeded(sessionId: string): BudgetCheckResult {
    const usage = this.getSessionUsage(sessionId);

    if (this.config.maxInputTokensPerSession !== undefined &&
        usage.inputTokens >= this.config.maxInputTokensPerSession) {
      return {
        exceeded: true,
        reason: `Session input token budget exhausted: ${usage.inputTokens} >= ${this.config.maxInputTokensPerSession}`,
      };
    }

    if (this.config.maxCostPerSession !== undefined &&
        usage.cost >= this.config.maxCostPerSession) {
      return {
        exceeded: true,
        reason: `Session cost budget exhausted: ${usage.cost.toFixed(6)} >= ${this.config.maxCostPerSession}`,
      };
    }

    return { exceeded: false };
  }

  /**
   * Remove tracking data for a completed/cleaned-up session.
   */
  removeSession(sessionId: string): void {
    this.sessionUsage.delete(sessionId);
  }

  /**
   * Remove tracking data for a completed request (parent session).
   */
  removeRequest(parentSessionId: string): void {
    this.requestUsage.delete(parentSessionId);
  }

  /**
   * Reset all tracking data. Called on plugin teardown or full reset.
   */
  reset(): void {
    this.requestUsage.clear();
    this.sessionUsage.clear();
  }

  /**
   * Get a human-readable budget status summary for a parent session.
   */
  getStatus(parentSessionId: string): string {
    const usage = this.getRequestUsage(parentSessionId);
    const lines: string[] = [];

    const limit = (v: number | undefined) =>
      v !== undefined ? String(v) : "unlimited";

    lines.push("### Budget Status");
    lines.push("");
    lines.push("**Request-level (cumulative across all dispatched sessions):**");
    lines.push(`| Metric | Current | Limit | % Used |`);
    lines.push(`|--------|---------|-------|--------|`);
    lines.push(
      `| Input Tokens | ${usage.inputTokens} | ${limit(this.config.maxInputTokensPerRequest)} | ` +
      `${this._pct(usage.inputTokens, this.config.maxInputTokensPerRequest)} |`,
    );
    lines.push(
      `| Output Tokens | ${usage.outputTokens} | ${limit(this.config.maxOutputTokensPerRequest)} | ` +
      `${this._pct(usage.outputTokens, this.config.maxOutputTokensPerRequest)} |`,
    );
    lines.push(
      `| Cost (USD) | ${usage.cost.toFixed(6)} | ${limit(this.config.maxCostPerRequest)} | ` +
      `${this._pct(usage.cost, this.config.maxCostPerRequest)} |`,
    );
    lines.push("");

    // Show per-session budgets
    const sesInLimit = limit(this.config.maxInputTokensPerSession);
    const sesCostLimit = limit(this.config.maxCostPerSession);
    lines.push("**Per-session limits:**");
    lines.push(`| Session Metric | Limit |`);
    lines.push(`|----------------|-------|`);
    lines.push(`| Input Tokens | ${sesInLimit} |`);
    lines.push(`| Cost (USD) | ${sesCostLimit} |`);

    return lines.join("\n");
  }

  /** Format a percentage string, or "—" when limit is undefined. */
  private _pct(value: number, limit: number | undefined): string {
    if (limit === undefined || limit <= 0) return "—";
    const pct = ((value / limit) * 100).toFixed(1);
    return `${pct}%`;
  }
}
