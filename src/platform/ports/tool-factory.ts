/**
 * IToolFactory — port interface for compiling canonical tool definitions
 * into platform-native tool objects.
 *
 * The defineTool() function creates platform-agnostic CanonicalToolDefs.
 * The IToolFactory adapter compiles them for the target platform.
 *
 * Must NOT import from @opencode-ai/plugin or @opencode-ai/sdk.
 */

import type { z } from "zod";
import type { CanonicalToolDef, CanonicalToolContext, ToolResult } from "../types.ts";

export type { CanonicalToolDef, CanonicalToolContext, ToolResult };

/**
 * Platform adapter that compiles canonical tool definitions into
 * the target platform's native tool format.
 */
export interface IToolFactory {
  /**
   * Compile a single canonical tool definition into a platform-native tool.
   * The returned object is opaque — only the platform runtime interprets it.
   */
  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown;

  /**
   * Compile a record of named canonical tool definitions into platform-native tools.
   * Convenience method equivalent to mapping compile() over each entry.
   */
  compileAll(defs: Record<string, CanonicalToolDef>): Record<string, unknown>;
}

/**
 * Create a platform-agnostic tool definition.
 *
 * This is the canonical replacement for `tool()` from @opencode-ai/plugin.
 * It performs no platform-specific transformation — it simply validates
 * the shape and returns the definition as-is.
 *
 * Usage:
 *   import { defineTool } from "../platform/ports/tool-factory.ts";
 *   export const myTool = defineTool({ description, args, execute });
 */
export function defineTool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: CanonicalToolContext,
  ): Promise<ToolResult>;
}): CanonicalToolDef<Args> {
  return input;
}
