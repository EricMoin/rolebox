import type { OpencodeClient } from "@opencode-ai/sdk";
import type { LoopState, LoopMode } from "./types.js";
import {
  LOOP_PROGRESS_MARKER,
  LOOP_STATE_SCHEMA_VERSION,
} from "./constants.js";
import { LoopStore } from "./loop-store.js";
import { shouldCancelLoop } from "./coordinator.js";

const NON_TERMINAL_STATUSES = new Set([
  "running",
  "summarizing",
  "spawning",
  "waiting",
]);

interface LoopManagerHooks {
  register(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    mode: LoopMode;
    iterations: number;
  }): void;
}

export class LoopManager implements LoopManagerHooks {
  private loops = new Map<string, LoopState>();
  private childToOrigin = new Map<string, string>();
  private store?: LoopStore;
  private timer?: ReturnType<typeof setTimeout>;
  private _dirty = false;
  private _advancing = new Set<string>();
  private readonly client: OpencodeClient;

  constructor(
    client: OpencodeClient,
    _opts?: { delayMs?: number; roundTimeoutMs?: number },
  ) {
    this.client = client;
  }

  setStoreDirectory(dir: string): void {
    this.store = new LoopStore(dir);
  }

  recover(): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (!loaded) return;

    for (const [id, state] of loaded) {
      this.loops.set(id, state);
      if (state.activeSessionId !== id) {
        this.childToOrigin.set(state.activeSessionId, id);
      }
      if (NON_TERMINAL_STATUSES.has(state.status)) {
        state.status = "interrupted";
      }
      state.updatedAt = Date.now();
    }
    this._persist();
  }

  register(input: {
    originSessionId: string;
    agent: string;
    prompt: string;
    mode: LoopMode;
    iterations: number;
  }): void {
    const existing = this.loops.get(input.originSessionId);
    if (existing) return;

    const now = Date.now();
    const state: LoopState = {
      originSessionId: input.originSessionId,
      agent: input.agent,
      prompt: input.prompt,
      mode: input.mode,
      total: input.iterations,
      current: 1,
      status: "running",
      activeSessionId: input.originSessionId,
      lastSummary: undefined,
      cancelRequested: false,
      errorReason: undefined,
      startedAt: now,
      updatedAt: now,
      roundStartedAt: now,
      schemaVersion: LOOP_STATE_SCHEMA_VERSION,
    };

    this.loops.set(input.originSessionId, state);
    this._persist();
  }

  isLoopSession(sid: string): boolean {
    if (this.loops.has(sid) || this.childToOrigin.has(sid)) return true;
    // New dispatch model: check if this session is an active worker for any loop
    for (const loop of this.loops.values()) {
      if (loop.activeWorkerSessionId === sid) return true;
    }
    return false;
  }

  isLoopOrigin(sid: string): boolean {
    return this.loops.has(sid);
  }

  isLoopChild(sid: string): boolean {
    if (this.childToOrigin.has(sid)) return true;
    for (const loop of this.loops.values()) {
      if (loop.activeWorkerSessionId === sid) return true;
    }
    return false;
  }

  /**
   * Returns true if this session is the origin of an active loop.
   * Used by the continuation guard to prevent auto-continue during
   * loop-owned phases (summarizing, activating, finalizing).
   */
  isActiveLoopOrigin(sid: string): boolean {
    return this.loops.has(sid);
  }

  /**
   * Cancellation decision for user messages.
   *
   * Supports both the new phase-based model (LoopCoordinator) via delegation
   * to {@link shouldCancelLoop}, and the old status-based model (backward compat).
   * System re-prompts (dispatch markers, auto-continue, loop-progress) are
   * explicitly excluded in both models.
   */
  shouldCancelOnUserMessage(sessionId: string, messageText: string): boolean {
    let loop = this.loops.get(sessionId);
    if (!loop) {
      const originId = this.childToOrigin.get(sessionId);
      if (originId) loop = this.loops.get(originId);
    }
    if (!loop) return false;

    // Phase-based model (new): delegate to shouldCancelLoop
    if (loop.phase) {
      if (!shouldCancelLoop(loop, messageText)) return false;
      loop.cancelRequested = true;
      loop.updatedAt = Date.now();
      return true;
    }

    // Status-based model (old): backward-compatible logic
    if (LoopManager.TERMINAL_STATUSES.has(loop.status)) return false;
    if (loop.status === "interrupted") return false;
    if (loop.activeSessionId === sessionId) return false;
    loop.cancelRequested = true;
    loop.updatedAt = Date.now();
    return true;
  }

  getLoopState(originSessionId: string): LoopState | undefined {
    return this.loops.get(originSessionId);
  }

  getByActiveSession(sid: string): LoopState | undefined {
    if (this.loops.has(sid)) {
      const loop = this.loops.get(sid)!;
      if (loop.activeSessionId === sid) return loop;
    }
    const origin = this.childToOrigin.get(sid);
    if (origin) {
      const loop = this.loops.get(origin);
      if (loop && loop.activeSessionId === sid) return loop;
    }
    for (const loop of this.loops.values()) {
      if (loop.activeSessionId === sid) return loop;
    }
    return undefined;
  }

  requestCancel(originSessionId: string, reason?: string): void {
    const loop = this.loops.get(originSessionId);
    if (!loop) return;

    loop.cancelRequested = true;
    loop.updatedAt = Date.now();

    if (loop.status === "waiting") {
      loop.status = "cancelled";
      loop.updatedAt = Date.now();
      this._injectNote(
        originSessionId,
        `${LOOP_PROGRESS_MARKER} loop cancelled${reason ? `: ${reason}` : ""}]`,
      );
      this._persist();
    }
  }

  private static readonly TERMINAL_STATUSES = new Set([
    "complete",
    "cancelled",
    "error",
  ]);

  handleSessionError(sid: string, error?: string): void {
    let loop: LoopState | undefined;
    if (this.loops.has(sid)) {
      loop = this.loops.get(sid);
    } else {
      const origin = this.childToOrigin.get(sid);
      if (origin) {
        loop = this.loops.get(origin);
        this.childToOrigin.delete(sid);
      }
    }

    if (!loop) return;
    if (LoopManager.TERMINAL_STATUSES.has(loop.status)) return;
    if (this._advancing.has(loop.originSessionId)) return;

    loop.errorReason = error ?? "Unknown error";
    loop.status = "error";
    loop.updatedAt = Date.now();

    this._injectNote(
      loop.originSessionId,
      `${LOOP_PROGRESS_MARKER} error: ${loop.errorReason}]`,
    );
    this._persist();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this._dirty && this.store) {
      this._dirty = false;
      this.store.saveSync(this.loops);
    }
  }

  // ── private ─────────────────────────────────────────────────────

  private _injectNote(
    sessionId: string,
    text: string,
    agent?: string,
  ): ReturnType<OpencodeClient["session"]["promptAsync"]> {
    return this.client.session.promptAsync({
      path: { id: sessionId },
      body: {
        ...agent ? { agent } : {},
        noReply: true,
        parts: [{ type: "text", text }],
      },
    });
  }

  private _persist(): void {
    if (!this.store) return;
    this._dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this._dirty) return;
      this._dirty = false;
      this.store!.save(this.loops).catch(() => {});
    }, 500);
  }
}
