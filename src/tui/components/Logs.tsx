/**
 * TUI Logs view — the live pane over the platform's own log files.
 *
 * One record is ONE LINE, rendered through the runtime's own line format
 * (`formatLogLine`, src/log/sinks/console.ts): the same `[level] channel code
 * scope fields — message` a console reader sees is what the pane shows, so the
 * TUI never invents a second dialect for the same record. Colour is added on
 * TOP of that fact rather than in place of it: the level word is always in the
 * line (the runtime wrote it there) and it is also the glyph in front of it, so
 * the severity survives a monochrome terminal, a screenshot and a copy-paste.
 *
 * WHAT THE PANE SAYS ABOUT ITSELF. A live reader has to distinguish four facts
 * that all look like an empty pane: "nothing has been logged yet", "the filter
 * hides everything", "the read failed" and "the stream is paused". The first two
 * are one sentence each, the third names the error and keeps the last good
 * records on screen, and the pause is a standing `PAUSED` marker in the header —
 * a frozen pane that does not say it is frozen is a bug report waiting to
 * happen.
 *
 * ONE ROW PER RECORD, ALWAYS. A record line is longer than the 40-cell sidebar
 * and its message can be arbitrarily long, so {@link renderLogRecordLine}
 * composes the row until it fits: the whole line when it already does, the head
 * plus a middle-cut message when it does not, and a head with its trailing
 * `k=v` segments dropped whole when the message must not shrink further. Every
 * step is bounded by the cell budget, so the pane never needs a second row for
 * one record and a reader can count records by counting rows.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import type { LogLevel, LogRecord } from "../../log/types.ts";
import { formatLogLine } from "../../log/sinks/console.ts";
import type { RGBA } from "@opentui/core";
import type { ThemeColors } from "../helpers.ts";
import { truncate, BOLD, DIM, DIM_ITALIC, G_SUB } from "../helpers.ts";
import { ELLIPSIS, INDENT, RULE_WIDTH_NARROW, SIDEBAR_WIDTH, truncateMiddle, valueBudget } from "../layout.ts";
import { logsLevelColor, logsStatusText, type LogsStatusCounts, type LogsViewMode } from "../logs.ts";
import { LOGS_LEVEL_LOOSER_KEY, LOGS_PAUSE_KEY, LOGS_TOGGLE_KEY } from "../logic.ts";

// ── Standing copy ────────────────────────────────────────────────────────

/**
 * Every sentence below that names a KEY builds it from `logic.ts`'s constant,
 * and the keymap layer in `src/tui/index.tsx` registers those same constants: an
 * instruction and the binding it describes are one fact, not two spellings that
 * drift apart (a pane that says `Space` above a `ctrl+p` binding is worse than
 * one that says nothing).
 */

/** The banner a pane shows while the stream is frozen. */
export const LOGS_PAUSED_BANNER = `PAUSED — ${LOGS_PAUSE_KEY} resumes at this position`;

/** The sentence an empty, healthy pane shows. */
export const LOGS_EMPTY_TEXT = "no records yet — waiting for the first write";

/** The line a collapsed pane shows, naming the key that opens the view. */
export const LOGS_HIDDEN_TEXT = `hidden — press ${LOGS_TOGGLE_KEY} to open`;

/** The sentence an empty pane shows when its own filter is what hides the records. */
export const LOGS_EMPTY_FILTERED_TEXT = `nothing matches this filter — ${LOGS_LEVEL_LOOSER_KEY} lowers the level`;

/** The label a read failure is announced with. */
export const LOGS_ERROR_LABEL = "log read failed";

/** The field prefix the reader's page carries when older records were not delivered. */
export const LOGS_TRUNCATED_MARK = `${ELLIPSIS} older records not shown`;

/** The glyph a line is prefixed with, per level. Always visible, colour or not. */
const LEVEL_GLYPHS: Readonly<Record<LogLevel, string>> = {
  debug: G_SUB,
  info: G_SUB,
  warn: "!",
  error: "x",
  fatal: "!",
};

// ── Level visuals ────────────────────────────────────────────────────────

/** The single-cell glyph a level is marked with; an unknown word gets the neutral one. */
export function levelGlyph(level: string): string {
  return LEVEL_GLYPHS[level as LogLevel] ?? G_SUB;
}

/** The theme colour a level is painted with, falling back down the palette. */
export function levelColor(level: string, c: ThemeColors): RGBA {
  switch (level) {
    case "fatal":
    case "error":
      return c.error;
    case "warn":
      return c.warning;
    case "debug":
      return c.textMuted;
    default:
      return c.info;
  }
}

