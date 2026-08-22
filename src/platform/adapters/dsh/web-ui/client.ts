/**
 * dsh web-UI slot plugin — browser half (`src/platform/adapters/dsh/web-ui/client.ts`)
 *
 * This module is the client entry of the rolebox web-UI slot integration: a
 * dsh client plugin that contributes two components to the dsh web app:
 *
 *   - {@link RoleSwitchDock} → the `'conversation.input.dock'` slot (the
 *     list/session-scoped full-width row above the composer card);
 *   - {@link RoleboxMonitorPanel} → the `'settings.section'` slot (the
 *     list/root-scoped settings page showing the live rolebox engine state).
 *
 * Each contribution follows the same posture (see below); the sections that
 * follow document the two slot contracts and the graceful-degradation rule
 * that keeps the plugin healthy when a declaration is absent.
 *
 * ── Plugin shape ──────────────────────────────────────────────────────────
 * The export mirrors the canonical registrant-plugin posture of
 * `@deepseek-ai/dsh-client-ui-conversation`'s TodoDock entry (lib/client.js
 * lines 6303-6312 of the 0.1.0-rc.6 artifact):
 *
 *     ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
 *       name: "conversation.input.dock",
 *       id: "todo",
 *       order: 0,
 *       locale: NS,
 *     }, TodoDock));
 *
 * i.e. `{ name, inject, apply(ctx) }` where `apply` waits on the input-dock
 * declaration (`ctx.slots.inject`) and registers the component inside the
 * injection callback (`ctx.slots.register`), so the entry follows the slot
 * declaration across independent activation and reload. The `'conversation.input.dock'`
 * slot is declared by `@deepseek-ai/dsh-client-ui-conversation` as
 * `{ kind: 'list', scope: 'session', owner: InputZone }`
 * (lib/types/client/contract/slots.d.ts:190-194). The inject factory
 * signature derives from `InjectParams` for a `scope: 'session'` slot —
 * `(sessionId) => ({ sessionId })` (dsh-client-ui-slots
 * lib/types/index.d.ts:367) — delivering the framework-resolved session id
 * to the component for the switch request.
 *
 * ── The `settings.section` contribution ────────────────────────────────────
 * The monitor panel is contributed to the `'settings.section'` slot — one
 * settings page per list entry — declared by
 * `@deepseek-ai/dsh-client-ui-settings` as
 * `{ kind: 'list', scope: 'root', owner: SettingsSectionOwnerProps }`
 * (lib/types/client/contract/slots.d.ts:67-71). The owner share is
 * `{ close: () => void }` (SettingsSectionOwnerProps, slots.d.ts:148-151) —
 * the shell hands the section a `close` handle (closes the settings panel)
 * and renders the contribution inside the panel content column. Registrant
 * options carry the nav identity: `id` (section key, drives `only`
 * filtering), `order` (nav position), `label` (registrant-localized display
 * text). Because the slot is `scope: 'root'` (not `'session'`), the entry
 * needs no inject factory — the register options carry no `inject` face and
 * the component receives the owner share directly.
 *
 * ── Graceful degradation ───────────────────────────────────────────────────
 * `ctx.slots.inject` installs an effect per declaration lifetime: the
 * callback runs synchronously when the declaration already exists, or inside
 * the declaring `register()` call otherwise (dsh-client-runtime
 * lib/client.js:55, slots.d.ts:46-91). If a slot is never declared — e.g.
 * the settings shell (`sidebar.settings` owner in ui-settings-general) does
 * not activate — the corresponding injection callback simply never runs:
 * the contribution does not mount, `apply` still returns a disposer, and
 * the plugin remains healthy. The two contributions are independent: the
 * dock still mounts even when the settings surface is absent, and vice
 * versa.
 *
 * ── Structural typing (duck types) ────────────────────────────────────────
 * `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-slots` are
 * installed as devDeps for type/tests, but following the repo's dsh
 * convention ("The dsh surface is consumed structurally — this module does
 * NOT import `@deepseek-ai/*`", cf. web-role-switch-route.ts:13), the
 * slots service surface and the client context are duck-typed against the
 * observed `.d.ts` shapes:
 *
 *   - `ctx.slots`   — `SlotRegistry` (dsh-client-runtime
 *                     lib/types/client/slots.d.ts:46-91): `inject(key,
 *                     callback)` (line 90) + `register(options, component)`
 *                     (line 74, reusing `SlotCore.register`).
 *   - `register` options — `BaseOptions` / `StoredEntry.options`
 *                     (dsh-client-ui-slots lib/types/index.d.ts:402-445):
 *                     name / id / order / label / locale / inject / children /
 *                     store / registrant.
 *   - component     — `SlotComponent<P> = (props: P) => ReactNode`
 *                     (dsh-client-ui-slots lib/types/index.d.ts:310); the
 *                     return type is structurally `unknown` here (the
 *                     temporary `react.stub.d.ts` covers react's type
 *                     surface for the bundler, which keeps `react` external).
 *
 * Browser constraint: this module runs in the dsh web app — no node builtins.
 *
 * @module
 */

