/**
 * Pi Chat-Message Activation Adapter — `src/platform/adapters/pi/chat-activation.ts`
 * (subtask S8)
 *
 * Detects user messages on the Pi platform and runs the shared opencode
 * `handleChatMessage` pipeline (`src/hooks/chat-message.ts`) against them, so
 * function activation works on Pi exactly like the opencode `chat.message`
 * hook (hook-service.ts:207-213) without an opencode hook host:
 *
 *   - `|fn|` parsing / activation (`parseFunctionActivation` +
 *     `functionSessionState.activate`)
 *   - auto-activation on the first user message
 *     (`roleAutoActivateMap` / `roleLockedMap` → `activateDefaults`)
 *   - wake-event unblocking for gated functions (dispatch notifications and
 *     `[HITL APPROVAL REQUIRED]` messages clear `phase: "gated"`)
 *   - `sessionAgentRegistry` recording
 *
 * User-message detection has two paths:
 *
 *   1. **Primary (live events):** `pi.on("message_start")` events whose
 *      `message.role === "user"`. The user text is read from
 *      `message.content` (a plain string for UserMessage, or a content
 *      array of text entries).
 *   2. **Fallback (session restore):** when the event does not identify a
 *      user message (legacy Pi versions without `message.role`, or a
 *      resumed session that does not re-emit the current user message),
 *      the LAST user message of the invoking session is read from the Pi
 *      JSONL session file through `deps.session.messages(sessionID)` and
 *      replayed through the pipeline — this restores function activation
 *      state after an extension reload or `/resume`, when the in-memory
 *      hook state was lost.
 *
 * Synthetic injections are skipped **exactly as chat-message.ts:26-29**:
 *
 *   - On the live event path the shared pipeline applies that predicate
 *     internally (the same behavior as opencode, where synthetic re-entries
 *     DO pass through the `chat.message` hook so wake-event unblocking for
 *     dispatch notifications still fires).
 *   - On the JSONL fallback path the same predicate is applied here, so a
 *     historical synthetic injection (e.g. a persisted loop-progress marker
 *     or dispatch notification) is never replayed as a genuine user message.
 *
 * A per-session dedup map (keyed by the message id when available) prevents
 * a message from being fed through the pipeline twice — whether re-emitted
 * by Pi or re-read from the JSONL fallback.
 *
 * @module
 */

import { handleChatMessage } from "../../../hooks/chat-message.ts";
import type { HookDeps } from "../../../hooks/deps.ts";
import type { HookState } from "../../../hooks/state.ts";
import { isDispatchNotification } from "../../../dispatch/notification.ts";
import { LOOP_PROGRESS_MARKER } from "../../../loop/constants.ts";
import { COPILOT_MARKER } from "../../../copilot/constants.ts";
import { createSubLogger } from "../../../logger.ts";
import { extractPiSessionId, extractPiAgent } from "./system-transform.ts";

const log = createSubLogger("pi-chat-activation");

// ── Per-session dedup ────────────────────────────────────────────────────────

/**
 * Per-session dedup map: `sessionID → fingerprint` of the last user message
 * fed through the chat-message pipeline. Prevents double-processing when Pi
 * re-emits a `message_start` event or the JSONL fallback re-reads a message
 * that the live event path already handled.
 */
const processedUserMessages = new Map<string, string>();

/**
 * Clear the per-session dedup map (test/teardown helper).
 */
export function resetPiChatActivationDedup(): void {
  processedUserMessages.clear();
}

// ── Synthetic-injection predicate (chat-message.ts:26-29) ───────────────────

/**
 * Synthetic-injection predicate — mirrors `chat-message.ts:26-29` EXACTLY
 * (same markers, same expression). Used by the JSONL fallback replay path to
 * avoid re-processing a historical auto-continue / loop-progress / dispatch
 * notification as a genuine user message. The live event path delegates to
 * the shared pipeline, which applies this same predicate internally.
 */
