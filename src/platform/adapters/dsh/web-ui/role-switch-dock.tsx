/**
 * RoleSwitchDock — the rolebox contribution to the dsh
 * `'conversation.input.dock'` slot (browser half).
 *
 * The dock is a list/session-scoped full-width row above the composer card
 * (declared by `@deepseek-ai/dsh-client-ui-conversation` as
 * `{ kind: 'list', scope: 'session', owner: InputZone }`). This component is
 * registered into that slot by the client plugin entry (`client.ts`).
 *
 * The dock answers a STATUS question — "which role is running?" — so the
 * redesign makes the VALUE the title. The shipped static label ("Role") is
 * gone; the header renders the active role's display NAME. A label the user
 * already knows (the strip is 8px above a composer, glyph-marked, and the only
 * such strip) is replaced by the one fact the user does not have.
 *
 *   - a 40px toggle header — lead glyph, the active role NAME, an
 *     `Active`/`Base` chip, a chevron — plus a sibling status seat outside
 *     the button. The dock starts COLLAPSED on mount and on every session
 *     change so it never blocks the composer;
 *   - the active role is carried by FIVE redundant channels and never by a
 *     coloured side border (a banned anti-slop tell): the spelled-out chip in
 *     the header (which survives total loss of hue perception), a reserved
 *     20px trailing mark seat on every row holding a check glyph, an inherited
 *     font-weight step (400 -> 500) on the active row, the host active-nav
 *     fill, and `aria-current`. The shipped 6px dot is gone;
 *   - the status seat is a SIBLING of the toggle button, not a descendant:
 *     a live region nested inside an interactive control rewrites the
 *     control's accessible name on every status change. It is rendered
 *     UNCONDITIONALLY so the region stays mounted (mounting a live region
 *     together with its text is unreliable across screen readers), and it is
 *     empty and silent at rest — the value seat and the chip carry the steady
 *     state. A successful mutation writes a confirmation into it visually
 *     hidden, so a collapse is still announced;
 *   - the disclosure is ALWAYS MOUNTED and animated via
 *     `grid-template-rows: 0fr -> 1fr` plus `visibility`, so closing can
 *     animate and closed content is neither focusable nor exposed to the
 *     accessibility tree. The button carries `aria-expanded` and
 *     `aria-controls`;
 *   - a filter row (shown while roles exist) narrows the list client-side by
 *     name and description as the user types, with a clear affordance, a live
 *     `n of N` count, and an explicit no-match row. The query survives
 *     collapse/expand and resets on session change;
 *   - on mount (and on every `sessionId` change) the session's persisted
 *     active role is hydrated from `GET /rolebox/roles/active?session=…`. A
 *     tri-state (`loading` | `ready` | `unknown`) prevents the dock from
 *     claiming "Base agent" before the probe has answered;
 *   - a successful switch or clear collapses the dock — the collapse IS the
 *     confirmation (no toast, no checkmark flash, no colour pulse) — and a
 *     FAILED mutation keeps the list open so the Retry row stays reachable;
 *   - a clear-to-base row (visible only while a role is active) issues
 *     `DELETE /rolebox/roles/active?session=…`;
 *   - a failed LOAD is recoverable: the empty state offers a Reload action
 *     that preserves the open list and the typed query.
 *
 * The slot contract (dsh-client-ui-slots' `SlotCore.register` +
 * `PropsRuntime` / `InjectFace` / `PropsLocale`) is consumed STRUCTURALLY:
 * `@deepseek-ai/dsh-client-ui-slots` is not installed yet, so
 * `RoleSwitchDockProps` duck-types the composed four-share intersection
 * against the observed `.d.ts` shapes — see the module docstring of
 * `client.ts` for the citation map. The only external module this file
 * imports is `react`, whose type surface is supplied by the temporary
 * `react.stub.d.ts` in this directory — which declares `useState`,
 * `useEffect`, `useRef`, `createElement` and `Fragment`. No hook beyond
 * those five may be used.
 *
 * This module is BROWSER code: it must not import node builtins, and it uses
 * the browser `fetch` global with relative (same-origin) paths. It touches
 * the DOM in exactly ONE place, by design: a single `useRef` on the header
 * toggle, used to restore focus after a successful switch/clear. Collapsing
 * the disclosure hides the row the user just activated, so without that call
 * focus falls to `<body>` and the keyboard user's next keystroke goes nowhere.
 * No scroll listeners, no measurement, no other DOM reads.
 *
 * @module
 */

