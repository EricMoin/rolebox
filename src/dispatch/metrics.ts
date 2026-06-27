/**
 * Lightweight in-process metrics registry with zero external dependencies.
 *
 * Provides counters, gauges, and bucketed histograms for operational
 * observability of the dispatch subsystem. No HTTP server — snapshots are
 * consumed programmatically or exposed via other means (e.g., health check).
 *
 * Gated via ROLEBOX_METRICS env var. When unset or falsy, all methods are
 * NO-OPs and snapshot() returns an empty structure.
 */

// ── Histogram bucket boundaries (milliseconds) ───────────────────────

const HISTOGRAM_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 900000, 1800000, 2700000] as const;

const CORE_METRIC_NAMES = {
  counters: ["dispatch_rejected_total", "dispatch_backpressure_retry_total"],
  gauges: ["inflight_tasks", "concurrency_queued"],
} as const;

// ── Public interfaces ────────────────────────────────────────────────

export interface CounterSnapshot {
  value: number;
  labels?: Record<string, string>;
}

export interface GaugeSnapshot {
  value: number;
  labels?: Record<string, string>;
}

export interface HistogramSnapshot {
  buckets: Record<string, number>;
  sum: number;
  count: number;
  labels?: Record<string, string>;
}

export interface MetricsSnapshot {
  counters: Record<string, CounterSnapshot>;
  gauges: Record<string, GaugeSnapshot>;
  histograms: Record<string, HistogramSnapshot>;
}

// ── Metric type implementations ──────────────────────────────────────

/**
 * A monotonically increasing counter.
 *
 * Labels must be low-cardinality only (agent id, status, concurrency key).
 * Do NOT use high-cardinality labels like taskId or sessionId.
 */
export class Counter {
  private _value = 0;

  inc(n = 1): void {
    this._value += n;
  }

  peek(): number {
    return this._value;
  }
}

/**
 * A gauge that can go up and down.
 *
 * Same low-cardinality label constraint as Counter.
 */
export class Gauge {
  private _value = 0;

  inc(n = 1): void {
    this._value += n;
  }

  dec(n = 1): void {
    this._value -= n;
  }

  set(val: number): void {
    this._value = val;
  }

  peek(): number {
    return this._value;
  }
}

/**
 * A histogram with fixed, named bucket boundaries (milliseconds).
 *
 * Buckets consume bounded memory regardless of observation count:
 * only the 11 predefined buckets are tracked.
 *
 * Labels must be low-cardinality only (agent id, status, concurrency key).
 * Do NOT use high-cardinality labels like taskId or sessionId.
 */
export class Histogram {
  private _buckets: Map<string, number>;
  private _sum = 0;
  private _count = 0;

  constructor() {
    this._buckets = new Map<string, number>();
    for (const boundary of HISTOGRAM_BUCKETS) {
      this._buckets.set(String(boundary), 0);
    }
  }

  observe(value: number): void {
    this._sum += value;
    this._count++;
    for (const boundary of HISTOGRAM_BUCKETS) {
      if (value <= boundary) {
        const key = String(boundary);
        this._buckets.set(key, (this._buckets.get(key) ?? 0) + 1);
      }
    }
  }

  peek(): HistogramSnapshot {
    const buckets: Record<string, number> = {};
    for (const [k, v] of this._buckets) {
      buckets[k] = v;
    }
    return { buckets, sum: this._sum, count: this._count };
  }
}

// ── Registry ─────────────────────────────────────────────────────────

/**
 * In-process metrics registry.
 *
 * Creates counters, gauges, and histograms keyed by `name` + sorted labels
 * so that label sets like `{status: "ok"}` and `{status: "fail"}` produce
 * distinct metrics under the same name.
 *
 * When `enabled` is false (default: read from ROLEBOX_METRICS env var),
 * all metric creation returns NO-OP wrappers and snapshot() returns an
 * empty structure.
 */
export class MetricsRegistry {
  private readonly enabled: boolean;

  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  private coreCounters = new Map<string, Counter>();
  private coreGauges = new Map<string, Gauge>();

  constructor(enabled?: boolean) {
    this.enabled = enabled ?? !!process.env.ROLEBOX_METRICS;
  }

  counter(name: string, labels?: Record<string, string>): Counter {
    if (!this.enabled) {
      if (!CORE_METRIC_NAMES.counters.includes(name as typeof CORE_METRIC_NAMES.counters[number])) {
        return new Counter();
      }
      const key = makeKey(name, labels);
      const existing = this.coreCounters.get(key);
      if (existing) return existing;
      const c = new Counter();
      this.coreCounters.set(key, c);
      return c;
    }
    const key = makeKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) return existing;
    const c = new Counter();
    this.counters.set(key, c);
    return c;
  }

  gauge(name: string, labels?: Record<string, string>): Gauge {
    if (!this.enabled) {
      if (!CORE_METRIC_NAMES.gauges.includes(name as typeof CORE_METRIC_NAMES.gauges[number])) {
        return new Gauge();
      }
      const key = makeKey(name, labels);
      const existing = this.coreGauges.get(key);
      if (existing) return existing;
      const g = new Gauge();
      this.coreGauges.set(key, g);
      return g;
    }
    const key = makeKey(name, labels);
    const existing = this.gauges.get(key);
    if (existing) return existing;
    const g = new Gauge();
    this.gauges.set(key, g);
    return g;
  }

  histogram(name: string, labels?: Record<string, string>): Histogram {
    if (!this.enabled) return new Histogram();
    const key = makeKey(name, labels);
    const existing = this.histograms.get(key);
    if (existing) return existing;
    const h = new Histogram();
    this.histograms.set(key, h);
    return h;
  }

  snapshot(): MetricsSnapshot {
    if (!this.enabled) {
      const counters: Record<string, CounterSnapshot> = {};
      for (const [key, c] of this.coreCounters) {
        counters[key] = { value: c.peek() };
      }
      const gauges: Record<string, GaugeSnapshot> = {};
      for (const [key, g] of this.coreGauges) {
        gauges[key] = { value: g.peek() };
      }
      return { counters, gauges, histograms: {} };
    }

    const counters: Record<string, CounterSnapshot> = {};
    for (const [key, c] of this.counters) {
      counters[key] = { value: c.peek() };
    }

    const gauges: Record<string, GaugeSnapshot> = {};
    for (const [key, g] of this.gauges) {
      gauges[key] = { value: g.peek() };
    }

    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [key, h] of this.histograms) {
      histograms[key] = h.peek();
    }

    return { counters, gauges, histograms };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a stable internal map key from a metric name and optional labels.
 *
 * Labels are sorted by key to ensure `{b:1,a:2}` and `{a:2,b:1}` produce
 * the same internal key.
 */
function makeKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels).sort();
  const parts = sorted.map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(",")}}`;
}

// ── Module-level singleton ───────────────────────────────────────────

/** Module-level metrics registry. Gated via ROLEBOX_METRICS env var. */
export const metrics = new MetricsRegistry();
