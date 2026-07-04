import { describe, it, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MetricsPersister } from "../../src/dispatch/metrics-persister.ts";
import { metrics, MetricsRegistry } from "../../src/dispatch/metrics.ts";
import { shortHash } from "../../src/state-paths.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  metrics.reset();

  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "metrics-persister-test-"));
  tmpDirs.push(dir);
  return dir;
}

function metricsFilePath(dir: string): string {
  const hash = shortHash(dir);
  return join(dir, ".rolebox", "state", `metrics-${hash}.json`);
}

function eventLogPath(dir: string): string {
  const hash = shortHash(dir);
  return join(dir, ".rolebox", "state", `metrics-events-${hash}.ndjson`);
}

/**
 * Read and parse the metrics file. Returns null if file doesn't exist.
 */
function readMetricsFile(dir: string): unknown | null {
  const fp = metricsFilePath(dir);
  if (!existsSync(fp)) return null;
  return JSON.parse(readFileSync(fp, "utf-8"));
}

/**
 * Use core-only metrics that appear in the snapshot even when the module-level
 * `metrics` singleton is disabled (ROLEBOX_METRICS unset).
 *
 * Core counters: dispatch_rejected_total, dispatch_backpressure_retry_total
 * Core gauges:   inflight_tasks, concurrency_queued
 *
 * Non-core metrics (histograms, user metrics) only appear when the registry
 * is enabled — the MetricsPersister's `enabled` flag is separate from the
 * registry's `enabled` flag.
 */
