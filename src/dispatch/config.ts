/**
 * Centralized configuration constants for the dispatch subsystem.
 * This is the single source of truth — all other files import from here.
 */

// ── Timing constants ────────────────────────────────────────────────

/** Default stale timeout (45 min): max wall-clock idle before a task is considered hung. */
export const DEFAULT_STALE_TIMEOUT_MS = 2_700_000;

/** Task TTL (30 min): how long completed/failed task records live before cleanup. */
export const TASK_TTL_MS = 1_800_000;

/** Default poll interval (3 s): gap between status-polling heartbeats. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Minimum runtime (5 s): a task must exist at least this long before it can be reaped. */
export const MIN_RUNTIME_MS = 5_000;

/** Default max concurrent background tasks. */
export const DEFAULT_MAX_CONCURRENT = 5;

/** Default max queued tasks per concurrency slot (2× maxConcurrent). */
export const DEFAULT_MAX_QUEUE_DEPTH = 10;

/** Default number of reserved slots for synchronous dispatch per concurrency key. */
export const DEFAULT_SYNC_RESERVED_SLOTS = 1;

/** Session-gone timeout (1 min): time without any status before we declare a session missing. */
export const SESSION_GONE_TIMEOUT_MS = 60_000;

/** Message staleness timeout (60 min): time without any assistant output before declaring dead. */
export const MESSAGE_STALENESS_TIMEOUT_MS = 3_600_000;

/** Sync timeout (10 min): max wall-clock time for synchronous executeSync prompts. */
export const SYNC_TIMEOUT_MS = 600_000;

/** Background default stale timeout (15 min): per-task default when no explicit timeout_ms is set.
 *  More aggressive than the global staleTimeoutMs (45 min) to prevent background tasks from
 *  holding resources too long. */
export const BACKGROUND_STALE_TIMEOUT_MS = 900_000;

/** Minimum consecutive idle polls before marking a task as stable / complete. */
export const MIN_STABILITY_POLLS = 2;

/** Minimum consecutive polls with no status before triggering an existence check. */
export const MIN_SESSION_GONE_POLLS = 3;

/** Absolute minimum poll interval (500 ms) to prevent tight-looping. */
export const MIN_POLL_INTERVAL_MS = 500;

/** Absolute maximum poll interval (5 s) to prevent polling too infrequently. */
export const MAX_POLL_INTERVAL_MS = 5_000;

/** Per-task reconcile watchdog interval (15 s): max event silence before a one-shot reconcile. */
export const WATCHDOG_INTERVAL_MS = 15_000;

/** Global sweep interval (30 s): safety-net pass over all running tasks for missed events / crash recovery. */
export const GLOBAL_SWEEP_INTERVAL_MS = 30_000;

/** Idle debounce (1.5 s): wait after a validated session.idle before confirming completion, to absorb between-step idles. */
export const IDLE_DEBOUNCE_MS = 1_500;

/** Terminal task TTL (30 min): how long a terminal-state task record lives before eviction. */
export const TERMINAL_TASK_TTL_MS = 1_800_000;

// ── Configuration interface ─────────────────────────────────────────

/**
 * Configurable limits and intervals for the dispatch manager.
 * These control polling frequency, timeouts, concurrency, and cleanup.
 *
 * New fields are marked optional (`?:`) to preserve backward compatibility
 * with existing call sites that construct partial configs.
 */
export interface DispatchManagerConfig {
  /** Interval (ms) between status-polling heartbeats — default: 3000 */
  pollIntervalMs: number;
  /** Maximum wall-clock time (ms) before a running task is considered stale — default: 45 minutes */
  staleTimeoutMs: number;
  /** Minimum wall-clock time (ms) before a task can be reaped — default: 5000 */
  minRuntimeMs: number;
  /** Maximum number of concurrent background tasks — default: 5 */
  maxConcurrent: number;
  /** Maximum queued tasks waiting per concurrency slot — default: 10 */
  maxQueueDepth?: number;
  /** Time-to-live (ms) for completed task records before cleanup — default: 30 minutes */
  taskTtlMs: number;
  // ── New optional fields ───────────────────────────────────────────
  /** Timeout (ms) for detecting a missing session — default: 60000 (1 min) */
  sessionGoneTimeoutMs?: number;
  /** Staleness timeout (ms) for sessions that never produced output — default: 3600000 (60 min) */
  messageStalenessTimeoutMs?: number;
  /** Timeout (ms) for synchronous executeSync prompts — default: 600000 (10 min) */
  syncTimeoutMs?: number;
  /** Consecutive idle polls before marking task stable — default: 3 */
  minStabilityPolls?: number;
  /** Consecutive polls with no status before existence check — default: 3 */
  minSessionGonePolls?: number;
  /** Minimum allowed poll interval (ms) — default: 500 */
  minPollIntervalMs?: number;
  /** Maximum allowed poll interval (ms) — default: 5000 */
  maxPollIntervalMs?: number;
  /** Number of concurrency slots reserved for synchronous dispatch per key — default: 1 */
  syncReservedSlots?: number;
  /** Per-task default stale timeout (ms) for background tasks — default: 900000 (15 min) */
  backgroundStaleTimeoutMs?: number;
  /** Watchdog reconcile interval (ms) — default: 15000 (15 s) */
  watchdogIntervalMs?: number;
  /** Global sweep interval (ms) — default: 30000 (30 s) */
  globalSweepIntervalMs?: number;
  /** Idle debounce delay (ms) — default: 1500 (1.5 s) */
  idleDebounceMs?: number;
}

// ── Default configuration ───────────────────────────────────────────

export const DEFAULT_CONFIG: DispatchManagerConfig = {
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  staleTimeoutMs: DEFAULT_STALE_TIMEOUT_MS,
  minRuntimeMs: MIN_RUNTIME_MS,
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  maxQueueDepth: DEFAULT_MAX_QUEUE_DEPTH,
  taskTtlMs: TASK_TTL_MS,
  sessionGoneTimeoutMs: SESSION_GONE_TIMEOUT_MS,
  messageStalenessTimeoutMs: MESSAGE_STALENESS_TIMEOUT_MS,
  syncTimeoutMs: SYNC_TIMEOUT_MS,
  minStabilityPolls: MIN_STABILITY_POLLS,
  minSessionGonePolls: MIN_SESSION_GONE_POLLS,
  minPollIntervalMs: MIN_POLL_INTERVAL_MS,
  maxPollIntervalMs: MAX_POLL_INTERVAL_MS,
  syncReservedSlots: DEFAULT_SYNC_RESERVED_SLOTS,
  backgroundStaleTimeoutMs: BACKGROUND_STALE_TIMEOUT_MS,
  watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
  globalSweepIntervalMs: GLOBAL_SWEEP_INTERVAL_MS,
  idleDebounceMs: IDLE_DEBOUNCE_MS,
};
