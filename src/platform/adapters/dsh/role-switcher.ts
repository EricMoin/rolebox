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
 *   2. **Persistence (sidecar remedy)** — durability lives in a rolebox-owned
 *      sidecar under `.rolebox/state` (see {@link ActiveRolePersistence},
 *      backed by `active-role-store.ts`), NOT in the dsh session event log.
 *      The former `rolebox/active-role` session event was removed: rc.6
 *      persistence refuses to reload an unknown event type that lacks the
 *      `ignorable: true` marker, and there is no public `append()` option to
 *      set it (). The holder is
 *      hydrated synchronously from the sidecar at construction, every mutation
 *      is written back asynchronously (best-effort), and the harness
 *      `session/flush` checkpoint drains the sidecar durably
 *      ({@link ActiveRoleRef.flush}, bounded + non-throwing). The plugin fiber
 *      disposer additionally performs a final synchronous write
 *      (`ActiveRoleStore.saveSync`) on shutdown.
 *   3. **Restore** — a `ctx.on("session/created")` listener resolves the new
 *      session's selection with a fixed precedence: (1) its own sidecar entry
 *      (including an explicit clear); (2) a read-only scan of its own log for
 *      a previous `rolebox/active-role` event, adopted into the sidecar; (3) a
 *      fork with neither inherits its parent's selection through the durable
 *      `header.parentSession`. The session log is never written. A
 *      stale selection (role no longer registered, or no longer primary) is
 *      cleared rather than restored.
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
import { err, ok, type Result } from "../../../utils/result.ts";
import type { AgentDefinition } from "../../types.ts";
import type { ActiveRoleEntry } from "./active-role-store.ts";
import type { DshAgentRegistrar } from "./agent-registrar.ts";
import type { DshCordisContext } from "./event-bridge.ts";
import type {
  DshSessionEventLike,
  DshSessionLike,
  DshSessionStoreLike,
} from "./session.ts";
/** Module logger for the persistence seam owned by {@link createActiveRoleRef}. */
const log = createSubLogger("dsh-active-role");

/**
 * Legacy session-event type rolebox appended before the sidecar. It is read ONLY to
 * adopt a pre-sidecar selection into the sidecar on first sight; rolebox never
 * writes this type again (rc.6 persistence refuses to reload it without the
 * `ignorable` marker — see the module doc).
 */
const LEGACY_ACTIVE_ROLE_EVENT = "rolebox/active-role";

/**
 * Upper bound (ms) on a `session/flush` sidecar drain. The harness flush must
 * never block on a slow/unresponsive disk, so the flush handler races the
 * persist against this timeout and resolves regardless.
 */
export const ACTIVE_ROLE_FLUSH_TIMEOUT_MS = 2000;

/**
 * Persistence seam for the active-role sidecar.
 *
 * Declared here (rather than importing the concrete {@link ActiveRoleStore})
 * so the switcher depends on an injected interface; the file-backed store in
 * `active-role-store.ts` satisfies it structurally, and the concrete wiring
 * lives in `src/dsh-plugin.ts`. All methods are synchronous on read and
 * best-effort on write — persistence must never fail a role switch.
 */
export interface ActiveRolePersistence {
  /**
   * Synchronously load the persisted session→role selections.
   *
   * @returns A session-keyed map, or `null` when nothing usable was read.
   */
  load(): Map<string, ActiveRoleEntry> | null;
  /**
   * Persist the full session-keyed map. Async implementations serialize their
   * own writes; the caller does not await (the in-memory holder is
   * authoritative for the running process).
   *
   * @param sessions - The holder's current state (mutated in place thereafter).
   */
  save(sessions: Map<string, ActiveRoleEntry>): Promise<void> | void;
}

/**
 * Session-aware mutable holder for the currently active role — the dsh
 * sibling of the Pi adapter's {@link ActiveAgentRef} pattern.
 *
 * `get` is a synchronous in-memory read (safe to call from spawn/prompt hot
 * paths). `null` (or an absent session key) means "base agent": no rolebox
 * role is active for that session. `set` updates memory synchronously and
 * schedules an asynchronous sidecar write when the holder was created with a
 * {@link ActiveRolePersistence}.
 */
