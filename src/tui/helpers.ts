/**
 * TUI helper functions and constants.
 *
 * Pure utilities shared across the TUI plugin — no SolidJS reactivity.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import type { RGBA } from "@opentui/core";
import { formatDuration, truncate, shortSessionId, barSegments } from "../utils/display-helpers";
import { buildSessionScope } from "../utils/session-scope";

export { formatDuration, truncate, shortSessionId, barSegments, buildSessionScope };

// ── Types ────────────────────────────────────────────────────────────────

export type ThemeColors = Record<string, RGBA>;
export type HealthState = "ACTIVE" | "IDLE" | "NO_STATE" | "STALE" | "ERROR";

// ── Constants ────────────────────────────────────────────────────────────

export const REFRESH_MS = 1000;
export const MAX_DISPATCH_ROWS = 6;
export const MAX_GRAPH_ROWS = 2;
export const MAX_LOOP_ROWS = 3;
export const MAX_FN_ROWS = 4;
export const BAR_WIDTH = 6;
export const RULE_WIDTH = 36;

export const BOLD = TextAttributes.BOLD;
export const DIM = TextAttributes.DIM;
export const ITALIC = TextAttributes.ITALIC;
export const UNDERLINE = TextAttributes.UNDERLINE;
export const DIM_ITALIC = DIM | ITALIC;

// ── Glyphs ───────────────────────────────────────────────────────────────

export const G_RUNNING  = "\u25b8"; // ▸
export const G_PENDING  = "\u25cf"; // ●
export const G_ERROR    = "\u2717"; // ✗
export const G_DONE     = "\u2713"; // ✓
export const G_CANCEL   = "\u25cb"; // ○
export const G_TIMEOUT  = "\u25c7"; // ◇
export const G_FN       = "\u2192"; // →
export const G_GATED    = "\u23f8"; // ⏸
export const G_BAR_ON   = "\u25a0"; // ■
export const G_BAR_OFF  = "\u25a1"; // □
export const G_SUB      = "\u2514\u2500"; // └─
export const G_RULE     = "\u2500"; // ─
export const G_STALLED  = "⚠"; // ⚠
export const LEN_VERSION = 8;
export const LEN_DUR     = 8;

// ── Color conversion ─────────────────────────────────────────────────────

export function rgbaToCSS(c: RGBA): string {
  return `rgb(${c.r},${c.g},${c.b})`;
}

// ── Package version ──────────────────────────────────────────────────────

export function readPackageVersion(): string {
  try {
    const dir = import.meta.dirname;
    if (dir) {
      const pkgPath = join(dir, "..", "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8") as string) as Record<string, unknown>;
        return (pkg.version as string) ?? "?";
      }
    }
  } catch { /* swallow */ }
  return "?";
}

// ── Agent name helpers ───────────────────────────────────────────────────

/** Extract the leaf agent name from a "--"-scoped path. */
export function agentLeaf(agent: string): string {
  const parts = agent.split(/--|\//);
  return parts[parts.length - 1] ?? agent;
}

/** Extract the ROOT agent name (first segment before --). */
export function agentRoot(agent: string): string {
  const parts = agent.split(/--|\//);
  return parts[0] ?? agent;
}

// ── Text helpers (re-exported from shared utils) ─────────────────────

// ── Duration formatting ──────────────────────────────────────────────────

/** Format a time duration as a human-readable relative time like "3s ago", "2m ago", or "1h ago". */
export function formatTimeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return "now";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

// ── Status visuals ───────────────────────────────────────────────────────

/** Status glyph + color for a task. */
export function statusVisual(status: string, c: ThemeColors): { glyph: string; color: RGBA } {
  switch (status) {
    case "running":   return { glyph: G_RUNNING, color: c.info };
    case "pending":   return { glyph: G_PENDING, color: c.warning };
    case "error":     return { glyph: G_ERROR,   color: c.error };
    case "completed": return { glyph: G_DONE,    color: c.success };
    case "cancelled": return { glyph: G_CANCEL,  color: c.textMuted };
    case "timeout":   return { glyph: G_TIMEOUT, color: c.secondary };
    default:          return { glyph: "?",       color: c.text };
  }
}

// ── Text wrapping ────────────────────────────────────────────────────────

/** Wrap a long string into lines of at most `width` chars. */
export function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    // Try to break at a space near the width boundary
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) breakAt = width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}
