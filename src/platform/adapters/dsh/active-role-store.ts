/**
 * ActiveRoleStore — per-workspace, session-keyed, versioned JSON sidecar for
 * the dsh active-role selection.
 *
 * sidecar remedy: active-role durability moves off the dsh session event log
 * (whose unknown `rolebox/active-role` envelope rc.6 persistence refuses to
 * reload — see `role-switcher.ts`) into a rolebox-owned file under
 * `.rolebox/state`. The file is named `activerole-<dirHash>.json`, matching the
 * canonical state-file naming in `src/utils/state-paths.ts` and the sibling
 * stores ({@link FunctionRuntimeStore} `fnstate-`, {@link LoopStore} `loops-`).
 *
 * Shape: `{ version: 1; sessions: [{ sessionId, roleId, updatedAt }] }`.
 * `roleId: null` records an explicit clear back to the base agent (distinct
 * from a session that was never written).
 *
 * Multi-process safety: the file is shared, not private. `src/entries/dsh.ts`
 * builds the store from `process.cwd()`, so two dsh web processes serving the
 * same workspace resolve to the same path — and a whole-map write from either
 * one used to erase the sessions the other had just added. Therefore:
 *   - **every write is a read-merge-write while holding a cross-process lock.**
 *     The lock is the existence of `<statePath>.lock`, created with
 *     `openSync(path, "wx", 0o600)`. Under it, the current file is read with the
 *     same tolerant parser `load()` uses, the caller's entries are merged in by
 *     `sessionId` (the larger `updatedAt` wins; the caller wins a tie, so a
 *     repeated save in one process still lands last), disk-only entries are
 *     kept, and the `maxSessions` cap is applied newest-first before writing.
 *   - the locked section is **fully synchronous on both paths** — the merge
 *     read and the replace happen with no `await` between them, and the lock is
 *     released in the same tick. Holding a file lock across a promise boundary
 *     deadlocks this process against itself: a sibling `saveSync` blocks the
 *     event loop while spinning, so the async holder can never be resumed to
 *     release, and both end up writing from stale reads. The lock is therefore
 *     held for microseconds and always released in a `finally`.
 *   - the wait is **bounded**, because one caller is a shutdown path: async
 *     writes retry every 10ms for ~2s, `saveSync` spins up to ~250ms (only ever
 *     waiting on another PROCESS, now that a same-process holder cannot be
 *     preempted mid-write), and a lock file older than 10s belongs to a writer
 *     that is not coming back, so it is taken over (unlink, then retry). A
 *     caller that exhausts its wait proceeds unlocked rather than dropping its
 *     data; the merge narrows that window to one read.
 *   - the write itself is **one atomic replace**: a unique temp sibling is
 *     renamed over the target, so a concurrent reader sees the old file or the
 *     new one and never a moment with no file. The shared `atomicWriteSync`
 *     helper is deliberately not used — it unlinks the target first, which is
 *     exactly that no-file window.
 *   - `load()` takes no lock: readers only ever see a whole file, so an unlocked
 *     read is safe and a stalled writer cannot block a reader.
 *
 * Behaviour mirrors the house stores:
 *   - `load()` fails soft — missing/corrupt/out-of-range files return `null`
 *   - version-range migration: files older than the current schema version are
 *     normalized forward instead of rejected; unknown future versions are
 *     rejected (return `null`)
 *   - `prune()` applies a TTL and a per-file session cap in memory
 *   - `load()` prunes on every read (TTL + cap) so the file cannot grow without
 *     bound; when a live-session census (`ctx.sessions.list()` mapped to ids)
 *     is supplied, a still-live session is protected from TTL eviction even
 *     when its entry is old — an entry is evicted only when it is BOTH absent
 *     from the census AND older than the TTL
 *   - **never delete on `session/disposed`** — disposal is memory eviction, not
 *     permanent deletion (`dsh-session/lib/types/index.d.ts:54`); a disposed
 *     session may be reloaded later. This store registers no session-lifecycle
 *     handler and evicts only lazily via TTL/cap at load time.
 *
 * The store is workspace-scoped: the caller passes the workspace directory.
 * This module does NOT import `@deepseek-ai/*` (or `@opencode-ai/*`).
 *
 * @module
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { uniqueTmpPath } from "../../../function/fs-util.ts";
import { shortHash } from "../../../utils/state-paths.ts";
import { createSubLogger } from "../../../logger.ts";

const log = createSubLogger("active-role-store");

/** Current on-disk schema version written by {@link ActiveRoleStore}. */
export const ACTIVE_ROLE_STORE_VERSION = 1;

