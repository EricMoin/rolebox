/// <reference types="bun-types" />

/**
 * RoleboxMonitorPanel behavior tests — the browser-half monitoring settings
 * page (`src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx`).
 *
 * Verifies the panel's interaction contract:
 *   - the same-origin API contract (`GET /rolebox/status`,
 *     `GET /rolebox/metrics`) is fetched on mount, in parallel;
 *   - engine-graph readings render (phase, node count + per-status counts,
 *     budget tokens/cost) and loop readings render (origin session, agent,
 *     phase, round progress);
 *   - metrics readings render, including the core dispatch counter/gauge
 *     seats, plus histogram sum/count;
 *   - the manual Refresh control re-fetches both endpoints (with the panel
 *     `aria-busy` and the control disabled while in flight) and updates the
 *     readings;
 *   - the loading / error / empty states: a pending initial fetch shows the
 *     loading state, a failed fetch shows an `role="alert"` error state with
 *     a Retry control that re-runs the load, an empty snapshot shows the
 *     explicit empty state, and a refresh failure with previously rendered
 *     data keeps the data visible with the error on the status seat;
 *   - accessibility posture: the status seat is a live region
 *     (`role="status"`), the panel root carries `aria-busy` and the
 *     `data-rolebox-monitor` marker;
 *   - the CSS module ships `rolebox-monitor-` namespaced rules whose only
 *     design tokens are `--dsw-*` (no `--dsh-*` leaks).
 *
 * ── Harness ────────────────────────────────────────────────────────────────
 * React is NOT a devDependency of this repo (the temporary
 * `react.stub.d.ts` covers the type surface), so — like the sibling
 * `dsh-web-ui-client.test.ts` — `react` and the JSX runtime are mocked
 * BEFORE the panel module is imported. As in `dsh-web-ui-dock.test.ts`, the
 * double here is STATEFUL: a ~100-line mini-React (hook slots per component
 * instance, synchronous re-render on `setState`, effect flush with
 * dependency comparison and cleanup) plus a virtual-DOM tree with query
 * helpers — enough to exercise the component's full state machine
 * in-process, with `fetch` double-routed through a per-test config and
 * assertions on the rendered vnode tree (no DOM, no jsdom — bun-native).
 *
 * @module
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Stateful react double + tree harness ───────────────────────────────────

/** One rendered JSX element (bun's automatic runtime passes children via props). */
interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}

/** Per-mount hook slots (the mini-React "fiber"). */
interface RenderState {
  states: unknown[];
  effects: Array<{ deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }>;
  pending: Array<{
    slot: number;
    effect: () => void | (() => void);
    deps: readonly unknown[] | undefined;
  }>;
}

let renderState: RenderState | null = null;
let currentComponent: ((props: unknown) => unknown) | null = null;
let currentProps: unknown = null;
let hookIndex = 0;
let rendering = false;
let dirty = false;
let tree: VNode | null = null;

/** `useState` — one state slot per hook call, synchronous re-render on change. */
function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void] {
  const rs = renderState!;
  const slot = hookIndex++;
  if (rs.states.length <= slot) {
    rs.states.push(typeof initial === "function" ? (initial as () => S)() : initial);
  }
  return [
    rs.states[slot] as S,
    (value) => {
      const next =
        typeof value === "function"
          ? (value as (previous: S) => S)(rs.states[slot] as S)
          : value;
      // React's Object.is bail-out: an identical value does not re-render
      // (keeps effect-driven setState from looping).
      if (Object.is(next, rs.states[slot])) return;
      rs.states[slot] = next;
      if (rendering) {
        dirty = true;
        return;
      }
      renderNow();
    },
  ];
}

/** `useEffect` — runs after the commit; re-runs on dependency change (with cleanup). */
function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
  const rs = renderState!;
  const slot = hookIndex++;
  const prev = rs.effects[slot];
  const prevDeps = prev?.deps;
  const changed =
    prev === undefined ||
    deps === undefined ||
    prevDeps === undefined ||
    deps.length !== prevDeps.length ||
    deps.some((dep, index) => !Object.is(dep, prevDeps[index]));
  if (changed) rs.pending.push({ slot, effect, deps });
}

