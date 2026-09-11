import { dim, red, green, cyan, yellow, magenta, gray } from "../../format.ts";
import { formatDuration, truncate, shortSessionId, statusGlyph } from "../../../utils/display-helpers.ts";

export { formatDuration, truncate, shortSessionId, statusGlyph };

// ── Layout helpers ──────────────────────────────────────────────

/**
 * Compute a consistent content width based on terminal columns.
 * Clamped to [60, 96] for readability on wide terminals.
 */
export function contentWidth(): number {
  const cols = process.stdout?.columns ?? 80;
  return Math.max(60, Math.min(cols - 2, 96));
}

/** Whether the terminal is in narrow mode (< 70 cols). */
export function isNarrow(): boolean {
  return (process.stdout?.columns ?? 80) < 70;
}

// ── Helpers ──────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function statusColor(status: string): (s: string) => string {
  switch (status) {
    case "running": return cyan;
    case "completed": return green;
    case "error": return red;
    case "pending": return yellow;
    case "cancelled": return gray;
    case "timeout": return magenta;
    default: return dim;
  }
}

/**
 * Format a status line item: colored glyph + padded status word.
 * Total width: 11 chars.
 */
export function statusCell(status: string): string {
  const color = statusColor(status);
  const glyph = statusGlyph(status);
  return color(`${glyph} ${status.padEnd(9)}`);
}

// ── Metric name parser ─────────────────────────────────────────────

export function parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
  const braceIdx = key.indexOf("{");
  if (braceIdx === -1) return { name: key, labels: {} };

  const name = key.slice(0, braceIdx);
  const labelsPart = key.slice(braceIdx + 1, key.length - 1);
  const labels: Record<string, string> = {};
  for (const part of labelsPart.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    labels[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
  }
  return { name, labels };
}

export function formatPromLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${labels[k]}"`);
  return `{${parts.join(",")}}`;
}

// ── Histogram percentile computation ───────────────────────────────

export function histogramPercentile(
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
