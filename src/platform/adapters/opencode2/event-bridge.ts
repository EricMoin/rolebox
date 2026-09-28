/**
 * opencode v2 event normalization.
 *
 * `ctx.event.subscribe()` yields the v2 event union as an `AsyncIterable`
 * (node_modules/@opencode/plugin/dist/promise/event.d.ts:2-3 wraps
 * `Pick<EventApi, "subscribe">`, whose result is `AsyncIterable<OpenCodeEvent>`,
 * …/client/dist/effect/api/api.d.ts:2163-2166). Every v2 event is an envelope
 *
 *   { id, created, type, data, location?, metadata? }
 *
 * (…/schema/dist/event.d.ts, `Payload`: the type discriminant is `type`, the
 * payload is `data` — v1's `properties` is gone).
 *
 * Conventions are taken from the v1 normalizer
 * (src/platform/adapters/opencode/event-bridge.ts):
 *  - a mapping table guarded by the host's own event-name union, so a typo or a
 *    name the host does not declare is a compile error instead of a dead entry;
 *  - an unmapped or unrecognised event resolves to "unknown" with the raw type
 *    preserved — never dropped, never thrown on;
 *  - `properties` is a shallow copy of the host payload.
 *
 * For v2 the payload is `data`, so `data`'s fields are lifted into
 * `properties` — that is the depth rolebox's consumers read. The single
 * consumer is `handleEvent` (src/hooks/event-handler.ts), which reads
 * `properties.sessionID` (:62, :161, :173), `properties.status` (:164-168),
 * `properties.error` (:175), `properties.info.id` for session.deleted (:188)
 * and `properties.info.sessionID` for message.updated (:197). Every mapped v2
 * event carries `sessionID` inside `data` (verified against the installed
 * 2.0.18 declarations), and `session.deleted` gets the v1-shaped
 * `info: { id }` alias it reads.
 *
 * The envelope (`id`, `created`, `location`, `metadata`) is NOT carried: the
 * canonical shape (src/platform/types.ts:107-113) has no envelope slot and no
 * consumer reads one.
 *
 * KNOWN GAP — there is no v2 event for the canonical `message.updated`.
 * v1 mapped `message.updated` (the dispatch watchdog's progress heartbeat,
 * src/dispatch/completion/completion-evaluator.ts:674-689). v2's message-level
 * event is `session.message.content.updated` (…/schema/dist/session-event.d.ts:777,
 * `MessageContentUpdated`), and the plugin's subscribe union does NOT carry it:
 * the event group the stream is built from
 * (…/protocol/dist/groups/event.d.ts) lists that name zero times, which is why
 * it cannot appear in the table below without failing the `satisfies` guard
 * (probed: adding it fails `bun run typecheck` with TS2353).
 *
 * The closest carriers that ARE in the union are the step and usage streams —
 * `session.step.started`, `session.step.ended`, `session.step.streamed`,
 * `session.usage.updated`, `session.text.ended` — and each carries `sessionID`
 * in `data`. None of them is a message-level event, though, and the streaming
 * half of that vocabulary is what the v1 table folds into `part.updated`
 * (below), so mapping one onto `message.updated` here would be a guess at the
 * host's emission timing rather than a normalization.
 *
 * The watchdog therefore loses that heartbeat on v2; `session.status`
 * (busy/idle/retry, still mapped, and itself a progress heartbeat in
 * src/dispatch/completion/completion-evaluator.ts:629-635) and the part streams
 * below remain.
 */

import type { Plugin as Opencode2Plugin } from "@opencode/plugin";

import type {
  CanonicalEvent,
  CanonicalEventType,
} from "../../ports/event-bridge.ts";

// ── Host vocabulary ────────────────────────────────────────────────────────

/** What `ctx.event.subscribe()` yields — the real v2 event union. */
type Opencode2EventStream = ReturnType<Opencode2Plugin.Context["event"]["subscribe"]>;
type Opencode2Event = Opencode2EventStream extends AsyncIterable<infer T> ? T : never;

/** The union's `type` discriminants, derived from the host declarations. */
type Opencode2EventNameOf<T> = T extends { type: infer U } ? Extract<U, string> : never;
type Opencode2EventName = Opencode2EventNameOf<Opencode2Event>;

// ── v2-to-canonical event type mapping ─────────────────────────────────────

