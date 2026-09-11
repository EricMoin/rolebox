/**
 * Memory management CLI commands.
 *
 * Each subcommand lives in its own module for focused maintenance.
 * This file assembles them into the `rolebox memory` command tree.
 *
 * @module
 */

import { defineCommand } from "citty";
import { listCommand } from "./memory/memory-list.ts";
import { showCommand } from "./memory/memory-show.ts";
import { searchCommand } from "./memory/memory-search.ts";
import { deleteCommand } from "./memory/memory-delete.ts";
import { exportCommand } from "./memory/memory-export.ts";
import { cleanCommand } from "./memory/memory-clean.ts";
import { statsCommand } from "./memory/memory-stats.ts";

export default defineCommand({
  meta: {
    name: "memory",
    description: "Manage rolebox memory store",
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    search: searchCommand,
    delete: deleteCommand,
    export: exportCommand,
    clean: cleanCommand,
    stats: statsCommand,
  },
});
