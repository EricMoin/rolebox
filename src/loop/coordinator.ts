import type { LoopState, LoopMode, LoopPhase } from "./types.js";
import type { IDispatchAdapter } from "./dispatch-adapter.js";
import {
  SEED_CHAR_CAP,
  INTER_ROUND_DELAY_MS,
  DISPATCH_ROUND_TIMEOUT_MS,
  LOOP_PROGRESS_MARKER,
  LOOP_STATE_SCHEMA_VERSION,
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
 * Only **genuine human messages** during user-owned phases (`awaiting_worker`,
 * `dispatching`) trigger cancellation. System re-prompts (dispatch completion
 * markers, auto-continue, loop-progress notes) are explicitly excluded — they
 * re-enter the chat.message hook as synthetic injections and must never cancel
 * the loop.
 */
export function shouldCancelLoop(
  loopState: LoopState,
  messageText: string,
): boolean {
  // 1. Never cancel on dispatch system re-prompts
  if (isDispatchNotification(messageText)) return false;

  // 2. Never cancel on auto-continue injections
  if (messageText.includes(AUTO_CONTINUE_PREFIX)) return false;

  // 3. Never cancel on loop-progress markers
  if (messageText.includes(LOOP_PROGRESS_MARKER)) return false;

  // 4. Never cancel on terminal phases
  if (TERMINAL_PHASES.has(loopState.phase)) return false;

  // 5. Never cancel on origin-owned phases (activating, summarizing, finalizing)
  if (ORIGIN_OWNED_PHASES.has(loopState.phase)) return false;

  // 6. Only cancel during user-owned phases
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
    private opts?: { delayMs?: number; roundTimeoutMs?: number },
  ) {}

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
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    this.loops.set(input.originSessionId, state);
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
    } finally {
      this._advancing.delete(originSessionId);
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

      if (result.hadError) {
        loop.phase = "error";
        loop.errorReason = result.errorReason ?? "Worker round failed";
        loop.updatedAt = Date.now();
        await this.adapter.injectNote(
          originSessionId,
          `${LOOP_PROGRESS_MARKER} error: ${loop.errorReason}]`,
        );
        return;
      }

      const lastMsgId = await this.adapter.getLastMessageId(originSessionId);
      loop.summaryBoundaryMessageId = lastMsgId;
      loop.phase = "summarizing";
      loop.updatedAt = Date.now();
      // DispatchManager's notifyParent re-prompts origin → origin produces summary → onOriginIdle fires
    } finally {
      this._advancing.delete(originSessionId);
    }
  }

  requestCancel(originSessionId: string): void {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    loop.cancelRequested = true;
    loop.updatedAt = Date.now();
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

  /** Feed a recovered loop state back into the coordinator (startup recovery). */
  restoreState(state: LoopState): void {
    if (this.loops.has(state.originSessionId)) return;
    this.loops.set(state.originSessionId, state);
    if (state.activeWorkerTaskId) {
      this._workerToOrigin.set(state.activeWorkerTaskId, state.originSessionId);
    }
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
    });

    loop.activeWorkerTaskId = result.workerTaskId;
    loop.activeWorkerSessionId = result.workerSessionId;
    loop.phase = "awaiting_worker";
    loop.roundStartedAt = Date.now();
    loop.updatedAt = Date.now();

    this._workerToOrigin.set(result.workerTaskId, loop.originSessionId);
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

    loop.phase = terminalPhase;
    loop.updatedAt = Date.now();

    const marker =
      terminalPhase === "complete"
        ? `${LOOP_PROGRESS_MARKER} loop complete]`
        : `${LOOP_PROGRESS_MARKER} loop cancelled]`;

    await this.adapter.injectNote(loop.originSessionId, marker);
  }
}
