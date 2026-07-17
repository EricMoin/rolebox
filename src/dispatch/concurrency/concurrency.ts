/**
 * Promise-based semaphore for limiting concurrent subagent executions per model key.
 *
 * Key format: `${providerID}/${modelID}` (model-based concurrency).
 * Fallback key when model unknown: "default".
 */

import { debugLog, infoLog } from "../core/debug-log.ts";
import { metrics } from "../persistence/metrics.ts";

interface Waiter {
  resolve: () => void;
  cancelled: boolean;
  id: string;
  enqueuedAt: number;
  expiresAt: number;
  parentId?: string;
  maxActivePerParent?: number;
  /** Priority: lower number = higher priority. Default 0. Used to order queue promotion. */
  priority: number;
}

interface ConcurrencySlot {
  active: number;
  limit: number;
  maxQueueDepth: number;
  reserved: number;
  queue: Waiter[];
  activeByParent: Map<string, number>;
}

export type AcquireBackgroundResult =
  | { outcome: "acquired"; cancel: () => void }
  | { outcome: "queued"; promise: Promise<void>; cancel: () => void }
  | { outcome: "full"; error: QueueFullError; cancel: () => void };

/** Error thrown when a waiter exceeds the TTL while waiting in the queue. */
export class WaiterTimeoutError extends Error {
  constructor(key: string, waitMs: number) {
    super(`Waiter timed out after ${waitMs}ms for key "${key}"`);
    this.name = "WaiterTimeoutError";
  }
}

/** Default TTL for queued waiters: 300 seconds (5 minutes). */
export const WAITER_TTL_MS = 300_000;

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

/**
 * Interface for concurrency management. The default implementation is
 * ConcurrencyManager (per-model semaphore + FIFO queue). Custom implementations
 * can be plugged in via the concurrency_policies extension point or
 * the concurrency_policy config field.
 */
export interface IConcurrencyManager {
  acquireBackground(key: string, opts?: { parentId?: string; maxActivePerParent?: number; priority?: number }): AcquireBackgroundResult;
  acquireSync(key: string): { promise: Promise<void>; cancel: () => void };
  release(key: string, parentId?: string): void;
  getActiveCount(key: string): number;
  getLimit(key: string): number;
  forceOccupyBackground(key: string, count?: number, parentId?: string): number;
  getReserved(key: string): number;
  setReserved(key: string, count: number): void;
  canAcquireForParent(key: string, parentId: string, maxActivePerParent: number): boolean;
  setSlotReserved(key: string, reserved: number): void;
  getQueueDepth(key: string): number;
  getAllKeys(): string[];
}

export class ConcurrencyManager implements IConcurrencyManager {
  private slots: Map<string, ConcurrencySlot> = new Map();
  private defaultLimit: number;
  private defaultMaxQueueDepth: number;
  private defaultReserved: number;
  private retryAfterMs: number;
  private _sweeperInterval: ReturnType<typeof setInterval> | undefined;

