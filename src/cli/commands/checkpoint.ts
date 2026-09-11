/**
 * Checkpoint management CLI commands.
 *
 * Manages dispatch checkpoint lifecycle: list active checkpoints,
 * and clean expired or all checkpoints.
 *
 * @module
 */

import { defineCommand } from "citty";
import { listCommand } from "./checkpoint/checkpoint-list.ts";
import { cleanCommand } from "./checkpoint/checkpoint-clean.ts";

export default defineCommand({
  meta: {
    name: "checkpoint",
    description: "Manage dispatch checkpoints",
  },
  subCommands: {
    list: listCommand,
    clean: cleanCommand,
  },
});