function renderNow(): void {
  if (currentComponent === null || renderState === null) return;
  rendering = true;
  hookIndex = 0;
  try {
    tree = currentComponent(currentProps) as VNode;
  } finally {
    rendering = false;
  }
  const due = renderState.pending.splice(0);
  for (const { slot, effect, deps } of due) {
    const prev = renderState.effects[slot];
    if (prev?.cleanup) prev.cleanup();
    // Record the slot BEFORE running the body: a setState inside the effect
    // triggers a synchronous re-render, and the re-registration must see
    // this effect's deps (otherwise the same effect re-queues forever).
    renderState.effects[slot] = { deps, cleanup: undefined };
    const cleanup = effect();
    renderState.effects[slot] = {
      deps,
      cleanup: typeof cleanup === "function" ? cleanup : undefined,
    };
  }
  if (dirty) {
    dirty = false;
    renderNow();
  }
}

/** Mount the component (fresh hook slots) and run its mount effects. */
function mount(component: (props: unknown) => unknown, props: unknown): void {
  currentComponent = component;
  currentProps = props;
  renderState = { states: [], effects: [], pending: [] };
  dirty = false;
  renderNow();
}

// ── Tree query helpers ─────────────────────────────────────────────────────

function childNodes(node: VNode): Array<VNode | string | number> {
  const children = node.props.children;
  if (children === undefined || children === null || typeof children === "boolean") return [];
  if (Array.isArray(children)) {
    return children.flat(Infinity) as Array<VNode | string | number>;
  }
  return [children as VNode | string | number];
}

function walk(node: unknown, visit: (vnode: VNode) => void): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  const vnode = node as VNode;
  if (typeof vnode !== "object" || vnode.type === undefined || vnode.props === undefined) return;
  visit(vnode);
  for (const child of childNodes(vnode)) walk(child, visit);
}

function allNodes(): VNode[] {
  const out: VNode[] = [];
  walk(tree, (node) => out.push(node));
  return out;
}

function byClass(cls: string): VNode[] {
  return allNodes().filter((node) => {
    const className = node.props.className;
    return typeof className === "string" && className.split(" ").includes(cls);
  });
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node === "boolean") return "";
  const vnode = node as VNode;
  if (typeof vnode !== "object" || vnode.type === undefined || vnode.props === undefined) return "";
  return childNodes(vnode).map(textOf).join("");
}

function click(node: VNode): void {
  const onClick = node.props.onClick;
  if (typeof onClick === "function") (onClick as () => void)();
}

// ── Module mocks (must precede the panel import) ───────────────────────────

const FRAGMENT = Symbol.for("react.fragment");
const jsx = (type: unknown, props: Record<string, unknown>): VNode => ({ type, props });

mock.module("react", () => ({ useState, useEffect, createElement: jsx, Fragment: FRAGMENT }));
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));
mock.module("react/jsx-dev-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));

// ── Module under test (dynamic import: mocks must precede the graph) ───────

const panel = await import("../../src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx");
const css = await import("../../src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.css.ts");

// ── fetch double ───────────────────────────────────────────────────────────

interface FetchConfig {
  status: unknown;
  metrics: unknown;
  statusOk: boolean;
  metricsOk: boolean;
  /** When true, both fetches hang until `releaseGate` resolves them. */
  gate: boolean;
}

let cfg: FetchConfig;
const calls: string[] = [];
const pendingGates: Array<() => void> = [];

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function releaseGate(): void {
  const pending = pendingGates.splice(0);
  for (const resolve of pending) resolve();
}

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push(method + " " + url);
  if (cfg.gate) {
    return new Promise<Response>((resolve) => {
      pendingGates.push(() =>
        resolve(fakeResponse(200, url === panel.STATUS_ENDPOINT ? cfg.status : cfg.metrics)),
      );
    });
  }
  if (url === panel.STATUS_ENDPOINT) {
    if (!cfg.statusOk) return Promise.resolve(fakeResponse(500, { ok: false, error: "boom" }));
    return Promise.resolve(fakeResponse(200, cfg.status));
  }
  if (url === panel.METRICS_ENDPOINT) {
    if (!cfg.metricsOk) return Promise.resolve(fakeResponse(500, { ok: false, error: "boom" }));
    return Promise.resolve(fakeResponse(200, cfg.metrics));
  }
  return Promise.resolve(fakeResponse(404, { ok: false, error: "not found" }));
}) as typeof fetch;

