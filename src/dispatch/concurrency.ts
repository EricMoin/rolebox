/**
 * Promise-based semaphore for limiting concurrent subagent executions per model key.
 *
 * Key format: `${providerID}/${modelID}` (model-based concurrency).
 * Fallback key when model unknown: "default".
 */

interface ConcurrencySlot {
  active: number;
  limit: number;
  queue: Array<() => void>;
}

export class ConcurrencyManager {
  private slots: Map<string, ConcurrencySlot> = new Map();
  private defaultLimit: number;

  constructor(defaultLimit: number = 5) {
    this.defaultLimit = defaultLimit;
  }

  /**
   * Acquire a slot for the given key. Resolves immediately if under the limit,
   * otherwise queues the caller until a slot is freed.
   */
  acquire(key: string): Promise<void> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, limit: this.defaultLimit, queue: [] };
      this.slots.set(key, slot);
    }

    if (slot.active < slot.limit) {
      slot.active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      slot!.queue.push(resolve);
    });
  }

  /**
   * Release a slot for the given key. If there are queued waiters, the next one
   * is immediately granted the slot.
   */
  release(key: string): void {
    const slot = this.slots.get(key);
    if (!slot || slot.active <= 0) return;

    slot.active--;

    if (slot.queue.length > 0) {
      const next = slot.queue.shift()!;
      slot.active++;
      next();
    }
  }

  /** Returns the number of currently active acquisitions for the given key. */
  getActiveCount(key: string): number {
    return this.slots.get(key)?.active ?? 0;
  }

  /**
   * Bypass the acquire queue and directly occupy concurrency slots.
   * Intended for crash recovery only — caller is responsible for correctness.
   */
  forceOccupy(key: string, count: number = 1): void {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: 0, limit: this.defaultLimit, queue: [] };
      this.slots.set(key, slot);
    }
    slot.active += count;
  }
}
