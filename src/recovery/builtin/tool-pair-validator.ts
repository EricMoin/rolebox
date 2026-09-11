import type { BuiltInHookDefinition } from "../types.ts";
import { createSubLogger } from "../../logger.ts";

const log = createSubLogger("hook:tool-pair");

/**
 * Patterns that suggest a tool_use/tool_result mismatch in the
 * system prompt text.
 */
const TOOL_ERROR_PATTERNS = [
  /tool_use.*without.*tool_result/i,
  /tool_result.*without.*tool_use/i,
  /unmatched tool/i,
  /tool call.*not found/i,
  /missing tool result/i,
  /tool.*mismatch/i,
  /expected tool.*call/i,
  /unexpected tool result/i,
];

/**
 * Creates the tool-pair-validator built-in hook.
 *
 * Scans the system prompt during `system.transform` for evidence
 * of tool_use/tool_result mismatches. When detected, injects a
 * correction reminder directly via `ctx.inject()`.
 *
 * This is a simplified guard — full message-scanning would require
 * a messages.transform event that rolebox does not yet expose.
 *
 * No engine dependency — pure guard with direct injection.
 *
 * @returns A configured BuiltInHookDefinition
 */
export function createToolPairValidatorHook(): BuiltInHookDefinition {
  return {
    name: "tool-pair-validator",
    configKey: "tool_pair_validation",
    events: ["system.transform"],
    phase: "after",
    priority: 10,
    module: {
      onSystemTransform: async (
        ctx: unknown,
        input: { system: string[] },
      ) => {
        const hookCtx = ctx as { inject: (text: string) => void };

        const combinedPrompt = input.system.join("\n");
        const matched = TOOL_ERROR_PATTERNS.some((p) => p.test(combinedPrompt));
        if (!matched) return;

        log.debug("Tool pair mismatch detected in system prompt");

        hookCtx.inject(
          `\n[RECOVERY] Tool pair mismatch detected. Ensure every ` +
            `tool_use has a matching tool_result and vice versa. ` +
            `Review recent tool calls for incomplete pairs.\n`,
        );
      },
    },
  };
}
