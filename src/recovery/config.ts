/**
 * Configuration parsing and defaults for the rolebox error recovery framework.
 *
 * Provides the default recovery configuration, per-category strategy chains,
 * known strategy name validation, and a recursive config parser that merges
 * raw role.yaml data with role-level defaults.
 *
 * @module recovery/config
 */

import type {
  RecoveryConfig,
  RecoveryErrorCategory,
  RecoveryChainConfig,
  StrategyStep,
} from "./types.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("recovery:config");

// ── Default Configuration ───────────────────────────────────────────────

/**
 * Default recovery configuration applied when no user config is provided.
 *
 * Recovery is enabled by default — error recovery hooks (session_error,
 * edit_error, json_error, context_window, empty_response) activate
 * automatically. Guard hooks (bash_file_read_guard, write_existing_file_guard,
 * etc.) remain opt-in. Users can disable everything with `recovery.enabled: false`.
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  enabled: true,
  maxTotalAttempts: 10,
  persistState: true,
  collectMetrics: true,
  chains: {},
};

// ── Default Chains ──────────────────────────────────────────────────────

/**
 * Default strategy chains for each recoverable error category.
 *
 * These chains are used when a category has no explicit user-defined chain.
 * Each chain is a sequence of strategies that are tried in order until one
 * succeeds or the chain is exhausted.
 */
export const DEFAULT_CHAINS: Partial<Record<RecoveryErrorCategory, RecoveryChainConfig>> = {
  session_error: {
    chain: [
      { strategy: "retry", config: { max_retries: 2, backoff_ms: 2000, backoff_factor: 2 } },
      { strategy: "compact", config: { preserve: ["todos", "artifacts"] } },
      { strategy: "abort", config: { message: "Session failed after all recovery attempts" } },
    ],
  },
  context_window: {
    chain: [
      { strategy: "truncate", config: { target_ratio: 0.5, max_truncations: 8 } },
      { strategy: "summarize", config: {} },
      { strategy: "abort", config: { message: "Context window limit exceeded" } },
    ],
  },
  edit_error: {
    chain: [
      { strategy: "remind_and_retry", config: { max_retries: 2, reminder_text: "[EDIT ERROR] STOP and re-read the file before retrying." } },
    ],
  },
  json_error: {
    chain: [
      { strategy: "remind_and_retry", config: { max_retries: 2, reminder_text: "[JSON PARSE ERROR] Fix your JSON syntax and retry." } },
    ],
  },
  empty_response: {
    chain: [
      { strategy: "remind_and_retry", config: { max_retries: 1, reminder_text: "[EMPTY RESPONSE] Your tool call returned no content. Check and retry." } },
    ],
  },
};

// ── Known Strategy Names ────────────────────────────────────────────────

/**
 * Set of all recognised recovery strategy names.
 *
 * Used for validation during config parsing — unknown strategy names are
 * warned about and skipped to prevent silent misconfiguration.
 */
export const KNOWN_STRATEGIES = new Set([
  "retry",
  "compact",
  "fallback_model",
  "abort",
  "remind_and_retry",
  "truncate",
  "summarize",
]);

// ── Config Parser ───────────────────────────────────────────────────────

/**
 * Parse raw (typically YAML-derived) configuration into a validated
 * {@link RecoveryConfig}.
 *
 * Handles undefined/null input gracefully, falling back to defaults.
 * Warns on unknown strategy names and skips them. Merges role-level
 * defaults after parsing, so role-level overrides take precedence over
 * parsed values and default chains fill in for categories without an
 * explicit user chain.
 *
 * @param raw - Raw configuration object (from role.yaml `recovery:` block)
 * @param roleDefaults - Optional role-level default overrides
 * @returns A fully resolved RecoveryConfig
 */
