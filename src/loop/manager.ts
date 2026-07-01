import type { OpencodeClient } from "@opencode-ai/sdk";
import type { LoopState, LoopMode } from "./types.js";
import {
  SUMMARY_INPUT_CHAR_CAP,
  INTER_ROUND_DELAY_MS,
  LOOP_PROGRESS_MARKER,
  LOOP_STATE_SCHEMA_VERSION,
  SUMMARIZER_TIMEOUT_MS,
  ROUND_TIMEOUT_MS,
  SPAWN_MAX_RETRIES,
  SPAWN_RETRY_BASE_DELAY_MS,
} from "./constants.js";
import { LoopStore } from "./loop-store.js";
import { createSummarizerFn } from "./summarizer.js";

type SummarizeFn = ReturnType<typeof createSummarizerFn>;

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
  onRoundComplete(activeSessionId: string): Promise<void>;
}

export class LoopManager implements LoopManagerHooks {
  private loops = new Map<string, LoopState>();
  private childToOrigin = new Map<string, string>();
  private store?: LoopStore;
  private timer?: ReturnType<typeof setTimeout>;
  private _watchdog?: ReturnType<typeof setInterval>;
  private _dirty = false;
  private _advancing = new Set<string>();
  private _summarizer?: SummarizeFn;
  private readonly client: OpencodeClient;
  private readonly _delayMs: number;
  private readonly _roundTimeoutMs: number;

  constructor(
    client: OpencodeClient,
    opts?: { delayMs?: number; roundTimeoutMs?: number },
  ) {
    this.client = client;
    this._delayMs = opts?.delayMs ?? INTER_ROUND_DELAY_MS;
    this._roundTimeoutMs = opts?.roundTimeoutMs ?? ROUND_TIMEOUT_MS;
    this._startWatchdog();
  }

