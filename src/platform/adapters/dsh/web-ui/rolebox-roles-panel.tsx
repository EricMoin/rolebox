/**
 * RoleboxRolesPanel — the rolebox contribution to the dsh `'settings.section'`
 * slot (browser half): the "Rolebox" settings page that lists every loaded role.
 *
 * The settings panel answers one question — "what roles are loaded right now?"
 * — so this page is a catalogue, not a live stream: one card per role, in the
 * order the host serves them, carrying the role's identity (name / id /
 * description), its model and mode (or the explicit fallbacks the definition
 * implies) and its catalog configuration (`tools` policy and `maxSteps`).
 * Live SESSION monitoring deliberately does NOT live here any more: it moved to
 * a right-Sidebar page tab ({@link RoleboxMonitorPanel}, registered by
 * `client.ts`), because monitoring is session-scoped evidence that belongs
 * beside the conversation. The header's "Open monitor" control bridges the two
 * through the `{ openMonitor }` inject face the settings entry passes
 * (see `client.ts`).
 *
 * The page:
 *
 *   - fetches the loaded-role list from `GET /rolebox/roles` (the bare JSON
 *     array served by `web-role-switch-route.ts`, same-origin relative path)
 *     on mount and on every manual Refresh; the request is guarded against a
 *     concurrent refresh and cancelled on unmount, and it NEVER polls;
 *   - normalizes every item defensively: missing / extra keys and malformed
 *     values degrade to explicit fallbacks ("Unnamed role", "default",
 *     "primary", "not set", "none declared") instead of blanks or a crash,
 *     the same posture the dock applies to its own DTO;
 *   - offers the in-process role reload (`POST /rolebox/reload`, the manual,
 *     non-destructive re-discovery) — the reload's ONLY entry point, moved
 *     here from the monitor panel because "what roles are loaded" is this
 *     page's question. A successful reload reports discovered / resolved /
 *     skipped and re-fetches the list; a failed reload leaves the rendered
 *     list untouched and reports on the status seat without a follow-up fetch;
 *   - reports load / refresh / reload outcomes on a live-region status seat
 *     (`role="status"`) that never wraps an interactive control, renders a
 *     content-shaped skeleton only while nothing has ever rendered, an
 *     `role="alert"` error state with Retry only when there is no data, and
 *     keeps already-rendered roles visible when a later refresh fails;
 *   - every truncation is recoverable: truncated values carry a `title`, and
 *     a long tool-name list is capped at {@link TOOL_NAME_LIMIT} entries with
 *     the full list in the `title`.
 *
 * Props are duck-typed structurally, like the dock and the monitor panel: the
 * component receives the `settings.section` owner share (`{ close }`) and the
 * entry's injected business face (`{ openMonitor }`). The only external module
 * imported is `react`, whose type surface is supplied by the temporary
 * `react.stub.d.ts` in this directory; no hook beyond `useState` /
 * `useEffect` is used.
 *
 * This module is BROWSER code: it must not import node builtins, and it uses
 * the browser `fetch` global with relative (same-origin) paths.
 *
 * @module
 */

import { useEffect, useState } from "react";
import { rolesClass } from "./rolebox-roles-panel.css.ts";

// ── Endpoint contract ──────────────────────────────────────────────────────

/** `GET /rolebox/roles` — the loaded role list (a bare JSON array). */
export const ROLES_ENDPOINT = "/rolebox/roles";

/**
 * `POST /rolebox/reload` — in-process, non-destructive role reload
 * (same-origin). This page is the ONLY entry point to it (locked decision: no
 * CLI/TUI surface), it is triggered MANUALLY (no polling), and a successful
 * reload is followed by a role-list re-fetch. Moved here from the monitor
 * panel: reloading roles answers this page's question.
 */
export const RELOAD_ENDPOINT = "/rolebox/reload";

/**
 * How many tool names one allow/deny row renders before it caps and defers to
 * the row's `title`. A role can declare dozens of tools; the row must still
 * read as one line in the settings content column.
 */
export const TOOL_NAME_LIMIT = 6;

