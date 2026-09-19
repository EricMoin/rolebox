/**
 * Canonical text, number and terminal-width formatting for rolebox display
 * surfaces: durations, timestamps, byte counts, locale-independent counts,
 * ANSI stripping, display width, truncation/padding, markdown table cells and
 * progress bars.
 *
 * The session browser, CLI monitor, dispatch / graph / LSP duration display
 * paths, the checkpoint list, the download progress renderer and the
 * notification formatter delegate here. These are pure functions: no I/O, no
 * `process`, no imports and no ambient locale — the output is a deterministic
 * function of the arguments.
 *
 * Not every display path delegates here. These still implement their own
 * width, timestamp or duration logic:
 * - `src/terminal/screen-buffer.ts` `charWidth` — a second width table for
 *   screen-buffer cell accounting.
 * - `src/cli/commands/renderer/table-helpers.ts` and
 *   `src/cli/commands/renderer/layout.ts` — UTF-16 code-unit widths composed
 *   with the monitor helpers' column truncation.
 * - `src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx` — an
 *   ambient-locale `toLocaleTimeString` timestamp.
 * - `src/loop/loop-tools.ts`, `src/loop/worker-dispatch.ts` and
 *   `src/loop/coordinator.ts` — seconds-only `toFixed(1)s` duration
 *   renderings.
 *
 * Deliberately still local, because their contract differs from the inclusive
 * display-column budget here:
 * - `src/tui/helpers.ts` `formatTimeAgo` — scales an elapsed duration (`3s`)
 *   and only some callers append their own `" ago"` (`formatIsoAgo` in
 *   `src/tui/components/TaskDetail.tsx` does not); it is not a timestamp
 *   helper.
 * - `src/copilot/transcript.ts` `truncate` — appends the ellipsis *beyond*
 *   `max` (up to `max + 1` UTF-16 code units).
 * - `src/cli/commands/memory/memory-helpers.ts` `truncate` — a UTF-16
 *   code-unit budget whose callers `.padEnd()` afterwards.
 * - `src/graph/engine/approval-payload.ts` `truncateSummary` — a fixed
 *   `slice(0, 200)` with no ellipsis on a structured (non-display) payload.
 *
 * Hardening contract: display paths must never throw and must never render
 * `NaN` or `Infinity` text. Malformed input degrades to a documented fallback.
 *
 * @module
 */

// ── Constants ───────────────────────────────────────────────────────────────

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;

/** Inclusive ECMAScript `Date` range (±100 000 000 days). */
const MAX_DATE_MS = 8.64e15;

// ── Duration ────────────────────────────────────────────────────────────────

/**
 * Display style of {@link formatDuration}.
 *
 * - `"clock"`   — `0s` · `42s` · `1m 5s` · `1h 0m` · `25h 0m` — session tables / inspect
 * - `"monitor"` — `?` · `0ms` · `500ms` · `59s` · `1m` · `1m 1s` · `61m 1s` — CLI monitor + TUI
 * - `"narrow"`  — `0s` · `500ms` · `59s` · `61m` — single-unit inline
 * - `"decimal"` — `?` · `999ms` · `1.0s` · `1m 5s` — engine / loop notifications
 * - `"stall"`   — `?` · `2.5s` · `60.0s` · `1m` · `1m 1s` — stall idle
 * - `"largest"` — `0s` · `42s` · `12m` · `3h` · `2d` — one rounded unit
 */
export type DurationStyle = "clock" | "monitor" | "narrow" | "decimal" | "stall" | "largest";

/**
 * Format a millisecond duration in one of the six display styles.
 *
 * Every style is total: invalid input (non-finite or negative) yields the
 * style's sentinel instead of `NaN`/`Infinity` text. Minutes never roll into
 * hours in `"monitor"` or `"decimal"`; `"clock"` never rolls hours into days.
 *
 * Rounding happens on the raw millisecond value before any unit roll-over, so
 * the last value of a range can round up into the next unit's label: `"stall"`
 * renders 59 999 ms as `60.0s`, `"decimal"` renders it as `60.0s` too,
 * `"largest"` renders 3 599 000 ms as `60m` and 86 399 999 ms as `24h`. Those
 * renderings are pinned by tests and deliberately preserved — `formatBytes` is
 * the only formatter that promotes at its unit boundary.
 */
