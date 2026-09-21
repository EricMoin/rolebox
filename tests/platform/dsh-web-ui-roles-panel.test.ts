/// <reference types="bun-types" />

/**
 * RoleboxRolesPanel behavior tests — the browser-half "Rolebox" settings page
 * (`src/platform/adapters/dsh/web-ui/rolebox-roles-panel.tsx`), which lists
 * the loaded roles and owns the manual role-reload control.
 *
 * Verifies the page's interaction contract:
 *   - `GET /rolebox/roles` is fetched on mount, and each rendered card carries
 *     the role's identity (display name, id, description), its model / mode
 *     (or the explicit "default" / "primary" fallbacks) and its catalog
 *     configuration (tool policy allow/deny counts + names, maxSteps);
 *   - missing / absent seats render explicit fallbacks ("not set",
 *     "none declared", "Unnamed role", "No description") rather than blanks;
 *   - a long tool-name list caps with the untruncated list in the `title`;
 *   - manual Refresh re-fetches the list (busy-gating the controls) and
 *     updates the cards, and a second gesture while a request is in flight is
 *     ignored (in-flight guard);
 *   - the manual role-reload control POSTs `/rolebox/reload` exactly once per
 *     click, reports discovered / resolved / skipped, re-fetches the list on
 *     success, reports failures on the status seat WITHOUT a follow-up fetch,
 *     and never schedules a timer (no polling);
 *   - the loading / error / empty states: a pending initial fetch shows the
 *     skeleton, an HTTP failure shows a `role="alert"` error with Retry, a
 *     malformed (non-array) body is reported as an invalid response, an empty
 *     array shows the explicit "No roles loaded" state, and a refresh failure
 *     with cards already rendered keeps the cards and reports on the status
 *     seat;
 *   - "Open monitor" closes the settings shell first, then calls the injected
 *     `openMonitor`; a non-null return lands on the status seat (never thrown);
 *   - accessibility posture: one live-region status seat (`role="status"`)
 *     that wraps no control, an `<h1>Rolebox</h1>`, keyboard-operable buttons,
 *     and the `data-rolebox-roles` marker plus `aria-busy`;
 *   - the CSS module ships `rolebox-roles-` namespaced rules whose only
 *     design tokens are `--dsw-*` (no bare `--rolebox-*` consumption).
 *
 * ── Harness ────────────────────────────────────────────────────────────────
 * React is NOT a devDependency of this repo (the temporary
 * `react.stub.d.ts` covers the type surface), so — like the sibling
 * `dsh-web-ui-monitor-panel.test.ts` — `react` and the JSX runtime are
 * mocked BEFORE the panel module is imported, with the same STATEFUL
 * mini-React double (hook slots per component instance, synchronous re-render
 * on `setState`, effect flush with dependency comparison and cleanup) plus a
 * virtual-DOM tree with query helpers (the repo duplicates these doubles per
 * test file rather than sharing a helper module).
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

/** Same query, restricted to one subtree. */
function within(root: VNode, cls: string): VNode[] {
  const out: VNode[] = [];
  walk(root, (node) => {
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

const panel = await import("../../src/platform/adapters/dsh/web-ui/rolebox-roles-panel.tsx");
const css = await import("../../src/platform/adapters/dsh/web-ui/rolebox-roles-panel.css.ts");

// ── fetch double ───────────────────────────────────────────────────────────

interface FetchConfig {
  roles: unknown;
  rolesOk: boolean;
  /** When true, the roles fetch hangs until `releaseGate` resolves it. */
  gate: boolean;
  /** `POST /rolebox/reload` response body (the success shape by default). */
  reload: unknown;
  /** When false, the reload POST answers 409 with `reload` as the error body. */
  reloadOk: boolean;
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
  if (url === panel.RELOAD_ENDPOINT) {
    // MANUAL ONLY: the POST is issued from the button's click, never a timer.
    if (method !== "POST") {
      return Promise.resolve(fakeResponse(405, { ok: false, error: "Method not allowed" }));
    }
    return Promise.resolve(fakeResponse(cfg.reloadOk ? 200 : 409, cfg.reload));
  }
  if (cfg.gate) {
    return new Promise<Response>((resolve) => {
      pendingGates.push(() => resolve(fakeResponse(200, cfg.roles)));
    });
  }
  if (url === panel.ROLES_ENDPOINT) {
    if (!cfg.rolesOk) return Promise.resolve(fakeResponse(500, { ok: false, error: "boom" }));
    return Promise.resolve(fakeResponse(200, cfg.roles));
  }
  return Promise.resolve(fakeResponse(404, { ok: false, error: "not found" }));
}) as typeof fetch;

// ── Fixtures and helpers ───────────────────────────────────────────────────

const ROLES_BODY = [
  {
    id: "engineer",
    name: "Engineer",
    description: "Builds and verifies changes",
    model: "example-provider/model-a",
    mode: "primary",
    tools: { allow: ["read", "write", "bash"], deny: ["browser"] },
    maxSteps: 40,
  },
  {
    id: "qa",
    name: "QA",
    description: "Reviews changes",
    model: null,
    mode: null,
    tools: null,
    maxSteps: null,
  },
];

function mountPanel(props: Record<string, unknown> = {}): void {
  calls.length = 0;
  pendingGates.length = 0;
  mount(panel.RoleboxRolesPanel as unknown as (props: unknown) => unknown, props);
}

/** Flush the microtask chain (fetch → json → setState) before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function root(): VNode {
  return byClass("rolebox-roles")[0]!;
}

function cards(): VNode[] {
  return byClass("rolebox-roles-card");
}

function refreshButton(): VNode {
  return byClass("rolebox-roles-refresh")[0]!;
}

function reloadButton(): VNode {
  return byClass("rolebox-roles-reload")[0]!;
}

function openMonitorButton(): VNode {
  return byClass("rolebox-roles-open-monitor")[0]!;
}

function statusSeat(): VNode {
  return byClass("rolebox-roles-status")[0]!;
}

function stateSeat(): VNode {
  return byClass("rolebox-roles-state")[0]!;
}

/** Text of the `dd` of the kv row whose `dt` label is `name`, inside `card`. */
function kvValue(card: VNode, name: string): string {
  const row = within(card, "rolebox-roles-kv-row").find((node) => {
    const children = childNodes(node);
    return children.length > 0 && textOf(children[0]!) === name;
  });
  expect(row).toBeDefined();
  const children = childNodes(row!);
  return textOf(children[1] ?? "");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleboxRolesPanel", () => {
  beforeEach(() => {
    cfg = {
      roles: ROLES_BODY,
      rolesOk: true,
      gate: false,
      reload: { ok: true, discovered: 3, resolved: 2, skipped: 1 },
      reloadOk: true,
    };
  });

  describe("API contract", () => {
    it("declares the same-origin roles and reload endpoints", () => {
      expect(panel.ROLES_ENDPOINT).toBe("/rolebox/roles");
      expect(panel.RELOAD_ENDPOINT).toBe("/rolebox/reload");
    });

    it("fetches the role list on mount and marks the page", async () => {
      mountPanel();
      await settle();

      expect(calls).toEqual(["GET /rolebox/roles"]);
      expect(root().props["data-rolebox-roles"]).toBe(true);
      expect(root().props["aria-busy"]).toBe(false);
    });
  });

  describe("role cards", () => {
    it("renders one card per role in API order with identity and configuration", async () => {
      mountPanel();
      await settle();

      const rendered = cards();
      expect(rendered).toHaveLength(2);
      // API order is preserved: engineer first.
      const first = rendered[0]!;
      const firstText = textOf(first);
      expect(firstText).toContain("Engineer");
      expect(firstText).toContain("engineer");
      expect(firstText).toContain("Builds and verifies changes");
      expect(kvValue(first, "Model")).toBe("example-provider/model-a");
      expect(kvValue(first, "Mode")).toBe("primary");
      expect(kvValue(first, "Max steps")).toBe("40");
      // Tool policy: counts always visible, names compactly after them.
      expect(firstText).toContain("Allow (3)");
      expect(firstText).toContain("Deny (1)");
      expect(firstText).toContain("read, write, bash");
      expect(firstText).toContain("browser");
      // The header states how many roles are loaded.
      expect(textOf(byClass("rolebox-roles-count")[0]!)).toBe("2 roles");
    });

    it("renders explicit fallbacks for absent model / mode / tools / maxSteps", async () => {
      mountPanel();
      await settle();

      const second = cards()[1]!;
      const text = textOf(second);
      expect(text).toContain("QA");
      // Never a silently empty chip.
      expect(kvValue(second, "Model")).toBe("default");
      expect(kvValue(second, "Mode")).toBe("primary");
      expect(kvValue(second, "Max steps")).toBe("not set");
      expect(text).toContain("Tool policy: none declared");
    });

    it("normalizes malformed items defensively and never crashes", async () => {
      cfg.roles = [
        { id: "bare" }, // no name / description / model / mode / tools / maxSteps
        { id: 7, name: 42, description: null, model: 3, mode: [], tools: "nope", maxSteps: "many" },
        "not an object",
        { id: "half", name: "Half", tools: { allow: ["read", 5, null], deny: "all" } },
      ];
      mountPanel();
      await settle();

      const rendered = cards();
      // The non-record item is dropped; the rest render.
      expect(rendered).toHaveLength(3);
      expect(textOf(rendered[0]!)).toContain("bare");
      expect(textOf(rendered[0]!)).toContain("No description");
      expect(kvValue(rendered[0]!, "Max steps")).toBe("not set");
      // Wrong-typed halves degrade to the explicit fallbacks, not to a crash.
      expect(kvValue(rendered[1]!, "Model")).toBe("default");
      // A present policy with a malformed half keeps both counts visible.
      const half = textOf(rendered[2]!);
      expect(half).toContain("Allow (1)");
      expect(half).toContain("Deny (0)");
      expect(half).toContain("read");
    });

    it("caps a long tool list and recovers the full list through the title", async () => {
      cfg.roles = [
        {
          id: "many",
          name: "Many",
          description: "",
          model: null,
          mode: null,
          tools: { allow: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"], deny: [] },
          maxSteps: 5,
        },
      ];
      mountPanel();
      await settle();

      const names = byClass("rolebox-roles-tool-names")[0]!;
      const shown = textOf(names);
      expect(shown).toContain("t1");
      expect(shown).not.toContain("t9");
      expect(shown).toContain("+3 more");
      // Every truncation is recoverable.
      expect(names.props.title).toBe("t1, t2, t3, t4, t5, t6, t7, t8, t9");
      expect(textOf(cards()[0]!)).toContain("Allow (9)");
    });

    it("shows the explicit empty state for an empty list", async () => {
      cfg.roles = [];
      mountPanel();
      await settle();

      expect(cards()).toHaveLength(0);
      expect(textOf(stateSeat())).toBe("No roles loaded");
      expect(textOf(byClass("rolebox-roles-count")[0]!)).toBe("0 roles");
    });
  });

  describe("manual refresh", () => {
    it("re-fetches the list, busy-gates the controls, and updates the cards", async () => {
      mountPanel();
      await settle();
      expect(calls).toHaveLength(1);

      cfg.roles = [ROLES_BODY[1]!];
      cfg.gate = true;
      click(refreshButton());
      // In flight: the page is busy and the controls are disabled.
      expect(root().props["aria-busy"]).toBe(true);
      expect(refreshButton().props.disabled).toBe(true);
      expect(reloadButton().props.disabled).toBe(true);
      expect(textOf(statusSeat())).toBe("Refreshing…");

      // The in-flight guard: a second gesture cannot queue another request.
      click(refreshButton());
      releaseGate();
      await settle();

      expect(calls).toHaveLength(2);
      expect(refreshButton().props.disabled).toBe(false);
      expect(cards()).toHaveLength(1);
      expect(textOf(cards()[0]!)).toContain("QA");
      expect(textOf(statusSeat())).toContain("Loaded 1 role");
    });
  });

  describe("manual role reload", () => {
    it("POSTs /rolebox/reload exactly once per click, then re-fetches the list", async () => {
      mountPanel();
      await settle();
      expect(calls).toEqual(["GET /rolebox/roles"]);

      click(reloadButton());
      // In flight: the page is busy and both controls are gated.
      expect(root().props["aria-busy"]).toBe(true);
      expect(reloadButton().props.disabled).toBe(true);
      await settle();

      expect(calls).toEqual([
        "GET /rolebox/roles",
        "POST /rolebox/reload",
        "GET /rolebox/roles",
      ]);
      expect(root().props["aria-busy"]).toBe(false);

      // The button is the only trigger: one click, one POST.
      click(reloadButton());
      await settle();
      expect(calls.filter((call) => call === "POST /rolebox/reload")).toHaveLength(2);
    });

    it("surfaces the reload success (discovered / resolved / skipped) on the status seat", async () => {
      mountPanel();
      await settle();

      click(reloadButton());
      expect(textOf(statusSeat())).toBe("Reloading roles…");
      await settle();

      // The confirmation survives the list re-fetch it triggered.
      expect(textOf(statusSeat())).toContain("Reloaded roles");
      expect(textOf(statusSeat())).toContain("3 discovered");
      expect(textOf(statusSeat())).toContain("2 resolved");
      expect(textOf(statusSeat())).toContain("1 skipped");
      expect(statusSeat().props.className).not.toContain("rolebox-roles-status-error");
      expect(cards()).toHaveLength(2);
    });

    it("surfaces a failed reload on the status seat and keeps the cards", async () => {
      cfg.reloadOk = false;
      cfg.reload = { ok: false, error: "reload already in progress" };
      mountPanel();
      await settle();

      click(reloadButton());
      await settle();

      expect(statusSeat().props.title).toContain("Role reload failed");
      expect(statusSeat().props.title).toContain("reload already in progress");
      expect(statusSeat().props.className).toContain("rolebox-roles-status-error");
      // A failed reload changed nothing: the cards stay and no follow-up
      // fetch is issued.
      expect(cards()).toHaveLength(2);
      expect(calls).toEqual(["GET /rolebox/roles", "POST /rolebox/reload"]);
    });

    it("never schedules a timer — only a click issues the next request", async () => {
      const scheduled: string[] = [];
      const realSetInterval = globalThis.setInterval;
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setInterval = ((...args: unknown[]) => {
        scheduled.push("setInterval");
        return (realSetInterval as (...a: unknown[]) => unknown)(...args);
      }) as unknown as typeof globalThis.setInterval;
      globalThis.setTimeout = ((...args: unknown[]) => {
        scheduled.push("setTimeout");
        return (realSetTimeout as (...a: unknown[]) => unknown)(...args);
      }) as unknown as typeof globalThis.setTimeout;
      try {
        mountPanel();
        await settle();
        click(reloadButton());
        await settle();

        const afterReload = calls.length;
        expect(scheduled).toEqual([]);
        // Wait out a would-be polling tick with a REAL timer: the page still
        // fetches nothing on its own.
        await new Promise((resolve) => realSetTimeout(resolve, 25));
        expect(calls).toHaveLength(afterReload);
        expect(scheduled).toEqual([]);
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.setTimeout = realSetTimeout;
      }
    });
  });

  describe("loading / error / empty states", () => {
    it("shows a content-shaped skeleton while the initial fetch is in flight", async () => {
      cfg.gate = true;
      mountPanel();

      expect(root().props["aria-busy"]).toBe(true);
      expect(byClass("rolebox-roles-skeleton")).toHaveLength(1);
      expect(byClass("rolebox-roles-skeleton-card")).toHaveLength(2);
      expect(textOf(statusSeat())).toBe("Loading roles…");

      releaseGate();
      await settle();
      expect(byClass("rolebox-roles-skeleton")).toHaveLength(0);
      expect(root().props["aria-busy"]).toBe(false);
      expect(cards()).toHaveLength(2);
    });

    it("shows an alert error state with a Retry control when the fetch fails", async () => {
      cfg.rolesOk = false;
      mountPanel();
      await settle();

      const state = stateSeat();
      expect(state.props.role).toBe("alert");
      expect(textOf(state)).toContain("Failed to load roles");
      expect(textOf(state)).toContain("HTTP 500");
      expect(byClass("rolebox-roles-retry")).toHaveLength(1);

      // Retry re-runs the load once the backend recovers.
      cfg.rolesOk = true;
      click(byClass("rolebox-roles-retry")[0]!);
      await settle();
      expect(calls).toHaveLength(2);
      expect(cards()).toHaveLength(2);
    });

    it("reports a malformed body as an invalid response instead of an empty catalogue", async () => {
      cfg.roles = { ok: true, roles: [] };
      mountPanel();
      await settle();

      expect(stateSeat().props.role).toBe("alert");
      expect(textOf(stateSeat())).toContain("Invalid server response");
      // Never a false "No roles loaded" claim about a payload that says
      // nothing of the sort.
      expect(byClass("rolebox-roles-state")).toHaveLength(1);
    });

    it("keeps rendered cards visible when a refresh fails (error on the status seat)", async () => {
      mountPanel();
      await settle();

      cfg.rolesOk = false;
      click(refreshButton());
      await settle();

      // Cards stay on screen; the failure lands on the live-region seat.
      expect(cards()).toHaveLength(2);
      expect(textOf(cards()[0]!)).toContain("Engineer");
      expect(statusSeat().props.title).toContain("Failed to load roles");
      expect(statusSeat().props.className).toContain("rolebox-roles-status-error");
      expect(byClass("rolebox-roles-state")).toHaveLength(0);
    });
  });

  describe("open monitor", () => {
    it("closes the settings shell first, then opens the tab and reports success silently", async () => {
      const order: string[] = [];
      mountPanel({
        close: () => order.push("close"),
        openMonitor: () => {
          order.push("openMonitor");
          return null;
        },
      });
      await settle();

      click(openMonitorButton());
      expect(order).toEqual(["close", "openMonitor"]);
      // Success is silent: the seat still carries the load outcome.
      expect(statusSeat().props.className).not.toContain("rolebox-roles-status-error");
      expect(textOf(statusSeat())).toContain("Loaded 2 roles");
    });

    it("surfaces a non-null openMonitor return on the status seat instead of throwing", async () => {
      mountPanel({
        openMonitor: () => "Cannot open the monitor tab: no session surface is mounted",
      });
      await settle();

      click(openMonitorButton());
      expect(textOf(statusSeat())).toContain("Cannot open the monitor tab");
      expect(statusSeat().props.className).toContain("rolebox-roles-status-error");
      expect(statusSeat().props.title).toContain("no session surface is mounted");
    });

    it("is harmless without a close / openMonitor face", async () => {
      mountPanel();
      await settle();

      click(openMonitorButton());
      expect(textOf(statusSeat())).toContain("Loaded 2 roles");
      expect(statusSeat().props.className).not.toContain("rolebox-roles-status-error");
    });
  });

  describe("accessibility posture", () => {
    it("exposes the page heading, one live region that wraps no control, and the marker", async () => {
      mountPanel();
      await settle();

      const heading = byClass("rolebox-roles-title")[0]!;
      expect(heading.type).toBe("h1");
      expect(textOf(heading)).toBe("Rolebox");

      const seat = statusSeat();
      expect(seat.props.role).toBe("status");
      expect(seat.type).toBe("span");
      // The live region is a text seat: nothing interactive inside it.
      expect(textOf(seat)).toContain("Loaded 2 roles");
      walk(seat, (node) => {
        expect(["button", "a", "input", "select", "textarea"]).not.toContain(node.type);
      });
      // Exactly one live region.
      expect(allNodes().filter((node) => node.props.role === "status")).toHaveLength(1);

      for (const button of [refreshButton(), reloadButton(), openMonitorButton()]) {
        expect(button.type).toBe("button");
        expect(button.props.type).toBe("button");
      }
      // Keyboard-reachable: every control is focusable by default (a button)
      // and none is hidden from the tab order.
      expect(
        [refreshButton(), reloadButton(), openMonitorButton()].every(
          (button) => button.props.tabIndex === undefined,
        ),
      ).toBe(true);
    });
  });

  describe("normalization", () => {
    it("tolerates missing, extra and malformed keys", () => {
      const normalized = panel.normalizeRoles([
        { id: "a", name: "A", extra: true },
        null,
      ]);
      expect(normalized).toEqual([
        {
          id: "a",
          name: "A",
          description: "",
          model: null,
          mode: null,
          tools: null,
          maxSteps: null,
        },
      ]);
      // A body that is not a list normalizes to nothing; the panel reports it.
      expect(panel.normalizeRoles(null)).toEqual([]);
      expect(panel.normalizeRoles({ roles: [] })).toEqual([]);
    });
  });

  describe("CSS posture", () => {
    it("ships namespaced roles rules with only --dsw-* tokens", () => {
      const cssText = css.rolesCss;
      for (const cls of [
        "rolebox-roles",
        "rolebox-roles-header",
        "rolebox-roles-title",
        "rolebox-roles-refresh",
        "rolebox-roles-reload",
        "rolebox-roles-open-monitor",
        "rolebox-roles-status",
        "rolebox-roles-state",
        "rolebox-roles-retry",
        "rolebox-roles-body",
        "rolebox-roles-card",
        "rolebox-roles-role-name",
        "rolebox-roles-role-id",
        "rolebox-roles-kv-row",
        "rolebox-roles-tool-row",
        "rolebox-roles-tool-label",
        "rolebox-roles-tool-names",
        "rolebox-roles-tools-none",
        "rolebox-roles-fallback",
      ]) {
        expect(cssText).toContain("." + cls);
      }
      // Every var() reference is a dsw design token — no new --dsh-* leaks.
      const allVars = [...cssText.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!);
      const leaks = allVars.filter((token) => !token.startsWith("--dsw-"));
      expect(leaks).toEqual([]);

      // Every rolebox token CONSUMPTION must carry a comma + fallback.
      const bareRoleboxVars = [...cssText.matchAll(/var\((--rolebox-[a-z0-9-]+)\)/g)].map((m) => m[1]!);
      expect(bareRoleboxVars).toEqual([]);

      // Both settings-panel surfaces move on ONE curve — the host's.
      expect(cssText.match(/--rolebox-ease[a-z-]*:/g)).toEqual(["--rolebox-ease:"]);

      // Shared visual language: the 4pt spacing scale and the shared radius set.
      for (const step of [
        "--rolebox-space-1: 4px",
        "--rolebox-space-2: 8px",
        "--rolebox-space-3: 12px",
        "--rolebox-space-4: 16px",
      ]) {
        expect(cssText).toContain(step);
      }
      // No fixed width that could overflow the content column.
      const fixedWidths = [...cssText.matchAll(/[;{\s]width:\s*(\d+)px/g)].map((m) =>
        Number(m[1]),
      );
      expect(fixedWidths.length).toBeGreaterThan(0);
      expect(fixedWidths.every((width) => width <= 280)).toBe(true);
    });
  });
});
