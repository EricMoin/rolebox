// ── `rolebox logs` — read the log files back ────────────────────────────────
//
// The command surface of the logging platform's READ side (src/log/read.ts):
//
//   rolebox logs [filters]        the records a query matches, newest first
//   rolebox logs files            the log files on disk
//   rolebox logs prune            remove ROTATED copies only
//
// The default command is the query, so `rolebox logs` alone answers the last
// 100 records. Subcommands are separate citty commands, registered here and
// lazily imported from src/cli/main.ts, so the CLI pays for this module only
// when the command is used.
//
// CITTY 0.2.2 RUNS A MATCHED SUBCOMMAND AND THEN THE PARENT'S `run` (measured
// against the installed version: `runCommand` awaits the subcommand and then
// calls `cmd.run`, it does not return). The default command therefore SKIPS
// itself when the first positional names a subcommand — without that check
// `rolebox logs files` would print the table and then run a query as well.
//
// The runners and the argument parser live beside this file (./logs/), which is
// where the behaviour and its tests are; this file is the citty wiring and the
// exit-code contract: an unusable ARGUMENT is the one failure reported as an
// error (exit 1 with the usage line), while an empty answer is exit 0.

import { defineCommand } from "citty";
import {
  LOGS_FILES_USAGE,
  LOGS_PRUNE_USAGE,
  LOGS_USAGE,
  LogsUsageError,
  parseLogsFilesArgs,
  parseLogsPruneArgs,
  parseLogsQueryArgs,
} from "./logs/logs-args.ts";
import { runLogsFiles, runLogsPrune, runLogsQuery } from "./logs/logs-run.ts";

/** The subcommand names the default command must not also answer. */
const SUBCOMMAND_NAMES: readonly string[] = ["files", "prune"];

/**
 * Turn a failure into the exit code the contract promises: 1. A usage error
 * names the usage line; any other failure is reported by its message alone, so
 * a broken invocation never prints a stack trace.
 */
function reportFailure(error: unknown, usage: string, err: (line: string) => void): number {
  if (error instanceof LogsUsageError) {
    err(`Error: ${error.message}`);
    err(`Usage: ${usage}`);
    return 1;
  }
  err(`Error: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

/** `rolebox logs files` — list the log files, their rotation, size and mtime. */
export const logsFilesCommand = defineCommand({
  meta: {
    name: "files",
    description: "List the log files: channel, rotation, size and modification time",
  },
  args: {
    "log-dir": {
      type: "string",
      description: "Read from this directory instead of the resolved log directory",
    },
  },
  run({ args }) {
    try {
      process.exitCode = runLogsFiles(parseLogsFilesArgs(args));
    } catch (error) {
      process.exitCode = reportFailure(error, LOGS_FILES_USAGE, (line) => console.error(line));
    }
  },
});

/** `rolebox logs prune` — remove rotated copies, never the active file. */
export const logsPruneCommand = defineCommand({
  meta: {
    name: "prune",
    description: "Remove rotated log files (active files are never touched)",
  },
  args: {
    days: {
      type: "string",
      description: "Only remove rotated copies at least this many days old (e.g. 7)",
    },
    keep: {
      type: "string",
      description: "Rotated copies to keep per channel (default: the writer's ROLEBOX_LOG_RETAIN, else 3)",
    },
    "max-total-bytes": {
      type: "string",
      description: "Remove the oldest rotated copies until every log file left fits in this many bytes",
    },
    "dry-run": {
      type: "boolean",
      description: "Report what would be removed and remove nothing",
    },
    "log-dir": {
      type: "string",
      description: "Read from this directory instead of the resolved log directory",
    },
  },
  run({ args }) {
    try {
      process.exitCode = runLogsPrune(parseLogsPruneArgs(args));
    } catch (error) {
      process.exitCode = reportFailure(error, LOGS_PRUNE_USAGE, (line) => console.error(line));
    }
  },
});

export default defineCommand({
  meta: {
    name: "logs",
    description: "Read the rolebox log files: query records, list files, prune rotated copies",
  },
  args: {
    level: {
      type: "string",
      description: "Lowest level to show: debug, info, warn, error or fatal (warn shows warn and above)",
    },
    channel: {
      type: "string",
      description: "Only these channels, comma-separated (exact match)",
    },
    code: {
      type: "string",
      description: "Only these event codes, comma-separated (exact match)",
    },
    graph: {
      type: "string",
      description: "Only records whose scope carries this graphId",
    },
    session: {
      type: "string",
      description: "Only records whose scope carries this sessionId",
    },
    since: {
      type: "string",
      description: "Only records at or after this time: 10m, 2h, 1d, an ISO 8601 time, or epoch milliseconds",
    },
    until: {
      type: "string",
      description: "Only records at or before this time (same forms as --since)",
    },
    limit: {
      type: "string",
      description: "How many records to show (default: 100)",
    },
    order: {
      type: "string",
      description: "Newest first (desc, the default) or oldest first (asc)",
    },
    text: {
      type: "string",
      description: "Case-insensitive substring looked for in message, channel, code and field values",
    },
    "log-dir": {
      type: "string",
      description: "Read from this directory instead of the resolved log directory",
    },
    json: {
      type: "boolean",
      description: "Write one raw JSON record per line (for jq)",
    },
    follow: {
      type: "boolean",
      alias: ["f"],
      description: "Stream records written after the command starts (Ctrl-C to stop)",
    },
  },
  subCommands: {
    files: logsFilesCommand,
    prune: logsPruneCommand,
  },
  async run({ args }) {
    // citty 0.2.2 runs the matched subcommand AND this run (see the header), so
    // the default query stands down when a subcommand name is the positional.
    if (SUBCOMMAND_NAMES.some((name) => name === args._[0])) return;
    try {
      process.exitCode = await runLogsQuery(parseLogsQueryArgs(args, Date.now()));
    } catch (error) {
      process.exitCode = reportFailure(error, LOGS_USAGE, (line) => console.error(line));
    }
  },
});
