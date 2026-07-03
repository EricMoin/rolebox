/**
 * Core type definitions for the rolebox error recovery framework.
 *
 * The recovery system intercepts common failure modes (session errors,
 * context window limits, edit failures, JSON parse errors, empty responses,
 * tool pair issues, and guard violations) and runs configurable strategy
 * chains to recover automatically. Each error category maps to a chain of
 * strategies (retry, compact, truncate, summarise, abort, etc.) that are
 * executed in order until one succeeds or the chain is exhausted.
 *
 * @module recovery/types
 */

// ── Error Categories ────────────────────────────────────────────────────

/**
 * Categories of recoverable errors that the recovery framework can handle.
 *
 * Each category maps to a configurable strategy chain.
 *
 * - `session_error`: The agent session encountered an unrecoverable failure
 *   (timeout, crash, unexpected termination).
 * - `context_window`: The model's context window is full or near-full.
 * - `edit_error`: A file edit operation failed (write conflict, stale
 *   content, permission denied).
 * - `json_error`: A JSON parse error occurred in tool output or response.
 * - `empty_response`: A tool call or model response returned empty content.
 * - `tool_pair`: A paired tool invocation failed (e.g. read+write sequence
 *   where the read succeeded but the write failed).
 * - `guard_violation`: A safety or validation guard was triggered.
 */
export type RecoveryErrorCategory =
  | "session_error"
  | "context_window"
  | "edit_error"
  | "json_error"
  | "empty_response"
  | "tool_pair"
  | "guard_violation";

// ── Error Detection & Attempt Recording ─────────────────────────────────

/**
 * A detected error ready for recovery processing.
 *
 * Created by an {@link ErrorPattern} matcher when it recognises a specific
 * failure signature in raw tool output, model response, or system state.
 */
export interface RecoveryError {
  /** The high-level error category used to select the strategy chain */
  category: RecoveryErrorCategory;
  /** Provider- or system-specific error type string (e.g. "ContextLengthExceeded", "ETIMEDOUT") */
  errorType: string;
  /** Human-readable description of what went wrong */
  message: string;
  /** The raw error payload (tool output, exception object, etc.) for diagnostic use */
  raw?: unknown;
  /** Epoch milliseconds when the error was detected */
  timestamp: number;
}

/**
 * A recorded recovery attempt for persistence and metrics.
 *
 * Persisted as part of {@link RecoveryState} so that across restarts or
 * session transitions the system can reason about prior attempts.
 */
export interface RecoveryAttempt {
  /** The error category this attempt is addressing */
  category: RecoveryErrorCategory;
  /** Provider- or system-specific error type */
  errorType: string;
  /** Epoch milliseconds when the attempt was made */
  timestamp: number;
  /** Position in the strategy chain (0-based index) */
  chainPosition: number;
  /** Name of the strategy that was executed */
  strategy: string;
  /** Outcome of this attempt */
  result: "success" | "retry" | "next_strategy" | "abort";
  /** Optional descriptive message about the outcome */
  message?: string;
}

// ── Strategy Chain Configuration ────────────────────────────────────────

/**
 * A single step in a recovery strategy chain.
 *
 * Each step names a strategy (e.g. "retry", "compact", "truncate", "abort")
 * and an optional configuration block that the strategy implementation reads
 * at runtime.
 */
export interface StrategyStep {
  /** Strategy name — must be one of the known strategy identifiers */
  strategy: string;
  /** Strategy-specific configuration passed to the executor */
  config?: Record<string, unknown>;
}

/**
 * Chain configuration for a specific error category.
 *
 * Defines the ordered list of recovery strategies to attempt, plus an
 * optional enabled flag so individual chains can be toggled on or off.
 */
export interface RecoveryChainConfig {
  /** Ordered list of strategy steps to execute */
  chain: StrategyStep[];
  /** Whether this chain is active (defaults to true when a chain is present) */
  enabled?: boolean;
}

/**
 * Full recovery configuration for a role or session.
 *
 * Controls global recovery behaviour (enabled/disabled, attempt limits,
 * persistence, metrics collection) and per-category strategy chains.
 */
export interface RecoveryConfig {
  /** Master switch — when false, no recovery strategies run */
  enabled: boolean;
  /** Hard cap on total recovery attempts across all categories for a session */
  maxTotalAttempts: number;
  /** Whether to persist recovery state to disk (via RecoveryState) */
  persistState: boolean;
  /** Whether to collect recovery metrics (counts, success rates, etc.) */
  collectMetrics: boolean;
  /** Per-category strategy chains — categories without a chain get no recovery */
  chains: Partial<Record<RecoveryErrorCategory, RecoveryChainConfig>>;
}

// ── Session State Persistence ───────────────────────────────────────────

/**
 * Per-session recovery state persisted to disk.
 *
 * Used by {@link RecoveryConfig.persistState} to survive restarts and
 * provide continuity across the session lifecycle.
 */
export interface RecoveryState {
  /** Unique identifier for the session this state belongs to */
  sessionID: string;
  /** All recovery attempts recorded so far in this session */
  attempts: RecoveryAttempt[];
  /** Currently active (in-flight) chains keyed by category */
  activeChains: Record<string, {
    /** Index of the current step being executed (0-based) */
    currentStep: number;
    /** Epoch milliseconds when this chain started */
    startTime: number;
    /** Total attempts across all steps in this chain */
    totalAttempts: number;
  }>;
  /** Snapshot of cumulative recovery metrics at time of persistence */
  metrics: RecoveryMetricsSnapshot;
}

