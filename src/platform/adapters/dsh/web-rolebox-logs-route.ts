/**
 * DshRoleboxLogsWebRoute — structural adapter exposing the rolebox log VIEW as
 * a read-only `prefix` route on dsh's host web server
 * (`@deepseek-ai/dsh-host-webserver`).
 *
 * dsh's host webserver exposes `ctx.webServer.register(route)` where
 *
 *   `WebRoute = { kind: 'exact'|'prefix', path: string, handler:
 *   (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`
 *
 * and `register` returns a disposer. This module consumes that surface
 * structurally (duck typing) — it does NOT import `@deepseek-ai/*` and never
 * creates an HTTP server of its own. The route types, the `/rolebox` prefix
 * constant and the `{ ok: false, error }` error shape are shared with the
 * sibling role-switch and monitor routes, so all three surfaces describe one
 * vocabulary.
 *
 * ── The registered route ────────────────────────────────────────────────────
 *
 *   - `{ kind: 'prefix', path: '/rolebox/logs', handler }`
 *
 * MOUNTING, AND WHY THE MONITOR ROUTE IS NOT TOUCHED. dsh's host webserver
 * keeps one route per `(kind, path)` and resolves a request by LONGEST PREFIX
 * (`match()` in `@deepseek-ai/dsh-host-webserver` src/index.ts:318-330: a
 * prefix matches `p` and `p/<anything>`, and the longest matching prefix wins)
 * while refusing a duplicate `(kind, path)` (`register()`, src/index.ts:166-169).
 * `/rolebox/logs` is therefore a DIFFERENT registration from the existing
 * `/rolebox` one: this class registers its own prefix, requests under it are
 * routed here, and every other `/rolebox/*` request still reaches the monitor
 * route exactly as before. The alternative composition — the plugin handing
 * this handler to the monitor route's `delegate` — also works UNCHANGED,
 * because a delegate receives the same `(req, res)` with the full URL: the
 * handler matches its own prefix either way. Both options are properties of
 * the SAME class, so no edit to `web-rolebox-monitor-route.ts` is required or
 * wanted. The `/rolebox` prefix itself is shared through
 * {@link ROLE_SWITCH_ROUTE_PREFIX} so the two routes cannot drift apart.
 *
 * ── REST contract under the prefix (GET-only, read-only) ───────────────────
 *
 *   - `GET /rolebox/logs` — one poll of the log view, as JSON:
 *
 *         { records, cursor, source, truncated, skippedLines }
 *
 *     exactly the five keys `readLogView` answers with (src/log/view.ts), in
 *     that shape and with no envelope: the view layer is the contract, and a
 *     second spelling of it here would be a second thing to keep in sync. The
 *     answer is a SNAPSHOT OF FILES other processes own, not a subscription —
 *     poll it again, or hand the returned `cursor` back as `?cursor=` to
 *     continue exactly where the previous answer stopped.
 *
 * ── Query parameters (every one optional; the ones given are ANDed) ────────
 *
 *   | parameter | meaning                                                        |
 *   | --------- | -------------------------------------------------------------- |
 *   | `cursor`  | Opaque watermark from a previous answer. Absent = the newest      |
 *   |           | window. Never validated: a value this build cannot READ (a        |
 *   |           | truncated or foreign spelling) is treated as ABSENT by the view   |
 *   |           | layer, so the recent window is re-painted instead of the request  |
 *   |           | failing; a WELL-FORMED but old watermark is a position the caller |
 *   |           | HAS SEEN and the walk continues forward from it — see the cursor  |
 *   |           | contract in src/log/view.ts.                                      |
 *   | `limit`   | Whole number of records, `0`+ (default: the view's own            |
 *   |           | `DEFAULT_LOG_VIEW_LIMIT` = 1000). The window can hold MORE than   |
 *   |           | `limit` records when a burst shares its edge millisecond — group   |
 *   |           | completion is what keeps the cursor exact; the real size is in    |
 *   |           | `records`.                                                        |
 *   | `level`   | LOWEST level to keep (`warn` keeps warn/error/fatal), case-        |
 *   |           | insensitive; one of debug, info, warn, error, fatal. Same          |
 *   |           | semantics as the CLI's `--level`.                                 |
 *   | `channel` | Channel name(s), exact match; comma-separated and/or repeated      |
 *   |           | (`?channel=graph:host&channel=web-ui`).                           |
 *   | `code`    | Event code(s), exact match; comma-separated and/or repeated. A     |
 *   |           | record without a code never matches.                              |
 *   | `graph`   | Records whose scope carries this `graphId`.                       |
 *   | `session` | Records whose scope carries this `sessionId`.                     |
 *   | `text`    | Case-insensitive substring over message, channel, code and field   |
 *   |           | values (never over scope ids).                                    |
 *
 * A parameter that is present but ILLEGIBLE is a `400` with a readable message
 * — never a `500`, and never a silently different filter. An EMPTY value is
 * illegible: `?channel=` names no channel, so it is rejected rather than read
 * as "every channel" (a client that meant "no filter" omits the parameter).
 * `cursor=` is the one exception — an empty cursor is the absence of a cursor,
 * which is exactly what the view layer would make of it.
 *
 * UNKNOWN PARAMETERS ARE IGNORED, and that is a security property, not
 * sloppiness: this route NEVER takes a source from the request. `logDir`,
 * `logFile` and `files` are query-string noise here — the location is fixed at
 * construction ({@link DshRoleboxLogsRouteOptions.logDir} /
 * `.logFile`, or the writer's own resolution chain when neither is given), so
 * an HTTP caller cannot point the reader at a directory of its choosing, and
 * `source` in the answer is always the location that was actually read.
 *
 * ── Error contract ─────────────────────────────────────────────────────────
 *
 * Every non-2xx response is JSON with the stable shape
 * `{ "ok": false, "error": string }` — the same shape the monitor and
 * role-switch routes use. Status codes: `400` (illegible query parameter),
 * `404` (unknown sub-path, or a request outside the prefix), `405` (known
 * path, wrong method), `500` (unexpected failure). The 2xx response is
 * resource-shaped (the five view keys, no `ok` marker).
 *
 * ── What this route deliberately does NOT expose ───────────────────────────
 *
 *   - No credentials, no payloads, no request data: the body is built from
 *     records the KERNEL already wrote, and the kernel's field contract
 *     (`LogFieldValue`, src/log/types.ts) plus its redaction pass
 *     (src/log/redact.ts) are what restrict those records — this route adds no
 *     new source of bytes and echoes nothing it was sent.
 *   - No `files`, `prune` or `follow`: listing and deleting belong to the CLI
 *     (`rolebox logs files` / `rolebox logs prune`), and a stream is not a
 *     route shape. This surface only ever reads records through
 *     `readLogView`.
 *   - No writes: the method gate answers `405` before any handler runs, and
 *     the route never touches the file system itself.
 *
 * Operational notes:
 *   - The handler never rejects: every branch is guarded, so a failing read
 *     yields a stable `500` JSON error instead of a bare socket teardown.
 *     (The read layer itself does not throw — a missing directory is an empty
 *     answer, not an error — so the `500` path is a last-resort net.)
 *   - A MISSING LOG DIRECTORY IS `200` WITH AN EMPTY SET, the same philosophy
 *     as the CLI's exit codes: "nothing has been logged here yet" is a
 *     reading, not a failure. `source` still names the directory that was
 *     looked in.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubLogger, formatError } from "../../../logger.ts";
import { DEFAULT_LOG_VIEW_LIMIT, readLogView } from "../../../log/index.ts";
import type { LogRecord, LogSource, LogViewQuery } from "../../../log/index.ts";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "../../../log/types.ts";
import {
  ROLE_SWITCH_ROUTE_PREFIX,
  type DshWebRouteLike,
  type DshWebServerRouteRegistrar,
} from "./web-role-switch-route.ts";

/** Route prefix registered on the dsh host web server, under the shared `/rolebox` prefix. */
export const ROLEBOX_LOGS_ROUTE_PREFIX = `${ROLE_SWITCH_ROUTE_PREFIX}/logs`;

