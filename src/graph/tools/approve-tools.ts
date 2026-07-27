/**
 * Graph Execution Engine v2 — `graph_approve` Tool Registration
 *
 * Version: 2.0
 * Date: 2026-07-25
 *
 * Phase C migration (Plan B), GAP-2 fill. The legacy orchestrator-facing
 * human-approval pair `dispatch_approve` / `dispatch_reject` has **no**
 * graph_* equivalent in the original seven-tool set — the engine exposes
 * `approveNode` / `rejectNode` only as internal `EngineRuntime` methods
 * (deprecation-map §3 rows 7–8 classify them "(engine-internal)"). This module
 * adds the thin, additive `graph_approve` surface that routes a parent-facing
 * approve/reject decision to the engine's public API import-only (protected
 * engine files are never modified).
 *
 * The arg schema mirrors the `GraphApproveArgs` shape exported by
 * `graph-tools.ts`. A single `action: "approve" | "reject"` discriminator
 * consolidates the two legacy tools into one surface; `reason` carries the
 * human rejection feedback and `payload` the optional approval output.
 *
 * ## Precedence contract
 *
 * This factory is additive. Its key is `graph_approve`, which does not collide
 * with any existing `graph_*` or legacy `dispatch_*` / `loop_*` tool key.
 * Registration therefore never overrides a legacy tool.
 *
 * Design reference: `.rolebox/design/tool-merge-map.md` §2.2, §3 (rows 7–8),
 * and `.rolebox/evidence/final-qa/phase-c-inventory.md` §6 GAP-2.
 */

import { z } from "zod";
import type { CanonicalToolDef } from "../../platform/types.ts";
import { defineTool } from "../../platform/ports/tool-factory.ts";
import type { GraphToolSet, GraphApproveAction } from "./graph-tools.ts";

/** Render a plain-object tool result as an agent-readable JSON string. */
function json(input: unknown): string {
  return JSON.stringify(input, null, 2);
}

/** graph_approve — approve or reject a blocked needs_approval node. */
export function createGraphApproveTool(
  toolset: GraphToolSet,
): CanonicalToolDef {
  return defineTool({
    description:
      "Approve or reject a blocked needs_approval node (the parent-facing " +
      "human-in-the-loop surface). 'approve' resolves the gate (blocked → " +
      "completed) and runs the node's forward 'answer' data flow; 'reject' " +
      "re-enters the node with the rejection reason when it belongs to a loop " +
      "group, or escalates it when it has no loop to re-open. Both are " +
      "idempotent — a decision on an already-resolved node is a no-op.",
    args: {
      graph_id: z.string().describe("Graph containing the blocked node."),
      node_id: z
        .string()
        .describe("The needs_approval node currently blocked awaiting the human."),
      action: z
        .enum(["approve", "reject"] as const)
        .describe(
          "approve resolves the gate and continues the graph; reject re-enters " +
            "or escalates the node with the supplied reason.",
        ),
      reason: z
        .string()
        .optional()
        .describe(
          "Human-supplied rejection feedback (used when action=reject; merged " +
            "into the node's re-execution prompt).",
        ),
      payload: z
        .unknown()
        .optional()
        .describe(
          "Optional approval output passed downstream on the answer edge " +
            "(used when action=approve).",
        ),
    },
    async execute(args) {
      try {
        return json(await toolset.graph_approve(args));
      } catch (err) {
        return `graph_approve failed: ${(err as Error).message}`;
      }
    },
  });
}

// Re-export the action type for callers / tests that type against it.
export type { GraphApproveAction };
