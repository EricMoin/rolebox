/**
 * Promise-based semaphore for limiting concurrent subagent executions per model key.
 *
 * Key format: `${providerID}/${modelID}` (model-based concurrency).
 * Fallback key when model unknown: "default".
 */

import { debugLog } from "./debug-log.ts";

interface Waiter {
  resolve: () => void;
  cancelled: boolean;
  id: string;
}

interface ConcurrencySlot {
  active: number;
  limit: number;
  queue: Waiter[];
}

export class ConcurrencyManager {
  private slots: Map<string, ConcurrencySlot> = new Map();
  private defaultLimit: number;

  constructor(defaultLimit: number = 5) {
    this.defaultLimit = defaultLimit;
  }

  private getOrCreateSlot(key: string): ConcurrencySlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, limit: this.defaultLimit, queue: [] };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /**
   * Acquire a slot for the given key. Resolves immediately if under the limit,
   * otherwise queues the caller until a slot is freed.
   */
  acquire(key: string): Promise<void> {
    const slot = this.getOrCreateSlot(key);
    if (slot.active < slot.limit) {
      slot.active++;
      return Promise.resolve();
    }
    return this.acquireCancelable(key).promise;
  }

  /**
   * Acquire a slot with cancel support. Returns a promise and a cancel function.
   * Cancel is idempotent — safe to call after resolution.
   */
  acquireCancelable(key: string): { promise: Promise<void>; cancel: () => void } {
    const slot = this.getOrCreateSlot(key);
    if (slot.active < slot.limit) {
      slot.active++;
      return { promise: Promise.resolve(), cancel: () => {} };
    }

    const id = crypto.randomUUID();
    let resolveFn: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    const waiter: Waiter = { resolve: resolveFn!, cancelled: false, id };
    slot.queue.push(waiter);

    return {
      promise,
      cancel: () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        const idx = slot.queue.findIndex((w) => w.id === id);
        if (idx !== -1) slot.queue.splice(idx, 1);
      },
    };
  }

  /**
   * Release a slot for the given key. If there are queued waiters, the next
   * non-cancelled one is immediately granted the slot.
   */
  release(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;

    if (slot.active <= 0) {
      debugLog("concurrency", key, `release underflow: active=${slot.active}`);
      return;
    }

    slot.active--;

    while (slot.queue.length > 0) {
      const w = slot.queue.shift()!;
      if (w.cancelled) continue;
      slot.active++;
      w.resolve();
      break;
    }
  }

  /** Returns the number of currently active acquisitions for the given key. */
  getActiveCount(key: string): number {
    return this.slots.get(key)?.active ?? 0;
  }

  /** Returns the configured limit for the given key, or the default limit if not set. */
  getLimit(key: string): number {
    return this.slots.get(key)?.limit ?? this.defaultLimit;
  }

  /**
   * Bypass the acquire queue and directly occupy concurrency slots.
   * Clamps to the slot's limit. Returns the actual number of slots occupied.
   */
  forceOccupy(key: string, count: number = 1): number {
    const slot = this.getOrCreateSlot(key);
    const added = Math.min(count, Math.max(0, slot.limit - slot.active));
    slot.active += added;
    return added;
  }
}