// ── Structural DTO (mirror of the host route's RoleSwitchRoleDto) ──────────

/** Structural tool-policy DTO — both halves always present when the policy is. */
export interface RoleboxRoleToolsDto {
  allow: string[];
  deny: string[];
}

/**
 * Structural role DTO — one item of the `GET /rolebox/roles` array, mirroring
 * the host route's `RoleSwitchRoleDto` (`web-role-switch-route.ts`): all
 * seven keys are always present, `model` / `mode` / `maxSteps` are `null`
 * when the definition carries no value, and `tools` is `null` when the
 * definition declares no policy. The browser half never imports the host route
 * module; this interface is the structural copy.
 */
export interface RoleboxRoleDto {
  id: string;
  name: string;
  description: string;
  model: string | null;
  mode: string | null;
  tools: RoleboxRoleToolsDto | null;
  maxSteps: number | null;
}

/**
 * Composed props of the settings-page entry — a duck-type of the slot
 * framework's `PropsRuntime<'settings.section'> & InjectFace<...> &
 * PropsLocale<'settings'>` intersection, restricted to the seats this panel
 * consumes:
 *
 *   - `close` — the owner-share seat of the settings panel
 *     (`SettingsSectionOwnerProps`); the "Open monitor" control closes the
 *     settings shell before opening the right-Sidebar tab, so the tab is not
 *     opened underneath a covering panel.
 *   - `openMonitor` — the entry's injected business face (`client.ts` passes
 *     `inject: () => ({ openMonitor })`): opens the monitoring tab in the
 *     mounted session's right Sidebar. It returns `null` on success and a
 *     short user-facing line when no session surface is mounted; the line is
 *     rendered on the status seat, never thrown.
 *   - `t` — the locale seat (declared for structural completeness). The panel
 *     renders hardcoded English text (the plugin registers no locale
 *     dictionaries, and unknown keys must not be routed through `t`).
 */
