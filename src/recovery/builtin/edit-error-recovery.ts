import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:edit-error");

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

/** Common patterns that indicate an edit tool failure. */
const EDIT_ERROR_PATTERNS = [
  // Edit: exact match failures
  /oldString not found/i,
  /Found multiple matches/i,
  /no edits were applied/i,
  // Write: disk-level errors
  /permission denied/i,
  /ENOENT/i,
  /EACCES/i,
  /EISDIR/i,
  /read-only/i,
  // Hashline: anchor or version mismatch
  /anchor not found/i,
  /version mismatch/i,
  /stale content/i,
  /edit conflict/i,
];

/**
 * Creates the edit-error-recovery built-in hook.
 *
 * Intercepts tool execution results for edit/write/hashline_edit and
 * delegates detected failures to the recovery engine for chain-based
 * recovery. Falls back to direct injection when the engine does not
 * fully recover.
 *
 * @param engine - Recovery engine dependency
 * @returns A configured BuiltInHookDefinition
 */
export function createEditErrorRecoveryHook(
  engine: RecoveryEngineLike,
): BuiltInHookDefinition {
  return {
    name: "edit-error-recovery",
    configKey: "edit_error",
    events: ["tool.execute.after"],
    phase: "after",
    priority: 10,
    filter: { tools: ["edit", "write", "hashline_edit"] },
    module: {
      onToolAfter: async (
        ctx: unknown,
        input: { tool: string; args: unknown; output: unknown },
      ) => {
        const hookCtx = ctx as {
          sessionID?: string;
          inject: (text: string) => void;
        };

        // Extract error text from the output
        const errorText = extractErrorText(input.output);
        if (!errorText) return;

        const matched = EDIT_ERROR_PATTERNS.some((p) => p.test(errorText));
        if (!matched) return;

        const sessionID = hookCtx.sessionID;
        if (!sessionID) {
          // No session ID — inject a direct reminder as fallback
          hookCtx.inject(
            `\n[RECOVERY] Edit error detected in "${input.tool}". ` +
              `Check file permissions and try again.\n`,
          );
          return;
        }

        log.debug("Edit error detected, attempting recovery", {
          sessionID,
          tool: input.tool,
        });

        const result = await engine.recover(
          sessionID,
          { tool: input.tool, error: errorText },
          "edit_error",
        );

        if (!result.recovered && result.message) {
          hookCtx.inject(`\n[RECOVERY] ${result.message}\n`);
        }
      },
    },
  };
}

/**
 * Extract a string representation of the error from tool output.
 */
function extractErrorText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    // Try common error fields
    const obj = output as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.stderr === "string") return obj.stderr;
    // Fall back to JSON stringification
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}
