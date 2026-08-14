/**
 * DshRoleSwitchWebServer — self-contained web surface for the dsh role
 * switcher, built on `node:http` (no framework, no new dependencies).
 *
 * The dsh harness has no built-in agent picker on its session surface;
 * {@link DshRoleSwitcher} owns the per-session active-role state. This module
 * exposes that state as a tiny HTTP server so a user (or a wrapper UI) can
 * inspect and change the active role from a browser:
 *
 *   - `GET    /`                       — self-contained HTML page (vanilla JS
 *                                        fetch, no build step): role-name
 *                                        input, `<datalist>` of switchable
 *                                        roles, switch button, status line.
 *   - `GET    /api/roles`              — JSON array of switchable roles
 *                                        (`id`/`name`/`description`/`model`/
 *                                        `mode`, primary roles only).
 *   - `GET    /api/roles/active`       — `{ session, role }` — the active
 *                                        role id for the session, or `null`
 *                                        for the base agent.
 *   - `POST   /api/roles/switch`       — body `{ role: string, session?:
 *                                        string }`; delegates to
 *                                        {@link DshRoleSwitcher.activate}.
 *   - `DELETE /api/roles/active`       — clear the active role for the
 *                                        session.
 *
 * The `session` key is optional everywhere: an explicit session (body or
 * `?session=` query) wins; otherwise the most recently active session in the
 * SessionStore is used; with no sessions at all the literal key
 * {@link ROLE_SWITCH_DEFAULT_SESSION} (`"default"`) is used.
 *
 * Error contract — every non-2xx response is JSON with a stable shape:
 * `{ "ok": false, "error": string }`. Status codes: `400` (malformed JSON,
 * missing `role`, unknown or non-primary role), `404` (unknown route), `405`
 * (known path, wrong method), `413` (request body over the cap), `500`
 * (unexpected failure). 2xx responses are resource-shaped: the roles list is
 * a bare array, `active` is `{ session, role }`, mutations are
 * `{ ok: true, session, role }`.
 *
 * Operational notes:
 *   - Binds to `127.0.0.1` by default (loopback only — the surface exposes
 *     session state, so binding to all interfaces is a deliberate opt-in via
 *     {@link DshRoleSwitchWebServerOptions.host}).
 *   - Request bodies are capped (default 64 KiB,
 *     {@link DshRoleSwitchWebServerOptions.maxBodyBytes}) — oversized bodies
 *     are drained and answered `413`, never buffered.
 *   - `start()` binds an ephemeral port (0) by default; the bound port is
 *     exposed via the {@link DshRoleSwitchWebServer.port} getter.
 *
 * The dsh surface is consumed structurally (duck typing). This module does
 * NOT import `@deepseek-ai/*` (or `@opencode-ai/*`).
 *
 * @module
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createSubLogger, formatError } from "../../../logger.ts";
import type { AgentDefinition } from "../../types.ts";
import type { DshRoleSwitcher } from "./role-switcher.ts";
import type { DshSessionLike, DshSessionStoreLike } from "./session.ts";

/** Fallback session key when no explicit session and no store sessions exist. */
export const ROLE_SWITCH_DEFAULT_SESSION = "default";

/** Default bind host — loopback only. */
export const ROLE_SWITCH_DEFAULT_HOST = "127.0.0.1";

/** Default request-body cap (64 KiB). */
export const ROLE_SWITCH_DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Serialized switchable role — the `GET /api/roles` list item shape.
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

/**
 * Options for constructing a {@link DshRoleSwitchWebServer}.
 */
export interface DshRoleSwitchWebServerOptions {
  /** Bind host/interface (default `127.0.0.1` — loopback only). */
  host?: string;
  /** Maximum request body size in bytes (default 65536). */
  maxBodyBytes?: number;
  /** Optional sub-logger name override (default `"dsh-web-role-switch"`). */
  loggerName?: string;
}

/** Stable error shape for every non-2xx JSON response. */
export interface RoleSwitchErrorBody {
  ok: false;
  error: string;
}

/**
 * Minimal web server exposing the dsh role switcher over HTTP.
 *
 * Lifecycle: construct with the switcher and the session store, then
 * `await start()` (binds an ephemeral loopback port by default), read the
 * bound port from the {@link DshRoleSwitchWebServer.port} getter, and
 * `await close()` when done. `start()`/`close()` are idempotent.
 */