import { RoleSwitchDock } from "./role-switch-dock.tsx";
import type { RoleSwitchDockProps } from "./role-switch-dock.tsx";
import { RoleboxMonitorPanel } from "./rolebox-monitor-panel.tsx";

// ── Plugin metadata ────────────────────────────────────────────────────────

/** Plugin name — the dsh client plugin identity (matches the host plugin). */
export const name = "rolebox";

/**
 * dsh client services this plugin waits for (the cordis plugin-object
 * `inject`, NOT package.json's `dsh.client.inject` module edges). The client
 * cordis enforces inject-gated service access — reading `ctx.slots` without
 * declaring it here fails the fiber with `cannot get property "slots"
 * without inject`. This mirrors dsh's own slot registrants (e.g.
 * @deepseek-ai/dsh-client-ui-conversation lib/client.js:9401 declares
 * `["slots", ...]`); declaring the service also delays activation until the
 * client runtime has provided the slot registry.
 */
export const inject: string[] = ["slots"];

/** The slot this plugin contributes into (the input dock above the composer). */
export const DOCK_SLOT_NAME = "conversation.input.dock";

/** List-entry id within the dock slot (list-kind slots key entries by `id`). */
export const DOCK_SLOT_ID = "rolebox";

/** List position — after the goal/queue strips (TodoDock=0, QueueDock=20). */
export const DOCK_SLOT_ORDER = 40;

/** Locale namespace declared by the entry (dsh-client-ui-conversation). */
export const DOCK_LOCALE = "conversation";

/** The settings page slot this plugin contributes into (one page per feature). */
export const MONITOR_SLOT_NAME = "settings.section";

/** Section key within settings.section (drives the `only` filtering). */
export const MONITOR_SLOT_ID = "rolebox-monitor";

/** Nav position — after the feature pages (late order keeps it near the end). */
export const MONITOR_SLOT_ORDER = 90;

/** Nav display text (registrant-localized label rendered by the shell). */
export const MONITOR_SLOT_LABEL = "Monitoring";

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
 * Structural slot-registry service — duck of the dsh-client-runtime
 * `SlotRegistry` surface (lib/types/client/slots.d.ts:46-91), restricted to
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
 * Structural client context — duck of the cordis `Context` after the
 * `@deepseek-ai/dsh-client-runtime/client` module augmentation
 * (lib/types/client/index.d.ts:106-110 declares `ctx.slots: SlotRegistry`).
 */
export interface DshClientContext {
  /** The browser slot registry service. */
  slots: DshSlotsService;
}

// ── apply ──────────────────────────────────────────────────────────────────

/**
 * Client plugin `apply(ctx)` — registers both contributions into their slots
 * following the TodoDock posture: wait on each slot declaration via
 * `ctx.slots.inject`, then register inside the injected callback so the
 * contribution tracks the declaration across independent activation and
 * reload.
 *
 *   - the {@link RoleSwitchDock} into `'conversation.input.dock'`. The inject
 *     factory resolves the session-scoped session id (the framework calls it
 *     with the definite session id per `InjectParams<'session'>`) and
 *     returns the business face `{ sessionId }` the dock consumes for the
 *     `POST /rolebox/roles/switch` body.
 *   - the {@link RoleboxMonitorPanel} into `'settings.section'`. The slot is
 *     `scope: 'root'`, so the register options carry no inject face — the
 *     component receives the owner share (`{ close }`) directly from the
 *     shell.
 *
 * The returned disposer tears down BOTH injection effects (each contribution
 * is independently removable, so an absent declaration degrades gracefully —
 * see the module docstring).
 *
 * @param ctx - the client cordis context (structural; the injected slots service).
 * @returns the fiber disposer removing both injection effects (and, through
 *          the registered callbacks' disposers, both slot contributions).
 */
export function apply(ctx: DshClientContext): (() => void) | void {
  const disposers = [
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
    ctx.slots.inject(MONITOR_SLOT_NAME, () =>
      ctx.slots.register(
        {
          name: MONITOR_SLOT_NAME,
          id: MONITOR_SLOT_ID,
          order: MONITOR_SLOT_ORDER,
          label: MONITOR_SLOT_LABEL,
        },
        RoleboxMonitorPanel,
      ),
    ),
  ];
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

// Type-only re-exports: the dock's composed props and DTOs for consumers
// wiring the entry (e.g. the slot-contract mirror in tests).
export type { RoleSwitchDockProps };
