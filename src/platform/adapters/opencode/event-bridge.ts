/**
 * OpencodeEventBridge — event normalization for the opencode SDK platform.
 *
 * Translates opencode SDK native Event objects into CanonicalEvents.
 * Follows the same pattern as PiEventBridge on the Pi side.
 *
 * Opencode SDK events are NOT imported here — the normalization function
 * accepts { type: string; properties?: unknown } which is the structural
 * contract of every opencode Event variant. The host's own `Hooks` type IS
 * imported (type-only) to derive the wire event-name vocabulary below.
 *
 * @module
 */

import type { Hooks } from "@opencode-ai/plugin";

import type {
  CanonicalEvent,
  CanonicalEventType,
} from "../../ports/event-bridge.ts";

// ── Opencode-to-canonical event type mapping ────────────────────────────────

/** The opencode event names the host can actually deliver (from the host's own Hooks type). */
type OpencodeEventType = Parameters<NonNullable<Hooks["event"]>>[0]["event"]["type"];

/**
 * Mapping from opencode SDK event type strings to canonical event types.
 * Most opencode SDK event types match canonical names directly.
 * Unrecognised types resolve to "unknown".
 *
 * `Partial` is intentional: rolebox handles a subset of the host's ~32
 * events. The `satisfies` guard makes a key the host does not declare — or a
 * typo — a compile error instead of a dead mapping. Unmapped host events
 * (e.g. `message.part.removed`) resolve to "unknown" by design.
 *
 * Exported for the liveness-linkage test (`tests/opencode-liveness-relay.test.ts`).
 */
export const OPENCODE_EVENT_TYPE_MAP = {
  // Session lifecycle
  "session.idle": "session.idle",
  "session.status": "session.status",
  "session.error": "session.error",
  "session.created": "session.created",
  "session.updated": "session.updated",
  "session.deleted": "session.deleted",
  // Message lifecycle
  "message.updated": "message.updated",
  // Part lifecycle (tool calls / results / streaming updates)
  "message.part.updated": "part.updated",
} satisfies Partial<Record<OpencodeEventType, CanonicalEventType>>;

/**
 * Map an opencode SDK event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapOpencodeEventType(rawType: string): CanonicalEventType {
  // Invariant: rawType comes off the wire, so it is an arbitrary string rather
  // than a narrowed host literal. Every key in the table is host-declared
  // (enforced by the `satisfies` above); any non-key is "unknown", so widening
  // the lookup key cannot smuggle in an unchecked mapping.
  const map = OPENCODE_EVENT_TYPE_MAP as Partial<
    Record<string, CanonicalEventType>
  >;
  return map[rawType] ?? "unknown";
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
