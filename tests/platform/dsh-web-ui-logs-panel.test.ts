/// <reference types="bun-types" />

/**
 * RoleboxLogsPanel behavior tests — the browser-half rolebox LIVE LOG VIEW
 * (`src/platform/adapters/dsh/web-ui/rolebox-logs-panel.tsx`), a dsh
 * right-Sidebar page tab (`sidebar.right.pane.tab`, keyed by the `rolebox-logs`
 * tab type).
 *
 * Verifies the panel's contract at four levels:
 *
 *   1. WIRE — the panel polls `GET /rolebox/logs`, sends the window size on the
 *      first request, hands the returned cursor back on every later one, and
 *      tolerates a page whose records are partly unreadable.
 *   2. STREAM CONTROL — refreshing happens only while the document is visible
 *      and the pane is unpaused; a hidden tab tears the change channel AND the
 *      fallback interval down, Resume continues from the SAME cursor, a
 *      `changed` frame refreshes immediately whatever reason it carries, and a
 *      trigger that lands during an in-flight fetch is DEFERRED to that fetch's
 *      `finally` rather than dropped. The buffer is bounded with the dropped
 *      count reported.
 *   3. READINGS — time, level chip, channel, code, scope, fields and the
 *      message are all rendered, and the pane prints the SOURCE the server
 *      actually read rather than a guess.
 *   4. POSTURE — explicit empty/error states with a way back, a live-region
 *      status seat, and a stylesheet that is namespaced, `--dsw-*`-only,
 *      single-column and free of decorative stripes.
 *
 * ── Harness ────────────────────────────────────────────────────────────────
 * React is NOT a devDependency of this repo (the temporary `react.stub.d.ts`
 * covers the type surface), so `react` and the JSX runtime are mocked BEFORE
 * the panel module is imported, exactly as the sibling monitor-panel suite
 * does. The double is STATEFUL: a mini-React (hook slots per component
 * instance, synchronous re-render on `setState`, effect flush with dependency
 * comparison and cleanup) plus a virtual-DOM tree with query helpers. On top of
 * it this file installs four deterministic seams the monitor suite does not
 * need: a TIMER double (the panel's own `setInterval` is the thing under test),
 * a `document` double (visibility), a queue-driven `fetch` double (the polling
 * sequence, whose requests can be HELD open so an in-flight fetch is
 * observable), and an `EventSource` double (the change channel — Bun ships a
 * real global, so installing the double is what keeps a test from dialling).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

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

/** Class query scoped to one subtree. */
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

/** `useRef` — a per-slot mutable cell. */
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

const panel = await import("../../src/platform/adapters/dsh/web-ui/rolebox-logs-panel.tsx");
const css = await import("../../src/platform/adapters/dsh/web-ui/rolebox-logs-panel.css.ts");

// ── Timer double (the panel's own interval is under test) ──────────────────

const intervals = new Map<number, () => void>();
let nextTimerId = 1;

