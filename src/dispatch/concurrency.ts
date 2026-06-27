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
  parentId?: string;
  maxActivePerParent?: number;
}

interface ConcurrencySlot {
  active: number;
  limit: number;
  maxQueueDepth: number;
  reserved: number;
  queue: Waiter[];
  activeByParent: Map<string, number>;
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
  private retryAfterMs: number;

  constructor(defaultLimit: number = 5, defaultMaxQueueDepth: number = 10, defaultReserved: number = 1, retryAfterMs: number = 30_000) {
    this.defaultLimit = defaultLimit;
    this.defaultMaxQueueDepth = defaultMaxQueueDepth;
    this.defaultReserved = defaultReserved;
    this.retryAfterMs = retryAfterMs;
  }

  private getOrCreateSlot(key: string): ConcurrencySlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, limit: this.defaultLimit, maxQueueDepth: this.defaultMaxQueueDepth, reserved: this.defaultReserved, queue: [], activeByParent: new Map() };
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
        promise: Promise.reject(new QueueFullError(liveCount, slot.maxQueueDepth, this.retryAfterMs)),
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
   *
   * Optional opts.parentId and opts.maxActivePerParent enable per-parent fairness:
   * when a parent would exceed its maxActivePerParent, the request is queued even if
   * global slots are available.
   */
  acquireBackground(key: string, opts?: { parentId?: string; maxActivePerParent?: number }): AcquireBackgroundResult {
    const slot = this.getOrCreateSlot(key);
    const bgLimit = Math.max(0, slot.limit - slot.reserved);
    const { parentId, maxActivePerParent } = opts ?? {};

    if (parentId !== undefined && maxActivePerParent !== undefined && !this.canAcquireForParent(key, parentId, maxActivePerParent)) {
      return this._enqueueBackground(key, slot, parentId, maxActivePerParent);
    }

    if (slot.active < bgLimit) {
      slot.active++;
      if (parentId !== undefined) {
        slot.activeByParent.set(parentId, (slot.activeByParent.get(parentId) ?? 0) + 1);
      }
      metrics.gauge("concurrency_active", { key }).set(slot.active);
      return { outcome: "acquired", cancel: () => {} };
    }

    return this._enqueueBackground(key, slot, parentId, maxActivePerParent);
  }

  private _enqueueBackground(key: string, slot: ConcurrencySlot, parentId?: string, maxActivePerParent?: number): AcquireBackgroundResult {
    const liveCount = slot.queue.filter(w => !w.cancelled).length;
    if (liveCount >= slot.maxQueueDepth) {
      return {
        outcome: "full",
        error: new QueueFullError(liveCount, slot.maxQueueDepth, this.retryAfterMs),
        cancel: () => {},
      };
    }

    const id = crypto.randomUUID();
    let resolveFn: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    const waiter: Waiter = { resolve: resolveFn!, cancelled: false, id, enqueuedAt: Date.now(), parentId, maxActivePerParent };
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
   * Check whether a parent can acquire another slot for the given key.
   * Returns false when the parent already holds maxActivePerParent or more active slots.
   */
  canAcquireForParent(key: string, parentId: string, maxActivePerParent: number): boolean {
    const slot = this.slots.get(key);
    if (!slot) return true;
    const parentActive = slot.activeByParent.get(parentId) ?? 0;
    return parentActive < maxActivePerParent;
  }

  /**
   * Bypass the acquire queue and directly occupy background concurrency slots.
   * Clamps to limit - reserved (does not steal reserved slots).
   * When parentId is provided, registers the occupied slots against that parent.
   * Returns the actual number of slots occupied.
   */
  forceOccupyBackground(key: string, count: number = 1, parentId?: string): number {
    const slot = this.getOrCreateSlot(key);
    const bgLimit = Math.max(0, slot.limit - slot.reserved);
    const added = Math.min(count, Math.max(0, bgLimit - slot.active));
    slot.active += added;
    if (parentId && added > 0) {
      slot.activeByParent.set(parentId, (slot.activeByParent.get(parentId) ?? 0) + added);
    }
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
   * Release a slot for the given key. If there are queued waiters, the first
   * eligible non-cancelled one is immediately granted the slot. Waiters whose
   * parent is at or over their maxActivePerParent cap are skipped so a different
   * parent's waiter can be promoted instead.
   */
  release(key: string, parentId?: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;

    if (slot.active <= 0) {
      debugLog("concurrency", key, `release underflow: active=${slot.active}`);
      return;
    }

    slot.active--;
    metrics.gauge("concurrency_active", { key }).set(slot.active);

    if (parentId) {
      const current = slot.activeByParent.get(parentId) ?? 0;
      if (current <= 1) {
        slot.activeByParent.delete(parentId);
      } else {
        slot.activeByParent.set(parentId, current - 1);
      }
    }

    this._promoteNextEligible(key, slot);
  }

  private _promoteNextEligible(key: string, slot: ConcurrencySlot): void {
    while (slot.queue.length > 0 && slot.queue[0].cancelled) {
      slot.queue.shift();
    }

    let eligibleIdx = -1;
    for (let i = 0; i < slot.queue.length; i++) {
      if (slot.queue[i].cancelled) continue;
      if (slot.queue[i].parentId !== undefined && slot.queue[i].maxActivePerParent !== undefined) {
        const parentActive = slot.activeByParent.get(slot.queue[i].parentId!) ?? 0;
        if (parentActive >= slot.queue[i].maxActivePerParent!) continue;
      }
      eligibleIdx = i;
      break;
    }

    if (eligibleIdx === -1) return;

    const w = slot.queue[eligibleIdx];
    const removed = slot.queue.splice(0, eligibleIdx + 1);
    for (let j = removed.length - 2; j >= 0; j--) {
      if (!removed[j].cancelled) {
        slot.queue.unshift(removed[j]);
      }
    }

    const waitMs = Date.now() - w.enqueuedAt;
    metrics.histogram("queue_wait_ms", { key }).observe(waitMs);
    slot.active++;
    if (w.parentId) {
      slot.activeByParent.set(w.parentId, (slot.activeByParent.get(w.parentId) ?? 0) + 1);
    }
    metrics.gauge("concurrency_active", { key }).set(slot.active);
    const newLiveCount = slot.queue.filter(x => !x.cancelled).length;
    metrics.gauge("concurrency_queued", { key }).set(newLiveCount);
    w.resolve();
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