/** Oldest on-disk schema version this store can migrate forward from. */
export const ACTIVE_ROLE_STORE_MIN_VERSION = 0;

/** Default prune TTL — sessions untouched for longer are dropped (30 days). */
export const DEFAULT_ACTIVE_ROLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default prune cap — the newest N sessions are retained. */
export const DEFAULT_ACTIVE_ROLE_MAX_SESSIONS = 200;

/**
 * One persisted active-role selection, keyed by `sessionId` in the in-memory
 * map and stored inline in the file's `sessions` array.
 */
export interface ActiveRoleEntry {
  /** The dsh session id this selection applies to. */
  sessionId: string;
  /** Active role id, or `null` for an explicit clear back to the base agent. */
  roleId: string | null;
  /** Epoch ms of the last write for this session (used by {@link ActiveRoleStore.prune}). */
  updatedAt: number;
}

/** On-disk envelope. `version` is intentionally widened for migration reads. */
interface FileShape {
  version: number;
  sessions: ActiveRoleEntry[];
}

/** Suffix of the cross-process write lock guarding a state file. */
const LOCK_SUFFIX = ".lock";

/** A lock file older than this belongs to a writer that is not coming back. */
const LOCK_STALE_MS = 10_000;

/** Retry interval while an async write waits for the cross-process lock. */
const LOCK_RETRY_MS = 10;

/** Bounded wait for the cross-process lock on the async path. */
const LOCK_ASYNC_TIMEOUT_MS = 2_000;

/**
 * Bounded wait for the cross-process lock on the synchronous path. `saveSync`
 * runs from flush/shutdown handlers, so it must finish even when another
 * process is wedged; a busy spin keeps it independent of any timer/event loop
 * that may already be torn down. Short because the holder's critical section is
 * synchronous (a read, a write and a rename): a live writer never needs more
 * than that, so time spent here means a wedged process, and shutdown should not
 * pay a second for it.
 */
const LOCK_SYNC_TIMEOUT_MS = 250;

/**
 * Parse a persisted envelope tolerantly — the one reader used by both
 * {@link ActiveRoleStore.load} and the merge in each write.
 *
 * Answers `null` when nothing usable can be read: malformed JSON, no
 * `sessions` array, or a version outside `[MIN, CURRENT]`. Rows without a
 * string `sessionId` are skipped; a missing/non-string `roleId` becomes `null`
 * and a missing/invalid `updatedAt` becomes `0`, which is what lets a version-0
 * file migrate forward instead of being rejected.
 */
function parseFile(raw: string): Map<string, ActiveRoleEntry> | null {
  let parsed: FileShape;
  try {
    parsed = JSON.parse(raw) as FileShape;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.sessions)) return null;
  const version = parsed.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < ACTIVE_ROLE_STORE_MIN_VERSION ||
    version > ACTIVE_ROLE_STORE_VERSION
  ) {
    return null;
  }

  const out = new Map<string, ActiveRoleEntry>();
  for (const entry of parsed.sessions) {
    if (typeof entry?.sessionId !== "string") continue;
    const roleId = typeof entry.roleId === "string" ? entry.roleId : null;
    const updatedAt =
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : 0;
    out.set(entry.sessionId, { sessionId: entry.sessionId, roleId, updatedAt });
  }
  if (version < ACTIVE_ROLE_STORE_VERSION) {
    log.info("Migrated active-role store", {
      fromVersion: version,
      toVersion: ACTIVE_ROLE_STORE_VERSION,
      sessions: out.size,
    });
  }
  return out;
}