  constructor(defaultLimit: number = 5, defaultMaxQueueDepth: number = 10, defaultReserved: number = 1, retryAfterMs: number = 30_000) {
    this.defaultLimit = defaultLimit;
    this.defaultMaxQueueDepth = defaultMaxQueueDepth;
    this.defaultReserved = defaultReserved;
    this.retryAfterMs = retryAfterMs;
    this._sweeperInterval = setInterval(() => this._sweepExpiredWaiters(), 60_000);
    if (this._sweeperInterval && typeof this._sweeperInterval === "object" && "unref" in this._sweeperInterval) {
      (this._sweeperInterval as any).unref();
    }
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

    const waiter: Waiter = { resolve: resolveFn!, cancelled: false, id, enqueuedAt: Date.now(), expiresAt: 0, priority: 0 };
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
  acquireBackground(key: string, opts?: { parentId?: string; maxActivePerParent?: number; priority?: number }): AcquireBackgroundResult {
    const slot = this.getOrCreateSlot(key);
    const bgLimit = Math.max(0, slot.limit - slot.reserved);
    const { parentId, maxActivePerParent, priority = 0 } = opts ?? {};

    if (parentId !== undefined && maxActivePerParent !== undefined && !this.canAcquireForParent(key, parentId, maxActivePerParent)) {
      return this._enqueueBackground(key, slot, parentId, maxActivePerParent, priority);
    }

    if (slot.active < bgLimit) {
      slot.active++;
      if (parentId !== undefined) {
        slot.activeByParent.set(parentId, (slot.activeByParent.get(parentId) ?? 0) + 1);
      }
      metrics.gauge("concurrency_active", { key }).set(slot.active);
      return { outcome: "acquired", cancel: () => {} };
    }

    return this._enqueueBackground(key, slot, parentId, maxActivePerParent, priority);
  }

  private _enqueueBackground(key: string, slot: ConcurrencySlot, parentId?: string, maxActivePerParent?: number, priority: number = 0): AcquireBackgroundResult {
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

    const expiresAt = Date.now() + WAITER_TTL_MS;

    // Create waiter first so the TTL timer callback can reference it via closure
    const waiter: Waiter = { resolve: () => {}, cancelled: false, id, enqueuedAt: Date.now(), expiresAt, parentId, maxActivePerParent, priority };
    // TTL race: slot acquisition vs timeout
    let ttlTimer: ReturnType<typeof setTimeout> | undefined;
    const ttlPromise = new Promise<void>((_, reject) => {
      ttlTimer = setTimeout(() => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        const idx = slot.queue.findIndex((w) => w.id === id);
        if (idx !== -1) slot.queue.splice(idx, 1);
        metrics.gauge("concurrency_queued", { key }).set(slot.queue.filter(w => !w.cancelled).length);
        reject(new WaiterTimeoutError(key, WAITER_TTL_MS));
      }, WAITER_TTL_MS);
    });

    // Override resolve to clear the TTL timer when the waiter is promoted
    const overrideResolve = () => {
      clearTimeout(ttlTimer);
      resolveFn!();
    };
    waiter.resolve = overrideResolve;
    slot.queue.push(waiter);
    metrics.gauge("concurrency_queued", { key }).set(liveCount + 1);

    return {
      outcome: "queued",
      promise: Promise.race([promise, ttlPromise]),
      cancel: () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        clearTimeout(ttlTimer);
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

    // Find the eligible waiter with the highest priority (lowest number).
    // Ties are broken by enqueue order (FIFO within same priority).
    let bestIdx = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < slot.queue.length; i++) {
      const w = slot.queue[i];
      if (w.cancelled) continue;
      if (w.parentId !== undefined && w.maxActivePerParent !== undefined) {
        const parentActive = slot.activeByParent.get(w.parentId) ?? 0;
        if (parentActive >= w.maxActivePerParent!) continue;
      }
      // Lower priority number = higher priority
      if (bestIdx === -1 || w.priority < bestPriority) {
        bestIdx = i;
        bestPriority = w.priority;
      }
      // Same priority: first enqueued wins (FIFO) — already scanning left-to-right
    }

    if (bestIdx === -1) return;

    const w = slot.queue[bestIdx];
    // Remove elements up to and including bestIdx, re-add non-cancelled ones except the promoted waiter
    const removed = slot.queue.splice(0, bestIdx + 1);
    for (let j = bestIdx - 1; j >= 0; j--) {
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

  /**
   * Sweep expired waiters from all slots' queues.
   * Runs periodically (every 60s) via the _sweeperInterval.
   */
  private _sweepExpiredWaiters(): void {
    let totalExpired = 0;
    for (const [key, slot] of this.slots) {
      const before = slot.queue.length;
      const now = Date.now();
      slot.queue = slot.queue.filter(w => {
        if (w.cancelled) return false;
        if (w.expiresAt > 0 && w.expiresAt <= now) {
          w.cancelled = true;
          totalExpired++;
          return false;
        }
        return true;
      });
      const removed = before - slot.queue.length;
      if (removed > 0) {
        debugLog("concurrency", key, `sweep removed ${removed} expired waiters from queue`);
      }
    }
    if (totalExpired > 0) {
      infoLog("concurrency", "sweeper", `Sweep removed ${totalExpired} expired waiters across all keys`);
    }
  }

  /** Clean up the sweeper interval. Call when the manager is disposed. */
  dispose(): void {
    if (this._sweeperInterval) {
      clearInterval(this._sweeperInterval);
      this._sweeperInterval = undefined;
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

  /** Returns the count of non-cancelled waiters in the queue for the given key (0 if key not found). */
  getQueueDepth(key: string): number {
    const slot = this.slots.get(key);
    if (!slot) return 0;
    return slot.queue.filter(w => !w.cancelled).length;
  }

  /** Returns all concurrency keys that have been created. */
  getAllKeys(): string[] {
    return Array.from(this.slots.keys());
  }
}
