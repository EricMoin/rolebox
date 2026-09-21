/// <reference types="bun-types" />

/**
 * dsh web-UI client plugin tests — the browser half of the web-UI slot
 * integration (`src/platform/adapters/dsh/web-ui/`).
 *
 * The plugin's `apply(ctx)` is exercised against fake `ctx.slots` /
 * `ctx.sidebarRightTabs` / `ctx.sidebarRight` doubles (platform-test
 * convention: structural fakes, no `@deepseek-ai/*` imports). Verifies:
 *   - the plugin entry metadata: `name === 'rolebox'`,
 *     `inject === ['slots', 'sidebarRightTabs', 'sidebarRight']`, `apply` is a
 *     function (and the default object export carries them)
 *   - the UNCHANGED dock contribution: `ctx.slots.inject` is called with
 *     `'conversation.input.dock'`, and the injected callback registers
 *     `{ name, id: 'rolebox', order: 40, locale: 'conversation' }` with the
 *     session-scoped inject factory resolving `{ sessionId }`
 *   - the settings contribution: `'settings.section'` is injected, and its
 *     callback registers `RoleboxRolesPanel` with `name`, `id: 'rolebox'`,
 *     `order: 90`, `label: 'Rolebox'` and an inject face exposing
 *     `openMonitor` — which opens the monitoring tab kind through
 *     `ctx.sidebarRight.openTab` and returns `null` (or a message when the
 *     face throws)
 *   - the right-Sidebar tab TYPE: `ctx.sidebarRightTabs.register` receives
 *     `{ id, kind, title, guide }` with no `patterns` (a page type), and the
 *     guide entry names loops / engine graphs / metrics / sessions
 *   - the right-Sidebar tab BODY: `'sidebar.right.pane.tab'` is injected and
 *     its callback registers `RoleboxMonitorPanel` keyed by the tab id
 *   - the returned disposer tears down every registration (the three
 *     injection effects and the tab-type registration)
 *   - the dock module's same-origin API contract (`GET /rolebox/roles`,
 *     `POST /rolebox/roles/switch`)
 *
 * React is not installed yet (subtask 3 adds the devDeps) — the `react`
 * module surface (and the JSX runtime the transpiler emits for the .tsx
 * components) is stubbed via `mock.module` BEFORE the client entry is
 * imported, so the component modules load without a react install.
 *
 * @module
 */

import { describe, it, expect, mock } from "bun:test";

// ── React surface stubs (subtask 3 installs the real devDeps) ──────────────

/** Minimal react runtime double — just enough for the modules to load. */
function reactDouble() {
  return {
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => {},
    ],
    useEffect: () => {},
    // The dock holds one ref (focus restoration after a collapsing switch),
    // so this double must expose the same surface the component imports.
    useRef: (initial: unknown) => ({ current: initial }),
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    Fragment: Symbol.for("react.fragment"),
  };
}

/** Minimal JSX runtime double (jsx / jsxs / jsxDEV element factories). */
function jsxRuntimeDouble() {
  return {
    jsx: (type: unknown, props: unknown) => ({ type, props }),
    jsxs: (type: unknown, props: unknown) => ({ type, props }),
    jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
    Fragment: Symbol.for("react.fragment"),
  };
}

mock.module("react", reactDouble);
mock.module("react/jsx-runtime", jsxRuntimeDouble);
mock.module("react/jsx-dev-runtime", jsxRuntimeDouble);

// ── Module under test (dynamic import: mocks must precede the graph) ───────

const client = await import("../../src/platform/adapters/dsh/web-ui/client.ts");
const dock = await import("../../src/platform/adapters/dsh/web-ui/role-switch-dock.tsx");
const monitor = await import("../../src/platform/adapters/dsh/web-ui/rolebox-monitor-panel.tsx");
const roles = await import("../../src/platform/adapters/dsh/web-ui/rolebox-roles-panel.tsx");

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Record of one `slots.register` call. */
interface RegisterCall {
  options: Record<string, unknown>;
  component: unknown;
}

