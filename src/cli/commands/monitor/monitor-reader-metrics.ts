import { readFileSync } from "node:fs";
import { tryReadJson, listStateFiles, listNDJSONFiles } from "./monitor-reader-utils.ts";
import type { MetricsSnapshot } from "../../../dispatch/persistence/metrics.ts";
import type { NDJSONEvent } from "./monitor-reader-types.ts";

/**
 * Parse the metrics sidecar JSON file from the state directory. Returns the
 * MetricsSnapshot (the `metrics` field from the sidecar file) or null if no
 * valid metrics file exists.
 *
 * Handles missing files, malformed JSON, and partial data gracefully (returns
 * null, never throws).
 */
export function readMetricsSnapshot(
  stateDir: string,
): MetricsSnapshot | null {
  // Read the metrics JSON sidecar
  const metricsFiles = listStateFiles(stateDir, "metrics-");
  if (metricsFiles.length === 0) return null;

  for (const filePath of metricsFiles) {
    const raw = tryReadJson(filePath);
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.metrics !== "object" || obj.metrics === null) continue;
    const metrics = obj.metrics as MetricsSnapshot;
    if (typeof metrics.counters !== "object" || typeof metrics.gauges !== "object") continue;
    return metrics;
  }

  return null;
}

/**
 * Read the last N lines of the NDJSON event log (metrics-events-*.ndjson) and
 * return them as parsed NDJSONEvent objects. Returns an empty array when the
 * log file does not exist or cannot be read.
 */
export function readMetricsRecentEvents(
  stateDir: string,
  maxLines = 20,
): NDJSONEvent[] {
  const eventFiles = listNDJSONFiles(stateDir, "metrics-events-");
  if (eventFiles.length === 0) return [];

  for (const filePath of eventFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const lastLines = lines.slice(-maxLines);
      const events: NDJSONEvent[] = [];

      for (const line of lastLines) {
        try {
          const parsed = JSON.parse(line);
          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.ts === "string"
          ) {
            events.push({
              ts: parsed.ts,
              counters: parsed.counters ?? {},
              gauges: parsed.gauges ?? {},
              histograms: parsed.histograms,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (events.length > 0) return events;
    } catch {
      // Skip unreadable files
    }
  }

  return [];
}
