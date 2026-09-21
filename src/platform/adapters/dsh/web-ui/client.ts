/**
 * dsh web-UI slot plugin — browser half (`src/platform/adapters/dsh/web-ui/client.ts`)
 *
 * This module is the client entry of the rolebox web-UI integration: a dsh
 * client plugin that contributes three components to the dsh web app:
 *
 *   - {@link RoleSwitchDock} → the `'conversation.input.dock'` slot (the
 *     list/session-scoped full-width row above the composer card);
 *   - {@link RoleboxRolesPanel} → the `'settings.section'` slot (the
 *     list/root-scoped settings page entitled "Rolebox" listing every loaded
 *     role and its tool policy / max steps);
 *   - {@link RoleboxMonitorPanel} → the keyed `'sidebar.right.pane.tab'` slot
 *     (the session-scoped right-Sidebar page body), backed by a tab TYPE
 *     registered under {@link MONITOR_TAB_ID} in the `ctx.sidebarRightTabs`
 *     registry and opened by kind through `ctx.sidebarRight.openTab`
 *     ({@link MONITOR_TAB_KIND}); live monitoring belongs beside the
 *     conversation, not inside settings.
 *
 * Each contribution follows the same posture (see below); the sections that
 * follow document the three slot contracts, the tab-type registry, and the
 * graceful-degradation rule that keeps the plugin healthy when a declaration
 * is absent.
 *
 * ── Plugin shape ──────────────────────────────────────────────────────────
 * The export mirrors the canonical registrant-plugin posture of
 * `@deepseek-ai/dsh-client-ui-conversation`'s QueueDock entry
 * (packages/client/ui-conversation/src/client/queue/QueueDock.tsx in the
 * 0.1.5-rc.1 source checkout):
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
 * ── The `settings.section` contribution (the "Rolebox" page) ─────────────
 * {@link RoleboxRolesPanel} is contributed to the `'settings.section'` slot —
 * one settings page per list entry — declared by
 * `@deepseek-ai/dsh-client-ui-settings` as
 * `{ kind: 'list', scope: 'root', owner: SettingsSectionOwnerProps }`
 * (lib/types/client/contract/slots.d.ts:67-71). The owner share is
 * `{ close: () => void }` (SettingsSectionOwnerProps, slots.d.ts:148-151) —
 * the shell hands the section a `close` handle (closes the settings panel)
 * and renders the contribution inside the panel content column. Registrant
 * options carry the nav identity: `id` (section key, drives `only`
 * filtering), `order` (nav position), `label` (registrant-localized display
 * text). Because the slot is `scope: 'root'` (not `'session'`), the inject
 * factory receives no definite session id; the entry passes a zero-argument
 * business face (`() => ({ openMonitor })`) — the same shape shipped
 * registrants use (dsh-client-ui-agent-preset
 * src/client/index.ts:215-222 passes `inject: sectionInjected`).
 *
 * ── The right-Sidebar monitoring contribution ─────────────────────────────
 * The monitoring page is a right-Sidebar PAGE TYPE, registered in two stages
 * exactly as `@deepseek-ai/dsh-client-ui-plan` registers its preview type
 * (packages/client/ui-plan/src/client/index.ts:65-69 and :93-98):
 *
 *   1. the TYPE into the `ctx.sidebarRightTabs` registry
 *      (`SidebarRightTabRegistry.register`, dsh-client-ui-sidebar-right
 *      src/client/tab-registry.ts:248) — `{ id, kind, title, guide }`, with
 *      `patterns` omitted so this is a page type opened by `kind` rather
 *      than an address glob (tab-registry.ts:91-134);
 *   2. the BODY into the keyed `'sidebar.right.pane.tab'` slot under the
 *      definition's own `id` (the seat's dispatch key, declared by
 *      dsh-client-ui-sidebar-right as
 *      `{ kind: 'keyed', scope: 'session', hookContext: TabHookContext }`,
 *      src/client/contract/slots.ts:50-58). A page body needs none of the
 *      tab's runtime data and may render global state, which is why the
 *      registration carries no `inject` face (ui-plan's PlanPreview body
 *      registers the same way).
 *
 * `ctx.sidebarRightTabs` and `ctx.sidebarRight` are provided services
 * (dsh-client-ui-sidebar-right src/client/index.ts:84 and :109-110 —
 * `ctx.reflect.provide('sidebarRightTabs', tabs)` /
 * `provide('sidebarRight', controller)`). The type is opened through
 * `ctx.sidebarRight.openTab(kind)` (src/client/service.ts:150-171), which
 * expands the column in the same step; it THROWS when no session surface is
 * mounted ("sidebarRight: no session surface is mounted",
 * src/client/service.ts:296-299 → :537-544), so {@link openMonitor} converts
 * that throw into a user-facing error line rather than letting it escape a
 * click handler. The guide entry ({@link MONITOR_TAB_GUIDE_ID}) lists the type
 * in the docked guide page, whose capsules call
 * `openTab(kind, { replaceTab: true })`
 * (src/client/tabs/guide/GuideBody.tsx:80-99) — the standard discovery path
 * for a page type.
 *
 * ── Graceful degradation ───────────────────────────────────────────────────
 * `ctx.slots.inject` installs an effect per declaration lifetime: the
 * callback runs synchronously when the declaration already exists, or inside
 * the declaring `register()` call otherwise (dsh-client-ui-slots
 * lib/client.js:55, lib/types/index.d.ts:46-91). If a slot is never declared —
 * e.g. the settings shell (`sidebar.settings` owner in ui-settings-general)
 * does not activate — the corresponding injection callback simply never runs:
 * that contribution does not mount, `apply` still returns a disposer, and the
 * plugin remains healthy. The tab-BODY injection degrades the same way when
 * the frame never declares `sidebar.right.pane.tab`.
 *
 * Per-contribution ISOLATION goes one step further: each registration is
 * installed through `apply`'s `contribute` helper, so one contribution that
 * throws cannot take the others down with it. That matters most for the pair
 * the host dispatches as ONE unit — the tab TYPE and the tab BODY. A tab is
 * rendered by looking the type up by `tab.kind` and then dispatching the body
 * under the type's `id`; a type whose body is missing makes the host draw its
 * own "这类内容还没有可用的查看方式。" notice (ui-sidebar-right
 * SidebarRight.tsx:218) in the panel's place, saying nothing about why. Since
 * `sidebarRightTabs.register` is the one call here that throws on a duplicate
 * id, isolating it means a double activation can no longer cost the user their
 * panel — and the body installs BEFORE the type, because a body with no type is
 * inert while a type with no body is a dead tab.
 *
 * The tab-type registration is NOT declaration-waited: it is a direct
 * `ctx.sidebarRightTabs.register(...)` call, so the plugin's `inject` roster
 * now waits on the right-Sidebar services themselves
 * (`["slots", "sidebarRightTabs", "sidebarRight"]`). That is the accepted
 * cost of contributing a page type: `ctx.sidebarRightTabs` must exist before
 * `apply` runs, and the whole plugin therefore activates behind it. The
 * alternative — probing `ctx.get('sidebarRightTabs')` — would silently drop
 * the monitoring tab on exactly the hosts that DO provide the frame.
 *
 * ── Structural typing (duck types) ────────────────────────────────────────
 * `@deepseek-ai/dsh-client-ui-slots` is installed as a devDep for
 * type/tests, but following the repo's dsh
 * convention ("The dsh surface is consumed structurally — this module does
 * NOT import `@deepseek-ai/*`", cf. web-role-switch-route.ts:13), the
 * slots service surface, the right-Sidebar faces and the client context are
 * duck-typed against the observed `.d.ts` shapes:
 *
 *   - `ctx.slots`   — `SlotRegistry` (dsh-client-ui-slots
 *                     lib/types/index.d.ts:46-91): `inject(key,
 *                     callback)` (line 90) + `register(options, component)`
 *                     (line 74, reusing `SlotCore.register`).
 *   - `register` options — `BaseOptions` / `StoredEntry.options`
 *                     (dsh-client-ui-slots lib/types/index.d.ts:402-445):
 *                     name / id / order / label / locale / inject / children /
 *                     store / registrant / key.
 *   - component     — `SlotComponent<P> = (props: P) => ReactNode`
 *                     (dsh-client-ui-slots lib/types/index.d.ts:310); the
 *                     return type is structurally `unknown` here (the
 *                     temporary `react.stub.d.ts` only serves `tsc`; the
 *                     bundler keeps `react` external via its `external` list).
 *   - `ctx.sidebarRightTabs` — `SidebarRightTabRegistry.register(definition)`
 *                     (dsh-client-ui-sidebar-right src/client/tab-registry.ts:248).
 *   - `ctx.sidebarRight` — `ISidebarRight.openTab(kind, options?)`
 *                     (dsh-client-ui-sidebar-right src/client/service.ts:150-171).
 *
 * Browser constraint: this module runs in the dsh web app — no node builtins.
 *
 * @module
 */

