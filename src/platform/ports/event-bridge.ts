/**
 * IEventBridge — port interface for receiving and normalizing platform events.
 *
 * Platform adapters implement this to translate native event streams
 * into CanonicalEvents that the core event handler can process uniformly.
 *
 * Must NOT import from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import type { CanonicalEvent, CanonicalEventType } from "../types.ts";

export type { CanonicalEvent, CanonicalEventType };

export type CanonicalEventHandler = (event: CanonicalEvent) => void | Promise<void>;

/**
 * Port interface for platform event bridging.
 *
 * The event bridge translates platform-native events into canonical events
 * and dispatches them to registered handlers. This decouples the core
 * event processing logic from the platform's event delivery mechanism.
 */
export interface IEventBridge {
  /**
   * Subscribe to canonical events.
   * Returns an unsubscribe function.
   */
  on(handler: CanonicalEventHandler): () => void;

  /**
   * Subscribe to a specific canonical event type.
   * Returns an unsubscribe function.
   */
  onType(type: CanonicalEventType, handler: CanonicalEventHandler): () => void;

  /**
   * Normalize a platform-native event into a CanonicalEvent.
   * Used internally by adapters and externally for testing.
   */
  normalize(rawEvent: unknown): CanonicalEvent;

  /**
   * Emit a canonical event to all subscribers.
   * Platform adapters call this after normalizing native events.
   */
  emit(event: CanonicalEvent): Promise<void>;
}