export function formatDuration(ms: number, style: DurationStyle = "clock"): string {
  const valid = Number.isFinite(ms) && ms >= 0;

  if (style === "clock") {
    if (!valid) return "0s";
    if (ms < MS_IN_MINUTE) return `${Math.floor(ms / MS_IN_SECOND)}s`;
    if (ms < MS_IN_HOUR) {
      return `${Math.floor(ms / MS_IN_MINUTE)}m ${Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND)}s`;
    }
    return `${Math.floor(ms / MS_IN_HOUR)}h ${Math.floor((ms % MS_IN_HOUR) / MS_IN_MINUTE)}m`;
  }

  if (style === "monitor") {
    if (!valid) return "?";
    if (ms < MS_IN_SECOND) return `${ms}ms`;
    if (ms < MS_IN_MINUTE) return `${Math.floor(ms / MS_IN_SECOND)}s`;
    const minutes = Math.floor(ms / MS_IN_MINUTE);
    const seconds = Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  if (style === "narrow") {
    if (!valid || ms === 0) return "0s";
    if (ms < MS_IN_SECOND) return `${ms}ms`;
    if (ms < MS_IN_MINUTE) return `${Math.floor(ms / MS_IN_SECOND)}s`;
    return `${Math.floor(ms / MS_IN_MINUTE)}m`;
  }

  if (style === "decimal") {
    if (!valid) return "?";
    if (ms < MS_IN_SECOND) return `${ms}ms`;
    if (ms < MS_IN_MINUTE) return `${(ms / MS_IN_SECOND).toFixed(1)}s`;
    return `${Math.floor(ms / MS_IN_MINUTE)}m ${Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND)}s`;
  }

  if (style === "stall") {
    if (!valid) return "?";
    if (ms < MS_IN_MINUTE) return `${(ms / MS_IN_SECOND).toFixed(1)}s`;
    const minutes = Math.floor(ms / MS_IN_MINUTE);
    const seconds = Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  if (!valid) return "0s";
  if (ms < MS_IN_MINUTE) return `${Math.round(ms / MS_IN_SECOND)}s`;
  if (ms < MS_IN_HOUR) return `${Math.round(ms / MS_IN_MINUTE)}m`;
  if (ms < MS_IN_DAY) return `${Math.round(ms / MS_IN_HOUR)}h`;
  return `${Math.round(ms / MS_IN_DAY)}d`;
}

// ── Timestamps ──────────────────────────────────────────────────────────────

/**
 * Format an epoch-millisecond timestamp as `YYYY-MM-DD HH:mm:ss` in UTC.
 *
 * Never throws: a non-finite value or one outside the ECMAScript `Date` range
 * returns `fallback` instead of raising `RangeError: Invalid Date`. Negative
 * epochs render normally.
 */
export function formatTimestamp(ms: number, fallback = "unknown"): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return fallback;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/**
 * Format an epoch-millisecond timestamp relative to `now`, e.g. `"5s ago"`.
 *
 * A non-finite `ms` (or non-finite derived delta) returns `"unknown"`; any
 * delta below one second — including future timestamps — is `"just now"`.
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "unknown";
  const diff = now - ms;
  if (!Number.isFinite(diff)) return "unknown";
  if (diff < MS_IN_SECOND) return "just now";
  if (diff < MS_IN_MINUTE) return `${Math.floor(diff / MS_IN_SECOND)}s ago`;
  if (diff < MS_IN_HOUR) return `${Math.floor(diff / MS_IN_MINUTE)}m ago`;
  if (diff < MS_IN_DAY) return `${Math.floor(diff / MS_IN_HOUR)}h ago`;
  const days = Math.floor(diff / MS_IN_DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * Format a byte count with binary (`1024`) units by default, e.g. `1.2MB`.
 *
 * The suffix is attached without a space. Non-finite input yields `invalid`;
 * negative input is clamped to `0B`. Pass `binary: false` for decimal
 * (`1000`) scaling with the same unit labels.
 *
 * A value that rounds up to the next unit is promoted, so `1048575` renders
 * `1.0MB` rather than `1024KB`; the largest known unit is never promoted past
 * it (`1024 ** 5` stays `1024TB`).
 */
export function formatBytes(
  bytes: number,
  opts: { binary?: boolean; invalid?: string } = {},
): string {
  const binary = opts.binary ?? true;
  const invalid = opts.invalid ?? "?";
  if (!Number.isFinite(bytes)) return invalid;

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const base = binary ? 1024 : 1000;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}B`;

  // Promote when the *rendered* magnitude reaches the base, so 1048575
  // (1023.999… KiB) renders "1.0MB" instead of the nonsensical "1024KB".
  let rendered = renderScaledBytes(value);
  if (Number(rendered) >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
    rendered = renderScaledBytes(value);
  }
  return `${rendered}${units[unit]}`;
}

/** Whole units at 100+, one decimal below — the historical byte rendering. */
function renderScaledBytes(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * Format a number with `,` thousands separators, e.g. `1,234,567`.
 *
 * Fractional digits are preserved verbatim when they render in plain decimal
 * notation (`1234.5` → `1,234.5`). A magnitude below 1 whose fraction renders
 * in exponential notation contributes no tail, so the grouped integer part is
 * emitted instead (`1e-7` → `0`, never `0e-7`).
 *
 * Deterministic and locale-independent — deliberately not `toLocaleString`.
 * Non-finite input yields `invalid`.
 */
export function formatCount(n: number, opts: { invalid?: string } = {}): string {
  const invalid = opts.invalid ?? "?";
  if (!Number.isFinite(n)) return invalid;

  const negative = n < 0;
  const abs = Math.abs(n);
  const integer = Math.floor(abs);
  const fraction = abs - integer;
  const digits = String(integer);
  if (digits.includes("e") || digits.includes("E")) {
    return `${negative ? "-" : ""}${digits}`;
  }

  let grouped = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ",";
    grouped += digits[i];
  }
  // String(fraction) is "0.5"-shaped for ordinary fractions but "1e-7" for a
  // tiny magnitude; slicing the latter would emit a bogus "e-7" tail.
  const fractionText = String(fraction);
  const tail = fraction > 0 && fractionText.startsWith("0.") ? fractionText.slice(1) : "";
  const magnitude = `${grouped}${tail}`;
  // A magnitude that rounds to zero carries no sign (matches formatCount(-0)).
  if (magnitude === "0") return "0";
  return `${negative ? "-" : ""}${magnitude}`;
}

// ── ANSI ────────────────────────────────────────────────────────────────────

/**
 * OSC payload: `ESC ]` up to BEL, ST (`ESC \`) or end of input.
 * Placed before the CSI branch below because that branch matches (and therefore
 * mangles) a payload-bearing OSC prefix.
 */
const ANSI_OSC = "\\u001B\\][^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C|$)";

/**
 * The proven CSI + 2-character pattern from `src/terminal/session-registry.ts`.
 * Adopted verbatim; it covers `ESC [ … final`, `ESC ( B` and `ESC ] … BEL`
 * with an empty payload.
 */
const ANSI_CSI = "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";

const ANSI_RE = new RegExp(`${ANSI_OSC}|${ANSI_CSI}`, "g");
/** Sticky twin of {@link ANSI_RE} for single-pass tokenisation. */
const ANSI_AT_RE = new RegExp(ANSI_RE.source, "y");

/**
 * Remove ANSI escape sequences: CSI, OSC (BEL- or ST-terminated) and
 * two-character escapes. Single pass, no backtracking blowup.
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

// ── Display width ───────────────────────────────────────────────────────────

type Range = readonly [number, number];

/** East-Asian Wide/Fullwidth and emoji blocks. */
const WIDE_RANGES: readonly Range[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const COMBINING_RANGES: readonly Range[] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

function codePointWidth(cp: number): number {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (cp >= 0x200b && cp <= 0x200f) return 0;
  if (cp === 0x2060 || cp === 0xfeff) return 0;
  if (inRanges(cp, COMBINING_RANGES)) return 0;
  return inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

/**
 * Count the terminal columns of an ANSI-stripped string.
 *
 * Targets terminal alignment, not full UAX #11: combining marks and zero-width
 * characters count 0, C0/C1 controls count 0, East-Asian Wide/Fullwidth and
 * emoji blocks count 2, everything else counts 1. Ambiguous-width characters
 * count 1.
 */
export function displayWidth(input: string): number {
  let width = 0;
  for (const ch of stripAnsi(input)) width += codePointWidth(ch.codePointAt(0) as number);
  return width;
}

interface Unit {
  text: string;
  width: number;
  next: number;
}

/** One ANSI sequence (width 0) or one whole code point starting at `index`. */
function unitAt(input: string, index: number): Unit {
  ANSI_AT_RE.lastIndex = index;
  const match = ANSI_AT_RE.exec(input);
  if (match !== null && match[0].length > 0) {
    return { text: match[0], width: 0, next: index + match[0].length };
  }
  const cp = input.codePointAt(index) as number;
  const text = String.fromCodePoint(cp);
  return { text, width: codePointWidth(cp), next: index + text.length };
}

/** Longest prefix of whole code points (never a split escape) within `columns`. */
function takeColumns(input: string, columns: number): { text: string; hasBase: boolean } {
  let text = "";
  let width = 0;
  let hasBase = false;
  let index = 0;
  while (index < input.length) {
    const unit = unitAt(input, index);
    if (width + unit.width > columns) break;
    text += unit.text;
    width += unit.width;
    if (unit.width > 0) hasBase = true;
    index = unit.next;
  }
  return { text, hasBase };
}

/**
 * Truncate to `maxWidth` display columns, ellipsis included.
 *
 * Three budget cases: `+Infinity` means "no truncation" and returns the input
 * unchanged; `NaN`, `-Infinity` and any value `<= 0` return `""`; a finite
 * positive budget clips to whole display columns.
 *
 * Never splits a surrogate pair and never leaves a dangling ZWJ or an
 * unattached combining mark. ANSI sequences are preserved and cost no columns.
 * When the ellipsis alone already fills the budget the clipped ellipsis is
 * returned.
 */
export function truncateText(input: string, maxWidth: number, ellipsis = "\u2026"): string {
  if (maxWidth === Number.POSITIVE_INFINITY) return input;
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return "";
  if (displayWidth(input) <= maxWidth) return input;

  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return takeColumns(ellipsis, maxWidth).text;

  const taken = takeColumns(input, maxWidth - ellipsisWidth);
  let text = taken.text;
  if (!taken.hasBase) text = "";
  while (text.endsWith("\u200d")) text = text.slice(0, -1);
  return text + ellipsis;
}

/**
 * Hard cap on the spaces or bar glyphs one call may emit. A hostile width
 * (`Number.MAX_SAFE_INTEGER`) must not drive `String.repeat` into an unbounded
 * allocation, so the emitted padding is clamped to this many columns.
 */
const MAX_DISPLAY_PAD = 10_000;

/**
 * Pad with spaces on the right until `displayWidth` reaches `width`.
 * Never truncates; `width <= 0` (or non-finite) returns the input unchanged.
 * The padding emitted by one call is clamped to {@link MAX_DISPLAY_PAD}
 * columns, so a hostile width returns a bounded string instead of throwing.
 */
export function padDisplayEnd(input: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return input;
  const padding = Math.min(MAX_DISPLAY_PAD, Math.ceil(width - displayWidth(input)));
  return padding > 0 ? input + " ".repeat(padding) : input;
}

/**
 * Pad with spaces on the left until `displayWidth` reaches `width`.
 * Never truncates; `width <= 0` (or non-finite) returns the input unchanged.
 * The padding emitted by one call is clamped to {@link MAX_DISPLAY_PAD}
 * columns, so a hostile width returns a bounded string instead of throwing.
 */
export function padDisplayStart(input: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return input;
  const padding = Math.min(MAX_DISPLAY_PAD, Math.ceil(width - displayWidth(input)));
  return padding > 0 ? " ".repeat(padding) + input : input;
}

// ── Markdown tables ─────────────────────────────────────────────────────────

/**
 * Make a value safe as a single markdown table cell: `\` and `|` are escaped
 * (backslash first, so a literal `\|` round-trips), newlines become `<br>`,
 * TAB becomes a space and remaining C0/C1 controls are dropped.
 *
 * The guarantee is row structure only: raw HTML and other markdown syntax are
 * intentionally passed through unchanged, so a cell can never add or remove a
 * table column but may still render as markup.
 */
export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/**
 * Render a GitHub-flavoured markdown table.
 *
 * Every cell is escaped with {@link escapeMarkdownTableCell}. Rows shorter than
 * `headers` are padded with empty cells; extra cells are clipped. An empty
 * header list returns `""`. The result has no trailing newline.
 */
export function renderMarkdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (headers.length === 0) return "";
  const lines = [
    `| ${headers.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < headers.length; i++) {
      cells.push(escapeMarkdownTableCell(row[i] ?? ""));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

// ── Progress bars ───────────────────────────────────────────────────────────

/** Filled and empty segment counts of a progress bar. */
export interface ProgressParts {
  filled: number;
  empty: number;
}

/**
 * Segment counts for a bar of `width` characters.
 *
 * A zero, negative or non-finite `total` — and any non-finite `current` —
 * yields an empty bar, so `0/0` and `NaN/5` can never render as complete.
 * Negative widths clamp to 0; fractional widths truncate. The width is capped
 * at {@link MAX_DISPLAY_PAD} so a hostile width cannot drive the unbounded
 * `String.repeat` in {@link progressBar}.
 */
export function progressBarParts(current: number, total: number, width = 6): ProgressParts {
  const size = Number.isFinite(width)
    ? Math.min(MAX_DISPLAY_PAD, Math.max(0, Math.trunc(width)))
    : 0;
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return { filled: 0, empty: size };
  }
  const filled = Math.min(size, Math.max(0, Math.round((current / total) * size)));
  return { filled, empty: size - filled };
}

/**
 * Draw a progress bar, e.g. `■■■□□□` for `5/10` at width 6.
 *
 * Glyphs default to `■` and `□`; see {@link progressBarParts} for the
 * invalid-input behaviour.
 */
export function progressBar(
  current: number,
  total: number,
  width = 10,
  glyphs: { filled?: string; empty?: string } = {},
): string {
  const { filled, empty } = progressBarParts(current, total, width);
  return (glyphs.filled ?? "\u25a0").repeat(filled) + (glyphs.empty ?? "\u25a1").repeat(empty);
}