import { RoleSwitchDock } from "./role-switch-dock.tsx";
import type { RoleSwitchDockProps } from "./role-switch-dock.tsx";
import { RoleboxMonitorPanel } from "./rolebox-monitor-panel.tsx";
import { RoleboxRolesPanel } from "./rolebox-roles-panel.tsx";
import type { RoleboxRolesPanelProps } from "./rolebox-roles-panel.tsx";

// ── Plugin metadata ────────────────────────────────────────────────────────

/** Plugin name — the dsh client plugin identity (matches the host plugin). */
export const name = "rolebox";

/**
 * dsh client services this plugin waits for (the cordis plugin-object
 * `inject`, NOT package.json's `dsh.client.inject` module edges). The client
 * cordis enforces inject-gated service access — reading `ctx.slots` without
 * declaring it here fails the fiber with `cannot get property "slots"
 * without inject`; the same holds for the right-Sidebar faces. This mirrors
 * dsh's own slot registrants (e.g. @deepseek-ai/dsh-client-ui-conversation
 * lib/client.js:9401 declares `["slots", ...]`; ui-plan declares
 * `["slots", ..., "sidebarRight", "sidebarRightTabs"]`,
 * src/client/index.ts:52); declaring the services also delays activation
 * until the client runtime has provided them.
 */
