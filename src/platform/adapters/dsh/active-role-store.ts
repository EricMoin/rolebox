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
 * Behaviour mirrors the house stores:
 *   - atomic writes via `src/function/fs-util.ts` (no torn reads)
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../../../function/fs-util.ts";
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
   * Persist `sessions` atomically. Async writes are serialized through an
   * internal lock; a write failure is logged and swallowed (best-effort).
   */
  async save(sessions: Map<string, ActiveRoleEntry>): Promise<void> {
    this._lock = this._lock.then(
      () => this._doSave(sessions),
      () => this._doSave(sessions),
    );
    return this._lock;
  }

  private async _doSave(sessions: Map<string, ActiveRoleEntry>): Promise<void> {
    try {
      await atomicWrite(this.statePath(), this.toFile(sessions));
    } catch (err) {
      log.warn("ActiveRoleStore._doSave failed", err);
    }
  }

  /** Synchronous variant of {@link save}. Best-effort; failures are logged. */
  saveSync(sessions: Map<string, ActiveRoleEntry>): void {
    try {
      atomicWriteSync(this.statePath(), this.toFile(sessions));
    } catch (err) {
      log.warn("ActiveRoleStore.saveSync failed", err);
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
   * a still-live session from TTL eviction. Pruning is in-memory only — persist
   * the compacted map via {@link save}/{@link saveSync} if compaction on disk
   * is desired.
   *
   * @param options - Per-call prune overrides (TTL, cap, live-session census).
   * @returns A session-keyed map, or `null` when nothing usable was read.
   */
  load(options: ActiveRoleStoreOptions = {}): Map<string, ActiveRoleEntry> | null {
    let raw: string;
    try {
      raw = readFileSync(this.statePath(), "utf-8");
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as FileShape;
      if (!Array.isArray(parsed.sessions)) return null;
      const version = parsed.version;
      if (
        typeof version !== "number" ||
        !Number.isInteger(version) ||
        version < ACTIVE_ROLE_STORE_MIN_VERSION ||
        version > ACTIVE_ROLE_STORE_VERSION
      ) {
        return null;
      }

      const migrating = version < ACTIVE_ROLE_STORE_VERSION;
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
      if (migrating) {
        log.info("Migrated active-role store", {
          fromVersion: version,
          toVersion: ACTIVE_ROLE_STORE_VERSION,
          sessions: out.size,
        });
      }
      return this.prune(out, options);
    } catch {
      return null;
    }
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

    if (sessions.size > maxSessions) {
      const sorted = [...sessions.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId),
      );
      for (let i = Math.max(0, maxSessions); i < sorted.length; i++) {
        sessions.delete(sorted[i].sessionId);
      }
    }

    return sessions;
  }
}