// ── Fixtures and helpers ───────────────────────────────────────────────────

const STATUS_BODY = {
  timestamp: "2026-08-22T09:00:00.000Z",
  loops: [
    {
      originSessionId: "loop-1",
      agent: "engineer",
      phase: "awaiting_worker",
      current: 2,
      total: 5,
      mode: "inherit",
    },
  ],
  engineGraphs: [
    {
      graphId: "graph-1",
      phase: "executing",
      nodeCount: 3,
      nodeStatusCounts: { running: 1, completed: 2 },
      budget: {
        sessionsSpawned: 1,
        totalInputTokens: 1200,
        totalOutputTokens: 800,
        totalCost: 0.012,
      },
      loopGroups: [{ id: "lg-1", traversalCount: 2, maxTraversals: 5 }],
      updatedAt: "2026-08-22T09:00:00.000Z",
    },
  ],
  sessions: { count: 2, recentIds: ["sess-1", "sess-2"] },
};

const METRICS_BODY = {
  counters: {
    dispatch_rejected_total: { value: 7 },
    dispatch_backpressure_retry_total: { value: 1 },
  },
  gauges: {
    inflight_tasks: { value: 4 },
    concurrency_queued: { value: 0 },
  },
  histograms: {
    request_duration_ms: { count: 5, sum: 420, buckets: {} },
  },
};

function mountPanel(): void {
  calls.length = 0;
  pendingGates.length = 0;
  mount(panel.RoleboxMonitorPanel as unknown as (props: unknown) => unknown, {});
}