/** Fake `ctx.slots` double capturing inject/register calls and disposals. */
function createFakeSlots() {
  const injected: Array<{ key: string; callback: () => unknown }> = [];
  const registered: RegisterCall[] = [];
  const injectedDisposers: number[] = [];
  const slots = {
    inject(key: string, callback: () => unknown) {
      injected.push({ key, callback });
      const index = injectedDisposers.length;
      injectedDisposers.push(0);
      return () => {
        injectedDisposers[index] = (injectedDisposers[index] ?? 0) + 1;
      };
    },
    register(options: unknown, component: unknown) {
      registered.push({
        options: (options ?? {}) as Record<string, unknown>,
        component,
      });
      return () => {
        /* disposer: no-op (the inject effect owns it in the real registry) */
      };
    },
  };
  return { slots, injected, registered, injectedDisposers };
}

/** Fake `ctx.sidebarRightTabs` double capturing the registered tab type. */
function createFakeSidebarRightTabs() {
  const registered: Array<Record<string, unknown>> = [];
  let disposed = 0;
  const sidebarRightTabs = {
    register(definition: unknown) {
      registered.push((definition ?? {}) as Record<string, unknown>);
      return () => {
        disposed += 1;
      };
    },
  };
  return { sidebarRightTabs, registered, disposed: () => disposed };
}

/** Fake `ctx.sidebarRight` double recording `openTab` kinds. */
function createFakeSidebarRight() {
  const opened: string[] = [];
  let failure: Error | null = null;
  const sidebarRight = {
    openTab(kind: string) {
      if (failure !== null) throw failure;
      opened.push(kind);
    },
  };
  return {
    sidebarRight,
    opened,
    failWith(error: Error) {
      failure = error;
    },
  };
}