/** Stable error shape for every non-2xx JSON response (shared with the sibling routes). */
export interface RoleboxLogsErrorBody {
  ok: false;
  error: string;
}

/**
 * The `GET /rolebox/logs` response body: exactly the five keys
 * {@link readLogView} returns, and nothing else. `source` is the location the
 * read actually used — an explicit route source, or the writer's own
 * resolution chain when this route named none — so a client can print where
 * the records came from without guessing.
 */
export interface RoleboxLogsViewBody {
  /** The records after the cursor (or the newest `limit`), in the reader's order. */
  records: LogRecord[];
  /** Hand back as `?cursor=` to continue exactly where this answer stopped. */
  cursor: string;
  /** WHERE this answer was read from, as the read layer resolved it. */
  source: LogSource;
  /** True when more matching records exist than this answer carried. */
  truncated: boolean;
  /** Lines skipped as unusable, counted exactly as the read layer counts them. */
  skippedLines: number;
}

/**
 * Options for constructing a {@link DshRoleboxLogsWebRoute}.
 *
 * `logDir` / `logFile` FIX THE SOURCE for every request this route serves; the
 * plugin passes them when it wants an explicit location, and omits both to let
 * the writer's own chain decide (`ROLEBOX_LOG_FILE`, then `ROLEBOX_LOG_DIR`,
 * then the workspace `.rolebox/logs` fallback — see the read-side precedence
 * in src/log/read.ts). Neither is ever read from a request.
 */
