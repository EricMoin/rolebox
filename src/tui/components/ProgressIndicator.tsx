/**
 * TUI progress indicator component — text-based progress bar for a task.
 *
 * Renders a compact progress bar like `[████░░░░░░] 45% | stage: compiling | 12 events`
 * that fits inline in the dispatch activity view.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import type { ThemeColors } from "../helpers.ts";
import { rgbaToCSS, BOLD, DIM, G_BAR_ON, G_BAR_OFF, G_SUB } from "../helpers.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const BAR_WIDTH = 10;

// ── Bar computation ────────────────────────────────────────────────────────

function barSegments(percentage: number, width: number): { filled: number; empty: number } {
  if (percentage <= 0) return { filled: 0, empty: width };
  if (percentage >= 100) return { filled: width, empty: 0 };
  const filled = Math.round((percentage / 100) * width);
  return { filled, empty: width - filled };
}

// ── Render: Progress indicator ────────────────────────────────────────────

export function renderProgressIndicator(props: {
  c: ThemeColors;
  stage: string;
  percentage?: number;
  message: string;
  eventCount: number;
}) {
  const { c, stage, percentage, message, eventCount } = props;

  if (percentage !== undefined && percentage >= 0) {
    const { filled, empty } = barSegments(percentage, BAR_WIDTH);
    // Show: [████░░░░░░] 45% | stage: compiling | 12 events
    return (
      <text>
        <span fg={rgbaToCSS(c.info)}>{G_BAR_ON.repeat(filled)}</span>
        <span fg={rgbaToCSS(c.borderSubtle)}>{G_BAR_OFF.repeat(empty)}</span>
        <span fg={rgbaToCSS(c.text)} attributes={BOLD}>{" " + percentage + "%"}</span>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" | stage: " + stage}</span>
        {eventCount > 0 && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" | " + eventCount + " events"}</span>
        )}
        {message && (
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" \u00b7 " + message}</span>
        )}
      </text>
    );
  }

  // No percentage — just show stage
  return (
    <text>
      <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " "}</span>
      <span fg={rgbaToCSS(c.info)} attributes={BOLD}>{"stage: " + stage}</span>
      {eventCount > 0 && (
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" | " + eventCount + " events"}</span>
      )}
      {message && (
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" \u00b7 " + message}</span>
      )}
    </text>
  );
}
