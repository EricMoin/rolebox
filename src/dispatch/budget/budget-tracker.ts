import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchManagerConfig } from "../config.ts";
import { atomicWriteSync } from "../../function/fs-util.ts";
import { shortHash } from "../../utils/state-paths.ts";
import { createSubLogger } from "../../logger.ts";

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
 * Tracks token and cost budgets across dispatched sessions within a single
 * plugin lifecycle. State is persisted to disk via debounced writes so it
 * survives plugin restarts.
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
 */
export class BudgetTracker {
  private log = createSubLogger("budget");

  /** Per-parent-session cumulative usage (request-level budgets). */
  private requestUsage = new Map<string, UsageRecord>();

  /** Per-dispatch-session usage (session-level budgets). */
  private sessionUsage = new Map<string, UsageRecord>();

  /** The active config used for budget limit checks. */
  private config: DispatchManagerConfig;

  /** Directory hash for state-file naming. */
  private dirHash: string;

  /** Workspace directory for state file storage. */
  private directory: string;

  // ── Debounce fields for deferred persistence ────────────────────────
  private _dirty = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: DispatchManagerConfig, directory: string) {
    this.config = config;
    this.directory = directory;
    this.dirHash = shortHash(directory);
    this.restore();
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

    // Trigger debounced persistence
    this._debouncedPersist();
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
   * Reset usage for a specific dispatched session, subtracting its recorded
   * token/cost from the parent request's cumulative usage. Used by task-retry
   * with reset_budget=true so the retry does not count the old session's usage.
   *
   * This is a surgical reset — only the given session is affected; other
   * concurrent sessions under the same parent are untouched.
   */
  resetSessionUsage(sessionId: string, parentSessionId: string): void {
    const session = this.sessionUsage.get(sessionId);
    if (!session) return;

    // Subtract from parent request's cumulative usage
    const parent = this.requestUsage.get(parentSessionId);
    if (parent) {
      parent.inputTokens = Math.max(0, parent.inputTokens - session.inputTokens);
      parent.outputTokens = Math.max(0, parent.outputTokens - session.outputTokens);
      parent.cost = Math.max(0, parent.cost - session.cost);
      if (parent.inputTokens === 0 && parent.outputTokens === 0 && parent.cost === 0) {
        this.requestUsage.delete(parentSessionId);
      }
    }

    // Remove the session's own entry
    this.sessionUsage.delete(sessionId);

    this.log.debug(
      "resetSessionUsage session=" + sessionId.slice(0, 12) +
      " parent=" + parentSessionId.slice(0, 12) +
      " in=" + session.inputTokens + " out=" + session.outputTokens +
      " cost=" + session.cost.toFixed(6),
    );

    this._debouncedPersist();
  }

  /**
   * Reset all tracking data. Called on plugin teardown or full reset.
   */
  reset(): void {
    this.requestUsage.clear();
    this.sessionUsage.clear();
  }

  /**
   * Dispose the tracker — clears pending debounce timer and resets state.
   * Called during DispatchManager.dispose().
   */
  dispose(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this.reset();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Path to the budget state file on disk.
   */
  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `budget-${this.dirHash}.json`);
  }

  /**
   * Serialize current usage Maps to disk using atomic write pattern
   * (.tmp + renameSync) to prevent file corruption from partial writes.
   */
  persist(): void {
    const data = JSON.stringify({
      version: 1,
      requestUsage: [...this.requestUsage.entries()],
      sessionUsage: [...this.sessionUsage.entries()],
    });
    atomicWriteSync(this.statePath(), data);
  }

  /**
   * Restore usage Maps from disk. Called from the constructor.
   * If the file does not exist or is corrupt, starts fresh with empty Maps.
   */
  restore(): void {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) return;
      this.requestUsage = new Map(parsed.requestUsage ?? []);
      this.sessionUsage = new Map(parsed.sessionUsage ?? []);
      this.log.debug("restored budget from disk", {
        requestSessions: this.requestUsage.size,
        dispatchSessions: this.sessionUsage.size,
      });
    } catch {
      // Corrupt file — start fresh
    }
  }

  /**
   * Debounced persist: sets dirty flag, restarts 200ms timer.
   * The timer callback flushes to disk when no new calls arrive within
   * the 200ms window.
   */
  private _debouncedPersist(): void {
    this._dirty = true;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (!this._dirty) return;
      this._dirty = false;
      this.persist();
    }, 200);
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
