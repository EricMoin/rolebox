/** Default number of loop iterations when not specified */
export const DEFAULT_ITERATIONS = 5;

/** Hard upper limit on loop iterations to prevent runaway execution */
export const MAX_ITERATIONS_HARD_CAP = 50;

/** Maximum time (ms) allowed for the summarizer to produce a round summary */
export const SUMMARIZER_TIMEOUT_MS = 60_000;

/** Maximum time (ms) allowed for a single loop round to complete */
export const ROUND_TIMEOUT_MS = 900_000;

/** Minimum delay (ms) between consecutive rounds */
export const INTER_ROUND_DELAY_MS = 2_000;

/** Maximum characters of round output fed into the summarizer */
export const SUMMARY_INPUT_CHAR_CAP = 8_000;

/** Current schema version for persisted LoopState records */
export const LOOP_STATE_SCHEMA_VERSION = 1;

/** Marker string used to detect loop-progress signals in session output */
export const LOOP_PROGRESS_MARKER = "[loop-progress";

/** Maximum number of retries when spawning a child session fails */
export const SPAWN_MAX_RETRIES = 2;

/** Base delay (ms) between spawn retries (doubles each attempt) */
export const SPAWN_RETRY_BASE_DELAY_MS = 2_000;

/** Canonical name of the loop function */
export const LOOP_FUNCTION_NAME = "loop";
