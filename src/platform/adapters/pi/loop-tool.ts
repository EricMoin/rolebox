/**
 * Loop start tool factory for the Pi platform.
 *
 * Creates a CanonicalToolDef for the "loop_start" tool that registers a
 * multi-round loop with the LoopCoordinator. The coordinator runs rounds
 * asynchronously via background dispatch; this tool returns immediately
 * (non-blocking).
 *
 * The tool's key in the loopTools map (in pi-extension.ts) is "loop_start",
 * which becomes the tool name visible to the agent.
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
 * Create the "loop_start" canonical tool definition for the Pi platform.
 *
 * The agent must provide a `prompt` describing the task to iterate, and
 * may optionally provide an `objective` for nested-loop convergence
 * detection. The coordinator's register() performs fingerprint/lineage/tree
 * budget checks and returns a RegisterResult — this tool forwards the result
 * back to the agent: on error it returns the rejection reason as a
 * correction; on success it returns a confirmation with the origin session
 * ID for loop_status tracking.
 *
 * @param coordinator - The LoopCoordinator instance that manages loop lifecycle.
 * @param pi - Pi's ExtensionAPI object (captured for future progress delivery).
 * @param activeAgent - Resolver for the currently active agent full ID.
 *                      On Pi, `context.agent` is always empty, so this
 *                      fallback mirrors the dispatch tool's pattern.
 * @returns A CanonicalToolDef ready to be placed in the `loopTools` map
 *          under the key `"loop_start"`.
 */
export function createLoopStartTool(
  coordinator: LoopCoordinator,
  pi: any,
  activeAgent: () => string,
): CanonicalToolDef {
  return defineTool({
    description:
      "Start a sequential multi-session loop — runs the same task across fresh sessions",
    args: {
      iterations: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe("Number of rounds to execute (1–50, default 5)"),
      mode: z
        .enum(["inherit", "fresh"])
        .default("inherit")
        .describe(
          'Loop mode: "inherit" shares context between rounds, ' +
            '"fresh" starts each round clean',
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "The task to execute across every round — " +
            "what the worker agent should do each iteration",
        ),
      objective: z
        .string()
        .optional()
        .describe(
          "Convergence criteria for nested loops — when the summary " +
            "declares this objective done, the loop terminates early",
        ),
    },
    async execute(args, ctx) {
      // ── Validate params ──────────────────────────────────────
      const iterations = args.iterations;
      const mode = args.mode as LoopMode;
      const prompt = args.prompt;
      const objective = args.objective;

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
      const result = coordinator.register({
        originSessionId: ctx.sessionID,
        agent,
        prompt,
        mode,
        iterations,
        objective,
      });

      if (!result.ok) {
        // Registration rejected — return the reason as a
        // correction to guide the agent toward a valid request.
        return `Loop not started: ${result.reason}`;
      }

      return (
        `Loop started: ${iterations} rounds, mode=${mode}. ` +
        `Track with loop_status(session_id="${ctx.sessionID}"). ` +
        `Use /stop-loop to cancel.`
      );
    },
  });
}
