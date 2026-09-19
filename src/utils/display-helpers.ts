/**
 * Shared display utility functions used by both the CLI monitor and TUI sidebar.
 *
 * Pure functions — no side effects, no I/O, no framework imports.
 *
 * @module
 */

import {
  formatDuration as formatDurationText,
  progressBarParts,
  truncateText,
} from "./text-format.ts";

// ── Duration formatting ──────────────────────────────────────────────────

/**
 * Format a millisecond duration as a human-readable string.
 * Returns "?" for invalid or negative inputs.
 *
 * One-line delegation to `formatDuration(…, "monitor")` in `./text-format.ts`.
 */
export function formatDuration(ms: number): string {
  return formatDurationText(ms, "monitor");
}

/**
 * Format a millisecond duration as a compact single-unit string for inline display.
 * Returns "0s" for zero or negative values.
 *
 * One-line delegation to `formatDuration(…, "narrow")` in `./text-format.ts`.
 */
export function compactDuration(ms: number): string {
  return formatDurationText(ms, "narrow");
}

// ── Text helpers ─────────────────────────────────────────────────────────

/**
 * Truncate a string with an ellipsis character ("…") if it exceeds maxLen.
 *
 * One-line delegation to `truncateText` in `./text-format.ts`. CONTRACT
 * CHANGE: `maxLen` is a display-COLUMN budget that includes the ellipsis; at
 * HEAD it budgeted UTF-16 code units. The two agree for ASCII but not for wide
 * characters — CJK and emoji occupy two columns each, so
 * `truncate("你好世界", 3)` is `"你…"`. The column budget is the correct
 * semantic for a terminal width budget and is what makes composition with the
 * padding helpers meaningful.
 */
export function truncate(s: string, maxLen: number): string {
  return truncateText(s, maxLen);
}

/**
 * Shorten a session ID for display. For IDs of 15 characters or more, strips the
 * `ses_` prefix (if present) and shows `first3…last5`. Falls back to the original
 * ellipsis-prefixed-last-8 behavior for shorter IDs.
 */
export function shortSessionId(id: string): string {
  if (id.length < 15) {
    // Original fallback: return as-is if short enough, else …last8
    if (id.length <= 12) return id;
    return "\u2026" + id.slice(-8);
  }
  // For longer IDs: strip ses_ prefix, then show first3…last5
  const stripped = id.startsWith("ses_") ? id.slice(4) : id;
  return stripped.slice(0, 3) + "\u2026" + stripped.slice(-5);
}

// ── Progress bar ─────────────────────────────────────────────────────────

/**
 * Compute the number of filled and empty segments for a progress bar
 * of the given width.
 *
 * One-line delegation to `progressBarParts` in `./text-format.ts`.
 */
export function barSegments(current: number, total: number, width = 6): { filled: number; empty: number } {
  return progressBarParts(current, total, width);
}

// ── Status glyphs ────────────────────────────────────────────────────────

/**
 * Canonical glyph table for status display.
 * Returns just the glyph (caller adds color).
 */
export function statusGlyph(status: string): string {
  switch (status) {
    case "running":   return "\u25b8"; // ▸
    case "completed": return "\u2713"; // ✓
    case "error":     return "\u2717"; // ✗
    case "pending":   return "\u25cf"; // ●
    case "cancelled": return "\u2298"; // ⊘
    case "timeout":   return "\u23f1"; // ⏱
    default:          return "?";
  }
}
