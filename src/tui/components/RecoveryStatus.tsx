/**
 * TUI recovery status panel.
 *
 * Adapted from the CLI renderer's `renderRecovery()` in status-format.ts.
 * Renders only when `snap.recovery` is present and totalAttempts > 0.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import type { ThemeColors } from "../helpers.ts";
import {
  rgbaToCSS, BOLD, DIM, G_SUB, truncate,
} from "../helpers.ts";
import { SIDEBAR_WIDTH, INDENT, VALUE_BUDGET, valueBudget } from "../layout.ts";
import type {
  MonitorSnapshot,
} from "../../cli/commands/monitor/monitor-reader.ts";

// ── Render: recovery status panel ───────────────────────────────────

export function renderRecoveryStatus(props: { c: ThemeColors; snap: MonitorSnapshot | null }) {
  const { c, snap } = props;
  const recovery = snap?.recovery;

  // SUPPRESS: no recovery data or zero attempts
  if (!recovery || recovery.totalAttempts === 0) return null;

  const totalAttempts = recovery.totalAttempts;
  const successes = recovery.successfulRecoveries;
  const aborted = recovery.abortedChains;
  const exhausted = recovery.exhaustedChains;
  const successRate = totalAttempts > 0
    ? Math.round((successes / totalAttempts) * 100)
    : 0;

  const parts: unknown[] = [];

  // Summary rows — one `label: value` fact per row.
  const rateColor = successRate >= 80 ? c.success : successRate >= 50 ? c.warning : c.error;

  const summaryRow = (label: string, value: string, color: RGBA) => {
    const prefix = `${label}: `;
    const cells = valueBudget(SIDEBAR_WIDTH, INDENT.length + prefix.length);
    const display = cells > 0 ? truncate(value, cells) : "";
    return (
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + prefix}</span>
        <span fg={rgbaToCSS(color)}>{display}</span>
      </text>
    );
  };

  parts.push(summaryRow("attempts", String(totalAttempts), c.text));
  parts.push(summaryRow("recovered", String(successes), c.success));
  if (aborted > 0) parts.push(summaryRow("aborted", String(aborted), c.warning));
  if (exhausted > 0) parts.push(summaryRow("exhausted", String(exhausted), c.textMuted));
  parts.push(summaryRow("rate", String(successRate) + "%", rateColor));

  // By category
  const catKeys = Object.keys(recovery.byCategory);
  if (catKeys.length > 0) {
    parts.push(
      <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " by category"}</text>,
    );
    for (const cat of catKeys) {
      const entry = recovery.byCategory[cat];
      const rate = entry.attempts > 0 ? Math.round((entry.successes / entry.attempts) * 100) : 0;
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + truncate(cat, VALUE_BUDGET)}</span>
          <span fg={rgbaToCSS(c.info)}>{" " + String(entry.attempts) + "/" + String(entry.successes)}</span>
          <span fg={rgbaToCSS(c.textMuted)}>{" " + String(rate) + "%"}</span>
        </text>,
      );
    }
  }

  // By strategy (top 5)
  const stratKeys = Object.keys(recovery.byStrategy);
  if (stratKeys.length > 0) {
    parts.push(
      <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " by strategy"}</text>,
    );
    for (const strat of stratKeys) {
      const entry = recovery.byStrategy[strat];
      const rate = entry.attempts > 0 ? Math.round((entry.successes / entry.attempts) * 100) : 0;
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + truncate(strat, VALUE_BUDGET)}</span>
          <span fg={rgbaToCSS(c.info)}>{" " + String(entry.attempts) + "/" + String(entry.successes)}</span>
          <span fg={rgbaToCSS(c.textMuted)}>{" " + String(rate) + "%"}</span>
        </text>,
      );
    }
  }

  // Top errors (top 5)
  const errorKeys = Object.keys(recovery.errorTypeFrequency);
  if (errorKeys.length > 0) {
    parts.push(
      <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " top errors"}</text>,
    );
    const sorted = errorKeys
      .map((k) => ({ type: k, count: recovery.errorTypeFrequency[k] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    for (const err of sorted) {
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + truncate(err.type, VALUE_BUDGET)}</span>
          <span fg={rgbaToCSS(c.warning)}>{" " + String(err.count)}</span>
        </text>,
      );
    }
  }

  return (
    <box marginBottom={1}>
      <text fg={rgbaToCSS(c.textMuted)} attributes={BOLD}>{"\u2500 recovery"}</text>
      {parts}
    </box>
  );
}