/**
 * Rename `temporary` over `target`, replacing it in one step.
 *
 * POSIX rename replaces an existing file atomically. Windows refuses a rename
 * onto an existing file, so only for `EEXIST`/`EPERM` does the old target get
 * unlinked first — a fallback that keeps Windows working without giving POSIX
 * the no-file window.
 */
function renameOver(temporary: string, target: string): void {
  try {
    renameSync(temporary, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw err;
    try {
      unlinkSync(target);
    } catch {
      // Already gone: the rename below is then the plain POSIX case.
    }
    renameSync(temporary, target);
  }
}

/**
 * Atomically replace `target` with `content`: write a unique sibling temp file,
 * then rename it over the target. Nothing is unlinked before the rename, so a
 * concurrent reader always sees a complete file.
 *
 * Deliberately synchronous, and used by BOTH save paths: the locked critical
 * section then contains no `await`, so a sibling `saveSync` in this same process
 * cannot block the event loop under a holder that is waiting to be resumed — it
 * would spin out its budget and then write unlocked from a stale view.
 */
function replaceFileSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = uniqueTmpPath(target);
  try {
    writeFileSync(temporary, content, "utf-8");
    renameOver(temporary, target);
  } catch (err) {
    // Best-effort cleanup so a failed write never leaves an orphan `.tmp`
    try { unlinkSync(temporary); } catch {}
    throw err;
  }
}

/**
 * Options controlling {@link ActiveRoleStore.prune} and
 * {@link ActiveRoleStore.load}.
 */
export interface ActiveRoleStoreOptions {
  /** TTL in ms; entries older than this are pruned. Defaults to 30 days. */
  ttlMs?: number;
  /** Maximum sessions retained. Defaults to 200. */
  maxSessions?: number;
  /**
   * Live-session census — the session ids that still exist in the harness
   * (`ctx.sessions.list()` mapped to ids). May be a snapshot or a provider so
   * a caller can read the census fresh at load time. When supplied, a stale
   * entry whose session is still present is retained (a disposed session that
   * is still reloadable is not deleted); an entry is evicted only when it is
   * absent from the census AND older than the TTL. Omit it to fall back to
   * TTL-only eviction.
   */
  liveSessionIds?: Iterable<string> | (() => Iterable<string>);
}

/**
 * Workspace-scoped store for dsh active-role selections.
 *
 * Construct with the workspace directory; all instances for the same physical
 * directory resolve to the same state file.
 */
export class ActiveRoleStore {
  private readonly directory: string;
  private readonly dirHash: string;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  /** Census provider configured at construction; see {@link ActiveRoleStoreOptions.liveSessionIds}. */
  private readonly liveSessionIds?: Iterable<string> | (() => Iterable<string>);

  /** Serializes async saves so a later write never interleaves an earlier one. */
  private _lock: Promise<void> = Promise.resolve();

