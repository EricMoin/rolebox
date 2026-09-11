/**
 * PiEventBridge — IEventBridge adapter for Pi (plugin) platform events.
 *
 * Translates Pi Extension API raw events into CanonicalEvents and
 * dispatches them to registered handlers. Does NOT import from
 * any Pi SDK (@opencode-ai/plugin or @opencode-ai/sdk).
 *
 * @module
 */

import type {
  CanonicalEvent,
  CanonicalEventHandler,
  CanonicalEventType,
  IEventBridge,
} from "../../ports/event-bridge.ts";

// ── Pi-to-canonical event type mapping ─────────────────────────────────────

/**
 * Mapping from Pi Extension API event type strings to canonical event types.
 */
const PI_EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
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
};

/**
 * Map a Pi Extension API event type string to a CanonicalEventType.
 * Unknown or unmapped types resolve to "unknown".
 */
export function mapPiEventType(piType: string): CanonicalEventType {
  return PI_EVENT_TYPE_MAP[piType] ?? "unknown";
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
