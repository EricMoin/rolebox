/**
 * Persistence layer for per-session recovery state.
 *
 * {@link RecoveryStateStore} manages on-disk recovery state files in the
 * project's `.rolebox/state/` directory — the same location used by the loop,
 * dispatch, and graph stores. Each session gets its own file keyed by session
 * ID (`recovery-${sessionID}.json`).
 *
 * Writes use the same atomic-file pattern as {@link LoopStore} (via
 * `atomicWrite` / `atomicWriteSync`) so readers never observe partially
 * written state.
 *
 * @module recovery/state
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "../function/fs-util.ts";
import { stateDirFor } from "../utils/state-paths.ts";
import { createSubLogger } from "../logger.ts";
import type { RecoveryState, RecoveryAttempt } from "./types.ts";

const log = createSubLogger("recovery:state");

/**
 * File-backed store for per-session recovery state.
 *
 * Supports both async fire-and-forget writes (`save`) and synchronous writes
 * (`saveSync`) for use during shutdown or critical sections where the async
 * path may not have flushed yet. A dirty-map tracks pending async writes and
 * can be drained via `flushSync`.
 */
export class RecoveryStateStore {
  private workspaceDir: string;
  private dirty: Map<string, RecoveryState> = new Map();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** Resolve the on-disk path for a given session's recovery state file. */
  private filePath(sessionID: string): string {
    return join(stateDirFor(this.workspaceDir), `recovery-${sessionID}.json`);
  }

  /**
   * Load recovery state for a session from disk.
   *
   * Returns `null` when no state file exists or when the file cannot be
   * parsed — the caller treats this as "no prior recovery state".
   */
  load(sessionID: string): RecoveryState | null {
    try {
      const fp = this.filePath(sessionID);
      if (!existsSync(fp)) return null;
      const data = readFileSync(fp, "utf-8");
      return JSON.parse(data) as RecoveryState;
    } catch (err) {
      log.debug("Failed to load recovery state", { sessionID, err });
      return null;
    }
  }

  /**
   * Persist recovery state asynchronously (fire-and-forget).
   *
   * The write is recorded in the dirty map and scheduled. Callers that need
   * guarantees about durability before proceeding should use {@link saveSync}
   * or {@link flushSync}.
   */
  save(sessionID: string, state: RecoveryState): void {
    this.dirty.set(sessionID, state);
    void this.writeAsync(sessionID, state);
  }

  /** Internal async writer — swallows errors and logs them. */
  private async writeAsync(sessionID: string, state: RecoveryState): Promise<void> {
    try {
      await atomicWrite(this.filePath(sessionID), JSON.stringify(state, null, 2));
      this.dirty.delete(sessionID);
    } catch (err) {
      log.debug("Failed to save recovery state", { sessionID, err });
    }
  }

  /**
   * Persist recovery state synchronously.
   *
   * Guarantees the file is on disk before returning. Use during shutdown,
   * process-exit handlers, or critical-path sections where an incomplete
   * write would corrupt recovery continuity.
   */
  saveSync(sessionID: string, state: RecoveryState): void {
    try {
      atomicWriteSync(this.filePath(sessionID), JSON.stringify(state, null, 2));
    } catch (err) {
      log.debug("Failed to saveSync recovery state", { sessionID, err });
    }
  }

  /**
   * Record a single recovery attempt and persist the updated state.
   *
   * Automatically deduplicates: if an attempt with the same `timestamp` and
   * `strategy` already exists in the loaded state, it is not added again.
   * This prevents double-counting when `recordAttempt` is called multiple
   * times for the same logical event (e.g. after a restart before the async
   * write completed).
   *
   * When no prior state exists for the session, creates a fresh state
   * skeleton with zeroed metrics.
   */
  recordAttempt(sessionID: string, attempt: RecoveryAttempt): void {
    const existing = this.load(sessionID) ?? {
      sessionID,
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };

    const isDuplicate = existing.attempts.some(
      (a) => a.timestamp === attempt.timestamp && a.strategy === attempt.strategy,
    );
    if (!isDuplicate) {
      existing.attempts.push(attempt);
    }
    this.save(sessionID, existing);
  }

  /**
   * Update the state of an active recovery chain in-place.
   *
   * Merges the provided fields into the chain's current state, creating the
   * chain entry if it does not yet exist. The full state is persisted after
   * each update.
   */
  updateChainState(
    sessionID: string,
    chainKey: string,
    update: { currentStep?: number; startTime?: number; totalAttempts?: number },
  ): void {
    const existing = this.load(sessionID) ?? {
      sessionID,
      attempts: [],
      activeChains: {},
      metrics: {
        totalAttempts: 0,
        successfulRecoveries: 0,
        abortedChains: 0,
        exhaustedChains: 0,
        byCategory: {},
        byStrategy: {},
        errorTypeFrequency: {},
      },
    };
    const current = existing.activeChains[chainKey] ?? {
      currentStep: 0,
      startTime: Date.now(),
      totalAttempts: 0,
    };
    existing.activeChains[chainKey] = { ...current, ...update };
    this.save(sessionID, existing);
  }

  /**
   * Remove the recovery state file for a session from disk.
   *
   * Silently succeeds when no file exists. The dirty map is also cleaned up
   * to prevent stale async writes from recreating the file.
   */
  delete(sessionID: string): void {
    this.dirty.delete(sessionID);
    try {
      const fp = this.filePath(sessionID);
      if (existsSync(fp)) unlinkSync(fp);
    } catch {
      // Silently ignore — nothing to clean up
    }
  }

  /**
   * Drain all pending async writes synchronously.
   *
   * Call before shutdown, process-exit, or any point where in-flight async
   * writes must not be lost. After this call the dirty map is empty.
   */
  flushSync(): void {
    for (const [sessionID, state] of this.dirty) {
      this.saveSync(sessionID, state);
    }
    this.dirty.clear();
  }

  /**
   * Load all persisted recovery states from disk.
   *
   * Because recovery state files are discovered per-session ID via explicit
   * calls to {@link load}, this method is primarily a hook for startup
   * recovery where the set of known session IDs is provided externally.
   *
   * Currently returns an empty map — callers should use {@link load} per
   * session ID instead.
   */
  loadAll(): Map<string, RecoveryState> {
    return new Map();
  }
}
