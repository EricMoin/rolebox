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
 *   - on mount (and on every `sessionId` change) the session's persisted
 *     active role is hydrated from `GET /rolebox/roles/active?session=…`,
 *     so the `aria-current` highlight and the status seat reflect the role
 *     that survived a reload / session switch;
 *   - a clear-to-base row (visible only while a role is active) issues
 *     `DELETE /rolebox/roles/active?session=…`, returning the session to
 *     the base agent; on success the `aria-current` highlight and the
 *     status seat reset, and a failed clear keeps the previous active role;
 *   - a failed switch or clear preserves the previous active state, shows
 *     the server error on the status seat, and offers a Retry row that
 *     re-runs the failed mutation;
 *   - the header's status seat reports load/switch/clear outcomes and
 *     errors (live region, `role="status"`).
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

/** `GET /rolebox/roles/active` — the session's persisted active role. */
export const ACTIVE_ENDPOINT = "/rolebox/roles/active";

/** `DELETE /rolebox/roles/active` — clear the session's active role (same path as `ACTIVE_ENDPOINT`, method `DELETE`). */
export const CLEAR_ENDPOINT = "/rolebox/roles/active";

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
 * shape `{ ok: false, error: string }` (see `web-role-switch-route.ts`);
 * 2xx mutations carry `{ ok: true, session, role }` — `role` is `null` for
 * a clear. Malformed bodies fall back to a status-derived error so the
 * caller always has a displayable message.
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
 *   - on mount (and on every `sessionId` change), fetches the switchable
 *     roles from `GET /rolebox/roles` and the session's persisted active
 *     role from `GET /rolebox/roles/active?session=…` — both best-effort:
 *     a failed roles fetch leaves an empty list and the status seat reports
 *     the error; a failed active probe just leaves the seat unhighlighted
 *     (see {@link RoleSwitchActiveBody});
 *   - the header toggles the list; a row click posts
 *     `{ role, session: sessionId }` to `POST /rolebox/roles/switch` (the
 *     framework-resolved session id from the inject face), then reflects
 *     the outcome on the status seat — on success the seat names the role
 *     as active for the current session, on failure the previous active
 *     role is preserved, the server error is shown, and a Retry row
 *     re-runs the failed switch;
 *   - the clear-to-base row (visible only while a role is active) issues
 *     `DELETE /rolebox/roles/active?session=…`, resetting the
 *     `aria-current` highlight and the status seat to the base agent on
 *     success; a failed clear keeps the previous active role and shows
 *     the server error with a Retry row;
 *   - rows and the clear/retry controls are disabled while a mutation is
 *     in flight.
 *
 * @param props - composed slot props (see {@link RoleSwitchDockProps}).
 */
export function RoleSwitchDock({ sessionId }: RoleSwitchDockProps) {
  const [roles, setRoles] = useState<RoleSwitchRoleDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
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

  // Load the role list and the session's persisted active role. The effect
  // re-runs on every `sessionId` change so a session switch re-fetches both
  // (the dock is session-scoped — each session carries its own active role
  // server-side). `cancelled` guards against a state update after unmount or
  // after a superseding run (the fetches resolve asynchronously).
  useEffect(() => {
    let cancelled = false;

    // Drop the previous session's rows/seat before re-fetching: a session
    // switch must never render stale state.
    setRoles([]);
    setActiveRole(null);
    setFailedAction(null);
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
      setStatus(
        active !== null
          ? { text: "Active role: " + active, error: false }
          : {
              text: list.length > 0 ? "Ready" : "No switchable roles",
              error: false,
            },
      );
    }

    loadDockState().catch((err: unknown) => {
      if (cancelled) return;
      setStatus({
        text: "Failed to load roles: " + toMessage(err),
        error: true,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /**
   * Switch to a role. The session id for the POST body is the
   * framework-resolved one from the inject face, not a client-supplied
   * value. On failure the previous active role is preserved (state is only
   * written on success) and `failedAction` retains the role for the Retry
   * row.
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
      setStatus({
        text: "Role " + result.role + " is active for this session",
        error: false,
      });
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
   * `aria-current` highlight and the status seat; failure preserves the
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
      setStatus({ text: "Base agent active for this session", error: false });
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
                    : "Switch to " + failedAction.role}
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
        )}
      </div>
    </div>
  );
}
