/**
 * MetricsPersister — bridges in-process metrics to disk persistence.
 *
 * Periodically flushes MetricsRegistry.snapshot() to a sidecar JSON file at
 * `.rolebox/state/metrics-{hash}.json` (atomic write pattern) and optionally
 * appends to a ring-buffered NDJSON event log at
 * `.rolebox/state/metrics-events-{hash}.ndjson`.
 *
 * Both files are gated by ROLEBOX_METRICS: when unset/false, persist(),
 * flushSync(), and dispose() are complete NO-OPs (zero file I/O).
 *
 * Follows the same promise-chaining serialization (_saveLock) and atomic
 * write (.tmp + renameSync) patterns as TaskStateStore.
 */

import type { RecoveryMetricsSnapshot } from "../../recovery/types.ts";

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import { createSubLogger } from "../../logger.ts";
import { shortHash } from "../../utils/state-paths.ts";
import { metrics, type MetricsSnapshot } from "./metrics.ts";
import {
  METRICS_PERSIST_INTERVAL_MS,
  DEFAULT_METRICS_EVENT_LOG_MAX_BYTES,
} from "../config.ts";

// ── Logger ────────────────────────────────────────────────────────────────

const log = createSubLogger("dispatch:metrics");

// ── Metrics file schema version ────────────────────────────────────────────

const METRICS_FILE_VERSION = 1;

// ── MetricsPersister ───────────────────────────────────────────────────────

export class MetricsPersister {
  private directory: string;
  private dirHash: string;
  private enabled: boolean;
  private eventLogMaxBytes: number;

  /**
   * Optional provider for recovery metrics snapshots.
   * When set, the recovery data is included in the persisted metrics file
   * under a top-level `recovery` key. This bridges the RecoveryMetricsCollector
   * (which tracks recovery attempts, success rates, error types) into the
   * metrics pipeline without modifying the RecoveryMetricsCollector's existing API.
   *
   * Option A bridge: MetricsPersister calls the provider during serialization
   * and embeds the snapshot — zero changes to RecoveryMetricsCollector.
   */
  private recoverySnapshotProvider: (() => RecoveryMetricsSnapshot | null) | null = null;

  private _saveLock: Promise<void> = Promise.resolve();
  /** Serialization lock — chains async writes so only one is in-flight at a time. */

  constructor(
    directory: string,
    opts?: { enabled?: boolean; eventLogMaxBytes?: number },
  ) {
    this.directory = directory;
    this.dirHash = shortHash(directory);
    this.enabled = opts?.enabled ?? !!process.env.ROLEBOX_METRICS;
    this.eventLogMaxBytes = opts?.eventLogMaxBytes ?? DEFAULT_METRICS_EVENT_LOG_MAX_BYTES;
  }

