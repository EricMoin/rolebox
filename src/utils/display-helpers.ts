/**
 * Shared display utility functions used by both the CLI monitor and TUI sidebar.
 *
 * Pure functions — no side effects, no I/O, no framework imports.
 *
 * @module
 */

// ── Duration formatting ──────────────────────────────────────────────────

/**
 * Format a millisecond duration as a human-readable string.
 * Returns "?" for invalid or negative inputs.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Format a millisecond duration as a compact single-unit string for inline display.
 * Returns "0s" for zero or negative values.
 */
export function compactDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

// ── Text helpers ─────────────────────────────────────────────────────────

/**
 * Truncate a string with an ellipsis character ("…") if it exceeds maxLen.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
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
 */
export function barSegments(current: number, total: number, width = 6): { filled: number; empty: number } {
  if (total <= 0) return { filled: 0, empty: width };
  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
  return { filled, empty: width - filled };
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
