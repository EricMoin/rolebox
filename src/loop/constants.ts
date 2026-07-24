/** Default number of loop iterations when not specified */
export const DEFAULT_ITERATIONS = 5;

/** Hard upper limit on loop iterations to prevent runaway execution */
export const MAX_ITERATIONS_HARD_CAP = 50;

/** Maximum number of concurrently active tree-worker loop sessions (subtask 3) */
export const MAX_TREE_WORKER_SESSIONS = 30;

/** Maximum time (ms) allowed for a dispatched round to complete (replaces ROUND_TIMEOUT_MS) */
export const DISPATCH_ROUND_TIMEOUT_MS = 900_000;

/** @deprecated Use DISPATCH_ROUND_TIMEOUT_MS instead */
export const ROUND_TIMEOUT_MS = DISPATCH_ROUND_TIMEOUT_MS;

/** Minimum delay (ms) between consecutive rounds */
export const INTER_ROUND_DELAY_MS = 2_000;

/** Maximum characters of round output fed into the summarizer / unified seed */
export const SUMMARY_INPUT_CHAR_CAP = 8_000;

/** Maximum characters of the unified summary prepended as seed to the next round */
export const SEED_CHAR_CAP = 8_000;

/** @deprecated Kept for backward compat with existing tests — will be removed in T14 */
export const SUMMARIZER_TIMEOUT_MS = 60_000;

/** @deprecated Kept for backward compat with existing tests — will be removed in T14 */
export const SPAWN_MAX_RETRIES = 2;

/** @deprecated Kept for backward compat with existing tests — will be removed in T14 */
export const SPAWN_RETRY_BASE_DELAY_MS = 2_000;

/** Current schema version for persisted LoopState records */
export const LOOP_STATE_SCHEMA_VERSION = 3;

/** Marker string used to detect loop-progress signals in session output */
export const LOOP_PROGRESS_MARKER = "[loop-progress";

/** Canonical name of the loop function */
export const LOOP_FUNCTION_NAME = "loop";

/** Canonical name of the loop_start function (subtask 2/4) */
export const LOOP_START_FUNCTION_NAME = "loop_start";

/** Command name registered by the plugin to stop an active loop */
export const STOP_LOOP_COMMAND = "stop-loop";

/** Text injected by the stop-loop command; used by shouldCancelLoop to detect explicit cancellation */
export const STOP_LOOP_SIGNAL = "[rolebox:stop-loop]";

/**
 * Maximum time (ms) a lock in the _advancing Set can be held before the sweeper
 * considers it stale and releases it automatically. Prevents silent deadlock
 * if an exception escapes the try block without the finally block running.
 */
export const ADVANCING_LOCK_TIMEOUT_MS = 30_000;

/** Interval (ms) at which the _advancing sweeper runs to detect stale locks. */
export const SWEEPER_INTERVAL_MS = 15_000;

/**
 * Number of consecutive stale rounds (no progress marker, no output delta)
 * after which the stall guard terminates the loop early (subtask 2).
 */
export const CONSECUTIVE_STALE_THRESHOLD = 2;