import { useState, useEffect, useRef } from "react";
import { dockClass } from "./role-switch-dock.css.ts";

/**
 * Structural role DTO — the `GET /rolebox/roles` list item. Mirrors the
 * route's `RoleSwitchRoleDto` (`web-role-switch-route.ts`): all five
 * keys are always present; `model` / `mode` are `null` when the definition
 * carries no override.
 */
export interface RoleSwitchRoleDto {
  id: string;
  name: string;
  description: string;
  model: string | null;
  mode: string | null;
}

/** Structural success body of `POST /rolebox/roles/switch`. */
export interface RoleSwitchOkBody {
  ok: true;
  session: string;
  role: string;
}

/** Structural success body of `GET /rolebox/roles/active` (`role` is `null` for the base agent). */
export interface RoleSwitchActiveBody {
  session: string;
  role: string | null;
}

/** Structural success body of `DELETE /rolebox/roles/active` (`role` is always `null`). */
export interface RoleSwitchClearOkBody {
  ok: true;
  session: string;
  role: null;
}

/** Structural error body of `POST /rolebox/roles/switch` (non-2xx). */
export interface RoleSwitchErrorBody {
  ok: false;
  error: string;
}

/**
 * Composed props of the dock entry — a duck-type of the slot framework's
 * `PropsRuntime<'conversation.input.dock'> & InjectFace<...> & PropsLocale<'conversation'>`
 * intersection, restricted to the two seats this component consumes:
 *
 *   - `sessionId` — the framework-resolved session id, delivered through the
 *     entry's inject factory (`client.ts` passes `inject: (sessionId) =>
 *     ({ sessionId })`, per the InjectParams of a `scope: 'session'` slot).
 *   - `t` — the locale seat promised by declaring `locale: 'conversation'`.
 *     Declared (optional) so the component satisfies the four-share
 *     composition, but the dock renders hardcoded English text: the
 *     'conversation' dictionary keys are not known at this layer, and unknown
 *     keys must not be routed through `t`.
 */
export interface RoleSwitchDockProps {
  /** Framework-resolved session id, delivered via the entry's inject factory. */
  sessionId: string;
  /** Locale seat (declared `locale: 'conversation'`); accepted, not used. */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/** `GET /rolebox/roles` — same-origin relative path on the dsh web server. */
export const ROLES_ENDPOINT = "/rolebox/roles";

/** `GET /rolebox/roles/active` — the session's persisted active role. */
export const ACTIVE_ENDPOINT = "/rolebox/roles/active";

/** `DELETE /rolebox/roles/active` — clear the session's active role (same path as `ACTIVE_ENDPOINT`, method `DELETE`). */
export const CLEAR_ENDPOINT = "/rolebox/roles/active";

/** `POST /rolebox/roles/switch` — same-origin relative path. */
export const SWITCH_ENDPOINT = "/rolebox/roles/switch";

/**
 * The id wiring the header's `aria-controls` to the animated disclosure
 * region. Exported so the tests can assert the pair without duplicating the
 * literal.
 */
export const DOCK_DISCLOSURE_ID = "rolebox-dock-disclosure";

/**
 * `ROLE_DATALIST_ID` (`"rolebox-role-list"`) — retained as an exported
 * contract constant. The pre-restyle dock fed a `<datalist>` with this id
 * into the role-id input; the picker restyle dropped the input/datalist
 * pair from the render tree, but the export stays (value unchanged) for
 * consumers that wire the old surface.
 */
export const ROLE_DATALIST_ID = "rolebox-role-list";

/** Status-seat state: the rendered text plus whether it is an error. */
interface DockStatus {
  text: string;
  error: boolean;
  /**
   * Render the seat visually hidden. A successful switch confirms itself
   * visually by collapsing and by re-mounting the value seat — but a screen
   * reader gets nothing from a collapse, so the confirmation is announced
   * through the seat instead (WCAG 2.1 AA SC 4.1.3). No visible banner.
   */
  srOnly?: boolean;
}

/**
 * Hydration state of the dock's data.
 *
 *   - `loading` — the roles/active probes are in flight; the value seat reads
 *     "Loading…" and no chip is shown, so the dock never claims "Base agent"
 *     before the active-role probe has answered.
 *   - `ready` — both probes settled; the value seat and the chip are truthful.
 *   - `unknown` — the roles probe failed; the empty state offers Reload.
 */
type DockRoleState = "loading" | "ready" | "unknown";

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Structural guard for the `GET /rolebox/roles/active` success body
 * (`{ session: string, role: string | null }`). A malformed or non-object
 * payload fails the guard so the caller can treat the probe as absent.
 */
function isActiveBody(value: unknown): value is RoleSwitchActiveBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.session === "string" &&
    (record.role === null || typeof record.role === "string")
  );
}

