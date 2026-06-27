/**
 * Centralized configuration constants for the dispatch subsystem.
 * This is the single source of truth — all other files import from here.
 */

// ── Timing constants ────────────────────────────────────────────────

/** Task TTL (30 min): how long completed/failed task records live before cleanup.
 *  LIVE — read by manager.ts:758,1126 */
export const TASK_TTL_MS = 1_800_000;

/** Minimum runtime (5 s): a task must exist at least this long before it can be reaped.
 *  LIVE — read by manager.ts:898 */
export const MIN_RUNTIME_MS = 5_000;

/** Default max concurrent background tasks.
 *  LIVE — read by manager.ts constructor (maxConcurrent) */
export const DEFAULT_MAX_CONCURRENT = 5;

/** Default max queued tasks per concurrency slot (2× maxConcurrent).
 *  LIVE — imported by manager.ts:10 */
export const DEFAULT_MAX_QUEUE_DEPTH = 10;

/** Default number of reserved slots for synchronous dispatch per concurrency key.
 *  LIVE — imported by manager.ts:10 */
export const DEFAULT_SYNC_RESERVED_SLOTS = 1;

/** Sync timeout (10 min): max wall-clock time for synchronous executeSync prompts.
 *  LIVE — imported by manager.ts:10 */
export const SYNC_TIMEOUT_MS = 600_000;

/** Background default stale timeout (15 min): per-task default when no explicit timeout_ms is set.
 *  More aggressive than the old global staleTimeoutMs (45 min) to prevent background tasks from
 *  holding resources too long.
 *  LIVE — imported by manager.ts:10 */
export const BACKGROUND_STALE_TIMEOUT_MS = 900_000;

/** Minimum consecutive idle polls before marking a task as stable / complete.
 *  LIVE — referenced by completion-detector.ts:53 (doc comment) */
export const MIN_STABILITY_POLLS = 2;

/** Per-task reconcile watchdog interval (15 s): max event silence before a one-shot reconcile.
 *  LIVE — imported by manager.ts:10, watchdog.test.ts:4 */
export const WATCHDOG_INTERVAL_MS = 15_000;

/** Global sweep interval (30 s): safety-net pass over all running tasks for missed events / crash recovery.
 *  LIVE — imported by manager.ts:10, watchdog.test.ts:5 */
export const GLOBAL_SWEEP_INTERVAL_MS = 30_000;

/** Idle debounce (1.5 s): wait after a validated session.idle before confirming completion, to absorb between-step idles.
 *  LIVE — imported by manager.ts:10, watchdog.test.ts:6 */
export const IDLE_DEBOUNCE_MS = 1_500;

/** Default max active background tasks per parent session.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_MAX_ACTIVE_PER_PARENT = 3;

/** Delay (ms) after a task dispatch failure before the caller may retry.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_RETRY_AFTER_MS = 30_000;

/** Default max backpressure retry attempts before giving up.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_BACKPRESSURE_MAX_RETRIES = 5;

/** Default max backpressure delay (ms) before giving up.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 60_000;

/** Default acquire timeout (ms) for synchronous dispatch.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS = 120_000;

/** Default prompt timeout (ms) for synchronous dispatch.
 *  LIVE — consumed by manager.ts (Task 12) */
export const DEFAULT_SYNC_PROMPT_TIMEOUT_MS = 600_000;

/** Timeout (ms) for materializing a sub-agent result fetch — default: 10 s */
export const MATERIALIZE_TIMEOUT_MS = 10_000;

/** Result retention (ms): how long sidecar result files are kept after task cleanup — default: 1 h */
export const RESULT_RETENTION_MS = 3_600_000;

/** Outbox sweeper initial retry delay (ms) — default: 3 s */
export const OUTBOX_FIRST_RETRY_MS = 3_000;

/** Outbox sweeper max retry delay (ms) — default: 60 s */
export const OUTBOX_MAX_RETRY_MS = 60_000;

/** Outbox sweeper polling interval (ms) — default: 5 s */
export const OUTBOX_SWEEP_INTERVAL_MS = 5_000;

// ── Configuration interface ─────────────────────────────────────────

/**
 * Configurable limits and intervals for the dispatch manager.
 *
 * New fields are marked optional (`?:`) to preserve backward compatibility
 * with existing call sites that construct partial configs.
 */
export interface DispatchManagerConfig {
  /** Maximum number of concurrent background tasks — default: 5 */
  maxConcurrent: number;
  /** Maximum queued tasks waiting per concurrency slot — default: 10 */
  maxQueueDepth?: number;
  /** Maximum active background tasks per parent session — default: 3 */
  maxActivePerParent?: number;
  /** Time-to-live (ms) for completed task records before cleanup — default: 30 minutes */
  taskTtlMs: number;
  /** Minimum wall-clock time (ms) before a task can be reaped — default: 5000 */
  minRuntimeMs: number;
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

  /** @deprecated Use syncAcquireTimeoutMs and syncPromptTimeoutMs instead.
   *  Timeout (ms) for synchronous executeSync prompts — default: 600000 (10 min). */
  syncTimeoutMs?: number;
  /** Timeout (ms) to acquire a slot for synchronous dispatch — default: 120000 (2 min) */
  syncAcquireTimeoutMs?: number;
  /** Timeout (ms) for the sub-agent prompt to complete in sync mode — default: 600000 (10 min) */
  syncPromptTimeoutMs?: number;

