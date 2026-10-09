// ── Rendering what `rolebox logs` found ─────────────────────────────────────
//
// A RECORD HAS EXACTLY TWO RENDERINGS, and neither is invented here:
//
//   • the HUMAN line is {@link formatLogLine} from the console sink — the same
//     bytes the runtime writes to the terminal, so a line read back from a file
//     and a line watched live are the same line. This module only chooses it;
//   • the JSON line is the record itself, one line, `JSON.stringify`d in the
//     key order the READ layer normalises a record into (`time`, `level`,
//     `channel`, `message`, `fields`, `scope`, `process`, then `code` when the
//     record has one), so `jq` reads a stable shape and a pipeline can mix
//     `rolebox logs --json` with any other NDJSON source.
//
// EVERYTHING ELSE RENDERS A SUMMARY: the file table (`files`) and the prune
// report. Those are answers, not diagnostics, so they go to stdout — the query's
// own notes (an empty answer, a truncation, skipped lines) go to stderr, which
// keeps `rolebox logs --json | jq` parseable.

import { bold, dim, padEnd } from "../../format.ts";
import type { LogFileInfo, LogSource, PruneLogsResult } from "../../../log/index.ts";
import type { LogRecord } from "../../../log/types.ts";
import { formatLogLine } from "../../../log/sinks/console.ts";

/** One `logs files` row: the channel, the rotation, the size and the mtime. */
const FILE_COLUMNS: readonly string[] = ["CHANNEL", "ROTATION", "SIZE", "MODIFIED"];

/** The padding each `logs files` column gets before the next one starts. */
const FILE_COLUMN_WIDTHS: readonly number[] = [24, 10, 10, 0];

/** Human size units, in the order they are divided by 1024. */
const BYTE_UNITS: readonly string[] = ["KB", "MB", "GB", "TB"];

/**
 * One record as a single output line: the runtime's own human line, or the
 * record's JSON. `json` never pretty-prints — one record is one line.
 */
export function renderRecord(record: LogRecord, json: boolean): string {
  return json ? JSON.stringify(record) : formatLogLine(record);
}

