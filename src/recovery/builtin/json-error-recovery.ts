import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:json-error");

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
 * Tools that inherently do not produce JSON output and should be
 * excluded from JSON-error checking.
 */
const EXCLUDED_TOOLS = new Set([
  "bash",
  "read",
  "glob",
  "grep",
  "webfetch",
  "look_at",
  "grep_app_searchgithub",
  "websearch_web_search_exa",
]);

/**
 * Patterns that indicate a JSON parse or serialization failure
 * in tool output.
 */
const JSON_ERROR_PATTERNS = [
  /Unexpected token .* in JSON/i,
  /JSON\.parse/i,
  /JSON\.stringify/i,
  /Unexpected end of JSON/i,
  /JSON Parse error/i,
  /Invalid JSON/i,
  /Malformed JSON/i,
  /Expected .* JSON/i,
  /SyntaxError:.*unexpected/i,
];

/**
 * Creates the json-error-recovery built-in hook.
 *
 * Intercepts tool execution results and detects JSON parse/serialization
 * errors. Delegates to the recovery engine for chain-based recovery.
 * Falls back to direct injection when the engine does not fully recover.
 *
 * @param engine - Recovery engine dependency
 * @returns A configured BuiltInHookDefinition
 */
export function createJsonErrorRecoveryHook(
  engine: RecoveryEngineLike,
): BuiltInHookDefinition {
  return {
    name: "json-error-recovery",
    configKey: "json_error",
    events: ["tool.execute.after"],
    phase: "after",
    priority: 10,
    module: {
      onToolAfter: async (
        ctx: unknown,
        input: { tool: string; args: unknown; output: unknown },
      ) => {
        // Exclusion check: skip tools that don't produce JSON
        if (EXCLUDED_TOOLS.has(input.tool)) return;

        const hookCtx = ctx as {
          sessionID?: string;
          inject: (text: string) => void;
        };

        const errorText = extractErrorText(input.output);
        if (!errorText) return;

        const matched = JSON_ERROR_PATTERNS.some((p) => p.test(errorText));
        if (!matched) return;

        const sessionID = hookCtx.sessionID;
        if (!sessionID) {
          hookCtx.inject(
            `\n[RECOVERY] JSON error detected in "${input.tool}" output. ` +
              `Verify the response format and retry.\n`,
          );
          return;
        }

        log.debug("JSON error detected, attempting recovery", {
          sessionID,
          tool: input.tool,
        });

        const result = await engine.recover(
          sessionID,
          { tool: input.tool, error: errorText },
          "json_error",
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
    const obj = output as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.stderr === "string") return obj.stderr;
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}
