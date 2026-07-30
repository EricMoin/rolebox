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