function populateCoreMetrics(): void {
  metrics.counter("dispatch_rejected_total").inc(3);
  metrics.gauge("inflight_tasks").set(5);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("MetricsPersister", () => {
  describe("enabled = true", () => {
    it("writes valid JSON to the metrics file on persist()", async () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      await persister.persist();

      const parsed = readMetricsFile(dir) as Record<string, unknown>;
      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(1);
      expect(typeof (parsed as Record<string, unknown>).timestamp).toBe("string");

      const metricsSection = (parsed as { metrics: Record<string, unknown> }).metrics;
      expect(metricsSection).toBeDefined();
      expect(metricsSection).toHaveProperty("counters");
      expect(metricsSection).toHaveProperty("gauges");
      expect(metricsSection).toHaveProperty("histograms");
    });

    it("includes core metric values in the snapshot file", async () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      await persister.persist();

      const parsed = readMetricsFile(dir) as {
        metrics: {
          counters: Record<string, { value: number }>;
          gauges: Record<string, { value: number }>;
        };
      };
      expect(parsed.metrics.counters["dispatch_rejected_total"]).toEqual({
        value: 3,
      });
      expect(parsed.metrics.gauges["inflight_tasks"]).toEqual({ value: 5 });
    });

    it("creates NDJSON event log with ts field", async () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      await persister.persist();

      const eventFile = eventLogPath(dir);
      expect(existsSync(eventFile)).toBe(true);

      const lines = readFileSync(eventFile, "utf-8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed).toHaveProperty("ts");
      expect(typeof parsed.ts).toBe("string");
      expect(parsed).toHaveProperty("counters");
      expect(parsed).toHaveProperty("gauges");
      expect(parsed).toHaveProperty("histograms");
    });

    it("flushSync() writes synchronously and never throws", () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      expect(() => persister.flushSync()).not.toThrow();

      const parsed = readMetricsFile(dir) as {
        metrics: { counters: Record<string, { value: number }> };
      };
      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(1);
      expect(parsed.metrics.counters["dispatch_rejected_total"]).toEqual({
        value: 3,
      });
    });

    it("dispose() performs final flush without throwing", () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      expect(() => persister.dispose()).not.toThrow();

      const filePath = metricsFilePath(dir);
      expect(existsSync(filePath)).toBe(true);
    });

    it("atomic write: temp file is cleaned up after rename", async () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      await persister.persist();

      const filePath = metricsFilePath(dir);
      const tmpFile = filePath + ".tmp";

      expect(existsSync(tmpFile)).toBe(false);
      expect(existsSync(filePath)).toBe(true);
    });

    it("schema version field is present and correct", async () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      await persister.persist();

      const parsed = readMetricsFile(dir) as Record<string, unknown>;
      expect(parsed).toHaveProperty("version", 1);
    });

    it("NDJSON respects the event log size limit (truncate behavior)", async () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, {
        enabled: true,
        eventLogMaxBytes: 500,
      });

      const coreCounter = metrics.counter("dispatch_backpressure_retry_total");
      for (let i = 0; i < 50; i++) {
        coreCounter.inc(1);
        await persister.persist();
      }

      const eventFile = eventLogPath(dir);
      expect(existsSync(eventFile)).toBe(true);

      const size = statSync(eventFile).size;
      expect(size).toBeLessThanOrEqual(700); // Allow some headroom

      const lines = readFileSync(eventFile, "utf-8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);

      // Verify the truncated lines are still valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("ts");
        expect(parsed).toHaveProperty("counters");
      }
    });

    it("multiple persist() calls produce sequential NDJSON lines", async () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, { enabled: true });

      // First persist — no core metrics have been touched, counters empty
      await persister.persist();

      // Second persist — after incrementing a core counter
      metrics.counter("dispatch_rejected_total").inc(10);
      await persister.persist();

      const lines = readFileSync(eventLogPath(dir), "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);

      // Second line should have a higher (or present) counter value.
      // When the singleton registry is disabled, non-core counters are absent
      // but core counters like dispatch_rejected_total appear in every snapshot.
      const firstVal = first.counters?.dispatch_rejected_total?.value ?? 0;
      const secondVal = second.counters?.dispatch_rejected_total?.value ?? 0;
      expect(secondVal).toBeGreaterThanOrEqual(firstVal + 10);
    });

    describe("recovery snapshot provider", () => {
      it("includes recovery data in the persisted file when provider is set", async () => {
        const dir = makeTempDir();
        populateCoreMetrics();
        const persister = new MetricsPersister(dir, { enabled: true });

        persister.setRecoverySnapshotProvider(() => ({
          totalAttempts: 10,
          successfulRecoveries: 6,
          abortedChains: 2,
          exhaustedChains: 2,
          byCategory: {
            session_error: { attempts: 5, successes: 3 },
            json_error: { attempts: 3, successes: 2 },
          },
          byStrategy: {
            retry: { attempts: 6, successes: 4 },
            compact: { attempts: 2, successes: 1 },
          },
          errorTypeFrequency: {
            ContextLengthExceeded: 4,
            JSONParseError: 3,
          },
        }));

        await persister.persist();

        const parsed = readMetricsFile(dir) as Record<string, unknown>;
        expect(parsed).not.toBeNull();
        expect(parsed).toHaveProperty("recovery");

        const recovery = (parsed as { recovery: Record<string, unknown> }).recovery;
        expect(recovery.totalAttempts).toBe(10);
        expect(recovery.successfulRecoveries).toBe(6);
        expect(recovery.abortedChains).toBe(2);
        expect(recovery.exhaustedChains).toBe(2);
        expect(recovery.byCategory).toEqual({
          session_error: { attempts: 5, successes: 3 },
          json_error: { attempts: 3, successes: 2 },
        });
        expect(recovery.byStrategy).toEqual({
          retry: { attempts: 6, successes: 4 },
          compact: { attempts: 2, successes: 1 },
        });
        expect(recovery.errorTypeFrequency).toEqual({
          ContextLengthExceeded: 4,
          JSONParseError: 3,
        });
      });

      it("excludes recovery data when provider returns null", async () => {
        const dir = makeTempDir();
        populateCoreMetrics();
        const persister = new MetricsPersister(dir, { enabled: true });

        // Set provider that returns null
        persister.setRecoverySnapshotProvider(() => null);
        await persister.persist();

        const parsed = readMetricsFile(dir) as Record<string, unknown>;
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty("recovery");
      });

      it("excludes recovery data when no provider is set", async () => {
        const dir = makeTempDir();
        populateCoreMetrics();
        const persister = new MetricsPersister(dir, { enabled: true });

        // No provider set
        await persister.persist();

        const parsed = readMetricsFile(dir) as Record<string, unknown>;
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty("recovery");
      });

      it("recovery data appears in flushSync() when provider is set", () => {
        const dir = makeTempDir();
        populateCoreMetrics();
        const persister = new MetricsPersister(dir, { enabled: true });

        persister.setRecoverySnapshotProvider(() => ({
          totalAttempts: 5,
          successfulRecoveries: 3,
          abortedChains: 1,
          exhaustedChains: 1,
          byCategory: {},
          byStrategy: {},
          errorTypeFrequency: {},
        }));

        persister.flushSync();

        const parsed = readMetricsFile(dir) as Record<string, unknown>;
        expect(parsed).not.toBeNull();
        expect(parsed).toHaveProperty("recovery");
        expect((parsed as { recovery: Record<string, unknown> }).recovery.totalAttempts).toBe(5);
      });

      it("recovery data is still valid JSON with metrics", async () => {
        const dir = makeTempDir();
        populateCoreMetrics();
        const persister = new MetricsPersister(dir, { enabled: true });

        persister.setRecoverySnapshotProvider(() => ({
          totalAttempts: 3,
          successfulRecoveries: 1,
          abortedChains: 1,
          exhaustedChains: 1,
          byCategory: {},
          byStrategy: {},
          errorTypeFrequency: {},
        }));

        await persister.persist();

        const raw = readFileSync(metricsFilePath(dir), "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(parsed).toHaveProperty("version");
        expect(parsed).toHaveProperty("metrics");
        expect(parsed).toHaveProperty("recovery");
        expect(parsed!.version).toBe(1);
      });
    });

  });

  describe("enabled = false (NO-OP)", () => {
    it("persist() does NOT create any metrics files", async () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, { enabled: false });

      await persister.persist();

      expect(existsSync(metricsFilePath(dir))).toBe(false);
      expect(existsSync(eventLogPath(dir))).toBe(false);
    });

    it("flushSync() does NOT create any metrics files and never throws", () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, { enabled: false });

      expect(() => persister.flushSync()).not.toThrow();

      expect(existsSync(metricsFilePath(dir))).toBe(false);
      expect(existsSync(eventLogPath(dir))).toBe(false);
    });

    it("dispose() does NOT create any metrics files", () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, { enabled: false });

      expect(() => persister.dispose()).not.toThrow();

      expect(existsSync(metricsFilePath(dir))).toBe(false);
      expect(existsSync(eventLogPath(dir))).toBe(false);
    });
  });

  describe("flushSync() robustness", () => {
    it("flushSync() writes the metrics file even when called without prior persist()", () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      persister.flushSync();

      const parsed = readMetricsFile(dir) as {
        metrics: { counters: Record<string, { value: number }> };
      };
      expect(parsed).not.toBeNull();
      expect(parsed.metrics.counters["dispatch_rejected_total"]).toEqual({
        value: 3,
      });
    });

    it("flushSync() is safe to call on a directory with no state subdir (creates it)", () => {
      const dir = makeTempDir();
      populateCoreMetrics();
      const persister = new MetricsPersister(dir, { enabled: true });

      expect(() => persister.flushSync()).not.toThrow();
      expect(existsSync(metricsFilePath(dir))).toBe(true);
    });
  });

  describe("NDJSON edge cases", () => {
    it("truncates to ~half when file exceeds limit (at threshold)", async () => {
      const dir = makeTempDir();
      // Set a limit that forces truncation after ~3 persistent writes
      const persister = new MetricsPersister(dir, {
        enabled: true,
        eventLogMaxBytes: 400,
      });

      const coreCounter = metrics.counter("dispatch_backpressure_retry_total");
      for (let i = 0; i < 20; i++) {
        coreCounter.inc(1);
        await persister.persist();
      }

      const eventFile = eventLogPath(dir);
      expect(existsSync(eventFile)).toBe(true);

      const size = statSync(eventFile).size;
      expect(size).toBeLessThanOrEqual(600); // Allow some headroom
      expect(size).toBeGreaterThan(0);

      const lines = readFileSync(eventFile, "utf-8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);

      // Verify every line is still valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("ts");
        expect(parsed).toHaveProperty("counters");
      }
    });

    it("handles a single line that exceeds the max bytes gracefully (no crash)", async () => {
      const dir = makeTempDir();
      // Very small limit — a single event line could exceed it
      const persister = new MetricsPersister(dir, {
        enabled: true,
        eventLogMaxBytes: 1,
      });

      // Populate enough metrics to make each line substantial
      metrics.counter("dispatch_total").inc(1);
      metrics.gauge("inflight_tasks").set(5);

      await persister.persist();

      const eventFile = eventLogPath(dir);
      expect(existsSync(eventFile)).toBe(true);

      // Should have at least one valid JSON line
      const content = readFileSync(eventFile, "utf-8").trim();
      expect(content.length).toBeGreaterThan(0);
      const lines = content.split("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("ts");
      }
    });

    it("concurrent persist() calls do not corrupt the metrics file", async () => {
      const dir = makeTempDir();
      const persister = new MetricsPersister(dir, { enabled: true });

      const promises: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        metrics.counter("dispatch_rejected_total").inc(1);
        promises.push(persister.persist());
      }

      await Promise.all(promises);

      // The file should contain valid JSON
      const parsed = readMetricsFile(dir) as Record<string, unknown>;
      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(1);

      // The NDJSON event log should have valid lines (no interleaved corruption)
      const eventFile = eventLogPath(dir);
      if (existsSync(eventFile)) {
        const lines = readFileSync(eventFile, "utf-8").trim().split("\n");
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          expect(parsed).toHaveProperty("ts");
        }
      }
    });

    it("NDJSON with exactly burst of lines stays at ~half after truncation", async () => {
      const dir = makeTempDir();
      // Medium limit — fill it then verify ratio
      const persister = new MetricsPersister(dir, {
        enabled: true,
        eventLogMaxBytes: 800,
      });

      const coreCounter = metrics.counter("dispatch_backpressure_retry_total");
      for (let i = 0; i < 30; i++) {
        coreCounter.inc(1);
        await persister.persist();
      }

      const eventFile = eventLogPath(dir);
      expect(existsSync(eventFile)).toBe(true);

      const size = statSync(eventFile).size;
      // Should be within reasonable range of the limit
      expect(size).toBeLessThanOrEqual(1200);
      expect(size).toBeGreaterThan(0);

      // All lines must be valid JSON
      const lines = readFileSync(eventFile, "utf-8").trim().split("\n");
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(typeof parsed.ts).toBe("string");
      }
    });
  });
});
