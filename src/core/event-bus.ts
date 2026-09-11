import { createSubLogger } from "../logger.ts";

const log = createSubLogger("event-bus");

export type EventHandler = (payload: any) => void | Promise<void>;

/**
 * Lightweight publish/subscribe event bus for inter-service communication.
 * Replaces direct ad-hoc calls between services (e.g. notification hook
 * bolted onto every hook handler).
 *
 * Handlers are fire-and-forget — errors are caught and logged, never propagated.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.set(event, this.handlers.get(event)!.add(handler));
    return () => this.off(event, handler);
  }

  /** Unsubscribe a handler from an event. */
  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
    }
  }

  /** Emit an event to all subscribers. Handlers run sequentially. Errors are caught. */
  async emit(event: string, payload?: any): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        await handler(payload);
      } catch (err) {
        log.warn("Event handler failed", { event, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Remove all handlers for a specific event (or all events if no arg). */
  clear(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