  /**
   * Register a callback that provides the current recovery metrics snapshot.
   * Called during serialization when the metrics file is written.
   * Set to null (or call with null) to exclude recovery data from the file.
   *
   * Designed to be wired from plugin-hooks.ts where both DispatchManager
   * (which owns MetricsPersister) and RecoveryEngine are available:
   *
   *   dispatchManager.setRecoverySnapshotProvider(() => recoveryEngine.getMetrics());
   */
  setRecoverySnapshotProvider(
    provider: (() => RecoveryMetricsSnapshot | null) | null,
  ): void {
    this.recoverySnapshotProvider = provider;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Persist a metrics snapshot to disk asynchronously.
   *
   * Writes the metrics sidecar JSON file and appends to the NDJSON event log
   * using the same promise-chaining pattern as TaskStateStore.save() to
   * serialize concurrent writes.
   *
   * NO-OP when metrics gating is disabled (!this.enabled).
   */
  async persist(): Promise<void> {
    if (!this.enabled) return;
    this._saveLock = this._saveLock.then(
      () => this._doPersist(),
      () => this._doPersist(),
    );
    return this._saveLock;
  }

  /**
   * Synchronous flush for crash-safety on process exit.
   *
   * Writes the metrics file synchronously (atomic pattern).
   * Never throws — wraps errors in try/catch and logs a warning.
   * NO-OP when metrics gating is disabled.
   */
  flushSync(): void {
    if (!this.enabled) return;
    try {
      this._writeMetricsFileSync();
      this._appendEventLogSync();
    } catch (err) {
      log.warn("Metrics persist (sync) failed", err);
    }
  }

  /**
   * Dispose the persister: performs a final synchronous flush and cleans up
   * any pending state.
   *
   * Safe to call multiple times.
   * NO-OP when metrics gating is disabled.
   */
  dispose(): void {
    if (!this.enabled) return;
    // Perform final flush
    this.flushSync();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getStateDir(): string {
    return join(this.directory, ".rolebox", "state");
  }

  private getMetricsFilePath(): string {
    return join(this.getStateDir(), `metrics-${this.dirHash}.json`);
  }

  private getEventLogPath(): string {
    return join(this.getStateDir(), `metrics-events-${this.dirHash}.ndjson`);
  }

  /**
   * Serialize a MetricsSnapshot to the on-disk sidecar file schema.
   */
  private serializeSnapshot(snap: MetricsSnapshot): string {
    const data: Record<string, unknown> = {
      version: METRICS_FILE_VERSION,
      timestamp: new Date().toISOString(),
      metrics: {
        counters: mapSnapshot(snap.counters, (c) => ({ value: c.value })),
        gauges: mapSnapshot(snap.gauges, (g) => ({ value: g.value })),
        histograms: mapSnapshot(snap.histograms, (h) => ({
          buckets: h.buckets,
          sum: h.sum,
          count: h.count,
        })),
      },
    };

    // Bridge recovery metrics into the persisted file when a provider is available.
    // The `recovery` key is optional — absent when there is no recovery engine
    // or when ROLEBOX_METRICS is disabled (the persister is a NO-OP in that case).
    const recoverySnap = this.recoverySnapshotProvider?.();
    if (recoverySnap) {
      data.recovery = recoverySnap;
    }
    return JSON.stringify(data, null, 2);
  }

  private async _doPersist(): Promise<void> {
    try {
      const snap = metrics.snapshot();
      const json = this.serializeSnapshot(snap);
      const filePath = this.getMetricsFilePath();
      const stateDir = this.getStateDir();

      mkdirSync(stateDir, { recursive: true });

      const tmp = filePath + ".tmp";
      await writeFile(tmp, json, "utf-8");

      // Atomic replace: rename-over the destination (see task-store pattern).
      renameSync(tmp, filePath);

      // Append NDJSON event log line
      this._appendEventLogSync();
    } catch (err) {
      log.warn("Metrics persist (async) failed", err);
    }
  }

  /** Synchronous atomic write to the metrics file. */
  private _writeMetricsFileSync(): void {
    const snap = metrics.snapshot();
    const json = this.serializeSnapshot(snap);
    const filePath = this.getMetricsFilePath();
    const stateDir = this.getStateDir();

    mkdirSync(stateDir, { recursive: true });

    const tmp = filePath + ".tmp";
    writeFileSync(tmp, json, "utf-8");

    // Atomic replace: rename-over the destination (see task-store pattern).
    renameSync(tmp, filePath);
  }

  /**
   * Append a single event-log line to the NDJSON file.
   * If the file exceeds eventLogMaxBytes, truncate by keeping only the last
   * half of the lines (ring-buffer style).
   */
  private _appendEventLogSync(): void {
    try {
      const snap = metrics.snapshot();
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        counters: mapSnapshot(snap.counters, (c) => ({ value: c.value })),
        gauges: mapSnapshot(snap.gauges, (g) => ({ value: g.value })),
        histograms: mapSnapshot(snap.histograms, (h) => ({
          buckets: h.buckets,
          sum: h.sum,
          count: h.count,
        })),
      }) + "\n";

      const eventPath = this.getEventLogPath();
      mkdirSync(dirname(eventPath), { recursive: true });

      // Append a line
      appendFileSync(eventPath, line, "utf-8");

      // Check if we exceed the size budget
      let size: number;
      try {
        size = statSync(eventPath).size;
      } catch {
        return;
      }

      if (size > this.eventLogMaxBytes) {
        this._truncateEventLog(eventPath);
      }
    } catch (err) {
      log.warn("Metrics NDJSON append failed", err);
    }
  }

  /**
   * Truncate the NDJSON event log file to ~half its lines.
   * Reads all lines, keeps the last portion, rewrites atomically.
   */
  private _truncateEventLog(eventPath: string): void {
    try {
      const content = readFileSync(eventPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      if (lines.length <= 1) return; // Nothing meaningful to trim

      const keep = Math.max(Math.floor(lines.length / 2), 1);
      const trimmed = lines.slice(lines.length - keep).join("\n") + "\n";

      const tmp = eventPath + ".tmp";
      writeFileSync(tmp, trimmed, "utf-8");

      try {
        unlinkSync(eventPath);
      } catch {
        // Ignore
      }
      renameSync(tmp, eventPath);
    } catch (err) {
      log.warn("Metrics NDJSON truncation failed", err);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Transform a record of snapshot entries into a serializable format,
 * preserving the key (name{labels}) and applying a mapper to each value.
 */
function mapSnapshot<T, R>(
  entries: Record<string, T>,
  mapper: (entry: T) => R,
): Record<string, R> {
  const result: Record<string, R> = {};
  for (const [key, val] of Object.entries(entries)) {
    result[key] = mapper(val);
  }
  return result;
}
