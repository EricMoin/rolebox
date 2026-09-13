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

/** Nodes the component asked to focus, in order (the R5 focus-restoration spy). */
const focusCalls: unknown[] = [];

/**
 * `useRef` — a per-slot mutable cell. It shares the `states` slot array with
 * `useState` (both consume a `hookIndex` slot), so hook order stays stable.
 */
function useRef<T>(initial: T): { current: T } {
  const rs = renderState!;
  const slot = hookIndex++;
  if (rs.states.length <= slot) rs.states.push({ current: initial });
  return rs.states[slot] as { current: T };
}

const jsx = (type: unknown, props: Record<string, unknown>): VNode => {
  // Stand in for React's ref attachment so focus restoration is observable
  // without a real DOM.
  const ref = props?.ref as { current: unknown } | undefined;
  if (ref !== undefined && ref !== null && typeof ref === "object") {
    ref.current = { focus: () => focusCalls.push(type) };
  }
  return { type, props };
};

mock.module("react", () => ({ useState, useEffect, useRef, createElement: jsx, Fragment: FRAGMENT }));
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
  /** When false, `GET /rolebox/roles` answers 500 so the load-failure path is reachable. */
  rolesOk: boolean;
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
    if (!cfg.rolesOk) {
      return Promise.resolve(fakeResponse(500, { ok: false, error: "server exploded" }));
    }
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
  focusCalls.length = 0;
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

/** The header's value seat — the active role's display name (never its id). */
function valueSeat(): VNode {
  return byClass("rolebox-dock-value")[0]!;
}

/** The header's Active/Base chip (absent while the dock is still hydrating). */
function chipSeat(): VNode | undefined {
  return byClass("rolebox-dock-chip")[0];
}

/**
 * Disclosure openness. The region is ALWAYS MOUNTED (so closing can animate
 * and closed content leaves the a11y tree via `visibility`), so openness is
 * read from `data-open` rather than inferred from list presence.
 */