// ── Colour ───────────────────────────────────────────────────────────────
//
// Every `fg` below is the theme's own RGBA value, NOT a CSS string. The
// sibling components build colours with `rgbaToCSS` (`"rgb(r,g,b)"`), which this
// `@opentui/core` build cannot read: `parseColor` maps a string through
// `hexToRgb` and nothing else, so an `rgb(...)` value is logged as an invalid
// hex colour and replaced with magenta — measured here, 30 warnings for one
// painted pane, i.e. every coloured span in it. An RGBA passes `parseColor`
// through untouched. Colour is never the only signal either way (the level
// WORD and its glyph are in the line), so this changes how the pane looks and
// not what it says.

// ── Pure line helpers (exported so the layout is pinned by a test) ────────

/**
 * Split the runtime's own line at its message: the HEAD is everything
 * `formatLogLine` wrote before the em dash (level, channel, code, scope,
 * fields) and the TAIL is the message.
 *
 * The head is never shortened, because every part of it is structured data an
 * operator greps for by name: cutting inside it once produced a real frame
 * reading `reason="writer` / `busy" — a truncated value that reads like the
 * record's actual content. The message is the one free-text part, so the
 * message is what gives way. A record whose head alone overflows the pane falls
 * back to the mid-cut, which is the only shape left when there is nothing left
 * to sacrifice.
 */
export function splitLogLine(record: LogRecord): { head: string; message: string } {
  const line = formatLogLine(record);
  const at = line.lastIndexOf(" \u2014 ");
  if (at <= 0) return { head: line, message: "" };
  return { head: line.slice(0, at), message: line.slice(at + 3) };
}

/**
 * Drop whole SPACE-SEPARATED segments from the END of `head` until the head AND
 * its mark fit `budget` — the ellipsis is a cell, so the marked head has to fit
 * `budget - 1` — then append the mark.
 *
 * The head's parts are one unbreakable token each (`channel`, `code`,
 * `k=value`), and a `k=value` cut in the middle is a LIE about the record: a
 * real frame from this pane read `reason="writer` / `busy"`, which an operator
 * reads as two values. Dropping a segment loses a field honestly instead. When
 * even the first segment does not fit there is nothing left to drop, so the
 * value is character-truncated — with the ellipsis, never a silent cut.
 */
function fitHead(head: string, budget: number): string {
  if (head.length <= budget) return head;
  if (budget <= 0) return "";
  const segments = head.split(" ");
  if (segments[0] !== head) {
    // THE ELLIPSIS IS PART OF THE BUDGET. It is a display cell like every other
    // character here, so a head with dropped segments has to fit inside
    // `budget - 1` cells BEFORE the mark is appended. Without that reservation
    // the composed row is one cell too wide — measured at 37 cells for the
    // production budget of 36 — and the pane wraps one record onto two rows,
    // breaking the one structural promise this module makes.
    let kept = head;
    while (kept.length + ELLIPSIS.length > budget && kept.includes(" ")) {
      kept = kept.slice(0, kept.lastIndexOf(" "));
    }
    if (kept.length + ELLIPSIS.length <= budget) return kept + ELLIPSIS;
  }
  return truncateMiddle(head, budget, Math.max(1, budget - 1));
}

/**
 * The least room a shortened row leaves for the MESSAGE before another head
 * field is sacrificed instead.
 *
 * Without a floor the row can spend its last cells on one more `k=v` and cut the
 * message to a bare `…` — measured as `[error] graph:host settle.threw… — …`,
 * a row that names the event and hides what happened. The message is the free
 * text an operator actually reads, so a candidate that leaves it less than this
 * is only used when no candidate can do better.
 */
const MIN_MESSAGE_CELLS = 8;

/**
 * Compose the structured head with the message inside `width`.
 *
 * THE ORDER OF CONCESSIONS, which is the whole rule:
 *
 *   1. the whole head and the whole message, separated by the runtime's em dash;
 *   2. the whole head and as much of the message as fits, cut in the MIDDLE so
 *      both ends of what the record says survive;
 *   3. a head with its trailing `k=v` segments dropped WHOLE, the message cut
 *      into what is left — dropping a segment loses a field honestly, while a
 *      `k=value` cut in half claims a value the record never had (a measured
 *      frame from this pane read `reason="writer` / `busy"`);
 *   4. the head alone, if even that has to give.
 *
 * THE MESSAGE HAS A FLOOR — {@link MIN_MESSAGE_CELLS} cells. A candidate head is
 * only accepted while the message still gets that much room, so a row cannot buy
 * one more `k=v` with the whole message. When no candidate reaches the floor, the
 * one with the most room wins.
 *
 * The level word and the channel are the head's first two segments and the last
 * things to go, so the reader always knows what happened and where.
 */

