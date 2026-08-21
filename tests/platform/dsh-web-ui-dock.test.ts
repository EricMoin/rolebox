/// <reference types="bun-types" />

/**
 * RoleSwitchDock behavior tests — the browser-half dock component
 * (`src/platform/adapters/dsh/web-ui/role-switch-dock.tsx`).
 *
 * Verifies the dock's interaction contract:
 *   - collapsed by default on mount AND re-collapsed on session change,
 *     with the hydrated active role reported by the header status seat
 *     (plus the header's current-role dot) while the list is hidden;
 *   - one-click expand (`aria-expanded`) with `aria-current` on the active
 *     role row;
 *   - the keystroke filter (name + description, case-insensitive), its
 *     clear affordance, Escape-to-clear, and the explicit no-match row;
 *   - the filter query surviving collapse/expand but resetting on session
 *     change (transient chrome state, never hidden state);
 *   - protected-name layout: the name seat is `flex: none` in the injected
 *     CSS and every row renders the full name (plus `title` recovery on
 *     name and meta) — meta truncates first, identity never does;
 *   - preserved mutation behaviors: successful switch/clear collapse the
 *     dock and move `aria-current`; a failed mutation keeps the list open
 *     with the Retry row; rows are busy-disabled while a mutation is in
 *     flight (the filter stays usable).
 *
 * ── Harness ────────────────────────────────────────────────────────────────
 * React is NOT a devDependency of this repo (the temporary
 * `react.stub.d.ts` covers the type surface), so — like the sibling
 * `dsh-web-ui-client.test.ts` — `react` and the JSX runtime are mocked
 * BEFORE the dock module is imported. Unlike that file, the double here is
 * STATEFUL: a ~100-line mini-React (hook slots per component instance,
 * synchronous re-render on `setState`, effect flush with dependency
 * comparison and cleanup) plus a virtual-DOM tree with query helpers. This
 * is enough to exercise the component's full state machine in-process,
 * with `fetch` double-routed through a per-test config and assertions on
 * the rendered vnode tree (no DOM, no jsdom — bun-native).
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

/** Re-render with new props (effects re-run only if their deps changed). */
function rerender(props: unknown): void {
  currentProps = props;
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

function byType(type: string): VNode[] {
  return allNodes().filter((node) => node.type === type);
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

function changeInput(input: VNode, value: string): void {
  const onChange = input.props.onChange;
  if (typeof onChange === "function") {
    (onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  }
}

function keyDown(input: VNode, key: string): void {
  const onKeyDown = input.props.onKeyDown;
  if (typeof onKeyDown === "function") (onKeyDown as (event: { key: string }) => void)({ key });
}

// ── Module mocks (must precede the dock import) ────────────────────────────

const FRAGMENT = Symbol.for("react.fragment");
const jsx = (type: unknown, props: Record<string, unknown>): VNode => ({ type, props });

mock.module("react", () => ({ useState, useEffect, createElement: jsx, Fragment: FRAGMENT }));
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));
mock.module("react/jsx-dev-runtime", () => ({ jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT }));

// ── Module under test (dynamic import: mocks must precede the graph) ───────

const dock = await import("../../src/platform/adapters/dsh/web-ui/role-switch-dock.tsx");
const css = await import("../../src/platform/adapters/dsh/web-ui/role-switch-dock.css.ts");

// ── fetch double ───────────────────────────────────────────────────────────

interface FetchConfig {
  roles: Array<{
    id: string;
    name: string;
    description: string;
    model: string | null;
    mode: string | null;
  }>;
  active: string | null;
  switchOk: boolean;
  clearOk: boolean;
  /** When true, the next POST /roles/switch hangs until `releaseSwitch` resolves it. */
  gateSwitch: boolean;
}

let cfg: FetchConfig;
const calls: Array<{ url: string; method: string; body: string | null }> = [];
let releaseSwitch: ((res: Response) => void) | null = null;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
  if (url === dock.ROLES_ENDPOINT) {
    return Promise.resolve(fakeResponse(200, cfg.roles));
  }
  if (url.startsWith(dock.ACTIVE_ENDPOINT + "?")) {
    if (method === "DELETE") {
      if (!cfg.clearOk) {
        return Promise.resolve(fakeResponse(500, { ok: false, error: "server exploded" }));
      }
      return Promise.resolve(fakeResponse(200, { ok: true, session: "sess-1", role: null }));
    }
    return Promise.resolve(fakeResponse(200, { session: "sess-1", role: cfg.active }));
  }
  if (url === dock.SWITCH_ENDPOINT && method === "POST") {
    if (cfg.gateSwitch) {
      return new Promise<Response>((resolve) => {
        releaseSwitch = resolve;
      });
    }
    if (!cfg.switchOk) {
      return Promise.resolve(fakeResponse(500, { ok: false, error: "server exploded" }));
    }
    const role = (JSON.parse(init!.body as string) as { role: string }).role;
    return Promise.resolve(fakeResponse(200, { ok: true, session: "sess-1", role }));
  }
  return Promise.resolve(fakeResponse(404, { ok: false, error: "not found" }));
}) as typeof fetch;