globalThis.setInterval = ((fn: () => void, _ms?: number) => {
  const id = nextTimerId++;
  intervals.set(id, fn);
  return id as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;

globalThis.clearInterval = ((id: number) => {
  intervals.delete(id);
}) as typeof clearInterval;

/** Run every live interval callback once (the tick the panel would get). */
async function tick(): Promise<void> {
  for (const fn of [...intervals.values()]) fn();
  await settle();
}

// ── Document double (visibility) ───────────────────────────────────────────

class FakeDocument {
  visibilityState = "visible";
  /** Every registered `visibilitychange` listener, in registration order. */
  readonly listeners = new Set<() => void>();

  addEventListener(type: string, callback: () => void): void {
    if (type === "visibilitychange") this.listeners.add(callback);
  }

  removeEventListener(type: string, callback: () => void): void {
    this.listeners.delete(callback);
  }

  hide(): void {
    this.visibilityState = "hidden";
    for (const callback of [...this.listeners]) callback();
  }

  show(): void {
    this.visibilityState = "visible";
    for (const callback of [...this.listeners]) callback();
  }
}

let fakeDocument: FakeDocument;

function installDocument(): FakeDocument {
  fakeDocument = new FakeDocument();
  (globalThis as { document?: unknown }).document = fakeDocument;
  return fakeDocument;
}

// ── EventSource double (the change channel) ────────────────────────────────

/**
 * Controllable `EventSource` double.
 *
 * The runtime DOES define a global `EventSource` (Bun ships one), so a test that
 * leaves it alone would dial a real connection; installing this double is what
 * makes the change channel observable and deterministic. The panel opens a
 * channel per mounted-and-live effect, so the suite reads the LAST instance
 * (`eventSource()`) and keeps them all for the teardown assertions.
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
  /** The channel dropped (the browser retries on its own). */
  drop(): void {
    this.onerror?.();
  }
  /** One frame from the host. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** One RAW frame body, exactly as the wire carried it (malformed included). */
  raw(data: string): void {
    this.onmessage?.({ data });
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

/** The channel the panel most recently opened. */
function eventSource(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

// ── fetch double (a queue of pages) ────────────────────────────────────────

interface PageSpec {
  status?: number;
  body?: unknown;
  /**
   * Keep the request in flight until {@link releaseHeld} runs, so a test can
   * place a trigger INSIDE an open fetch (the panel promises never two in
   * flight, and never a dropped wake-up).
   */
  hold?: boolean;
}

const FIXTURE_SOURCE = { kind: "dir", path: "/tmp/rolebox-fixture-logs" };
const calls: string[] = [];
const inits: Array<RequestInit | undefined> = [];
let queue: PageSpec[] = [];

/** An empty but valid page (the route's own shape). */
function emptyPage(cursor = "c-empty"): Record<string, unknown> {
  return {
    records: [],
    cursor,
    source: FIXTURE_SOURCE,
    truncated: false,
    skippedLines: 0,
  };
}

/** One record, in the route's wire shape. */
function rec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: T0,
    level: "info",
    channel: "graph:host",
    message: "Graph g1 advanced",
    fields: {},
    scope: {},
    process: { pid: 42, role: "host" },
    ...overrides,
  };
}

/** A page carrying the given records. */
function page(
  records: Array<Record<string, unknown>>,
  cursor: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...emptyPage(cursor), records, ...extra };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Resolvers of every held request, in the order the requests were made. */
const held: Array<() => void> = [];

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  inits.push(init);
  const next = queue.shift();
  if (next === undefined) return Promise.resolve(fakeResponse(200, emptyPage()));
  const response = fakeResponse(next.status ?? 200, next.body ?? emptyPage());
  if (next.hold === true) {
    return new Promise<Response>((resolve) => {
      held.push(() => resolve(response));
    });
  }
  return Promise.resolve(response);
}) as typeof fetch;

/** Settle every held request, then flush the chain its answer starts. */
async function releaseHeld(): Promise<void> {
  for (const release of held.splice(0)) release();
  await settle();
}

// ── Fixtures and helpers ───────────────────────────────────────────────────

/** Fixture epoch — record times are offsets from it, so clocks are deterministic. */
const T0 = 1_791_450_000_000;

const SESSION = "session-8e7a9623-1f59-4f02-b929-5ef95615a6aa";

/**
 * Re-render the mounted panel with new props, the way the framework does when
 * the seat hands the body a different session.
 */
function rerender(props: Record<string, unknown>): void {
  currentProps = props;
  renderNow();
}

/**
 * Mount the panel with a fresh document. The fetch queue is the TEST's (set it
 * before mounting); an exhausted queue answers a valid empty page.
 */
function mountPanel(props: Record<string, unknown> = {}): void {
  installDocument();
  mount(panel.RoleboxLogsPanel as unknown as (props: unknown) => unknown, props);
}

beforeEach(() => {
  calls.length = 0;
  inits.length = 0;
  intervals.clear();
  held.length = 0;
  queue = [];
  installEventSource();
});

