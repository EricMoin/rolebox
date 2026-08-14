/**
 * DshRoleSwitchWebRoute — structural adapter exposing the dsh role
 * switcher's REST surface as a single `prefix` route on dsh's host web
 * server (`@deepseek-ai/dsh-host-webserver`).
 *
 * dsh's host webserver exposes `ctx.webServer.register(route)` where
 *
 *   `WebRoute = { kind: 'exact'|'prefix', path: string, handler:
 *   (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`
 *
 * and `register` returns a disposer. This module consumes that surface
 * structurally (duck typing) — it does NOT import `@deepseek-ai/*` and never
 * creates an HTTP server of its own.
 *
 * Registered route:
 *
 *   - `{ kind: 'prefix', path: '/rolebox', handler }`
 *
 * REST contract under the prefix (migrated 1:1 from the loopback server,
 * paths renamed `/api/*` → `/rolebox/*`):
 *
 *   - `GET    /rolebox/roles`          — JSON array of switchable roles
 *                                        (`id`/`name`/`description`/`model`/
 *                                        `mode`, primary roles only).
 *   - `GET    /rolebox/roles/active`   — `{ session, role }` — the active
 *                                        role id for the session, or `null`
 *                                        for the base agent.
 *   - `POST   /rolebox/roles/switch`   — body `{ role: string, session?:
 *                                        string }`; delegates to
 *                                        {@link DshRoleSwitcher.activate}.
 *   - `DELETE /rolebox/roles/active`   — clear the active role for the
 *                                        session.
 *
 * The `session` key is optional everywhere: an explicit session (body or
 * `?session=` query) wins; otherwise the most recently active session in the
 * SessionStore is used; with no sessions at all the literal key `"default"`
 * is used (the same fallback key the standalone loopback server used).
 *
 * Error contract — identical to the loopback server: every non-2xx response
 * is JSON with the stable shape `{ "ok": false, "error": string }`. Status
 * codes: `400` (malformed JSON, missing `role`, unknown or non-primary
 * role), `404` (unknown route), `405` (known path, wrong method), `413`
 * (request body over the cap), `500` (unexpected failure). 2xx responses are
 * resource-shaped: the roles list is a bare array, `active` is
 * `{ session, role }`, mutations are `{ ok: true, session, role }`.
 *
 * Operational notes:
 *   - Request bodies are capped (default 64 KiB) — oversized bodies are
 *     drained and answered `413`, never buffered.
 *   - The handler never rejects: every branch is guarded so a failing
 *     handler yields a stable `500` JSON error instead of a bare socket
 *     teardown.
 *   - The standalone loopback server module was removed; the DTO types are
 *     defined here so the route surface stays self-contained.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { AgentDefinition } from "../../types.ts";
import type { DshRoleSwitcher } from "./role-switcher.ts";
import type { DshSessionLike, DshSessionStoreLike } from "./session.ts";

/**
 * Serialized switchable role — the `GET /rolebox/roles` list item shape.
 * All five keys are always present; `model` / `mode` are `null` when the
 * definition carries no override (they are optional on
 * {@link AgentDefinition}).
 */
export interface RoleSwitchRoleDto {
  id: string;
  name: string;
  description: string;
  model: string | null;
  mode: string | null;
}

/** Stable error shape for every non-2xx JSON response. */
export interface RoleSwitchErrorBody {
  ok: false;
  error: string;
}

/** Route prefix registered on the dsh host web server. */
export const ROLE_SWITCH_ROUTE_PREFIX = "/rolebox";

/** Fallback session key when no explicit session and no store sessions exist. */
const DEFAULT_SESSION_KEY = "default";

/** Default request-body cap (64 KiB). */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Options for constructing a {@link DshRoleSwitchWebRoute}.
 */
export interface DshRoleSwitchRouteOptions {
  /** Maximum request body size in bytes (default 65536). */
  maxBodyBytes?: number;
  /** Optional sub-logger name override (default `"dsh-role-switch-route"`). */
  loggerName?: string;
}

/**
 * Structural `WebRoute` from `@deepseek-ai/dsh-host-webserver` — consumed by
 * duck typing, never imported from the package.
 */
