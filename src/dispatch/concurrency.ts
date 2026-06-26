/**
 * Promise-based semaphore for limiting concurrent subagent executions per model key.
 *
 * Key format: `${providerID}/${modelID}` (model-based concurrency).
 * Fallback key when model unknown: "default".
 */

import { debugLog } from "./debug-log.ts";
import { metrics } from "./metrics.ts";

interface Waiter {
  resolve: () => void;
  cancelled: boolean;
  id: string;
  enqueuedAt: number;
}

interface ConcurrencySlot {
  active: number;
  limit: number;
  maxQueueDepth: number;
  reserved: number;
  queue: Waiter[];
}

type AcquireBackgroundResult =
  | { outcome: "acquired"; cancel: () => void }
  | { outcome: "queued"; promise: Promise<void>; cancel: () => void }
  | { outcome: "full"; error: QueueFullError; cancel: () => void };

/** Error thrown when the concurrency queue is at capacity. */
export class QueueFullError extends Error {
  depth: number;
  limit: number;
  retryAfter: number;

  constructor(depth: number, limit: number, retryAfter: number = 30_000) {
    super(`Queue is full: ${depth} queued tasks (limit: ${limit})`);
    this.name = "QueueFullError";
    this.depth = depth;
    this.limit = limit;
    this.retryAfter = retryAfter;
  }
}

export class ConcurrencyManager {
  private slots: Map<string, ConcurrencySlot> = new Map();
  private defaultLimit: number;
  private defaultMaxQueueDepth: number;
  private defaultReserved: number;

  constructor(defaultLimit: number = 5, defaultMaxQueueDepth: number = 10, defaultReserved: number = 1) {
    this.defaultLimit = defaultLimit;
    this.defaultMaxQueueDepth = defaultMaxQueueDepth;
    this.defaultReserved = defaultReserved;
  }

  private getOrCreateSlot(key: string): ConcurrencySlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, limit: this.defaultLimit, maxQueueDepth: this.defaultMaxQueueDepth, reserved: this.defaultReserved, queue: [] };
      this.slots.set(key, slot);
      metrics.gauge("concurrency_limit", { key }).set(this.defaultLimit);
    }
    return slot;
  }

  /**
   * Acquire a slot with cancel support. Returns a promise and a cancel function.
   * Cancel is idempotent — safe to call after resolution.
   *
   * When all slots are occupied AND the queue is at capacity, the returned
   * promise rejects with a QueueFullError instead of enqueuing.
   */
  acquireCancelable(key: string): { promise: Promise<void>; cancel: () => void } {
    const slot = this.getOrCreateSlot(key);
    if (slot.active < slot.limit) {
      slot.active++;
      metrics.gauge("concurrency_active", { key }).set(slot.active);
      return { promise: Promise.resolve(), cancel: () => {} };
    }

    const liveCount = slot.queue.filter(w => !w.cancelled).length;
    if (liveCount >= slot.maxQueueDepth) {
      return {
        promise: Promise.reject(new QueueFullError(liveCount, slot.maxQueueDepth)),
        cancel: () => {},
      };
    }

    const id = crypto.randomUUID();
    let resolveFn: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    const waiter: Waiter = { resolve: resolveFn!, cancelled: false, id, enqueuedAt: Date.now() };
    slot.queue.push(waiter);
    metrics.gauge("concurrency_queued", { key }).set(liveCount + 1);

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
   * Acquire a background slot. Background tasks can only use limit - reserved slots.
   * Returns a discriminated outcome: "acquired" (slot taken), "queued" (waiting in queue),
   * or "full" (queue at capacity).
   */
  acquireBackground(key: string): AcquireBackgroundResult {
    const slot = this.getOrCreateSlot(key);
    const bgLimit = Math.max(0, slot.limit - slot.reserved);
    if (slot.active < bgLimit) {
      slot.active++;
      metrics.gauge("concurrency_active", { key }).set(slot.active);
      return { outcome: "acquired", cancel: () => {} };
    }

    const liveCount = slot.queue.filter(w => !w.cancelled).length;
    if (liveCount >= slot.maxQueueDepth) {
      return {
        outcome: "full",
        error: new QueueFullError(liveCount, slot.maxQueueDepth),
        cancel: () => {},
      };
    }

    const id = crypto.randomUUID();
    let resolveFn: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    const waiter: Waiter = { resolve: resolveFn!, cancelled: false, id, enqueuedAt: Date.now() };
    slot.queue.push(waiter);
    metrics.gauge("concurrency_queued", { key }).set(liveCount + 1);

    return {
      outcome: "queued",
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
   * Acquire a sync slot. Sync tasks can use all limit slots including reserved ones.
   * Falls back to the bounded cancelable queue if all slots are occupied.
   */
  acquireSync(key: string): { promise: Promise<void>; cancel: () => void } {
    return this.acquireCancelable(key);
  }

  /**
   * Bypass the acquire queue and directly occupy background concurrency slots.
   * Clamps to limit - reserved (does not steal reserved slots).
   * Returns the actual number of slots occupied.
   */
  forceOccupyBackground(key: string, count: number = 1): number {
    const slot = this.getOrCreateSlot(key);
    const bgLimit = Math.max(0, slot.limit - slot.reserved);
    const added = Math.min(count, Math.max(0, bgLimit - slot.active));
    slot.active += added;
    return added;
  }

  /** Returns the reserved slot count for the given key. */
  getReserved(key: string): number {
    return this.slots.get(key)?.reserved ?? this.defaultReserved;
  }

  /** Set the reserved slot count for the given key. */
  setReserved(key: string, count: number): void {
    const slot = this.getOrCreateSlot(key);
    slot.reserved = count;
  }

  /** Configure per-key reserved slots (alias for setReserved). */
  setSlotReserved(key: string, reserved: number): void {
    this.setReserved(key, reserved);
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
    metrics.gauge("concurrency_active", { key }).set(slot.active);

    while (slot.queue.length > 0) {
      const w = slot.queue.shift()!;
      if (w.cancelled) continue;
      const waitMs = Date.now() - w.enqueuedAt;
      metrics.histogram("queue_wait_ms", { key }).observe(waitMs);
      slot.active++;
      metrics.gauge("concurrency_active", { key }).set(slot.active);
      const newLiveCount = slot.queue.filter(x => !x.cancelled).length;
      metrics.gauge("concurrency_queued", { key }).set(newLiveCount);
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

}