function isSyntheticInjection(text: string): boolean {
  return (
    text.includes("[auto-continue") ||
    text.includes(LOOP_PROGRESS_MARKER) ||
    text.includes(COPILOT_MARKER) ||
    isDispatchNotification(text)
  );
}

// ── Text-extraction helpers ─────────────────────────────────────────────────

/**
 * Extract the user text from a Pi `message.content` payload. User messages
 * carry a plain prompt string; content arrays (text / thinking / toolCall /
 * image entries) contribute their text entries joined by newlines.
 */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.type === "text" && typeof e.text === "string") parts.push(e.text);
    }
    return parts.join("\n");
  }
  return "";
}

/** Loose shape of a message parsed from the Pi JSONL session file. */
type JsonlMessage = {
  info?: { role?: string; id?: string };
  parts?: Array<{ type?: string; text?: string }>;
};

/**
 * Find the LAST user message in a session's parsed JSONL messages and return
 * its text plus its message id (when present). Returns `null` when the
 * session has no user message with text.
 */
function lastUserMessage(
  messages: JsonlMessage[],
): { text: string; id?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "user") continue;
    const textPart = (msg.parts ?? []).find(
      (p) => p?.type === "text" && typeof p?.text === "string",
    );
    if (textPart?.text) return { text: textPart.text, id: msg.info?.id };
  }
  return null;
}

/**
 * Dedup fingerprint for a live event — prefers the message id so identical
 * follow-up messages are still processed, falling back to a text token only
 * when the event carries no id at all.
 */
