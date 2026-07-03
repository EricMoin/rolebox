import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:session-error");

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
 * Creates the session-error-recovery built-in hook.
 *
 * Intercepts `session.error` events and delegates to the recovery engine
 * for chain-based recovery. If recovery fails with a message, falls back
 * to direct injection as a reminder.
 *
 * @param engine - Recovery engine dependency (must expose `recover()`)
 * @returns A configured BuiltInHookDefinition
 */
export function createSessionErrorRecoveryHook(
  engine: RecoveryEngineLike,
): BuiltInHookDefinition {
  return {
    name: "session-error-recovery",
    configKey: "session_error",
    events: ["event"],
    phase: "after",
    priority: 10,
    filter: { eventTypes: ["session.error"] },
    module: {
      onEvent: async (
        ctx: unknown,
        input: { type: string; properties?: Record<string, unknown> },
      ) => {
        const hookCtx = ctx as {
          sessionID?: string;
          inject: (text: string) => void;
        };
        const sessionID =
          (input.properties?.sessionID as string) ?? hookCtx.sessionID;
        if (!sessionID) return;

        const error = input.properties?.error;
        log.debug("Session error detected, attempting recovery", {
          sessionID,
          errorType: typeof error,
        });

        const result = await engine.recover(sessionID, error, "session_error");
        if (!result.recovered && result.message) {
          hookCtx.inject(`\n[RECOVERY] ${result.message}\n`);
        }
      },
    },
  };
}
