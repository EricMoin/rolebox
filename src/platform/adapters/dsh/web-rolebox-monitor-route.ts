/**
 * DshRoleboxMonitorWebRoute — structural adapter exposing a read-only
 * rolebox runtime monitor surface as a `prefix` route on dsh's host web
 * server (`@deepseek-ai/dsh-host-webserver`).
 *
 * dsh's host webserver exposes `ctx.webServer.register(route)` where
 *
 *   `WebRoute = { kind: 'exact'|'prefix', path: string, handler:
 *   (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`
 *
 * and `register` returns a disposer. This module consumes that surface
 * structurally (duck typing) — it does NOT import `@deepseek-ai/*` and never
 * creates an HTTP server of its own. The route types and the `/rolebox`
 * prefix constant are shared with the sibling role-switch adapter
 * (`web-role-switch-route.ts`) so both routes mount on the same prefix with
 * a single source of truth for the path.
 *
 * Registered route:
 *
 *   - `{ kind: 'prefix', path: '/rolebox', handler }`
 *
 * Single-registration composition. The real dsh host webserver rejects a
 * duplicate `(kind, path)` registration (`webserver: duplicate prefix route
 * "/rolebox"` — see `@deepseek-ai/dsh-host-webserver` lib/index.js:54-55),
 * so when the plugin mounts the role-switch surface AND this monitor surface
 * on the same `/rolebox` prefix, they MUST share one registration. This
 * route is the composition point: it owns `/status` + `/metrics` and, when
 * constructed with the optional `delegate` option (the role-switch handler),
 * falls every other sub-path through to the delegate — see
 * {@link DshRoleboxMonitorRouteOptions.delegate}.
 *
 * REST contract under the prefix (GET-only, read-only):
 *
 *   - `GET /rolebox/status`  — composed runtime status JSON:
 *       - `loops`        — summary of every live loop, projected from
 *                          `LoopCoordinator.getAllLoopStates()` (count +
 *                          per-loop {@link LoopSummaryDto}).
 *       - `engineGraphs` — the live engine-graph snapshots, reusing the
 *                          monitor reader helper `readLiveEngineGraphs`
 *                          (`src/cli/commands/monitor/monitor-reader-engine.ts`)
 *                          against the configured `stateDir`.
 *       - `sessions`     — session count + most recent session id (from
 *                          `DshSessionStoreLike.list()`), plus the active
 *                          role id per session (from
 *                          `DshRoleSwitcher.getActive`).
 *   - `GET /rolebox/metrics` — the dispatch metrics snapshot
 *                          (`metrics.snapshot()` from
 *                          `src/dispatch/persistence/metrics.ts`).
 *
 * Error contract — identical to the role-switch route: every non-2xx
 * response is JSON with the stable shape `{ "ok": false, "error": string }`.
 * Status codes: `404` (unknown route), `405` (known path, wrong method),
 * `500` (unexpected failure). 2xx responses are resource-shaped: `/metrics`
 * returns the metrics snapshot directly (mirroring how `/roles` returns a
 * bare array), `/status` returns the composed object with an `ok: true`
 * marker.
 *
 * Operational notes:
 *   - Both endpoints are GET and never read a request body, so the
 *     role-switch route's body-cap contract is preserved structurally: a
 *     request body is never buffered by this route.
 *   - The handler never rejects: every branch is guarded so a failing
 *     dependency (e.g. a throwing engine-state read) yields a stable `500`
 *     JSON error instead of a bare socket teardown.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubLogger, formatError } from "../../../logger.ts";
import { readLiveEngineGraphs } from "../../../cli/commands/monitor/monitor-reader-engine.ts";
import type { EngineGraphSnapshot } from "../../../cli/commands/monitor/monitor-reader-types.ts";
import { metrics } from "../../../dispatch/persistence/metrics.ts";
import type { LoopCoordinator } from "../../../loop/coordinator.ts";
import type { LoopState } from "../../../loop/types.ts";
import type { DshRoleSwitcher } from "./role-switcher.ts";
import type {
  DshSessionLike,
  DshSessionStoreLike,
} from "./session.ts";
import {
  ROLE_SWITCH_ROUTE_PREFIX,
  type DshWebRouteLike,
  type DshWebServerRouteRegistrar,
} from "./web-role-switch-route.ts";

/** Route prefix registered on the dsh host web server (shared with the role-switch route). */
export const ROLEBOX_MONITOR_ROUTE_PREFIX = ROLE_SWITCH_ROUTE_PREFIX;

/** Stable error shape for every non-2xx JSON response. */
export interface RoleboxMonitorErrorBody {
  ok: false;
  error: string;
}

/**
 * Serialized per-loop summary item — the `GET /rolebox/status` `loops.states`
 * entry shape, projected from a live {@link LoopState}. Optional fields are
 * omitted when absent on the source state (never `undefined`-serialized).
 */
