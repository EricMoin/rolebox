import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Per-path FIFO async mutex.
 *
 * Serializes same-file critical sections within a single process (Bun/Node
 * share one event loop, but async code interleaves at every await point).
 * This is intentionally an in-process lock only — it provides NO mutual
 * exclusion across processes. Cross-process races are handled by best-effort
 * pre-write version revalidation in the hashline_edit write path, not here.
 *
 * Lock state lives in a module-level Map keyed by `normalizeLockKey(path)`.
 * Entries are dropped once their tail settles and nothing is queued behind
 * them, so holding no locks leaves no retained state.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Normalize a file path into a lock key.
 *
 * `realpathSync` resolves symlink chains so a file and a symlink alias of it
 * contend on the same lock and are recognized as the same file (D15: a batch
 * holding both must be rejected as duplicate). Non-existent paths (to-be-
 * created files) cannot be realpath'd — ENOENT falls back to `path.resolve`,
 * which still collapses relative paths and `..`/`.` segments so different
 * spellings of the same (future) file contend on the same lock. On darwin and
 * win32 (case-insensitive by default) the key is additionally lowercased so
 * case aliases of the same file serialize against each other.
 */
export function normalizeLockKey(filePath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    resolved = resolve(filePath);
  }
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

/** A held path lock. Call `release()` exactly when the critical section ends. */
export interface PathLock {
  /** Release the lock. Idempotent — safe to call more than once. */
  release(): void;
}

/**
 * Acquire the lock for `filePath`, waiting FIFO behind any earlier acquirers.
 *
 * The returned lock must be released (use `withPathLock` / `withPathLocks`
 * when the critical section is a single function call). Release is idempotent:
 * repeated calls hand the lock to the next waiter exactly once.
 */
export async function acquirePathLock(filePath: string): Promise<PathLock> {
  const key = normalizeLockKey(filePath);
  const prev = queues.get(key) ?? Promise.resolve();

  let released = false;
  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((res) => {
    resolveGate = res;
  });
  const release = (): void => {
    if (released) return;
    released = true;
    resolveGate();
  };

  // Queue tail: settles only when this holder releases. It never rejects, so
  // the next acquirer always gets handed the lock even if this holder's
  // critical section threw.
  const tail = prev.then(() => gate);
  queues.set(key, tail);

  // Drop the map entry once this tail settles and nothing queued behind it.
  // No state leaks after the last acquirer finishes.
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });

  await prev; // FIFO: wait for the previous holder to release.
  return { release };
}

/** Run `fn` while holding the lock for `filePath`; release on every path. */
export async function withPathLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = await acquirePathLock(filePath);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Acquire locks for every path in `filePaths` at once.
 *
 * Paths are deduplicated by normalized key (acquiring the same key twice in one
 * call would self-deadlock) and sorted by key, so overlapping batches from
 * concurrent callers contend in a single global order and can never deadlock.
 * The returned composite lock releases in reverse acquisition order; on partial
 * acquisition failure, already-held locks are released before rethrowing.
 */
export async function acquirePathLocks(filePaths: string[]): Promise<PathLock> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const filePath of filePaths) {
    const key = normalizeLockKey(filePath);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(filePath);
    }
  }
  unique.sort((a, b) => {
    const ka = normalizeLockKey(a);
    const kb = normalizeLockKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const locks: PathLock[] = [];
  try {
    for (const filePath of unique) {
      locks.push(await acquirePathLock(filePath));
    }
  } catch (err) {
    for (let i = locks.length - 1; i >= 0; i--) {
      locks[i].release();
    }
    throw err;
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      for (let i = locks.length - 1; i >= 0; i--) {
        locks[i].release();
      }
    },
  };
}

/** Run `fn` while holding every lock in `filePaths`; release all on every path. */
export async function withPathLocks<T>(filePaths: string[], fn: () => T | Promise<T>): Promise<T> {
  const lock = await acquirePathLocks(filePaths);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