export function parseRecoveryConfig(
  raw: unknown,
  roleDefaults?: Partial<RecoveryConfig>,
): RecoveryConfig {
  // Handle undefined/null
  if (!raw || typeof raw !== "object") {
    return roleDefaults ? { ...DEFAULT_RECOVERY_CONFIG, ...roleDefaults } : DEFAULT_RECOVERY_CONFIG;
  }

  const obj = raw as Record<string, unknown>;

  const config: RecoveryConfig = {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_RECOVERY_CONFIG.enabled,
    maxTotalAttempts: typeof obj.max_total_attempts === "number"
      ? obj.max_total_attempts
      : DEFAULT_RECOVERY_CONFIG.maxTotalAttempts,
    persistState: typeof obj.persist_state === "boolean"
      ? obj.persist_state
      : DEFAULT_RECOVERY_CONFIG.persistState,
    collectMetrics: typeof obj.collect_metrics === "boolean"
      ? obj.collect_metrics
      : DEFAULT_RECOVERY_CONFIG.collectMetrics,
    chains: {},
  };

  // Parse chain configs for each category
  const categoryKeys: RecoveryErrorCategory[] = [
    "session_error",
    "context_window",
    "edit_error",
    "json_error",
    "empty_response",
    "tool_pair",
    "guard_violation",
  ];

  for (const cat of categoryKeys) {
    const rawChain = obj[cat];
    if (rawChain && typeof rawChain === "object") {
      const chainObj = rawChain as Record<string, unknown>;
      const chain = Array.isArray(chainObj.chain) ? parseChain(chainObj.chain, cat) : [];
      if (chain.length > 0) {
        config.chains[cat] = {
          chain,
          enabled: typeof chainObj.enabled === "boolean" ? chainObj.enabled : true,
        };
      }
    } else if (DEFAULT_CHAINS[cat]) {
      // Use default chain when no user chain is provided for this category
      config.chains[cat] = DEFAULT_CHAINS[cat];
    }
  }

  // Merge with role-level defaults (role defaults take precedence)
  if (roleDefaults) {
    if (roleDefaults.enabled !== undefined) config.enabled = roleDefaults.enabled;
    if (roleDefaults.maxTotalAttempts !== undefined) config.maxTotalAttempts = roleDefaults.maxTotalAttempts;
    if (roleDefaults.persistState !== undefined) config.persistState = roleDefaults.persistState;
    if (roleDefaults.collectMetrics !== undefined) config.collectMetrics = roleDefaults.collectMetrics;
    if (roleDefaults.chains) {
      for (const [cat, chain] of Object.entries(roleDefaults.chains)) {
        if (chain) config.chains[cat as RecoveryErrorCategory] = chain;
      }
    }
  }

  return config;
}

// ── Internal Helpers ────────────────────────────────────────────────────

/**
 * Validate and normalise an array of raw strategy step objects.
 *
 * Unknown strategy names are logged as warnings and skipped.
 *
 * @param steps - Raw array of strategy step objects
 * @param category - The error category for context in warning messages
 * @returns An array of validated StrategyStep objects
 */
function parseChain(steps: unknown[], category: string): StrategyStep[] {
  const result: StrategyStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;
    const strategyName = typeof s.strategy === "string" ? s.strategy : "";
    if (!strategyName) continue;
    if (!KNOWN_STRATEGIES.has(strategyName)) {
      log.warn(`Unknown recovery strategy "${strategyName}" in ${category} chain — skipping`);
      continue;
    }
    result.push({
      strategy: strategyName,
      config: typeof s.config === "object" && s.config !== null
        ? (s.config as Record<string, unknown>)
        : undefined,
    });
  }
  return result;
}

// ── Built-in Flag Merging ───────────────────────────────────────────────

/**
 * Merge multiple built-in hook flag records with left-to-right priority.
 *
 * An explicit `true` in any flag set wins. A `false` only applies when no
 * earlier flag set has explicitly set the key to `true`.
 *
 * This ensures that role-level config overrides can selectively enable
 * built-in hooks without accidentally disabling hooks that were already
 * enabled by a higher-priority source.
 *
 * @param flags - Array of flag records, ordered from lowest to highest priority
 * @returns A single merged flag record
 */
export function mergeBuiltinFlags(
  flags: Record<string, boolean>[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const flagSet of flags) {
    for (const [key, val] of Object.entries(flagSet)) {
      // Explicit true wins unconditionally
      if (val === true) result[key] = true;
      // Only set false if not already true from a higher-priority source
      else if (result[key] !== true) result[key] = false;
    }
  }
  return result;
}
