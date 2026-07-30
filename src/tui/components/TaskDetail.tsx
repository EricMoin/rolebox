/**
 * TUI task detail panel — scrollable inspection of a selected dispatch task.
 *
 * Shows the task's result text (windowed via offset/limit), metadata (agent,
 * status, duration, tool-call count, liveness), and error details.
 *
 * Navigation: mouse wheel for scroll, g/G for top/bottom,
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { ThemeColors } from "../helpers.ts";
import type { TaskSnapshot, TaskDetail } from "../../cli/commands/monitor/monitor-reader.ts";
import {
  rgbaToCSS, BOLD, DIM, DIM_ITALIC,
  G_RUNNING, G_PENDING, G_ERROR, G_DONE, G_CANCEL, G_TIMEOUT, G_STALLED,
  agentLeaf, shortSessionId, formatDuration, formatTimeAgo, truncate,
} from "../helpers.ts";
import {
  SIDEBAR_WIDTH, RULE_WIDTH_NARROW, INDENT, GLYPH_CELLS, VALUE_BUDGET,
  valueBudget, labelValue,
} from "../layout.ts";

// ── Props ────────────────────────────────────────────────────────────────

export interface TaskDetailPanelProps {
  c: ThemeColors;
  detail: TaskDetail;
  selectedTask: TaskSnapshot | null;
  offset: number;
  totalChars: number;
  /** Called when the close/back button is clicked. */
  onClose?: () => void;
  /** Called on scroll up. */
  onScrollUp?: () => void;
  /** Called on scroll down. */
  onScrollDown?: () => void;
}

// ── Status glyph ──────────────────────────────────────────────────────────

function statusGlyph(status: string, c: ThemeColors): { glyph: string; color: string } {
  switch (status) {
    case "running":   return { glyph: G_RUNNING, color: rgbaToCSS(c.info) };
    case "pending":   return { glyph: G_PENDING, color: rgbaToCSS(c.warning) };
    case "error":     return { glyph: G_ERROR,   color: rgbaToCSS(c.error) };
    case "completed": return { glyph: G_DONE,    color: rgbaToCSS(c.success) };
    case "cancelled": return { glyph: G_CANCEL,  color: rgbaToCSS(c.textMuted) };
    case "timeout":   return { glyph: G_TIMEOUT, color: rgbaToCSS(c.secondary) };
    default:          return { glyph: "?",       color: rgbaToCSS(c.text) };
  }
}

// ── Format an ISO timestamp to a relative display ─────────────────────────

function formatIsoAgo(iso: string | undefined): string {
  if (!iso) return "?";
  const elapsed = Date.now() - new Date(iso).getTime();
  return formatTimeAgo(elapsed);
}

// ── Component ─────────────────────────────────────────────────────────────

