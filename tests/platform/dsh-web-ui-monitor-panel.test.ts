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

/** `useRef` — a per-slot mutable cell (shares the `useState` slot array). */
function useRef<T>(initial: T): { current: T } {
  const rs = renderState!;
  const slot = hookIndex++;
  if (rs.states.length <= slot) rs.states.push({ current: initial });
  return rs.states[slot] as { current: T };
}

mock.module("react", () => ({ useState, useEffect, useRef, createElement: jsx, Fragment: FRAGMENT }));
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

/**
 * The glyph component the attention band chose. The harness stores function
 * components as vnodes without invoking them (there is no real DOM), so the
 * component IDENTITY is what is observable here — which is exactly what the
 * assertion needs: which of the three glyphs the band selected.
 */
function bandGlyph(): string {
  const glyph = byClass("rolebox-monitor-attention-glyph")[0]!;
  const child = childNodes(glyph)[0] as VNode;
  return (child.type as { name?: string }).name ?? "";
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

      // Every rolebox token CONSUMPTION must carry a comma + fallback, so the
      // bare var() scan above can never become a loophole for a private
      // namespace. Definitions are plain declarations and are not scanned.
      const bareRoleboxVars = [...cssText.matchAll(/var\((--rolebox-[a-z0-9-]+)\)/g)].map((m) => m[1]!);
      expect(bareRoleboxVars).toEqual([]);

      // The neutral chips must be distinguishable in KIND, not just in alpha —
      // the word is the primary channel, but a 1px 4%-alpha hairline is not one.
      const stoppedBlock =
        /\.rolebox-monitor-chip-stopped\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(stoppedBlock).toContain("--rolebox-border-strong");
      const idleBlock =
        /\.rolebox-monitor-chip-idle\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(idleBlock).toContain("rolebox-surface-hover");

      // Both rolebox surfaces move on ONE curve — the host's (--ds-ease-in-out).
      expect(cssText.match(/--rolebox-ease[a-z-]*:/g)).toEqual(["--rolebox-ease:"]);
    });
  });

  describe("run-state vocabulary", () => {
    it("classifies the real engine (idle | executing | complete), loop and node vocabularies", () => {
      // The loop state machine, verbatim (src/loop/types.ts).
      expect(panel.classifyRunPhase("activating")).toBe("running");
      expect(panel.classifyRunPhase("dispatching")).toBe("running");
      expect(panel.classifyRunPhase("awaiting_worker")).toBe("running");
      expect(panel.classifyRunPhase("summarizing")).toBe("running");
      expect(panel.classifyRunPhase("finalizing")).toBe("running");
      expect(panel.classifyRunPhase("complete")).toBe("complete");
      expect(panel.classifyRunPhase("error")).toBe("failed");
      // A cancelled run stopped, but it did not break — calling it Failed
      // would be a lie.
      expect(panel.classifyRunPhase("cancelled")).toBe("stopped");
      expect(panel.classifyRunPhase("interrupted")).toBe("stopped");
      // Engine vocabulary.
      expect(panel.classifyRunPhase("executing")).toBe("running");
      // The engine's resting phase is a real state, not an unreadable one.
      expect(panel.classifyRunPhase("idle")).toBe("idle");
      expect(panel.classifyRunPhase("blocked")).toBe("blocked");
      expect(panel.classifyRunPhase("failed")).toBe("failed");
      // Never guess: an unrecognised or absent phase is neutrally unknown.
      expect(panel.classifyRunPhase("weird_thing")).toBe("unknown");
      expect(panel.classifyRunPhase(undefined)).toBe("unknown");
    });

    it("derives the attention verdict from the payload alone", () => {
      const healthy = panel.deriveAttention(STATUS_BODY.engineGraphs, STATUS_BODY.loops);
      expect(healthy.needsAttention).toBe(false);
      expect(healthy.running).toBe(2);
      expect(healthy.failed).toEqual([]);

      const broken = panel.deriveAttention(
        [{ ...STATUS_BODY.engineGraphs[0]!, phase: "failed" }],
        STATUS_BODY.loops,
      );
      expect(broken.needsAttention).toBe(true);
      expect(broken.failed).toEqual(["graph-1"]);
    });

    it("treats an escalated node as blocked until the graph completes", () => {
      // idle + an escalated node: a node is waiting on a human, which the
      // host's own renderer paints as an error.
      const awaiting = panel.deriveAttention(
        [
          {
            ...STATUS_BODY.engineGraphs[0]!,
            phase: "idle",
            nodeStatusCounts: { escalate: 1 },
          },
        ],
        [],
      );
      expect(awaiting.needsAttention).toBe(true);
      expect(awaiting.blocked).toEqual(["graph-1"]);

      // A historical escalation on a finished graph must not alarm forever.
      const finished = panel.deriveAttention(
        [
          {
            ...STATUS_BODY.engineGraphs[0]!,
            phase: "complete",
            nodeStatusCounts: { escalate: 1 },
          },
        ],
        [],
      );
      expect(finished.needsAttention).toBe(false);
    });

    it("keeps a terminal graph's verdict despite its historical stopped nodes", () => {
      // nodeStatusCounts is a snapshot that OUTLIVES the run, so a finished
      // graph must never pin a permanent red band beside its own green chip.
      expect(
        panel.deriveAttention(
          [
            {
              ...STATUS_BODY.engineGraphs[0]!,
              phase: "complete",
              nodeStatusCounts: { timeout: 1, done: 3 },
            },
          ],
          [],
        ).needsAttention,
      ).toBe(false);
      expect(
        panel.deriveAttention(
          [
            {
              ...STATUS_BODY.engineGraphs[0]!,
              phase: "complete",
              nodeStatusCounts: { cancelled: 1, done: 2 },
            },
          ],
          [],
        ).needsAttention,
      ).toBe(false);
      // The carve-out: a HITL gate survives cancellation — the engine leaves the
      // blocked node for the human while forcing the phase to complete — so it
      // must still raise the verdict on a terminal graph.
      expect(
        panel.deriveAttention(
          [
            {
              ...STATUS_BODY.engineGraphs[0]!,
              phase: "complete",
              nodeStatusCounts: { blocked: 1 },
            },
          ],
          [],
        ),
      ).toMatchObject({ needsAttention: true, blocked: ["graph-1"] });

      // On a LIVE graph the same node statuses do raise the verdict.
      expect(
        panel.deriveAttention(
          [
            {
              ...STATUS_BODY.engineGraphs[0]!,
              phase: "executing",
              nodeStatusCounts: { timeout: 1, running: 1 },
            },
          ],
          [],
        ).needsAttention,
      ).toBe(true);
    });

    it("names unreadable phases instead of claiming all clear", () => {
      const murky = panel.deriveAttention(
        [{ ...STATUS_BODY.engineGraphs[0]!, phase: "quantum_superposition" }],
        [],
      );
      expect(murky.needsAttention).toBe(false);
      expect(murky.unknown).toEqual(["graph-1"]);
      // The band must NOT assert "All clear" over data it could not read.
      expect(panel.describeAttention(murky)).toContain("Unrecognized: graph-1");
    });

    it("carries the admission into the band and the live region", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [
          { ...STATUS_BODY.engineGraphs[0]!, phase: "quantum_superposition" },
        ],
      };
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(textOf(band)).toContain("state unrecognized");
      expect(band.props.className).toContain("rolebox-monitor-attention-calm");
      // A check mark must never sit over an admission: the neutral question
      // glyph is what this state renders.
      expect(bandGlyph()).toBe("QuestionGlyph");
      // The live region must not disagree with the band about the same snapshot.
      expect(textOf(statusSeat())).toContain("state unrecognized");
    });

    it("surfaces a failed node on a graph whose own phase still reads running", () => {
      const verdict = panel.deriveAttention(
        [
          {
            ...STATUS_BODY.engineGraphs[0]!,
            phase: "executing",
            nodeStatusCounts: { running: 1, failed: 2 },
          },
        ],
        [],
      );
      expect(verdict.needsAttention).toBe(true);
      expect(verdict.failed).toEqual(["graph-1"]);
    });

    it("does not raise attention for a cancelled run", () => {
      const verdict = panel.deriveAttention([], [
        { ...STATUS_BODY.loops[0]!, phase: "cancelled" },
      ]);
      expect(verdict.needsAttention).toBe(false);
    });
  });

  describe("attention band", () => {
    it("leads with an all-clear verdict for a healthy snapshot", async () => {
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(band.props.className).toContain("rolebox-monitor-attention-calm");
      expect(textOf(band)).toContain("All clear");
      // "All clear" is the only state allowed a check mark.
      expect(bandGlyph()).toBe("CheckGlyph");
      // The band is the first child of the body — verdict before evidence.
      expect(childNodes(byClass("rolebox-monitor-body")[0]!)[0]).toBe(band);
    });

    it("raises an alert band and names what needs attention", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ ...STATUS_BODY.engineGraphs[0]!, phase: "failed" }],
      };
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(band.props.className).toContain("rolebox-monitor-attention-alert");
      expect(textOf(band)).toContain("1 need attention");
      expect(textOf(band)).toContain("Failed: graph-1");
      expect(bandGlyph()).toBe("AlertGlyph");
      // The live-region seat announces the verdict too.
      expect(textOf(statusSeat())).toContain("1 need attention");
    });
  });

  describe("state chips", () => {
    it("pairs every raw phase with a normalised state word", async () => {
      mountPanel();
      await settle();

      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      // The raw backend phase is never replaced by the word.
      expect(bodyText).toContain("executing");
      expect(bodyText).toContain("awaiting_worker");
      // Both the graph and the loop are running.
      expect(byClass("rolebox-monitor-chip-running")).toHaveLength(2);
      expect(byClass("rolebox-monitor-chip-complete")).toHaveLength(0);
    });

    it("moves the chip to its terminal state after a refresh", async () => {
      mountPanel();
      await settle();

      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ ...STATUS_BODY.engineGraphs[0]!, phase: "complete" }],
      };
      click(refreshButton());
      await settle();

      expect(byClass("rolebox-monitor-chip-complete")).toHaveLength(1);
      expect(byClass("rolebox-monitor-chip-running")).toHaveLength(1);
      const bodyText = textOf(byClass("rolebox-monitor-body")[0]!);
      expect(bodyText).toContain("complete");
    });
  });

  describe("section counts", () => {
    it("states how much each section holds", async () => {
      mountPanel();
      await settle();

      const counts = byClass("rolebox-monitor-section-count");
      expect(counts).toHaveLength(4);
      expect(textOf(counts[0]!)).toBe("1"); // engine graphs
      expect(textOf(counts[1]!)).toBe("1"); // loops
      expect(textOf(counts[3]!)).toBe("2"); // sessions
    });
  });

  describe("metric overflow", () => {
    it("caps a group and exposes the rest through an accessible disclosure", async () => {
      const counters: Record<string, { value: number }> = {};
      for (let i = 0; i < 10; i++) counters["c" + i] = { value: i };
      cfg.status = { engineGraphs: STATUS_BODY.engineGraphs };
      cfg.metrics = { counters, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      const toggle = byClass("rolebox-monitor-more")[0]!;
      expect(toggle).toBeDefined();
      expect(toggle.props["aria-expanded"]).toBe(false);
      expect(textOf(toggle)).toBe("Show all 10");
      expect(toggle.props["aria-controls"]).toBe("rolebox-monitor-counters");
      // The 9th row is behind the disclosure.
      expect(textOf(byClass("rolebox-monitor-body")[0]!)).not.toContain("c9");

      click(toggle);
      // Re-query: the click re-rendered the tree, so the old vnode is stale.
      const toggled = byClass("rolebox-monitor-more")[0]!;
      expect(toggled.props["aria-expanded"]).toBe(true);
      expect(textOf(toggled)).toBe("Show fewer");
      expect(textOf(byClass("rolebox-monitor-body")[0]!)).toContain("c9");
    });

    it("renders no disclosure when a group fits the cap", async () => {
      mountPanel();
      await settle();
      expect(byClass("rolebox-monitor-more")).toHaveLength(0);
    });
  });

  describe("loading and refresh posture", () => {
    it("substitutes a content-shaped skeleton for the first load only", async () => {
      cfg.gate = true;
      mountPanel();

      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(1);
      expect(byClass("rolebox-monitor-spinner")).toHaveLength(1);
      // The skeleton mirrors the real layout: an attention band plus cards.
      expect(byClass("rolebox-monitor-skeleton-card")).toHaveLength(3);

      releaseGate();
      await settle();
      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(0);
    });

    it("names a refresh as a refresh rather than a first load", async () => {
      mountPanel();
      await settle();
      expect(textOf(statusSeat())).toContain("Updated at");

      cfg.gate = true;
      click(refreshButton());
      // With data already on screen the seat says what is happening, and the
      // body is never replaced by the skeleton.
      expect(textOf(statusSeat())).toBe("Refreshing…");
      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(0);
      expect(byClass("rolebox-monitor-body")).toHaveLength(1);

      releaseGate();
      await settle();
    });
  });
});
