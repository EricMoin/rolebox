/**
 * RoleSwitchDock — the rolebox contribution to the dsh
 * `'conversation.input.dock'` slot (browser half).
 *
 * The dock is a list/session-scoped full-width row above the composer card
 * (declared by `@deepseek-ai/dsh-client-ui-conversation` as
 * `{ kind: 'list', scope: 'session', owner: InputZone }`). This component is
 * registered into that slot by the client plugin entry (`client.ts`) and
 * renders a dsh-styled one-tap role picker:
 *
 *   - a 36px toggle header (lead glyph + "Role" title + status seat) that
 *     collapses/expands the role list, styled from the sibling
 *     `role-switch-dock.css.ts` module (itself a faithful replica of the
 *     shipped QueueDock/TodoPanel rules — see that module's docstring for
 *     the citation map);
 *   - a collapsible role list (`GET /rolebox/roles`, same-origin relative
 *     path — the dsh web server serves the rolebox API under `/rolebox/*`),
 *     one 36px row per role; a row click posts
 *     `POST /rolebox/roles/switch` with `{ role, session: sessionId }` (the
 *     session id arrives through the entry's inject factory, `client.ts`);
 *   - the header's status seat reports load/switch outcomes and errors
 *     (live region, `role="status"`).
 *
 * The slot contract (dsh-client-ui-slots' `SlotCore.register` +
 * `PropsRuntime` / `InjectFace` / `PropsLocale`) is consumed STRUCTURALLY:
 * `@deepseek-ai/dsh-client-ui-slots` is not installed yet (subtask 3 adds the
 * devDeps), so `RoleSwitchDockProps` duck-types the composed four-share
 * intersection against the observed `.d.ts` shapes — see the module docstring
 * of `client.ts` for the citation map. The only external module this file
 * imports is `react`, whose type surface is currently supplied by the
 * temporary `react.stub.d.ts` in this directory.
 *
 * This module is BROWSER code: it must not import node builtins, and it uses
 * the browser `fetch` global with relative (same-origin) paths.
 *
 * @module
 */

import { useState, useEffect } from "react";
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

/** Structural error body of `POST /rolebox/roles/switch` (non-2xx). */
export interface RoleSwitchErrorBody {
  ok: false;
  error: string;
}

/**
 * Composed props of the dock entry — a duck-type of the slot framework's
 * `PropsRuntime<'conversation.input.dock'> & InjectFace<...> & PropsLocale<'conversation'>`
 * intersection (dsh-client-ui-slots `lib/types/index.d.ts:358`), restricted
 * to the two seats this component consumes:
 *
 *   - `sessionId` — the framework-resolved session id, delivered through the
 *     entry's inject factory (`client.ts` passes `inject: (sessionId) =>
 *     ({ sessionId })`, per the InjectParams of a `scope: 'session'` slot,
 *     dsh-client-ui-slots `lib/types/index.d.ts:367`).
 *   - `t` — the locale seat promised by declaring `locale: 'conversation'`
 *     (dsh-client-ui-slots `lib/types/index.d.ts:67-70`). Declared (optional)
 *     so the component satisfies the four-share composition, but the dock
 *     renders hardcoded English text: the 'conversation' dictionary keys are
 *     not known at this layer, and unknown keys must not be routed through
 *     `t`.
 *
 * Members the real composed props carry that this component does not consume
 * (the session/global standard kit — `useSession`, `useProjection`,
 * `useSessions`, `useWorkspaces` — and the `InputZone` owner share `session` /
 * `input`) are simply not declared: a component with a narrower prop type
 * accepts the broader framework-supplied props structurally.
 */
