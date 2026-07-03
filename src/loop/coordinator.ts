import type { LoopState, LoopMode, LoopPhase } from "./types.js";
import type { IDispatchAdapter } from "./dispatch-adapter.js";
import {
  SEED_CHAR_CAP,
  DISPATCH_ROUND_TIMEOUT_MS,
  LOOP_PROGRESS_MARKER,
  LOOP_STATE_SCHEMA_VERSION,
  STOP_LOOP_SIGNAL,
} from "./constants.js";
import {
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
  isDispatchNotification,
} from "../dispatch/notification.js";

// ── Phase-aware cancellation ───────────────────────────────────────

export const DISPATCH_MARKERS = [
  DISPATCH_COMPLETION_MARKER,
  DISPATCH_ALL_COMPLETE_MARKER,
  DISPATCH_RECOVERY_MARKER,
] as const;

const TERMINAL_PHASES = new Set<LoopPhase>([
  "complete",
  "cancelled",
  "error",
  "interrupted",
]);

/** Phases owned by the origin/orchestrator — human input here is NOT an interrupt. */
const ORIGIN_OWNED_PHASES = new Set<LoopPhase>([
  "activating",
  "summarizing",
  "finalizing",
]);

const AUTO_CONTINUE_PREFIX = "[auto-continue";

/**
 * Determine whether an incoming message should cancel the loop.
 *
 * Cancellation requires an **explicit stop signal** (the `/stop-loop` command
 * injects `STOP_LOOP_SIGNAL` into the message text). Ordinary user messages
 * no longer interrupt a running loop — only the dedicated command does.
 *
 * System re-prompts (dispatch completion markers, auto-continue, loop-progress
 * notes) are still excluded for safety.
 */
export function shouldCancelLoop(
  loopState: LoopState,
  messageText: string,
): boolean {
  // Only cancel when the explicit stop-loop signal is present
  if (!messageText.includes(STOP_LOOP_SIGNAL)) return false;

  if (TERMINAL_PHASES.has(loopState.phase)) return false;
  if (ORIGIN_OWNED_PHASES.has(loopState.phase)) return false;

  if (loopState.phase === "awaiting_worker") return true;
  if (loopState.phase === "dispatching") return true;

  return false;
}

export class LoopCoordinator {
  private loops = new Map<string, LoopState>();
  private _advancing = new Set<string>();
  private _workerToOrigin = new Map<string, string>();

  constructor(
    private adapter: IDispatchAdapter,
    private opts?: {
      delayMs?: number;
      roundTimeoutMs?: number;
      persist?: (loops: Map<string, LoopState>) => void;
    },
  ) {}

