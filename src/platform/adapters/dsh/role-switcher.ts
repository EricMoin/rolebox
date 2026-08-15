/**
 * DshRoleSwitcher — in-session "switch active role" capability for the dsh
 * (DeepSeek Harness) platform.
 *
 * dsh is a multi-session, web-driven harness with no built-in agent picker on
 * the session surface. rolebox already resolves every role into an
 * {@link AgentDefinition} and registers them on the {@link DshAgentRegistrar}
 * (as `SubagentProvider`s into `ctx.subagents`). This module turns that
 * registry into a per-session role switcher consumed structurally through the
 * dsh seam:
 *
 *   - {@link DshRoleSwitcher.listRoles} — the switchable targets (primary
 *     roles only, sorted by id)
 *   - {@link DshRoleSwitcher.activate}   — switch to a role / clear it
 *   - {@link DshRoleSwitcher.getActive}  — the active role for a session
 *
 * What "switching" does on dsh (mirrors the Pi adapter's role switcher, with
 * platform-specific differences):
 *
 *   1. **Per-session state** — the chosen role id is recorded immediately in
 *      a per-session holder (an exposed {@link ActiveRoleRef}, the
 *      session-aware sibling of Pi's `ActiveAgentRef`). The holder is the
 *      single shared source of truth for the switch: `DshAgentRegistrar`
 *      reads it at spawn time (`buildProvider().start()` consults
 *      `request.sessionId`) to apply the active role's system prompt and
 *      model override to spawned agents, and the web role-switch surface
 *      reads/writes it for the UI.
 *   2. **Persistence** — a log-only session event (`rolebox/active-role`,
 *      data `{ id }`) is appended via `session.append(type, data, opts)`
 *      WITHOUT a `surfaceOp`, per the log-only vocabulary in
 *      `docs/dsh-plugin-contract.md` §4.1.
 *   3. **Restore** — a `ctx.on("session/created")` listener scans the new
 *      session's event log and restores the last persisted active role
 *      (covers seeds / forks / resume that carry the log forward).
 *
 * The dsh platform has no per-turn system-prompt hook (`system-transform`
 * is a documented no-op at the hook level in hook-provider.ts: dsh composes
 * the model-facing system prompt from its mounted `systemPrompt` service,
 * §3.1). Session-level injection now flows through {@link DshSystemPromptAdapter}
 * (system-prompt.ts — the `rolebox:role` section + `rolebox:context` entry,
 * resolved per-session via `context.agent.id`). Spawn-time application for
 * subagents lives in {@link DshAgentRegistrar} (shared {@link ActiveRoleRef},
 * wired in `src/dsh-plugin.ts`): the switcher owns write/restore; the
 * registrar and the prompt adapter own the read side.
 *
 * The dsh surface is consumed structurally (duck typing). This module does
 * NOT import `@deepseek-ai/*` (or `@opencode-ai/*`).
 *
 * @module
 */

import { RoleMode } from "../../../constants.ts";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { AgentDefinition } from "../../types.ts";
import type { DshAgentRegistrar } from "./agent-registrar.ts";
import type { DshCordisContext } from "./event-bridge.ts";
import type {
  DshSessionEventLike,
  DshSessionLike,
  DshSessionStoreLike,
} from "./session.ts";

/** Session event type used to persist the active role (log-only, §4.1). */
export const ACTIVE_ROLE_EVENT = "rolebox/active-role";

/**
 * Session-aware mutable holder for the currently active role — the dsh
 * sibling of the Pi adapter's {@link ActiveAgentRef} pattern.
 *
 * `null` (or an absent session key) means "base agent": no rolebox role is
 * active for that session.
 */
export interface ActiveRoleRef {
  /** Return the active role id for a session, or `null` for the base agent. */
  get(sessionId: string): string | null;
  /** Set the active role id for a session, or `null` to clear back to base. */
  set(sessionId: string, id: string | null): void;
}

/**
 * Create an {@link ActiveRoleRef} backed by a per-session Map.
 *
 * @returns A fresh, independent holder.
 */