export interface LoopSummaryDto {
  /** Session id of the origin (first) loop round. */
  originSessionId: string;
  /** Name of the agent running the loop. */
  agent: string;
  /** Current orchestrator phase (`activating` … `error`). */
  phase: string;
  /** Current round number (1-based). */
  current: number;
  /** Total number of rounds requested. */
  total: number;
  /** Loop mode — `inherit` conversation history or `fresh` each round. */
  mode: string;
  /** Id of the orchestrator loop when this loop is a tree worker. */
  parentLoopId?: string;
  /** Dispatch task id of the active worker round. */
  activeWorkerTaskId?: string;
  /** Session id of the active worker round. */
  activeWorkerSessionId?: string;
  /** Whether cancellation has been requested. */
  cancelRequested: boolean;
  /** Unix timestamp (ms) when the loop started. */
  startedAt: number;
  /** Unix timestamp (ms) of the most recent state update. */
  updatedAt: number;
  /** Unix timestamp (ms) when the current round started. */
  roundStartedAt: number;
  /** Number of dispatched rounds recorded so far. */
  roundCount: number;
  /** Error description when the loop phase is `error`. */
  errorReason?: string;
}

/** The `GET /rolebox/status` composed response body. */
export interface DshRoleboxStatusBody {
  ok: true;
  /** Live loop summary — count plus per-loop projections. */
  loops: {
    count: number;
    states: LoopSummaryDto[];
  };
  /** Live engine-graph snapshots (see `readLiveEngineGraphs`). */
  engineGraphs: EngineGraphSnapshot[];
  /** Session census — count, most recent id, and per-session active roles. */
  sessions: {
    count: number;
    mostRecentId: string | null;
    activeRoles: Record<string, string | null>;
  };
}

/**
 * Options for constructing a {@link DshRoleboxMonitorWebRoute}.
 */
export interface DshRoleboxMonitorRouteOptions {
  /** Optional sub-logger name override (default `"dsh-rolebox-monitor-route"`). */
  loggerName?: string;
  /**
   * Optional delegate handler for sub-paths this route does not own.
   *
   * The plugin composes the role-switch surface (`/roles*`) and this monitor
   * surface into a SINGLE `/rolebox` prefix registration (the real host
   * webserver rejects duplicate prefix routes — see the module docstring),
   * so the plugin passes the role-switch route's handler here. Requests
   * under the prefix that are not `/status` / `/metrics` (and are not a
   * known-but-wrong-method monitor sub-path) fall through to the delegate,
   * which answers 200 for its own sub-paths and 404/405 for anything else.
   */
  delegate?: DshWebRouteLike["handler"];
}

/**
 * Route adapter exposing the rolebox runtime monitor on the host web server.
 *
 * Construct with the role switcher, the session store, the loop coordinator
 * and the engine-state directory, then `register(webServer)` to mount the
 * `/rolebox` prefix route; the returned disposer unmounts it. The handler is
 * also exposed directly as {@link DshRoleboxMonitorWebRoute.handle} for tests
 * and non-HTTP callers. When constructed with the optional `delegate` (the
 * role-switch handler), this route is the single `/rolebox` registration
 * serving BOTH surfaces — the monitor's `/status` + `/metrics` and the
 * role-switch's `/roles*` sub-paths.
 */
export class DshRoleboxMonitorWebRoute {
  private readonly switcher: DshRoleSwitcher;
  private readonly store: DshSessionStoreLike;
  private readonly loopCoordinator: LoopCoordinator;
  private readonly stateDir: string;
  private readonly delegate: DshWebRouteLike["handler"] | undefined;
  private readonly _log;