export interface ActiveRoleRef {
  /** Return the active role id for a session, or `null` for the base agent. */
  get(sessionId: string): string | null;
  /**
   * True when the holder has an explicit entry for `sessionId` — including an
   * explicit clear (`get` returns `null`). Distinguishes "a record says base
   * agent" from "no record at all", which the restore precedence needs in
   * order to fall back to a legacy event only when the sidecar is silent.
   */
  has(sessionId: string): boolean;
  /** Set the active role id for a session, or `null` to clear back to base. */
  set(sessionId: string, id: string | null): void;
  /**
   * Snapshot the full session→entry map (a shallow copy). The shutdown path
   * hands this to a synchronous store write; the copy keeps the holder's live
   * map private from the caller.
   */
  snapshot(): Map<string, ActiveRoleEntry>;
  /**
   * Await a durable persist of the current map. Bounded (races
   * {@link ACTIVE_ROLE_FLUSH_TIMEOUT_MS}) and non-throwing — a slow or failing
   * sidecar write resolves normally so the harness `session/flush` never blocks
   * or errors on it.
   */
  flush(): Promise<void>;
}

/**
 * Create an {@link ActiveRoleRef} backed by a per-session Map.
 *
 * When `persistence` is supplied the map is hydrated synchronously from
 * `persistence.load()` at construction (so readers see the restored selection
 * immediately), and each `set` writes the map back through `persistence.save`
 * fire-and-forget. A load failure degrades to an empty in-memory map.
 *
 * @param persistence - Optional sidecar persistence seam.
 * @returns A fresh, independent holder.
 */
export function createActiveRoleRef(
  persistence?: ActiveRolePersistence,
): ActiveRoleRef {
  let bySession: Map<string, ActiveRoleEntry>;
  try {
    bySession = persistence?.load() ?? new Map<string, ActiveRoleEntry>();
  } catch (err) {
    log.debug("active-role sidecar load failed — starting empty", {
      error: formatError(err),
    });
    bySession = new Map<string, ActiveRoleEntry>();
  }

  return {
    get: (sessionId) => bySession.get(sessionId)?.roleId ?? null,
    has: (sessionId) => bySession.has(sessionId),
    set: (sessionId, id) => {
      bySession.set(sessionId, { sessionId, roleId: id, updatedAt: Date.now() });
      if (!persistence) return;
      try {
        // Best-effort async write: the in-memory map is authoritative for the
        // running process, so a slow/failed write must not fail the switch.
        void persistence.save(bySession);
      } catch (err) {
        log.debug("active-role sidecar save failed", {
          error: formatError(err),
        });
      }
    },
    snapshot: () => new Map(bySession),
    flush: () => flushSidecar(persistence, bySession),
  };
}

/**
 * Drain the sidecar through `persistence.save`, bounded and non-throwing.
 *
 * The write is started inside an async closure so a synchronously-throwing
 * `save` becomes a rejection (not an exception out of `flush`), then raced
 * against {@link ACTIVE_ROLE_FLUSH_TIMEOUT_MS}. A no-op when no persistence is
 * configured.
 */
