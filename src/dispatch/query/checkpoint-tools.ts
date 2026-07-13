/**
 * dispatch_checkpoint tool — saves execution checkpoints during task runs.
 *
 * Enables mid-execution resume by persisting phase, completed items,
 * remaining items, and optional metadata to the CheckpointStore.
 */

import { defineTool, type CanonicalToolContext } from "../../platform/ports/tool-factory.ts";
import { z } from "zod";
import type { DispatchManager } from "../core/manager.ts";
import type { CheckpointData } from "../types.checkpoint.ts";
import { DEFAULT_CHECKPOINT_TTL_MS } from "../config.ts";

/**
 * Generate a short, time-ordered checkpoint ID.
 * Format: cp_{timestamp}_{random4}
 */
function generateCheckpointId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
  return `cp_${timestamp}_${random}`;
}

export function createCheckpointTool(dispatchManager: DispatchManager) {
  return defineTool({
    description:
      "Save a mid-execution checkpoint for a dispatch task. " +
      "Persists the current phase, completed items, remaining items, " +
      "and optional metadata. When the task is later retried, the " +
      "checkpoint context is automatically injected into the retry prompt " +
      "so work is not duplicated.",
    args: {
      task_id: z
        .string()
        .min(1)
        .describe("Task ID this checkpoint belongs to"),
      phase: z
        .string()
        .min(1)
        .describe("Current phase label (e.g., 'research', 'implementation', 'verification')"),
      completed_items: z
        .array(z.string())
        .min(0)
        .describe("Items that have been successfully completed so far"),
      remaining_items: z
        .array(z.string())
        .min(0)
        .describe("Items remaining to be processed"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional arbitrary metadata for extensibility"),
    },
    async execute(input, _context: CanonicalToolContext) {
      const { task_id, phase, completed_items, remaining_items, metadata } = input;

      const checkpointStore = dispatchManager.getCheckpointStore();

      const checkpointData: CheckpointData = {
        task_id,
        checkpoint_id: generateCheckpointId(),
        phase,
        completed_items,
        remaining_items,
        created_at: new Date().toISOString(),
        ttl_ms: DEFAULT_CHECKPOINT_TTL_MS,
      };

      if (metadata !== undefined) {
        checkpointData.metadata = metadata;
      }

      await checkpointStore.saveCheckpoint(task_id, checkpointData);

      return [
        `Checkpoint saved: ${checkpointData.checkpoint_id}`,
        `(phase: ${phase}, ${completed_items.length} done, ${remaining_items.length} remaining)`,
      ].join("\n");
    },
  });
}