// ── Fixtures and helpers ───────────────────────────────────────────────────

const ROLES = [
  {
    id: "engineer",
    name: "Engineer",
    description: "Writes and ships production code",
    model: "gpt-4o",
    mode: "code",
  },
  {
    id: "architect",
    name: "Software Architect",
    description: "Designs systems and reviews architecture decisions",
    model: "claude-sonnet",
    mode: null,
  },
  {
    id: "qa",
    name: "QA Lead",
    description: "Owns test strategy and release quality",
    model: null,
    mode: null,
  },
  {
    id: "long",
    name: "A Very Long Role Name That Must Never Be Clipped",
    description: "Long description",
    model: "gpt-4",
    mode: "chat",
  },
];

function mountDock(sessionId = "sess-1"): void {
  calls.length = 0;
  releaseSwitch = null;
  mount(dock.RoleSwitchDock as unknown as (props: unknown) => unknown, { sessionId });
}

/** Flush the microtask chain (fetch → json → setState) before asserting. */
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function headerButton(): VNode {
  return byClass("rolebox-dock-header")[0]!;
}

function expand(): void {
  click(headerButton());
}

function filterInput(): VNode {
  return byClass("rolebox-dock-filter-input")[0]!;
}

function rows(): VNode[] {
  return byClass("rolebox-dock-row");
}

/** The role rows proper — excludes the Retry and clear-to-base control rows. */
function roleRows(): VNode[] {
  return rows().filter((row) => ROLES.some((role) => textOf(row).includes(role.name)));
}

