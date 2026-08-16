/// <reference types="bun-types" />

/**
 * dsh web-UI client plugin tests — the browser half of the web-UI slot
 * integration (`src/platform/adapters/dsh/web-ui/`).
 *
 * The plugin's `apply(ctx)` is exercised against a fake `ctx.slots` double
 * (platform-test convention: structural fakes, no `@deepseek-ai/*` imports).
 * Verifies:
 *   - the plugin entry metadata: `name === 'rolebox'`, `inject === ['slots']`,
 *     `apply` is a function (and the default object export carries them)
 *   - `apply` wires the canonical TodoDock posture: `ctx.slots.inject` is
 *     called with `'conversation.input.dock'`, and the injected callback
 *     performs the `ctx.slots.register` call
 *   - the registration options: `name: 'conversation.input.dock'`,
 *     `id: 'rolebox'`, `order: 40`, `locale: 'conversation'`, an inject
 *     factory resolving the session-scoped session id into `{ sessionId }`
 *   - the registered component is the `RoleSwitchDock` component and the
 *     disposer returned by `apply` is a function (fiber cleanup)
 *   - the dock module's same-origin API contract (`GET /rolebox/roles`,
 *     `POST /rolebox/roles/switch`)
 *
 * React is not installed yet (subtask 3 adds the devDeps) — the `react`
 * module surface (and the JSX runtime the transpiler emits for the .tsx
 * component) is stubbed via `mock.module` BEFORE the client entry is
 * imported, so the component module loads without a react install.
 *
 * @module
 */

import { describe, it, expect, mock } from "bun:test";

// ── React surface stubs (subtask 3 installs the real devDeps) ──────────────

/** Minimal react runtime double — just enough for the module to load. */
function reactDouble() {
  return {
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => {},
    ],
    useEffect: () => {},
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

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Record of one `slots.register` call. */
interface RegisterCall {
  options: Record<string, unknown>;
  component: unknown;
}

/** Fake `ctx.slots` double capturing inject/register calls. */
function createFakeSlots() {
  const injected: Array<{ key: string; callback: () => unknown }> = [];
  const registered: RegisterCall[] = [];
  const slots = {
    inject(key: string, callback: () => unknown) {
      injected.push({ key, callback });
      return () => {
        /* disposer: no-op */
      };
    },
    register(options: unknown, component: unknown) {
      registered.push({
        options: (options ?? {}) as Record<string, unknown>,
        component,
      });
      return () => {
        /* disposer: no-op */
      };
    },
  };
  return { slots, injected, registered };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("dsh web-UI client plugin entry", () => {
  it("exports the plugin metadata", () => {
    expect(client.name).toBe("rolebox");
    // The client cordis enforces inject-gated service access: reading
    // `ctx.slots` in apply() requires declaring it ("cannot get property
    // 'slots' without inject" otherwise) — mirrors dsh-client-ui-conversation.
    expect(client.inject).toEqual(["slots"]);
    expect(typeof client.apply).toBe("function");
    // object plugin shape (default export) carries the same metadata
    expect(client.default.name).toBe("rolebox");
    expect(client.default.inject).toEqual(["slots"]);
    expect(typeof client.default.apply).toBe("function");
  });

  it("wires the canonical input-dock registration through ctx.slots", () => {
    const { slots, injected, registered } = createFakeSlots();
    const disposer = client.apply({ slots });

    // apply waits on the input-dock declaration (TodoDock posture).
    expect(injected).toHaveLength(1);
    expect(injected[0]!.key).toBe("conversation.input.dock");

    // the injected callback performs the registration.
    injected[0]!.callback();
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

  it("declares the same-origin rolebox API contract on the dock module", () => {
    expect(dock.ROLES_ENDPOINT).toBe("/rolebox/roles");
    expect(dock.ACTIVE_ENDPOINT).toBe("/rolebox/roles/active");
    expect(dock.SWITCH_ENDPOINT).toBe("/rolebox/roles/switch");
    expect(dock.CLEAR_ENDPOINT).toBe("/rolebox/roles/active");
    expect(dock.ROLE_DATALIST_ID).toBe("rolebox-role-list");
  });
});