  /**
   * @param switcher        - The dsh role switcher providing per-session
   *                          active-role reads (`getActive`).
   * @param store           - The dsh SessionStore providing the session
   *                          census (`list()`).
   * @param loopCoordinator - The loop coordinator providing live loop states
   *                          (`getAllLoopStates()`).
   * @param stateDir        - The engine-state directory handed to
   *                          `readLiveEngineGraphs` for the engine-graph
   *                          snapshot (the same `process.cwd()` the graph
   *                          tools persist under).
   * @param options         - Optional tuning (logger name, delegate).
   */
  constructor(
    switcher: DshRoleSwitcher,
    store: DshSessionStoreLike,
    loopCoordinator: LoopCoordinator,
    stateDir: string,
    options: DshRoleboxMonitorRouteOptions = {},
  ) {
    this.switcher = switcher;
    this.store = store;
    this.loopCoordinator = loopCoordinator;
    this.stateDir = stateDir;
    this.delegate = options.delegate;
    this._log = createSubLogger(
      options.loggerName ?? "dsh-rolebox-monitor-route",
    );
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
      path: ROLEBOX_MONITOR_ROUTE_PREFIX,
      handler: (req, res) => this.handle(req, res),
    });
  }

  /**
   * Dispatch a request under the `/rolebox` prefix to its route handler.
   *
   * Requests whose path does not start with the prefix are answered `404`
   * (the host webserver should only forward prefix-matching requests, but
   * the guard keeps the handler self-contained). `/status` and `/metrics`
   * are served here; when a `delegate` was supplied (the composed
   * role-switch surface), every other sub-path falls through to it — it
   * answers 200 for `/roles*` and 404/405 for anything else. Without a
   * delegate the handler answers `404` for unknown sub-paths. Every branch
   * is wrapped in a try/catch so a failing handler (e.g. a throwing
   * engine-state read) always yields a stable `500` JSON error instead of a
   * bare socket teardown.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (!path.startsWith(ROLEBOX_MONITOR_ROUTE_PREFIX)) {
        return sendJson(res, 404, errorBody("Not found"));
      }
      const sub = path.slice(ROLEBOX_MONITOR_ROUTE_PREFIX.length); // e.g. "/status"

      if (method === "GET" && sub === "/status") return this.serveStatus(res);
      if (method === "GET" && sub === "/metrics") return this.serveMetrics(res);

      if (KNOWN_SUB_PATHS.has(sub)) {
        return sendJson(res, 405, errorBody("Method not allowed"));
      }
      // Sub-paths this route does not own fall through to the optional
      // delegate — the role-switch surface when the plugin composes both
      // surfaces into a single `/rolebox` registration (the real host
      // webserver rejects duplicate prefix routes). The delegate answers
      // 200 for its own sub-paths and 404/405 for anything else.
      if (this.delegate) {
        return this.delegate(req, res);
      }
      return sendJson(res, 404, errorBody("Not found"));
    } catch (err) {
      this._log.error("Rolebox monitor route handler failed", {
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
   * `GET /rolebox/status` — the composed runtime status: live loop summary,
   * engine-graph snapshots, and the session census with per-session active
   * roles.
   */
  private serveStatus(res: ServerResponse): void {
    const loopStates = this.loopCoordinator.getAllLoopStates();
    const sessions = this.store.list();
    const activeRoles: Record<string, string | null> = {};
    for (const session of sessions) {
      activeRoles[session.id] = this.switcher.getActive(session.id);
    }

    const body: DshRoleboxStatusBody = {
      ok: true,
      loops: {
        count: loopStates.size,
        states: [...loopStates.values()].map(toLoopSummary),
      },
      engineGraphs: readLiveEngineGraphs(this.stateDir),
      sessions: {
        count: sessions.length,
        mostRecentId: mostRecentSessionId(this.store) ?? null,
        activeRoles,
      },
    };
    sendJson(res, 200, body);
  }

  /** `GET /rolebox/metrics` — the dispatch metrics snapshot, as-is. */
  private serveMetrics(res: ServerResponse): void {
    sendJson(res, 200, metrics.snapshot());
  }
}

// ── Routing constants ────────────────────────────────────────────────────────

/** Sub-paths that exist under the `/rolebox` prefix (for `405` vs `404`). */
const KNOWN_SUB_PATHS = new Set(["/status", "/metrics"]);

// ── Projection helpers ───────────────────────────────────────────────────────

/**
 * Project a live {@link LoopState} into the JSON-safe {@link LoopSummaryDto}.
 * Optional fields are spread conditionally so absent values are omitted from
 * the serialized JSON rather than emitted as `undefined`.
 */
function toLoopSummary(state: LoopState): LoopSummaryDto {
  return {
    originSessionId: state.originSessionId,
    agent: state.agent,
    phase: state.phase,
    current: state.current,
    total: state.total,
    mode: state.mode,
    ...(state.parentLoopId !== undefined
      ? { parentLoopId: state.parentLoopId }
      : {}),
    ...(state.activeWorkerTaskId !== undefined
      ? { activeWorkerTaskId: state.activeWorkerTaskId }
      : {}),
    ...(state.activeWorkerSessionId !== undefined
      ? { activeWorkerSessionId: state.activeWorkerSessionId }
      : {}),
    cancelRequested: state.cancelRequested,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    roundStartedAt: state.roundStartedAt,
    roundCount: state.rounds?.length ?? 0,
    ...(state.errorReason !== undefined ? { errorReason: state.errorReason } : {}),
  };
}

// ── Serialization helpers ────────────────────────────────────────────────────

/** Stable error body for every non-2xx response. */
function errorBody(message: string): RoleboxMonitorErrorBody {
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
 * timestamped event in each session's log (the same recency rule the
 * role-switch route uses). Sessions without any timestamped event rank as
 * inactive (`0`). Returns `undefined` when the store has no sessions.
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