export interface DshRoleboxLogsRouteOptions {
  /** Read this directory and nothing else (an explicit read-side source). */
  logDir?: string;
  /** Read this ONE file (legacy single-file mode); beats `logDir`, as on the read side. */
  logFile?: string;
  /** Optional sub-logger name override (default `"dsh-rolebox-logs-route"`). */
  loggerName?: string;
  /**
   * Optional delegate for sub-paths this route does not own.
   *
   * The handler owns `/rolebox/logs` alone. When the plugin composes several
   * surfaces into one registration it passes the next handler here (exactly as
   * the monitor route does), so a request that is not this route's falls
   * through instead of being answered `404` by the wrong surface.
   */
  delegate?: DshWebRouteLike["handler"];
}

/** The parsed result of a query string: a view query, or the reason it is illegible. */
export type LogsRouteQueryParse =
  | { ok: true; query: LogViewQuery }
  | { ok: false; error: string };

/**
 * Route adapter exposing the rolebox log view on the host web server.
 *
 * Construct with an optional explicit source (`logDir` / `logFile`) — omit both
 * to read wherever the logging kernel writes — then `register(webServer)` to
 * mount the `/rolebox/logs` prefix route; the returned disposer unmounts it.
 * The handler is also exposed directly as {@link DshRoleboxLogsWebRoute.handle}
 * for tests and for composing this surface into another route's `delegate`.
 */
export class DshRoleboxLogsWebRoute {
  private readonly source: { logDir?: string; logFile?: string };
  private readonly delegate: DshWebRouteLike["handler"] | undefined;
  private readonly _log;

  /**
   * @param options - explicit source, logger name and optional delegate.
   */
  constructor(options: DshRoleboxLogsRouteOptions = {}) {
    this.source = {
      ...(options.logDir !== undefined ? { logDir: options.logDir } : {}),
      ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
    };
    this.delegate = options.delegate;
    this._log = createSubLogger(options.loggerName ?? "dsh-rolebox-logs-route");
  }

