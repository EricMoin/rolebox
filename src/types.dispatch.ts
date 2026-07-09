/**
 * Raw dispatch configuration as parsed from role.yaml.
 * Each field is an optional number that, when set, overrides the
 * corresponding DispatchManagerConfig default for this role's sub-agent dispatch.
 */
export interface DispatchRoleConfig {
  /** Maximum concurrent background tasks (dispatch default: 5) */
  maxConcurrent?: number;
  /** Maximum queued tasks per concurrency slot (dispatch default: 10) */
  maxQueueDepth?: number;
  /** Reserved concurrency slots for synchronous dispatch (dispatch default: 1) */
  syncReservedSlots?: number;
  /** Maximum active background tasks per parent session (dispatch default: 3) */
  maxActivePerParent?: number;
  /** Maximum cumulative sessions across all dispatches in a request (undefined = unlimited) */
  maxTotalSessionsPerRequest?: number;
  /** Delay (ms) after a dispatch failure before retry (dispatch default: 30000) */
  retryAfterMs?: number;
  /** Maximum backpressure retry attempts (dispatch default: 5) */
  backpressureMaxRetries?: number;
  /** Maximum cumulative backpressure delay (ms) (dispatch default: 60000) */
  backpressureMaxDelayMs?: number;
  /** Per-task default stale timeout (ms) for background tasks (dispatch default: 900000) */
  backgroundStaleTimeoutMs?: number;
  /** Timeout (ms) to acquire a slot for synchronous dispatch (dispatch default: 120000) */
  syncAcquireTimeoutMs?: number;
  /** Timeout (ms) for sub-agent prompt in sync mode (dispatch default: 600000) */
  syncPromptTimeoutMs?: number;
}