export interface DshWebRouteLike {
  kind: "exact" | "prefix";
  path: string;
  handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): void | Promise<void>;
}

/**
 * Structural `ctx.webServer` registrar surface from
 * `@deepseek-ai/dsh-host-webserver` — `register(route)` returns a disposer.
 */
export interface DshWebServerRouteRegistrar {
  register(route: DshWebRouteLike): () => void;
}

/**
 * Route adapter exposing the dsh role switcher on the host web server.
 *
 * Construct with the switcher and the session store, then
 * `register(webServer)` to mount the `/rolebox` prefix route; the returned
 * disposer unmounts it. The handler is also exposed directly as
 * {@link DshRoleSwitchWebRoute.handle} for tests and non-HTTP callers.
 */
export class DshRoleSwitchWebRoute {
  private readonly switcher: DshRoleSwitcher;
  private readonly store: DshSessionStoreLike;
  private readonly maxBodyBytes: number;
  private readonly _log;

  /**
   * @param switcher - The dsh role switcher this route delegates to.
   * @param store    - The dsh SessionStore used to resolve the most recent
   *                   session when no explicit session is supplied.
   * @param options  - Optional tuning (body cap / logger name).
   */
  constructor(
    switcher: DshRoleSwitcher,
    store: DshSessionStoreLike,
    options: DshRoleSwitchRouteOptions = {},
  ) {
    this.switcher = switcher;
    this.store = store;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this._log = createSubLogger(options.loggerName ?? "dsh-role-switch-route");
  }

  /**
   * Register the `/rolebox` prefix route on the host web server.
   *
   * @param webServer - The duck-typed `ctx.webServer` registrar.
   * @returns The disposer returned by `webServer.register(...)` — call it to
   *          unmount the route.
   */
  register(webServer: DshWebServerRouteRegistrar): () => void {
    return webServer.register({
      kind: "prefix",
      path: ROLE_SWITCH_ROUTE_PREFIX,
      handler: (req, res) => this.handle(req, res),
    });
  }

  /**
   * Dispatch a request under the `/rolebox` prefix to its route handler.
   *
   * Requests whose path does not start with the prefix are answered `404`
   * (the host webserver should only forward prefix-matching requests, but
   * the guard keeps the handler self-contained). Every branch is wrapped in
   * a try/catch so a failing handler always yields a stable `500` JSON error
   * instead of a bare socket teardown.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const path = url.pathname;
      const session = url.searchParams.get("session");

      if (!path.startsWith(ROLE_SWITCH_ROUTE_PREFIX)) {
        return sendJson(res, 404, errorBody("Not found"));
      }
      const sub = path.slice(ROLE_SWITCH_ROUTE_PREFIX.length); // e.g. "/roles"

      if (method === "GET" && sub === "/roles") return this.serveRoles(res);
      if (method === "GET" && sub === "/roles/active") {
        return this.serveActive(res, session);
      }
      if (method === "POST" && sub === "/roles/switch") {
        return this.serveSwitch(req, res);
      }
      if (method === "DELETE" && sub === "/roles/active") {
        return this.serveClear(res, session);
      }

      if (KNOWN_SUB_PATHS.has(sub)) {
        return sendJson(res, 405, errorBody("Method not allowed"));
      }
      return sendJson(res, 404, errorBody("Not found"));
    } catch (err) {
      this._log.error("Role-switch route handler failed", {
        error: formatError(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("Internal server error"));
      } else {
        res.end();
      }
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  /** `GET /rolebox/roles` — the switchable roles as a bare JSON array. */
  private serveRoles(res: ServerResponse): void {
    sendJson(res, 200, this.switcher.listRoles().map(toRoleDto));
  }

  /** `GET /rolebox/roles/active` — `{ session, role }` (role may be null). */
  private serveActive(res: ServerResponse, sessionParam: string | null): void {
    const session = this.resolveSessionId(sessionParam);
    sendJson(res, 200, { session, role: this.switcher.getActive(session) });
  }