/** A complete fake client context. */
function createFakeContext() {
  const slots = createFakeSlots();
  const tabs = createFakeSidebarRightTabs();
  const right = createFakeSidebarRight();
  return { slots, tabs, right };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("dsh web-UI client plugin entry", () => {
  it("exports the plugin metadata", () => {
    expect(client.name).toBe("rolebox");
    // The client cordis enforces inject-gated service access: reading
    // `ctx.slots` / `ctx.sidebarRight*` in apply() requires declaring them
    // ("cannot get property ... without inject" otherwise) — mirrors
    // dsh-client-ui-plan's roster.
    expect(client.inject).toEqual(["slots", "sidebarRightTabs", "sidebarRight"]);
    expect(typeof client.apply).toBe("function");
    // object plugin shape (default export) carries the same metadata
    expect(client.default.name).toBe("rolebox");
    expect(client.default.inject).toEqual(["slots", "sidebarRightTabs", "sidebarRight"]);
    expect(typeof client.default.apply).toBe("function");
  });

  it("keeps the canonical input-dock registration unchanged", () => {
    const { slots, injected, registered } = createFakeSlots();
    const tabs = createFakeSidebarRightTabs();
    const right = createFakeSidebarRight();
    const disposer = client.apply({
      slots,
      sidebarRightTabs: tabs.sidebarRightTabs,
      sidebarRight: right.sidebarRight,
    });

    // apply waits on every seat declaration; pick the dock one by key.
    const dockInject = injected.find((i) => i.key === "conversation.input.dock");
    expect(dockInject).toBeDefined();

    // the injected callback performs the registration.
    dockInject!.callback();
    expect(registered).toHaveLength(1);

    const call = registered[0]!;
    expect(call.options.name).toBe("conversation.input.dock");
    expect(call.options.id).toBe("rolebox");
    expect(call.options.order).toBe(40);
    expect(call.options.locale).toBe("conversation");

    // the registered component is the RoleSwitchDock component.
    expect(call.component).toBe(dock.RoleSwitchDock);

    // the inject factory resolves the session-scoped session id.
    const face = call.options.inject as (sessionId: string) => Record<string, unknown>;
    expect(typeof face).toBe("function");
    expect(face("sess-1")).toEqual({ sessionId: "sess-1" });

    // apply returns the fiber disposer (a function) for cleanup.
    expect(typeof disposer).toBe("function");
  });

  it("registers the Rolebox settings page with an openMonitor inject face", () => {
    const ctx = createFakeContext();
    const disposer = client.apply({
      slots: ctx.slots.slots,
      sidebarRightTabs: ctx.tabs.sidebarRightTabs,
      sidebarRight: ctx.right.sidebarRight,
    });

    const settingsInject = ctx.slots.injected.find((i) => i.key === "settings.section");
    expect(settingsInject).toBeDefined();
    settingsInject!.callback();
    expect(ctx.slots.registered).toHaveLength(1);

    const call = ctx.slots.registered[0]!;
    expect(call.options.name).toBe("settings.section");
    expect(call.options.id).toBe("rolebox");
    expect(call.options.order).toBe(90);
    expect(call.options.label).toBe("Rolebox");
    expect(call.component).toBe(roles.RoleboxRolesPanel);

    // scope 'root' slot: the inject face takes no session id and exposes the
    // tab-opening business face the page's "Open monitor" control consumes.
    const face = call.options.inject as () => { openMonitor: () => string | null };
    expect(typeof face).toBe("function");
    const business = face();
    expect(typeof business.openMonitor).toBe("function");
    expect(business.openMonitor()).toBeNull();
    expect(ctx.right.opened).toEqual([client.MONITOR_TAB_KIND]);

    // A host without a mounted session surface throws; the face converts that
    // into a user-facing line instead of letting it escape the click handler.
    ctx.right.failWith(new Error("sidebarRight: no session surface is mounted"));
    const failure = business.openMonitor();
    expect(typeof failure).toBe("string");
    expect(failure).toContain("no session surface is mounted");

    expect(typeof disposer).toBe("function");
  });

  it("registers the right-Sidebar monitoring tab type with a guide entry", () => {
    const ctx = createFakeContext();
    client.apply({
      slots: ctx.slots.slots,
      sidebarRightTabs: ctx.tabs.sidebarRightTabs,
      sidebarRight: ctx.right.sidebarRight,
    });

    // The type is registered eagerly (not declaration-waited): the page type
    // must exist before any openTab call can name its kind.
    expect(ctx.tabs.registered).toHaveLength(1);
    const definition = ctx.tabs.registered[0]!;
    expect(definition.id).toBe("rolebox-monitor");
    expect(definition.kind).toBe("rolebox-monitor");
    // A page type: no resource globs.
    expect(definition.patterns).toBeUndefined();
    const title = definition.title as (address: string) => string;
    expect(typeof title).toBe("function");
    expect(title("")).toBe("Rolebox");

    const guide = definition.guide as Array<Record<string, unknown>>;
    expect(guide).toHaveLength(1);
    const entry = guide[0]!;
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.order).toBe("number");
    expect((entry.title as () => string)()).toBe("Rolebox");
    const description = (entry.description as () => string)();
    for (const word of ["loops", "engine graphs", "metrics", "sessions"]) {
      expect(description.toLowerCase()).toContain(word);
    }
  });

  it("registers the monitoring tab body keyed by the tab id", () => {
    const ctx = createFakeContext();
    client.apply({
      slots: ctx.slots.slots,
      sidebarRightTabs: ctx.tabs.sidebarRightTabs,
      sidebarRight: ctx.right.sidebarRight,
    });

    const bodyInject = ctx.slots.injected.find((i) => i.key === "sidebar.right.pane.tab");
    expect(bodyInject).toBeDefined();
    bodyInject!.callback();
    expect(ctx.slots.registered).toHaveLength(1);

    const call = ctx.slots.registered[0]!;
    expect(call.options.name).toBe("sidebar.right.pane.tab");
    // The keyed seat dispatches on the tab type's implementation id.
    expect(call.options.key).toBe("rolebox-monitor");
    expect(call.component).toBe(monitor.RoleboxMonitorPanel);
    // A page body needs none of the tab runtime props and no locale: no
    // inject face is declared for it.
    expect(call.options.inject).toBeUndefined();
    expect(call.options.locale).toBeUndefined();
  });

  it("tears down every registration through the returned disposer", () => {
    const ctx = createFakeContext();
    const disposer = client.apply({
      slots: ctx.slots.slots,
      sidebarRightTabs: ctx.tabs.sidebarRightTabs,
      sidebarRight: ctx.right.sidebarRight,
    }) as () => void;

    // Three declaration waits (dock, settings, tab body) + the tab type.
    expect(ctx.slots.injected).toHaveLength(3);
    expect(ctx.tabs.registered).toHaveLength(1);
    expect(ctx.slots.injectedDisposers).toEqual([0, 0, 0]);
    expect(ctx.tabs.disposed()).toBe(0);

    disposer();
    expect(ctx.slots.injectedDisposers).toEqual([1, 1, 1]);
    expect(ctx.tabs.disposed()).toBe(1);
  });

  it("keeps the tab body registered when a sibling contribution fails", () => {
    // A duplicate id/kind throws out of `sidebarRightTabs.register`
    // (tab-registry.ts:235-247), which a double activation produces on its own.
    // If that throw escaped `apply`, the LATER body registration would never
    // run and a tab that is already open would render the host's
    // "这类内容还没有可用的查看方式。" notice with nothing to explain it.
    const ctx = createFakeContext();
    ctx.tabs.sidebarRightTabs.register = () => {
      throw new Error('sidebarRight: tab type id "rolebox-monitor" is taken');
    };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const disposer = client.apply({
        slots: ctx.slots.slots,
        sidebarRightTabs: ctx.tabs.sidebarRightTabs,
        sidebarRight: ctx.right.sidebarRight,
      });

      // Every declaration-waited contribution is still installed.
      for (const key of [
        "conversation.input.dock",
        "settings.section",
        "sidebar.right.pane.tab",
      ]) {
        expect(ctx.slots.injected.some((entry) => entry.key === key)).toBe(true);
      }

      // …and the tab body actually registers when its seat is declared.
      const bodyInject = ctx.slots.injected.find(
        (entry) => entry.key === "sidebar.right.pane.tab",
      )!;
      bodyInject.callback();
      const body = ctx.slots.registered.find(
        (call) => call.options.name === "sidebar.right.pane.tab",
      );
      expect(body).toBeDefined();
      expect(body!.options.key).toBe("rolebox-monitor");
      expect(body!.component).toBe(monitor.RoleboxMonitorPanel);

      // The failure is reported rather than swallowed, and the fiber still
      // returns a disposer that tears down what DID register.
      expect(warnings.some((line) => line.includes("monitor tab type"))).toBe(true);
      expect(typeof disposer).toBe("function");
      disposer!();
      expect(ctx.slots.injectedDisposers.some((count) => count > 0)).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  it("declares the same-origin rolebox API contract on the dock module", () => {
    expect(dock.ROLES_ENDPOINT).toBe("/rolebox/roles");
    expect(dock.ACTIVE_ENDPOINT).toBe("/rolebox/roles/active");
    expect(dock.SWITCH_ENDPOINT).toBe("/rolebox/roles/switch");
    expect(dock.CLEAR_ENDPOINT).toBe("/rolebox/roles/active");
    expect(dock.ROLE_DATALIST_ID).toBe("rolebox-role-list");
  });

  it("declares the same-origin roles/reload contract on the settings page", () => {
    expect(roles.ROLES_ENDPOINT).toBe("/rolebox/roles");
    expect(roles.RELOAD_ENDPOINT).toBe("/rolebox/reload");
  });
});
