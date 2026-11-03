/** Browser plugin: session views, role settings, composer chip and tool rows. */

import { RoleSwitchDock } from "./role-switch-dock.tsx";
import type { RoleSwitchDockProps } from "./role-switch-dock.tsx";
import { RoleboxLogsPanel } from "./rolebox-logs-panel.tsx";
import { RoleboxMonitorPanel } from "./rolebox-monitor-panel.tsx";
import { RoleboxRolesPanel } from "./rolebox-roles-panel.tsx";
import type { RoleboxRolesPanelProps } from "./rolebox-roles-panel.tsx";
import { RoleboxToolRow } from "./tool-view-row.tsx";
import { ROLEBOX_TOOL_VIEW_NAMES } from "./tool-view-descriptors.ts";
import { TOOL_VIEW_NS, en as toolViewEn, zh as toolViewZh } from "./tool-view-locales.ts";

// ── Plugin metadata ────────────────────────────────────────────────────────

/** Plugin name — the dsh client plugin identity (matches the host plugin). */
export const name = "rolebox";

export const inject: string[] = ["slots", "locale"];

/** The keyed per-tool transcript-view seat (declared by dsh-client-ui-tool). */
export const TOOL_VIEW_SLOT = "tool.call.toolview";

/** The slot this plugin contributes into (composer tool row, left of the model selector). */
export const DOCK_SLOT_NAME = "conversation.input.right";

/** List-entry id within that seat (list-kind slots key entries by `id`). */
export const DOCK_SLOT_ID = "rolebox";

/** List position within the seat — rolebox is its only occupant today. */
export const DOCK_SLOT_ORDER = 40;

/** Locale namespace declared by the entry (dsh-client-ui-conversation). */
export const DOCK_LOCALE = "conversation";

/** The settings page slot this plugin contributes into (one page per feature). */
export const SETTINGS_SLOT_NAME = "settings.section";

/** Section key within settings.section (drives the `only` filtering). */
export const SETTINGS_SLOT_ID = "rolebox";

/** Nav position — after the stock feature pages (late order keeps it near the end). */
export const SETTINGS_SLOT_ORDER = 90;

/** Nav display text (registrant-localized label rendered by the shell). */
export const SETTINGS_SLOT_LABEL = "Rolebox";

/** Session views follow the host's Chat and Trajectory entries. */
export const CONVERSATION_VIEW_SLOT = "conversation.view";
export const MONITOR_VIEW_ID = "rolebox-monitor";
export const MONITOR_VIEW_ORDER = 30;
export const MONITOR_VIEW_LABEL = "Rolebox";
export const LOGS_VIEW_ID = "rolebox-logs";
export const LOGS_VIEW_ORDER = 40;
export const LOGS_VIEW_LABEL = "Logs";

// ── Structural slot contract (duck of @deepseek-ai/dsh-client-ui-slots) ────

/**
 * Structural register options — duck of the dsh-client-ui-slots
 * `BaseOptions` / `StoredEntry.options` surface (lib/types/index.d.ts:402-445).
 * `inject` mirrors the stored form `((...args: never[]) => Record<string,
 * unknown>)` (line 436); the `name` key is the target slot.
 */
export interface DshSlotRegisterOptions {
  /** Target slot key (this entry contributes INTO this slot). */
  name: string;
  /** List-kind entry id (kind `list`). */
  id?: string;
  /** List-kind position (ascending; ties keep registration order). */
  order?: number;
  /** List-kind display label (string or per-read thunk). */
  label?: string | (() => string);
  /** Declared dictionary namespace (puts the `t` seat on the component). */
  locale?: string;
  /** Registrant business face factory; params derive from the slot scope. */
  inject?: (...args: never[]) => Record<string, unknown>;
  /** Child-slot declaration + render authorization table. */
  children?: unknown;
  /** Store seat (shared handle or exclusive factory). */
  store?: unknown;
  /** Diagnostics label of who registered. */
  registrant?: string;
  /** Chain-kind routing selector. */
  select?: (owner: never) => unknown;
  /** Chain-kind position. */
  priority?: number;
  /** Keyed-kind dispatch key. */
  key?: string;
}

/**
 * Structural slot-registry service — duck of the dsh-client-ui-slots
 * `SlotRegistry` surface (lib/types/index.d.ts:46-91), restricted to
 * the two members this plugin consumes. The register component is typed
 * `(props: never) => unknown` (the real `SlotComponent<P>` shape,
 * lib/types/index.d.ts:310); the never-param keeps assignment checkable
 * through parameter contravariance exactly like the real contract.
 */
export interface DshSlotsService {
  /**
   * Install an effect for each declaration lifetime of a slot (runs the
   * callback synchronously when the declaration exists, or inside the
   * declaring `register()` call). Returns an idempotent disposer.
   */
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void;
  /**
   * Contribute a component to a declared slot. Returns the disposer that
   * removes the contribution (and collapses any declared child slots).
   */
  register(
    options: DshSlotRegisterOptions,
    component: (props: never) => unknown,
  ): () => void;
}