export function renderTaskDetailPanel(props: TaskDetailPanelProps) {
  const { c, detail, selectedTask, offset, totalChars } = props;
  const task = selectedTask ?? detail.task;
  const sg = statusGlyph(task.status, c);
  const norm = rgbaToCSS(c.text);
  const muted = rgbaToCSS(c.textMuted);
  const info = rgbaToCSS(c.info);
  const warn = rgbaToCSS(c.warning);
  const err = rgbaToCSS(c.error);
  const border = rgbaToCSS(c.borderSubtle);
  const success = rgbaToCSS(c.success);

  const agentName = task.agent ? agentLeaf(task.agent) : "(unknown)";
  const durStr = task.status === "running" || task.status === "pending"
    ? "running\u2026"
    : task.durationMs > 0
      ? formatDuration(task.durationMs)
      : "?";

  // Build liveness description
  let livenessStr = "";
  if (task.status === "running") {
    if (task.lastActivityAgoMs !== undefined && task.lastActivityAgoMs !== null) {
      const staleTimeout = task.staleTimeoutMs ?? 300_000;
      if (task.lastActivityAgoMs > staleTimeout) {
        livenessStr = G_STALLED + " stalled \u00b7 " + formatTimeAgo(task.lastActivityAgoMs) + " ago";
      } else {
        livenessStr = "active \u00b7 " + formatTimeAgo(task.lastActivityAgoMs) + " ago";
      }
    } else {
      livenessStr = "active";
    }
  }

  const toolCount = task.toolCalls ?? 0;
  const hasOutput = task.hasProducedOutput === true;

  // Window indicator
  const windowStart = offset;
  const windowEnd = Math.min(offset + (detail.limit ?? 500), totalChars);
  const pct = totalChars > 0 ? Math.round((windowEnd / totalChars) * 100) : 0;

  // Sidecar result line: show resultPreview if available (truncated to sidebar width)
  const previewLine = task.resultPreview ? truncate(task.resultPreview, SIDEBAR_WIDTH) : null;

  // Row budgets derived from layout primitives — no hardcoded widths.
  const secondaryBudget = valueBudget(SIDEBAR_WIDTH, INDENT.length);

  // Primary label:value row — dimmed lowercase label + colored, truncated value.
  const row = (label: string, value: string, color: string) => {
    const prefix = `${label}: `;
    const cells = valueBudget(SIDEBAR_WIDTH, prefix.length);
    const display = cells > 0 ? truncate(value, cells) : "";
    return (
      <text>
        <span fg={muted} attributes={DIM}>{prefix}</span>
        <span fg={color}>{display}</span>
      </text>
    );
  };

  // Secondary dimmed indented row — composed via labelValue, capped at VALUE_BUDGET.
  const secondary = (label: string, value: string) => {
    const totalBudget = Math.min(secondaryBudget, label.length + 2 + VALUE_BUDGET);
    return (
      <text>
        <span fg={muted} attributes={DIM}>{INDENT + labelValue(label, value, totalBudget)}</span>
      </text>
    );
  };

  return (
    <scrollbox
      scrollY={true}
      marginBottom={1}
      onMouseScroll={(event) => {
        if (event.scroll?.direction === "up") props.onScrollUp?.();
        if (event.scroll?.direction === "down") props.onScrollDown?.();
      }}
    >
      {/* ── Header ── */}
      <text>
        <span fg={info} attributes={BOLD} on:click={() => props.onClose?.()}>{"[Back] "}</span>
        <span attributes={BOLD} fg={norm}>{"  Task Detail"}</span>
      </text>

      {/* Separator */}
      <text fg={border}>{"\u2500".repeat(RULE_WIDTH_NARROW)}</text>

      {/* Status: glyph + agent (primary) */}
      <text>
        <span fg={sg.color}>{sg.glyph + " "}</span>
        <span fg={norm}>{truncate(agentName, valueBudget(SIDEBAR_WIDTH, GLYPH_CELLS + 1))}</span>
      </text>

      {/* Status: duration (secondary, dimmed) */}
      {secondary("duration", durStr)}

      {/* Status: liveness (secondary, dimmed, only while running) */}
      {task.status === "running" && livenessStr && secondary("liveness", livenessStr)}

      {/* ID */}
      {row("id", task.id, norm)}

      {/* Description */}
      <Show when={task.description}>
        {row("desc", task.description ?? "", norm)}
      </Show>

      {/* Session ID */}
      <Show when={task.sessionId}>
        {row("session", shortSessionId(task.sessionId ?? ""), norm)}
      </Show>

      {/* Status / depth / mode — each on its own label:value row */}
      {row("status", task.status, norm)}
      {row("depth", String(task.depth), norm)}
      {row("mode", task.mode, norm)}

      {/* Tool calls + output — each on its own label:value row */}
      {row("tools", String(toolCount), toolCount > 0 ? info : muted)}
      {row("output", hasOutput ? "yes" : "no", hasOutput ? success : muted)}

      {/* Error details */}
      <Show when={task.error}>
        {row("error", task.error ?? "", err)}
      </Show>

      {/* ── Sidecar result preview (from snapshot) ── */}
      <Show when={previewLine}>
        <text>{" "}</text>
        <text fg={muted} attributes={DIM}>{"result preview:"}</text>
        <text>
          <span fg={norm}>{previewLine}</span>
        </text>
      </Show>

      {/* ── Result text (windowed) ── */}
      <Show when={detail.fullText && detail.fullText.length > 0}>
        <text>{" "}</text>
        <text fg={muted} attributes={DIM}>{"result text:"}</text>
        <text>
          <span fg={norm}>{detail.fullText}</span>
        </text>
      </Show>

      <Show when={(!detail.fullText || detail.fullText.length === 0) && totalChars > 0}>
        <text>
          <span fg={muted} attributes={DIM_ITALIC}>{"(empty window \u2014 try scrolling)"}</span>
        </text>
      </Show>

      <Show when={totalChars === 0}>
        <text>
          <span fg={muted} attributes={DIM_ITALIC}>{"(no result text)"}</span>
        </text>
      </Show>

      {/* ── Scroll indicator ── */}
      <text>{" "}</text>
      <text fg={border}>{"\u2500".repeat(RULE_WIDTH_NARROW)}</text>
      <text>
        <span fg={muted} attributes={DIM}>{"chars "}</span>
        <span fg={info}>{String(windowStart)}\u2013{String(windowEnd)}</span>
        <span fg={muted} attributes={DIM}>{" of "}</span>
        <span fg={norm}>{String(totalChars)}</span>
        <span fg={muted} attributes={DIM}>{" (" + pct + "%)"}</span>
      </text>

    </scrollbox>
  );
}
