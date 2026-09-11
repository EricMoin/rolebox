import type { CondEnv } from "../function/conditions.ts";
import type { ObserveSpec } from "../types.ts";

/**
 * Read-only, scoped capability for custom condition handlers.
 * Exposes a minimal surface instead of the full CondEnv.
 * No write access to state.kv, artifacts, or internal arrays.
 */
export interface ConditionCapability {
  /** Session identifier. */
  readonly sessionID: string;
  /** Function name being evaluated. */
  readonly fnName: string;
  /** Whether the user sent a message this turn. */
  isUserMessagedThisTurn(): boolean;
  /** Count of unchecked todo items (- [ ]) in the session plan. */
  getTodosRemaining(): number;
  /** Whether a named artifact exists and has content. */
  artifactExists(name: string): boolean;
  /** Whether all required evidence tags are met. */
  isEvidenceMet(evidence: string[]): boolean;
  /** Whether a specific tool was observed this session. */
  wasToolObserved(toolName: string): boolean;
  /** Number of turns since this function was activated. */
  getTurnsSinceActivation(): number;
  /** Read a single value from runtime KV store (read-only). Returns undefined if missing. */
  getStateValue(key: string): string | undefined;
}

/**
 * Typed, minimal capability for custom observe event handlers.
 * Carries only the context relevant to the event.
 */
export interface ObserveCapability {
  /** Session identifier. */
  readonly sessionID: string;
  /** Event name that triggered this handler. */
  readonly eventName: string;
  /** Tool name, if the event originated from a tool call. */
  readonly toolName?: string;
  /** Arguments passed to the tool, if applicable. */
  readonly toolArgs?: unknown;
  /** Output produced by the tool, if applicable. */
  readonly toolOutput?: unknown;
  /** Last assistant text before the event fired. */
  readonly lastAssistantText?: string;
}

/** Wrap a raw CondEnv into a read-only ConditionCapability. */
export function wrapConditionCapability(env: CondEnv): ConditionCapability {
  return {
    sessionID: env.sessionID,
    fnName: env.fnName,
    isUserMessagedThisTurn: () => env.userMessagedThisTurn,
    getTodosRemaining: () => {
      const blob =
        (env.state.kv["__todos"] as string) ??
        env.artifacts.read(env.sessionID, "plan") ??
        "";
      const m = blob.match(/- \[ \]/g);
      return m ? m.length : 0;
    },
    artifactExists: (name: string) => env.artifacts.exists(env.sessionID, name),
    isEvidenceMet: (evidence: string[]) =>
      env.requiredEvidence.every(
        (t) => env.state.evidenceObserved[t] === true,
      ),
    wasToolObserved: (toolName: string) =>
      env.state.toolsObserved.includes(toolName),
    getTurnsSinceActivation: () =>
      env.state.currentTurn - env.state.activatedAtTurn,
    getStateValue: (key: string) => {
      const val = env.state.kv[key];
      return val !== undefined ? String(val) : undefined;
    },
  };
}

/**
 * Wrap raw context into a typed ObserveCapability.
 * The `ctx` parameter is accepted for forward compatibility but is not
 * introspected — pass event-specific data via `extras`.
 */
export function wrapObserveCapability(
  _ctx: unknown,
  sessionID: string,
  eventName: string,
  extras?: {
    toolName?: string;
    toolArgs?: unknown;
    toolOutput?: unknown;
    lastAssistantText?: string;
  },
): ObserveCapability {
  return {
    sessionID,
    eventName,
    toolName: extras?.toolName,
    toolArgs: extras?.toolArgs,
    toolOutput: extras?.toolOutput,
    lastAssistantText: extras?.lastAssistantText,
  };
}
