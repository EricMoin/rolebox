import { realpathSync, statSync } from "node:fs";
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
 * Strip trailing path-separator runs from a file path, preserving a bare root.
 *
 * Both POSIX `/` and Windows `\` are treated as separators (Windows accepts
 * both at the filesystem level). Used so that `dir/f.txt` and `dir/f.txt/`
 * spell the same lock key: `realpathSync` throws ENOTDIR on the trailing-slash
 * form of a regular file, which previously forced a string-key fallback that
 * diverged from the resolved form when a parent segment was a symlink
 * (e.g. `/var` -> `/private/var` on darwin), bypassing duplicate detection.
 */
function stripTrailingSeparators(filePath: string): string {
  const stripped = filePath.replace(/[\\/]+$/, "");
  // Preserve a bare root ("/" or "C:\") — stripping it to "" would make the
  // realpath probe meaningless and the fallback wrong.
  return stripped.length === 0 ? filePath : stripped;
}

/**
 * Normalize a file path into a lock key.
 *
 * For a path that EXISTS on disk, the key is a filesystem-identity token
 * (`ino:${dev}:${ino}`) derived from `realpathSync` + `statSync` on the
 * trailing-slash-stripped path. Because the identity is the inode, every peer
 * directory entry of the same file — a symlink chain (D15), a hardlink alias
 * (D2), or a trailing-slash spelling (D3) — folds to the SAME key and is
 * rejected as a duplicate within one batch, while distinct files never collide.
 *
 * For a path that does NOT exist yet (a to-be-created file), or when the
 * `realpathSync`/`statSync` probe fails or races the filesystem (ENOENT/
 * ENOTDIR, or the file vanishing between the two calls), the key falls back to
 * the normalized string of the trailing-slash-stripped path: `resolve()`
 * collapses relative paths and `..`/`.` segments, and on darwin/win32
 * (case-insensitive by default) the result is additionally lowercased so case
 * aliases of the same future file serialize against each other.
 */
export function normalizeLockKey(filePath: string): string {
  const stripped = stripTrailingSeparators(filePath);
  try {
    const resolvedPath = realpathSync(stripped);
    const st = statSync(resolvedPath);
    return `ino:${st.dev}:${st.ino}`;
  } catch {
    // ENOENT/ENOTDIR (to-be-created file), a realpath/stat race, or any other
    // probe failure: fall back to a normalized string key of the stripped path.
  }
  const fallback = resolve(stripped);
  return process.platform === "darwin" || process.platform === "win32"
    ? fallback.toLowerCase()
    : fallback;
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