/** Flush the microtask chain (fetch → json → setState) before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function root(): VNode {
  return byClass("rolebox-monitor")[0]!;
}

function refreshButton(): VNode {
  return byClass("rolebox-monitor-refresh")[0]!;
}

function statusSeat(): VNode {
  return byClass("rolebox-monitor-status")[0]!;
}

function stateSeat(): VNode {
  return byClass("rolebox-monitor-state")[0]!;
}

/** Text of the `dd` value of the kv row whose `dt` label is `name`. */
function kvValue(name: string): string {
  const row = byClass("rolebox-monitor-kv-row").find((node) => {
    const children = childNodes(node);
    return children.length > 0 && textOf(children[0]!) === name;
  });
  expect(row).toBeDefined();
  const children = childNodes(row!);
  return textOf(children[1] ?? "");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleboxMonitorPanel", () => {
  beforeEach(() => {
    cfg = { status: STATUS_BODY, metrics: METRICS_BODY, statusOk: true, metricsOk: true, gate: false };
  });

  describe("API contract", () => {
    it("declares the same-origin monitoring endpoints", () => {
      expect(panel.STATUS_ENDPOINT).toBe("/rolebox/status");
      expect(panel.METRICS_ENDPOINT).toBe("/rolebox/metrics");
    });

    it("fetches both endpoints in parallel on mount", async () => {
      mountPanel();
      await settle();
      expect(calls).toEqual(["GET /rolebox/status", "GET /rolebox/metrics"]);
      expect(root().props["aria-busy"]).toBe(false);
    });
  });

  describe("readings", () => {
    it("renders engine-graph readings (phase, node counts, budget)", async () => {
      mountPanel();
      await settle();

      const body = byClass("rolebox-monitor-body")[0]!;
      const bodyText = textOf(body);
      expect(bodyText).toContain("Engine graphs");
      expect(bodyText).toContain("graph-1");
      expect(bodyText).toContain("executing");
      expect(kvValue("Nodes")).toBe("3");
      expect(kvValue("running")).toBe("1");
      expect(kvValue("completed")).toBe("2");
      expect(kvValue("Sessions spawned")).toBe("1");
      expect(kvValue("Tokens in/out")).toBe("1200 / 800");
      expect(kvValue("Cost")).toBe("0.012");
      // loop-group ids and last update ride the graph card meta.
      expect(bodyText).toContain("lg-1");
      expect(bodyText).toContain("Updated 2026-08-22T09:00:00.000Z");
    });

    it("renders loop readings (origin session, agent, phase, progress)", async () => {
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("Loops");
      expect(bodyText).toContain("loop-1");
      expect(bodyText).toContain("engineer");
      expect(bodyText).toContain("awaiting_worker");
      expect(bodyText).toContain("2/5");
    });

    it("renders metrics readings including the core counter/gauge and histograms", async () => {
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("Metrics");
      expect(bodyText).toContain("Counters");
      expect(bodyText).toContain("Gauges");
      // Core dispatch counter/gauge seats.
      expect(kvValue("dispatch_rejected_total")).toBe("7");
      expect(kvValue("dispatch_backpressure_retry_total")).toBe("1");
      expect(kvValue("inflight_tasks")).toBe("4");
      expect(kvValue("concurrency_queued")).toBe("0");
      // Histogram sum/count.
      expect(bodyText).toContain("request_duration_ms");
      expect(bodyText).toContain("5 samples · 420ms");
    });

    it("renders the sessions line with count, recent ids and active roles", async () => {
      const withRoles = {
        ...STATUS_BODY,
        sessions: {
          count: 2,
          recentIds: ["sess-1", "sess-2"],
          activeRoles: { "sess-1": "engineer" },
        },
      };
      cfg.status = withRoles;
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("Sessions");
      expect(bodyText).toContain("2 sessions");
      expect(bodyText).toContain("sess-1 (engineer)");
      expect(bodyText).toContain("sess-2");
    });
  });

  describe("manual refresh", () => {
    it("re-fetches both endpoints, busy-gates the control, and updates the readings", async () => {
      mountPanel();
      await settle();
      expect(calls).toHaveLength(2);

      // Simulate a changed backend: a fresh graph with a new phase/id.
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [
          { ...STATUS_BODY.engineGraphs[0]!, graphId: "graph-2", phase: "complete" },
        ],
      };

      click(refreshButton());
      // In flight: the panel is busy and the control is disabled.
      expect(root().props["aria-busy"]).toBe(true);
      expect(refreshButton().props.disabled).toBe(true);
      await settle();

      expect(calls).toHaveLength(4);
      expect(refreshButton().props.disabled).toBe(false);
      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("graph-2");
      expect(bodyText).toContain("complete");
      // The live-region status seat announces the refresh outcome.
      expect(textOf(statusSeat())).toContain("Updated at");
      expect(statusSeat().props.title).toContain("Updated at");
    });
  });

  describe("loading / error / empty states", () => {
    it("shows the loading state with aria-busy while the initial fetch is in flight", async () => {
      cfg.gate = true;
      mountPanel();

      expect(root().props["aria-busy"]).toBe(true);
      expect(refreshButton().props.disabled).toBe(true);
      const state = stateSeat();
      expect(state.props.role).toBe("status");
      expect(textOf(state)).toBe("Loading monitoring data…");

      releaseGate();
      await settle();
      expect(root().props["aria-busy"]).toBe(false);
      expect(byClass("rolebox-monitor-body")).toHaveLength(1);
    });

    it("shows an alert error state with a Retry control when a fetch fails", async () => {
      cfg.statusOk = false;
      mountPanel();
      await settle();

      expect(root().props["aria-busy"]).toBe(false);
      const state = stateSeat();
      expect(state.props.role).toBe("alert");
      expect(textOf(state)).toContain("Failed to load monitoring data");
      expect(textOf(state)).toContain("HTTP 500");
      expect(byClass("rolebox-monitor-retry")).toHaveLength(1);

      // Retry re-runs the load once the backend recovers.
      cfg.statusOk = true;
      click(byClass("rolebox-monitor-retry")[0]!);
      await settle();
      expect(calls).toHaveLength(4);
      expect(byClass("rolebox-monitor-body")).toHaveLength(1);
      expect(textOf(byClass("rolebox-monitor-body")[0]!)).toContain("graph-1");
    });

    it("shows the explicit empty state when the snapshot carries no data", async () => {
      cfg.status = { sessions: { count: 0, recentIds: [] } };
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      const state = stateSeat();
      expect(state.props.role).toBe("status");
      expect(textOf(state)).toBe("No monitoring data available");
      expect(byClass("rolebox-monitor-body")).toHaveLength(0);
    });

    it("keeps previously rendered data visible when a refresh fails (error on the status seat)", async () => {
      mountPanel();
      await settle();

      cfg.statusOk = false;
      click(refreshButton());
      await settle();

      // Data stays on screen; the failure lands on the live-region seat.
      expect(byClass("rolebox-monitor-body")).toHaveLength(1);
      expect(textOf(byClass("rolebox-monitor-body")[0]!)).toContain("graph-1");
      expect(statusSeat().props.title).toContain("Failed to load monitoring data");
      expect(statusSeat().props.className).toContain("rolebox-monitor-status-error");
    });
  });

  describe("defensive rendering", () => {
    it("renders only the sections the backend payload carries", async () => {
      cfg.status = { engineGraphs: STATUS_BODY.engineGraphs };
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("Engine graphs");
      expect(bodyText).toContain("graph-1");
      // Loop / metrics / sessions seats absent → their sections are omitted.
      expect(byClass("rolebox-monitor-loop")).toHaveLength(0);
      expect(byClass("rolebox-monitor-metric-group")).toHaveLength(0);
      expect(byClass("rolebox-monitor-sessions")).toHaveLength(0);
    });

    it("accepts a Map-serialized loops seat and an array sessions seat", async () => {
      cfg.status = {
        loops: { "loop-9": { originSessionId: "loop-9", agent: "qa", phase: "complete", current: 3, total: 3 } },
        sessions: [{ id: "sess-a" }, { id: "sess-b" }],
      };
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("loop-9");
      expect(bodyText).toContain("qa");
      expect(bodyText).toContain("3/3");
      expect(bodyText).toContain("2 sessions");
      expect(bodyText).toContain("sess-a");
      expect(bodyText).toContain("sess-b");
    });
  });

  describe("accessibility posture", () => {
    it("exposes a live-region status seat and the panel marker", async () => {
      mountPanel();
      await settle();

      expect(root().props["data-rolebox-monitor"]).toBe(true);
      const seat = statusSeat();
      expect(seat.props.role).toBe("status");
      expect(textOf(seat)).toContain("Updated at");
      expect(refreshButton().props.type).toBe("button");
    });
  });

  describe("CSS posture", () => {
    it("ships namespaced monitor rules with only --dsw-* tokens", () => {
      const cssText = css.monitorCss;
      for (const cls of [
        "rolebox-monitor-panel",
        "rolebox-monitor-header",
        "rolebox-monitor-refresh",
        "rolebox-monitor-status",
        "rolebox-monitor-state",
        "rolebox-monitor-retry",
        "rolebox-monitor-body",
        "rolebox-monitor-graph",
        "rolebox-monitor-kv-row",
        "rolebox-monitor-loop",
        "rolebox-monitor-metric-group",
        "rolebox-monitor-sessions",
      ]) {
        expect(cssText).toContain("." + cls);
      }
      // Every var() reference is a dsw design token — no new --dsh-* leaks.
      const allVars = [...cssText.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!);
      const leaks = allVars.filter((token) => !token.startsWith("--dsw-"));
      expect(leaks).toEqual([]);
    });
  });
});