async function flushSidecar(
  persistence: ActiveRolePersistence | undefined,
  bySession: Map<string, ActiveRoleEntry>,
): Promise<void> {
  if (!persistence) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = (async () => {
      await persistence.save(bySession);
    })();
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ACTIVE_ROLE_FLUSH_TIMEOUT_MS);
      // A bounded flush must never keep the process alive.
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([write, timeout]);
  } catch (err) {
    log.debug("active-role sidecar flush failed", { error: formatError(err) });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Options for constructing a {@link DshRoleSwitcher}.
 */
export interface DshRoleSwitcherOptions {
  /** Registry holding all resolved agent definitions (roles + subagents). */
  registrar: DshAgentRegistrar;
  /**
   * The dsh SessionStore (`ctx.sessions`), used by the `session/created`
   * restore listener to resolve a session (and its `header.parentSession`) from
   * an id-only payload.
   */
  store: DshSessionStoreLike;
  /** Structural cordis context (`ctx.on` / `ctx.emit`) for lifecycle listeners. */
  ctx: DshCordisContext;
  /**
   * Shared per-session active-role holder (ActiveAgentRef-style). When
   * omitted, a private in-memory holder is created. The holder is always
   * exposed via {@link DshRoleSwitcher.activeRole}, so external consumers
   * (e.g. a web role-switch server) can read the current state and keep it in
   * sync. Pass the SAME holder (created with the sidecar persistence) that the
   * registrar and prompt adapter read.
   */
  activeRole?: ActiveRoleRef;
  /**
   * Optional refresh hook invoked once after every APPLIED active-role change:
   * a switch ({@link DshRoleSwitcher.activate}), an explicit clear, or a
   * restore on `session/created` (which changes the candidate role set just as
   * a switch does). The dsh plugin wires this to the lazy skill provider's
   * `invalidate()` so the `ctx.skills` catalog is refreshed whenever the active
   * role set changes.
   *
   * Best-effort: a throwing hook is contained by a debug log and never fails
   * the switch. Invoked exactly once per applied change.
   */
  onActiveRoleChanged?: (sessionId: string, roleId: string | null) => void;
}

/**
 * In-session active-role switcher for the dsh platform.
 *
 * Keeps the currently active role per session in the shared holder, persists
 * each switch through the holder's sidecar seam, and re-validates the restored
 * selection when a session is created (seeds / forks / resume).
 *
 * All state mutations are defensive: an unknown session in the store or a
 * failed sidecar write degrades to a debug log — validation only rejects an
 * unknown or non-primary role id, per {@link activate}.
 */
export class DshRoleSwitcher {
  /** Exposed per-session active-role holder (backed by a per-session Map). */
  readonly activeRole: ActiveRoleRef;

  private readonly registrar: DshAgentRegistrar;
  private readonly store: DshSessionStoreLike;
  /** Optional refresh hook fired once per applied active-role change. */
  private readonly onActiveRoleChanged:
    | ((sessionId: string, roleId: string | null) => void)
    | undefined;
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
    this.onActiveRoleChanged = options.onActiveRoleChanged;
    this._log = createSubLogger("dsh-role-switcher");
    this.wireRestore(options.ctx);
    this.wireFlush(options.ctx);
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
   * role. On success the per-session holder is updated (memory synchronously,
   * sidecar asynchronously via the holder's persistence seam). The write is
   * best-effort: a failed sidecar save is logged and does not fail the switch.
   *
   * @param roleId    - Role id to activate, or `null` to clear.
   * @param sessionId - The dsh session id the switch applies to.
   * @returns `ok()` on success, or `err(...)` with the reason when the role
   *          is unknown or not primary.
   */
  async activate(
    roleId: string | null,
    sessionId: string,
  ): Promise<Result<void, string>> {
    if (roleId === null) {
      this.activeRole.set(sessionId, null);
      this._log.info("Active role cleared", { sessionId });
      this.notifyActiveRoleChanged(sessionId, null);
      return ok();
    }

    const role = this.registrar.getRegisteredAgents().find((a) => a.id === roleId);
    if (!role) {
      return err(`Unknown role: ${roleId}`);
    }
    if ((role.mode ?? RoleMode.Primary) !== RoleMode.Primary) {
      return err(`Role '${roleId}' is not a primary role`);
    }

    this.activeRole.set(sessionId, role.id);
    this._log.info("Active role switched", { sessionId, role: role.id });
    this.notifyActiveRoleChanged(sessionId, role.id);
    return ok();
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
   * Fire the optional {@link DshRoleSwitcherOptions.onActiveRoleChanged} hook.
   *
   * Called exactly once after each applied active-role change (switch, clear,
   * restore). Best-effort: a throwing hook is logged at debug and swallowed so
   * a refresh concern can never fail the role change itself.
   */
  private notifyActiveRoleChanged(sessionId: string, roleId: string | null): void {
    if (!this.onActiveRoleChanged) return;
    try {
      this.onActiveRoleChanged(sessionId, roleId);
    } catch (err) {
      this._log.debug("onActiveRoleChanged hook failed", {
        error: formatError(err),
      });
    }
  }

  /**
   * Subscribe `session/created` and restore the active role for the new
   * session, honoring the three-source precedence:
   *
   *   1. **sidecar entry** — an explicit record for this session (a role id,
   *      or an explicit `null` clear) always wins.
   *   2. **read-only legacy-event adoption** — when the sidecar is silent, the
   *      session's own log is scanned for a legacy `rolebox/active-role` event
   *      and the last selection is adopted into the sidecar. The log itself is
   *      never written (rc.6 would refuse to reload it — ).
   *   3. **fork inheritance** — a session with neither source inherits its
   *      parent's selection through the durable `header.parentSession`; the
   *      parent is resolved from the store and read with the same 1→2 order.
   *
   * A restored role is kept only when it still exists in the current catalog
   * and is primary; a stale selection (or an explicit clear) resolves to the
   * base agent. An adopted or inherited selection is recorded under the new
   * session id via the holder's sidecar seam — never in the session log.
   */
  private wireRestore(ctx: DshCordisContext): void {
    const disposer = ctx.on("session/created", (payload: unknown) => {
      try {
        const session = resolveSession(payload, this.store);
        if (!session) return;

        // (1) sidecar entry → (2) legacy-event adoption for this session.
        let restoredId = this.readPersistedRole(session);
        let inheritedFrom: string | undefined;

        // (3) fork inheritance — only when this session has no own selection.
        if (restoredId === undefined) {
          const parentId = resolveParentSessionId(session);
          if (!parentId) return; // nothing persisted for this session
          const parent = this.store.get(parentId);
          restoredId = parent
            ? this.readPersistedRole(parent)
            : this.activeRole.has(parentId)
              ? this.activeRole.get(parentId)
              : undefined;
          inheritedFrom = parentId;
        }
        if (restoredId === undefined) return; // nothing persisted for this session

        const role = this.registrar
          .getRegisteredAgents()
          .find((a) => a.id === restoredId);
        if (!role || (role.mode ?? RoleMode.Primary) !== RoleMode.Primary) {
          // Role no longer registered, or no longer switchable — clear the
          // stale selection rather than restoring it.
          this.activeRole.set(session.id, null);
          this.notifyActiveRoleChanged(session.id, null);
          return;
        }

        // Re-set through the holder so an adopted (legacy) or inherited (fork)
        // selection is recorded under the new session id in the sidecar. This
        // never appends to the session event log.
        this.activeRole.set(session.id, restoredId);
        this._log.info(
          inheritedFrom
            ? "Restored active role from parent session"
            : "Restored active role from sidecar/legacy events",
          {
            sessionId: session.id,
            role: restoredId,
            ...(inheritedFrom ? { parentSession: inheritedFrom } : {}),
          },
        );
        this.notifyActiveRoleChanged(session.id, restoredId);
      } catch (err) {
        this._log.debug("session/created restore failed", {
          error: formatError(err),
        });
      }
    });
    if (disposer) this.disposers.push(disposer);
  }

  /**
   * Subscribe `session/flush` and drain the active-role sidecar.
   *
   * The harness emits `session/flush` when it flushes a session's log
   * (`dsh-plugin-contract.md` §4.1: "Persistence is a plugin concern: ...
   * drain on `session/flush`"), so it is the durable checkpoint for the
   * workspace sidecar. The whole session-keyed map is persisted (not just the
   * flushed session) because the sidecar is workspace-scoped. The drain is
   * bounded and non-throwing — a slow or failing write must never block or
   * break the harness flush.
   */
  private wireFlush(ctx: DshCordisContext): void {
    const disposer = ctx.on("session/flush", () => {
      void this.activeRole.flush().catch((err) => {
        this._log.debug("session/flush active-role persist failed", {
          error: formatError(err),
        });
      });
    });
    if (disposer) this.disposers.push(disposer);
  }

  /**
   * Read a session's persisted selection, honoring the restore source order:
   * the sidecar entry (including an explicit `null` clear) wins; otherwise the
   * session's own legacy `rolebox/active-role` events are scanned read-only.
   *
   * @param session - The session whose selection to read.
   * @returns The persisted role id, `null` for an explicit clear, or
   *          `undefined` when neither source has a record.
   */
  private readPersistedRole(session: DshSessionLike): string | null | undefined {
    if (this.activeRole.has(session.id)) return this.activeRole.get(session.id);
    return scanLegacyActiveRole(session.events);
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
 * Resolve a session's durable parent id from its header (rc.6
 * `SessionHeader.parentSession`), used to inherit an active role on fork.
 *
 * @returns The parent session id, or `undefined` when the session is not a
 *          fork (or the field is absent/malformed).
 */
function resolveParentSessionId(session: DshSessionLike): string | undefined {
  const parent = session.header?.parentSession;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

/**
 * Read-only scan of a session's event log for the previous
 * `rolebox/active-role` events, returning the LAST selection. This is an
 * adoption source only: the caller writes the result to the sidecar and never
 * appends to the log.
 *
 * @param events - The session's event log.
 * @returns The last role id (string), `null` for the most recent explicit
 *          clear / malformed payload, or `undefined` when no legacy event
 *          exists at all.
 */
function scanLegacyActiveRole(
  events: readonly DshSessionEventLike[],
): string | null | undefined {
  let last: string | null | undefined;
  for (const evt of events) {
    if (evt.type !== LEGACY_ACTIVE_ROLE_EVENT) continue;
    const data = isRecord(evt.data) ? evt.data : {};
    last = typeof data.id === "string" ? data.id : null;
  }
  return last;
}