export class DshRoleSwitchWebServer {
  private readonly switcher: DshRoleSwitcher;
  private readonly store: DshSessionStoreLike;
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly _log;
  private server: Server | null = null;

  /**
   * @param switcher - The dsh role switcher this server delegates to.
   * @param store    - The dsh SessionStore used to resolve the most recent
   *                   session when no explicit session is supplied.
   * @param options  - Optional tuning (host / body cap / logger name).
   */
  constructor(
    switcher: DshRoleSwitcher,
    store: DshSessionStoreLike,
    options: DshRoleSwitchWebServerOptions = {},
  ) {
    this.switcher = switcher;
    this.store = store;
    this.host = options.host ?? ROLE_SWITCH_DEFAULT_HOST;
    this.maxBodyBytes = options.maxBodyBytes ?? ROLE_SWITCH_DEFAULT_MAX_BODY_BYTES;
    this._log = createSubLogger(options.loggerName ?? "dsh-web-role-switch");
  }

  /**
   * The bound TCP port once the server is listening, or `0` when not started.
   * After `start()` with the default ephemeral port this is the actual port.
   */
  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : 0;
  }

  /**
   * Start listening.
   *
   * Binds an ephemeral port (0) by default; pass a concrete port to bind a
   * specific one. Resolves once the server is accepting connections. No-op
   * (and resolves) when already running.
   *
   * @param port - TCP port to bind; `0` (default) selects an ephemeral port.
   */
  async start(port = 0): Promise<void> {
    if (this.server) return; // already running
    const server = createServer((req, res) => {
      // handle() never rejects (all routes are internally guarded); this
      // catch is belt-and-braces for unexpected async failures.
      void this.handle(req, res).catch((err) => {
        this._log.error("Unhandled request error", { error: formatError(err) });
        if (!res.headersSent) {
          sendJson(res, 500, errorBody("Internal server error"));
        } else {
          res.end();
        }
      });
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        if (this.server === server) this.server = null;
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.host);
    });

    this._log.info("Role-switch web server listening", {
      host: this.host,
      port: this.port,
    });
  }

  /**
   * Stop listening. Resolves once the server is fully closed (idle
   * keep-alive sockets are nudged closed so this is prompt). No-op when not
   * running. Idempotent.
   */
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      const s = server as Server & { closeAllConnections?: () => void };
      s.closeAllConnections?.();
    });
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  /**
   * Dispatch a request to its route handler. Every branch is wrapped in a
   * try/catch so a failing handler always yields a stable `500` JSON error
   * instead of a bare socket teardown.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const path = url.pathname;
      const session = url.searchParams.get("session");

      if (method === "GET" && path === "/") return this.serveIndex(res);
      if (method === "GET" && path === "/api/roles") return this.serveRoles(res);
      if (method === "GET" && path === "/api/roles/active") {
        return this.serveActive(res, session);
      }
      if (method === "POST" && path === "/api/roles/switch") {
        return this.serveSwitch(req, res);
      }
      if (method === "DELETE" && path === "/api/roles/active") {
        return this.serveClear(res, session);
      }

      if (KNOWN_PATHS.has(path)) {
        return sendJson(res, 405, errorBody("Method not allowed"));
      }
      return sendJson(res, 404, errorBody("Not found"));
    } catch (err) {
      this._log.error("Request handler failed", { error: formatError(err) });
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("Internal server error"));
      } else {
        res.end();
      }
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  /** `GET /` — the self-contained HTML page. */
  private serveIndex(res: ServerResponse): void {
    const roles = this.switcher.listRoles();
    const options = roles
      .map(
        (r) =>
          `<option value="${escapeHtml(r.id)}" label="${escapeHtml(r.name)}">`,
      )
      .join("");
    sendHtml(res, 200, renderIndexPage(options));
  }

  /** `GET /api/roles` — the switchable roles as a bare JSON array. */
  private serveRoles(res: ServerResponse): void {
    sendJson(res, 200, this.switcher.listRoles().map(toRoleDto));
  }

  /** `GET /api/roles/active` — `{ session, role }` (role may be null). */
  private serveActive(res: ServerResponse, sessionParam: string | null): void {
    const session = this.resolveSessionId(sessionParam);
    sendJson(res, 200, { session, role: this.switcher.getActive(session) });
  }

  /**
   * `POST /api/roles/switch` — body `{ role, session? }`. Unknown or
   * non-primary roles are rejected with `400` (delegated to the switcher).
   */
  private async serveSwitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    this._log.info("Role switched via web surface", { session, role: parsed.role });
    return sendJson(res, 200, { ok: true, session, role: parsed.role });
  }

  /** `DELETE /api/roles/active` — clear the active role back to base agent. */
  private async serveClear(res: ServerResponse, sessionParam: string | null): Promise<void> {
    const session = this.resolveSessionId(sessionParam);
    await this.switcher.activate(null, session); // clearing never fails
    this._log.info("Active role cleared via web surface", { session });
    return sendJson(res, 200, { ok: true, session, role: null });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resolve the session a request applies to: an explicit session (body /
   * query) wins; otherwise the most recently active session in the
   * SessionStore; with no sessions at all, the literal
   * {@link ROLE_SWITCH_DEFAULT_SESSION} key.
   */
  private resolveSessionId(explicit: string | null | undefined): string {
    if (explicit && explicit.length > 0) return explicit;
    return mostRecentSessionId(this.store) ?? ROLE_SWITCH_DEFAULT_SESSION;
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

/** Paths that exist on this server (for `405` vs `404` discrimination). */
const KNOWN_PATHS = new Set(["/", "/api/roles", "/api/roles/active", "/api/roles/switch"]);

// ── Serialization helpers ────────────────────────────────────────────────────

/** Map an AgentDefinition into the `GET /api/roles` list item shape. */
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

/** Send an HTML response. */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/** Structural record guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape HTML metacharacters for safe interpolation into markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// ── HTML page (self-contained, vanilla JS, no build step) ───────────────────

/**
 * Render the role-switch page. The `<datalist>` is populated server-side at
 * serve time AND refreshed client-side from `/api/roles` on load, so the
 * list stays in sync with the live catalog. The status line reads the active
 * role on load and after every switch.
 */
function renderIndexPage(datalistOptions: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>rolebox · dsh role switch</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 42rem; margin: 2.5rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  p { margin: .5rem 0; }
  form { display: flex; gap: .5rem; margin-top: 1rem; }
  input { flex: 1; padding: .5rem .6rem; font-size: 1rem; border: 1px solid #8886; border-radius: .4rem; }
  button { padding: .5rem .9rem; font-size: 1rem; border: 1px solid #8886; border-radius: .4rem; cursor: pointer; }
  #status { margin-top: 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; white-space: pre-wrap; }
  .error { color: #c0392b; }
  .ok { color: #1e8449; }
</style>
</head>
<body>
  <h1>rolebox · dsh role switch</h1>
  <p>Choose a role to make active for the current session.</p>
  <form id="switch-form">
    <input id="role-input" list="role-list" placeholder="role id" autocomplete="off" required />
    <datalist id="role-list">${datalistOptions}</datalist>
    <button type="submit">Switch</button>
  </form>
  <p id="status">Loading…</p>
  <script>
    const input = document.getElementById("role-input");
    const list = document.getElementById("role-list");
    const status = document.getElementById("status");
    const form = document.getElementById("switch-form");

    function setStatus(text, cls) {
      status.textContent = text;
      status.className = cls ?? "";
    }

    async function refreshRoles() {
      const res = await fetch("/api/roles");
      if (!res.ok) return;
      const roles = await res.json();
      list.replaceChildren(...roles.map((r) => {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.label = r.id + " — " + r.name;
        return opt;
      }));
    }

    async function refreshActive() {
      try {
        const res = await fetch("/api/roles/active");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (data.role) {
          setStatus("Active role: " + data.role + "  (session: " + data.session + ")", "ok");
        } else {
          setStatus("No active role (base agent)  [session: " + data.session + "]");
        }
      } catch (err) {
        setStatus("Failed to read active role: " + err.message, "error");
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const role = input.value.trim();
      if (!role) return;
      setStatus("Switching to " + role + "…");
      try {
        const res = await fetch("/api/roles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: role })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok !== true) {
          setStatus("Switch failed: " + (data.error ?? "HTTP " + res.status), "error");
          return;
        }
        input.value = "";
        await refreshActive();
      } catch (err) {
        setStatus("Switch failed: " + err.message, "error");
      }
    });

    refreshRoles();
    refreshActive();
  </script>
</body>
</html>
`;
}
