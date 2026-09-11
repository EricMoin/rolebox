/**
 * Raw dispatch configuration as parsed from role.yaml.
 * Each field is an optional number that, when set, overrides the
 * corresponding DispatchManagerConfig default for this role's sub-agent dispatch.
 */
export interface DispatchRoleConfig {
  /** Per-task default stale timeout (ms) for background tasks (dispatch default: 900000) */
  backgroundStaleTimeoutMs?: number;
  /** Timeout (ms) for sub-agent prompt in sync mode (dispatch default: 600000) */
  syncPromptTimeoutMs?: number;
}