function composeLogLine(head: string, message: string, width: number): string {
  if (width <= 0) return "";
  const separator = " \u2014 ";
  if (message.length === 0) return fitHead(head, width);
  const segments = head.split(" ");
  // As MANY head segments as fit while the message still gets MIN_MESSAGE_CELLS;
  // when nothing reaches the floor, the candidate with the most room wins, so the
  // message is never cut to nothing while a field could have given way.
  let fallback: { readonly candidate: string; readonly room: number } | null = null;
  for (let keep = segments.length; keep >= 1; keep -= 1) {
    const candidate = segments.slice(0, keep).join(" ") + (keep < segments.length ? ELLIPSIS : "");
    const room = width - candidate.length - separator.length;
    if (room < 1) continue;
    if (room >= message.length) return candidate + separator + message;
    if (room >= MIN_MESSAGE_CELLS) return candidate + separator + truncateMiddle(message, room, Math.ceil(room / 2));
    if (fallback === null || room > fallback.room) fallback = { candidate, room };
  }
  if (fallback !== null) {
    return fallback.candidate + separator + truncateMiddle(message, fallback.room, Math.ceil(fallback.room / 2));
  }
  return fitHead(head, width);
}

/**
 * The one line a record renders as: the runtime's own format, shortened when it
 * does not fit `width`.
 *
 * A line that already fits passes through untouched — this function is the
 * identity on every record a terminal this size can hold, which is what makes
 * "one format" a fact and not a hope. When it does not fit, {@link composeLogLine}
 * decides what gives way, and the level word always survives: it is the first
 * thing `formatLogLine` writes.
 */
export function renderLogRecordLine(record: LogRecord, width: number): string {
  const line = formatLogLine(record);
  if (width <= 0 || line.length <= width) return line;
  const { head, message } = splitLogLine(record);
  return composeLogLine(head, message, width);
}

/** The `level` filter segment, e.g. `>=(warn)`; `all` for the permissive end. */
export function levelFilterSegment(level: string): string {
  return `>=(${level})`;
}

/**
 * The channel segment: `all`, or the one channel with `+N` for the rest.
 *
 * The pane's filter is a single channel today (`c` cycles it), so the extra
 * count is what tells a reader that more channels exist than the one shown.
 */
export function channelSegment(channels: readonly string[], available: number): string {
  const first = channels[0];
  if (first === undefined) return "all";
  const extra = Math.max(0, available - channels.length);
  return extra > 0 ? `${first} +${extra}` : first;
}