  /**
   * `POST /rolebox/roles/switch` — body `{ role, session? }`. Unknown or
   * non-primary roles are rejected with `400` (delegated to the switcher).
   */
  private async serveSwitch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { body, tooLarge } = await this.readBody(req);
    if (tooLarge) {
      return sendJson(res, 413, errorBody("Request body too large"));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return sendJson(res, 400, errorBody("Invalid JSON body"));
    }
    if (!isRecord(parsed) || typeof parsed.role !== "string" || parsed.role.length === 0) {
      return sendJson(res, 400, errorBody("Missing or invalid 'role' field"));
    }

    const session = this.resolveSessionId(
      typeof parsed.session === "string" ? parsed.session : undefined,
    );
    const result = await this.switcher.activate(parsed.role, session);
    if (!result.ok) {
      return sendJson(res, 400, errorBody(result.error ?? "Role switch failed"));
    }
    this._log.info("Role switched via web route", { session, role: parsed.role });
    return sendJson(res, 200, { ok: true, session, role: parsed.role });
  }

  /** `DELETE /rolebox/roles/active` — clear the active role back to base agent. */
  private async serveClear(
    res: ServerResponse,
    sessionParam: string | null,
  ): Promise<void> {
    const session = this.resolveSessionId(sessionParam);
    await this.switcher.activate(null, session); // clearing never fails
    this._log.info("Active role cleared via web route", { session });
    return sendJson(res, 200, { ok: true, session, role: null });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve the session a request applies to: an explicit session (body /
   * query) wins; otherwise the most recently active session in the
   * SessionStore; with no sessions at all, the literal
   * {@link DEFAULT_SESSION_KEY} (`"default"`) key.
   */
  private resolveSessionId(explicit: string | null | undefined): string {
    if (explicit && explicit.length > 0) return explicit;
    return mostRecentSessionId(this.store) ?? DEFAULT_SESSION_KEY;
  }

  /**
   * Read the request body up to {@link maxBodyBytes}. Oversized bodies are
   * drained and discarded (never buffered) and reported via `tooLarge` so the
   * caller can answer `413` after the request completes cleanly.
   */
  private readBody(
    req: IncomingMessage,
  ): Promise<{ body: string; tooLarge: boolean }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (tooLarge) return; // keep draining, discard
        if (total > this.maxBodyBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) resolve({ body: "", tooLarge: true });
        else resolve({ body: Buffer.concat(chunks).toString("utf8"), tooLarge: false });
      });
      req.on("error", reject);
    });
  }
}

// ── Routing constants ────────────────────────────────────────────────────────

/** Sub-paths that exist under the `/rolebox` prefix (for `405` vs `404`). */
const KNOWN_SUB_PATHS = new Set(["/roles", "/roles/active", "/roles/switch"]);

// ── Serialization helpers ────────────────────────────────────────────────────

/** Map an AgentDefinition into the `GET /rolebox/roles` list item shape. */
function toRoleDto(role: AgentDefinition): RoleSwitchRoleDto {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    model: role.model ?? null,
    mode: role.mode ?? null,
  };
}

/** Stable error body for every non-2xx response. */
function errorBody(message: string): RoleSwitchErrorBody {
  return { ok: false, error: message };
}

/** Send a JSON response with the proper Content-Type and length. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the most recently active session in the store, derived from the last
 * timestamped event in each session's log. Sessions without any timestamped
 * event rank as inactive (`0`). Returns `undefined` when the store has no
 * sessions.
 */
function mostRecentSessionId(store: DshSessionStoreLike): string | undefined {
  let best: { id: string; at: number } | undefined;
  for (const session of store.list()) {
    const at = sessionLastActivity(session);
    if (!best || at > best.at) best = { id: session.id, at };
  }
  return best?.id;
}

/** Latest event timestamp for a session (best-effort, `0` when unknown). */
function sessionLastActivity(session: DshSessionLike): number {
  let latest = 0;
  for (const evt of session.events ?? []) {
    const ts =
      typeof evt.timestamp === "number"
        ? evt.timestamp
        : typeof evt.at === "number"
          ? evt.at
          : isRecord(evt.time) && typeof evt.time.created === "number"
            ? evt.time.created
            : 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}