export interface RoleboxRolesPanelProps {
  /** Owner-share seat: closes the settings panel. */
  close?: () => void;
  /** Injected face: opens the right-Sidebar monitoring tab (error line or null). */
  openMonitor?: () => string | null;
  /** Locale seat; accepted, unused (hardcoded English copy). */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Status-seat state: the rendered text plus whether it is an error. */
interface PanelStatus {
  text: string;
  error: boolean;
}

/** Render an error/status message as a string (browser-safe, no node builtins). */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structural record guard (non-null, non-array object). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string guard. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Finite-number guard. */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** String-list guard: non-array and non-string entries are dropped, never fatal. */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Defensive normalization of one role item. Missing or wrong-typed keys
 * degrade to explicit values (never `undefined` in the render tree), so a
 * partially populated or older backend renders a truthful card instead of
 * crashing the page.
 */
function normalizeRole(item: Record<string, unknown>): RoleboxRoleDto {
  const id = asString(item.id) ?? "";
  return {
    id,
    name: asString(item.name) ?? (id !== "" ? id : "Unnamed role"),
    description: asString(item.description) ?? "",
    model: asString(item.model),
    mode: asString(item.mode),
    // A non-object policy is "none declared"; a present policy always carries
    // both halves (the host route guarantees it, and a malformed body that
    // does not still gets an explicit empty half).
    tools: isRecord(item.tools)
      ? { allow: asStringList(item.tools.allow), deny: asStringList(item.tools.deny) }
      : null,
    maxSteps: asNumber(item.maxSteps),
  };
}

/**
 * Defensive normalization of the whole `GET /rolebox/roles` body: a bare
 * array of role records. A body that is not an array is NOT normalized here —
 * the caller treats it as an invalid response, because silently rendering an
 * empty list would claim "no roles are loaded" about a payload that says
 * nothing of the sort.
 */
export function normalizeRoles(body: unknown): RoleboxRoleDto[] {
  if (!Array.isArray(body)) return [];
  const roles: RoleboxRoleDto[] = [];
  for (const item of body) {
    if (isRecord(item)) roles.push(normalizeRole(item));
  }
  return roles;
}

// ── Section renderers ──────────────────────────────────────────────────────

/** A role value with its explicit fallback ("default" / "primary"). */
function renderValue(value: string | null, fallback: string) {
  if (value === null) {
    return <span className={rolesClass.fallback}>{fallback}</span>;
  }
  return (
    <span className={rolesClass.value} title={value}>
      {value}
    </span>
  );
}

/**
 * One tool-policy half: the COUNT is always visible (that is the summary), the
 * names follow compactly, and a list longer than {@link TOOL_NAME_LIMIT} caps
 * with the untruncated list in the row's `title`. An empty half says "none"
 * rather than rendering nothing — an absent row would be indistinguishable
 * from "this half was not reported".
 */
function renderToolRow(label: string, names: string[]) {
  const full = names.join(", ");
  const capped =
    names.length > TOOL_NAME_LIMIT
      ? names.slice(0, TOOL_NAME_LIMIT).join(", ") +
        " +" +
        (names.length - TOOL_NAME_LIMIT) +
        " more"
      : full;
  return (
    <div className={rolesClass.toolRow}>
      <span className={rolesClass.toolLabel}>
        {label} ({names.length})
      </span>
      {names.length === 0 ? (
        <span className={rolesClass.toolEmpty}>none</span>
      ) : (
        <span className={rolesClass.toolNames} title={full}>
          {capped}
        </span>
      )}
    </div>
  );
}

/** The card's tool-policy block, including the explicit "none declared" state. */
function renderToolPolicy(tools: RoleboxRoleToolsDto | null) {
  if (tools === null) {
    return <p className={rolesClass.toolsNone}>Tool policy: none declared</p>;
  }
  return (
    <div className={rolesClass.tools}>
      <span className={rolesClass.toolsTitle}>Tool policy</span>
      {renderToolRow("Allow", tools.allow)}
      {renderToolRow("Deny", tools.deny)}
    </div>
  );
}

/**
 * One role card. Plain render function (called directly, not as a JSX
 * component — the dock convention keeps the render tree flat).
 */
function renderRoleCard(role: RoleboxRoleDto, index: number) {
  return (
    <article
      className={rolesClass.card}
      key={(role.id === "" ? "role" : role.id) + "-" + index}
    >
      <div className={rolesClass.cardHead}>
        <h2 className={rolesClass.roleName} title={role.name}>
          {role.name}
        </h2>
        <span
          className={rolesClass.roleId}
          title={role.id === "" ? "no id reported" : role.id}
        >
          {role.id === "" ? "no id reported" : role.id}
        </span>
      </div>
      <p
        className={rolesClass.description}
        title={role.description === "" ? "No description" : role.description}
      >
        {role.description === "" ? "No description" : role.description}
      </p>
      <dl className={rolesClass.kv}>
        <div className={rolesClass.kvRow}>
          <dt>Model</dt>
          <dd>{renderValue(role.model, "default")}</dd>
        </div>
        <div className={rolesClass.kvRow}>
          <dt>Mode</dt>
          <dd>{renderValue(role.mode, "primary")}</dd>
        </div>
        <div className={rolesClass.kvRow}>
          <dt>Max steps</dt>
          <dd>
            {role.maxSteps === null ? (
              <span
                className={rolesClass.fallback}
                title="No maxSteps declared on the definition"
              >
                not set
              </span>
            ) : (
              <span className={rolesClass.value}>{role.maxSteps}</span>
            )}
          </dd>
        </div>
      </dl>
      {renderToolPolicy(role.tools)}
    </article>
  );
}

/** The "no roles loaded" state — explicit, never an empty page. */
function renderEmptyState() {
  return <p className={rolesClass.state}>No roles loaded</p>;
}

/**
 * Alert glyph — a 14x14 circled exclamation. State is never carried by colour
 * alone, so the error surface pairs its tint with this glyph and its text.
 * A local SVG: the dock's / monitor's glyphs are deliberately not imported
 * across modules.
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

// ── The panel ──────────────────────────────────────────────────────────────

/**
 * The "Rolebox" settings page: fetches `GET /rolebox/roles` on mount (and on
 * every manual Refresh), renders one card per loaded role, and surfaces
 * loading / error / empty states with a live-region status seat
 * (`role="status"`) and an `aria-busy` page while a request is in flight.
 * The header also carries the manual role-reload control
 * (`POST /rolebox/reload`), the reload's only entry point; it never polls.
 *
 * @param props - composed settings-page props (see {@link RoleboxRolesPanelProps}).
 */
export function RoleboxRolesPanel(props: RoleboxRolesPanelProps) {
  /**
   * `null` means "never rendered": it is what distinguishes the first load
   * (skeleton, alert-capable error state) from a refresh with data on screen.
   */
  const [roles, setRoles] = useState<RoleboxRoleDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PanelStatus>({
    text: "Loading roles…",
    error: false,
  });
  /** Manual-refresh trigger; bumping it re-runs the load effect. */
  const [refreshToken, setRefreshToken] = useState(0);
  /**
   * Manual role-reload trigger (`POST /rolebox/reload`). MANUAL ONLY: the
   * request is issued from the button's click handler and never from a timer
   * or an interval — this page does not poll.
   */
  const [reloading, setReloading] = useState(false);
  /**
   * Confirmation of the last successful role reload, held until the
   * follow-up list fetch lands (that fetch owns the status seat's steady
   * text, so without this hand-off the confirmation would be overwritten by
   * the refresh the reload itself triggered).
   */
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Distinguish the first load from a refresh: the skeleton only substitutes
    // for content that has never rendered, and the seat names which one is
    // happening.
    const isInitialLoad = roles === null;
    // Consume a pending reload confirmation: the fetch that follows a
    // successful reload is what reports it. Clearing it here (not on the
    // success branch) keeps a stale confirmation from resurfacing if this
    // follow-up fetch itself fails.
    const reloadNoticeText = reloadNotice;
    setReloadNotice(null);
    setLoading(true);
    setStatus({
      text: isInitialLoad ? "Loading roles…" : "Refreshing…",
      error: false,
    });

    async function load(): Promise<void> {
      try {
        const res = await fetch(ROLES_ENDPOINT);
        if (cancelled) return;
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = (await res.json().catch(() => null)) as unknown;
        if (cancelled) return;
        // A body that is not the documented bare array is a malformed
        // response, not an empty catalogue — report it instead of claiming
        // "No roles loaded". Per-item malformation is tolerated inside
        // normalizeRoles.
        if (!Array.isArray(data)) throw new Error("Invalid server response");
        const next = normalizeRoles(data);
        setRoles(next);
        setStatus({
          text:
            reloadNoticeText ??
            "Loaded " +
              next.length +
              (next.length === 1 ? " role" : " roles") +
              " · " +
              new Date().toLocaleTimeString(),
          error: false,
        });
      } catch (err) {
        if (!cancelled) {
          setStatus({
            text: "Failed to load roles: " + toMessage(err),
            error: true,
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  /**
   * Re-fetch the role list. Guarded against re-entry: a refresh while a
   * request is in flight (or a reload is running) is ignored, so one gesture
   * can never queue two overlapping loads.
   */
  const refresh = (): void => {
    if (loading || reloading) return;
    setRefreshToken((count) => count + 1);
  };

  /**
   * Reload roles: POST the in-process reload route, then re-fetch the role
   * list. MANUAL ONLY — this runs from the button's click handler and nothing
   * else; no timer and no interval is ever scheduled.
   *
   * This is NOT the dock's client-side `reload()` (`role-switch-dock.tsx`),
   * which merely re-reads the role list over GET. This control is a different
   * concern: it asks the server to re-discover and re-resolve roles from disk
   * and refresh every consumer of the previous role state. The two are
   * deliberately not merged.
   *
   * A failed reload leaves the rendered list untouched (the server preserved
   * its state too), so the failure is reported on the status seat without a
   * follow-up fetch.
   */
  const reloadRoles = async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    setStatus({ text: "Reloading roles…", error: false });
    try {
      const res = await fetch(RELOAD_ENDPOINT, { method: "POST" });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        // The route's stable error shape is { ok: false, error, disabled? };
        // a bodyless failure degrades to the HTTP status.
        const message =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "HTTP " + res.status;
        setStatus({ text: "Role reload failed: " + message, error: true });
        return;
      }
      const record = isRecord(body) ? body : {};
      setReloadNotice(
        "Reloaded roles — " +
          (asNumber(record.discovered) ?? 0) +
          " discovered, " +
          (asNumber(record.resolved) ?? 0) +
          " resolved, " +
          (asNumber(record.skipped) ?? 0) +
          " skipped",
      );
      // Re-fetch the list through the same path the Refresh control uses; the
      // notice rides that fetch so the seat reports the outcome.
      setRefreshToken((count) => count + 1);
    } catch (err) {
      setStatus({ text: "Role reload failed: " + toMessage(err), error: true });
    } finally {
      setReloading(false);
    }
  };

  /**
   * Open the monitoring tab: close the settings shell first (so the tab is not
   * opened underneath a covering panel), then ask the injected face to open
   * it. A non-null return is the face's user-facing failure line — it is
   * rendered on the status seat, never thrown.
   */
  const openMonitorTab = (): void => {
    props.close?.();
    const failure = props.openMonitor?.() ?? null;
    if (failure !== null) setStatus({ text: failure, error: true });
  };

  // Body posture: a skeleton only while nothing has rendered; the alert state
  // only when there is no data to fall back on (a refresh failure with data
  // reports on the status seat instead); otherwise the cards or the explicit
  // empty state.
  let body: unknown;
  if (loading && roles === null) {
    // The header status seat is the page's ONLY live region, so the skeleton
    // is decorative (aria-hidden) and never double-announces the load.
    body = (
      <div className={rolesClass.skeleton} aria-hidden="true">
        <div className={rolesClass.skeletonCard}>
          <span className={rolesClass.skeletonBarWide} />
          <span className={rolesClass.skeletonBarHalf} />
        </div>
        <div className={rolesClass.skeletonCard}>
          <span className={rolesClass.skeletonBarWide} />
          <span className={rolesClass.skeletonBar} />
          <span className={rolesClass.skeletonBar} />
          <span className={rolesClass.skeletonBar} />
        </div>
      </div>
    );
  } else if (status.error && roles === null) {
    body = (
      <div
        className={rolesClass.state + " " + rolesClass.stateError}
        role="alert"
      >
        <span className={rolesClass.alertGlyph} aria-hidden="true">
          <AlertGlyph />
        </span>
        <span className={rolesClass.errorText}>{status.text}</span>
        <button type="button" className={rolesClass.retry} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  } else if (roles === null || roles.length === 0) {
    body = renderEmptyState();
  } else {
    body = <div className={rolesClass.body}>{roles.map(renderRoleCard)}</div>;
  }

  return (
    <div
      className="rolebox-roles"
      data-rolebox-roles
      aria-busy={loading || reloading}
    >
      <header className={rolesClass.header}>
        <h1 className={rolesClass.title}>Rolebox</h1>
        <span className={rolesClass.count}>
          {roles === null
            ? "…"
            : roles.length + (roles.length === 1 ? " role" : " roles")}
        </span>
        <button
          type="button"
          className={rolesClass.refresh}
          disabled={loading || reloading}
          onClick={refresh}
        >
          {loading && (
            <span className={rolesClass.spinner} aria-hidden="true" />
          )}
          Refresh
        </button>
        <button
          type="button"
          className={rolesClass.reload}
          disabled={loading || reloading}
          onClick={() => void reloadRoles()}
        >
          {reloading && (
            <span className={rolesClass.spinner} aria-hidden="true" />
          )}
          Reload roles
        </button>
        <button
          type="button"
          className={rolesClass.openMonitor}
          onClick={openMonitorTab}
        >
          Open monitor
        </button>
        {/* The live region is a text seat and never wraps a control: an
            announced control would be re-read on every refresh. */}
        <span
          role="status"
          title={status.text}
          className={
            status.error
              ? rolesClass.status + " " + rolesClass.statusError
              : rolesClass.status
          }
        >
          {status.text}
        </span>
      </header>
      {body}
    </div>
  );
}