  /**
   * Register the `/rolebox/logs` prefix route on the host web server.
   *
   * A DISTINCT registration from the `/rolebox` monitor route: the host
   * resolves by longest prefix and refuses duplicate `(kind, path)` pairs, so
   * this one receives every request under `/rolebox/logs` while the monitor
   * route keeps every other `/rolebox/*` request — its behaviour is untouched.
   *
   * @param webServer - the duck-typed `ctx.webServer` registrar.
   * @returns the disposer returned by `webServer.register(...)`.
   */
  register(webServer: DshWebServerRouteRegistrar): () => void {
    return webServer.register({
      kind: "prefix",
      path: ROLEBOX_LOGS_ROUTE_PREFIX,
      handler: (req, res) => this.handle(req, res),
    });
  }

  /**
   * Dispatch a request under the `/rolebox/logs` prefix.
   *
   * Requests outside the prefix are answered `404` (the host only forwards
   * matching prefixes, but the guard keeps the handler self-contained and
   * makes it safe to use as another route's delegate). The prefix root — `""`
   * and `"/"`, i.e. `/rolebox/logs` and `/rolebox/logs/` — is the one served
   * path; a known path with another method is `405`; anything else falls
   * through to the optional delegate, or `404` without one. Every branch is
   * wrapped so a failing handler always yields a stable `500` JSON error.
   *
   * @param req - the request; read for its method and URL only.
   * @param res - the response to write.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (path !== ROLEBOX_LOGS_ROUTE_PREFIX && !path.startsWith(`${ROLEBOX_LOGS_ROUTE_PREFIX}/`)) {
        return sendJson(res, 404, errorBody("Not found"));
      }
      const sub = path.slice(ROLEBOX_LOGS_ROUTE_PREFIX.length); // "" or "/…"

      if (sub === "" || sub === "/") {
        if (method !== "GET") return sendJson(res, 405, errorBody("Method not allowed"));
        return this.serveView(url.searchParams, res);
      }

      if (this.delegate) return this.delegate(req, res);
      return sendJson(res, 404, errorBody("Not found"));
    } catch (err) {
      this._log.error("Rolebox logs route handler failed", {
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

  /**
   * `GET /rolebox/logs` — one poll of the log view.
   *
   * An illegible query is answered `400` BEFORE the read runs, so a client
   * typo can never look like an empty log directory. Otherwise the answer is
   * whatever `readLogView` returns, verbatim in shape: the view layer already
   * answers (never throws) for a missing directory, an unreadable file and a
   * cursor it cannot parse.
   */
  private serveView(params: URLSearchParams, res: ServerResponse): void {
    const parsed = parseLogsRouteQuery(params, this.source);
    if (!parsed.ok) return sendJson(res, 400, errorBody(parsed.error));

    const view = readLogView(parsed.query);
    const body: RoleboxLogsViewBody = {
      records: view.records,
      cursor: view.cursor,
      source: view.source,
      truncated: view.truncated,
      skippedLines: view.skippedLines,
    };
    sendJson(res, 200, body, { noStore: true });
  }
}

// ── Query parsing ────────────────────────────────────────────────────────────

/** The query parameters this route understands, in the order the docs list them. */
export const LOGS_ROUTE_PARAMS: readonly string[] = [
  "cursor",
  "limit",
  "level",
  "channel",
  "code",
  "graph",
  "session",
  "text",
];

/** A non-blank single value: trimmed, or `undefined` for absent/blank/empty. */
function scalarParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? "" : trimmed;
}

/**
 * A list parameter: every occurrence of `name`, each split on commas, trimmed
 * and de-blanked. Returns `undefined` when the parameter is absent and an
 * EMPTY ARRAY when it was given but names nothing (`?channel=` or `?channel=,`),
 * which the caller reports as illegible.
 */
function listParam(params: URLSearchParams, name: string): string[] | undefined {
  const raw = params.getAll(name);
  if (raw.length === 0) return undefined;
  const values: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) values.push(trimmed);
    }
  }
  return values;
}