  /**
   * @param directory - Workspace directory (the `.rolebox/state` file lives under it).
   * @param options   - Optional prune defaults (TTL, cap, live-session census).
   */
  constructor(directory: string, options: ActiveRoleStoreOptions = {}) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
    this.ttlMs = options.ttlMs ?? DEFAULT_ACTIVE_ROLE_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_ACTIVE_ROLE_MAX_SESSIONS;
    this.liveSessionIds = options.liveSessionIds;
  }

  /** Absolute path to the workspace-scoped state file. */
  private statePath(): string {
    return join(this.directory, ".rolebox", "state", `activerole-${this.dirHash}.json`);
  }

  /** Path of the cross-process write lock guarding {@link statePath}. */
  private lockPath(): string {
    return `${this.statePath()}${LOCK_SUFFIX}`;
  }

  /** Serialize the in-memory map into the versioned envelope. */
  private toFile(sessions: Map<string, ActiveRoleEntry>): string {
    const entries = [...sessions.values()].map((e) => ({
      sessionId: e.sessionId,
      roleId: e.roleId,
      updatedAt: e.updatedAt,
    }));
    return JSON.stringify(
      { version: ACTIVE_ROLE_STORE_VERSION, sessions: entries } satisfies FileShape,
      null,
      2,
    );
  }

  /**
   * Persist `sessions`, merged over whatever another process has already
   * written.
   *
   * Async writes are serialized through the in-process `_lock` (so two calls in
   * one process cannot interleave), and the read-merge-write runs under the
   * cross-process lock file so a sibling dsh process's sessions survive. A
   * write failure is logged and swallowed (best-effort).
   */
  async save(sessions: Map<string, ActiveRoleEntry>): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(sessions),
      () => this._doSave(sessions),
    );
    return this._lock;
  }

  private async _doSave(sessions: Map<string, ActiveRoleEntry>): Promise<void> {
    const target = this.statePath();
    try {
      // The lock lives beside the target, so the directory must exist first.
      mkdirSync(dirname(target), { recursive: true });
      const lockPath = this.lockPath();
      const locked = await this.acquireLock(lockPath);
      try {
        // Synchronous on purpose: no `await` between the merge read and the
        // replace, so nothing in this process can interleave with the write.
        replaceFileSync(target, this.toFile(this.mergeWithDisk(sessions)));
      } finally {
        if (locked) this.releaseLock(lockPath);
      }
    } catch (err) {
      log.warn("ActiveRoleStore._doSave failed", err);
    }
  }

  /**
   * Synchronous variant of {@link save}: same read-merge-write under the
   * cross-process lock, with a bounded spin instead of an async wait.
   * Best-effort; failures are logged.
   */
  saveSync(sessions: Map<string, ActiveRoleEntry>): void {
    const target = this.statePath();
    try {
      // The lock lives beside the target, so the directory must exist first.
      mkdirSync(dirname(target), { recursive: true });
      const lockPath = this.lockPath();
      const locked = this.acquireLockSync(lockPath);
      try {
        replaceFileSync(target, this.toFile(this.mergeWithDisk(sessions)));
      } finally {
        if (locked) this.releaseLock(lockPath);
      }
    } catch (err) {
      log.warn("ActiveRoleStore.saveSync failed", err);
    }
  }

  /**
   * Merge this caller's map over the entries currently on disk.
   *
   * The disk read is tolerant — a missing, corrupt, or future-version file
   * simply contributes nothing, so the write still lands. For a `sessionId`
   * present on both sides the larger `updatedAt` wins, and the caller wins a
   * tie so a repeated save in one process still lands last. Disk-only entries
   * are kept: they belong to another process and are not this caller's to
   * drop. Finally the `maxSessions` cap is applied newest-first, matching
   * {@link load}'s bound. TTL pruning is deliberately NOT applied here — the
   * caller's map may legitimately still reference an older session, and the
   * load-time prune is the single place that decides expiry.
   *
   * @param incoming - The caller's map (never mutated).
   * @returns The merged map, bounded by the session cap.
   */
  private mergeWithDisk(
    incoming: Map<string, ActiveRoleEntry>,
  ): Map<string, ActiveRoleEntry> {
    const merged = new Map<string, ActiveRoleEntry>();
    const onDisk = this.readEntries();
    if (onDisk !== null) {
      for (const [sessionId, entry] of onDisk) merged.set(sessionId, entry);
    }
    for (const [sessionId, entry] of incoming) {
      const existing = merged.get(sessionId);
      if (existing !== undefined && existing.updatedAt > entry.updatedAt) continue;
      merged.set(sessionId, entry);
    }
    this.applyCap(merged, this.maxSessions);
    return merged;
  }

  /**
   * Try once to take the cross-process lock.
   *
   * `wx` is the whole mutex: the open fails with `EEXIST` exactly when the lock
   * file exists. Answers `"held"` on success, `"busy"` when another writer
   * holds it, and `"failed"` for anything else (permissions, a missing
   * directory), which the caller treats as "write unlocked, best effort".
   */
  private tryLock(lockPath: string): "held" | "busy" | "failed" {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return "held";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "busy";
      log.warn("ActiveRoleStore could not create its lock", err);
      return "failed";
    }
  }

  /**
   * Take over a lock whose mtime is older than {@link LOCK_STALE_MS} — the
   * writer that made it is not coming back to release it — and report whether
   * the caller should retry immediately. A lock that vanished between the
   * failed create and this stat is also a retry, not a wait.
   */
  private breakStaleLock(lockPath: string): boolean {
    let age: number;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return true;
    }
    if (age <= LOCK_STALE_MS) return false;
    try {
      unlinkSync(lockPath);
    } catch {
      // Another writer broke it first; either way the next create decides.
    }
    return true;
  }

  /**
   * Wait for the cross-process lock, retrying every {@link LOCK_RETRY_MS} for
   * at most {@link LOCK_ASYNC_TIMEOUT_MS}.
   *
   * @returns Whether the lock is held. On timeout the caller proceeds unlocked:
   *   dropping the save would lose the caller's own entry, while the unlocked
   *   merge-write still preserves everything it read.
   */
  private async acquireLock(lockPath: string): Promise<boolean> {
    const deadline = Date.now() + LOCK_ASYNC_TIMEOUT_MS;
    for (;;) {
      const attempt = this.tryLock(lockPath);
      if (attempt === "held") return true;
      if (attempt === "failed") return false;
      if (this.breakStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        log.warn("ActiveRoleStore lock wait timed out; writing unlocked", { lockPath });
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  /**
   * Synchronous counterpart of {@link acquireLock}: a bounded busy spin, so a
   * wedged sibling process cannot hold a flush or shutdown path open. Answers
   * `false` after {@link LOCK_SYNC_TIMEOUT_MS}, and the caller proceeds
   * unlocked for the reason given there.
   */
  private acquireLockSync(lockPath: string): boolean {
    const deadline = Date.now() + LOCK_SYNC_TIMEOUT_MS;
    for (;;) {
      const attempt = this.tryLock(lockPath);
      if (attempt === "held") return true;
      if (attempt === "failed") return false;
      if (this.breakStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        log.warn("ActiveRoleStore lock spin timed out; writing unlocked", { lockPath });
        return false;
      }
    }
  }

  /** Release the cross-process lock; one that cannot be removed is left to the stale rule. */
  private releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch {
      // A lock file that outlives its write is broken by the stale rule.
    }
  }

  /**
   * Load the persisted selections, pruning as it reads.
   *
   * Fails soft: a missing file, unreadable file, malformed JSON, or a schema
   * version outside `[MIN, CURRENT]` returns `null` (never throws). A version
   * older than {@link ACTIVE_ROLE_STORE_VERSION} is migrated forward: a
   * missing `roleId` becomes `null` and a missing/invalid `updatedAt` becomes
   * `0`.
   *
   * Lifecycle/GC: the returned map is passed through {@link prune} (TTL + cap)
   * before it is returned, so a file cannot grow without bound across restarts.
   * Passing `liveSessionIds` (from `ctx.sessions.list()`) additionally protects
   * a still-live session from TTL eviction. Pruning is in-memory only: a write
   * merges over the file instead of replacing it, so an expired row leaves the
   * file when the `maxSessions` cap evicts it, not when it expires.
   *
   * @param options - Per-call prune overrides (TTL, cap, live-session census).
   * @returns A session-keyed map, or `null` when nothing usable was read.
   */
  load(options: ActiveRoleStoreOptions = {}): Map<string, ActiveRoleEntry> | null {
    const entries = this.readEntries();
    if (entries === null) return null;
    return this.prune(entries, options);
  }

  /**
   * Read the state file tolerantly and answer its entries, or `null` when
   * nothing usable was read (see {@link parseFile}). Shared by {@link load}
   * and the merge inside every write, so a write can never interpret the file
   * differently from a read. Takes no lock: the write side replaces the file
   * atomically, so an unlocked read always sees a whole file.
   */
  private readEntries(): Map<string, ActiveRoleEntry> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }
    return parseFile(raw);
  }

  /**
   * Resolve the live-session census for a prune call: the per-call override
   * wins over the constructor default, and a provider is invoked fresh.
   * Returns `undefined` when no census is configured (TTL-only eviction).
   */
  private resolveLiveIds(
    options: ActiveRoleStoreOptions,
  ): ReadonlySet<string> | undefined {
    const configured = options.liveSessionIds ?? this.liveSessionIds;
    if (configured === undefined) return undefined;
    let ids: Iterable<string>;
    try {
      ids = typeof configured === "function" ? configured() : configured;
    } catch (err) {
      // A throwing census provider must not fail a load — fall back to TTL-only.
      log.warn("live-session census provider failed; pruning by TTL only", err);
      return undefined;
    }
    return ids instanceof Set ? ids : new Set(ids);
  }

  /**
   * Apply the TTL and session cap in place.
   *
   * An entry is dropped when it is older than `ttlMs` (strictly: kept when
   * `now - updatedAt <= ttlMs`). An `updatedAt` of `0` means "age unknown" (a
   * migrated row with no timestamp) and is never TTL-evicted — only the cap may
   * drop it, so migration stays meaningful. When a live-session census is
   * configured (constructor or per-call `liveSessionIds`), a stale entry whose
   * session is still present in the census is retained: eviction requires the
   * session to be ABSENT from the census AND older than the TTL. This is why a
   * `session/disposed` event must never delete state — a disposed session may
   * still be reloadable, so only the lazy census+TTL pass evicts it.
   *
   * If the survivors exceed `maxSessions`, only the newest `maxSessions` (by
   * `updatedAt`, ties broken by `sessionId`) are kept. Pruning is in-memory
   * only — call {@link save} to persist the result.
   *
   * @param sessions - Map to prune (mutated).
   * @param options  - Per-call overrides for the constructor defaults.
   * @returns The same `sessions` reference, pruned.
   */
  prune(
    sessions: Map<string, ActiveRoleEntry>,
    options: ActiveRoleStoreOptions = {},
  ): Map<string, ActiveRoleEntry> {
    const ttlMs = options.ttlMs ?? this.ttlMs;
    const maxSessions = options.maxSessions ?? this.maxSessions;
    const live = this.resolveLiveIds(options);
    const now = Date.now();

    for (const [sessionId, entry] of sessions) {
      // Age unknown (migrated row) → keep; the cap still bounds growth.
      if (entry.updatedAt <= 0) continue;
      if (now - entry.updatedAt <= ttlMs) continue;
      // Stale. With a census, a session that still exists is retained; without
      // one, TTL alone evicts (the pre-census behaviour).
      if (live !== undefined && live.has(sessionId)) continue;
      sessions.delete(sessionId);
    }

    this.applyCap(sessions, maxSessions);

    return sessions;
  }

  /**
   * Bound a map at `maxSessions`, keeping the newest entries by `updatedAt`
   * (ties broken by `sessionId`, so the result is deterministic). Shared by
   * {@link prune} and the write-time merge, which must not let a merge grow the
   * file past the same cap a load enforces.
   */
  private applyCap(
    sessions: Map<string, ActiveRoleEntry>,
    maxSessions: number,
  ): void {
    if (sessions.size <= maxSessions) return;
    const sorted = [...sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId),
    );
    for (let i = Math.max(0, maxSessions); i < sorted.length; i++) {
      sessions.delete(sorted[i].sessionId);
    }
  }
}
