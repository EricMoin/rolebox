/**
 * OpenCode tool factory adapter — implements IToolFactory by compiling
 * canonical tool definitions into opencode's native tool format using
 * the `tool()` factory from @opencode-ai/plugin.
 */

import { tool } from "@opencode-ai/plugin";
import type { z } from "zod";
import type { IToolFactory } from "../ports/tool-factory.ts";
import type { CanonicalToolDef } from "../types.ts";

/**
 * IToolFactory adapter for the opencode platform.
 *
 * Compiles CanonicalToolDefs into opencode-native tool objects by
 * passing them through the `tool()` factory from @opencode-ai/plugin.
 * Since CanonicalToolDef has the same shape as tool()'s input, the
 * compilation is a direct pass-through.
 */
export class OpencodeToolFactory implements IToolFactory {
  compile<Args extends z.ZodRawShape>(def: CanonicalToolDef<Args>): unknown {
    return tool(def);
  }

  compileAll(defs: Record<string, CanonicalToolDef>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      result[name] = this.compile(def);
    }
    return result;
  }
}
