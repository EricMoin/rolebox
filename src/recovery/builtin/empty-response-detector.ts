import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:empty-response");

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
 * Minimum content length (non-whitespace characters) for a tool
 * response to be considered non-empty.
 */
const MIN_CONTENT_LENGTH = 5;

/**
 * Creates the empty-response-detector built-in hook.
 *
 * Intercepts all tool execution results and detects outputs that are
 * empty or contain only whitespace (fewer than 5 meaningful characters).
 * Delegates to the recovery engine for chain-based recovery. Falls back
 * to direct injection when the engine does not fully recover.
 *
 * @param engine - Recovery engine dependency
 * @returns A configured BuiltInHookDefinition
 */
export function createEmptyResponseDetectorHook(
  engine: RecoveryEngineLike,
): BuiltInHookDefinition {
  return {
    name: "empty-response-detector",
    configKey: "empty_response",
    events: ["tool.execute.after"],
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

        const responseText = extractResponseText(input.output);
        if (responseText !== null && responseText.trim().length >= MIN_CONTENT_LENGTH) {
          return;
        }

        const sessionID = hookCtx.sessionID;
        if (!sessionID) {
          hookCtx.inject(
            `\n[RECOVERY] Empty response from "${input.tool}". ` +
              `The tool returned no output. Please retry.\n`,
          );
          return;
        }

        log.debug("Empty response detected", {
          sessionID,
          tool: input.tool,
        });

        const result = await engine.recover(
          sessionID,
          { tool: input.tool, output: input.output },
          "empty_response",
        );

        if (!result.recovered && result.message) {
          hookCtx.inject(`\n[RECOVERY] ${result.message}\n`);
        }
      },
    },
  };
}

/**
 * Extract the textual content from a tool output for emptiness checking.
 *
 * Returns `null` when the output is absent (no data to check), and a
 * string (possibly empty) when output exists.
 */
function extractResponseText(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return output;
  if (typeof output === "number" || typeof output === "boolean") {
    return String(output);
  }
  if (Array.isArray(output)) {
    return output.map((item) => extractResponseText(item) ?? "").join(" ");
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // Prefer a common content field
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.stdout === "string") return obj.stdout;
    // Fall back to JSON representation
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return null;
}