/** A byte count an operator can read: `812 B`, `1.2 KB`, `2.3 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** An epoch-millisecond time as the local `YYYY-MM-DD HH:MM:SS` an operator reads. */
export function formatLocalTime(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** `active` for the file being written, `.N` for the writer's Nth rotated copy. */
function rotationLabel(rotation: number): string {
  return rotation === 0 ? "active" : `.${rotation}`;
}

/**
 * The heading of a `logs files` answer: WHERE the files it lists actually are.
 * A directory is named as a directory; a legacy single file is named as the
 * file, because the command read that file and its rotated copies rather than
 * everything in the file's directory.
 */
function fileTableHeading(files: readonly LogFileInfo[], source: LogSource): string {
  if (source.kind === "file") return `${files.length} log file(s) for the legacy single file ${source.path}:`;
  return `${files.length} log file(s) in ${source.path}:`;
}

/**
 * The `logs files` answer: a heading naming the source that was actually read,
 * the table itself and a trailing count. `files` is already ordered by
 * {@link listLogFiles} (channel ascending, the active file before its rotated
 * copies).
 */
export function renderFileTable(files: readonly LogFileInfo[], source: LogSource): string[] {
  const lines: string[] = [fileTableHeading(files, source)];
  lines.push("  " + FILE_COLUMNS.map((column, index) => bold(padEnd(column, FILE_COLUMN_WIDTHS[index] ?? 0))).join(""));
  let totalBytes = 0;
  let active = 0;
  for (const file of files) {
    totalBytes += file.sizeBytes;
    if (file.rotation === 0) active += 1;
    const cells = [
      file.channel,
      rotationLabel(file.rotation),
      formatBytes(file.sizeBytes),
      formatLocalTime(file.mtimeMs),
    ];
    lines.push("  " + cells.map((cell, index) => padEnd(cell, FILE_COLUMN_WIDTHS[index] ?? 0)).join(""));
  }
  lines.push(dim(`  ${active} active file(s), ${files.length - active} rotated copy(ies), ${formatBytes(totalBytes)} total`));
  return lines;
}

/** What {@link renderPruneReport} describes. */
export interface PruneReportInput {
  readonly result: PruneLogsResult;
  /** True when nothing was removed: the removed list is what WOULD go. */
  readonly dryRun: boolean;
  /** The age gate in days, when the caller set one. */
  readonly days?: number;
  /** The byte budget in bytes, when the caller set one. */
  readonly maxTotalBytes?: number;
  /** The ACTIVE files that were not candidates, for the closing sentence. */
  readonly activeFiles: readonly string[];
  /** The source the prune actually acted on — never the one the caller asked for. */
  readonly source: LogSource;
}

/**
 * The sentence that says WHERE a prune looked, so an empty report cannot read as
 * "nothing anywhere": the directory it scanned, or the ONE legacy file whose
 * rotated copies were the only candidates.
 */
function pruneSourceLine(source: LogSource): string {
  if (source.kind === "file") {
    return `Source: the legacy single file ${source.path} (only its rotated copies are candidates)`;
  }
  return `Source: the log directory ${source.path}`;
}

/** How the age gate reads in a sentence, or `undefined` when it was not set. */
function describeAge(days: number | undefined): string | undefined {
  if (days === undefined) return undefined;
  return days === 1 ? "older than 1 day" : `older than ${days} days`;
}

/**
 * The prune report: what was removed (or, under `--dry-run`, what would be),
 * how much that frees, how many rotated copies stayed — and, always, the
 * sentence that says the ACTIVE files were never candidates, because "prune my
 * logs" must not read as "delete the file my process is writing to".
 */
export function renderPruneReport(input: PruneReportInput): string[] {
  const { result, dryRun } = input;
  const count = result.removed.length;
  const age = describeAge(input.days);
  const budget = result.budget;
  const lines: string[] = [pruneSourceLine(input.source)];

  if (count === 0) {
    const conditions = [
      "beyond the retained window",
      age,
      input.maxTotalBytes === undefined ? undefined : `past the ${formatBytes(input.maxTotalBytes)} byte budget`,
    ].filter((part): part is string => part !== undefined);
    lines.push(`Nothing to prune: no rotated copy is ${conditions.join(" and ")}.`);
  } else if (dryRun) {
    lines.push(`Dry run: would remove ${count} rotated file(s), freeing ${formatBytes(result.freedBytes)}.`);
  } else {
    lines.push(`Removed ${count} rotated file(s), freeing ${formatBytes(result.freedBytes)}.`);
  }

  for (const removal of result.removed) {
    lines.push("  " + removal.path + dim("  " + formatBytes(removal.sizeBytes)));
  }

  if (budget !== undefined) {
    // The budget is the one gate a healthy directory can FAIL: the active files
    // alone may be larger than it, and that is a fact about the workload, not an
    // error in the invocation. Say which of the two happened.
    const removedForBudget =
      budget.removed === 0
        ? "no extra copy had to go"
        : `${budget.removed} of them were removed to meet it`;
    lines.push(
      budget.satisfied
        ? `Byte budget ${formatBytes(budget.maxTotalBytes)}: met — ${formatBytes(budget.remainingBytes)} left on disk (${removedForBudget}).`
        : `Byte budget ${formatBytes(budget.maxTotalBytes)}: NOT met — ${formatBytes(budget.remainingBytes)} left, and active files are never removed.`,
    );
  }

  if (result.kept > 0) {
    lines.push(dim(`  kept ${result.kept} rotated copy(ies) in place`));
  }

  const active = input.activeFiles.length;
  if (active === 0) {
    lines.push(
      input.source.kind === "file"
        ? "Active files are not touched: the legacy single file is not present right now."
        : "Active files are not touched: this directory holds none right now.",
    );
  } else {
    lines.push(
      `Active files are not touched: ${active} file(s) (e.g. ${input.activeFiles[0]}) keep being written to.`,
    );
  }
  return lines;
}