/**
 * Normalized result of a rolebox mutation (`POST /rolebox/roles/switch` or
 * `DELETE /rolebox/roles/active`). Non-2xx responses carry the stable error
 * shape `{ ok: false, error: string }`; 2xx mutations carry
 * `{ ok: true, session, role }` — `role` is `null` for a clear. Malformed
 * bodies fall back to a status-derived error so the caller always has a
 * displayable message.
 */
interface RoleboxMutation {
  ok: boolean;
  session: string | null;
  role: string | null;
  error: string;
}

/** Parse a rolebox mutation response into a normalized {@link RoleboxMutation}. */
async function readMutation(res: Response): Promise<RoleboxMutation> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: res.ok && data.ok === true,
    session: typeof data.session === "string" ? data.session : null,
    role: typeof data.role === "string" ? data.role : null,
    error:
      typeof data.error === "string"
        ? data.error
        : res.ok
          ? "Invalid server response"
          : "HTTP " + res.status,
  };
}

/**
 * Lead glyph — a 14x14 "role" mark (person silhouette) stroked with
 * `currentColor`, following the shipped glyph convention of the dsh dock
 * strips (14x14 artboard, `fill: none`, `aria-hidden`). Inline local SVG:
 * the dsh primitives icon set is deliberately not imported.
 */
function RoleGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="5" r="2.8" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.6 12c.9-2.4 2.5-3.6 4.4-3.6s3.5 1.2 4.4 3.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Filter lead glyph — a 14x14 magnifier marking the search field, following
 * the same stroke convention as {@link RoleGlyph} (inline local SVG,
 * `fill: none`, `aria-hidden`).
 */
function SearchGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="3.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8.7 8.7 12 12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Filter clear glyph — a 12x12 cross centered in the 24x24 clear-button hit
 * area (see `.rolebox-dock-filter-clear`), same stroke convention.
 */
function ClearGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m2.5 2.5 7 7M9.5 2.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Disclosure chevron — a 14x14 caret that rotates 180 degrees when the list
 * is open. It communicates WHICH DIRECTION the control will move the surface,
 * so it is paired with the same 200ms/160ms curve as the disclosure itself.
 */
function ChevronGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3.5 5.75 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Active-row mark — a 14x14 check. It lives in the reserved 20px trailing
 * seat that EVERY row carries, so switching the active role never reflows a
 * row. This is the non-colour channel that survives total loss of hue
 * perception, and it replaces the shipped 6px dot.
 */
function CheckGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3.25 7.5 2.75 2.75 4.75-6"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Alert glyph — a 14x14 circled exclamation marking the error seat. State is
 * never carried by colour alone, so every error surface pairs its tint with
 * this glyph and the message text.
 */
function AlertGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 4.3v3.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.1" r=".75" fill="currentColor" />
    </svg>
  );
}

/**
 * The dock component: a dsh-styled picker (header + animated disclosure).
 *
 * Behavior:
 *   - starts collapsed (and re-collapses on every `sessionId` change, and
 *     after a successful switch/clear). The header's VALUE seat reports the
 *     active role's display name while the list is hidden, and one header
 *     click expands it;
 *   - on mount (and on every `sessionId` change), fetches the switchable
 *     roles from `GET /rolebox/roles` and the session's persisted active
 *     role from `GET /rolebox/roles/active?session=…` — the active probe is
 *     best-effort (a failure just leaves the seat showing the base agent);
 *   - the expanded list is preceded by a filter row: a keystroke filter
 *     narrows the rows by name and description (case-insensitive substring),
 *     the clear button (visible only while a query is typed) restores the
 *     full list, and an explicit no-match row reports an empty result set;
 *   - a row click posts `{ role, session: sessionId }` to
 *     `POST /rolebox/roles/switch`, then collapses on success (the collapse
 *     is the confirmation). On failure the previous active role is preserved,
 *     the list stays open, the server error is shown, and a Retry row re-runs
 *     the failed switch;
 *   - the clear-to-base row (visible only while a role is active) issues
 *     `DELETE /rolebox/roles/active?session=…`, collapsing on success; a
 *     failed clear keeps the previous active role and shows the error with a
 *     Retry row;
 *   - rows and the clear/retry controls are disabled while a mutation is
 *     in flight (the filter stays usable — filtering is not a mutation).
 *
 * @param props - composed slot props (see {@link RoleSwitchDockProps}).
 */