export function createActiveRoleRef(): ActiveRoleRef {
  const bySession = new Map<string, string>();
  return {
    get: (sessionId) => bySession.get(sessionId) ?? null,
    set: (sessionId, id) => {
      if (id === null) {
        bySession.delete(sessionId);
      } else {
        bySession.set(sessionId, id);
      }
    },
  };
}

/**
 * Options for constructing a {@link DshRoleSwitcher}.
 */
export interface DshRoleSwitcherOptions {
  /** Registry holding all resolved agent definitions (roles + subagents). */
  registrar: DshAgentRegistrar;
  /** The dsh SessionStore (`ctx.sessions`) used to persist the active role. */
  store: DshSessionStoreLike;
  /** Structural cordis context (`ctx.on` / `ctx.emit`) for lifecycle listeners. */
  ctx: DshCordisContext;
  /**
   * Shared per-session active-role holder (ActiveAgentRef-style). When
   * omitted, a private holder is created. The holder is always exposed via
   * {@link DshRoleSwitcher.activeRole}, so external consumers (e.g. a web
   * role-switch server) can read the current state and keep it in sync.
   */
  activeRole?: ActiveRoleRef;
}

/**
 * In-session active-role switcher for the dsh platform.
 *
 * Keeps the currently active role per session, persists each switch as a
 * log-only `rolebox/active-role` session event (no surfaceOp), and restores
 * the last persisted role when a session is created (seeds / forks / resume).
 *
 * All state mutations are defensive: an unknown session in the store or an
 * append failure degrades to a debug log — validation only rejects an unknown
 * or non-primary role id, per {@link activate}.
 */
export class DshRoleSwitcher {
  /** Exposed per-session active-role holder (backed by a per-session Map). */
  readonly activeRole: ActiveRoleRef;

  private readonly registrar: DshAgentRegistrar;
  private readonly store: DshSessionStoreLike;
  /** Cordis disposers returned by `ctx.on` — released by `dispose()`. */
  private readonly disposers: Array<() => void> = [];
  private readonly _log;