/**
 * Parse a `/rolebox/logs` query string against the view contract.
 *
 * Pure and non-throwing: an illegible parameter comes back as
 * `{ ok: false, error }` with a message that names the parameter, the accepted
 * form and the value it got — the same posture as the CLI's usage errors, so a
 * human reading a `400` learns what to send instead. The source is named by the
 * CALLER (the route's construction options), never by the query string.
 *
 * @param params - the request's search parameters.
 * @param source - the fixed source this route reads (`logDir` / `logFile`).
 */
export function parseLogsRouteQuery(
  params: URLSearchParams,
  source: { logDir?: string; logFile?: string } = {},
): LogsRouteQueryParse {
  let limit: number | undefined;
  const limitText = scalarParam(params, "limit");
  if (limitText !== undefined) {
    if (!/^\d+$/.test(limitText)) {
      return {
        ok: false,
        error: `limit must be a whole number of records, 0 or more (got "${limitText}")`,
      };
    }
    limit = Number(limitText);
  }

  let minLevel: LogLevel | undefined;
  const levelText = scalarParam(params, "level");
  if (levelText !== undefined) {
    const normalized = levelText.toLowerCase();
    if (!isLogLevel(normalized)) {
      return {
        ok: false,
        error: `level must be one of ${LOG_LEVELS.join(", ")} (got "${levelText}")`,
      };
    }
    minLevel = normalized;
  }

  const channels = listParam(params, "channel");
  if (channels !== undefined && channels.length === 0) {
    return { ok: false, error: 'channel needs at least one value (got "")' };
  }
  const codes = listParam(params, "code");
  if (codes !== undefined && codes.length === 0) {
    return { ok: false, error: 'code needs at least one value (got "")' };
  }

  const scopeParam = (name: string, label: string): string | undefined | { error: string } => {
    const value = scalarParam(params, name);
    if (value === "") return { error: `${label} needs a value (got "")` };
    return value;
  };

  const graph = scopeParam("graph", "graph");
  if (typeof graph === "object") return { ok: false, error: graph.error };
  const session = scopeParam("session", "session");
  if (typeof session === "object") return { ok: false, error: session.error };
  const text = scopeParam("text", "text");
  if (typeof text === "object") return { ok: false, error: text.error };

  const cursorText = scalarParam(params, "cursor");

  return {
    ok: true,
    query: {
      ...(source.logFile !== undefined ? { logFile: source.logFile } : {}),
      ...(source.logDir !== undefined ? { logDir: source.logDir } : {}),
      // An empty `cursor=` is the ABSENCE of a cursor: the view layer treats an
      // unreadable watermark as absent, and "" is exactly that.
      ...(cursorText !== undefined && cursorText !== "" ? { cursor: cursorText } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(minLevel !== undefined ? { minLevel } : {}),
      ...(channels !== undefined ? { channels } : {}),
      ...(codes !== undefined ? { codes } : {}),
      ...(typeof graph === "string" ? { graphId: graph } : {}),
      ...(typeof session === "string" ? { sessionId: session } : {}),
      ...(typeof text === "string" ? { text } : {}),
    },
  };
}

/**
 * The view window a request that names no `limit` gets. Exported so a client
 * (and the docs) can state the default without importing the view module, and
 * deliberately the SAME constant the view layer uses.
 */
export const DEFAULT_LOGS_ROUTE_LIMIT = DEFAULT_LOG_VIEW_LIMIT;

// ── Serialization helpers ────────────────────────────────────────────────────

/** Stable error body for every non-2xx response. */
function errorBody(message: string): RoleboxLogsErrorBody {
  return { ok: false, error: message };
}

/**
 * Send a JSON response with the proper Content-Type and length.
 *
 * `noStore` is set for the view answer: it is a poll of files other processes
 * are appending to, so a cached copy is stale by definition and an intermediary
 * holding one would make the cursor walk backwards.
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  options: { noStore?: boolean } = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    ...(options.noStore === true ? { "Cache-Control": "no-store" } : {}),
  });
  res.end(text);
}