export interface RoleSwitchDockProps {
  /** Framework-resolved session id, delivered via the entry's inject factory. */
  sessionId: string;
  /** Locale seat (declared `locale: 'conversation'`); accepted, not used. */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/** `GET /rolebox/roles` — same-origin relative path on the dsh web server. */
export const ROLES_ENDPOINT = "/rolebox/roles";

/** `POST /rolebox/roles/switch` — same-origin relative path. */
export const SWITCH_ENDPOINT = "/rolebox/roles/switch";

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
}

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Lead glyph — a 14×14 "role" mark (person silhouette) stroked with
 * `currentColor`, following the shipped glyph convention of the dsh dock
 * strips (14×14 artboard, `fill: none`, `aria-hidden` — cf. TodoPanel's
 * `CompletedGlyph`, client.js:6116). Inline local SVG: the dsh primitives
 * icon set is deliberately not imported.
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
 * The dock component: a dsh-styled picker (toggle header + role list).
 *
 * Behavior:
 *   - on mount, fetches the switchable roles from `GET /rolebox/roles`
 *     (best-effort: a failed fetch leaves an empty list and the status seat
 *     reports the error);
 *   - the header toggles the list; a row click posts
 *     `{ role, session: sessionId }` to `POST /rolebox/roles/switch` (the
 *     framework-resolved session id from the inject face), then reflects
 *     the outcome on the status seat;
 *   - rows (and the header) are disabled while a switch is in flight.
 *
 * @param props - composed slot props (see {@link RoleSwitchDockProps}).
 */
export function RoleSwitchDock({ sessionId }: RoleSwitchDockProps) {
  const [roles, setRoles] = useState<RoleSwitchRoleDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [status, setStatus] = useState<DockStatus>({
    text: "Loading roles…",
    error: false,
  });

  // Populate the role list once on mount. `cancelled` guards against a state
  // update after unmount (the fetch resolves asynchronously).
  useEffect(() => {
    let cancelled = false;
    fetch(ROLES_ENDPOINT)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json() as Promise<unknown>;
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? (data as RoleSwitchRoleDto[]) : [];
        setRoles(list);
        setStatus({
          text: list.length > 0 ? "Ready" : "No switchable roles",
          error: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus({
          text: "Failed to load roles: " + toMessage(err),
          error: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Switch to a role. The session id for the POST body is the
   * framework-resolved one from the inject face, not a client-supplied value.
   */
  async function switchRole(role: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus({ text: "Switching to " + role + "…", error: false });
    try {
      const res = await fetch(SWITCH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, session: sessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | RoleSwitchOkBody
        | RoleSwitchErrorBody
        | Record<string, never>;
      if (!res.ok || data.ok !== true) {
        setStatus({
          text:
            "Switch failed: " +
            ("error" in data && typeof data.error === "string"
              ? data.error
              : "HTTP " + res.status),
          error: true,
        });
        return;
      }
      setActiveRole(data.role);
      setStatus({
        text: "Active role: " + data.role + "  (session: " + data.session + ")",
        error: false,
      });
    } catch (err) {
      setStatus({
        text: "Switch failed: " + toMessage(err),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rolebox-dock" data-rolebox-dock>
      <div className={dockClass.panel}>
        <button
          type="button"
          className={dockClass.header}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className={dockClass.lead} aria-hidden="true">
            <RoleGlyph />
          </span>
          <span className={dockClass.title}>Role</span>
          <span
            role="status"
            className={
              status.error
                ? dockClass.status + " " + dockClass.statusError
                : dockClass.status
            }
          >
            {status.text}
          </span>
        </button>
        {!collapsed && (
          <div className={dockClass.list}>
            {roles.map((role) => {
              const meta = [role.description, role.model, role.mode]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return (
                <button
                  key={role.id}
                  type="button"
                  className={dockClass.row}
                  disabled={busy}
                  aria-current={role.id === activeRole ? "true" : undefined}
                  onClick={() => {
                    void switchRole(role.id);
                  }}
                >
                  <span className={dockClass.name}>{role.name}</span>
                  {meta !== "" && <span className={dockClass.meta}>{meta}</span>}
                  {role.id === activeRole && (
                    <span className={dockClass.current} aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