function eventFingerprint(event: Record<string, unknown>, text: string): string {
  if (typeof event.messageID === "string" && event.messageID.length > 0) {
    return event.messageID;
  }
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  return `evt:${text}`;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface PiChatActivationRunOptions {
  /**
   * Pi extension context — `sessionManager.getSessionId()` resolves the
   * session id; `ctx.agent` is an agent fallback (same chain as the S7
   * system-transform adapter).
   */
  ctx?: Record<string, unknown> | undefined;
  /** S6 hook state (pendingCorrections, sessionAgentRegistry, …). */
  state: HookState;
  /** S6 hook deps (session client, role maps, custom hooks, …). */
  deps: HookDeps;
  /** Pi active-agent ref (role switcher) used as the agent fallback. */
  activeAgent?: { get(): string | null } | undefined;
}

export interface PiChatActivationResult {
  /** True when the message was fed through the chat-message pipeline. */
  processed: boolean;
}

/**
 * Run the shared `handleChatMessage` pipeline against a Pi `message_start`
 * event (or the session's last JSONL user message when the event does not
 * identify one). Resolves session id / agent via the shared Pi helpers,
 * builds the `{ agent, sessionID }` input + `{ parts: [{ type: "text",
 * text }] }` output shape the opencode `chat.message` hook uses, and
 * delegates to the pipeline with the S6 `state` + `deps`.
 *
 * Returns `{ processed: true }` when the pipeline ran, `{ processed: false }`
 * when there was nothing to run (no session id, assistant message with no
 * replayable user message, dedup hit, or synthetic fallback). Errors are
 * swallowed and logged — a detection defect must never break the Pi runtime.
 */
export async function runPiChatActivation(
  event: Record<string, unknown>,
  options: PiChatActivationRunOptions,
): Promise<PiChatActivationResult> {
  const { state, deps, activeAgent } = options;

  const sessionID = extractPiSessionId(event, options.ctx);
  if (!sessionID) {
    log.debug("runPiChatActivation: no session id — skipping");
    return { processed: false };
  }
  const agent = extractPiAgent(event, activeAgent, options.ctx);

  // ── Primary: the event itself is a user message ────────────────────────
  // pi 0.81.x message_start carries message.role; legacy events may carry a
  // top-level role instead.
  const rawMessage = event.message as
    | { role?: unknown; content?: unknown }
    | undefined;
  const isEventUserMessage =
    rawMessage?.role === "user" || event.role === "user";

  if (isEventUserMessage) {
    const text = extractUserText(rawMessage?.content ?? event.text);
    const fingerprint = eventFingerprint(event, text);
    if (fingerprint && processedUserMessages.get(sessionID) === fingerprint) {
      // Re-emitted message — already handled.
      return { processed: false };
    }
    await handleChatMessage(
      { agent, sessionID },
      { parts: [{ type: "text", text }] },
      state,
      deps,
    );
    if (fingerprint) processedUserMessages.set(sessionID, fingerprint);
    return { processed: true };
  }

  // ── Fallback: replay the last JSONL user message of the invoking session ─
  // Fires for events that do not identify a user message (legacy Pi versions
  // without message.role, or a resumed session). Restores function activation
  // state that was lost when the extension reloaded mid-session.
  let messages: JsonlMessage[];
  try {
    messages = (await deps.session.messages(sessionID)) as unknown as JsonlMessage[];
  } catch (err) {
    log.debug("runPiChatActivation: session read failed", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { processed: false };
  }

  const last = lastUserMessage(messages);
  if (!last) return { processed: false };

  // Historical synthetic injections are never replayed as genuine user
  // messages (chat-message.ts:26-29 predicate).
  if (isSyntheticInjection(last.text)) return { processed: false };

  const fingerprint = last.id ? last.id : `jsonl:${last.text}`;
  if (processedUserMessages.get(sessionID) === fingerprint) {
    return { processed: false };
  }

  await handleChatMessage(
    { agent, sessionID },
    { parts: [{ type: "text", text: last.text }] },
    state,
    deps,
  );
  processedUserMessages.set(sessionID, fingerprint);
  return { processed: true };
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export interface WirePiChatActivationOptions {
  /** Pi ExtensionAPI instance (loosely typed optional peer dependency). */
  pi: any;
  /** S6 hook state (the shared pipeline's `state`). */
  state: HookState;
  /** S6 hook deps (the shared pipeline's `deps`). */
  deps: HookDeps;
  /** Pi active-agent ref (role switcher) used as the agent fallback. */
  activeAgent?: { get(): string | null } | undefined;
  /**
   * Opt-out switch (child-process mode, subtask S2). When `false` the
   * wiring is skipped entirely — no `message_start` subscription is
   * created and `handleChatMessage` is never invoked, so a spawned Pi
   * subagent does not re-run the parent-side chat-activation machinery on
   * top of the `--append-system-prompt` it already received. Defaults to
   * `true`.
   */
  enabled?: boolean;
}

export interface PiChatActivationWireResult {
  /**
   * Remove the subscription. Pi's `pi.on` has no unsubscribe API, so this is
   * a no-op kept for uniform shutdown — same convention as
   * `wirePiSessionStatusEvents`.
   */
  unsubscribe: () => void;
}

/**
 * Subscribe `pi.on("message_start")` and route every event through
 * `runPiChatActivation` using the shared S6 pipeline state/deps. Degrades
 * gracefully when the Pi API lacks `.on()`.
 */
export function wirePiChatActivation(
  options: WirePiChatActivationOptions,
): PiChatActivationWireResult {
  const { pi, state, deps, activeAgent, enabled = true } = options;

  if (!enabled) {
    log.debug("Pi chat activation disabled (child-process mode) — not wired");
    return { unsubscribe: () => {} };
  }

  if (typeof pi?.on !== "function") {
    log.debug("Pi API lacks .on() — chat activation not wired");
    return { unsubscribe: () => {} };
  }

  pi.on("message_start", async (event: unknown, ctx: unknown) => {
    try {
      await runPiChatActivation(
        (event ?? {}) as Record<string, unknown>,
        {
          ctx: (ctx ?? undefined) as Record<string, unknown> | undefined,
          state,
          deps,
          activeAgent,
        },
      );
    } catch (err) {
      // Never throw into the Pi runtime — log and move on.
      log.debug("message_start activation handler error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  log.info("Pi chat activation wired — message_start → handleChatMessage");

  return {
    unsubscribe: () => {
      // No Pi-side unsubscribe API — kept as a no-op.
    },
  };
}
