/**
 * Loop tool factory for the Pi platform.
 *
 * Creates a CanonicalToolDef for the "loop" tool that registers a multi-round
 * loop with the LoopCoordinator. The coordinator runs rounds asynchronously
 * via background dispatch; this tool returns immediately (non-blocking).
 *
 * The tool's key in the loopTools map (in pi-extension.ts) is "loop", which
 * becomes the tool name visible to the agent.
 *
 * The `pi` ExtensionAPI reference is captured in the factory closure for
 * future use — e.g. the coordinator could deliver loop progress via
 * `pi.sendMessage(triggerTurn: false)`.
 *
 * @module
 */

import { defineTool } from "../../ports/tool-factory.ts";
import { z } from "zod";
import type { LoopCoordinator } from "../../../loop/coordinator.js";
import type { LoopMode } from "../../../loop/types.js";
import type { CanonicalToolDef } from "../../types.ts";

/**
 * Create the "loop" canonical tool definition for the Pi platform.
 *
 * @param coordinator - The LoopCoordinator instance that manages loop lifecycle.
 * @param pi - Pi's ExtensionAPI object (captured for future progress delivery).
 * @param activeAgent - Resolver for the currently active agent full ID.
 *                      On Pi, `context.agent` is always empty, so this
 *                      fallback mirrors the dispatch tool's pattern.
 * @returns A CanonicalToolDef ready to be placed in the `loopTools` map
 *          under the key `"loop"`.
 */
export function createLoopTool(
  coordinator: LoopCoordinator,
  pi: any,
  activeAgent: () => string,
): CanonicalToolDef {
  return defineTool({
    description:
      "Sequential multi-session iteration — runs the same task across fresh sessions",
    args: {
      iterations: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5),
      mode: z
        .enum(["inherit", "fresh"])
        .default("inherit"),
    },
    async execute(args, ctx) {
      // ── Validate params ──────────────────────────────────────
      const iterations = args.iterations;
      const mode = args.mode as LoopMode;

      if (iterations < 1 || iterations > 50) {
        return `Invalid iterations: ${iterations}. Must be between 1 and 50.`;
      }

      // ── Resolve acting agent ─────────────────────────────────
      // Pi never populates context.agent natively, so fall back to
      // the platform-provided resolver (activeAgent ref).
      const agent =
        ctx.agent && ctx.agent.length > 0
          ? ctx.agent
          : activeAgent();

      // ── Register the loop (non-blocking) ─────────────────────
      coordinator.register({
        originSessionId: ctx.sessionID,
        agent,
        prompt: "Execute the user's task",
        mode,
        iterations,
      });

      return (
        `Loop started: ${iterations} rounds, mode=${mode}. ` +
        `Check progress with dispatch_stream or dispatch_status. ` +
        `Use /stop-loop to cancel.`
      );
    },
  });
}