function disclosureOpen(): boolean {
  return byClass("rolebox-dock-disclosure")[0]!.props["data-open"] === "true";
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("RoleSwitchDock", () => {
  beforeEach(() => {
    cfg = { roles: ROLES, active: null, switchOk: true, clearOk: true, rolesOk: true, gateSwitch: false };
  });

  describe("collapsed posture", () => {
    it("starts collapsed and hydrates the active role into the header value seat", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();

      expect(disclosureOpen()).toBe(false);
      expect(headerButton().props["aria-expanded"]).toBe(false);
      // The header VALUE seat names the role: a display name, never the id the
      // picker does not show.
      expect(textOf(valueSeat())).toBe("Engineer");
      expect(valueSeat().props.title).toBe("Engineer");
      // The chip spells the state out, so it survives total loss of hue.
      expect(textOf(chipSeat()!)).toBe("Active");
      // Reserved mark seat: the non-colour row channel carrying the check glyph.
      expect(byClass("rolebox-dock-mark-active")).toHaveLength(1);
      // The shipped 6px dot is gone entirely.
      expect(byClass("rolebox-dock-current")).toHaveLength(0);
      // The live region is ALWAYS mounted so it can announce later; at rest it
      // is empty and therefore silent.
      expect(byClass("rolebox-dock-status")).toHaveLength(1);
      expect(textOf(statusSeat())).toBe("");
    });

    it("reports the base agent without a dot when the session runs no role", async () => {
      mountDock();
      await settle();
      expect(textOf(valueSeat())).toBe("Base agent");
      expect(textOf(chipSeat()!)).toBe("Base");
      expect(byClass("rolebox-dock-mark-active")).toHaveLength(0);
      expect(byClass("rolebox-dock-current")).toHaveLength(0);
      expect(textOf(statusSeat())).toBe("");
    });

    it("expands with one click and marks the active role with aria-current", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();

      expect(disclosureOpen()).toBe(true);
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
      expect(disclosureOpen()).toBe(false);
      expect(textOf(valueSeat())).toBe("Software Architect");
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
      expect(disclosureOpen()).toBe(false);
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

      expect(disclosureOpen()).toBe(false);
      // The collapse IS the confirmation: no text banner. The value seat and
      // the chip carry the new state.
      expect(textOf(valueSeat())).toBe("Engineer");
      expect(textOf(chipSeat()!)).toBe("Active");
      // No visible banner — but the change is still announced (SC 4.1.3).
      expect(textOf(statusSeat())).toContain("is now the active role");
      expect(String(statusSeat().props.className)).toContain(
        "rolebox-dock-status-sr",
      );
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
      // The retry names the DISPLAY NAME, never the id the picker never shows.
      expect(textOf(retry)).toContain("Switch to Engineer");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

      cfg.switchOk = true;
      click(retry);
      await settle();

      expect(disclosureOpen()).toBe(false);
      expect(textOf(valueSeat())).toBe("Engineer");
      expect(textOf(chipSeat()!)).toBe("Active");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    });

    it("returns to the base agent via the clear row and collapses", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();

      click(rows().find((row) => textOf(row).includes("Return to base agent"))!);
      await settle();

      expect(disclosureOpen()).toBe(false);
      expect(textOf(valueSeat())).toBe("Base agent");
      expect(textOf(chipSeat()!)).toBe("Base");
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
      // The progress message names the DISPLAY NAME, never the id.
      expect(textOf(statusSeat())).toContain("Switching to Engineer…");
      expect(rows().every((row) => row.props.disabled === true)).toBe(true);
      expect(headerButton().props.disabled).toBeUndefined();

      // Filtering is not a mutation — it stays usable while busy.
      changeInput(filterInput(), "arch");
      expect(rows()).toHaveLength(1);

      releaseSwitch!(fakeResponse(200, { ok: true, session: "sess-1", role: "engineer" }));
      await settle();
      expect(disclosureOpen()).toBe(false);
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

      // Every rolebox token CONSUMPTION must carry a comma + fallback, so the
      // bare var() scan above can never become a loophole for minting a private
      // token namespace. Definitions are plain declarations and are not scanned.
      const bareRoleboxVars = [...cssText.matchAll(/var\((--rolebox-[a-z0-9-]+)\)/g)].map((m) => m[1]!);
      expect(bareRoleboxVars).toEqual([]);
      expect(cssText).not.toContain(".rolebox-dock-current");
    });
  });

  describe("disclosure accessibility", () => {
    it("pairs aria-expanded with aria-controls on the always-mounted region", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();

      expect(headerButton().props["aria-controls"]).toBe(dock.DOCK_DISCLOSURE_ID);
      expect(byClass("rolebox-dock-disclosure")[0]!.props.id).toBe(dock.DOCK_DISCLOSURE_ID);
      expect(byClass("rolebox-dock-disclosure")).toHaveLength(1);

      const label = String(headerButton().props["aria-label"]);
      expect(label).toContain("Engineer");
      expect(label).toContain("is active");
      expect(label).toContain("Expand role list");

      expand();
      expect(String(headerButton().props["aria-label"])).toContain("Collapse role list");
    });

    it("keeps transient status text out of the toggle's own content", async () => {
      cfg.switchOk = false;
      mountDock();
      await settle();
      expand();
      click(rows().find((row) => textOf(row).includes("Engineer"))!);
      await settle();

      // The live region is a SIBLING of the toggle inside the header row, so a
      // status message can never rewrite the control's accessible name.
      expect(textOf(statusSeat())).toContain("Switch failed");
      expect(textOf(headerButton())).not.toContain("Switch failed");
    });
  });

  describe("focus restoration", () => {
    it("returns focus to the toggle after a successful switch", async () => {
      mountDock();
      await settle();
      expand();
      expect(focusCalls).toHaveLength(0);

      click(rows().find((row) => textOf(row).includes("Engineer"))!);
      await settle();

      // The activated row is hidden by the collapse, so focus must be handed
      // back to the toggle or it falls to <body> and the next keystroke is lost.
      expect(focusCalls.length).toBeGreaterThan(0);
    });

    it("returns focus to the toggle after clearing back to the base agent", async () => {
      cfg.active = "engineer";
      mountDock();
      await settle();
      expand();
      focusCalls.length = 0;

      click(rows().find((row) => textOf(row).includes("Return to base agent"))!);
      await settle();

      expect(focusCalls.length).toBeGreaterThan(0);
      expect(textOf(statusSeat())).toContain("Returned to the base agent");
    });
  });

  describe("live count", () => {
    it("reports the library size and the narrowed size while filtering", async () => {
      mountDock();
      await settle();
      expand();

      expect(textOf(byClass("rolebox-dock-count")[0]!)).toBe(String(ROLES.length));
      // The count is real feedback, so it is a live region rather than a
      // decoration a screen reader never learns about.
      expect(byClass("rolebox-dock-count")[0]!.props.role).toBe("status");
      changeInput(filterInput(), "engineer");
      expect(textOf(byClass("rolebox-dock-count")[0]!)).toBe("1 of " + ROLES.length);
    });
  });

  describe("load failure recovery", () => {
    it("offers a Reload action that recovers the list", async () => {
      cfg.rolesOk = false;
      mountDock();
      await settle();
      expand();

      expect(textOf(byClass("rolebox-dock-empty")[0]!)).toContain("Couldn't load roles");
      const reload = byClass("rolebox-dock-empty-action")[0]!;
      expect(reload).toBeDefined();
      expect(textOf(reload)).toBe("Reload");

      cfg.rolesOk = true;
      click(reload);
      await settle();

      expect(calls.filter((call) => call.url === dock.ROLES_ENDPOINT).length).toBeGreaterThanOrEqual(2);
      expect(roleRows()).toHaveLength(ROLES.length);
    });

    it("keeps an anchor on screen while the retry is in flight", async () => {
      cfg.rolesOk = false;
      mountDock();
      await settle();
      expand();
      expect(textOf(byClass("rolebox-dock-empty")[0]!)).toContain("Couldn't load roles");

      cfg.rolesOk = true;
      click(byClass("rolebox-dock-empty-action")[0]!);

      // The region the user clicked from must not blank out mid-retry, and the
      // placeholder is deliberately NOT a live region (the header seat already
      // announces the load, so a second one would double-announce).
      const placeholder = byClass("rolebox-dock-empty")[0]!;
      expect(textOf(placeholder)).toContain("Loading roles…");
      expect(placeholder.props.role).toBeUndefined();

      await settle();
      expect(roleRows()).toHaveLength(ROLES.length);
    });
  });

  describe("disclosure motion", () => {
    it("animates open/close, rotates the chevron, and honours reduced motion", () => {
      const cssText = css.dockCss;

      // Spatial continuity: the list extends downward out from under the header
      // by animating a grid track rather than teleporting into place.
      expect(cssText).toContain("grid-template-rows");
      expect(cssText).toContain('.rolebox-dock-disclosure[data-open="false"]');
      // The chevron states which way the control will move the surface.
      expect(cssText).toContain('.rolebox-dock-chevron[data-open="true"]');
      expect(cssText).toContain("rotate(180deg)");
      // Exits run faster than entrances so the UI is never held back.
      expect(cssText).toContain("--rolebox-dur-exit");
      // Every motion has a reduced-motion fallback.
      expect(cssText).toContain("@media (prefers-reduced-motion: reduce)");
      // Focus is deliberately instantaneous on both the header and the rows.
      expect(cssText).toContain(".rolebox-dock-header:focus-visible");
      expect(cssText).toContain(".rolebox-dock-row:focus-visible");

      // The chevron must not run AGAINST the disclosure it is paired with: the
      // closed state carries the exit duration, the open state the enter one.
      const chevronClosed =
        /\.rolebox-dock-chevron\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(chevronClosed).toContain("--rolebox-dur-exit");
      const chevronOpen =
        /\.rolebox-dock-chevron\[data-open="true"\]\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(chevronOpen).toContain("--rolebox-dur-base");

      // The sr-only seat must actually BE sr-only, not merely named so.
      const srBlock =
        /\.rolebox-dock-status-sr\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(srBlock).toContain("position: absolute");
      expect(srBlock).toContain("clip-path: inset(50%)");

      // ONE easing curve, the host's. An earlier invented pair made the opening
      // cover half its distance in the first fifth of its duration (which reads
      // as a stutter) and the closing hesitate through its first half.
      expect(cssText.match(/--rolebox-ease[a-z-]*:/g)).toEqual(["--rolebox-ease:"]);

      // Height and opacity must share a duration so the content finishes
      // appearing exactly when the box finishes revealing it. They used to
      // disagree (200ms of height against 130ms of opacity on open, and 160ms
      // against 90ms on close, so the content vanished half way through a close).
      const openBlock =
        /\.rolebox-dock-disclosure\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(openBlock).toContain("grid-template-rows var(--rolebox-dur-base");
      expect(openBlock).toContain("opacity var(--rolebox-dur-base");
      const closedBlock =
        /\.rolebox-dock-disclosure\[data-open="false"\]\s*\{([^}]*)\}/s.exec(cssText)?.[1] ?? "";
      expect(closedBlock).toContain("grid-template-rows var(--rolebox-dur-exit");
      expect(closedBlock).toContain("opacity var(--rolebox-dur-exit");

      // The collapsed subtree must skip its OWN layout: a 0fr grid track clips
      // and visibility: hidden skips paint, but neither skips layout, so the
      // invisible list was laid out on every pass. Guarded by @supports so a
      // browser without allow-discrete keeps the close animation.
      expect(cssText).toContain("@supports (transition-behavior: allow-discrete)");
      expect(cssText).toContain("content-visibility: hidden");
      expect(cssText).toContain("transition-behavior: normal, allow-discrete");
    });
  });
});