/**
 * Snapshot of cumulative recovery metrics.
 *
 * Captured at persistence time and used for telemetry, logging, and
 * post-session analysis.
 */
export interface RecoveryMetricsSnapshot {
  /** Total recovery attempts across all categories */
  totalAttempts: number;
  /** Total successful recoveries */
  successfulRecoveries: number;
  /** Total chains that ended with abort */
  abortedChains: number;
  /** Total chains that exhausted all strategies without success */
  exhaustedChains: number;
  /** Per-category breakdown of attempts and successes */
  byCategory: Record<string, { attempts: number; successes: number }>;
  /** Per-strategy breakdown of attempts and successes */
  byStrategy: Record<string, { attempts: number; successes: number }>;
  /** Absolute frequency of each distinct error type string */
  errorTypeFrequency: Record<string, number>;
}

// ── Error Pattern Matching ──────────────────────────────────────────────

/**
 * A provider-agnostic error pattern that can match errors from any source
 * (model response, tool output, system exception) and produce a structured
 * {@link RecoveryError}.
 *
 * Implementations are registered with the recovery manager and checked in
 * order when an error is detected.
 */
export interface ErrorPattern {
  /** Human-readable name for this pattern (for logging and metrics) */
  name: string;
  /** The error category this pattern produces */
  category: RecoveryErrorCategory;
  /**
   * Match function invoked with the raw error value.
   * Returns a structured RecoveryError when the pattern matches, or null
   * when it does not.
   */
  match: (error: unknown) => RecoveryError | null;
}

// ── Strategy Execution ──────────────────────────────────────────────────

/**
 * Context object passed to every recovery strategy execution.
 *
 * Provides the strategy with session context, the detected error, chain
 * state, and an injection mechanism for appending text to the next system
 * prompt.
 */
export interface RecoveryStrategyContext {
  /** The session identifier where recovery is taking place */
  sessionID: string;
  /** The structured error being recovered from */
  error: RecoveryError;
  /** The attempt number within the current strategy (1-based) */
  attempt: number;
  /** The configuration block from the current strategy step */
  stepConfig: Record<string, unknown>;
  /**
   * Append text to the next system prompt.
   * Uses the same mechanism as hook `inject()` — useful for reminders,
   * corrections, or instructions to the model during recovery.
   */
  inject: (text: string) => void;
  /**
   * The opencode plugin client instance.
   * Kept as `unknown` to avoid circular dependency on plugin types.
   */
  client?: unknown;
}

/**
 * The result of executing a recovery strategy.
 *
 * A discriminated union with four possible statuses:
 *
 * - `success`: Recovery succeeded — no further strategies needed.
 * - `retry`: The strategy should be re-executed (optionally after a delay).
 * - `next_strategy`: Move to the next strategy in the chain.
 * - `abort`: Give up on recovery entirely.
 */
export type RecoveryStrategyResult =
  | { status: "success"; message?: string }
  | { status: "retry"; delayMs?: number; reason: string }
  | { status: "next_strategy"; reason: string }
  | { status: "abort"; reason: string };

/**
 * Interface for pluggable recovery strategies.
 *
 * Strategies are registered by name and looked up during chain execution.
 * Built-in strategies include: retry, compact, truncate, summarise,
 * remind_and_retry, fallback_model, and abort.
 */
export interface RecoveryStrategy {
  /** Unique name matching the `strategy` field in StrategyStep */
  readonly name: string;
  /** Execute this strategy against the given context and return a result */
  execute(ctx: RecoveryStrategyContext): Promise<RecoveryStrategyResult>;
}

// ── Built-In Hook Definitions (TypeScript-Native) ───────────────────────

/**
 * A built-in hook definition that is compiled into the plugin (not loaded
 * from a file). Built-in hooks are declared in the `hooks.builtin` config
 * block and can be enabled or disabled individually.
 *
 * Unlike custom hooks (which load an external module), built-in hooks are
 * defined entirely in TypeScript and registered at startup.
 */
export interface BuiltInHookDefinition {
  /** Unique hook name (matches the config key in hooks.builtin) */
  name: string;
  /** The config key used in hooks.builtin to enable/disable this hook */
  configKey: string;
  /** Lifecycle events this hook listens to */
  events: string[];
  /** Whether it fires before or after built-in handlers */
  phase: "before" | "after";
  /** Execution priority (lower = earlier within its phase) */
  priority: number;
  /** The module object with handler methods */
  module: {
    onChatMessage?: (ctx: unknown, input: { text: string }) => void | Promise<void>;
    onToolBefore?: (ctx: unknown, input: { tool: string; args: unknown }) => void | Promise<void>;
    onToolAfter?: (ctx: unknown, input: { tool: string; args: unknown; output: unknown }) => void | Promise<void>;
    onSystemTransform?: (ctx: unknown, input: { system: string[] }) => void | Promise<void>;
    onEvent?: (ctx: unknown, input: { type: string; properties?: Record<string, unknown> }) => void | Promise<void>;
  };
  /** Optional filters to limit which tools or event types trigger this hook */
  filter?: {
    /** Only fire for these tool names */
    tools?: string[];
    /** Only fire for these event subtypes */
    eventTypes?: string[];
  };
}
