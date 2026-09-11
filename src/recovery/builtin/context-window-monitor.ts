import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:context-window");

/**
 * Minimal interface for the recovery engine dependency.
 * Avoids circular dependency on the full engine type.
 */
export interface RecoveryEngineLike {
  recover(
    sessionID: string,
    error: unknown,
    category?: string,
  ): Promise<{ recovered: boolean; message?: string }>;
}

/**
 * Threshold for large tool output that may indicate the context
 * window is under pressure. Outputs larger than this trigger a
 * pre-emptive warning.
 */
const LARGE_OUTPUT_THRESHOLD = 50_000;

/**
 * Patterns that indicate a context window or token limit error.
 * Provider-agnostic — matches common phrasing across model providers.
 */
const CONTEXT_WINDOW_PATTERNS = [
  /context length/i,
  /context window/i,
  /token limit/i,
  /maximum.*token/i,
  /too many tokens/i,
  /input too long/i,
  /prompt too long/i,
  /max.*context/i,
  /request too large/i,
  /exceeded.*length/i,
  /capacity.*exceeded/i,
];

/**
 * Creates the context-window-monitor built-in hook.
 *
 * Listens on two event paths:
 * - `tool.execute.after`: Estimates token count from output length and
 *   injects a pre-emptive warning when the output is very large.
 * - `event` (session.error): Detects token limit / context window errors
 *   and delegates to the recovery engine.
 *
 * @param engine - Recovery engine dependency
 * @returns A configured BuiltInHookDefinition
 */
export function createContextWindowMonitorHook(
  engine: RecoveryEngineLike,
): BuiltInHookDefinition {
  return {
    name: "context-window-monitor",
    configKey: "context_window",
    events: ["tool.execute.after", "event"],
    phase: "after",
    priority: 10,
    module: {
      onToolAfter: async (
        ctx: unknown,
        input: { tool: string; args: unknown; output: unknown },
      ) => {
        const hookCtx = ctx as {
          sessionID?: string;
          inject: (text: string) => void;
        };

        const outputStr = extractStringOutput(input.output);
        if (!outputStr || outputStr.length < LARGE_OUTPUT_THRESHOLD) return;

        // Rough token estimate: ~4 chars per token
        const estimatedTokens = Math.ceil(outputStr.length / 4);
        log.warn("Large tool output detected", {
          tool: input.tool,
          charLength: outputStr.length,
          estimatedTokens,
        });

        hookCtx.inject(
          `\n[RECOVERY] Warning: Large output from "${input.tool}" ` +
            `(~${estimatedTokens} tokens). Consider summarising or ` +
            `truncating to avoid context window pressure.\n`,
        );
      },
      onEvent: async (
        ctx: unknown,
        input: { type: string; properties?: Record<string, unknown> },
      ) => {
        if (input.type !== "session.error") return;

        const hookCtx = ctx as {
          sessionID?: string;
          inject: (text: string) => void;
        };
        const sessionID =
          (input.properties?.sessionID as string) ?? hookCtx.sessionID;
        if (!sessionID) return;

        const error = input.properties?.error;
        const errorText = extractStringOutput(error);
        if (!errorText) return;

        const matched = CONTEXT_WINDOW_PATTERNS.some((p) => p.test(errorText));
        if (!matched) return;

        log.debug("Context window error detected, attempting recovery", {
          sessionID,
        });

        const result = await engine.recover(
          sessionID,
          error,
          "context_window",
        );

        if (!result.recovered && result.message) {
          hookCtx.inject(`\n[RECOVERY] ${result.message}\n`);
        }
      },
    },
  };
}

/**
 * Extract a string representation from tool output for analysis.
 */
function extractStringOutput(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}
