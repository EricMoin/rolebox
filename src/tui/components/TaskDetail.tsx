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
  agentLeaf, formatDuration, formatTimeAgo,
} from "../helpers.ts";

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

  // Sidecar result line: show resultPreview if available
  const previewLine = task.resultPreview
    ? task.resultPreview.length > 80
      ? task.resultPreview.slice(0, 80) + "\u2026"
      : task.resultPreview
    : null;

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
        <span fg={info} attributes={BOLD} on:click={() => props.onClose?.()}>{"[\u2190 Back] "}</span>
        <span attributes={BOLD} fg={norm}>{"  Task Detail"}</span>
      </text>

      {/* Separator */}
      <text fg={border}>{"\u2500".repeat(36)}</text>

      {/* Status line */}
      <text>
        <span fg={sg.color}>{sg.glyph + " "}</span>
        <span fg={norm}>{agentName}</span>
        <span fg={muted} attributes={DIM}>{"  " + durStr}</span>
        {task.status === "running" && livenessStr && (
          <span fg={muted} attributes={DIM}>{"  " + livenessStr}</span>
        )}
      </text>

      {/* ID */}
      <text>
        <span fg={muted} attributes={DIM}>{"id: "}</span>
        <span fg={norm}>{task.id}</span>
      </text>

      {/* Description */}
      <Show when={task.description}>
        <text>
          <span fg={muted} attributes={DIM}>{"desc: "}</span>
          <span fg={norm}>{task.description}</span>
        </text>
      </Show>

      {/* Status / depth / mode */}
      <text>
        <span fg={muted} attributes={DIM}>{"status: "}</span>
        <span fg={norm}>{task.status}</span>
        <span fg={muted} attributes={DIM}>{"  depth: "}</span>
        <span fg={norm}>{String(task.depth)}</span>
        <span fg={muted} attributes={DIM}>{"  mode: "}</span>
        <span fg={norm}>{task.mode}</span>
      </text>

      {/* Tool calls + output */}
      <text>
        <span fg={muted} attributes={DIM}>{"tools: "}</span>
        <span fg={toolCount > 0 ? info : muted}>{String(toolCount)}</span>
        <span fg={muted} attributes={DIM}>{"  output: "}</span>
        <span fg={hasOutput ? success : muted}>{hasOutput ? "yes" : "no"}</span>
      </text>

      {/* Error details */}
      <Show when={task.error}>
        <text>
          <span fg={err} attributes={BOLD}>{"error: "}</span>
          <span fg={err}>{task.error}</span>
        </text>
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
      <text fg={border}>{"\u2500".repeat(36)}</text>
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