  /**
   * @param options - See {@link DshRoleSwitcherOptions}.
   */
  constructor(options: DshRoleSwitcherOptions) {
    this.registrar = options.registrar;
    this.store = options.store;
    this.activeRole = options.activeRole ?? createActiveRoleRef();
    this._log = createSubLogger("dsh-role-switcher");
    this.wireRestore(options.ctx);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * List the switchable roles — primary-mode roles only, sorted by id.
   *
   * Subagent-mode roles are deliberately excluded: switching targets are the
   * top-level roles, matching the Pi adapter's switcher.
   *
   * @returns The switchable agent definitions, sorted by id ascending.
   */
  listRoles(): AgentDefinition[] {
    return this.registrar
      .getRegisteredAgents()
      .filter((a) => (a.mode ?? RoleMode.Primary) === RoleMode.Primary)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Return the active role id for a session, or `null` when no role is active
   * (base agent).
   *
   * @param sessionId - The dsh session id.
   * @returns The active role id, or `null`.
   */
  getActive(sessionId: string): string | null {
    return this.activeRole.get(sessionId);
  }

  /**
   * Activate a role for a session, or clear the active role when `roleId` is
   * `null`.
   *
   * Validates that the role exists in the current catalog and is a primary
   * role. On success the per-session holder is updated and a log-only
   * `rolebox/active-role` event with data `{ id }` is appended to the
   * session's event log (no surfaceOp). The event append is best-effort: an
   * unknown session or an append failure is logged and does not fail the
   * switch.
   *
   * @param roleId    - Role id to activate, or `null` to clear.
   * @param sessionId - The dsh session id the switch applies to.
   * @returns `{ ok: true }` on success, or `{ ok: false, error }` when the
   *          role is unknown or not primary.
   */
  async activate(
    roleId: string | null,
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (roleId === null) {
      this.activeRole.set(sessionId, null);
      this.appendActiveRole(sessionId, null);
      this._log.info("Active role cleared", { sessionId });
      return { ok: true };
    }

    const role = this.registrar.getRegisteredAgents().find((a) => a.id === roleId);
    if (!role) {
      return { ok: false, error: `Unknown role: ${roleId}` };
    }
    if ((role.mode ?? RoleMode.Primary) !== RoleMode.Primary) {
      return { ok: false, error: `Role '${roleId}' is not a primary role` };
    }

    this.activeRole.set(sessionId, role.id);
    this.appendActiveRole(sessionId, role.id);
    this._log.info("Active role switched", { sessionId, role: role.id });
    return { ok: true };
  }

  /**
   * Unsubscribe every cordis listener registered by this switcher.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    const disposers = this.disposers.splice(0);
    for (const disposer of disposers) {
      try {
        disposer();
      } catch (err) {
        this._log.debug("dsh role-switcher disposer failed", {
          error: formatError(err),
        });
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  /**
   * Append a log-only `rolebox/active-role` event for the session.
   *
   * `rolebox/active-role` is not a surface event type, so no `surfaceOp` is
   * passed (log-only vocabulary, `docs/dsh-plugin-contract.md` §4.1). The
   * append is defensive: missing sessions and append errors are logged and
   * the switch itself still succeeds.
   */
  private appendActiveRole(sessionId: string, id: string | null): void {
    try {
      const session = this.store.get(sessionId);
      if (!session) {
        this._log.debug("Active-role event not appended — session not found", {
          sessionId,
        });
        return;
      }
      session.append(ACTIVE_ROLE_EVENT, { id }, {});
    } catch (err) {
      this._log.debug("Active-role event append failed", {
        sessionId,
        error: formatError(err),
      });
    }
  }

  /**
   * Subscribe `session/created` and restore the last persisted active role
   * for the new session by scanning its event log.
   *
   * A brand-new session has no active-role events and is left untouched. A
   * persisted role is restored only when it still exists in the current
   * catalog and is a primary role; a stale or cleared (`{ id: null }`)
   * selection is restored as the base agent.
   */
  private wireRestore(ctx: DshCordisContext): void {
    const disposer = ctx.on("session/created", (payload: unknown) => {
      try {
        const session = resolveSession(payload, this.store);
        if (!session) return;

        const restoredId = scanActiveRole(session.events);
        if (restoredId === undefined) return; // nothing persisted for this session

        if (restoredId === null) {
          this.activeRole.set(session.id, null);
          return;
        }

        const role = this.registrar
          .getRegisteredAgents()
          .find((a) => a.id === restoredId);
        if (!role || (role.mode ?? RoleMode.Primary) !== RoleMode.Primary) {
          // Role no longer registered, or no longer switchable — clear the
          // stale selection rather than restoring it.
          this.activeRole.set(session.id, null);
          return;
        }

        this.activeRole.set(session.id, restoredId);
        this._log.info("Restored active role from session events", {
          sessionId: session.id,
          role: restoredId,
        });
      } catch (err) {
        this._log.debug("session/created restore failed", {
          error: formatError(err),
        });
      }
    });
    if (disposer) this.disposers.push(disposer);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the created Session from the raw `session/created` listener args.
 *
 * The dsh session service emits the Session object itself; tests and forks
 * may deliver an id string or a descriptor instead. Falls back to a store
 * lookup whenever only an id is available.
 */
function resolveSession(
  payload: unknown,
  store: DshSessionStoreLike,
): DshSessionLike | undefined {
  if (isRecord(payload)) {
    if (typeof payload.id === "string" && Array.isArray(payload.events)) {
      return payload as unknown as DshSessionLike;
    }
    if (typeof payload.sessionID === "string") {
      return store.get(payload.sessionID);
    }
    if (typeof payload.id === "string") {
      return store.get(payload.id);
    }
  }
  if (typeof payload === "string") {
    return store.get(payload);
  }
  return undefined;
}

/**
 * Scan a session's event log for `rolebox/active-role` events and return the
 * LAST persisted selection.
 *
 * @param events - The session's event log.
 * @returns The last role id (string), `null` for the most recent explicit
 *          clear, or `undefined` when no active-role event exists at all.
 */
function scanActiveRole(
  events: readonly DshSessionEventLike[],
): string | null | undefined {
  let last: string | null | undefined;
  for (const evt of events) {
    if (evt.type !== ACTIVE_ROLE_EVENT) continue;
    const data = isRecord(evt.data) ? evt.data : {};
    last = typeof data.id === "string" ? data.id : null;
  }
  return last;
}