/** `2 skipped` / `1 skipped · 3 dropped` — the reader's and the cap's counters, or "". */
export function counterSegment(skippedLines: number, dropped: number): string {
  const parts: string[] = [];
  if (skippedLines > 0) parts.push(`${skippedLines} skipped`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  return parts.join(` ${G_SUB} `);
}

/** Compose a `label value` segment, or "" when the value is blank. */
function segment(label: string, value: string): string {
  return value.length > 0 ? `${label} ${value}` : "";
}

// ── Component ────────────────────────────────────────────────────────────

/** Props of {@link renderLogs}. */
export interface LogsProps {
  readonly c: ThemeColors;
  /** Widen the pane to the full sidebar width instead of the narrow rule width. */
  readonly wide: boolean;
  /** True when the Logs view is the active tab. */
  readonly open: boolean;
  /** True when the view was frozen — by the Pause key or because it is not shown. */
  readonly paused: boolean;
  /** The level threshold as a word (`debug`…`fatal`). */
  readonly minLevel: string;
  /** The active channel filters; empty means every channel. */
  readonly channels: readonly string[];
  /** Every channel the source currently holds, for the `+N` count and the cycle. */
  readonly availableChannels: readonly string[];
  /** The resolved location the last answer was read from, or `null` before the first. */
  readonly source: string | null;
  /** The records to show, oldest first. */
  readonly records: readonly LogRecord[];
  /** Malformed lines the reader skipped in the last answer. */
  readonly skippedLines: number;
  /** Records the free-text filter matched out of the buffer. */
  readonly shown: number;
  /** Records the buffer holds, matching or not. */
  readonly total: number;
  /** Records the cap dropped since the last reset. */
  readonly dropped: number;
  /** Records the cap dropped before the last reset. */
  readonly earlierDropped: number;
  /** True when the last answer held more records than one poll delivers. */
  readonly pending: boolean;
  /** The message of a failed read, or `null`. */
  readonly error: string | null;
  /** The free-text filter currently applied, for the empty-state sentence. */
  readonly filterText: string;
}

/**
 * The Logs pane body. Always renders its header — a surface that vanishes when
 * the data is missing leaves the reader unable to tell "nothing to show" from
 * "the pane is gone" — and one block per distinct fact after it.
 *
 * TWO STRUCTURAL RULES, both measured on this component against
 * `@opentui/solid`'s headless renderer and neither visible in the types:
 *
 *   1. every block lives inside ONE `<box>`. A bare fragment at the root does
 *      not work here: the library inserts a component's children into the
 *      parent renderable, and a fragment leaves them without one.
 *   2. a conditional block is guarded by JSX (`{cond && (<text>…</text>)}`) or
 *      sits inside such a guard — never as a bare `<Show when={false}>` under
 *      the box. With a false condition at mount the library inserts an EMPTY
 *      text node into the box and throws `Orphan text error: "" must have a
 *      <text> as a parent`; the `&&` guard keeps the false branch from being a
 *      node at all.
 */
export function renderLogs(props: LogsProps) {
  const c = props.c;
  const width = props.wide ? SIDEBAR_WIDTH : RULE_WIDTH_NARROW;
  const status: LogsStatusCounts = {
    shown: props.shown,
    total: props.total,
    dropped: props.dropped,
    earlierDropped: props.earlierDropped,
    pending: props.pending,
    skippedLines: props.skippedLines,
  };
  const filtered = props.filterText.trim().length > 0;
  const view: LogsViewMode = props.open ? (props.paused ? "paused" : "open") : "hidden";

  return (
    <box>
      <text>
        <span fg={c.primary} attributes={BOLD}>{"Logs"}</span>
        <span fg={c.textMuted} attributes={DIM}>{INDENT + "level " + props.minLevel}</span>
        <span fg={c.textMuted} attributes={DIM}>{INDENT + "chan " + channelSegment(props.channels, props.availableChannels.length)}</span>
      </text>

      {!props.open && (
        <text fg={c.textMuted} attributes={DIM_ITALIC}>{INDENT + LOGS_HIDDEN_TEXT}</text>
      )}

      {props.open && props.paused && (
        <text fg={c.warning} attributes={BOLD}>{INDENT + LOGS_PAUSED_BANNER}</text>
      )}

      {props.open && (
        <text fg={c.textMuted} attributes={DIM}>
          {/* The tail of a path is the part that distinguishes one source from
              another (`…/rolebox/.rolebox/logs`), so the source is cut in the
              MIDDLE: a right-truncation drops exactly the directory name a
              reader compares, and this line exists to answer "where is this
              pane reading?". The `src ` label is the head and is not cut
              (`valueBudget(width, INDENT.length + 4)` reserves its four cells). */}
          {INDENT + segment("src", truncateMiddle(props.source ?? "resolving" + ELLIPSIS, valueBudget(width, INDENT.length + 4), 0))}
        </text>
      )}

      {props.open && props.error !== null && (
        <text fg={c.error}>
          {INDENT + truncate(LOGS_ERROR_LABEL + ": " + (props.error ?? ""), valueBudget(width, INDENT.length))}
        </text>
      )}

      {props.open && (
        <text fg={c.textMuted} attributes={DIM}>{INDENT + logsStatusText(status) + (view === "paused" ? " (held)" : "")}</text>
      )}

      {props.open && props.records.length === 0 && props.error === null && (
        <text fg={c.textMuted} attributes={DIM_ITALIC}>
          {INDENT + (filtered ? LOGS_EMPTY_FILTERED_TEXT : LOGS_EMPTY_TEXT)}
        </text>
      )}

      {props.open && props.records.length > 0 && (
        <For each={props.records}>
          {(record) => {
            const line = renderLogRecordLine(record, valueBudget(width, INDENT.length + 2));
            return (
              <text>
                <span fg={c.textMuted} attributes={DIM}>{INDENT}</span>
                <span fg={c[logsLevelColor(record.level)] ?? c.text} attributes={BOLD}>{levelGlyph(record.level) + " "}</span>
                <span fg={c.text}>{line}</span>
              </text>
            );
          }}
        </For>
      )}
    </box>
  );
}
