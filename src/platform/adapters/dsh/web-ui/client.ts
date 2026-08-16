/**
 * dsh web-UI slot plugin — browser half (`src/platform/adapters/dsh/web-ui/client.ts`)
 *
 * This module is the client entry of the rolebox web-UI slot integration: a
 * dsh client plugin that contributes the {@link RoleSwitchDock} component to
 * the `'conversation.input.dock'` slot of the dsh web app (the
 * list/session-scoped full-width row above the composer card).
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
 * ── Structural typing (duck types) ────────────────────────────────────────
 * `@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-slots` are
 * NOT installed yet (subtask 3 adds the devDeps). Following the repo's dsh
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
 *                     return type is structurally `unknown` here (react is
 *                     also not installed — the temporary `react.stub.d.ts`
 *                     covers its type surface).
 *
 * Browser constraint: this module runs in the dsh web app — no node builtins.
 *
 * @module
 */

import { RoleSwitchDock } from "./role-switch-dock.tsx";
import type { RoleSwitchDockProps } from "./role-switch-dock.tsx";

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
 * Client plugin `apply(ctx)` — registers the {@link RoleSwitchDock} into the
 * `'conversation.input.dock'` slot following the TodoDock posture: wait on
 * the slot declaration via `ctx.slots.inject`, then register inside the
 * injected callback so the contribution tracks the declaration across
 * independent activation and reload.
 *
 * The inject factory resolves the session-scoped session id (the framework
 * calls it with the definite session id per `InjectParams<'session'>`) and
 * returns the business face `{ sessionId }` the dock consumes for the
 * `POST /rolebox/roles/switch` body.
 *
 * @param ctx - the client cordis context (structural; the injected slots service).
 * @returns the fiber disposer removing the injection effect (and, through
 *          the registered callback's disposer, the slot contribution).
 */
export function apply(ctx: DshClientContext): (() => void) | void {
  return ctx.slots.inject(DOCK_SLOT_NAME, () =>
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
  );
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