  /** Delay (ms) after a dispatch failure before the caller may retry — default: 30000 */
  retryAfterMs: number;
  /** Max retry attempts under backpressure before giving up — default: 5 */
  backpressureMaxRetries?: number;
  /** Max cumulative delay (ms) under backpressure before giving up — default: 60000 */
  backpressureMaxDelayMs?: number;

  /** Timeout (ms) for materializing a sub-agent result fetch — default: 10000 */
  materializeTimeoutMs?: number;
  /** How long (ms) sidecar result files are kept after task cleanup — default: 3600000 */
  resultRetentionMs?: number;
  /** Outbox sweeper initial retry delay (ms) — default: 3000 */
  outboxFirstRetryMs?: number;
  /** Outbox sweeper max retry delay (ms) — default: 60000 */
  outboxMaxRetryMs?: number;
  /** Outbox sweeper polling interval (ms) — default: 5000 */
  outboxSweepIntervalMs?: number;
}

// ── Default configuration ───────────────────────────────────────────

export const DEFAULT_CONFIG: DispatchManagerConfig = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  maxQueueDepth: DEFAULT_MAX_QUEUE_DEPTH,
  maxActivePerParent: DEFAULT_MAX_ACTIVE_PER_PARENT,
  taskTtlMs: TASK_TTL_MS,
  minRuntimeMs: MIN_RUNTIME_MS,
  syncReservedSlots: DEFAULT_SYNC_RESERVED_SLOTS,
  backgroundStaleTimeoutMs: BACKGROUND_STALE_TIMEOUT_MS,
  watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
  globalSweepIntervalMs: GLOBAL_SWEEP_INTERVAL_MS,
  idleDebounceMs: IDLE_DEBOUNCE_MS,
  syncTimeoutMs: SYNC_TIMEOUT_MS,
  syncAcquireTimeoutMs: DEFAULT_SYNC_ACQUIRE_TIMEOUT_MS,
  syncPromptTimeoutMs: DEFAULT_SYNC_PROMPT_TIMEOUT_MS,
  retryAfterMs: DEFAULT_RETRY_AFTER_MS,
  backpressureMaxRetries: DEFAULT_BACKPRESSURE_MAX_RETRIES,
  backpressureMaxDelayMs: DEFAULT_BACKPRESSURE_MAX_DELAY_MS,

  materializeTimeoutMs: MATERIALIZE_TIMEOUT_MS,
  resultRetentionMs: RESULT_RETENTION_MS,
  outboxFirstRetryMs: OUTBOX_FIRST_RETRY_MS,
  outboxMaxRetryMs: OUTBOX_MAX_RETRY_MS,
  outboxSweepIntervalMs: OUTBOX_SWEEP_INTERVAL_MS,
};

// ── Environment variable resolution ─────────────────────────────────

/**
 * Reads dispatch configuration from environment variables.
 * Only returns keys that are explicitly set and parse to positive numbers.
 * NaN, ≤0, and empty-string values are silently ignored.
 */
export function resolveEnvConfig(): Partial<DispatchManagerConfig> {
  const result: Partial<DispatchManagerConfig> = {};

  const intEnv = (key: string): number | undefined => {
    const raw = process.env[key];
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (Number.isNaN(n) || n <= 0) return undefined;
    return n;
  };

  const mc = intEnv("ROLEBOX_DISPATCH_MAX_CONCURRENT");
  if (mc !== undefined) result.maxConcurrent = mc;

  const mqd = intEnv("ROLEBOX_DISPATCH_MAX_QUEUE_DEPTH");
  if (mqd !== undefined) result.maxQueueDepth = mqd;

  const sr = intEnv("ROLEBOX_DISPATCH_SYNC_RESERVED");
  if (sr !== undefined) result.syncReservedSlots = sr;

  const map = intEnv("ROLEBOX_DISPATCH_MAX_ACTIVE_PER_PARENT");
  if (map !== undefined) result.maxActivePerParent = map;

  const ra = intEnv("ROLEBOX_DISPATCH_RETRY_AFTER_MS");
  if (ra !== undefined) result.retryAfterMs = ra;

  const bs = intEnv("ROLEBOX_DISPATCH_BG_STALE_MS");
  if (bs !== undefined) result.backgroundStaleTimeoutMs = bs;

  const mt = intEnv("ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS");
  if (mt !== undefined) result.materializeTimeoutMs = mt;

  const rr = intEnv("ROLEBOX_DISPATCH_RESULT_RETENTION_MS");
  if (rr !== undefined) result.resultRetentionMs = rr;

  return result;
}

// ── Config merging ──────────────────────────────────────────────────

/**
 * Merge dispatch configuration with precedence: env > roleConfig > base.
 *
 * @param base       Base configuration (e.g. DEFAULT_CONFIG)
 * @param roleCfg    Optional role-level overrides (from role.yaml `dispatch:` block)
 * @param envCfg     Optional environment-level overrides (from resolveEnvConfig())
 * @returns          Merged DispatchManagerConfig
 */
export function mergeConfig(
  base: DispatchManagerConfig,
  roleCfg?: Partial<DispatchManagerConfig>,
  envCfg?: Partial<DispatchManagerConfig>,
): DispatchManagerConfig {
  return {
    ...base,
    ...roleCfg,
    ...envCfg,
  };
}
