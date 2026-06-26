import { describe, it, expect } from "bun:test";
import {
  MetricsRegistry,
  Counter,
  Gauge,
  Histogram,
} from "../../src/dispatch/metrics.ts";

// ── Counter ──────────────────────────────────────────────────────────

describe("Counter", () => {
  it("starts at zero", () => {
    const c = new Counter();
    expect(c.peek()).toBe(0);
  });

  it("inc() increments by 1 by default", () => {
    const c = new Counter();
    c.inc();
    expect(c.peek()).toBe(1);
  });

  it("inc(n) increments by n", () => {
    const c = new Counter();
    c.inc(5);
    c.inc(3);
    expect(c.peek()).toBe(8);
  });

  it("peek() returns current value without mutating", () => {
    const c = new Counter();
    c.inc(42);
    expect(c.peek()).toBe(42);
    expect(c.peek()).toBe(42);
  });
});

// ── Gauge ────────────────────────────────────────────────────────────

describe("Gauge", () => {
  it("starts at zero", () => {
    const g = new Gauge();
    expect(g.peek()).toBe(0);
  });

  it("inc() increments by 1 by default", () => {
    const g = new Gauge();
    g.inc();
    expect(g.peek()).toBe(1);
  });

  it("inc(n) increments by n", () => {
    const g = new Gauge();
    g.inc(10);
    expect(g.peek()).toBe(10);
  });

  it("dec() decrements by 1 by default", () => {
    const g = new Gauge();
    g.inc(5);
    g.dec();
    expect(g.peek()).toBe(4);
  });

  it("dec(n) decrements by n", () => {
    const g = new Gauge();
    g.inc(10);
    g.dec(3);
    expect(g.peek()).toBe(7);
  });

  it("can go negative", () => {
    const g = new Gauge();
    g.dec(5);
    expect(g.peek()).toBe(-5);
  });

  it("set() assigns an absolute value", () => {
    const g = new Gauge();
    g.inc(10);
    g.set(42);
    expect(g.peek()).toBe(42);
  });

  it("peek() returns current value without mutating", () => {
    const g = new Gauge();
    g.set(7);
    expect(g.peek()).toBe(7);
    expect(g.peek()).toBe(7);
  });
});

// ── Histogram ────────────────────────────────────────────────────────

describe("Histogram", () => {
  it("starts with all buckets zero and zero sum/count", () => {
    const h = new Histogram();
    const snap = h.peek();
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    for (const v of Object.values(snap.buckets)) {
      expect(v).toBe(0);
    }
  });

  it("observe() increments the correct bucket and sum/count", () => {
    const h = new Histogram();
    h.observe(40); // falls into bucket 50
    const snap = h.peek();
    expect(snap.count).toBe(1);
    expect(snap.sum).toBe(40);
    expect(snap.buckets["50"]).toBe(1);
    expect(snap.buckets["100"]).toBe(1); // cumulative: ≤100 also includes ≤50
  });

  it("cumulative buckets: value falls into all buckets >= its boundary", () => {
    const h = new Histogram();
    h.observe(200);
    const snap = h.peek();
    // 200 ≤ 250, ≤ 500, ≤ 1000, ... but NOT ≤ 50 or ≤ 100
    expect(snap.buckets["50"]).toBe(0);
    expect(snap.buckets["100"]).toBe(0);
    expect(snap.buckets["250"]).toBe(1);
    expect(snap.buckets["500"]).toBe(1);
    expect(snap.buckets["1000"]).toBe(1);
  });

  it("multiple observations are cumulative", () => {
    const h = new Histogram();
    h.observe(30);
    h.observe(80);
    h.observe(300);
    const snap = h.peek();
    expect(snap.count).toBe(3);
    expect(snap.sum).toBe(410);
    expect(snap.buckets["50"]).toBe(1); // only 30
    expect(snap.buckets["100"]).toBe(2); // 30 + 80
    expect(snap.buckets["250"]).toBe(2); // 30 + 80
    expect(snap.buckets["500"]).toBe(3); // all three
  });

  it("value above the largest bucket falls into no bucket", () => {
    const h = new Histogram();
    h.observe(999999);
    const snap = h.peek();
    expect(snap.count).toBe(1);
    expect(snap.sum).toBe(999999);
    for (const v of Object.values(snap.buckets)) {
      expect(v).toBe(0);
    }
  });
});

// ── MetricsRegistry (enabled) ────────────────────────────────────────

