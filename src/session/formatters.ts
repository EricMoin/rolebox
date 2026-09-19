/**
 * Display formatters for the session browser and inspect tools.
 *
 * Shape only: durations, timestamps, counts, truncation and markdown cells all
 * delegate to the canonical primitives in `src/utils/text-format.ts`, so every
 * render path is total (no thrown `RangeError`, no `NaN`/`Infinity` text) and
 * locale-independent.
 */

import {
  displayWidth,
  formatCount,
  formatDuration as formatClockDuration,
  formatTimestamp,
  padDisplayEnd,
  renderMarkdownTable,
  truncateText,
} from "../utils/text-format.ts";
import type {
  SessionInfo,
  Message,
  Part,
  FileDiff,
  Todo,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolStateCompleted,
  SessionStats,
  SearchMatch,
} from "./types.ts";

/** Character budget for a single text preview (ellipsis included). */
const MAX_TEXT_PREVIEW = 500;

/** ASCII ellipsis: this output is read in terminals and markdown. */
const TEXT_ELLIPSIS = "...";

// ── Primitives ──────────────────────────────────────────────────────────────

/**
 * Format an epoch-millisecond timestamp as `YYYY-MM-DD HH:mm:ss` (UTC).
 *
 * Total: a missing, non-finite or out-of-range value renders as `unknown`
 * instead of throwing `RangeError: Invalid Date`. Session records are read from
 * disk, so a single damaged `time.created` must not kill the tool call.
 */
export function formatDate(ms: number): string {
  return formatTimestamp(ms);
}

/**
 * Format a millisecond duration in the session-table style:
 * `0s` · `42s` · `1m 5s` · `1h 0m` · `25h 0m`.
 *
 * Non-finite and negative input degrades to `0s`.
 */
export function formatDuration(ms: number): string {
  return formatClockDuration(ms, "clock");
}

/**
 * Seconds-ago rendering for a session timestamp.
 *
 * Re-exported from the canonical module under this module's historical name so
 * existing session-tool imports keep working; non-finite input is `unknown`.
 */
export { formatRelativeTime as relativeTime } from "../utils/text-format.ts";

/** `$0.015000`; `$?` for a non-finite cost so `NaN` never reaches the output. */
function formatCost(cost: number): string {
  return `$${Number.isFinite(cost) ? cost.toFixed(6) : "?"}`;
}

/** Keep user-supplied text on one output line. */
function collapseLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
}

/** Clip a preview to `max` display columns, ellipsis included, code-point safe. */
function truncate(text: string, max = MAX_TEXT_PREVIEW): string {
  return truncateText(text, max, TEXT_ELLIPSIS);
}

// ── Session tables ──────────────────────────────────────────────────────────

const SESSION_TABLE_HEADERS = ["Session ID", "Title", "Date Range", "Duration"] as const;
const SESSION_LIST_TABLE_HEADERS = [
  "Session ID",
  "Title",
  "Messages",
  "Date Range",
  "Duration",
] as const;

/** `YYYY-MM-DD -> YYYY-MM-DD`; invalid sides degrade to `unknown`. */
function formatDateRange(created: number, updated: number): string {
  return `${formatDate(created).slice(0, 10)} -> ${formatDate(updated).slice(0, 10)}`;
}

/**
 * Markdown table of sessions. `renderMarkdownTable` applies the canonical
 * `escapeMarkdownTableCell` to every cell, so a title containing `|` or a
 * newline stays inside its own row.
 */
export function formatSessionTable(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const rows = sessions.map((session) => [
    session.id,
    session.title || "(untitled)",
    formatDateRange(session.time.created, session.time.updated),
    formatDuration(session.time.updated - session.time.created),
  ]);

  return renderMarkdownTable(SESSION_TABLE_HEADERS, rows);
}

export function formatSessionListTable(
  sessions: SessionInfo[],
  messageCounts: Record<string, number>,
): string {
  if (sessions.length === 0) return "No sessions found.";

  const rows = sessions.map((session) => [
    session.id,
    session.title || "(untitled)",
    String(messageCounts[session.id] ?? 0),
    formatDateRange(session.time.created, session.time.updated),
    formatDuration(session.time.updated - session.time.created),
  ]);

  return renderMarkdownTable(SESSION_LIST_TABLE_HEADERS, rows);
}

// ── Messages ────────────────────────────────────────────────────────────────

