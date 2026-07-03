import { z } from "zod";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("hook-tool-before");

/**
 * Registry of tool name → zod raw shape (the `args` field of each ToolDefinition).
 * Populated by registerToolSchemas() when tools are created in plugin-hooks.ts.
 */
const toolSchemaRegistry = new Map<string, z.ZodRawShape>();

export function registerToolSchema(toolName: string, args: z.ZodRawShape): void {
  toolSchemaRegistry.set(toolName, args);
}

/**
 * Pre-execution hook: validates tool parameters with zod .strict() mode.
 * 
 * If the model passes unknown parameters (e.g. hallucinated `block=true` on
 * dispatch_output), zod's default .strip() mode silently removes them — the tool
 * returns "still running" and the model enters a polling loop because it thinks
 * its blocking request was ignored.
 * 
 * Using .strict() here makes unknown keys a validation error. We throw with a
 * clear message listing the valid parameters, so the model can self-correct.
 */
export async function handleToolBefore(
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
): Promise<void> {
  const schema = toolSchemaRegistry.get(input.tool);
  if (!schema) return; // Unknown tool — let opencode handle it

  // .strict() rejects unknown keys instead of silently stripping them
  const result = z.object(schema).strict().safeParse(output.args);

  if (!result.success) {
    const issues = result.error.issues;

    // Separate unknown-key errors from other validation errors
    const unknownKeys: string[] = [];
    const otherErrors: string[] = [];

    for (const issue of issues) {
      if (issue.code === "unrecognized_keys") {
        const keys = (issue as { keys?: string[] }).keys;
        if (keys) unknownKeys.push(...keys);
      } else {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        otherErrors.push(`  - ${path}: ${issue.message}`);
      }
    }

    const validParams = Object.keys(schema);
    const lines: string[] = [];

    if (unknownKeys.length > 0) {
      lines.push(
        `Invalid tool call: '${input.tool}' does not accept parameter(s): ${unknownKeys.map((k) => `'${k}'`).join(", ")}.`,
      );
      lines.push("");
      lines.push(`Valid parameters for '${input.tool}': ${validParams.join(", ")}`);
      lines.push("");
      lines.push("Remove the unsupported parameter(s) and call again. Do not retry with the same parameters.");
    }

    if (otherErrors.length > 0) {
      lines.push("Parameter validation errors:");
      lines.push(otherErrors.join("\n"));
      lines.push("");
      lines.push(`Valid parameters: ${validParams.join(", ")}`);
    }

    const errorMsg = lines.join("\n");
    log.debug("validation failed", { tool: input.tool, unknownKeys, sessionID: input.sessionID });

    // Throw to abort tool execution — opencode returns the error as a tool result
    throw new Error(errorMsg);
  }

  // Validation passed — update args with the parsed result (normalized)
  output.args = result.data;
}