  private _persist(): void {
    this.opts?.persist?.(this.loops);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  register(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    mode: LoopMode;
    iterations: number;
  }): void {
    if (this.loops.has(input.originSessionId)) return;

    const now = Date.now();
    const state: LoopState = {
      originSessionId: input.originSessionId,
      agent: input.agent,
      basePrompt: input.prompt,
      mode: input.mode,
      total: input.iterations,
      current: 1,
      phase: "activating",
      cancelRequested: false,
      startedAt: now,
      updatedAt: now,
      roundStartedAt: now,
      rounds: [],
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    this.loops.set(input.originSessionId, state);
    this._persist();
  }

  async onOriginIdle(originSessionId: string): Promise<void> {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    if (this._advancing.has(originSessionId)) return;

    this._advancing.add(originSessionId);
    try {
      switch (loop.phase) {
        case "activating":
          loop.phase = "dispatching";
          await this._dispatchRound(loop);
          break;
        case "summarizing":
          await this._handleSummary(loop);
          break;
        default:
          break;
      }
    } catch (err) {
      await this._failLoop(loop, err instanceof Error ? err.message : String(err));
    } finally {
      this._advancing.delete(originSessionId);
      this._persist();
    }
  }

  async onWorkerCompleted(workerTaskId: string): Promise<void> {
    const originSessionId = this._workerToOrigin.get(workerTaskId);
    if (!originSessionId) return;

    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    if (loop.phase !== "awaiting_worker") return;
    if (loop.activeWorkerTaskId !== workerTaskId) return;
    if (this._advancing.has(originSessionId)) return;

    this._advancing.add(originSessionId);
    try {
      const result = await this.adapter.getRoundResult(workerTaskId);

      this._workerToOrigin.delete(workerTaskId);
      loop.activeWorkerTaskId = undefined;
      loop.activeWorkerSessionId = undefined;

      // Update round history
      const lastRound = loop.rounds?.[loop.rounds.length - 1];
      if (lastRound && lastRound.status === "running") {
        const now = Date.now();
        lastRound.completedAt = now;
        lastRound.durationMs = now - lastRound.startedAt;
        lastRound.status = result.hadError ? "error" : "completed";
      }

      if (result.hadError) {
        await this._failLoop(loop, result.errorReason ?? "Worker round failed");
        return;
      }

      // Inject per-round progress note with session ID for discoverability
      if (lastRound) {
        const dur = lastRound.durationMs !== undefined ? `${(lastRound.durationMs / 1000).toFixed(1)}s` : "?";
        await this.adapter
          .injectNote(
            loop.originSessionId,
            `${LOOP_PROGRESS_MARKER} round ${lastRound.round}/${loop.total} ${lastRound.status}, session=${lastRound.workerSessionId}, duration=${dur}]`,
          )
          .catch(() => {});
      }

      const lastMsgId = await this.adapter.getLastMessageId(originSessionId);
      loop.summaryBoundaryMessageId = lastMsgId;
      loop.phase = "summarizing";
      loop.updatedAt = Date.now();
      // DispatchManager's notifyParent re-prompts origin → origin produces summary → onOriginIdle fires
    } catch (err) {
      await this._failLoop(loop, err instanceof Error ? err.message : String(err));
    } finally {
      this._advancing.delete(originSessionId);
      this._persist();
    }
  }

  requestCancel(originSessionId: string): void {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    loop.cancelRequested = true;
    loop.updatedAt = Date.now();
    this._persist();
  }

  /** Immediately cancel a loop: cancels the in-flight worker and finalizes as cancelled. */
  async cancelNow(sessionId: string): Promise<void> {
    let loop = this.loops.get(sessionId);
    if (!loop) {
      const originId = this._workerToOrigin.get(sessionId);
      if (originId) loop = this.loops.get(originId);
    }
    if (!loop) return;

    loop.cancelRequested = true;
    loop.updatedAt = Date.now();

    if (TERMINAL_PHASES.has(loop.phase) || loop.phase === "finalizing") {
      this._persist();
      return;
    }
    if (this._advancing.has(loop.originSessionId)) {
      this._persist();
      return;
    }

    this._advancing.add(loop.originSessionId);
    try {
      loop.phase = "finalizing";
      await this._finalize(loop, "cancelled");
    } catch (err) {
      await this._failLoop(loop, err instanceof Error ? err.message : String(err));
    } finally {
      this._advancing.delete(loop.originSessionId);
      this._persist();
    }
  }

  /** Phase-aware cancellation decision with source-tagging.
   *
   *  Looks up the loop by sessionId (handles both origin and worker sessions),
   *  then delegates to {@link shouldCancelLoop}. If cancellation is indicated,
   *  immediately sets `cancelRequested=true` on the loop state so downstream
   *  coordinator logic (e.g. in `onOriginIdle`, `onWorkerCompleted`) can
   *  finalize as cancelled.
   */
  shouldCancelOnUserMessage(sessionId: string, messageText: string): boolean {
    let loop = this.loops.get(sessionId);
    if (!loop) {
      const originId = this._workerToOrigin.get(sessionId);
      if (originId) loop = this.loops.get(originId);
    }
    if (!loop) return false;

    if (!shouldCancelLoop(loop, messageText)) return false;

    loop.cancelRequested = true;
    loop.updatedAt = Date.now();
    return true;
  }

  isActiveLoopOrigin(sessionId: string): boolean {
    const loop = this.loops.get(sessionId);
    if (!loop) return false;
    return !TERMINAL_PHASES.has(loop.phase);
  }

  isLoopSession(sessionId: string): boolean {
    if (this.loops.has(sessionId)) return true;
    for (const loop of this.loops.values()) {
      if (loop.activeWorkerSessionId === sessionId) return true;
    }
    return false;
  }

  getLoopState(originSessionId: string): LoopState | undefined {
    return this.loops.get(originSessionId);
  }

  getAllLoopStates(): Map<string, LoopState> {
    return new Map(this.loops);
  }

  getNonTerminalLoops(): LoopState[] {
    return [...this.loops.values()].filter(
      (l) => !TERMINAL_PHASES.has(l.phase),
    );
  }

  async failSession(sessionId: string, reason: string): Promise<void> {
    const loop = this.loops.get(sessionId);
    if (!loop || TERMINAL_PHASES.has(loop.phase)) return;
    await this._failLoop(loop, reason);
    this._persist();
  }

  /** Feed a recovered loop state back into the coordinator (startup recovery). */
  restoreState(state: LoopState): void {
    if (this.loops.has(state.originSessionId)) return;
    this.loops.set(state.originSessionId, state);
    if (state.activeWorkerTaskId) {
      this._workerToOrigin.set(state.activeWorkerTaskId, state.originSessionId);
    }
    this._persist();
  }

  dispose(): void {
    this.loops.clear();
    this._workerToOrigin.clear();
    this._advancing.clear();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async _dispatchRound(loop: LoopState): Promise<void> {
    let prompt = loop.basePrompt;
    if (loop.mode === "inherit" && loop.lastSummary) {
      const seed =
        loop.lastSummary.length > SEED_CHAR_CAP
          ? loop.lastSummary.slice(-SEED_CHAR_CAP)
          : loop.lastSummary;
      prompt = seed + "\n\n---\n\n" + loop.basePrompt;
    }

    const result = await this.adapter.dispatchRound({
      originSessionId: loop.originSessionId,
      agent: loop.agent,
      prompt,
      description: `Loop round ${loop.current}/${loop.total}`,
      timeoutMs: this.opts?.roundTimeoutMs ?? DISPATCH_ROUND_TIMEOUT_MS,
    });

    loop.activeWorkerTaskId = result.workerTaskId;
    loop.activeWorkerSessionId = result.workerSessionId;
    // Record round history
    if (!loop.rounds) loop.rounds = [];
    loop.rounds.push({
      round: loop.current,
      workerTaskId: result.workerTaskId,
      workerSessionId: result.workerSessionId,
      startedAt: Date.now(),
      status: "running",
    });
    loop.phase = "awaiting_worker";
    loop.roundStartedAt = Date.now();
    loop.updatedAt = Date.now();

    this._workerToOrigin.set(result.workerTaskId, loop.originSessionId);

    // Inject a "loop started" progress note on the first round so the user
    // knows the loop has begun (mirrors the end-of-loop notes in _finalize).
    if (loop.current === 1) {
      await this.adapter
        .injectNote(
          loop.originSessionId,
          `${LOOP_PROGRESS_MARKER} loop started: ${loop.total} rounds, ${loop.mode} mode]`,
        )
        .catch(() => {});
    }
  }

  private async _handleSummary(loop: LoopState): Promise<void> {
    const summary = await this.adapter.readOriginSummary(
      loop.originSessionId,
      loop.summaryBoundaryMessageId,
    );

    loop.lastSummary =
      summary.length > SEED_CHAR_CAP
        ? summary.slice(-SEED_CHAR_CAP)
        : summary;
    loop.updatedAt = Date.now();

    loop.current += 1;

    if (loop.current > loop.total) {
      loop.phase = "finalizing";
      await this._finalize(loop, "complete");
      return;
    }

    if (loop.cancelRequested) {
      loop.phase = "finalizing";
      await this._finalize(loop, "cancelled");
      return;
    }

    loop.phase = "dispatching";
    const delay = this.opts?.delayMs ?? 0;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    await this._dispatchRound(loop);
  }

  private async _finalize(
    loop: LoopState,
    terminalPhase: "complete" | "cancelled",
  ): Promise<void> {
    if (loop.activeWorkerTaskId) {
      await this.adapter.cancelRound(loop.activeWorkerTaskId).catch(() => {});
      this._workerToOrigin.delete(loop.activeWorkerTaskId);
      loop.activeWorkerTaskId = undefined;
      loop.activeWorkerSessionId = undefined;
    }

    // Mark current round as cancelled in history
    const lastRound = loop.rounds?.[loop.rounds.length - 1];
    if (lastRound && lastRound.status === "running") {
      lastRound.completedAt = Date.now();
      lastRound.durationMs = lastRound.completedAt - lastRound.startedAt;
      lastRound.status = "cancelled";
    }

    loop.phase = terminalPhase;
    loop.updatedAt = Date.now();

    // Build round summary for session discovery
    const roundsSummary = (loop.rounds ?? [])
      .map((r) => {
        const dur = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : "?";
        return `r${r.round}:${r.workerSessionId}(${dur},${r.status})`;
      })
      .join(", ");

    const marker =
      terminalPhase === "complete"
        ? `${LOOP_PROGRESS_MARKER} loop complete]\nRounds: ${roundsSummary}`
        : `${LOOP_PROGRESS_MARKER} loop cancelled]\nRounds: ${roundsSummary}`;

    await this.adapter.injectNote(loop.originSessionId, marker);
  }

  private async _failLoop(loop: LoopState, reason: string): Promise<void> {
    if (loop.activeWorkerTaskId) {
      await this.adapter.cancelRound(loop.activeWorkerTaskId).catch(() => {});
      this._workerToOrigin.delete(loop.activeWorkerTaskId);
      loop.activeWorkerTaskId = undefined;
      loop.activeWorkerSessionId = undefined;
    }
    loop.phase = "error";
    loop.errorReason = reason;
    loop.updatedAt = Date.now();

    // Mark current round as errored in history
    const lastRound = loop.rounds?.[loop.rounds.length - 1];
    if (lastRound && lastRound.status === "running") {
      lastRound.completedAt = Date.now();
      lastRound.durationMs = lastRound.completedAt - lastRound.startedAt;
      lastRound.status = "error";
    }

    await this.adapter
      .injectNote(loop.originSessionId, `${LOOP_PROGRESS_MARKER} error: ${reason}]`)
      .catch(() => {});
  }
}
