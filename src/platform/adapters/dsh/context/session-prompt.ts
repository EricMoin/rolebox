/**
 * The one human prompt a DSH session is currently working on.
 *
 * Turn recall and its LLM query scout must agree on WHICH message drives
 * retrieval. Two sources exist, and their timing differs:
 *
 * - The `agent/pre-step` waterfall carries the step's ADMITTED user messages:
 *   the agent loop claims them out of the inbox BEFORE it appends them to the
 *   session log. A `UserMessage` has a stable id, so this payload is the only
 *   place the FIRST turn's prompt exists at recall-render time, and the only
 *   place a later turn's NEWEST prompt exists before admission.
 * - The session log carries the message once the step admitted it. It stays
 *   the fallback for a render with no pre-step handoff (for example a session
 *   restored from disk, where the prompt is already logged).
 *
 * Only a message the user actually authored counts: synthetic messages
 * (injected runtime context, model selections, compaction checkpoints, rolebox
 * notices) share the event type but are not human input. Keeping the
 * extraction here — rather than private to the recall provider — is what lets
 * the scout offer queries for the exact prompt the recall render will read.
 *
 * A prompt is identified by its `UserMessage` id when one is present (the
 * stable key the pre-step payload and the logged event share), falling back to
 * the log position only when the fake or legacy log omits the id.
 *
 * @module
 */

/** Event type of a model-visible user-role message. */
export const USER_MESSAGE_EVENT = "user/message";

/** One structural session event (a fake log omits `seq`). */
export interface DshSessionPromptEvent {
  type: string;
  data?: unknown;
  seq?: number;
}

/** One user-authored prompt: its stable key and its text. */
export interface DshPrompt {
  key: string;
  text: string;
}

/**
 * The session's newest user-authored prompt, keyed by its message id.
 *
 * Synthetic `user/message` events are skipped, and an older prompt is never
 * substituted for a newer one: an empty or unusably short newest prompt is
 * returned as-is (and its recall term check rejects it), never replaced by an
 * earlier one. A logged message without a string id falls back to
 * `seq:<eventSeq>` as its key.
 *
 * @param events - The session's event log.
 * @returns The prompt key and text, or `undefined`.
 */
export function latestUserPrompt(
  events: readonly DshSessionPromptEvent[],
): DshPrompt | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== USER_MESSAGE_EVENT) continue;
    if (!isUserAuthored(event.data)) continue;
    const id = messageId(event.data);
    return {
      key: id ?? `seq:${eventSeq(event, index)}`,
      text: messageText(event.data),
    };
  }
  return undefined;
}

/**
 * The last user-authored message in an `agent/pre-step` payload.
 *
 * The payload carries the step's admitted `UserMessage` values — the current
 * prompt, claimed before the session log holds it. A candidate must have the
 * user source, text and a stable string id; anything else is skipped, and the
 * LAST matching message wins because that is the newest human input of the
 * batch.
 *
 * @param messages - The payload's admitted messages.
 * @returns The prompt key (the message id) and text, or `undefined`.
 */
export function latestPayloadPrompt(
  messages: readonly unknown[],
): DshPrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isUserAuthored(message)) continue;
    const key = messageId(message);
    if (key === undefined) continue;
    const text = messageText(message);
    if (text.length === 0) continue;
    return { key, text };
  }
  return undefined;
}

/** True when a message's `source.kind` is `user`. */
export function isUserAuthored(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const source = "source" in message ? message.source : undefined;
  if (typeof source !== "object" || source === null) return false;
  return "kind" in source && source.kind === "user";
}

/** Join a message's text content blocks. */
export function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** The message's stable id, when it carries a non-empty string one. */
function messageId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const id = "id" in message ? message.id : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The event's monotonic sequence number, or its log index for a fake log. */
function eventSeq(event: DshSessionPromptEvent, index: number): number {
  if (event.seq !== undefined && Number.isFinite(event.seq)) return event.seq;
  return index;
}