export const inject: string[] = ["slots", "sidebarRightTabs", "sidebarRight"];

/** The slot this plugin contributes into (the input dock above the composer). */
export const DOCK_SLOT_NAME = "conversation.input.dock";

/** List-entry id within the dock slot (list-kind slots key entries by `id`). */
export const DOCK_SLOT_ID = "rolebox";

/** List position — after the goal/queue strips (TodoDock=0, QueueDock=20). */
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

/** The keyed right-Sidebar seat one tab body registers into. */
export const MONITOR_TAB_SLOT_NAME = "sidebar.right.pane.tab";

/**
 * The monitoring tab type's implementation identity. It is ALSO the key the
 * body registers under in {@link MONITOR_TAB_SLOT_NAME} and the key the title
 * seat uses (tab-registry.ts:91-106), so it is deliberately the same string as
 * the kind — the value the shipped plugins pass (`const id = "..."; kind:
 * "terminal"` vs ui-plan's `previewId` used for both).
 */
export const MONITOR_TAB_ID = "rolebox-monitor";

/** Type discriminator: what tabs of this type are, and what `openTab` names. */
export const MONITOR_TAB_KIND = "rolebox-monitor";

/** The tab chip's / guide capsule's title text. */
export const MONITOR_TAB_TITLE = "Rolebox";

/** Stable guide-entry identity within this provider (unique per type). */
export const MONITOR_TAB_GUIDE_ID = "monitor";

/** Ascending guide position among every registered type's entries. */
export const MONITOR_TAB_GUIDE_ORDER = 20;

/** The guide capsule's one-line description of what picking it opens. */
export const MONITOR_TAB_GUIDE_DESCRIPTION =
  "Live rolebox monitoring: loops, engine graphs, metrics and sessions.";

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
 * Structural guide entry — duck of `SidebarRightGuideEntry`
 * (dsh-client-ui-sidebar-right src/client/tab-registry.ts:61-80). The guide
 * page lists every registered type's entries and picking one calls
 * `openTab(kind, { replaceTab: true })` (src/client/tabs/guide/GuideBody.tsx:80-99),
 * which is the standard discovery path for a page type.
 */
export interface DshSidebarRightGuideEntry {
  /** Stable entry identity within its provider. */
  id: string;
  /** Ascending position among every registered type's entries. */
  order: number;
  /** The capsule's title. */
  title: () => string;
  /** One line on what picking the capsule opens. */
  description?: () => string;
}

