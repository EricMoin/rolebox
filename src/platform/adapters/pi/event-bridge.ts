/**
 * PiEventBridge — IEventBridge adapter for Pi (plugin) platform events.
 *
 * Translates Pi Extension API raw events into CanonicalEvents and
 * dispatches them to registered handlers.
 *
 * The host vocabulary is imported **type-only** from the optional
 * `@earendil-works/pi-coding-agent` peer, so the literal tables below are
 * compiler-checked while the imports erase at build time. This module MUST NOT
 * value-import the host and MUST NOT import from `@opencode-ai/*`.
 *
 * @module
 */

// Type-only host imports: `ExtensionEvent` is the Extension API's discriminated event
// union, `JsonAgentSessionEvent` the `pi --mode json` stdout union. They exist only to
// check the literal vocabularies below — pi is an optional runtime peer supplied by the
// host, so these imports must never gain a runtime form (same pattern as
// dsh/event-bridge.ts:37-43).
import type {
  ExtensionEvent,
  JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type {
  CanonicalEvent,
  CanonicalEventHandler,
  CanonicalEventType,
  IEventBridge,
} from "../../ports/event-bridge.ts";

// ── Pi vocabulary ───────────────────────────────────────────────────────────

/**
 * Event names the pi Extension API can deliver, taken from the host's own
 * discriminated union (`ExtensionEvent`; `ExtensionAPI.on` declares the matching
 * overload set). A key the host does not declare — or a typo — is a compile error
 * in {@link PI_EVENT_TYPE_MAP} instead of a mapping that can never fire.
 */
export type PiEventType = ExtensionEvent["type"];

/**
 * Extension-API event names the legacy `pi --mode json` stream carried at the top level.
 *
 * `tool_call` / `tool_result` are extension events, not members of the JSON-stream union
 * (`JsonAgentSessionEvent` carries `tool_execution_*` instead), but rolebox's stream parser
 * handles them — kept working and still host-checked through `satisfies`.
 */
const PI_LEGACY_STREAM_EVENT_TYPES = [
  "tool_call",
  "tool_result",
] as const satisfies readonly ExtensionEvent["type"][];

/**
 * pi vocabulary rolebox parses that the installed host declarations do NOT publish.
 *
 * Real at runtime, but not compiler-checkable from the host's root type surface:
 *   - `text`     — content-block discriminant, e.g. `dist/core/tools/bash.js:173`
 *                  (`content: [{ type: "text", text }]`) and the plain-text
 *                  `--mode json` event rolebox still parses;
 *   - `thinking` — content-block discriminant, `dist/core/compaction/utils.js:106`
 *                  (`block.type === "thinking"`);
 *   - `toolCall` — content-block discriminant,
 *                  `dist/core/compaction/branch-summarization.js:235`.
 *
 * Those are content types of the transitive `@earendil-works/pi-ai` package
 * (`TextContent` :242, `ThinkingContent` :247, `ToolCall` :261), which the host does not
 * re-export from its root; importing that package directly would make an optional peer's
 * internal a build dependency, so the vocabulary is recorded here instead.
 */
export type PiRuntimeOnlyEventType = "text" | "thinking" | "toolCall";

/**
 * The `pi --mode json` stdout vocabulary rolebox's parsers switch on: the host's declared
 * wire union, the legacy extension names older streams used, and the runtime-only literals.
 *
 * Switch labels are checked against this union, so a name no installed source can emit is a
 * compile error instead of a case that can never run.
 */
export type PiJsonEventType =
  | JsonAgentSessionEvent["type"]
  | (typeof PI_LEGACY_STREAM_EVENT_TYPES)[number]
  | PiRuntimeOnlyEventType;

// ── Pi-to-canonical event type mapping ─────────────────────────────────────

/**
 * Mapping from Pi Extension API event type strings to canonical event types.
 *
 * `Partial` is intentional: rolebox handles a subset of the host's Extension API events.
 * The `satisfies` guard makes a key the host does not declare — or a typo — a compile
 * error instead of a dead mapping. Unmapped host events resolve to "unknown" by design.
 */
export const PI_EVENT_TYPE_MAP = {
  session_start: "session.created",
  session_shutdown: "session.deleted",
  agent_start: "session.updated",
  agent_end: "session.idle",
  agent_settled: "session.idle",
  message_start: "message.created",
  message_update: "message.updated",
  message_end: "message.completed",
  tool_call: "part.created",
  tool_result: "part.updated",
} as const satisfies Partial<Record<PiEventType, CanonicalEventType>>;

/**
 * String-keyed view used by the tolerant lookup in {@link mapPiEventType}.
 *
 * `piType` arrives as an arbitrary string (the host union is not validated at runtime), so
 * the typed table is widened once, here. Every key is host-declared — enforced by the
 * `satisfies` guard above — and any non-key resolves to "unknown", so the widening cannot
 * smuggle in an unchecked mapping.
 */
const PI_EVENT_TYPE_LOOKUP: Record<string, CanonicalEventType> = PI_EVENT_TYPE_MAP;

/**
 * Map a Pi Extension API event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapPiEventType(piType: string): CanonicalEventType {
  return PI_EVENT_TYPE_LOOKUP[piType] ?? "unknown";
}

// ── Adapter implementation ─────────────────────────────────────────────────

/**
 * IEventBridge implementation that adapts Pi Extension API events
 * into the canonical event system.
 *
 * Maintains a set of general-purpose handlers (invoked for all events)
 * and a map of type-specific handlers (invoked only for matching types).
 */
export class PiEventBridge implements IEventBridge {
  /** General-purpose handlers invoked for every emitted event. */
  private readonly handlers: Set<CanonicalEventHandler> = new Set();

  /** Type-specific handlers, keyed by canonical event type. */
  private readonly typeHandlers: Map<
    CanonicalEventType,
    Set<CanonicalEventHandler>
  > = new Map();

  // ── IEventBridge implementation ─────────────────────────────────────────

  /**
   * Subscribe a general-purpose event handler.
   * The handler receives all emitted canonical events.
   *
   * @param handler - Callback receiving the canonical event.
   * @returns An unsubscribe function that removes the handler.
   */
  on(handler: CanonicalEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Subscribe a type-specific event handler.
   * The handler only receives events matching the specified canonical type.
   *
   * @param type  - The canonical event type to subscribe to.
   * @param handler - Callback receiving the canonical event.
   * @returns An unsubscribe function that removes the handler.
   */
  onType(type: CanonicalEventType, handler: CanonicalEventHandler): () => void {
    let handlers = this.typeHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.typeHandlers.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.typeHandlers.delete(type);
      }
    };
  }

  /**
   * Normalize a raw Pi platform event into a CanonicalEvent.
   *
   * Expects `rawEvent` to be an object with a `type` string property
   * containing the Pi Extension API event type name. All other properties
   * on the raw event are captured in the `properties` bag.
   *
   * @param rawEvent - The raw Pi event (unknown shape).
   * @returns A normalized CanonicalEvent.
   */
  normalize(rawEvent: unknown): CanonicalEvent {
    const rawType = this.extractRawType(rawEvent);
    const canonicalType = mapPiEventType(rawType);
    const properties = this.extractProperties(rawEvent);

    return {
      type: canonicalType,
      rawType,
      properties,
    };
  }

  /**
   * Emit a canonical event to all matching subscribers.
   *
   * Dispatches to both general-purpose handlers and type-specific handlers.
   * All handlers are invoked and awaited; if any handler rejects, the
   * error is captured and re-thrown after all handlers have settled.
   *
   * @param event - The canonical event to dispatch.
   */
  async emit(event: CanonicalEvent): Promise<void> {
    const errors: unknown[] = [];

    // Dispatch to general-purpose handlers.
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        errors.push(err);
      }
    }

    // Dispatch to type-specific handlers.
    const typeHandlerSet = this.typeHandlers.get(event.type);
    if (typeHandlerSet) {
      for (const handler of typeHandlerSet) {
        try {
          await handler(event);
        } catch (err) {
          errors.push(err);
        }
      }
    }

    if (errors.length > 0) {
      // Rethrow the first error; additional errors are aggregated for debugging.
      const aggregate = new AggregateError(
        errors,
        `PiEventBridge.emit: ${errors.length} handler(s) failed for event "${event.type}"`,
      );
      throw aggregate;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Extract the Pi event type string from a raw event object.
   * Returns "unknown" when the raw event is not an object or has no type string.
   */
  private extractRawType(rawEvent: unknown): string {
    if (
      rawEvent !== null &&
      typeof rawEvent === "object" &&
      "type" in rawEvent
    ) {
      const maybeType = (rawEvent as Record<string, unknown>).type;
      if (typeof maybeType === "string") {
        return maybeType;
      }
    }
    return "unknown";
  }

  /**
   * Extract all enumerable properties except `type` from the raw event
   * into a plain record for the `properties` bag.
   */
  private extractProperties(rawEvent: unknown): Record<string, unknown> {
    if (rawEvent === null || typeof rawEvent !== "object") {
      return {};
    }
    const { type: _type, ...rest } = rawEvent as Record<string, unknown>;
    return rest;
  }
}