export function formatMessages(
  messages: Message[],
  options: {
    includeThinking?: boolean;
    includeToolResults?: boolean;
    roleFilter?: "user" | "assistant";
    toolFilter?: string;
    offset?: number;
  } = {},
): string {
  const { includeThinking, includeToolResults, roleFilter, toolFilter, offset = 0 } = options;

  const parts: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msgIdx = offset + i;
    const { info, parts: msgParts } = messages[i];

    if (roleFilter && info.role !== roleFilter) continue;

    const role = info.role === "user" ? "user" : "assistant";
    const ts = formatDate(info.time.created);
    parts.push(`\n[Message ${msgIdx + 1}] ${role} (${ts})`);

    if (info.role === "assistant" && info.modelID) {
      parts.push(`Model: ${info.providerID}/${info.modelID}`);
      if (typeof info.cost === "number") {
        parts.push(`Cost: ${formatCost(info.cost)}`);
      }
    }

    for (const part of msgParts) {
      switch (part.type) {
        case "text": {
          const tp = part as TextPart;
          if (tp.ignored) break;
          parts.push(truncate(tp.text));
          break;
        }
        case "reasoning": {
          if (!includeThinking) break;
          const rp = part as ReasoningPart;
          parts.push(`> thinking: ${truncate(rp.text)}`);
          break;
        }
        case "tool": {
          const tool = part as ToolPart;
          if (toolFilter && !tool.tool.includes(toolFilter)) break;

          const state = tool.state;
          if (state.status === "pending" || state.status === "running") {
            parts.push(`  [tool: ${tool.tool}] (${state.status})`);
          } else if (state.status === "completed") {
            const cs = state as ToolStateCompleted;
            parts.push(`  [tool: ${tool.tool}] ${cs.title || ""}`);
            if (includeToolResults) {
              parts.push(`    output: ${truncate(String(cs.output))}`);
            }
          } else if (state.status === "error") {
            parts.push(`  [tool: ${tool.tool}] ERROR: ${truncate(state.error)}`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return parts.join("\n");
}

// ── Stats ───────────────────────────────────────────────────────────────────

export function formatStats(stats: SessionStats): string {
  const lines: string[] = [];

  lines.push("### Token Usage");
  const tokenRows: Array<[label: string, value: number]> = [
    ["Input:", stats.totalInputTokens],
    ["Output:", stats.totalOutputTokens],
    ["Reasoning:", stats.totalReasoningTokens],
    ["Cache read:", stats.totalCacheRead],
    ["Cache write:", stats.totalCacheWrite],
  ];
  const labelWidth = tokenRows.reduce((max, [label]) => Math.max(max, displayWidth(label)), 0);
  for (const [label, value] of tokenRows) {
    lines.push(`  ${padDisplayEnd(label, labelWidth)} ${formatCount(value)}`);
  }
  lines.push("");

  lines.push(`Total Cost: ${formatCost(stats.totalCost)}`);
  lines.push("");

  const modelKeys = Object.keys(stats.modelDistribution);
  if (modelKeys.length > 0) {
    lines.push("### Models Used");
    for (const key of modelKeys.sort()) {
      lines.push(`  ${key}: ${formatCount(stats.modelDistribution[key])} messages`);
    }
    lines.push("");
  }

  const toolKeys = Object.keys(stats.toolFrequencies);
  if (toolKeys.length > 0) {
    lines.push("### Tool Usage");
    const sorted = toolKeys.sort(
      (a, b) => stats.toolFrequencies[b] - stats.toolFrequencies[a],
    );
    for (const key of sorted) {
      lines.push(`  ${key}: ${formatCount(stats.toolFrequencies[key])} calls`);
    }
    lines.push("");
  }

  if (stats.diffs.length > 0) {
    lines.push("### File Changes");
    lines.push(`  Files modified: ${formatCount(stats.filesModified)}`);
    lines.push(`  Additions: ${formatCount(stats.totalAdditions)}`);
    lines.push(`  Deletions: ${formatCount(stats.totalDeletions)}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Unified diff ────────────────────────────────────────────────────────────

/** Lines of unchanged context emitted around each change in a hunk. */
const DIFF_CONTEXT_LINES = 3;

/**
 * Guard for the LCS dynamic-programming table.
 *
 * The table holds `(before + 1) * (after + 1)` 32-bit cells, so a large product
 * costs hundreds of megabytes and a visible freeze inside a tool call. Above
 * this bound the diff falls back to a bounded coarse diff: the common prefix
 * and suffix are kept as context and the differing middle becomes one removed
 * block followed by one added block.
 */
const MAX_DIFF_MATRIX_CELLS = 4_000_000;

/** Body lines emitted per file block (hunk headers and markers included). */
const MAX_DIFF_BODY_LINES = 400;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

type DiffKind = "context" | "remove" | "add";

interface DiffOp {
  kind: DiffKind;
  text: string;
  /** 0-based line index in the before content, or -1 for an addition. */
  beforeIndex: number;
  /** 0-based line index in the after content, or -1 for a removal. */
  afterIndex: number;
}

interface HunkRange {
  start: number;
  end: number;
}

/**
 * Split file content into lines, so a terminating `\n` does not add a phantom
 * final empty line. Really empty content is zero lines, not one empty line.
 */
function splitDiffLines(text: string): string[] {
  if (text === "") return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

/** Longest-common-subsequence edit script; see {@link MAX_DIFF_MATRIX_CELLS}. */
function lcsDiffOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  // dp[i * width + j] = LCS length of before[i..] and after[j..].
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        before[i] === after[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "context", text: before[i], beforeIndex: i, afterIndex: j });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: "remove", text: before[i], beforeIndex: i, afterIndex: -1 });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j], beforeIndex: -1, afterIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", text: before[i], beforeIndex: i, afterIndex: -1 });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: after[j], beforeIndex: -1, afterIndex: j });
    j += 1;
  }
  return ops;
}

/**
 * Bounded fallback for inputs past {@link MAX_DIFF_MATRIX_CELLS}: shared prefix
 * and suffix stay context, the middle is one removed block plus one added block.
 */
function coarseDiffOps(before: string[], after: string[]): DiffOp[] {
  const shared = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shared && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: "context", text: before[i], beforeIndex: i, afterIndex: i });
  }
  for (let i = prefix; i < before.length - suffix; i++) {
    ops.push({ kind: "remove", text: before[i], beforeIndex: i, afterIndex: -1 });
  }
  for (let j = prefix; j < after.length - suffix; j++) {
    ops.push({ kind: "add", text: after[j], beforeIndex: -1, afterIndex: j });
  }
  const shift = after.length - before.length;
  for (let i = before.length - suffix; i < before.length; i++) {
    ops.push({ kind: "context", text: before[i], beforeIndex: i, afterIndex: i + shift });
  }
  return ops;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  if (before.length * after.length > MAX_DIFF_MATRIX_CELLS) {
    return coarseDiffOps(before, after);
  }
  return lcsDiffOps(before, after);
}

/** Merge change positions into hunks no more than 2x context lines apart. */
function hunkRanges(ops: DiffOp[]): HunkRange[] {
  const ranges: HunkRange[] = [];
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].kind === "context") continue;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES);
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

interface HunkContext {
  beforePrefix: Int32Array;
  afterPrefix: Int32Array;
  beforeLastIndex: number;
  afterLastIndex: number;
  beforeHasNewline: boolean;
  afterHasNewline: boolean;
}

/** Render one hunk; returns its line count even when `emit` drops lines. */
function renderHunk(
  ops: DiffOp[],
  range: HunkRange,
  context: HunkContext,
  emit: (line: string) => void,
): number {
  const beforePosition = context.beforePrefix[range.start];
  const afterPosition = context.afterPrefix[range.start];
  const beforeCount = context.beforePrefix[range.end + 1] - beforePosition;
  const afterCount = context.afterPrefix[range.end + 1] - afterPosition;

  let count = 0;
  const push = (line: string): void => {
    emit(line);
    count += 1;
  };

  // A zero-count side names the line before the hunk, as unified diff does.
  const beforeStart = beforeCount === 0 ? beforePosition : beforePosition + 1;
  const afterStart = afterCount === 0 ? afterPosition : afterPosition + 1;
  push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);

  for (let index = range.start; index <= range.end; index++) {
    const op = ops[index];
    if (op.kind === "remove") {
      push(`-${op.text}`);
      if (op.beforeIndex === context.beforeLastIndex && !context.beforeHasNewline) {
        push(NO_NEWLINE_MARKER);
      }
    } else if (op.kind === "add") {
      push(`+${op.text}`);
      if (op.afterIndex === context.afterLastIndex && !context.afterHasNewline) {
        push(NO_NEWLINE_MARKER);
      }
    } else {
      push(` ${op.text}`);
      const missingBefore =
        op.beforeIndex === context.beforeLastIndex && !context.beforeHasNewline;
      const missingAfter =
        op.afterIndex === context.afterLastIndex && !context.afterHasNewline;
      if (missingBefore || missingAfter) push(NO_NEWLINE_MARKER);
    }
  }
  return count;
}

/** `null` when the content is unchanged, so unchanged files emit no block. */
function renderFileBlock(diff: FileDiff): string | null {
  const beforeLines = splitDiffLines(diff.before);
  const afterLines = splitDiffLines(diff.after);
  const ops = diffOps(beforeLines, afterLines);
  const ranges = hunkRanges(ops);
  if (ranges.length === 0) return null;

  const beforePrefix = new Int32Array(ops.length + 1);
  const afterPrefix = new Int32Array(ops.length + 1);
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    beforePrefix[index + 1] = beforePrefix[index] + (op.kind === "add" ? 0 : 1);
    afterPrefix[index + 1] = afterPrefix[index] + (op.kind === "remove" ? 0 : 1);
  }

  const context: HunkContext = {
    beforePrefix,
    afterPrefix,
    beforeLastIndex: beforeLines.length - 1,
    afterLastIndex: afterLines.length - 1,
    beforeHasNewline: diff.before.endsWith("\n"),
    afterHasNewline: diff.after.endsWith("\n"),
  };

  const body: string[] = [];
  const emit = (line: string): void => {
    if (body.length < MAX_DIFF_BODY_LINES) body.push(line);
  };
  let total = 0;
  for (const range of ranges) total += renderHunk(ops, range, context, emit);
  if (total > body.length) body.push(`... (${total - body.length} more lines)`);

  return [`--- a/${diff.file}`, `+++ b/${diff.file}`, ...body].join("\n");
}

export function formatDiff(diffs: FileDiff[]): string {
  if (diffs.length === 0) return "No file changes in this session.";

  // Recorded additions/deletions are the session summary's own numbers; the
  // line diff below is presentation only and never recomputes them.
  const totalAdditions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
  const totalDeletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);

  const summary = [
    `Files changed: ${diffs.length}`,
    `Additions: ${formatCount(totalAdditions)}`,
    `Deletions: ${formatCount(totalDeletions)}`,
    "",
  ].join("\n");

  const fileBlocks = diffs
    .map(renderFileBlock)
    .filter((block): block is string => block !== null);

  return summary + fileBlocks.join("\n\n");
}

// ── Search results and todos ────────────────────────────────────────────────

export function formatSearchResults(
  matches: SearchMatch[],
  totalMatches: number,
  sessionCount: number,
): string {
  if (matches.length === 0) return "No matches found.";

  const header = [
    `Found ${totalMatches} match${totalMatches !== 1 ? "es" : ""} across ${sessionCount} session${sessionCount !== 1 ? "s" : ""}`,
    "",
    "---",
    "",
  ].join("\n");

  const perMatch = matches.slice(0, 20).map((match, i) => {
    const ctxBefore = match.contextBefore
      ? `...${collapseLines(match.contextBefore).slice(-80)}`
      : "";
    const ctxAfter = match.contextAfter
      ? `${collapseLines(match.contextAfter).slice(0, 80)}...`
      : "";

    return [
      `[${i + 1}] Session: ${match.sessionID} (${collapseLines(match.sessionTitle)})`,
      `    Message: ${match.messageID} | Role: ${match.role}`,
      `    Context: ${ctxBefore}**${collapseLines(match.text)}**${ctxAfter}`,
    ].join("\n");
  });

  const footer =
    matches.length > 20
      ? `\n... and ${totalMatches - 20} more matches. Use a more specific query.`
      : "";

  return header + perMatch.join("\n\n") + footer;
}

export function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "  No todos for this session.";

  const completed = todos.filter((todo) => todo.status === "completed").length;
  const header = `  ${completed}/${todos.length} completed`;
  const rows = todos.map((todo) => {
    const statusIcon =
      todo.status === "completed"
        ? "[x]"
        : todo.status === "in_progress"
          ? "[~]"
          : "[ ]";
    return `  ${statusIcon} [${todo.priority}] ${collapseLines(todo.content)}`;
  });

  return [header, ...rows].join("\n");
}