/**
 * Structural tab-type definition — duck of `SidebarRightTabDefinition`
 * (dsh-client-ui-sidebar-right src/client/tab-registry.ts:91-134). `id` is
 * the implementation identity AND the key the body registers under in the
 * `sidebar.right.pane.tab` seat; `kind` is what `openTab` names. `patterns`
 * is deliberately omitted for this type: without resource globs it is a PAGE
 * type, opened by kind and recognizing no address (tab-registry.ts:107-117).
 */
export interface DshSidebarRightTabDefinition {
  /** This implementation's identity in the tab system. */
  id: string;
  /** Type discriminator: what tabs of this type are, and what `openTab` names. */
  kind: string;
  /** Each open by kind creates independent content (omitted: one page per kind). */
  multiple?: boolean;
  /** Resource-address globs this type recognizes (omitted ⇒ a page type). */
  patterns?: readonly string[];
  /** Registration band; defaults to `extension` when omitted. */
  priority?: string;
  /** The tab chip's initial text, captured into the layout record at open time. */
  title: (address: string) => string;
  /** Entry boxes for the guide page. Omit to stay off it. */
  guide?: readonly DshSidebarRightGuideEntry[];
}

/**
 * Structural tab-type registry — duck of `SidebarRightTabRegistry`
 * (dsh-client-ui-sidebar-right src/client/tab-registry.ts:248 and its
 * `register` contract at :235-247), restricted to the one member this
 * plugin consumes. `register` throws when the `id` is taken or the kind is
 * already registered in a way this one cannot coexist with.
 */
export interface DshSidebarRightTabsService {
  /**
   * Register one tab type for the caller's lifetime; returns the idempotent
   * disposer that unregisters it.
   */
  register(definition: DshSidebarRightTabDefinition): () => void;
}

/**
 * Structural right-Sidebar navigation face — duck of `ISidebarRight`
 * (dsh-client-ui-sidebar-right src/client/service.ts:150-171), restricted to
 * the one member this plugin consumes. `openTab` expands the column in the
 * same step and THROWS when no session surface is mounted
 * (service.ts:296-299 → :537-544).
 */
export interface DshSidebarRightService {
  /** Open a page type by kind (the type in force for it). */
  openTab(kind: string): void;
}

/**
 * Structural client context — duck of the cordis `Context` after the
 * `@deepseek-ai/dsh-client-ui-slots` module augmentation
 * (lib/types/index.d.ts:106-110 declares `ctx.slots: SlotRegistry`) and the
 * `@deepseek-ai/dsh-client-ui-sidebar-right` augmentation
 * (src/client/index.ts:84 declares `ctx.sidebarRight` and
 * `ctx.sidebarRightTabs`).
 */