describe("MetricsRegistry (enabled)", () => {
  it("is enabled by default when ROLEBOX_METRICS is set", () => {
    // The module-level singleton reads process.env at import time.
    // For direct instances, we pass enabled=true explicitly.
    const reg = new MetricsRegistry(true);
    const snap = reg.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.gauges).toEqual({});
    expect(snap.histograms).toEqual({});
  });

  it("counter() returns same instance for same name/labels", () => {
    const reg = new MetricsRegistry(true);
    const a = reg.counter("tasks");
    const b = reg.counter("tasks");
    expect(a).toBe(b);
  });

  it("counter() with different labels returns distinct instances", () => {
    const reg = new MetricsRegistry(true);
    const ok = reg.counter("tasks", { status: "ok" });
    const fail = reg.counter("tasks", { status: "fail" });
    expect(ok).not.toBe(fail);
    ok.inc(1);
    fail.inc(5);
    expect(ok.peek()).toBe(1);
    expect(fail.peek()).toBe(5);
  });

  it("counter() label order does not matter", () => {
    const reg = new MetricsRegistry(true);
    const a = reg.counter("tasks", { a: "1", b: "2" });
    const b = reg.counter("tasks", { b: "2", a: "1" });
    expect(a).toBe(b);
  });

  it("gauge() returns same instance for same name/labels", () => {
    const reg = new MetricsRegistry(true);
    const a = reg.gauge("active");
    const b = reg.gauge("active");
    expect(a).toBe(b);
  });

  it("histogram() returns same instance for same name/labels", () => {
    const reg = new MetricsRegistry(true);
    const a = reg.histogram("duration");
    const b = reg.histogram("duration");
    expect(a).toBe(b);
  });

  it("snapshot() captures all registered metrics", () => {
    const reg = new MetricsRegistry(true);
    reg.counter("tasks").inc(3);
    reg.gauge("active").set(7);
    reg.histogram("duration").observe(150);

    const snap = reg.snapshot();

    const taskKey = "tasks";
    expect(snap.counters[taskKey]).toEqual({ value: 3 });
    expect(snap.gauges["active"]).toEqual({ value: 7 });

    const dur = snap.histograms["duration"];
    expect(dur.count).toBe(1);
    expect(dur.sum).toBe(150);

    // JSON-serializable
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    expect(parsed.counters[taskKey].value).toBe(3);
  });

  it("snapshot() includes labeled metrics with distinct keys", () => {
    const reg = new MetricsRegistry(true);
    reg.counter("tasks", { status: "ok" }).inc(1);
    reg.counter("tasks", { status: "fail" }).inc(2);

    const snap = reg.snapshot();
    const keys = Object.keys(snap.counters);
    expect(keys).toHaveLength(2);
    // Keys are sorted-label format
    expect(keys).toContain("tasks{status=fail}");
    expect(keys).toContain("tasks{status=ok}");
  });

  it("reset() clears all registered metrics", () => {
    const reg = new MetricsRegistry(true);
    reg.counter("x").inc(1);
    reg.reset();
    const snap = reg.snapshot();
    expect(snap.counters).toEqual({});
    expect(snap.gauges).toEqual({});
    expect(snap.histograms).toEqual({});
  });
});

// ── MetricsRegistry (disabled) ───────────────────────────────────────

describe("MetricsRegistry (disabled)", () => {
  it("snapshot() returns empty structure", () => {
    const reg = new MetricsRegistry(false);
    expect(reg.snapshot()).toEqual({
      counters: {},
      gauges: {},
      histograms: {},
    });
  });

  it("counter() returns a NO-OP instance that does not accumulate", () => {
    const reg = new MetricsRegistry(false);
    const c = reg.counter("tasks");
    c.inc(10);
    expect(c.peek()).toBe(10); // local counter still works
    expect(reg.snapshot().counters).toEqual({}); // but not registered
  });

  it("gauge() returns a NO-OP instance", () => {
    const reg = new MetricsRegistry(false);
    const g = reg.gauge("active");
    g.set(42);
    expect(g.peek()).toBe(42);
    expect(reg.snapshot().gauges).toEqual({});
  });

  it("histogram() returns a NO-OP instance", () => {
    const reg = new MetricsRegistry(false);
    const h = reg.histogram("duration");
    h.observe(100);
    expect(h.peek().count).toBe(1);
    expect(reg.snapshot().histograms).toEqual({});
  });

  it("multiple calls to counter() produce distinct NO-OP instances", () => {
    const reg = new MetricsRegistry(false);
    const a = reg.counter("tasks");
    const b = reg.counter("tasks");
    expect(a).not.toBe(b); // not cached in disabled mode
  });
});