export function RoleSwitchDock({ sessionId }: RoleSwitchDockProps) {
  const [roles, setRoles] = useState<RoleSwitchRoleDto[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * Collapsed by default: the dock is a quiet tool strip above the
   * composer, not a view. Every session change re-collapses it and a
   * successful switch/clear collapses it again.
   */
  const [collapsed, setCollapsed] = useState(true);
  /**
   * The keystroke filter over the role list (name + description,
   * case-insensitive). Transient chrome state: it survives collapse/expand
   * (the field stays visible and self-explanatory — no hidden state) and is
   * preserved across a Reload, but is reset by a session change.
   */
  const [query, setQuery] = useState("");
  const [activeRole, setActiveRole] = useState<string | null>(null);
  /**
   * The last failed mutation (switch/clear), retained so the Retry row can
   * re-run it. Cleared by a successful mutation or by a fresh session load.
   */
  const [failedAction, setFailedAction] = useState<
    { kind: "switch"; role: string } | { kind: "clear" } | null
  >(null);
  const [status, setStatus] = useState<DockStatus>({
    text: "Loading roles…",
    error: false,
  });
  /**
   * Bumped by `reload()`. It is a dependency of the LOAD effect only, so a
   * retry re-fetches without re-running the session reset — which is what
   * lets Reload preserve the open list and the typed query.
   */
  const [loadToken, setLoadToken] = useState(0);
  /** Hydration tri-state; see {@link DockRoleState}. */
  const [roleState, setRoleState] = useState<DockRoleState>("loading");
  /**
   * The header toggle. Used only to restore focus after a successful
   * switch/clear collapses the disclosure out from under the activated row.
   */
  const headerRef = useRef<{ focus?: () => void } | null>(null);

  // Session-scoped reset. Deliberately does NOT depend on `loadToken`: a
  // session switch must never render stale state, but a Reload must not throw
  // away the user's filter or the open list.
  useEffect(() => {
    setRoles([]);
    setActiveRole(null);
    setFailedAction(null);
    setCollapsed(true);
    setQuery("");
    setRoleState("loading");
    setStatus({ text: "Loading roles…", error: false });
  }, [sessionId]);

  // Load the role list and the session's persisted active role. Re-runs on a
  // session change and on an explicit reload. `cancelled` guards against a
  // state update after unmount or after a superseding run (the fetches
  // resolve asynchronously).
  useEffect(() => {
    let cancelled = false;
    setRoleState("loading");
    setStatus({ text: "Loading roles…", error: false });

    async function loadDockState(): Promise<void> {
      const [rolesRes, activeRes] = await Promise.all([
        fetch(ROLES_ENDPOINT),
        fetch(ACTIVE_ENDPOINT + "?session=" + encodeURIComponent(sessionId)),
      ]);
      if (cancelled) return;
      if (!rolesRes.ok) throw new Error("HTTP " + rolesRes.status);

      const rolesData = (await rolesRes.json()) as unknown;
      const list = Array.isArray(rolesData)
        ? (rolesData as RoleSwitchRoleDto[])
        : [];

      // Best-effort active-role probe: a non-ok or malformed response (e.g.
      // an older backend without the endpoint) just leaves the seat
      // unhighlighted — it must not fail the whole dock.
      let active: string | null = null;
      if (activeRes.ok) {
        const activeData = (await activeRes.json()) as unknown;
        if (isActiveBody(activeData)) active = activeData.role;
      }

      if (cancelled) return;
      setRoles(list);
      setActiveRole(active);
      setRoleState("ready");
      // The value seat and the chip carry the steady state; the seat stays
      // empty until there is something to report (progress or a failure).
      setStatus({ text: "", error: false });
    }

    loadDockState().catch((err: unknown) => {
      if (cancelled) return;
      setRoleState("unknown");
      setStatus({
        text: "Failed to load roles: " + toMessage(err),
        error: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, loadToken]);

  /** Re-fetch the role list and the active role without losing the filter. */
  function reload(): void {
    setLoadToken((n) => n + 1);
  }

  /**
   * Switch to a role. The session id for the POST body is the
   * framework-resolved one from the inject face, not a client-supplied
   * value. On failure the previous active role is preserved (state is only
   * written on success) and `failedAction` retains the role for the Retry
   * row.
   */
  async function switchRole(role: string): Promise<void> {
    if (busy) return;
    const switchedName = roles.find((item) => item.id === role)?.name ?? role;
    setBusy(true);
    setStatus({ text: "Switching to " + switchedName + "…", error: false });
    try {
      const res = await fetch(SWITCH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, session: sessionId }),
      });
      const result = await readMutation(res);
      if (!result.ok) {
        setFailedAction({ kind: "switch", role });
        setStatus({
          text: "Switch failed: " + result.error + " — retry below",
          error: true,
        });
        return;
      }
      setFailedAction(null);
      setActiveRole(result.role);
      // The picker closes on success and the collapse IS the visible
      // confirmation: the value seat re-mounts with the new name, the chip
      // flips to Active, and the dock returns to its rest posture instead of
      // blocking the composer. No toast, no checkmark flash, no colour pulse —
      // but the seat still announces the change for assistive technology.
      setStatus({
        text: switchedName + " is now the active role",
        error: false,
        srOnly: true,
      });
      setCollapsed(true);
      // The row this was clicked from is about to be hidden, which would drop
      // focus to <body>; return it to the toggle the user came from.
      headerRef.current?.focus?.();
    } catch (err) {
      setFailedAction({ kind: "switch", role });
      setStatus({
        text: "Switch failed: " + toMessage(err) + " — retry below",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Clear the active role back to the base agent
   * (`DELETE /rolebox/roles/active?session=…` — the session param is sent
   * the same way the active-role probe passes it). Success resets the
   * `aria-current` highlight and the value seat; failure preserves the
   * previous active role and leaves `failedAction` set for the Retry row.
   */
  async function clearRole(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus({ text: "Returning to base agent…", error: false });
    try {
      const res = await fetch(
        CLEAR_ENDPOINT + "?session=" + encodeURIComponent(sessionId),
        { method: "DELETE" },
      );
      const result = await readMutation(res);
      if (!result.ok) {
        setFailedAction({ kind: "clear" });
        setStatus({
          text: "Clear failed: " + result.error + " — retry below",
          error: true,
        });
        return;
      }
      setFailedAction(null);
      setActiveRole(null);
      setStatus({
        text: "Returned to the base agent",
        error: false,
        srOnly: true,
      });
      setCollapsed(true);
      headerRef.current?.focus?.();
    } catch (err) {
      setFailedAction({ kind: "clear" });
      setStatus({
        text: "Clear failed: " + toMessage(err) + " — retry below",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  /** Re-run the last failed mutation — the Retry row's action. */
  function retryLastAction(): void {
    if (busy || failedAction === null) return;
    if (failedAction.kind === "clear") void clearRole();
    else void switchRole(failedAction.role);
  }

  /**
   * Client-side filter: case-insensitive substring over name + description
   * (the model/mode overrides stay out of the match surface — they are
   * display meta, not identity). The trimmed needle is also what the
   * no-match row echoes back, so a whitespace-only query reads as "no
   * filter".
   */
  const needle = query.trim().toLowerCase();
  const visibleRoles =
    needle === ""
      ? roles
      : roles.filter(
          (role) =>
            role.name.toLowerCase().includes(needle) ||
            role.description.toLowerCase().includes(needle),
        );

  // Recognition over recall: the header names the DISPLAY NAME of the active
  // role. The shipped design named the role *id*, which the picker never
  // displays — so the header named a string the user could not find anywhere
  // in the list. Falls back to the id only if the role is not in the list.
  const activeName =
    activeRole === null
      ? null
      : (roles.find((role) => role.id === activeRole)?.name ?? activeRole);
  const valueLabel =
    roleState === "loading"
      ? "Loading…"
      : roleState === "unknown"
        ? "Unknown"
        : (activeName ?? "Base agent");
  const chipKind: "active" | "base" | null =
    roleState === "ready" ? (activeRole === null ? "base" : "active") : null;
  const spokenValue = chipKind === "base" ? "base agent" : valueLabel;
  const headerLabel =
    "Role picker: " +
    spokenValue +
    (chipKind === "active" ? " is active" : "") +
    (collapsed ? ". Expand role list." : ". Collapse role list.");

  const countText =
    needle === ""
      ? String(roles.length)
      : visibleRoles.length + " of " + roles.length;

  const open = !collapsed;

  return (
    <div className="rolebox-dock" data-rolebox-dock>
      <div className={dockClass.panel}>
        <div className={dockClass.headerRow}>
          <button
            ref={headerRef}
            type="button"
            className={dockClass.header}
            aria-expanded={open}
            aria-controls={DOCK_DISCLOSURE_ID}
            aria-label={headerLabel}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span className={dockClass.lead} aria-hidden="true">
              <RoleGlyph />
            </span>
            <span
              key={roleState + ":" + (activeRole ?? "none")}
              className={dockClass.value}
              title={valueLabel}
            >
              {valueLabel}
            </span>
            {chipKind !== null && (
              <span
                className={
                  chipKind === "active"
                    ? dockClass.chip + " " + dockClass.chipActive
                    : dockClass.chip + " " + dockClass.chipBase
                }
                aria-hidden="true"
              >
                {chipKind === "active" ? "Active" : "Base"}
              </span>
            )}
            <span
              className={dockClass.chevron}
              data-open={String(open)}
              aria-hidden="true"
            >
              <ChevronGlyph />
            </span>
          </button>
          <span
            role="status"
            title={status.text}
            className={
              (status.error
                ? dockClass.status + " " + dockClass.statusError
                : dockClass.status) +
              (status.srOnly === true ? " " + dockClass.statusSr : "")
            }
          >
            {status.error && (
              <span className={dockClass.statusGlyph} aria-hidden="true">
                <AlertGlyph />
              </span>
            )}
            {status.text}
          </span>
        </div>
        <div
          className={dockClass.disclosure}
          id={DOCK_DISCLOSURE_ID}
          data-open={String(open)}
        >
          <div className={dockClass.disclosureInner}>
            {roles.length > 0 && (
              <div className={dockClass.filter}>
                <span className={dockClass.filterLead} aria-hidden="true">
                  <SearchGlyph />
                </span>
                <input
                  type="text"
                  className={dockClass.filterInput}
                  value={query}
                  placeholder="Filter roles"
                  aria-label="Filter roles"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event: { target: { value: string } }) =>
                    setQuery(event.target.value)
                  }
                  onKeyDown={(event: { key: string }) => {
                    if (event.key === "Escape" && query !== "") setQuery("");
                  }}
                />
                <span className={dockClass.count} role="status">
                  {countText}
                </span>
                {query !== "" && (
                  <button
                    type="button"
                    className={dockClass.filterClear}
                    aria-label="Clear filter"
                    onClick={() => setQuery("")}
                  >
                    <ClearGlyph />
                  </button>
                )}
              </div>
            )}
            <div
              className={dockClass.list}
              role="group"
              aria-label="Switchable roles"
            >
              {visibleRoles.map((role) => {
                const meta = [role.description, role.model, role.mode]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ");
                const isActive = role.id === activeRole;
                return (
                  <button
                    key={role.id}
                    type="button"
                    className={dockClass.row}
                    disabled={busy}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => {
                      void switchRole(role.id);
                    }}
                  >
                    <span className={dockClass.name} title={role.name}>
                      {role.name}
                    </span>
                    {meta !== "" && (
                      <span className={dockClass.meta} title={meta}>
                        {meta}
                      </span>
                    )}
                    <span
                      className={
                        isActive
                          ? dockClass.mark + " " + dockClass.markActive
                          : dockClass.mark
                      }
                      aria-hidden="true"
                    >
                      {isActive && <CheckGlyph />}
                    </span>
                  </button>
                );
              })}
              {needle !== "" && visibleRoles.length === 0 && (
                <div className={dockClass.empty} role="status">
                  No roles match “{query.trim()}”
                </div>
              )}
              {roles.length === 0 && needle === "" && roleState === "loading" && (
                // Not a live region: the header seat already announces the load.
                <div className={dockClass.empty}>
                  <span className={dockClass.emptyBody}>Loading roles…</span>
                </div>
              )}
              {roles.length === 0 &&
                needle === "" &&
                roleState !== "loading" &&
                (roleState === "unknown" ? (
                  <div className={dockClass.empty}>
                    <span className={dockClass.emptyTitle}>
                      Couldn&apos;t load roles
                    </span>
                    <span className={dockClass.emptyBody}>{status.text}</span>
                    <button
                      type="button"
                      className={dockClass.emptyAction}
                      onClick={reload}
                    >
                      Reload
                    </button>
                  </div>
                ) : (
                  <div className={dockClass.empty}>
                    <span className={dockClass.emptyBody}>
                      No switchable roles in this project.
                    </span>
                    <button
                      type="button"
                      className={dockClass.emptyAction}
                      onClick={reload}
                    >
                      Reload
                    </button>
                  </div>
                ))}
              {failedAction !== null && (
                <button
                  type="button"
                  className={dockClass.row}
                  disabled={busy}
                  onClick={retryLastAction}
                >
                  <span className={dockClass.name}>Retry</span>
                  <span className={dockClass.meta}>
                    {failedAction.kind === "clear"
                      ? "Return to base agent"
                      : "Switch to " +
                        (roles.find((item) => item.id === failedAction.role)
                          ?.name ?? failedAction.role)}
                  </span>
                </button>
              )}
              {activeRole !== null && (
                <button
                  type="button"
                  className={dockClass.row}
                  disabled={busy}
                  onClick={() => {
                    void clearRole();
                  }}
                >
                  <span className={dockClass.name}>Return to base agent</span>
                  <span className={dockClass.meta} aria-hidden="true">
                    clear active role
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
