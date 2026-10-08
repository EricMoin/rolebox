/**
 * Narrow-sidebar layout primitives.
 *
 * Pure layout constants and helpers — no UI-framework reactivity, no I/O.
 * This is the single source of truth for the label/value + truncation
 * convention consumed by the narrow-sidebar components (subtasks 3–7).
 *
 * @module
 */

import { truncate } from "../utils/display-helpers";

// ── Narrow-sidebar constants ────────────────────────────────────────────

/** Total usable width (in display cells) of the narrow sidebar. */
export const SIDEBAR_WIDTH = 40;

/** Width of a full-width horizontal rule inside the narrow sidebar. */
export const RULE_WIDTH_NARROW = 28;

/** Indent used for secondary/dimmed rows that nest under a primary row. */
export const INDENT = "  ";

/** Width, in display cells, of a single status glyph. */
export const GLYPH_CELLS = 1;

/** Default per-value cell budget inside the narrow sidebar. */
export const VALUE_BUDGET = 22;

/**
 * The one character every truncation in this module ends a cut with.
 *
 * A single DISPLAY CELL in every font the sidebar relies on, so `truncate` and
 * {@link truncateMiddle} can promise a cell budget and not an approximation.
 */
export const ELLIPSIS = "\u2026";

// ── Pure helpers ────────────────────────────────────────────────────────

/**
 * Remaining cells available for a value after reserving cells for labels,
 * indentation, glyphs, or other fixed columns.
 *
 * Negative results (when reserved exceeds total) are clamped to zero — a value
 * never receives a negative budget.
 */
export function valueBudget(totalCells: number, reservedCells: number): number {
  return Math.max(0, totalCells - reservedCells);
}

/**
 * Truncate from the MIDDLE, keeping `head` display cells of the front and the
 * rest of the budget on the tail, with a single `…` between them.
 *
 * This is the layout's second truncation convention and it exists for one
 * reason: a log line's two informative ends are its PREFIX (level and channel)
 * and its MESSAGE, while the middle is the least interesting part. Plain
 * right-truncation would throw the message away, and showing an unbounded line
 * would wrap in a 40-cell sidebar. A value that already fits is returned
 * unchanged; a budget of zero cells answers "" and never a bare ellipsis.
 */
export function truncateMiddle(value: string, maxCells: number, headCells = 0): string {
  if (maxCells <= 0) return "";
  if (value.length <= maxCells) return value;
  if (maxCells === 1) return ELLIPSIS;
  const head = Math.max(0, Math.min(headCells, maxCells - 1));
  const tail = Math.max(0, maxCells - 1 - head);
  return value.slice(0, head) + ELLIPSIS + (tail > 0 ? value.slice(value.length - tail) : "");
}

/**
 * Hard-wrap a string into lines of at most `width` display cells, breaking at
 * the last space when there is one and mid-token otherwise. A width below 2 is
 * clamped to 2 so progress is always made and the walk terminates.
 */
export function wrapCells(value: string, width: number): string[] {
  const budget = Math.max(2, Math.floor(width));
  const lines: string[] = [];
  let rest = value;
  while (rest.length > budget) {
    const space = rest.lastIndexOf(" ", budget);
    const cut = space > 0 ? space : budget;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

/**
 * Compose a lowercase `'label: '` prefix with a value, truncating the value
 * (via `truncate`) so the composed string fits `totalBudget`.
 *
 * The value is given `totalBudget - (label.length + 2)` cells (the `2` accounts
 * for the `': '` separator). When that budget is zero or negative the value is
 * omitted and only the label prefix is returned.
 */
export function labelValue(label: string, value: string, totalBudget: number): string {
  const prefix = `${label}: `;
  const valueCells = valueBudget(totalBudget, prefix.length);
  const displayValue = valueCells > 0 ? truncate(value, valueCells) : "";
  return `${prefix}${displayValue}`;
}