export interface DshClientContext {
  /** The browser slot registry service. */
  slots: DshSlotsService;
  /** The right-Sidebar tab-type registry. */
  sidebarRightTabs: DshSidebarRightTabsService;
  /** The right-Sidebar navigation/presentation face. */
  sidebarRight: DshSidebarRightService;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── apply ──────────────────────────────────────────────────────────────────

/**
 * Client plugin `apply(ctx)` — registers every contribution following the
 * TodoDock posture: wait on each slot declaration via `ctx.slots.inject`,
 * then register inside the injected callback so the contribution tracks the
 * declaration across independent activation and reload.
 *
 *   - the {@link RoleSwitchDock} into `'conversation.input.dock'`. The inject
 *     factory resolves the session-scoped session id (the framework calls it
 *     with the definite session id per `InjectParams<'session'>`) and
 *     returns the business face `{ sessionId }` the dock consumes for the
 *     `POST /rolebox/roles/switch` body.
 *   - the {@link RoleboxRolesPanel} into `'settings.section'`. The slot is
 *     `scope: 'root'`, so the inject factory receives no session id; it
 *     returns the business face `{ openMonitor }` — the page's "Open monitor"
 *     control opens the right-Sidebar tab through the shared
 *     {@link DshSidebarRightService}. The component also receives the owner
 *     share (`{ close }`) directly from the shell.
 *   - the monitoring tab TYPE into `ctx.sidebarRightTabs` (id / kind
 *     {@link MONITOR_TAB_ID} / {@link MONITOR_TAB_KIND}, title and guide entry
 *     naming loops, engine graphs, metrics and sessions).
 *   - the monitoring tab BODY ({@link RoleboxMonitorPanel}) into the keyed
 *     `'sidebar.right.pane.tab'` seat under the type's `id`. A page body
 *     consumes none of the tab's runtime data, so the registration carries no
 *     inject face.
 *
 * The returned disposer tears down EVERY registration created here (the three
 * injection effects — dock, settings page, tab body — and the tab-type
 * registration), so an absent declaration or an unloading fiber degrades
 * gracefully — see the module docstring.
 *
 * @param ctx - the client cordis context (structural; the injected services).
 * @returns the fiber disposer removing every contribution (through the
 *          registered callbacks' disposers and the tab-type disposer).
 */
export function apply(ctx: DshClientContext): (() => void) | void {
  /**
   * Open the monitoring tab in the mounted session's right Sidebar. Returns
   * `null` on success and a short user-facing line when `openTab` throws
   * (no session surface mounted — e.g. the click came from a settings page
   * with no conversation on screen). Mirrors ui-plan's
   * `exitPlanMode: () => string | null` error-line convention
   * (src/client/index.ts:105-110): the caller renders the line on its status
   * seat instead of an exception escaping a click handler.
   */
  const openMonitor = (): string | null => {
    try {
      ctx.sidebarRight.openTab(MONITOR_TAB_KIND);
      return null;
    } catch (err) {
      return "Cannot open the monitor tab: " + toMessage(err);
    }
  };

  const disposers: Array<() => void> = [];

  /**
   * Install ONE contribution, isolating its failure.
   *
   * The four contributions are independent, and one of them genuinely can fail
   * at install time: `ctx.sidebarRightTabs.register` throws when its id or kind
   * is already taken (tab-registry.ts:235-247), which a double activation — a
   * hot reload on top of a live fiber, or a second registration from a stale
   * bundle — produces on its own.
   *
   * Letting that throw escape `apply` is the worst possible outcome for a tab
   * that is already open: the type would be missing AND, because the body
   * registration comes later in the same function, the body would never be
   * registered either. The host then draws `sidebarRight.tab.unavailable`
   * ("这类内容还没有可用的查看方式。", SidebarRight.tsx:218) in the panel's own
   * place, and nothing says why. Isolating each step keeps every contribution
   * that CAN install installed — and the tab body is one of them.
   *
   * @param label - contribution name, for the one diagnostic line.
   * @param install - the registration call; its disposer is collected.
   */
  const contribute = (label: string, install: () => (() => void) | void): void => {
    try {
      const dispose = install();
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (err) {
      // Browser code with no logger seat on the structural ctx: the console is
      // the only channel, and staying silent here is exactly what turns a
      // failed registration into an unexplained empty panel.
      console.warn("[rolebox] " + label + " did not register: " + toMessage(err));
    }
  };

  contribute("input dock", () =>
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
          inject: () => ({ openMonitor }),
        },
        RoleboxRolesPanel,
      ),
    ),
  );

  // The tab BODY is installed before the TYPE on purpose: a body with no type
  // is inert, whereas a type with no body is the "no way to view this" notice.
  contribute("monitor tab body", () =>
    ctx.slots.inject(MONITOR_TAB_SLOT_NAME, () =>
      ctx.slots.register(
        {
          name: MONITOR_TAB_SLOT_NAME,
          key: MONITOR_TAB_ID,
        },
        RoleboxMonitorPanel,
      ),
    ),
  );

  contribute("monitor tab type", () =>
    ctx.sidebarRightTabs.register({
      id: MONITOR_TAB_ID,
      kind: MONITOR_TAB_KIND,
      title: () => MONITOR_TAB_TITLE,
      guide: [
        {
          id: MONITOR_TAB_GUIDE_ID,
          order: MONITOR_TAB_GUIDE_ORDER,
          title: () => MONITOR_TAB_TITLE,
          description: () => MONITOR_TAB_GUIDE_DESCRIPTION,
        },
      ],
    }),
  );

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

// Type-only re-exports: the dock's and the roles page's composed props for
// consumers wiring the entry (e.g. the slot-contract mirror in tests).
export type { RoleSwitchDockProps, RoleboxRolesPanelProps };
