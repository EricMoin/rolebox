import type { LoopState, LoopMode } from "./types.js";
import type { IDispatchAdapter } from "./dispatch-adapter.js";
import { LOOP_PROGRESS_MARKER, LOOP_STATE_SCHEMA_VERSION } from "./constants.js";
import { shouldCancelLoop, TERMINAL_PHASES } from "./cancellation.js";
import {
  dispatchRound,
  handleSummary,
  finalizeLoop,
  failLoop,
} from "./worker-dispatch.js";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("loop/coordinator");

export { shouldCancelLoop, DISPATCH_MARKERS } from "./cancellation.js";

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
          await dispatchRound(this.adapter, loop, this._workerToOrigin, {
            roundTimeoutMs: this.opts?.roundTimeoutMs,
          });
          break;
        case "summarizing":
          await handleSummary(
            this.adapter,
            loop,
            this._workerToOrigin,
            () => dispatchRound(this.adapter, loop, this._workerToOrigin, {
              roundTimeoutMs: this.opts?.roundTimeoutMs,
            }),
            { delayMs: this.opts?.delayMs },
          );
          break;
        default:
          break;
      }
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
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

      const lastRound = loop.rounds?.[loop.rounds.length - 1];
      if (lastRound && lastRound.status === "running") {
        const now = Date.now();
        lastRound.completedAt = now;
        lastRound.durationMs = now - lastRound.startedAt;
        lastRound.status = result.hadError ? "error" : "completed";
      }

      if (result.hadError) {
        await failLoop(this.adapter, loop, result.errorReason ?? "Worker round failed", this._workerToOrigin);
        return;
      }

      if (lastRound) {
        const dur = lastRound.durationMs !== undefined ? `${(lastRound.durationMs / 1000).toFixed(1)}s` : "?";
        await this.adapter
          .injectNote(
            loop.originSessionId,
            `${LOOP_PROGRESS_MARKER} round ${lastRound.round}/${loop.total} ${lastRound.status}, session=${lastRound.workerSessionId}, duration=${dur}]`,
          )
          .catch((err) => {
            log.warn("Failed to inject loop progress note", { err });
          });
      }

      const lastMsgId = await this.adapter.getLastMessageId(originSessionId);
      loop.summaryBoundaryMessageId = lastMsgId;
      loop.phase = "summarizing";
      loop.updatedAt = Date.now();
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
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
      await finalizeLoop(this.adapter, loop, "cancelled", this._workerToOrigin);
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
    } finally {
      this._advancing.delete(loop.originSessionId);
      this._persist();
    }
  }

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
    await failLoop(this.adapter, loop, reason, this._workerToOrigin);
    this._persist();
  }

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
}
