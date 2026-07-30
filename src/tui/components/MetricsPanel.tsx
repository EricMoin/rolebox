/**
 * TUI metrics panel — dispatch gauges / counters / histograms.
 *
 * Adapted from the CLI renderer's `renderMetrics()` in status-format.ts.
 * Renders only when `snap.metrics` is present.
 *
 * @module
 */

/** @jsxImportSource @opentui/solid */
import { Show, For } from "solid-js";
import type { ThemeColors } from "../helpers.ts";
import {
  rgbaToCSS, BOLD, DIM, G_SUB,
} from "../helpers.ts";
import { SIDEBAR_WIDTH, INDENT, valueBudget, labelValue } from "../layout.ts";
import type {
  MonitorSnapshot,
} from "../../cli/commands/monitor/monitor-reader.ts";
import type { MetricsSnapshot } from "../../dispatch/persistence/metrics.ts";

// ── Metric key parser (adapted from monitor-helpers.ts) ──────────────

function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  const braceIdx = key.indexOf("{");
  if (braceIdx === -1) return { name: key, labels: {} };
  const name = key.slice(0, braceIdx);
  const labelsPart = key.slice(braceIdx + 1, -1);
  const labels: Record<string, string> = {};
  for (const part of labelsPart.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    labels[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
  }
  return { name, labels };
}

// ── Histogram percentile (adapted from monitor-helpers.ts) ───────────

function histogramPercentile(
  buckets: Record<string, number>,
  count: number,
  pct: number,
): number {
  const threshold = count * pct;
  const sorted = Object.entries(buckets)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);
  let cumulative = 0;
  for (const [boundary, bucketCount] of sorted) {
    cumulative += bucketCount;
    if (cumulative >= threshold) return boundary;
  }
  return sorted.length > 0 ? sorted[sorted.length - 1][0] : 0;
}

// ── Sub-section header ──────────────────────────────────────────────

function subHeader(c: ThemeColors, label: string) {
  return <text fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{G_SUB + " " + label}</text>;
}

// ── Render: Metrics panel ──────────────────────────────────────────

export function renderMetricsPanel(props: { c: ThemeColors; snap: MonitorSnapshot | null }) {
  const { c, snap } = props;
  const metrics = snap?.metrics;

  if (!metrics) return null;

  const parts: unknown[] = [];

  // Dimmed secondary row — one `label: value` fact per row.
  const dimRow = (label: string, value: string) => {
    const budget = valueBudget(SIDEBAR_WIDTH, INDENT.length);
    return (
      <text>
        <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{INDENT + labelValue(label, value, budget)}</span>
      </text>
    );
  };

  // ── Counters ──
  const counterKeys = Object.keys(metrics.counters);
  if (counterKeys.length > 0) {
    parts.push(subHeader(c, "counters"));
    for (const key of counterKeys) {
      const { name, labels } = parseMetricKey(key);
      const value = metrics.counters[key].value;
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + name}</span>
          {labelTags(labels, c)}
          <span fg={rgbaToCSS(c.text)}>{" " + String(value)}</span>
        </text>,
      );
    }
  }

  // ── Gauges ──
  const gaugeKeys = Object.keys(metrics.gauges);
  if (gaugeKeys.length > 0) {
    parts.push(subHeader(c, "gauges"));
    for (const key of gaugeKeys) {
      const { name, labels } = parseMetricKey(key);
      const value = metrics.gauges[key].value;
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + name}</span>
          {labelTags(labels, c)}
          <span fg={rgbaToCSS(c.text)}>{" " + String(value)}</span>
        </text>,
      );
    }
  }

  // ── Histograms ──
  const histKeys = Object.keys(metrics.histograms);
  if (histKeys.length > 0) {
    parts.push(subHeader(c, "histograms"));
    for (const key of histKeys) {
      const { name, labels } = parseMetricKey(key);
      const h = metrics.histograms[key];
      const avg = h.count > 0 ? Math.round(h.sum / h.count) : 0;
      const p50 = histogramPercentile(h.buckets, h.count, 0.5);
      const p95 = histogramPercentile(h.buckets, h.count, 0.95);
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + name}</span>
          {labelTags(labels, c)}
        </text>,
      );
      parts.push(dimRow("avg", avg + "ms"));
      parts.push(dimRow("p50", p50 + "ms"));
      parts.push(dimRow("p95", p95 + "ms"));
      parts.push(dimRow("n", String(h.count)));
    }
  }

  // ── Recent NDJSON events (last 3) ──
  const recentEvents = snap?.metricsRecentEvents;
  if (recentEvents && recentEvents.length > 0) {
    parts.push(subHeader(c, "recent events"));
    const recent = recentEvents.slice(-3);
    for (const evt of recent) {
      const ts = evt.ts.length > 19 ? evt.ts.slice(0, 19) : evt.ts;
      const counterVals = Object.entries(evt.counters)
        .map(([k, v]) => k + "=" + String(v))
        .join(" ");
      const gaugeVals = Object.entries(evt.gauges)
        .map(([k, v]) => k + "=" + String(v))
        .join(" ");
      parts.push(
        <text>
          <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{"  " + ts}</span>
        </text>,
      );
      if (counterVals) {
        parts.push(dimRow("counters", counterVals));
      }
      if (gaugeVals) {
        parts.push(dimRow("gauges", gaugeVals));
      }
    }
  }

  if (parts.length === 0) return null;

  return (
    <box marginBottom={1}>
      <text fg={rgbaToCSS(c.textMuted)} attributes={BOLD}>{"\u2500 metrics"}</text>
      {parts}
    </box>
  );
}

// ── Label tags helper ──────────────────────────────────────────────

function labelTags(labels: Record<string, string>, c: ThemeColors) {
  const keys = Object.keys(labels);
  if (keys.length === 0) return null;
  const tagStr = " " + keys.map((k) => k + ":" + labels[k]).join(" ");
  return <span fg={rgbaToCSS(c.textMuted)} attributes={DIM}>{tagStr}</span>;
}