/**
 * Structural locale registry — duck of `@deepseek-ai/dsh-client-locale`'s
 * `LocaleRuntime.register(ns, localeOrDicts, dict?)`
 * (packages/client/locale/src/client/index.ts:403-404), restricted to the one
 * overload this plugin uses. `en` is the registry's fallback locale, so a
 * namespace registering only `en` + `zh` still resolves every key in `ja`,
 * `es`, `fr`, … through the per-key fallback chain.
 */
export interface DshLocaleService {
  /**
   * Register one namespace's dictionaries for the caller's lifetime.
   * @param namespace - the namespace a slot entry declares as its `locale`.
   * @param dictionaries - locale id → flat key/value dictionary.
   * @returns the idempotent disposer that unregisters the namespace.
   */
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
}

export interface DshClientContext {
  slots: DshSlotsService;
  locale: DshLocaleService;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── apply ──────────────────────────────────────────────────────────────────

/** Register each contribution for its declaration lifetime. */
export function apply(ctx: DshClientContext): (() => void) | void {
  const disposers: Array<() => void> = [];

  const contribute = (label: string, install: () => (() => void) | void): void => {
    try {
      const dispose = install();
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (err) {
      // Browser code with no logger seat on the structural ctx: the console is
      // the only channel, and staying silent here is exactly what turns a
      // failed registration into an unexplained empty panel. The platform kernel
      // cannot take its place: src/log/context.ts imports node:async_hooks,
      // which this bundle's browser target stubs to an empty module, so
      // `new AsyncLocalStorage` throws while the bundle is evaluated. This call
      // is therefore the one documented exemption in
      // scripts/check-logging-boundaries.ts.
      console.warn("[rolebox] " + label + " did not register: " + toMessage(err));
    }
  };

  contribute("role switch chip", () =>
    ctx.slots.inject(DOCK_SLOT_NAME, () =>
      ctx.slots.register(
        {
          name: DOCK_SLOT_NAME,
          id: DOCK_SLOT_ID,
          order: DOCK_SLOT_ORDER,
          locale: DOCK_LOCALE,
          inject: (sessionId: string) => ({ sessionId }),
        },
        RoleSwitchDock,
      ),
    ),
  );

  contribute("Rolebox settings page", () =>
    ctx.slots.inject(SETTINGS_SLOT_NAME, () =>
      ctx.slots.register(
        {
          name: SETTINGS_SLOT_NAME,
          id: SETTINGS_SLOT_ID,
          order: SETTINGS_SLOT_ORDER,
          label: SETTINGS_SLOT_LABEL,
        },
        RoleboxRolesPanel,
      ),
    ),
  );

  contribute("monitor conversation view", () =>
    ctx.slots.inject(CONVERSATION_VIEW_SLOT, () =>
      ctx.slots.register(
        { name: CONVERSATION_VIEW_SLOT, id: MONITOR_VIEW_ID, order: MONITOR_VIEW_ORDER, label: MONITOR_VIEW_LABEL },
        RoleboxMonitorPanel,
      ),
    ),
  );

  contribute("logs conversation view", () =>
    ctx.slots.inject(CONVERSATION_VIEW_SLOT, () =>
      ctx.slots.register(
        { name: CONVERSATION_VIEW_SLOT, id: LOGS_VIEW_ID, order: LOGS_VIEW_ORDER, label: LOGS_VIEW_LABEL },
        RoleboxLogsPanel,
      ),
    ),
  );

  // ── Rolebox Tool-call rows (`tool.call.toolview`) ──────────────────────
  //
  // ONE registration per rolebox wire tool name — the keyed slot dispatches by
  // name and has no prefix routing. The dictionaries are registered FIRST: the
  // row's `t` seat resolves against this namespace, and a late dictionary would
  // render raw `verb.declare.run` keys during the first paint.
  //
  // The namespace carries `en` (the registry fallback) and `zh`; every other
  // installed language resolves per key through its fallback chain, which is
  // why the rows follow whichever locale the user picked in dsh Settings.
  //
  // A host WITHOUT the ui-tool package never declares `tool.call.toolview`, so
  // the injection callback never runs and the transcript keeps the host's
  // generic row — the same graceful degradation every other contribution has.
  contribute("tool view dictionaries", () =>
    ctx.locale.register(TOOL_VIEW_NS, { en: toolViewEn, zh: toolViewZh }),
  );

  contribute("tool call rows", () => {
    const registered = ROLEBOX_TOOL_VIEW_NAMES.map(toolName =>
      ctx.slots.inject(TOOL_VIEW_SLOT, () =>
        ctx.slots.register(
          {
            name: TOOL_VIEW_SLOT,
            key: toolName,
            locale: TOOL_VIEW_NS,
          },
          RoleboxToolRow,
        ),
      ),
    );
    return () => {
      for (const dispose of registered) dispose();
    };
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}

// ── Default export (object plugin shape) ───────────────────────────────────

/**
 * Default export — the object plugin shape `{ name, inject, apply }`
 * (cordis `Plugin.Object`, the shape the web app's plugin loader consumes;
 * the named exports above are also provided for direct import).
 */
export default {
  name,
  inject,
  apply,
};

// Type-only re-exports: the role chip's and the roles page's composed props for
// consumers wiring the entry (e.g. the slot-contract mirror in tests).
export type { RoleSwitchDockProps, RoleboxRolesPanelProps };
