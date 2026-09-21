/// <reference types="bun-types" />

/**
 * RoleboxMonitorPanel behavior tests — the browser-half rolebox RUN CONSOLE
 * (`src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx`), a dsh
 * right-Sidebar page tab (`sidebar.right.pane.tab`, keyed by the
 * `rolebox-monitor` tab type).
 *
 * Verifies the panel's contract at three levels:
 *
 *   1. WIRE — the panel reads the shape the backend actually composes
 *      (`loops: { count, states }`, `sessions: { count, mostRecentId,
 *      activeRoles }`) and still tolerates the two legacy shapes. The
 *      previous revision read `loops` as a bare array and
 *      `sessions.recentIds`, so against the real server the Loops section
 *      never mounted and the roster degraded to a count; both regressions are
 *      pinned here.
 *   2. READINGS — every developer-facing field the wire carries is rendered:
 *      per-node ledgers with agent/status/duration/retries, the node strip,
 *      frontier and budget, loop rounds/mode/elapsed/worker session and the
 *      loop's own error reason, session ids with their active roles, and the
 *      metric labels plus histogram avg/p50/p95/n.
 *   3. POSTURE — verdict before evidence, labelled facts instead of
 *      dot-joined metadata, no polling, live-region status seat, and a
 *      stylesheet that is namespaced, `--dsw-*`-only, single-column and free
 *      of decorative stripes.
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
    // Like React, a falsy entry of a children array contributes nothing.
    return children
      .flat(Infinity)
      .filter(
        (entry) => entry !== null && entry !== undefined && typeof entry !== "boolean",
      ) as Array<VNode | string | number>;
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

/** Class query scoped to one subtree (facts repeat across sections). */
function within(scope: VNode, cls: string): VNode[] {
  const out: VNode[] = [];
  walk(scope, (node) => {
    const className = node.props.className;
    if (typeof className === "string" && className.split(" ").includes(cls)) out.push(node);
  });
  return out;
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

// ── EventSource double ─────────────────────────────────────────────────────

/**
 * Controllable `EventSource` double.
 *
 * The runtime DOES define a global `EventSource` (Bun ships one), so a test
 * that leaves it alone would open a real connection; installing this double is
 * what makes the change channel observable and deterministic.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  /** The host accepted the connection. */
  open(): void {
    this.onopen?.();
  }
  /** The channel dropped (the browser retries on its own). */
  drop(): void {
    this.onerror?.();
  }
  /** One frame from the host. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Install the double (the panel's own `typeof EventSource` guard is the fallback path). */
function installEventSource(): void {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  FakeEventSource.reset();
}

/** Remove the global entirely, to exercise the no-channel fallback. */
function removeEventSource(): void {
  delete (globalThis as { EventSource?: unknown }).EventSource;
  FakeEventSource.reset();
}

/** The one channel the panel opened. */
function eventSource(): FakeEventSource {
  return FakeEventSource.instances[0]!;
}

/** The live badge's text (mode word + snapshot time). */
function liveBadge(): string {
  return textOf(byClass("rolebox-monitor-live")[0]!);
}

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
/** Request inits, in call order (the bounded-signal posture is observable here). */
const inits: Array<RequestInit | undefined> = [];
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
  inits.push(init);
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

/** Fixture epoch — ages are relative to it so durations are deterministic. */
const T0 = Date.now();

/** ISO timestamp at an offset (ms) from the fixture epoch. */
function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

const CURRENT_SESSION = "session-8e7a9623-1f59-4f02-b929-5ef95615a6aa";
const RECENT_SESSION = "session-0d81665c-2480-4735-a8be-d8b6cf3e9d7b";
const OTHER_SESSION = "session-573befaf-5b1a-43b3-9d72-4b062db5792a";

/** The loop summary array (`loops.states` on the wire). */
const LOOPS = [
  {
    originSessionId: "session-11111111-1111-1111-1111-111111111111",
    agent: "engineer",
    phase: "awaiting_worker",
    current: 2,
    total: 5,
    mode: "inherit",
    roundCount: 2,
    startedAt: T0 - 300_000,
    updatedAt: T0 - 4_000,
    roundStartedAt: T0 - 42_000,
    activeWorkerSessionId: "session-22222222-2222-2222-2222-222222222222",
  },
];

/** One live engine graph with a full node ledger. */
const GRAPH = {
  graphId: "graph-1",
  phase: "executing",
  nodeCount: 5,
  nodeStatusCounts: { completed: 3, running: 1, pending: 1 },
  nodes: [
    {
      nodeId: "plan",
      agent: "architect",
      status: "completed",
      startedAt: iso(-120_000),
      completedAt: iso(-60_000),
    },
    {
      nodeId: "build-api",
      agent: "engineer",
      status: "running",
      startedAt: iso(-42_000),
      retryCount: 1,
      dispatchSessionId: "session-22222222-2222-2222-2222-222222222222",
    },
    // Declared third, queued: the ledger must sort it above finished work.
    { nodeId: "verify", agent: "reviewer", status: "pending" },
    {
      nodeId: "docs",
      agent: "writer",
      status: "completed",
      startedAt: iso(-60_000),
      completedAt: iso(-30_000),
    },
    {
      nodeId: "changelog",
      agent: "writer",
      status: "completed",
      startedAt: iso(-30_000),
      completedAt: iso(-10_000),
    },
  ],
  budget: {
    sessionsSpawned: 1,
    totalInputTokens: 1200,
    totalOutputTokens: 800,
    totalCost: 0.012,
  },
  frontier: ["verify"],
  loopGroups: [{ id: "lg-1", traversalCount: 2, maxTraversals: 5 }],
  startedAt: iso(-600_000),
  updatedAt: iso(-2_000),
  updatedAtMs: T0 - 2_000,
};

/** The composed `GET /rolebox/status` body, in its REAL wire shape. */
const STATUS_BODY = {
  ok: true,
  timestamp: iso(0),
  loops: { count: LOOPS.length, states: LOOPS },
  engineGraphs: [GRAPH],
  sessions: {
    count: 3,
    mostRecentId: RECENT_SESSION,
    activeRoles: {
      [RECENT_SESSION]: "jetpack-compose",
      [OTHER_SESSION]: "jetpack-compose",
      [CURRENT_SESSION]: "ai-designer",
    },
  },
};

const METRICS_BODY = {
  counters: {
    "dispatch_rejected_total{agent=engineer}": { value: 7 },
  },
  gauges: {
    inflight_tasks: { value: 4 },
    concurrency_queued: { value: 0 },
  },
  histograms: {
    // Buckets are CUMULATIVE on the wire (Prometheus `le` style), so the last
    // one holds the whole population.
    request_duration_ms: { count: 5, sum: 420, buckets: { "50": 1, "100": 3, "250": 5 } },
  },
};

/** Mount the panel (optionally with the framework's session-scope props). */
function mountPanel(props: Record<string, unknown> = {}): void {
  calls.length = 0;
  inits.length = 0;
  pendingGates.length = 0;
  mount(panel.RoleboxMonitorPanel as unknown as (props: unknown) => unknown, props);
}

/** Flush the microtask chain (fetch → json → setState) before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function root(): VNode {
  return byClass("rolebox-monitor")[0]!;
}

function panelBody(): VNode {
  return byClass("rolebox-monitor-body")[0]!;
}

function bodyText(): string {
  return textOf(panelBody());
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
 * The value of a labelled fact row inside `scope`.
 *
 * The row is `icon | dt label | dd value`, and the label is visually hidden
 * whenever the glyph stands in for it — so the label is read from the `dt`
 * and the value from the `dd`, never from position.
 */
function factValue(scope: VNode, label: string): string {
  const row = within(scope, "rolebox-monitor-fact").find((node) => {
    const label_node = within(node, "rolebox-monitor-sr")[0] ??
      within(node, "rolebox-monitor-fact-word")[0];
    return label_node !== undefined && textOf(label_node) === label;
  });
  expect(row).toBeDefined();
  const value = within(row!, "rolebox-monitor-fact-value")[0];
  return value === undefined ? "" : textOf(value);
}

/** The node ids of the rendered node ledger, in render order. */
function nodeIds(scope: VNode): string[] {
  return within(scope, "rolebox-monitor-node-id").map((node) => textOf(node));
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleboxMonitorPanel", () => {
  beforeEach(() => {
    cfg = {
      status: STATUS_BODY,
      metrics: METRICS_BODY,
      statusOk: true,
      metricsOk: true,
      gate: false,
    };
    installEventSource();
  });

  describe("API contract", () => {
    it("declares the same-origin monitoring endpoints and no reload endpoint", () => {
      expect(panel.STATUS_ENDPOINT).toBe("/rolebox/status");
      expect(panel.METRICS_ENDPOINT).toBe("/rolebox/metrics");
      expect(panel.STATUS_ENDPOINT.startsWith("/")).toBe(true);
      expect("RELOAD_ENDPOINT" in panel).toBe(false);
    });

    it("fetches both endpoints in parallel on mount", async () => {
      mountPanel();
      await settle();

      expect(calls).toEqual(["GET /rolebox/status", "GET /rolebox/metrics"]);
      expect(root().props["aria-busy"]).toBe(false);
    });
  });

  describe("wire contract", () => {
    it("reads the loops seat in its real { count, states } shape", async () => {
      mountPanel();
      await settle();

      // The regression this pins: reading `loops` as a bare array filtered
      // every entry out of the real payload, so no loop ever rendered.
      expect(bodyText()).toContain("Loops");
      const loop = byClass("rolebox-monitor-loop")[0]!;
      expect(textOf(loop)).toContain("11111111");
      expect(textOf(loop)).toContain("engineer");
      expect(textOf(loop)).toContain("awaiting_worker");
    });

    it("still accepts a bare-array and a keyed-map loops seat", async () => {
      cfg.status = { ...STATUS_BODY, loops: LOOPS };
      mountPanel();
      await settle();
      expect(byClass("rolebox-monitor-loop")).toHaveLength(1);

      cfg.status = {
        ...STATUS_BODY,
        loops: { "session-11111111-1111-1111-1111-111111111111": LOOPS[0] },
      };
      mountPanel();
      await settle();
      expect(byClass("rolebox-monitor-loop")).toHaveLength(1);
    });

    it("reads the sessions census in its real shape and leads with this session", async () => {
      mountPanel({ sessionId: CURRENT_SESSION });
      await settle();

      const rows = byClass("rolebox-monitor-session-row");
      expect(rows).toHaveLength(3);
      // Where am I? The docked session leads and says so.
      expect(textOf(rows[0]!)).toContain("8e7a9623");
      expect(textOf(rows[0]!)).toContain("ai-designer");
      expect(textOf(rows[0]!)).toContain("this session");
      // The store's latest session follows, then the rest by id.
      expect(textOf(rows[1]!)).toContain("0d81665c");
      expect(textOf(rows[1]!)).toContain("latest");
      expect(textOf(rows[2]!)).toContain("573befaf");
      // The declared census is rendered as the section count.
      expect(textOf(byClass("rolebox-monitor-section-count")[0]!)).toBe("3");
      expect(textOf(byClass("rolebox-monitor-section-note")[0]!)).toContain("2 active roles");
    });

    it("tolerates an array sessions seat and a missing sessionId prop", async () => {
      cfg.status = { ...STATUS_BODY, sessions: [{ id: RECENT_SESSION }, { id: OTHER_SESSION }] };
      mountPanel();
      await settle();

      const rows = byClass("rolebox-monitor-session-row");
      expect(rows).toHaveLength(2);
      expect(textOf(rows[0]!)).not.toContain("this session");
      expect(bodyText()).toContain("0d81665c");
    });
  });

  describe("readings", () => {
    it("renders engine-graph identity, node counts, frontier and budget", async () => {
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      const text = textOf(graph);
      expect(text).toContain("graph-1");
      // The raw backend phase is never replaced by the normalised word.
      expect(text).toContain("executing");
      // The ledger heading carries the total; the fact row carries the strip's
      // legend and the run's readings, with no label repeated between them.
      expect(textOf(within(graph, "rolebox-monitor-sub-count")[0]!)).toBe("5");
      expect(factValue(graph, "completed")).toBe("3");
      expect(factValue(graph, "running")).toBe("1");
      expect(factValue(graph, "pending")).toBe("1");
      expect(factValue(graph, "frontier")).toBe("1");
      expect(factValue(graph, "sessions")).toBe("1");
      expect(factValue(graph, "tokens in")).toBe("1.2k");
      expect(factValue(graph, "tokens out")).toBe("800");
      expect(factValue(graph, "cost")).toBe("$0.012");
      // Loop groups keep their traversal readings.
      expect(text).toContain("lg-1 2/5");
    });

    it("draws exactly one strip cell per node", async () => {
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      const cells = within(graph, "rolebox-monitor-strip-cell");
      expect(cells).toHaveLength(GRAPH.nodes.length);
      // The strip is a redundant, position-preserving overview: one running
      // cell, three done, one queued.
      expect(within(graph, "rolebox-monitor-strip-running")).toHaveLength(1);
      expect(within(graph, "rolebox-monitor-strip-complete")).toHaveLength(3);
      expect(within(graph, "rolebox-monitor-strip-pending")).toHaveLength(1);
      // Decorative: the states are restated in words beside it.
      expect(within(graph, "rolebox-monitor-strip")[0]!.props["aria-hidden"]).toBe("true");
    });

    it("leads the node ledger with live work and caps the rest", async () => {
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      // running, then queued, then finished work in declaration order.
      expect(nodeIds(graph)).toEqual(["build-api", "verify", "plan", "docs"]);

      const node = within(graph, "rolebox-monitor-node-row")[0]!;
      expect(textOf(node)).toContain("engineer");
      // The state is a SHAPE on the row and the word in its title: the row no
      // longer spells out what the glyph already says.
      expect(node.props.title).toContain("running");
      expect(within(node, "rolebox-monitor-tone-running")).toHaveLength(1);
      expect(factValue(node, "retries")).toBe("1");
      expect(textOf(node)).toContain("42s");

      // Five nodes against a four-row cap: the rest stays one click away.
      const toggle = within(graph, "rolebox-monitor-more")[0]!;
      expect(textOf(toggle)).toBe("Show all 5 nodes");
      expect(textOf(graph)).not.toContain("changelog");
      click(toggle);
      expect(nodeIds(byClass("rolebox-monitor-graph")[0]!)).toEqual([
        "build-api",
        "verify",
        "plan",
        "docs",
        "changelog",
      ]);
    });

    it("renders a node's recorded failure reason beside its state", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [
          {
            ...GRAPH,
            nodes: GRAPH.nodes.map((n) =>
              n.nodeId === "build-api"
                ? { ...n, errorReason: "task vanished during restart" }
                : n,
            ),
          },
        ],
      };
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      const node = within(graph, "rolebox-monitor-node-row")[0]!;
      // E6: the reason is a labelled fact on the failing row, not just a status.
      expect(factValue(node, "error")).toBe("task vanished during restart");
    });

    it("renders loop rounds, mode, timing and the worker session", async () => {
      mountPanel();
      await settle();

      const loop = byClass("rolebox-monitor-loop")[0]!;
      expect(factValue(loop, "round")).toBe("2/5");
      expect(factValue(loop, "agent")).toBe("engineer");
      expect(factValue(loop, "mode")).toBe("inherit");
      expect(factValue(loop, "dispatched")).toBe("2");
      expect(factValue(loop, "elapsed")).toBe("5m");
      expect(factValue(loop, "round time")).toBe("42s");
      expect(factValue(loop, "worker")).toBe("22222222…");
      expect(textOf(loop)).toContain("awaiting_worker");
    });

    it("renders the loop's own failure reason instead of only its phase", async () => {
      cfg.status = {
        ...STATUS_BODY,
        loops: {
          count: 1,
          states: [{ ...LOOPS[0], phase: "error", errorReason: "round 2 dispatch failed" }],
        },
      };
      mountPanel();
      await settle();

      const error = byClass("rolebox-monitor-error")[0]!;
      expect(textOf(error)).toContain("round 2 dispatch failed");
      expect(textOf(byClass("rolebox-monitor-chip-failed")[0]!)).toBe("Failed");
    });

    it("parses metric labels and derives histogram percentiles", async () => {
      mountPanel();
      await settle();

      const metrics = byClass("rolebox-monitor-section")[3]!;
      const text = textOf(metrics);
      expect(text).toContain("dispatch_rejected_total");
      expect(text).toContain("agent=engineer");
      expect(text).toContain("inflight_tasks");
      expect(text).toContain("request_duration_ms");
      // avg = round(420/5) = 84ms, p50 = the 100ms bucket, p95 = the 250ms
      // bucket — each rendered as its own glyph cell.
      expect(text).toContain("84ms");
      const histogram = byClass("rolebox-monitor-metric-row")[3]!;
      expect(factValue(histogram, "p50")).toBe("100ms");
      expect(factValue(histogram, "p95")).toBe("250ms");
      expect(factValue(histogram, "samples")).toBe("5");
      // The distribution is drawn, not just summarised: one bar per bucket.
      expect(within(histogram, "rolebox-monitor-chart-bar")).toHaveLength(3);
    });

    it("explains an empty metrics snapshot instead of hiding the section", async () => {
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      expect(bodyText()).toContain("Metrics");
      expect(bodyText()).toContain("ROLEBOX_METRICS");
      expect(textOf(byClass("rolebox-monitor-section-count")[3]!)).toBe("0");
    });
  });

  describe("change channel", () => {
    it("opens the channel, reports itself live, and refetches once per burst", async () => {
      // The refetch delay is captured rather than waited out: the test drives
      // the coalescing window directly.
      const pending: Array<() => void> = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => {
        pending.push(fn);
        return realSetTimeout(() => {}, 0);
      }) as typeof globalThis.setTimeout;

      try {
        mountPanel();
        await settle();

        const source = eventSource();
        expect(source.url).toBe(panel.EVENTS_ENDPOINT);
        source.open();
        expect(liveBadge()).toContain("live");
        expect(calls).toHaveLength(2);

        // A burst of node completions is ONE wake-up, not one per frame.
        source.emit({ type: "changed", reason: "file", at: Date.now() });
        source.emit({ type: "changed", reason: "graph", at: Date.now() });
        source.emit({ type: "changed", reason: "loop", at: Date.now() });
        expect(pending).toHaveLength(1);
        expect(calls).toHaveLength(2);

        cfg.status = { ...STATUS_BODY, engineGraphs: [{ ...GRAPH, graphId: "graph-2" }] };
        pending[0]!();
        await settle();
        expect(calls).toHaveLength(4);
        expect(bodyText()).toContain("graph-2");
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });

    it("ignores frames it does not understand", async () => {
      mountPanel();
      await settle();

      const source = eventSource();
      source.open();
      source.emit({ type: "something-else" });
      source.emit("not json at all");
      source.emit({ no: "type" });
      await settle();

      expect(calls).toHaveLength(2);
    });

    it("falls back to manual refresh when the platform has no channel", async () => {
      removeEventSource();
      mountPanel();
      await settle();

      // The console still loads and still works; it just says how it updates.
      expect(bodyText()).toContain("Sessions");
      expect(liveBadge()).toContain("manual refresh");
      expect(FakeEventSource.instances).toHaveLength(0);
    });

    it("says manual again if the channel drops", async () => {
      mountPanel();
      await settle();

      const source = eventSource();
      source.open();
      expect(liveBadge()).toContain("live");

      source.drop();
      expect(liveBadge()).toContain("manual refresh");
    });
  });

  describe("live clock", () => {
    it("measures ages against the clock, not the last fetch", async () => {
      const ticks: Array<() => void> = [];
      const realSetInterval = globalThis.setInterval;
      const realNow = Date.now;
      globalThis.setInterval = ((fn: () => void) => {
        ticks.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as typeof globalThis.setInterval;

      try {
        mountPanel();
        await settle();

        const age = (): string => factValue(byClass("rolebox-monitor-graph")[0]!, "updated");
        expect(age()).toBe("2s ago");

        // A minute passes with no request of any kind, and the age follows the
        // clock: this is what "live" means once updates arrive on their own.
        Date.now = () => realNow() + 60_000;
        ticks[0]!();
        expect(age()).toBe("1m ago");
        expect(calls).toHaveLength(2);
      } finally {
        globalThis.setInterval = realSetInterval;
        Date.now = realNow;
      }
    });
  });

  describe("manual refresh", () => {
    it("bounds every request so a hung seat cannot strand the panel", async () => {
      mountPanel();
      await settle();

      // A bare fetch has no deadline: a request that never answers would leave
      // the skeleton with the panel's only control disabled, which is a
      // recovery path of zero width.
      expect(panel.FETCH_TIMEOUT_MS).toBeGreaterThan(0);
      expect(inits).toHaveLength(2);
      expect(inits.every((init) => init?.signal instanceof AbortSignal)).toBe(true);
    });

    it("re-fetches both endpoints, busy-gates the control, and updates the readings", async () => {
      mountPanel();
      await settle();
      expect(calls).toHaveLength(2);

      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ ...GRAPH, graphId: "graph-2", phase: "complete" }],
      };
      cfg.gate = true;
      click(refreshButton());

      expect(root().props["aria-busy"]).toBe(true);
      expect(refreshButton().props.disabled).toBe(true);

      releaseGate();
      await settle();
      expect(calls).toHaveLength(4);
      expect(refreshButton().props.disabled).toBe(false);
      expect(bodyText()).toContain("graph-2");
      // The seat announces the VERDICT; the freshness stamp rides the live
      // badge, outside the live region.
      expect(textOf(statusSeat())).toContain("run active");
      expect(liveBadge()).toContain(":");
      expect(statusSeat().props.title).toContain("run active");
    });
  });

  describe("read-only tab body", () => {
    it("renders no role-reload control (it lives on the Rolebox settings page)", async () => {
      mountPanel();
      await settle();

      expect(byClass("rolebox-monitor-reload")).toHaveLength(0);
      expect("RELOAD_ENDPOINT" in panel).toBe(false);
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    });

    it("names the surface with its own heading (the tab chip carries the name too)", async () => {
      mountPanel();
      await settle();

      const heading = byClass("rolebox-monitor-title")[0]!;
      expect(heading.type).toBe("h2");
      expect(textOf(heading)).toBe("Rolebox");
      // Every reading section keeps a name in the accessibility tree.
      const sectionHeadings = byClass("rolebox-monitor-section-title");
      expect(sectionHeadings.length).toBeGreaterThan(0);
      expect(sectionHeadings.every((node) => node.type === "h3")).toBe(true);
    });

    it("never polls: the only timer is the local clock", async () => {
      const scheduled: string[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const realSetInterval = globalThis.setInterval;
      globalThis.setTimeout = ((...args: unknown[]) => {
        scheduled.push("timeout");
        return realSetTimeout(...(args as Parameters<typeof realSetTimeout>));
      }) as typeof globalThis.setTimeout;
      globalThis.setInterval = ((...args: unknown[]) => {
        scheduled.push("interval");
        return realSetInterval(...(args as Parameters<typeof realSetInterval>));
      }) as typeof globalThis.setInterval;

      try {
        mountPanel();
        await settle();
        // Exactly one interval — the clock — and no timeout at all. Nothing
        // here asks the server for anything on a schedule.
        expect(scheduled).toEqual(["interval"]);
        expect(calls).toHaveLength(2);

        // Time passing changes nothing on the wire.
        await settle();
        expect(calls).toHaveLength(2);

        // Only a click (or a change signal) asks for more.
        click(refreshButton());
        await settle();
        expect(calls).toHaveLength(4);
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
      }
    });
  });

  describe("loading / error / empty states", () => {
    it("shows the loading state with aria-busy while the initial fetch is in flight", async () => {
      cfg.gate = true;
      mountPanel();

      expect(root().props["aria-busy"]).toBe(true);
      expect(refreshButton().props.disabled).toBe(true);
      // Announced exactly once: the header seat is the panel's single live
      // region, and the skeleton beside it is decorative.
      const live = allNodes().filter((node) => node.props.role === "status");
      expect(live).toHaveLength(1);
      expect(live[0]).toBe(statusSeat());
      expect(textOf(live[0]!)).toBe("Loading monitoring data…");
      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(1);

      releaseGate();
      await settle();
      expect(root().props["aria-busy"]).toBe(false);
      expect(byClass("rolebox-monitor-body")).toHaveLength(1);
    });

    it("shows an alert error state with a Retry control when a fetch fails", async () => {
      // Both seats down, with the docked session id supplied: the roster always
      // carries that session, so a panel that treats the roster as "data" would
      // never reach this state — or its Retry control — for any real session.
      cfg.statusOk = false;
      cfg.metricsOk = false;
      mountPanel({ sessionId: CURRENT_SESSION });
      await settle();

      const state = stateSeat();
      expect(state.props.role).toBe("alert");
      expect(textOf(state)).toContain("Failed to load monitoring data");
      expect(byClass("rolebox-monitor-retry")).toHaveLength(1);
      expect(byClass("rolebox-monitor-body")).toHaveLength(0);

      cfg.statusOk = true;
      click(byClass("rolebox-monitor-retry")[0]!);
      await settle();
      expect(byClass("rolebox-monitor-retry")).toHaveLength(0);
      expect(bodyText()).toContain("graph-1");
    });

    it("keeps previously rendered data visible when a refresh fails", async () => {
      mountPanel();
      await settle();
      expect(bodyText()).toContain("graph-1");

      cfg.statusOk = false;
      click(refreshButton());
      await settle();

      // The snapshot stays, the message is stated in the body, and the way back
      // is a control rather than a sentence.
      expect(bodyText()).toContain("graph-1");
      expect(textOf(statusSeat())).toBe("Load failed");
      expect(textOf(byClass("rolebox-monitor-error")[0]!)).toContain(
        "Failed to load monitoring data",
      );
      expect(byClass("rolebox-monitor-retry")).toHaveLength(1);
      expect(byClass("rolebox-monitor-state-error")).toHaveLength(0);
    });

    it("keeps the console alive when only the metrics seat fails", async () => {
      // The metrics endpoint is env-gated and optional; it must not be able to
      // take the page down with it.
      cfg.metricsOk = false;
      mountPanel({ sessionId: CURRENT_SESSION });
      await settle();

      expect(bodyText()).toContain("graph-1");
      expect(bodyText()).toContain("Loops");
      expect(bodyText()).toContain("Metrics could not be loaded");
      // The status seat reports the partial read without claiming the page died.
      expect(textOf(statusSeat())).toContain("metrics unavailable");
      expect(byClass("rolebox-monitor-state-error")).toHaveLength(0);
    });

    it("reports a malformed 200 body as a failed read, not as empty data", async () => {
      cfg.status = "not-an-object";
      mountPanel();
      await settle();

      // The message is carried by whichever failure surface is in force (the
      // alert state, or the retry row when the metrics seat still answered).
      const surfaces = [
        ...byClass("rolebox-monitor-state-error"),
        ...byClass("rolebox-monitor-error"),
      ];
      expect(surfaces).toHaveLength(1);
      expect(textOf(surfaces[0]!)).toContain("unexpected response body");
      expect(byClass("rolebox-monitor-retry")).toHaveLength(1);
    });

    it("says what would appear here when nothing is reporting", async () => {
      cfg.status = { ok: true, loops: { count: 0, states: [] }, engineGraphs: [], sessions: { count: 0, mostRecentId: null, activeRoles: {} } };
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };
      mountPanel({ sessionId: CURRENT_SESSION });
      await settle();

      // Not a bare "no data": the band states the verdict and the body states
      // what the surface is for.
      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(textOf(band)).toContain("Nothing running");
      expect(bodyText()).toContain("No graphs, loops or sessions are reporting");
      expect(byClass("rolebox-monitor-graph")).toHaveLength(0);
      expect(byClass("rolebox-monitor-loop")).toHaveLength(0);
    });
  });

  describe("defensive rendering", () => {
    it("treats a 1970 timestamp as a missing reading, not as a very old one", async () => {
      // The monitor reader substitutes new Date(0).toISOString() for a missing
      // updatedAt, so an epoch timestamp must not render as "20,717 days ago".
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [
          { ...GRAPH, updatedAt: new Date(0).toISOString(), updatedAtMs: 0, startedAt: undefined },
        ],
      };
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      const labels = within(graph, "rolebox-monitor-fact").map((node) =>
        textOf(childNodes(node)[0]!),
      );
      expect(labels).not.toContain("updated");
      expect(textOf(graph)).not.toContain("days ago");
    });

    it("renders a graph snapshot that carries no node ledger", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ graphId: "graph-sparse", phase: "executing", nodeCount: 3 }],
      };
      mountPanel();
      await settle();

      const graph = byClass("rolebox-monitor-graph")[0]!;
      expect(textOf(within(graph, "rolebox-monitor-sub-count")[0]!)).toBe("3");
      expect(within(graph, "rolebox-monitor-strip-cell")).toHaveLength(0);
      expect(within(graph, "rolebox-monitor-node-row")).toHaveLength(0);
      // The snapshot reports three nodes but carries no per-node records: the
      // ledger says so instead of looking complete.
      expect(textOf(graph)).toContain("3 more nodes not reported");
    });

    it("renders an unreadable graph phase as a neutral chip, never as failure", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ ...GRAPH, phase: "quantum_superposition" }],
      };
      mountPanel();
      await settle();

      expect(byClass("rolebox-monitor-chip-unknown")).toHaveLength(1);
      expect(byClass("rolebox-monitor-chip-failed")).toHaveLength(0);
      expect(bodyText()).toContain("quantum_superposition");
    });

    it("does not crash on a non-object JSON body", async () => {
      cfg.status = "not-an-object";
      cfg.metrics = 42;
      mountPanel({ sessionId: CURRENT_SESSION });
      await settle();

      // Neither seat can be read, so both report their own failure instead of
      // rendering as a confident "nothing is running".
      expect(textOf(statusSeat())).toBe("Load failed");
      expect(allNodes().length).toBeGreaterThan(0);
      expect(byClass("rolebox-monitor-retry")).toHaveLength(1);
    });
  });

  describe("accessibility posture", () => {
    it("exposes a live-region status seat and the panel marker", async () => {
      mountPanel();
      await settle();

      expect(root().props["data-rolebox-monitor"]).toBe(true);
      const seat = statusSeat();
      expect(seat.props.role).toBe("status");
      expect(textOf(seat)).toContain("runs active");
      // The freshness stamp sits OUTSIDE the live region, so a signal-driven
      // refresh does not re-announce a timestamp.
      expect(byClass("rolebox-monitor-live")).toHaveLength(1);
      expect(refreshButton().props.type).toBe("button");
    });

    it("hides the glyph and strip channels while keeping their words", async () => {
      mountPanel();
      await settle();

      expect(byClass("rolebox-monitor-strip")[0]!.props["aria-hidden"]).toBe("true");
      // The normalised state word is announced; it is never colour-only.
      expect(textOf(byClass("rolebox-monitor-chip-running")[0]!)).toBe("Running");
    });

    it("caps a ledger behind a disclosure that reports its own state", async () => {
      const counters: Record<string, { value: number }> = {};
      for (let i = 0; i < 10; i++) counters["c" + i] = { value: i };
      cfg.status = { ...STATUS_BODY, engineGraphs: [] };
      cfg.metrics = { counters, gauges: {}, histograms: {} };
      mountPanel();
      await settle();

      const toggle = byClass("rolebox-monitor-more")[0]!;
      expect(toggle.props["aria-expanded"]).toBe(false);
      expect(textOf(toggle)).toBe("Show all 10 readings");
      expect(toggle.props["aria-controls"]).toBe("rolebox-monitor-counters");
      expect(bodyText()).not.toContain("c9");

      click(toggle);
      const toggled = byClass("rolebox-monitor-more")[0]!;
      expect(toggled.props["aria-expanded"]).toBe(true);
      expect(textOf(toggled)).toBe("Show fewer");
      expect(bodyText()).toContain("c9");
    });

    it("renders a disclosure only for the ledger that exceeds its cap", async () => {
      mountPanel();
      await settle();

      // The five-node ledger is capped; the metric groups and the roster are not.
      const toggles = byClass("rolebox-monitor-more");
      expect(toggles).toHaveLength(1);
      expect(textOf(toggles[0]!)).toBe("Show all 5 nodes");
    });
  });

  describe("visual vocabulary", () => {
    it("gives every reading a glyph, so no lane is bare text", async () => {
      mountPanel();
      await settle();

      const rows = byClass("rolebox-monitor-fact");
      expect(rows.length).toBeGreaterThan(8);
      // The invariant behind the redesign: a reading is a SHAPE plus a value.
      // The word is either hidden in the dt (glyph-led) or rendered as a short
      // fact word beside the glyph.
      for (const row of rows) {
        const glyph = within(row, "rolebox-monitor-fact-icon");
        expect(glyph).toHaveLength(1);
        const label = within(row, "rolebox-monitor-sr").length +
          within(row, "rolebox-monitor-fact-word").length;
        expect(label).toBe(1);
      }
    });

    it("anchors every section and metric group with a glyph", async () => {
      mountPanel();
      await settle();

      for (const title of [
        ...byClass("rolebox-monitor-section-title"),
        ...byClass("rolebox-monitor-sub-title"),
      ]) {
        expect(within(title, "rolebox-monitor-section-icon")).toHaveLength(1);
      }
      expect(byClass("rolebox-monitor-section-title").length).toBeGreaterThanOrEqual(3);
      // Node ledger + the three metric groups.
      expect(byClass("rolebox-monitor-sub-title").length).toBe(4);
    });

    it("pairs every state chip with its own glyph and word", async () => {
      mountPanel();
      await settle();

      const chip = byClass("rolebox-monitor-chip-running")[0]!;
      const parts = childNodes(chip);
      // glyph + the state word: the two channels that survive a lost hue.
      expect(parts).toHaveLength(2);
      expect(textOf(parts[1]!)).toBe("Running");
      expect(textOf(byClass("rolebox-monitor-graph-id")[0]!)).toBe("graph-1");
    });

    it("draws a loop's round progress as one cell per round", async () => {
      mountPanel();
      await settle();

      const loop = byClass("rolebox-monitor-loop")[0]!;
      // 5 requested rounds, the run sitting in round 2 — so two cells carry it.
      expect(within(loop, "rolebox-monitor-progress-cell")).toHaveLength(5);
      expect(within(loop, "rolebox-monitor-progress-on")).toHaveLength(2);
      expect(textOf(within(loop, "rolebox-monitor-progress-text")[0]!)).toBe("2/5");
    });

    it("caps a long round list instead of stretching the row", async () => {
      cfg.status = {
        ...STATUS_BODY,
        loops: { count: 1, states: [{ ...LOOPS[0]!, current: 150, total: 200 }] },
      };
      mountPanel();
      await settle();

      const loop = byClass("rolebox-monitor-loop")[0]!;
      expect(within(loop, "rolebox-monitor-progress-cell")).toHaveLength(
        panel.ROUND_CELL_LIMIT,
      );
      // The bar reports the ratio; the exact reading is the text beside it.
      expect(textOf(within(loop, "rolebox-monitor-progress-text")[0]!)).toBe("150/200");
    });
  });

  describe("design posture", () => {
    it("keeps the tab body single-column and unable to overflow its pane", () => {
      const cssText = css.monitorCss;
      // Tighter horizontal padding than the settings page.
      const rootBlock = /\.rolebox-monitor\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(rootBlock).toContain("padding: 12px 8px");
      // The header's first track may shrink to nothing; the control never does.
      const headerBlock = /\.rolebox-monitor-header\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(headerBlock).toContain("minmax(0, 1fr)");
      // Every multi-item chrome row wraps instead of overflowing.
      for (const cls of [
        "rolebox-monitor-graph-head",
        "rolebox-monitor-node-head",
        "rolebox-monitor-loop-head",
        "rolebox-monitor-metric-row",
        "rolebox-monitor-facts",
      ]) {
        // Matched through the selector LIST that names the class, so a rule
        // shared by several classes is read as the single rule it is.
        const block =
          new RegExp("\\." + cls + "\\b[^{}]*\\{([^}]*)\\}", "s").exec(cssText)?.[1] ?? "";
        expect(block).toContain("flex-wrap: wrap");
      }
      // The panel fills its pane; nothing hard-codes a width that could
      // overflow the ~280px minimum content column.
      expect(cssText).toContain("width: 100%");
      const fixedWidths = [...cssText.matchAll(/[;{\s]width:\s*(\d+)px/g)].map((m) =>
        Number(m[1]),
      );
      expect(fixedWidths.length).toBeGreaterThan(0);
      expect(fixedWidths.every((width) => width <= 280)).toBe(true);
    });

    it("ships namespaced monitor rules with only --dsw-* tokens", () => {
      const cssText = css.monitorCss;
      // Every class the component names exists in the sheet.
      for (const cls of Object.values(css.monitorClass)) {
        expect(cssText).toContain("." + cls);
      }
      // The reload control left with the settings framing.
      expect(cssText).not.toContain("rolebox-monitor-reload");
      // Every var() reference is a dsw design token — no new --dsh-* leaks.
      const allVars = [...cssText.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!);
      expect(allVars.filter((token) => !token.startsWith("--dsw-"))).toEqual([]);

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
      const idleBlock = /\.rolebox-monitor-chip-idle\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(idleBlock).toContain("rolebox-surface-hover");
      const pendingBlock =
        /\.rolebox-monitor-chip-pending\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(pendingBlock).toContain("--rolebox-border-strong");

      // Both rolebox surfaces move on ONE curve — the host's (--ds-ease-in-out).
      expect(cssText.match(/--rolebox-ease[a-z-]*:/g)).toEqual(["--rolebox-ease:"]);

      // No decorative edge stripes: state and grouping are carried by a tint,
      // a full border and the state word, never by a coloured left edge.
      expect(cssText).not.toContain("border-left");
      expect(cssText).not.toContain("border-inline-start");
      expect(cssText).not.toContain("inset 0 0 0");
    });

    it("never glues readings into a dot-separated metadata line", async () => {
      mountPanel();
      await settle();

      // The banned formula: "AAA · BBB · CCC" as a heading or metadata run.
      // Labelled facts and prose are how this surface states readings.
      expect(bodyText()).not.toContain("·");
      expect(textOf(byClass("rolebox-monitor-attention")[0]!)).not.toContain("·");
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

    it("classifies node statuses that are not phases", () => {
      // A queued node is not executing, and an escalated node is not
      // unreadable: both need their own reading.
      expect(panel.classifyNodeStatus("pending")).toBe("pending");
      expect(panel.classifyNodeStatus("ready")).toBe("pending");
      expect(panel.classifyNodeStatus("escalate")).toBe("blocked");
      expect(panel.classifyNodeStatus("blocked")).toBe("blocked");
      // Everything else agrees with the phase vocabulary.
      expect(panel.classifyNodeStatus("running")).toBe("running");
      expect(panel.classifyNodeStatus("completed")).toBe("complete");
      expect(panel.classifyNodeStatus("done")).toBe("complete");
      expect(panel.classifyNodeStatus("error")).toBe("failed");
      expect(panel.classifyNodeStatus("timeout")).toBe("stopped");
      expect(panel.classifyNodeStatus(undefined)).toBe("unknown");
      // The chip word for a queued node is not "Unknown".
      expect(panel.RUN_STATE_LABEL.pending).toBe("Queued");
    });

    it("counts stopped and idle units instead of forgetting them", () => {
      // The regression the review found: a cancelled loop was counted NOWHERE,
      // so the band claimed "No graphs or loops are reporting" over a row it
      // was drawing itself.
      const stopped = panel.deriveAttention([], [{ ...LOOPS[0]!, phase: "cancelled" }]);
      expect(stopped.stopped).toBe(1);
      expect(stopped.units).toBe(1);
      expect(stopped.needsAttention).toBe(false);
      expect(panel.describeAttention(stopped)).toBe("1 stopped");

      const idle = panel.deriveAttention([{ ...GRAPH, phase: "idle" }], []);
      expect(idle.idle).toBe(1);
      expect(panel.describeAttention(idle)).toBe("1 idle");

      const empty = panel.deriveAttention([], []);
      expect(empty.units).toBe(0);
      expect(panel.describeAttention(empty)).toBe("No graphs or loops are reporting");

      // Mixed buckets read as a sentence, not as a dotted token list.
      const mixed = panel.deriveAttention([{ ...GRAPH, phase: "executing" }], [
        { ...LOOPS[0]!, phase: "cancelled" },
      ]);
      expect(panel.describeAttention(mixed)).toBe("1 run active, 1 stopped");
    });

    it("derives the attention verdict from the payload alone", () => {
      const healthy = panel.deriveAttention(STATUS_BODY.engineGraphs, LOOPS);
      expect(healthy.needsAttention).toBe(false);
      expect(healthy.running).toBe(2);
      expect(healthy.failed).toEqual([]);

      const broken = panel.deriveAttention(
        [{ ...GRAPH, phase: "failed" }],
        LOOPS,
      );
      expect(broken.needsAttention).toBe(true);
      expect(broken.failed).toEqual(["graph-1"]);
    });

    it("treats an escalated node as blocked until the graph completes", () => {
      const awaiting = panel.deriveAttention(
        [{ ...GRAPH, phase: "idle", nodeStatusCounts: { escalate: 1 } }],
        [],
      );
      expect(awaiting.needsAttention).toBe(true);
      expect(awaiting.blocked).toEqual(["graph-1"]);

      // A historical escalation on a finished graph must not alarm forever.
      const finished = panel.deriveAttention(
        [{ ...GRAPH, phase: "complete", nodeStatusCounts: { escalate: 1 } }],
        [],
      );
      expect(finished.needsAttention).toBe(false);
    });

    it("keeps a terminal graph's verdict despite its historical stopped nodes", () => {
      expect(
        panel.deriveAttention(
          [{ ...GRAPH, phase: "complete", nodeStatusCounts: { timeout: 1, done: 3 } }],
          [],
        ).needsAttention,
      ).toBe(false);
      expect(
        panel.deriveAttention(
          [{ ...GRAPH, phase: "complete", nodeStatusCounts: { cancelled: 1, done: 2 } }],
          [],
        ).needsAttention,
      ).toBe(false);
      // The carve-out: a HITL gate survives cancellation — the engine leaves
      // the blocked node for the human while forcing the phase to complete —
      // so it must still raise the verdict on a terminal graph.
      expect(
        panel.deriveAttention([{ ...GRAPH, phase: "complete", nodeStatusCounts: { blocked: 1 } }], []),
      ).toMatchObject({ needsAttention: true, blocked: ["graph-1"] });

      // On a LIVE graph the same node statuses do raise the verdict.
      expect(
        panel.deriveAttention(
          [{ ...GRAPH, phase: "executing", nodeStatusCounts: { timeout: 1, running: 1 } }],
          [],
        ).needsAttention,
      ).toBe(true);
    });

    it("surfaces a failed node on a graph whose own phase still reads running", () => {
      const verdict = panel.deriveAttention(
        [{ ...GRAPH, phase: "executing", nodeStatusCounts: { running: 1, failed: 2 } }],
        [],
      );
      expect(verdict.needsAttention).toBe(true);
      expect(verdict.failed).toEqual(["graph-1"]);
    });

    it("does not raise attention for a cancelled run", () => {
      const verdict = panel.deriveAttention([], [{ ...LOOPS[0]!, phase: "cancelled" }]);
      expect(verdict.needsAttention).toBe(false);
    });

    it("names unreadable phases instead of claiming all clear", () => {
      const murky = panel.deriveAttention([{ ...GRAPH, phase: "quantum_superposition" }], []);
      expect(murky.needsAttention).toBe(false);
      expect(murky.unknown).toEqual(["graph-1"]);
      // The band must NOT assert "All clear" over data it could not read.
      expect(panel.describeAttention(murky)).toContain("Unrecognized: graph-1");
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
      expect(childNodes(panelBody())[0]).toBe(band);
    });

    it("names a stopped or idle unit instead of claiming nothing is reporting", async () => {
      const emptySessions = { count: 0, mostRecentId: null, activeRoles: {} };
      cfg.metrics = { counters: {}, gauges: {}, histograms: {} };

      cfg.status = {
        ok: true,
        loops: { count: 1, states: [{ ...LOOPS[0]!, phase: "cancelled" }] },
        engineGraphs: [],
        sessions: emptySessions,
      };
      mountPanel();
      await settle();

      let band = byClass("rolebox-monitor-attention")[0]!;
      expect(textOf(band)).toContain("Nothing running");
      expect(textOf(band)).not.toContain("All clear");
      expect(factValue(band, "stopped")).toBe("1");
      // The band states facts, not a sentence that repeats them.
      expect(byClass("rolebox-monitor-attention-detail")).toHaveLength(0);
      // The unit the verdict is describing is drawn beneath it.
      expect(textOf(byClass("rolebox-monitor-loop")[0]!)).toContain("cancelled");
      expect(textOf(statusSeat())).toContain("1 stopped");

      // Same rule for a graph resting at the engine's own idle phase.
      cfg.status = {
        ok: true,
        loops: { count: 0, states: [] },
        engineGraphs: [{ ...GRAPH, phase: "idle" }],
        sessions: emptySessions,
      };
      mountPanel();
      await settle();

      band = byClass("rolebox-monitor-attention")[0]!;
      expect(textOf(band)).toContain("Nothing running");
      expect(textOf(band)).not.toContain("All clear");
      expect(factValue(band, "idle")).toBe("1");
      expect(textOf(byClass("rolebox-monitor-graph")[0]!)).toContain("idle");
    });

    it("states the counts behind the verdict as labelled facts", async () => {
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(factValue(band, "running")).toBe("2");
      // A zero count is not a reading — it is noise, and it is omitted.
      expect(within(band, "rolebox-monitor-fact")).toHaveLength(1);
      // Facts are per-label fields, not one dotted sentence.
      expect(textOf(band)).not.toContain("·");
    });

    it("raises an alert band and names what needs attention", async () => {
      cfg.status = { ...STATUS_BODY, engineGraphs: [{ ...GRAPH, phase: "failed" }] };
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(band.props.className).toContain("rolebox-monitor-attention-alert");
      expect(textOf(band)).toContain("Needs attention");
      expect(factValue(band, "failed")).toBe("1");
      // Naming the offender is the point: "1 need attention" alone is an alarm.
      const named = byClass("rolebox-monitor-attention-item");
      expect(named).toHaveLength(1);
      expect(textOf(named[0]!)).toContain("Failed");
      expect(textOf(named[0]!)).toContain("graph-1");
      // The offenders are listed row by row; the prose sentence lives on the
      // live region and the panel title instead of repeating them in the band.
      expect(byClass("rolebox-monitor-attention-detail")).toHaveLength(0);
      // …and the panel root carries NO title of its own: a title on the panel
      // makes every hover anywhere in it pop a tooltip over the readings.
      expect(root().props.title).toBeUndefined();
      expect(bandGlyph()).toBe("AlertGlyph");
      // The live-region seat announces the verdict too.
      expect(textOf(statusSeat())).toContain("1 needs attention");
    });

    it("carries an unreadable-phase admission into the band and the live region", async () => {
      cfg.status = {
        ...STATUS_BODY,
        engineGraphs: [{ ...GRAPH, phase: "quantum_superposition" }],
      };
      mountPanel();
      await settle();

      const band = byClass("rolebox-monitor-attention")[0]!;
      expect(textOf(band)).toContain("Partly unreadable");
      expect(band.props.className).toContain("rolebox-monitor-attention-calm");
      // A check mark must never sit over an admission: the neutral question
      // glyph is what this state renders.
      expect(bandGlyph()).toBe("QuestionGlyph");
      expect(textOf(statusSeat())).toContain("1 state unreadable");
    });
  });

  describe("state chips", () => {
    it("pairs every raw phase with a normalised state word", async () => {
      mountPanel();
      await settle();

      expect(bodyText()).toContain("executing");
      expect(bodyText()).toContain("awaiting_worker");
      // Both the graph and the loop are running.
      expect(byClass("rolebox-monitor-chip-running")).toHaveLength(2);
      expect(byClass("rolebox-monitor-chip-complete")).toHaveLength(0);
    });

    it("moves the chip to its terminal state after a refresh", async () => {
      mountPanel();
      await settle();

      cfg.status = { ...STATUS_BODY, engineGraphs: [{ ...GRAPH, phase: "complete" }] };
      click(refreshButton());
      await settle();

      expect(byClass("rolebox-monitor-chip-complete")).toHaveLength(1);
      expect(byClass("rolebox-monitor-chip-running")).toHaveLength(1);
      expect(bodyText()).toContain("complete");
    });
  });

  describe("section counts", () => {
    it("states how much each section holds", async () => {
      mountPanel();
      await settle();

      const counts = byClass("rolebox-monitor-section-count");
      expect(counts).toHaveLength(4);
      expect(textOf(counts[0]!)).toBe("3"); // sessions
      expect(textOf(counts[1]!)).toBe("1"); // engine graphs
      expect(textOf(counts[2]!)).toBe("1"); // loops
      expect(textOf(counts[3]!)).toBe("4"); // metrics (1 counter + 2 gauges + 1 histogram)
    });
  });

  describe("loading skeleton", () => {
    it("substitutes a content-shaped skeleton for the first load only", async () => {
      cfg.gate = true;
      mountPanel();

      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(1);
      expect(byClass("rolebox-monitor-spinner")).toHaveLength(1);
      // The skeleton mirrors the lanes it stands in for: two sections of
      // glyph-led rows.
      expect(byClass("rolebox-monitor-skeleton-card")).toHaveLength(2);
      expect(byClass("rolebox-monitor-skeleton-row")).toHaveLength(6);
      expect(byClass("rolebox-monitor-skeleton-icon")).toHaveLength(6);

      releaseGate();
      await settle();
      expect(byClass("rolebox-monitor-skeleton")).toHaveLength(0);
    });

    it("names a refresh as a refresh rather than a first load", async () => {
      mountPanel();
      await settle();
      expect(textOf(statusSeat())).toContain("runs active");

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
