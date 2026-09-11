/**
 * TUI pulse / health status components.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import type { ThemeColors, HealthState } from "../helpers.ts";
import { rgbaToCSS, BOLD, DIM, DIM_ITALIC, G_RUNNING, G_PENDING, G_ERROR, G_SUB } from "../helpers.ts";
import { INDENT } from "../layout.ts";

// ── Health display ───────────────────────────────────────────────────────

export function healthDisplay(
  h: HealthState | null,
  c: ThemeColors,
): { glyph: string; label: string; color: RGBA; glyphBold: boolean; labelBold: boolean } | null {
  if (h === null) return null;
  switch (h) {
    case "ACTIVE":  return { glyph: G_RUNNING, label: "ACTIVE",  color: c.info,    glyphBold: true,  labelBold: true };
    case "IDLE":    return { glyph: G_PENDING, label: "IDLE",    color: c.warning, glyphBold: false, labelBold: true };
    case "ERROR":   return { glyph: G_ERROR,   label: "ERROR",   color: c.error,   glyphBold: true,  labelBold: true };
    case "NO_STATE":return { glyph: G_ERROR,   label: "NO STATE",color: c.error,   glyphBold: true,  labelBold: true };
    case "STALE":   return { glyph: G_ERROR,   label: "STALE",   color: c.error,   glyphBold: true,  labelBold: true };
  }
}

// ── Render: Pulse ────────────────────────────────────────────────────────

export function renderPulse(props: {
  c: ThemeColors;
  hd: ReturnType<typeof healthDisplay>;
  active: number;
  limit: number;
  queued: number;
  showConcurrency: boolean;
}) {
  const { c, hd, active, limit, queued, showConcurrency } = props;
  if (!hd) return null;

  return (
    <>
      <text>
        <span fg={rgbaToCSS(hd.color)} attributes={hd.glyphBold ? BOLD : 0}>{hd.glyph}</span>
        <span fg={rgbaToCSS(hd.color)} attributes={hd.labelBold ? BOLD : 0}>{" " + hd.label}</span>
      </text>
      {showConcurrency && (
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + "concurrency: "}</span>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{String(active)}</span>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"/"}</span>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{String(limit)}</span>
          {queued > 0 && (
            <>
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{" " + G_SUB + " "}</span>
              <span fg={rgbaToCSS(c.warning)} attributes={DIM}>{String(queued)}</span>
              <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"q"}</span>
            </>
          )}
        </text>
      )}
    </>
  );
}

// ── Render: Stale hint ──────────────────────────────────────────────────

export function renderStaleHint(props: { c: ThemeColors; isStale: boolean }) {
  if (!props.isStale) return null;
  const c = props.c;
  return <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"data may be outdated"}</text>;
}

// ── Render: No state body ───────────────────────────────────────────────

export function renderNoStateBody(props: { c: ThemeColors; show: boolean }) {
  if (!props.show) return null;
  const c = props.c;
  return (
    <>
      <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"No .rolebox/state found"}</text>
      <text fg={rgbaToCSS(c.textMuted)} attributes={DIM_ITALIC}>{"Run rolebox to init"}</text>
    </>
  );
}
