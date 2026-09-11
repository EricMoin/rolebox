import type { LoopState, LoopMode, RegisterResult } from "./types.js";
import type { IDispatchAdapter } from "./dispatch-adapter.js";
import { LOOP_PROGRESS_MARKER, LOOP_STATE_SCHEMA_VERSION, ADVANCING_LOCK_TIMEOUT_MS, SWEEPER_INTERVAL_MS, MAX_TREE_WORKER_SESSIONS } from "./constants.js";
import { shouldCancelLoop, TERMINAL_PHASES } from "./cancellation.js";
import {
  dispatchRound,
  handleSummary,
  finalizeLoop,
  failLoop,
} from "./worker-dispatch.js";
import { createSubLogger } from "../logger.ts";
import { createHash } from "node:crypto";

const log = createSubLogger("loop/coordinator");

export { shouldCancelLoop, DISPATCH_MARKERS } from "./cancellation.js";

/**
 * Normalize a prompt string for deterministic fingerprinting:
 * collapse all whitespace sequences to a single space, trim, and lowercase.
 */
function normalizePromptForFingerprint(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Compute a stable SHA-256 fingerprint of a normalized prompt string.
 */
function computePromptFingerprint(prompt: string): string {
  return createHash("sha256").update(normalizePromptForFingerprint(prompt)).digest("hex");
}

/**
 * Find the root loop ID by walking up the parentLoopId chain.
 * Returns the originSessionId of the topmost ancestor (root).
 */
function findRootLoopId(loops: Map<string, LoopState>, startId: string): string {
  let current: string | undefined = startId;
  while (true) {
    const loop = loops.get(current);
    if (!loop || !loop.parentLoopId) return current;
    current = loop.parentLoopId;
  }
}

/**
 * Count the number of non-terminal loops in the tree rooted at `rootId`,
 * including the root itself. Each non-terminal loop represents an active
 * worker session.
 */
function countTreeNonTerminal(loops: Map<string, LoopState>, rootId: string): number {
  const root = loops.get(rootId);
  if (!root) return 0;
  let count = TERMINAL_PHASES.has(root.phase) ? 0 : 1;
  for (const loop of loops.values()) {
    if (loop.parentLoopId === rootId) {
      count += countTreeNonTerminal(loops, loop.originSessionId);
    }
  }
  return count;
}

export class LoopCoordinator {
  private loops = new Map<string, LoopState>();
  private _advancing = new Map<string, number>();
  private _workerToOrigin = new Map<string, string>();
  /** Map of workerTaskId → terminated listener callback, for cleanup on cancel/fail */
  private _workerListeners = new Map<string, (taskId: string, status: string) => void>();
  /** Completions that arrived while the _advancing re-entrancy guard was held, keyed by originSessionId. */
  private _pendingCompletions = new Map<string, string[]>();
  /** Timer reference for the stale-lock sweeper interval, cleared on dispose. */
  private _advancingSweeper: ReturnType<typeof setInterval> | null = null;
  /** Counter of stale locks detected and swept by the sweeper. */
  private _staleLockCount = 0;

  constructor(
    private adapter: IDispatchAdapter,
    private opts?: {
      delayMs?: number;
      roundTimeoutMs?: number;
      persist?: (loops: Map<string, LoopState>) => void;
    },
  ) {
    this._advancingSweeper = setInterval(() => this._sweepStaleLocks(), SWEEPER_INTERVAL_MS);
    if (this._advancingSweeper && typeof this._advancingSweeper === "object" && "unref" in this._advancingSweeper) {
      (this._advancingSweeper as any).unref();
    }
  }

  private _persist(): void {
    this.opts?.persist?.(this.loops);
  }

  /**
   * Periodic sweeper that detects and releases stale _advancing locks.
   * Runs every SWEEPER_INTERVAL_MS. A lock is stale if it has been held
   * longer than ADVANCING_LOCK_TIMEOUT_MS without being released, which
   * would indicate an exception escaped the try block without the finally
   * block executing.
   */
  private _sweepStaleLocks(): void {
    const now = Date.now();
    const stale: { sessionId: string; ageMs: number }[] = [];
    for (const [sessionId, acquiredAt] of this._advancing) {
      const ageMs = now - acquiredAt;
      if (ageMs > ADVANCING_LOCK_TIMEOUT_MS) {
        stale.push({ sessionId, ageMs });
      }
    }
    for (const { sessionId, ageMs } of stale) {
      this._advancing.delete(sessionId);
      this._staleLockCount++;
      log.warn("advancing-lock: swept stale lock", { sessionId, acquiredAgeMs: ageMs });
      // Drain any pending completions that were deferred during the abandoned critical section.
      // Mirror the pattern in _kickoffFromActivating and onWorkerCompleted finally blocks.
      const pending = this._pendingCompletions.get(sessionId);
      if (pending && pending.length > 0) {
        this._pendingCompletions.delete(sessionId);
        const nextTaskId = pending[pending.length - 1];
        log.debug("loop-trace: draining deferred completion from stale-lock sweep", { sessionId, taskId: nextTaskId });
        queueMicrotask(() => { void this.onWorkerCompleted(nextTaskId); });
      }
    }
  }

  // ── Private helpers (push-chain) ────────────────────────────────────────

  /**
   * Register a fire-once terminated listener on the loop's active worker task.
   * When the worker completes, the listener triggers onWorkerCompleted, which
   * chains into _advanceFromSummarizing to continue the push-driven loop.
   */
  private _registerWorkerListener(loop: LoopState): void {
    if (!loop.activeWorkerTaskId) return;
    log.debug("loop-trace: registerWorkerListener", { originSessionId: loop.originSessionId, taskId: loop.activeWorkerTaskId });
    const taskId = loop.activeWorkerTaskId;
    const cb = this.adapter.registerTerminatedListener(
      taskId,
      (_taskId: string, _status: string) => {
        // Fire-once: auto-removed by the registry after invocation.
        // Remove our local reference.
        this._workerListeners.delete(_taskId);
        // Fire-and-forget: onWorkerCompleted catches internal errors
        // and routes them through failLoop.
        this.onWorkerCompleted(_taskId);
      },
    );
    this._workerListeners.set(taskId, cb);
  }

  /**
   * Remove a pending terminated listener for a worker task that is being
   * cancelled or has errored (prevents callback leakage).
   */
  private _cleanupWorkerListener(workerTaskId: string | undefined): void {
    if (!workerTaskId) return;
    const cb = this._workerListeners.get(workerTaskId);
    if (cb) {
      this.adapter.removeTerminatedListener(workerTaskId, cb);
    }
    this._workerListeners.delete(workerTaskId);  // always cleanup
  }

  /**
   * Self-driving push-chain step: read summary, advance round count, then
   * either finalize (all rounds done) or dispatch the next round and register
   * its listener.  This runs inside the same _advancing critical section as
   * onWorkerCompleted, so no external idle event is needed.
   */
  private async _advanceFromSummarizing(originSessionId: string): Promise<void> {
    const loop = this.loops.get(originSessionId);
    log.debug("loop-trace: _advanceFromSummarizing entry", { originSessionId, phase: loop?.phase, round: loop?.current });
    if (!loop) return;
    if (loop.phase !== "summarizing") return;

    await handleSummary(
      this.adapter,
      loop,
      this._workerToOrigin,
      async () => {
        log.debug("loop-trace: dispatchRound beginning in handleSummary callback", { originSessionId, round: loop.current });
        await dispatchRound(this.adapter, loop, this._workerToOrigin, {
          roundTimeoutMs: this.opts?.roundTimeoutMs,
        });
        log.debug("loop-trace: dispatchRound complete in handleSummary", { originSessionId, newTaskId: loop.activeWorkerTaskId, phase: loop.phase, round: loop.current });
      },
      { delayMs: this.opts?.delayMs },
    );

    // If handleSummary dispatched a new round (phase became awaiting_worker),
    // register its terminated listener to continue the push chain.
    // If it finalized (complete/cancelled), no listener needed.
    // Use phase accessor to bypass TS narrowing (handleSummary mutates phase)
    if ((loop as LoopState).phase === "awaiting_worker" && loop.activeWorkerTaskId) {
      this._registerWorkerListener(loop);
    }
    log.debug("loop-trace: _advanceFromSummarizing exit", { originSessionId, phase: (loop as LoopState).phase, round: (loop as LoopState).current });
  }

  /**
   * Self-kickoff for loops in the activating phase. When register() creates a
   * loop with phase="activating", or reSubscribeListeners() recovers an
   * activating loop after restart, this method transitions it to dispatching
   * and dispatches the first round. This eliminates the previous dependency on
   * onOriginIdle for first-round kickoff.
   */
  private async _kickoffFromActivating(originSessionId: string): Promise<void> {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    if (loop.phase !== "activating") return;
    if (this._advancing.has(originSessionId)) return;

    this._advancing.set(originSessionId, Date.now());
    try {
      loop.phase = "dispatching";
      await dispatchRound(this.adapter, loop, this._workerToOrigin, {
        roundTimeoutMs: this.opts?.roundTimeoutMs,
      });
      // Register terminated listener on the first worker task,
      // starting the push-driven chain.
      this._registerWorkerListener(loop);
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
    } finally {
      this._advancing.delete(originSessionId);
      // Drain any completions that arrived while we held the critical section.
      {
        const pending = this._pendingCompletions.get(originSessionId);
        if (pending && pending.length > 0) {
          this._pendingCompletions.delete(originSessionId);
          const nextTaskId = pending[pending.length - 1];
          log.debug("loop-trace: draining deferred completion", { originSessionId, taskId: nextTaskId });
          queueMicrotask(() => { void this.onWorkerCompleted(nextTaskId); });
        }
      }
      this._persist();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  register(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    mode: LoopMode;
    iterations: number;
    objective?: string;
  }): RegisterResult {
    // ── Check: already active for this session ──────────────────
    if (this.loops.has(input.originSessionId)) {
      return { ok: false, reason: "loop already active for this session" };
    }

    // ── (a) Compute prompt fingerprint ──────────────────────────
    const promptFingerprint = computePromptFingerprint(input.prompt);

    // ── (b) Lineage detection: is originSessionId a worker
    //        session of an active (non-terminal) loop? ───────────
    let parentLoopId: string | undefined;
    for (const loop of this.loops.values()) {
      if (TERMINAL_PHASES.has(loop.phase)) continue;
      // Check active worker session
      if (loop.activeWorkerSessionId === input.originSessionId) {
        parentLoopId = loop.originSessionId;
        break;
      }
      // Check past rounds' worker sessions
      if (loop.rounds?.some((r) => r.workerSessionId === input.originSessionId)) {
        parentLoopId = loop.originSessionId;
        break;
      }
    }
    // Also check if originSessionId is a worker task ID in _workerToOrigin
    if (!parentLoopId) {
      const originByTask = this._workerToOrigin.get(input.originSessionId);
      if (originByTask) {
        const parentLoop = this.loops.get(originByTask);
        if (parentLoop && !TERMINAL_PHASES.has(parentLoop.phase)) {
          parentLoopId = originByTask;
        }
      }
    }

    // ── (c) Ancestor chain fingerprint dedup ────────────────────
    if (parentLoopId) {
      let ancestorId: string | undefined = parentLoopId;
      while (ancestorId) {
        const ancestor = this.loops.get(ancestorId);
        if (!ancestor) break;
        if (ancestor.promptFingerprint === promptFingerprint) {
          return {
            ok: false,
            reason:
              "identical task already looping in ancestor chain " +
              "— refine the task or report blockage instead",
          };
        }
        ancestorId = ancestor.parentLoopId;
      }
    }

    // ── (d) Tree-level budget enforcement ───────────────────────
    {
      const rootId = parentLoopId
        ? findRootLoopId(this.loops, parentLoopId)
        : input.originSessionId;
      const currentCount = countTreeNonTerminal(this.loops, rootId);
      // +1 for the loop being registered (not yet in this.loops)
      if (currentCount + 1 > MAX_TREE_WORKER_SESSIONS) {
        return {
          ok: false,
          reason:
            `tree worker budget exhausted: ${currentCount} active ` +
            `(max ${MAX_TREE_WORKER_SESSIONS}) — some loops must complete ` +
            `before spawning more`,
        };
      }
    }

    // ── Create LoopState ────────────────────────────────────────
    const now = Date.now();
    const state: LoopState = {
      originSessionId: input.originSessionId,
      agent: input.agent,
      basePrompt: input.prompt,
      objective: input.objective,
      promptFingerprint,
      parentLoopId,
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
    void Promise.resolve().then(() => this._kickoffFromActivating(input.originSessionId));

    return { ok: true };
  }

  async onOriginIdle(originSessionId: string): Promise<void> {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;
    if (this._advancing.has(originSessionId)) return;

    this._advancing.set(originSessionId, Date.now());
    try {
      switch (loop.phase) {
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
    if (!originSessionId) {
      log.debug("loop-trace: onWorkerCompleted guard — originSessionId not found", { workerTaskId });
      return;
    }

    const loop = this.loops.get(originSessionId);
    if (!loop) {
      log.debug("loop-trace: onWorkerCompleted guard — loop not found", { workerTaskId, originSessionId });
      return;
    }
    if (loop.phase !== "awaiting_worker") {
      log.debug("loop-trace: onWorkerCompleted guard — phase mismatch", { workerTaskId, originSessionId, phase: loop.phase });
      return;
    }
    if (loop.activeWorkerTaskId !== workerTaskId) {
      log.debug("loop-trace: onWorkerCompleted guard — taskId mismatch", { workerTaskId, originSessionId, activeWorkerTaskId: loop.activeWorkerTaskId });
      return;
    }

    log.debug("loop-trace: onWorkerCompleted entry", {
      workerTaskId,
      originSessionId,
      phase: loop.phase,
      activeWorkerTaskId: loop.activeWorkerTaskId,
      advancingHeld: this._advancing.has(originSessionId),
    });

    if (this._advancing.has(originSessionId)) {
      // Queue for processing after the current critical section exits.
      let pending = this._pendingCompletions.get(originSessionId);
      if (!pending) { pending = []; this._pendingCompletions.set(originSessionId, pending); }
      pending.push(workerTaskId);
      log.debug("loop-trace: onWorkerCompleted deferred — _advancing held", { originSessionId, workerTaskId });
      return;
    }

    this._advancing.set(originSessionId, Date.now());
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

      // Push-chain: advance from summarizing → dispatch next round or finalize.
      // This runs inside the same _advancing critical section, so it is
      // serialised and does not depend on an external idle event.
      await this._advanceFromSummarizing(originSessionId);
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
    } finally {
      this._advancing.delete(originSessionId);
      // Drain any completions that arrived while we held the critical section.
      {
        const pending = this._pendingCompletions.get(originSessionId);
        if (pending && pending.length > 0) {
          const taskIds = [...pending];  // copy before clearing
          pending.length = 0;
          for (const taskId of taskIds) {
            log.debug("loop-trace: draining deferred completion", { originSessionId, taskId });
            queueMicrotask(() => { void this.onWorkerCompleted(taskId); });
          }
        }
      }
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

    // Clean up the pending terminated listener before cancelling the worker
    this._cleanupWorkerListener(loop.activeWorkerTaskId);

    this._advancing.set(loop.originSessionId, Date.now());
    try {
      loop.phase = "finalizing";
      await finalizeLoop(this.adapter, loop, "cancelled", this._workerToOrigin);
    } catch (err) {
      await failLoop(this.adapter, loop, err instanceof Error ? err.message : String(err), this._workerToOrigin);
    } finally {
      this._advancing.delete(loop.originSessionId);
      this._persist();
    }

    // ── (f) Cascade: cancel all child loops recursively ──────
    // Collect child IDs first to avoid mutation during iteration.
    const childIds: string[] = [];
    for (const [childId, childLoop] of this.loops) {
      if (
        childLoop.parentLoopId === loop.originSessionId &&
        !TERMINAL_PHASES.has(childLoop.phase) &&
        childLoop.phase !== "finalizing"
      ) {
        childIds.push(childId);
      }
    }
    for (const childId of childIds) {
      try {
        await this.cancelNow(childId);
      } catch (err) {
        log.warn("cancelNow: cascade failed for child loop", {
          parentId: loop.originSessionId,
          childId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

  // ── (g) Tree navigation helpers ───────────────────────────────

  /**
   * Walk up the parentLoopId chain and return all ancestor LoopStates,
   * ordered from nearest ancestor to root.
   */
  getLoopAncestors(originSessionId: string): LoopState[] {
    const ancestors: LoopState[] = [];
    let current: string | undefined = this.loops.get(originSessionId)?.parentLoopId;
    while (current) {
      const ancestor = this.loops.get(current);
      if (!ancestor) break;
      ancestors.push(ancestor);
      current = ancestor.parentLoopId;
    }
    return ancestors;
  }

  /**
   * Collect all descendant loops (children, grandchildren, etc.)
   * of the given originSessionId recursively. Returns a flat array.
   */
  getLoopDescendants(originSessionId: string): LoopState[] {
    const descendants: LoopState[] = [];
    for (const loop of this.loops.values()) {
      if (loop.parentLoopId === originSessionId) {
        descendants.push(loop);
        descendants.push(...this.getLoopDescendants(loop.originSessionId));
      }
    }
    return descendants;
  }

  /**
   * Returns the current state of the _advancing lock map for health monitoring.
   * - `activeLocks`: number of locks currently held (non-stale)
   * - `staleLocks`: cumulative count of stale locks detected and swept
   */
  getAdvancingLockState(): { activeLocks: number; staleLocks: number } {
    return {
      activeLocks: this._advancing.size,
      staleLocks: this._staleLockCount,
    };
  }

  async failSession(sessionId: string, reason: string): Promise<void> {
    let loop = this.loops.get(sessionId);
    if (!loop) {
      const originId = this._workerToOrigin.get(sessionId);
      if (originId) loop = this.loops.get(originId);
    }
    if (!loop || TERMINAL_PHASES.has(loop.phase)) return;
    // Clean up the pending terminated listener before failing the loop
    this._cleanupWorkerListener(loop.activeWorkerTaskId);
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

  /**
   * Re-subscribe terminated listeners and advance loops after a restart.
   *
   * Called after reconcile + restoreState has loaded persisted loops and
   * reconciled their phase against dispatch task state. For each non-terminal
   * loop:
   *
   * - `awaiting_worker` with a completed worker → triggers onWorkerCompleted
   *   to advance through the push chain (summary → next round or finalize).
   * - `awaiting_worker` with a still-running worker → re-subscribes the
   *   terminated listener so the push chain resumes when the worker finishes.
   * - `summarizing` → calls _advanceFromSummarizing to resume the push chain
   *   (the worker completed during the restart window).
   *
   * Each transition runs inside the _advancing re-entrancy guard to stay
   * serialised with normal push-chain operations.
   */
  async reSubscribeListeners(): Promise<void> {
    const nonTerminal = this.getNonTerminalLoops();

    for (const loop of nonTerminal) {
      const originSessionId = loop.originSessionId;

      // ── summarizing: advance the push chain ─────────────────────
      if (loop.phase === "summarizing") {
        if (this._advancing.has(originSessionId)) continue;
        this._advancing.set(originSessionId, Date.now());
        try {
          await this._advanceFromSummarizing(originSessionId);
        } catch (err) {
          log.warn("reSubscribeListeners: _advanceFromSummarizing failed", {
            originSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this._advancing.delete(originSessionId);
        }
        continue;
      }

      // ── activating: self-kickoff first round ──────────────────────
      if (loop.phase === "activating") {
        await this._kickoffFromActivating(originSessionId);
        continue;
      }

      // ── awaiting_worker: re-subscribe or catch already-completed ─
      if (loop.phase === "awaiting_worker" && loop.activeWorkerTaskId) {
        const taskId = loop.activeWorkerTaskId;

        let status: string | undefined;
        try {
          status = await this.adapter.getTaskStatus(taskId);
        } catch (error) {
          log.warn("reSubscribeListeners: getTaskStatus failed", { taskId, error: error instanceof Error ? error.message : String(error) });
          loop.phase = "interrupted";
          loop.errorReason = "getTaskStatus failed during reSubscribe: " + (error instanceof Error ? error.message : String(error));
          loop.updatedAt = Date.now();
          this._persist();
          continue;
        }

        if (!status) {
          // Worker task not found in dispatch system — mark interrupted
          loop.phase = "interrupted";
          loop.errorReason = "Worker task vanished during restart recovery";
          loop.updatedAt = Date.now();
          this._persist();
          continue;
        }

        // Worker already completed during restart — push-chain advance
        if (status === "completed" || status === "error" || status === "cancelled" || status === "timeout") {
          await this.onWorkerCompleted(taskId);
          continue;
        }

        // Worker still running/pending — re-subscribe terminated listener
        if (status === "running" || status === "pending") {
          this._registerWorkerListener(loop);
          continue;
        }
      }
    }
  }

  dispose(): void {
    if (this._advancingSweeper !== null) {
      clearInterval(this._advancingSweeper);
      this._advancingSweeper = null;
    }
    // Cleanup worker listeners before clearing map
    for (const [workerTaskId, cb] of this._workerListeners) {
      try { this.adapter.removeTerminatedListener(workerTaskId, cb); } catch { /* best effort */ }
    }
    this._workerListeners.clear();
    this.loops.clear();
    this._workerToOrigin.clear();
    this._advancing.clear();
    this._pendingCompletions.clear();
  }
}
