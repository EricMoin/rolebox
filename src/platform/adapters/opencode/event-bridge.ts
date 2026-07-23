/**
 * OpencodeEventBridge — event normalization for the opencode SDK platform.
 *
 * Translates opencode SDK native Event objects into CanonicalEvents.
 * Follows the same pattern as PiEventBridge on the Pi side.
 *
 * Opencode SDK events are NOT imported here — the normalization function
 * accepts { type: string; properties?: unknown } which is the structural
 * contract of every opencode Event variant.
 *
 * @module
 */

import type {
  CanonicalEvent,
  CanonicalEventType,
} from "../../ports/event-bridge.ts";

// ── Opencode-to-canonical event type mapping ────────────────────────────────

/**
 * Mapping from opencode SDK event type strings to canonical event types.
 * Most opencode SDK event types match canonical names directly.
 * Unrecognised types resolve to "unknown".
 */
const OPENCODE_EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
  // Session lifecycle
  "session.idle": "session.idle",
  "session.status": "session.status",
  "session.error": "session.error",
  "session.created": "session.created",
  "session.updated": "session.updated",
  "session.deleted": "session.deleted",
  // Message lifecycle
  "message.created": "message.created",
  "message.updated": "message.updated",
  "message.completed": "message.completed",
  // Part lifecycle (tool calls / results)
  "part.created": "part.created",
  "part.updated": "part.updated",
};

/**
 * Map an opencode SDK event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapOpencodeEventType(rawType: string): CanonicalEventType {
  return OPENCODE_EVENT_TYPE_MAP[rawType] ?? "unknown";
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Raw structural shape of an opencode SDK event.
 * This matches every variant of the opencode `Event` discriminated union
 * without importing from @opencode-ai/sdk.
 */
type RawOpencodeEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

/**
 * Normalize a raw opencode SDK event into a CanonicalEvent.
 *
 * Uses the structural `{ type; properties? }` contract that every opencode
 * Event variant satisfies. Unknown event types are mapped to "unknown"
 * with the raw type preserved for debugging.
 *
 * @param rawEvent - The raw event from the opencode SDK.
 * @returns A normalized CanonicalEvent.
 */
export function normalizeOpencodeEvent(
  rawEvent: unknown,
): CanonicalEvent {
  const raw = rawEvent as Partial<RawOpencodeEvent>;

  const rawType = typeof raw?.type === "string" ? raw.type : "unknown";
  const canonicalType = mapOpencodeEventType(rawType);

  const properties: Record<string, unknown> =
    raw?.properties !== undefined && raw.properties !== null
      ? { ...raw.properties }
      : {};

  return {
    type: canonicalType,
    rawType,
    properties,
  };
}