/**
 * Mapping from v2 event type strings to canonical event types.
 *
 * `Partial` is intentional, exactly as in the v1 bridge: rolebox handles a
 * subset of the host's vocabulary. The `satisfies` guard makes a key the host
 * does not declare — or a typo — a compile error instead of a dead mapping.
 * Every other v2 event (text/reasoning streaming, tool input deltas, permission
 * requests, compaction, inbox delivery changes, …) resolves to "unknown" and is
 * still delivered to the hook pipeline with its raw type and data.
 *
 * Exported for the vocabulary test.
 */
export const OPENCODE2_EVENT_TYPE_MAP = {
  // Session lifecycle — the canonical types rolebox's event handler acts on.
  /** dispatch idle handling + continuation + notification (src/hooks/event-handler.ts:61). */
  "session.idle": "session.idle",
  /** dispatch status heartbeat, `status.type` ∈ busy|idle|retry (:160). */
  "session.status": "session.status",
  /**
   * v2's error carrier: the vocabulary has no `session.error`, and
   * `session.execution.failed`'s data is `{ sessionID, error: { type, message,
   * status? } }` — the shape `extractSessionErrorMessage`
   * (src/dispatch/core/error-utils.ts:7-25) already reads.
   */
  "session.execution.failed": "session.error",
  /** dispatch delete handling (:187); the normalizer adds the v1 `info.id` alias. */
  "session.deleted": "session.deleted",
  /** v1 parity (its table maps `session.created`); no rolebox consumer. */
  "session.created": "session.created",
  /** A user message entered the session — v1's `message.updated` creation half. */
  "session.inbox.delivered": "message.created",

  // Part streams — v1's `message.part.updated`, which its table documents as
  // "tool calls / results / streaming updates". v2 splits that into typed
  // streams; each one updates one assistant part. No rolebox consumer today.
  "session.text.started": "part.updated",
  "session.text.delta": "part.updated",
  "session.text.ended": "part.updated",
  "session.reasoning.started": "part.updated",
  "session.reasoning.delta": "part.updated",
  "session.reasoning.ended": "part.updated",
  "session.tool.called": "part.updated",
  "session.tool.input.started": "part.updated",
  "session.tool.input.delta": "part.updated",
  "session.tool.input.ended": "part.updated",
  "session.tool.progress": "part.updated",
  "session.tool.success": "part.updated",
  "session.tool.failed": "part.updated",
} satisfies Partial<Record<Opencode2EventName, CanonicalEventType>>;

/**
 * Map a v2 event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapOpencode2EventType(rawType: string): CanonicalEventType {
  // Invariant: rawType comes off the wire, so it is an arbitrary string rather
  // than a narrowed host literal. Every key in the table is host-declared
  // (enforced by the `satisfies` above); any non-key is "unknown", so widening
  // the lookup key cannot smuggle in an unchecked mapping.
  const map = OPENCODE2_EVENT_TYPE_MAP as Partial<
    Record<string, CanonicalEventType>
  >;
  return map[rawType] ?? "unknown";
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Raw structural shape of a v2 event: the `{ type, data }` contract every
 * variant of the v2 event union satisfies without importing the host's types.
 */
type RawOpencode2Event = {
  type?: unknown;
  data?: unknown;
};

/** Shallow copy of a v2 payload; a non-record `data` contributes nothing. */
function asProperties(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Normalize a raw v2 event into a CanonicalEvent.
 *
 * Uses the structural `{ type; data? }` contract. Unknown event types are
 * mapped to "unknown" with the raw type preserved for debugging — the same
 * degradation the v1 normalizer applies.
 *
 * @param rawEvent - The raw event from `ctx.event.subscribe()`.
 * @returns A normalized CanonicalEvent.
 */
export function normalizeOpencode2Event(rawEvent: unknown): CanonicalEvent {
  const raw = rawEvent as RawOpencode2Event | null | undefined;

  const rawType = typeof raw?.type === "string" ? raw.type : "unknown";
  const properties = asProperties(raw?.data);

  // v1-compat alias: v1's `session.deleted` payload was `{ info: Session }` and
  // `handleEvent` reads `properties.info.id` (src/hooks/event-handler.ts:188).
  // v2 carries only `{ sessionID }` (…/schema/dist/session-event.d.ts:1133-1180,
  // `Deleted`), so the v1 shape is reconstructed from it —
  // `sessionID` itself is kept at the top level, which is also what the
  // custom/built-in hook phases read (:32, :50).
  if (rawType === "session.deleted" && typeof properties["sessionID"] === "string") {
    properties["info"] = { id: properties["sessionID"] };
  }

  return {
    type: mapOpencode2EventType(rawType),
    rawType,
    properties,
  };
}