  private _startWatchdog(): void {
    const interval = Math.min(this._roundTimeoutMs / 2, 60_000);
    this._watchdog = setInterval(() => this._checkRoundTimeouts(), interval);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  private _checkRoundTimeouts(): void {
    const now = Date.now();
    for (const loop of this.loops.values()) {
      if (loop.status !== "running") continue;
      if (this._advancing.has(loop.originSessionId)) continue;
      if (now - loop.roundStartedAt > this._roundTimeoutMs) {
        loop.status = "error";
        loop.errorReason = `Round ${loop.current} timed out after ${Math.round(this._roundTimeoutMs / 1000)}s`;
        loop.updatedAt = now;
        this._injectNote(
          loop.originSessionId,
          `${LOOP_PROGRESS_MARKER} error: ${loop.errorReason}]`,
        );
        if (loop.activeSessionId !== loop.originSessionId) {
          this.childToOrigin.delete(loop.activeSessionId);
        }
        this._persist();
      }
    }
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
    return this.loops.has(sid) || this.childToOrigin.has(sid);
  }

  isLoopOrigin(sid: string): boolean {
    return this.loops.has(sid);
  }

  isLoopChild(sid: string): boolean {
    return this.childToOrigin.has(sid);
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

  async onRoundComplete(activeSessionId: string): Promise<void> {
    const loop = this.getByActiveSession(activeSessionId);
    if (!loop || loop.status !== "running") return;

    const origin = loop.originSessionId;

    if (this._advancing.has(origin)) return;
    this._advancing.add(origin);

    try {
      if (loop.cancelRequested) {
        loop.status = "cancelled";
        loop.updatedAt = Date.now();
        await this._injectNote(
          origin,
          `${LOOP_PROGRESS_MARKER} loop cancelled]`,
        );
        this.childToOrigin.delete(activeSessionId);
        this._persist();
        return;
      }

      if (loop.current >= loop.total) {
        loop.status = "complete";
        loop.updatedAt = Date.now();
        await this._injectNote(
          origin,
          `${LOOP_PROGRESS_MARKER} loop complete (round ${loop.current}/${loop.total})]`,
        );
        this.childToOrigin.delete(activeSessionId);
        this._persist();
        return;
      }

      const nextPrompt = await this._determineNextPrompt(loop, activeSessionId);

      if (loop.cancelRequested) {
        loop.status = "cancelled";
        loop.updatedAt = Date.now();
        await this._injectNote(
          origin,
          `${LOOP_PROGRESS_MARKER} loop cancelled]`,
        );
        this.childToOrigin.delete(activeSessionId);
        this._persist();
        return;
      }

      loop.status = "waiting";
      loop.updatedAt = Date.now();
      this._persist();

      await this._delay(this._delayMs);

      if (loop.cancelRequested) {
        loop.status = "cancelled";
        loop.updatedAt = Date.now();
        await this._injectNote(
          origin,
          `${LOOP_PROGRESS_MARKER} loop cancelled]`,
        );
        this.childToOrigin.delete(activeSessionId);
        this._persist();
        return;
      }

      loop.status = "spawning";
      let childId: string | undefined;
      for (let attempt = 0; attempt <= SPAWN_MAX_RETRIES; attempt++) {
        if (loop.cancelRequested) break;
        const createResult = await this.client.session.create({
          body: { parentID: origin },
        });
        childId = (
          (createResult as { data?: { id?: string } }).data
        )?.id;
        if (childId) break;
        if (attempt < SPAWN_MAX_RETRIES) {
          await this._delay(SPAWN_RETRY_BASE_DELAY_MS * (2 ** attempt));
        }
      }
      if (!childId) {
        if (loop.cancelRequested) {
          loop.status = "cancelled";
        } else {
          loop.status = "error";
          loop.errorReason = `Failed to create child session after ${SPAWN_MAX_RETRIES + 1} attempts`;
        }
        loop.updatedAt = Date.now();
        await this._injectNote(
          origin,
          `${LOOP_PROGRESS_MARKER} ${loop.status === "cancelled" ? "loop cancelled" : "error: " + loop.errorReason}]`,
        );
        this.childToOrigin.delete(activeSessionId);
        this._persist();
        return;
      }

      await this.client.session.promptAsync({
        path: { id: childId },
        body: {
          agent: loop.agent,
          parts: [{ type: "text", text: nextPrompt }],
        },
      });

      const prevCurrent = loop.current;
      loop.current += 1;
      loop.activeSessionId = childId;
      this.childToOrigin.set(childId, origin);
      loop.roundStartedAt = Date.now();
      loop.status = "running";
      loop.updatedAt = Date.now();

      await this._injectNote(
        origin,
        `${LOOP_PROGRESS_MARKER} round ${prevCurrent}/${loop.total} done → starting round ${loop.current} (child ${childId})]`,
      );

      this._persist();
    } finally {
      this._advancing.delete(origin);
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
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = undefined;
    }
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

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _getSummarizer(): SummarizeFn {
    if (!this._summarizer) {
      this._summarizer = createSummarizerFn(this.client, {
        timeoutMs: SUMMARIZER_TIMEOUT_MS,
      });
    }
    return this._summarizer;
  }

  private async _determineNextPrompt(
    loop: LoopState,
    activeSessionId: string,
  ): Promise<string> {
    if (loop.mode !== "inherit") {
      return loop.prompt;
    }

    loop.status = "summarizing";

    try {
      const messagesResult = await this.client.session.messages({
        path: { id: activeSessionId },
      });
      const data = (
        messagesResult as {
          data?: Array<{
            info?: { role?: string };
            parts?: Array<{ type: string; text?: string }>;
          }>;
        }
      ).data;

      let conversation = "";
      if (data) {
        for (const msg of data) {
          if (msg.info?.role === "assistant" && msg.parts) {
            for (const part of msg.parts) {
              if (part.type === "text" && typeof part.text === "string") {
                conversation += part.text;
              }
            }
          }
        }
      }

      if (conversation.length > SUMMARY_INPUT_CHAR_CAP) {
        conversation = conversation.slice(-SUMMARY_INPUT_CHAR_CAP);
      }

      const summarizer = this._getSummarizer();
      const result = await summarizer(loop.agent, conversation);

      if (result.ok) {
        loop.lastSummary = result.summary;
        return result.summary + "\n\n---\n\n" + loop.prompt;
      }

      return loop.prompt;
    } catch {
      return loop.prompt;
    }
  }

  private _injectNote(
    sessionId: string,
    text: string,
  ): ReturnType<OpencodeClient["session"]["promptAsync"]> {
    return this.client.session.promptAsync({
      path: { id: sessionId },
      body: {
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
