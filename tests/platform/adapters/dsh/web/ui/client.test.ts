/** Browser plugin registration and lifecycle contracts. */

import { describe, it, expect, vi } from "vitest";

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

vi.doMock("react", reactDouble);
vi.doMock("react/jsx-runtime", jsxRuntimeDouble);
vi.doMock("react/jsx-dev-runtime", jsxRuntimeDouble);

// ── Module under test (dynamic import: mocks must precede the graph) ───────

const client = await import("../../../../../../src/platform/adapters/dsh/web/ui/client.ts");
const dock = await import("../../../../../../src/platform/adapters/dsh/web/ui/role-switch-dock.tsx");
const suggest = await import("../../../../../../src/platform/adapters/dsh/web/ui/suggest-dock.tsx");
const monitor = await import("../../../../../../src/platform/adapters/dsh/web/ui/rolebox-monitor-panel.tsx");
const logs = await import("../../../../../../src/platform/adapters/dsh/web/ui/rolebox-logs-panel.tsx");
const roles = await import("../../../../../../src/platform/adapters/dsh/web/ui/rolebox-roles-panel.tsx");
const toolRow = await import("../../../../../../src/platform/adapters/dsh/web/ui/tool-view-row.tsx");
const descriptors = await import("../../../../../../src/platform/adapters/dsh/web/ui/tool-view-descriptors.ts");
const toolLocales = await import("../../../../../../src/platform/adapters/dsh/web/ui/tool-view-locales.ts");
const suggestLocales = await import("../../../../../../src/platform/adapters/dsh/web/ui/suggest-locales.ts");

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

/** Fake `ctx.locale` double capturing namespace registrations and disposal. */
function createFakeLocale() {
  const registered: Array<{
    namespace: string;
    dictionaries: Record<string, Record<string, string>>;
  }> = [];
  let disposed = 0;
  const locale = {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>) {
      registered.push({ namespace, dictionaries });
      return () => {
        disposed += 1;
      };
    },
  };
  return { locale, registered, disposed: () => disposed };
}