/** Flush the microtask chain (fetch → json → setState) before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function rows(): VNode[] {
  return byClass("rolebox-logs-row");
}

function rowTexts(): string[] {
  return rows().map((row) => textOf(row));
}

function statusSeat(): VNode {
  return byClass("rolebox-logs-status")[0]!;
}

function sourceLine(): string {
  return textOf(byClass("rolebox-logs-source")[0]!);
}

function emptyText(): string {
  const node = byClass("rolebox-logs-empty")[0];
  return node === undefined ? "" : textOf(node);
}

function errorText(): string {
  const node = byClass("rolebox-logs-error")[0];
  return node === undefined ? "" : textOf(node);
}

function pauseButton(): VNode {
  return byClass("rolebox-logs-button").find((node) => textOf(node) === "Pause")!;
}

function resumeButton(): VNode {
  return byClass("rolebox-logs-button").find((node) => textOf(node) === "Resume")!;
}

function refreshButton(): VNode {
  return byClass("rolebox-logs-button").find((node) => textOf(node).includes("Refresh"))!;
}

function retryButton(): VNode {
  return byClass("rolebox-logs-retry")[0]!;
}

function channelSelect(): VNode {
  return byClass("rolebox-logs-select")[0]!;
}

/** Change the channel select's value the way a browser would. */
function selectChannel(value: string): void {
  const onChange = channelSelect().props.onChange;
  expect(typeof onChange).toBe("function");
  (onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function sessionButton(): VNode {
  return byClass("rolebox-logs-button").find((node) => textOf(node) === "This session")!;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleboxLogsPanel", () => {
  describe("the poll (wire contract)", () => {
    it("polls the route on mount with the window size and no cursor", async () => {
      queue = [];
      mountPanel();
      await settle();

      expect(calls).toEqual(["/rolebox/logs?limit=200"]);
      expect(typeof inits[0]?.signal).toBe("object");
      // The first answer was an empty page: the pane says so.
      expect(emptyText()).toContain("No records yet");
    });

    it("renders one row per record with time, level, channel and message", async () => {
      queue = [
        {
          body: page(
            [
              rec({ time: T0, level: "warn", channel: "graph:host", message: "Store blocked" }),
              rec({ time: T0 + 1_000, level: "error", channel: "dispatch", message: "Dispatch failed" }),
            ],
            "c1",
          ),
        },
      ];
      mountPanel();
      await settle();

      expect(rows()).toHaveLength(2);
      expect(rowTexts()[0]).toContain("Store blocked");
      expect(rowTexts()[0]).toContain("graph:host");
      expect(rowTexts()[0]).toContain(panel.clockTime(T0));
      expect(rowTexts()[1]).toContain("Dispatch failed");
    });

    it("hands the returned cursor back and appends without repeating", async () => {
      queue = [
        { body: page([rec({ time: T0, message: "first" })], "c1") },
        { body: page([rec({ time: T0 + 1_000, message: "second" })], "c2") },
      ];
      mountPanel();
      await settle();
      expect(calls).toEqual(["/rolebox/logs?limit=200"]);

      await tick();

      expect(calls).toEqual([
        "/rolebox/logs?limit=200",
        "/rolebox/logs?limit=200&cursor=c1",
      ]);
      expect(rowTexts().map((text) => (text.includes("first") ? "first" : "second"))).toEqual([
        "first",
        "second",
      ]);
    });

    it("reports the source the server read, not a guess", async () => {
      queue = [{ body: page([rec()], "c1", { source: { kind: "file", path: "/tmp/one.log" } }) }];
      mountPanel();
      await settle();

      expect(sourceLine()).toContain("file: /tmp/one.log");
    });

    it("reports the malformed-line count the server measured", async () => {
      queue = [{ body: page([rec()], "c1", { skippedLines: 7 }) }];
      mountPanel();
      await settle();

      expect(textOf(byClass("rolebox-logs-facts")[0]!)).toContain("7");
    });

    it("says when more records are waiting at the cursor", async () => {
      queue = [{ body: page([rec()], "c1", { truncated: true }) }];
      mountPanel();
      await settle();

      expect(textOf(byClass("rolebox-logs-more")[0]!)).toContain("More records are waiting");
    });

    it("normalises every level word, defaulting an unknown one to info", async () => {
      queue = [
        {
          body: page(
            [
              rec({ time: T0, level: "debug" }),
              rec({ time: T0 + 1, level: "info" }),
              rec({ time: T0 + 2, level: "warn" }),
              rec({ time: T0 + 3, level: "error" }),
              rec({ time: T0 + 4, level: "fatal" }),
              rec({ time: T0 + 5, level: "verbose" }),
            ],
            "c1",
          ),
        },
      ];
      mountPanel();
      await settle();

      const levels = byClass("rolebox-logs-level").map((node) => textOf(node));
      expect(levels).toEqual(["debug", "info", "warn", "error", "fatal", "info"]);
      expect(byClass("rolebox-logs-level-debug")).toHaveLength(1);
      expect(byClass("rolebox-logs-level-warn")).toHaveLength(1);
      expect(byClass("rolebox-logs-level-error")).toHaveLength(1);
      expect(byClass("rolebox-logs-level-fatal")).toHaveLength(1);
      // The unknown word landed on the info chip, not on a missing class.
      expect(byClass("rolebox-logs-level-info")).toHaveLength(2);
    });

    it("renders the code, scope and field metadata without dropping any of it", async () => {
      queue = [
        {
          body: page(
            [
              rec({
                code: "sweep.store-blocked",
                scope: { graphId: "g1", sessionId: SESSION, ignored: 7 },
                fields: { reason: "lock", count: 3, flags: ["a", "b"] },
              }),
            ],
            "c1",
          ),
        },
      ];
      mountPanel();
      await settle();

      const row = rowTexts()[0]!;
      expect(row).toContain("sweep.store-blocked");
      expect(row).toContain("graphId=g1");
      expect(row).toContain("sessionId=" + SESSION);
      expect(row).toContain("reason=lock");
      expect(row).toContain("count=3");
      expect(row).toContain("flags=a, b");
      // A non-string scope entry is not an id: it is dropped, not stringified.
      expect(row).not.toContain("ignored");
    });
  });

  describe("stream control (visibility, pause, buffer)", () => {
    it("polls while visible and stops when the document is hidden", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();
      expect(calls).toHaveLength(1);
      expect(intervals.size).toBe(1);

      fakeDocument.hide();
      await settle();

      expect(intervals.size).toBe(0);
      const afterHide = calls.length;
      await tick();
      expect(calls.length).toBe(afterHide);

      // Back to visible: a fresh interval AND an immediate poll.
      queue = [{ body: page([rec({ time: T0 + 1_000, message: "while away" })], "c2") }];
      fakeDocument.show();
      await settle();

      expect(intervals.size).toBe(1);
      expect(calls).toHaveLength(afterHide + 1);
      expect(calls[afterHide]).toBe("/rolebox/logs?limit=200&cursor=c1");
      expect(rowTexts().join(" ")).toContain("while away");
    });

    it("labels the tab's state as Polling, Hidden and Paused", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();
      const liveLabel = (): string => textOf(byClass("rolebox-logs-live-label")[0]!);
      expect(liveLabel()).toBe("Polling");

      fakeDocument.hide();
      await settle();
      expect(liveLabel()).toBe("Hidden");

      fakeDocument.show();
      await settle();
      click(pauseButton());
      await settle();
      expect(liveLabel()).toBe("Paused");
    });

    it("Pause stops the stream and Resume continues from the same cursor", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      click(pauseButton());
      await settle();
      expect(intervals.size).toBe(0);
      const paused = calls.length;
      await tick();
      expect(calls.length).toBe(paused);

      queue = [{ body: page([rec({ time: T0 + 1_000, message: "after resume" })], "c2") }];
      click(resumeButton());
      await settle();

      expect(intervals.size).toBe(1);
      expect(calls[calls.length - 1]).toBe("/rolebox/logs?limit=200&cursor=c1");
      expect(rowTexts().join(" ")).toContain("after resume");
    });

    it("caps the buffer and reports what the cap dropped", async () => {
      const many = Array.from({ length: panel.BUFFER_LIMIT + 50 }, (_entry, index) =>
        rec({ time: T0 + index, message: "record " + String(index) }),
      );
      queue = [{ body: page(many, "c1") }];
      mountPanel();
      await settle();

      expect(rows()).toHaveLength(panel.BUFFER_LIMIT);
      // The NEWEST records survived the cap.
      expect(rowTexts()[panel.BUFFER_LIMIT - 1]).toContain("record " + String(panel.BUFFER_LIMIT + 49));
      expect(textOf(byClass("rolebox-logs-facts")[0]!)).toContain("dropped by buffer cap");
      expect(textOf(byClass("rolebox-logs-facts")[0]!)).toContain("50");
    });

    it("polls once per interval tick and never overlaps a request", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      // Two ticks, one fetch each: the queue is empty afterwards, so every extra
      // request would show up as an empty page (and as another call).
      await tick();
      await tick();
      expect(calls).toEqual([
        "/rolebox/logs?limit=200",
        "/rolebox/logs?limit=200&cursor=c1",
        "/rolebox/logs?limit=200&cursor=c-empty",
      ]);
    });

    it("Refresh polls immediately instead of waiting for the tick", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      queue = [{ body: page([rec({ time: T0 + 1_000, message: "manual" })], "c2") }];
      click(refreshButton());
      await settle();

      expect(calls).toHaveLength(2);
      expect(rowTexts().join(" ")).toContain("manual");
    });
  });

  describe("change channel (event-driven refresh)", () => {
    it("refreshes on a `changed` frame long before the fallback interval", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();
      expect(calls).toHaveLength(1);

      // The channel is the PRIMARY trigger and the fallback is deliberately
      // slow: this test never ticks an interval, so every extra request below
      // is the frame's.
      expect(panel.POLL_MS).toBeGreaterThan(10_000);
      const source = eventSource();
      expect(source.url).toBe(panel.EVENTS_ENDPOINT);

      queue = [{ body: page([rec({ time: T0 + 1_000, message: "pushed" })], "c2") }];
      source.emit({ type: "changed", at: Date.now(), reason: "log" });
      await settle();

      expect(calls).toEqual(["/rolebox/logs?limit=200", "/rolebox/logs?limit=200&cursor=c1"]);
      expect(rowTexts().join(" ")).toContain("pushed");

      // ANY reason refreshes: the channel coalesces a burst and keeps only the
      // LAST reason, so a "log"-only filter would drop this wake-up.
      queue = [{ body: page([rec({ time: T0 + 2_000, message: "graph moved" })], "c3") }];
      source.emit({ type: "changed", at: Date.now(), reason: "graph" });
      await settle();

      expect(calls).toHaveLength(3);
      expect(calls[2]).toBe("/rolebox/logs?limit=200&cursor=c2");
      expect(rowTexts().join(" ")).toContain("graph moved");
    });

    it("ignores frames it does not understand, and survives a dropped channel", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      const source = eventSource();
      source.emit({ type: "hello", coalesceMs: 250 });
      source.emit({ type: "something-else" });
      source.emit("not an object");
      source.raw("{ this is not json");
      source.drop(); // A dropped channel reconnects itself; the interval stays in charge.
      await settle();

      expect(calls).toHaveLength(1);

      // The fallback still works after the drop — that is the whole point of
      // leaving the interval in charge.
      queue = [{ body: page([rec({ time: T0 + 1_000, message: "after drop" })], "c2") }];
      await tick();
      expect(calls).toHaveLength(2);
      expect(rowTexts().join(" ")).toContain("after drop");
    });

    it("defers a trigger that lands during an in-flight fetch, and never overlaps", async () => {
      queue = [{ body: page([rec({ time: T0, message: "first" })], "c1"), hold: true }];
      mountPanel();
      await settle();

      // The mount poll is OPEN: exactly one request is in flight.
      expect(calls).toHaveLength(1);

      const source = eventSource();
      // A burst of frames inside that window is ONE deferred poll — not a
      // second request, and not a lost wake-up.
      source.emit({ type: "changed", at: Date.now(), reason: "log" });
      source.emit({ type: "changed", at: Date.now(), reason: "file" });
      await settle();
      expect(calls).toHaveLength(1);

      queue = [{ body: page([rec({ time: T0 + 1_000, message: "second" })], "c2") }];
      await releaseHeld();

      // Exactly one more request, from the cursor the first answer returned.
      expect(calls).toEqual(["/rolebox/logs?limit=200", "/rolebox/logs?limit=200&cursor=c1"]);
      expect(rowTexts().join(" ")).toContain("second");
    });

    it("drains a wake-up recorded by the NEXT run of the effect (manual refresh)", async () => {
      queue = [{ body: page([rec({ time: T0, message: "first" })], "c1"), hold: true }];
      mountPanel();
      await settle();

      // The mount poll is OPEN, and the user presses Refresh: the refresh token
      // re-runs the effect, so the wake-up is recorded by a NEW run while the
      // request that must drain it belongs to the OLD one. Nothing may overlap,
      // and nothing may be lost — with the fallback interval this slow, a
      // dropped wake-up is 15 seconds of a stale pane.
      queue = [{ body: page([rec({ time: T0 + 1_000, message: "after refresh" })], "c2") }];
      click(refreshButton());
      await settle();
      expect(calls).toHaveLength(1);

      await releaseHeld();

      // The old request's answer was DISCARDED (a cancelled run writes no
      // state, cursor included), so the drained poll re-reads from the same
      // cursorless position — and it is exactly one more request.
      expect(calls).toEqual(["/rolebox/logs?limit=200", "/rolebox/logs?limit=200"]);
      expect(rowTexts().join(" ")).toContain("after refresh");
    });

    it("keeps an interval-only fallback where the platform has no EventSource", async () => {
      removeEventSource();
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      // No channel was opened, and the pane still reads immediately.
      expect(FakeEventSource.instances).toHaveLength(0);
      expect(calls).toHaveLength(1);

      queue = [{ body: page([rec({ time: T0 + 1_000, message: "ticked" })], "c2") }];
      await tick();

      expect(calls).toHaveLength(2);
      expect(rowTexts().join(" ")).toContain("ticked");
    });

    it("opens the channel only while visible and unpaused, and closes it on teardown", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      const first = eventSource();
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(first.url).toBe(panel.EVENTS_ENDPOINT);
      expect(first.closed).toBe(false);

      // Hidden: the channel goes down with the interval...
      fakeDocument.hide();
      await settle();
      expect(first.closed).toBe(true);
      expect(intervals.size).toBe(0);

      // ...and coming back opens a FRESH one (the effect re-runs).
      fakeDocument.show();
      await settle();
      expect(FakeEventSource.instances).toHaveLength(2);
      const second = eventSource();
      expect(second.closed).toBe(false);

      // Paused: gone too, and Resume opens a third.
      click(pauseButton());
      await settle();
      expect(second.closed).toBe(true);

      click(resumeButton());
      await settle();
      expect(FakeEventSource.instances).toHaveLength(3);
      expect(eventSource().closed).toBe(false);
    });
  });

  describe("filters", () => {
    it("offers the channels in the buffer and asks the server for the chosen one", async () => {
      queue = [
        {
          body: page(
            [
              rec({ time: T0, channel: "graph:host" }),
              rec({ time: T0 + 1, channel: "web-ui" }),
            ],
            "c1",
          ),
        },
      ];
      mountPanel();
      await settle();

      const options = childNodes(channelSelect()) as VNode[];
      expect(options.map((option) => option.props.value)).toEqual(["", "graph:host", "web-ui"]);

      queue = [{ body: page([rec({ time: T0 + 2, channel: "web-ui", message: "only web" })], "c2") }];
      selectChannel("web-ui");
      await settle();

      expect(calls[calls.length - 1]).toBe("/rolebox/logs?limit=200&channel=web-ui");
      // A new filter starts a new view: the old cursor is gone with the buffer.
      expect(rowTexts()).toHaveLength(1);
      expect(rowTexts()[0]).toContain("only web");
    });

    it("restarts the view when the filter changes — no stale cursor, no stale rows", async () => {
      queue = [
        { body: page([rec({ time: T0, message: "old stream" })], "c-old") },
        { body: page([rec({ time: T0 + 5_000, message: "new stream" })], "c-new") },
      ];
      mountPanel();
      await settle();
      expect(rowTexts().join(" ")).toContain("old stream");

      selectChannel("web-ui");
      await settle();

      expect(calls[1]).toBe("/rolebox/logs?limit=200&channel=web-ui");
      expect(rowTexts().join(" ")).not.toContain("old stream");
      expect(rowTexts().join(" ")).toContain("new stream");
    });

    it("narrows to the docked session when this tab is asked to", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel({ sessionId: SESSION });
      await settle();

      click(sessionButton());
      await settle();

      expect(calls[calls.length - 1]).toBe(
        "/rolebox/logs?limit=200&session=" + encodeURIComponent(SESSION),
      );
      expect(sessionButton().props["aria-pressed"]).toBe(true);
    });

    it("restarts the view when the seat hands the body another session", async () => {
      queue = [{ body: page([rec({ time: T0, message: "session A record" })], "c-a") }];
      mountPanel({ sessionId: "session-A" });
      await settle();
      click(sessionButton());
      await settle();
      expect(calls[calls.length - 1]).toContain(
        "session=" + encodeURIComponent("session-A"),
      );

      // The seat hands the body another session while the tab stays mounted.
      queue = [{ body: page([rec({ time: T0 + 1_000, message: "session B record" })], "c-b") }];
      rerender({ sessionId: "session-B" });
      await settle();

      const last = calls[calls.length - 1]!;
      expect(last).toContain("session=" + encodeURIComponent("session-B"));
      // The new session's view starts from scratch: no cursor from session A.
      expect(last).not.toContain("cursor=");
      expect(rowTexts().join(" ")).toContain("session B record");
      expect(rowTexts().join(" ")).not.toContain("session A record");
    });

    it("does not offer the session toggle when the seat names no session", async () => {
      queue = [{ body: page([rec()], "c1") }];
      mountPanel();
      await settle();

      expect(
        byClass("rolebox-logs-button").filter((node) => textOf(node) === "This session"),
      ).toHaveLength(0);
    });
  });

  describe("empty and error states", () => {
    it("explains an empty view with the source it looked in", async () => {
      queue = [{ body: emptyPage("c1") }];
      mountPanel();
      await settle();

      expect(emptyText()).toContain("No records yet");
      expect(emptyText()).toContain(FIXTURE_SOURCE.path);
      expect(rows()).toHaveLength(0);
    });

    it("states a failed read with the HTTP status and offers Retry", async () => {
      queue = [{ status: 500, body: { ok: false, error: "boom" } }];
      mountPanel();
      await settle();

      expect(errorText()).toContain("HTTP 500");
      expect(byClass("rolebox-logs-error")[0]!.props.role).toBe("alert");
      expect(statusSeat().props.role).toBe("status");

      queue = [{ body: page([rec()], "c1") }];
      click(retryButton());
      await settle();

      expect(rowTexts()).toHaveLength(1);
      expect(errorText()).toBe("");
    });

    it("keeps the buffer when a later poll fails, and still offers Retry", async () => {
      queue = [{ body: page([rec({ message: "kept" })], "c1") }];
      mountPanel();
      await settle();

      queue = [{ status: 503, body: { ok: false, error: "gone" } }];
      await tick();

      expect(rowTexts().join(" ")).toContain("kept");
      expect(errorText()).toContain("HTTP 503");
      expect(retryButton()).toBeDefined();
    });

    it("treats a page without a cursor as a broken contract, not as empty", async () => {
      queue = [{ body: { records: [], source: FIXTURE_SOURCE, skippedLines: 0, truncated: false } }];
      mountPanel();
      await settle();

      expect(errorText()).toContain("unexpected response body");
      expect(emptyText()).toBe("");
    });

    it("survives a network failure with a readable message", async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
      try {
        mountPanel();
        await settle();
        expect(errorText()).toContain("connection refused");
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("readLogsPage / capBuffer / logsRequestUrl (unit)", () => {
    it("normalises a page and tolerates a partly unreadable record list", () => {
      const result = panel.readLogsPage({
        records: [rec({ level: "verbose", scope: { graphId: "g1", n: 2 } }), 42, null],
        cursor: "c1",
        source: { kind: "dir", path: "/tmp/x" },
        skippedLines: 3,
        truncated: true,
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.level).toBe("info");
      expect(result.records[0]!.scope).toEqual({ graphId: "g1" });
      expect(result.source).toEqual({ kind: "dir", path: "/tmp/x" });
      expect(result.skippedLines).toBe(3);
      expect(result.truncated).toBe(true);
    });

    it("rejects a body that is not a page", () => {
      expect(panel.readLogsPage(null)).toEqual({ error: "unexpected response body" });
      expect(panel.readLogsPage([])).toEqual({ error: "unexpected response body" });
      expect(panel.readLogsPage({ records: [] })).toEqual({
        error: "unexpected response body (no cursor)",
      });
    });

    it("caps to the newest records and counts the dropped front", () => {
      // The wire fixture is untyped on purpose (it comes from JSON); the unit
      // under test takes the panel's own record type.
      type PanelRecord = Parameters<typeof panel.capBuffer>[0][number];
      const records = Array.from({ length: panel.BUFFER_LIMIT + 3 }, (_entry, index) =>
        rec({ time: index, message: String(index) }),
      ) as unknown as PanelRecord[];
      const capped = panel.capBuffer(records);
      expect(capped.records).toHaveLength(panel.BUFFER_LIMIT);
      expect(capped.dropped).toBe(3);
      expect(capped.records[0]!.message).toBe("3");

      const small = panel.capBuffer(records.slice(0, 2));
      expect(small.dropped).toBe(0);
      expect(small.records).toHaveLength(2);
    });

    it("builds the request URL from the cursor and the active filter", () => {
      expect(panel.logsRequestUrl("", { channel: "", sessionOnly: false })).toBe(
        "/rolebox/logs?limit=200",
      );
      expect(panel.logsRequestUrl("c1", { channel: "graph:host", sessionOnly: false })).toBe(
        "/rolebox/logs?limit=200&cursor=c1&channel=graph%3Ahost",
      );
      expect(panel.logsRequestUrl("", { channel: "", sessionOnly: true }, SESSION)).toBe(
        "/rolebox/logs?limit=200&session=" + encodeURIComponent(SESSION),
      );
      // The session filter is inert without a session to narrow to.
      expect(panel.logsRequestUrl("", { channel: "", sessionOnly: true })).toBe(
        "/rolebox/logs?limit=200",
      );
    });

    it("formats a record time as a fixed-width local clock", () => {
      const at = new Date(2026, 0, 2, 3, 4, 5, 6).getTime();
      expect(panel.clockTime(at)).toBe("03:04:05.006");
    });
  });

  describe("design posture", () => {
    it("keeps the tab body single-column, wrapping and unable to overflow its pane", () => {
      const cssText = css.logsCss;
      const rootBlock = /\.rolebox-logs\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(rootBlock).toContain("padding: 12px 8px");
      const headerBlock = /\.rolebox-logs-header\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(headerBlock).toContain("minmax(0, 1fr)");
      for (const cls of ["rolebox-logs-row", "rolebox-logs-meta", "rolebox-logs-facts", "rolebox-logs-controls"]) {
        const block = new RegExp("\\." + cls + "\\b[^{}]*\\{([^}]*)\\}", "s").exec(cssText)?.[1] ?? "";
        const wraps = block.includes("flex-wrap: wrap") || block.includes("minmax(0, 1fr)");
        expect(wraps).toBe(true);
      }
      const fixedWidths = [...cssText.matchAll(/[;{\s]width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      expect(fixedWidths.every((width) => width <= 280)).toBe(true);
    });

    it("ships namespaced rules with only --dsw-* tokens", () => {
      const cssText = css.logsCss;
      // Every class the component names exists in the sheet.
      for (const cls of Object.values(css.logsClass)) {
        expect(cssText).toContain("." + cls);
      }
      // Every bare var() reference is a dsw design token.
      const allVars = [...cssText.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!);
      expect(allVars.filter((token) => !token.startsWith("--dsw-"))).toEqual([]);
      // Every private token CONSUMPTION carries a comma and a fallback.
      const bareRoleboxVars = [...cssText.matchAll(/var\((--rolebox-[a-z0-9-]+)\)/g)].map(
        (match) => match[1]!,
      );
      expect(bareRoleboxVars).toEqual([]);
      // No decorative edge stripes: the level is a chip and a tint, never a bar.
      expect(cssText).not.toContain("border-left");
      expect(cssText).not.toContain("border-inline-start");
      // One motion curve: the host's.
      expect(cssText.match(/--rolebox-logs-ease[a-z-]*:/g)).toEqual(["--rolebox-logs-ease:"]);
    });

    it("announces the poll outcome in one live region, not many", () => {
      // Render the panel this test asserts on rather than inheriting whichever
      // render a sibling test happened to leave in the harness's shared tree.
      mountPanel();
      expect(byClass("rolebox-logs-status")).toHaveLength(1);
      expect(statusSeat().props.role).toBe("status");
    });
  });
});