function statusSeat(): VNode {
  return byClass("rolebox-dock-status")[0]!;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleSwitchDock", () => {
  beforeEach(() => {
    cfg = { roles: ROLES, active: null, switchOk: true, clearOk: true, gateSwitch: false };
  });

  describe("collapsed posture", () => {
    it("starts collapsed and hydrates the active role into the header seat", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();

      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      expect(headerButton().props["aria-expanded"]).toBe(false);
      expect(textOf(statusSeat())).toContain("Active role: engineer");
      expect(statusSeat().props.title).toBe("Active role: engineer");
      // The current-role dot in the header marks a non-base session at a glance.
      expect(byClass("rolebox-dock-current")).toHaveLength(1);
    });

    it("shows no current dot when the session runs the base agent", async () => {
      mountDock();
      await settle();
      expect(textOf(statusSeat())).toBe("Ready");
      expect(byClass("rolebox-dock-current")).toHaveLength(0);
    });

    it("expands with one click and marks the active role with aria-current", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();

      expect(byClass("rolebox-dock-list")).toHaveLength(1);
      expect(headerButton().props["aria-expanded"]).toBe(true);
      expect(roleRows()).toHaveLength(ROLES.length);
      const current = roleRows().filter((row) => row.props["aria-current"] === "true");
      expect(current).toHaveLength(1);
      expect(textOf(current[0]!)).toContain("Engineer");
    });

    it("re-collapses on session change and resets the transient filter", async () => {
      mountDock();
      await settle();
      expand();
      changeInput(filterInput(), "eng");
      expect(rows()).toHaveLength(1);

      cfg.active = "architect";
      rerender({ sessionId: "sess-2" });
      await settle();

      expect(headerButton().props["aria-expanded"]).toBe(false);
      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      expect(textOf(statusSeat())).toContain("Active role: architect");
      const activeCalls = calls.filter((call) => call.url.startsWith(dock.ACTIVE_ENDPOINT));
      expect(activeCalls.at(-1)!.url).toContain("sess-2");

      expand();
      expect(filterInput().props.value).toBe("");
      expect(roleRows()).toHaveLength(ROLES.length);
    });
  });

  describe("filter", () => {
    it("narrows the list by name as the user types", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "arch");
      expect(rows()).toHaveLength(1);
      expect(textOf(rows()[0]!)).toContain("Software Architect");

      changeInput(filterInput(), "");
      expect(rows()).toHaveLength(ROLES.length);
    });

    it("matches descriptions too", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "test strategy");
      expect(rows()).toHaveLength(1);
      expect(textOf(rows()[0]!)).toContain("QA Lead");
    });

    it("offers a clear affordance that restores the full list", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "eng");
      expect(rows()).toHaveLength(1);
      const clearButton = byClass("rolebox-dock-filter-clear")[0]!;
      expect(clearButton.props["aria-label"]).toBe("Clear filter");

      click(clearButton);
      expect(filterInput().props.value).toBe("");
      expect(rows()).toHaveLength(ROLES.length);
      expect(byClass("rolebox-dock-filter-clear")).toHaveLength(0);
    });

    it("clears the query on Escape", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "eng");
      expect(rows()).toHaveLength(1);
      keyDown(filterInput(), "Escape");
      expect(filterInput().props.value).toBe("");
      expect(rows()).toHaveLength(ROLES.length);
    });

    it("shows an explicit no-match row when nothing matches", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "zzz");
      expect(rows()).toHaveLength(0);
      const empty = byClass("rolebox-dock-empty");
      expect(empty).toHaveLength(1);
      expect(textOf(empty[0]!)).toBe("No roles match “zzz”");
    });

    it("keeps the clear-to-base row reachable while the filter has no matches", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "zzz");
      expect(byClass("rolebox-dock-empty")).toHaveLength(1);
      expect(rows().some((row) => textOf(row).includes("Return to base agent"))).toBe(true);
    });

    it("preserves the query across collapse/expand (visible, never hidden)", async () => {
      mountDock();
      await settle();
      expand();

      changeInput(filterInput(), "eng");
      click(headerButton());
      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      click(headerButton());
      expect(filterInput().props.value).toBe("eng");
      expect(rows()).toHaveLength(1);
    });
  });

  describe("name legibility", () => {
    it("renders the full role name with title recovery on name and meta", async () => {
      mountDock();
      await settle();
      expand();

      const longName = "A Very Long Role Name That Must Never Be Clipped";
      const name = byClass("rolebox-dock-name").find((node) => textOf(node) === longName);
      expect(name).toBeDefined();
      expect(name!.props.title).toBe(longName);

      const meta = byClass("rolebox-dock-meta").find((node) => textOf(node).includes("Long description"));
      expect(meta).toBeDefined();
      expect(meta!.props.title).toBe("Long description · gpt-4 · chat");
    });

    it("protects the name seat from shrinking and lets meta absorb leftover space (CSS contract)", () => {
      const cssText = css.dockCss;
      const nameBlock = cssText.match(/\.rolebox-dock-name\s*\{([^}]*)\}/s)![1]!;
      expect(nameBlock).toContain("flex: none");
      expect(nameBlock).toContain("max-width: 100%");
      expect(nameBlock).toContain("text-overflow: ellipsis");

      const metaBlock = cssText.match(/\.rolebox-dock-meta\s*\{([^}]*)\}/s)![1]!;
      expect(metaBlock).toContain("flex: 1 1 auto");
      expect(metaBlock).toContain("min-width: 0");
      expect(metaBlock).toContain("text-overflow: ellipsis");
    });
  });

  describe("mutations", () => {
    it("collapses after a successful switch and moves aria-current", async () => {
      mountDock();
      await settle();
      expand();

      click(rows().find((row) => textOf(row).includes("Engineer"))!);
      await settle();

      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      expect(textOf(statusSeat())).toContain("Role engineer is active");
      const posted = calls.find((call) => call.method === "POST");
      expect(posted!.body).toBe(JSON.stringify({ role: "engineer", session: "sess-1" }));

      expand();
      const current = rows().find((row) => row.props["aria-current"] === "true");
      expect(current).toBeDefined();
      expect(textOf(current!)).toContain("Engineer");
    });

    it("keeps the list open on a failed switch and retries from the Retry row", async () => {
      cfg.switchOk = false;
      mountDock();
      await settle();
      expand();

      click(rows().find((row) => textOf(row).includes("Engineer"))!);
      await settle();

      expect(byClass("rolebox-dock-list")).toHaveLength(1);
      expect(textOf(statusSeat())).toContain("Switch failed");
      const retry = rows().find((row) => textOf(row).includes("Retry"))!;
      expect(textOf(retry)).toContain("Switch to engineer");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

      cfg.switchOk = true;
      click(retry);
      await settle();

      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      expect(textOf(statusSeat())).toContain("Role engineer is active");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    });

    it("returns to the base agent via the clear row and collapses", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();

      click(rows().find((row) => textOf(row).includes("Return to base agent"))!);
      await settle();

      expect(byClass("rolebox-dock-list")).toHaveLength(0);
      expect(textOf(statusSeat())).toContain("Base agent active");
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);

      expand();
      expect(rows().some((row) => row.props["aria-current"] === "true")).toBe(false);
    });

    it("disables rows while a mutation is in flight but keeps the filter usable", async () => {
      cfg.gateSwitch = true;
      mountDock();
      await settle();
      expand();

      click(rows().find((row) => textOf(row).includes("Engineer"))!);
      expect(rows().every((row) => row.props.disabled === true)).toBe(true);
      expect(headerButton().props.disabled).toBeUndefined();

      // Filtering is not a mutation — it stays usable while busy.
      changeInput(filterInput(), "arch");
      expect(rows()).toHaveLength(1);

      releaseSwitch!(fakeResponse(200, { ok: true, session: "sess-1", role: "engineer" }));
      await settle();
      expect(byClass("rolebox-dock-list")).toHaveLength(0);
    });
  });

  describe("CSS posture", () => {
    it("ships filter/empty rules under the rolebox-dock namespace with only --dsw-* tokens", () => {
      const cssText = css.dockCss;
      for (const cls of [
        "rolebox-dock-filter",
        "rolebox-dock-filter-input",
        "rolebox-dock-filter-clear",
        "rolebox-dock-empty",
      ]) {
        expect(cssText).toContain("." + cls);
      }
      // Every var() reference is either a dsw design token or one of the
      // pre-existing composer frame vars — no new --dsh-* token leaks in.
      const allVars = [...cssText.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!);
      const frameVars = new Set([
        "--dsh-composer-side-clearance",
        "--dsh-composer-dock-inset",
        "--dsh-composer-card-max-width",
        "--dsh-composer-stack-gap",
      ]);
      const leaks = allVars.filter((token) => !token.startsWith("--dsw-") && !frameVars.has(token));
      expect(leaks).toEqual([]);
    });
  });
});