/** A complete fake client context. */
function createFakeContext() {
  const slots = createFakeSlots();
  const locale = createFakeLocale();
  return { slots, locale };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("dsh web-UI client plugin entry", () => {
  it("exports the plugin metadata", () => {
    expect(client.name).toBe("rolebox");
    expect(client.inject).toEqual(["slots", "locale"]);
    expect(typeof client.apply).toBe("function");
    // object plugin shape (default export) carries the same metadata
    expect(client.default.name).toBe("rolebox");
    expect(client.default.inject).toEqual(["slots", "locale"]);
    expect(typeof client.default.apply).toBe("function");
  });

  it("registers the role chip in the composer tool row", () => {
    const { slots, injected, registered } = createFakeSlots();
    const locale = createFakeLocale();
    const disposer = client.apply({
      slots,
      locale: locale.locale,
    });

    // apply waits on every seat declaration; pick the role-chip one by key.
    // The seat is the composer tool row immediately LEFT of the model
    // selector — never the full-width strip above the composer.
    const chipInject = injected.find((i) => i.key === "conversation.input.right");
    expect(chipInject).toBeDefined();
    expect(client.DOCK_SLOT_NAME).toBe("conversation.input.right");

    // the injected callback performs the registration.
    chipInject!.callback();
    expect(registered).toHaveLength(1);

    const call = registered[0]!;
    expect(call.options.name).toBe("conversation.input.right");
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

  it("registers the draft suggestion button beside the role chip", () => {
    const { slots, injected, registered } = createFakeSlots();
    const locale = createFakeLocale();
    client.apply({ slots, locale: locale.locale });

    // TWO list entries in the same session-scoped composer seat: the role chip
    // and the draft-suggestion button, ordered chip-first.
    const seat = injected.filter((entry) => entry.key === client.DOCK_SLOT_NAME);
    expect(seat).toHaveLength(2);
    for (const entry of seat) entry.callback();
    expect(registered).toHaveLength(2);

    const chip = registered.find((call) => call.options.id === client.DOCK_SLOT_ID)!;
    expect(chip.options.order).toBe(client.DOCK_SLOT_ORDER);
    expect(chip.component).toBe(dock.RoleSwitchDock);

    expect(client.SUGGEST_SLOT_ID).toBe("rolebox-suggest");
    expect(client.SUGGEST_SLOT_ORDER).toBe(41);
    const suggestion = registered.find((call) => call.options.id === client.SUGGEST_SLOT_ID)!;
    expect(suggestion.options.name).toBe("conversation.input.right");
    expect(suggestion.options.order).toBe(41);
    // The pill declares its own copy namespace for the `t` seat.
    expect(suggestion.options.locale).toBe(suggestLocales.SUGGEST_NS);
    expect(suggestLocales.SUGGEST_NS).toBe("rolebox.suggest");
    expect(suggestion.component).toBe(suggest.SuggestDock);

    // Both entries receive the framework-resolved session id through the same
    // inject factory; the button derives running/draft from the standard seats.
    const face = suggestion.options.inject as (sessionId: string) => Record<string, unknown>;
    expect(face("sess-9")).toEqual({ sessionId: "sess-9" });
  });

  it("declares the same-origin copilot suggestion contract on the draft button", () => {
    expect(suggest.SUGGEST_ENDPOINT).toBe("/rolebox/copilot/suggest");
    expect(suggest.SUGGEST_DELAY_MS).toBe(300);
  });

  it("registers settings without the obsolete Sidebar shortcut", () => {
    const ctx = createFakeContext();
    client.apply({ slots: ctx.slots.slots, locale: ctx.locale.locale });
    ctx.slots.injected.find((entry) => entry.key === "settings.section")!.callback();
    expect(ctx.slots.registered[0]).toMatchObject({
      options: { name: "settings.section", id: "rolebox", order: 90, label: "Rolebox" },
      component: roles.RoleboxRolesPanel,
    });
    expect(ctx.slots.registered[0]!.options.inject).toBeUndefined();
  });

  it("places the original monitor and logs bodies in Conversation view tabs", () => {
    const ctx = createFakeContext();
    client.apply({ slots: ctx.slots.slots, locale: ctx.locale.locale });
    const views = ctx.slots.injected.filter((entry) => entry.key === "conversation.view");
    expect(views).toHaveLength(2);
    for (const entry of views) entry.callback();
    expect(ctx.slots.registered).toEqual([
      {
        options: { name: "conversation.view", id: "rolebox-monitor", order: 30, label: "Rolebox" },
        component: monitor.RoleboxMonitorPanel,
      },
      {
        options: { name: "conversation.view", id: "rolebox-logs", order: 40, label: "Logs" },
        component: logs.RoleboxLogsPanel,
      },
    ]);
    expect(ctx.slots.injected.some((entry) => entry.key.startsWith("sidebar."))).toBe(false);
  });

  it("declares the same-origin logs route on the log view panel", () => {
    expect(logs.LOGS_ENDPOINT).toBe("/rolebox/logs");
    expect(logs.POLL_MS).toBeGreaterThan(0);
    expect(logs.BUFFER_LIMIT).toBeGreaterThan(0);
  });

  it("tears down every declaration wait and the dictionaries", () => {
    const ctx = createFakeContext();
    const dispose = client.apply({ slots: ctx.slots.slots, locale: ctx.locale.locale }) as () => void;
    const waits = 5 + descriptors.ROLEBOX_TOOL_VIEW_NAMES.length;
    expect(ctx.slots.injected).toHaveLength(waits);
    dispose();
    expect(ctx.slots.injectedDisposers).toEqual(Array(waits).fill(1));
    // TWO locale registrations: the tool-view rows and the suggestion pill.
    expect(ctx.locale.disposed()).toBe(2);
  });

  it("registers one localized tool-call row per rolebox tool name", () => {
    const ctx = createFakeContext();
    client.apply({
      slots: ctx.slots.slots,
      locale: ctx.locale.locale,
    });

    // The dictionaries land in the namespace the rows declare as `locale`,
    // BEFORE the first row renders (a late dictionary would paint raw keys).
    expect(ctx.locale.registered).toHaveLength(2);
    const dictionaries = ctx.locale.registered.find(
      (registration) => registration.namespace === toolLocales.TOOL_VIEW_NS,
    )!;
    expect(dictionaries).toBeDefined();
    expect(dictionaries.namespace).toBe(toolLocales.TOOL_VIEW_NS);
    expect(Object.keys(dictionaries.dictionaries)).toEqual(["en", "zh"]);
    expect(dictionaries.dictionaries.en!["title.run"]).toBe("{verb} {noun}");
    expect(dictionaries.dictionaries.zh!["title.run"]).toBe("正在{verb}{noun}");
    expect(dictionaries.dictionaries.zh!["title.done"]).toBe("已{verb}{noun}");
    expect(dictionaries.dictionaries.zh!["verb.declare.run"]).toBe("声明");
    expect(dictionaries.dictionaries.zh!["noun.graph"]).toBe("图结构");
    expect(dictionaries.dictionaries.en!["noun.graph"]).toBe("graph");

    // The keyed slot dispatches by wire name, so every listed tool gets its
    // own injection and registers the shared row under that exact key.
    const toolInjections = ctx.slots.injected.filter(
      (entry) => entry.key === client.TOOL_VIEW_SLOT,
    );
    expect(toolInjections).toHaveLength(descriptors.ROLEBOX_TOOL_VIEW_NAMES.length);
    for (const injection of toolInjections) injection.callback();
    expect(ctx.slots.registered.map((call) => call.options.key))
      .toEqual([...descriptors.ROLEBOX_TOOL_VIEW_NAMES]);
    for (const call of ctx.slots.registered) {
      expect(call.options.name).toBe(client.TOOL_VIEW_SLOT);
      expect(call.options.locale).toBe(toolLocales.TOOL_VIEW_NS);
      expect(call.component).toBe(toolRow.RoleboxToolRow);
    }

    // Host-owned wire names keep the host card: rolebox must not replace the
    // host's web/session presentation for tools rolebox did not register.
    const names = descriptors.ROLEBOX_TOOL_VIEW_NAMES;
    expect(names).toContain("graph_declare");
    expect(names).toContain("team_send_event");
    expect(names).toContain("browse_open");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("session_search");
  });

  it("registers complete en/zh suggestion dictionaries for every copy key", () => {
    const ctx = createFakeContext();
    client.apply({ slots: ctx.slots.slots, locale: ctx.locale.locale });

    const registration = ctx.locale.registered.find(
      (entry) => entry.namespace === suggestLocales.SUGGEST_NS,
    );
    expect(registration).toBeDefined();
    expect(Object.keys(registration!.dictionaries)).toEqual(["en", "zh"]);
    expect(suggestLocales.SUGGEST_KEYS.length).toBeGreaterThan(0);
    for (const key of suggestLocales.SUGGEST_KEYS) {
      expect(registration!.dictionaries.en![key]).toEqual(expect.any(String));
      expect(registration!.dictionaries.zh![key]).toEqual(expect.any(String));
      expect(registration!.dictionaries.en![key]!.length).toBeGreaterThan(0);
      expect(registration!.dictionaries.zh![key]!.length).toBeGreaterThan(0);
    }
    // The key list is derived from the single copy table, so both languages
    // expose exactly the same keys.
    expect(Object.keys(registration!.dictionaries.en!)).toEqual([
      ...suggestLocales.SUGGEST_KEYS,
    ]);
    expect(Object.keys(registration!.dictionaries.zh!)).toEqual([
      ...suggestLocales.SUGGEST_KEYS,
    ]);
  });

  it("composes the running row title and argument line through the locale seat", () => {
    const calls: Array<{ key: string; params?: Record<string, unknown> }> = [];
    const t = (key: string, params?: Record<string, unknown>) => {
      calls.push({ key, ...(params === undefined ? {} : { params }) });
      return key;
    };
    const element = toolRow.RoleboxToolRow({
      callId: "call-1",
      toolName: "graph_declare",
      phase: "start",
      block: {
        argsRaw: JSON.stringify({
          declaration: { name: "build", nodes: [{ id: "a" }], edges: [] },
        }),
      },
      t,
    });

    // The row renders (no throw) and asks the seat for the running tense, the
    // descriptor's verb/noun, and the node-count unit.
    expect(element).toBeDefined();
    expect(calls).toContainEqual({ key: "verb.declare.run" });
    expect(calls).toContainEqual({ key: "noun.graph" });
    expect(calls.find((call) => call.key === "title.run")?.params).toEqual({
      verb: "verb.declare.run",
      noun: "noun.graph",
    });
    expect(calls).toContainEqual({ key: "count.nodes", params: { n: 1 } });
  });

  it("keeps the views when a sibling contribution fails", () => {
    const ctx = createFakeContext();
    const inject = ctx.slots.slots.inject;
    ctx.slots.slots.inject = (key, callback) => {
      if (key === "settings.section") throw new Error("settings unavailable");
      return inject(key, callback);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dispose = client.apply({ slots: ctx.slots.slots, locale: ctx.locale.locale });
      for (const view of ctx.slots.injected.filter((entry) => entry.key === "conversation.view")) view.callback();
      expect(ctx.slots.registered.map((entry) => entry.options.id)).toEqual([client.MONITOR_VIEW_ID, client.LOGS_VIEW_ID]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("settings unavailable"));
      dispose!();
    } finally { warn.mockRestore(); }
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
