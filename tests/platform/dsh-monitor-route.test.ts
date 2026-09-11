/// <reference types="bun-types" />

/**
 * DshRoleboxMonitorWebRoute tests — the structural adapter exposing the
 * read-only rolebox runtime monitor surface as a `prefix` route on the host
 * web server.
 *
 * Like the role-switch route tests, these tests exercise the adapter against
 * a FAKE registrar double: the registered `{ kind: 'prefix', path:
 * '/rolebox', handler }` route is captured and the handler is invoked
 * directly with mock req/res — no `node:http` server is ever created.
 *
 * Verifies the documented route/error contract:
 *   - register() captures exactly one prefix route at `/rolebox` and returns
 *     a disposer that unregisters it
 *   - GET /rolebox/status  — composed 200 JSON: live loop summary (from
 *     LoopCoordinator.getAllLoopStates), engine-graph snapshots (from
 *     readLiveEngineGraphs over a fresh empty state dir → `[]`), and the
 *     session census (count, most recent id, per-session active roles from
 *     DshRoleSwitcher.getActive)
 *   - GET /rolebox/metrics — 200 JSON: the metrics snapshot shape
 *     (`{ counters, gauges, histograms }`)
 *   - unknown sub-routes → 404 `{ ok:false }`; known path + wrong method
 *     → 405
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleMode } from "../../src/constants.ts";
import { DshRoleSwitcher } from "../../src/platform/adapters/dsh/role-switcher.ts";
import {
  DshRoleboxMonitorWebRoute,
  ROLEBOX_MONITOR_ROUTE_PREFIX,
} from "../../src/platform/adapters/dsh/web-rolebox-monitor-route.ts";
import type {
  DshWebRouteLike,
  DshWebServerRouteRegistrar,
} from "../../src/platform/adapters/dsh/web-role-switch-route.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
  DshSubagentRuntime,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { DshCordisContext } from "../../src/platform/adapters/dsh/event-bridge.ts";
import type {
  DshSessionEventLike,
  DshSessionLike,
  DshSessionStoreLike,
} from "../../src/platform/adapters/dsh/session.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";
import type { LoopCoordinator } from "../../src/loop/coordinator.ts";
import type { LoopState } from "../../src/loop/types.ts";

// ── Fakes (platform-test convention) ────────────────────────────────────────

/** Fake cordis ctx — `on` subscriptions driven via `emit`. */
function createFakeCtx() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ctx: DshCordisContext = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        listeners.set(
          event,
          cur.filter((l) => l !== listener),
        );
      };
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
  return { ctx, listeners };
}

/** Fake dsh subagent runtime for the registrar. */
function createFakeSubagents(): DshSubagentRuntime {
  const providers = new Map<string, DshSubagentProvider>();
  return {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (name: string) => providers.get(name),
    list: () => [...providers.keys()],
  };
}

/** Minimal AgentDefinition factory for the switcher catalog. */
function makeAgent(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    description: `description for ${id}`,
    systemPrompt: `You are ${id}.`,
    ...overrides,
  };
}

/** Fake dsh Session with an event log that append() mutates in place. */
function makeSession(id: string, events: DshSessionEventLike[] = []): DshSessionLike {
  return {
    id,
    seq: events.length,
    events,
    header: { cwd: process.cwd() },
    append(type: string, data: unknown) {
      const evt = { id, seq: events.length, type, data } as DshSessionEventLike;
      events.push(evt);
      return evt;
    },
    deriveMessages: () => [],
  };
}

/** Fake dsh SessionStore keyed by session id. */
function makeStore(sessions: DshSessionLike[]): DshSessionStoreLike {
  const map = new Map(sessions.map((s) => [s.id, s]));
  return {
    create(id?: string) {
      const sessionId = id ?? `session-${map.size + 1}`;
      const session = makeSession(sessionId);
      map.set(sessionId, session);
      return session;
    },
    get(id: string) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
    fork(source: DshSessionLike) {
      const forked = makeSession(`${source.id}-fork`);
      map.set(forked.id, forked);
      return forked;
    },
  };
}

/** Fake registrar double — captures registered routes, returns disposers. */
function createFakeWebServer() {
  const registered: DshWebRouteLike[] = [];
  const webServer: DshWebServerRouteRegistrar = {
    register(route: DshWebRouteLike): () => void {
      registered.push(route);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const idx = registered.indexOf(route);
        if (idx >= 0) registered.splice(idx, 1);
      };
    },
  };
  return { webServer, registered };
}

/** Minimal LoopState factory with defaults for every required field. */
function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    originSessionId: "origin-1",
    agent: "emperor",
    basePrompt: "base prompt",
    mode: "inherit",
    total: 3,
    current: 2,
    phase: "awaiting_worker",
    cancelRequested: false,
    startedAt: 100,
    updatedAt: 200,
    roundStartedAt: 150,
    schemaVersion: 1,
    ...overrides,
  };
}

/** Fake LoopCoordinator — structural double exposing getAllLoopStates(). */
function makeLoopCoordinator(states: LoopState[] = []) {
  const map = new Map(states.map((s) => [s.originSessionId, s]));
  return {
    getAllLoopStates: () => new Map(map),
  } as unknown as LoopCoordinator;
}

// ── Mock req/res (no node:http server is created) ───────────────────────────

/** Minimal IncomingMessage double: url/method + data/end/error listeners. */
class MockReq {
  url: string;
  method: string;
  private listeners = new Map<string, Array<(chunk?: unknown) => void>>();

  constructor(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  on(event: string, cb: (chunk?: unknown) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }

  /** Emit a body chunk to registered `data` listeners. */
  push(chunk: string | Buffer): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const cb of this.listeners.get("data") ?? []) cb(buf);
  }

  /** Emit `end` to registered listeners. */
  finish(): void {
    for (const cb of this.listeners.get("end") ?? []) cb();
  }
}

/** Minimal ServerResponse double: records status/headers/body. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(text = "") {
    this.body = text;
    return this;
  }
}

/** Invoke a route handler with a mock req/res and await completion. */
async function invoke(
  handler: DshWebRouteLike["handler"],
  method: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  req.finish();
  if (pending) await pending;
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

/** Parse a JSON response body, or fail loudly if it isn't JSON. */
function json<T = any>(result: { text: string }): T {
  return JSON.parse(result.text) as T;
}

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Full fixture: primary roles `alpha`/`beta` in the catalog, sessions `s1`
 * (older) and `s2` (newer) in the store, one live loop, and a real switcher
 * + monitor route adapter over a fresh empty engine-state directory.
 */
async function createFixture() {
  const { ctx } = createFakeCtx();
  const registrar = new DshAgentRegistrar({ subagents: createFakeSubagents() });
  await registrar.register([
    makeAgent("alpha", { mode: RoleMode.Primary }),
    makeAgent("beta", { mode: RoleMode.Primary }),
  ]);
  const s1 = makeSession("s1", [{ type: "turn/start", timestamp: 1000 }]);
  const s2 = makeSession("s2", [{ type: "turn/start", timestamp: 2000 }]);
  const store = makeStore([s1, s2]);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx });
  const loopCoordinator = makeLoopCoordinator([
    makeLoopState({ originSessionId: "origin-1", agent: "emperor", current: 2, total: 3 }),
  ]);
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-monitor-route-"));
  const route = new DshRoleboxMonitorWebRoute(switcher, store, loopCoordinator, stateDir);
  return { switcher, store, route, stateDir, s1, s2 };
}

// ── Registration ────────────────────────────────────────────────────────────

describe("DshRoleboxMonitorWebRoute registration", () => {
  it("register() captures exactly one prefix route at /rolebox with a handler", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();

    fixture.route.register(webServer);

    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe("prefix");
    expect(registered[0].path).toBe("/rolebox");
    expect(registered[0].path).toBe(ROLEBOX_MONITOR_ROUTE_PREFIX);
    expect(typeof registered[0].handler).toBe("function");
  });

  it("the returned disposer unregisters the route", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();

    const dispose = fixture.route.register(webServer);
    expect(registered).toHaveLength(1);

    dispose();
    expect(registered).toHaveLength(0);
  });
});

// ── GET /rolebox/status ─────────────────────────────────────────────────────

describe("DshRoleboxMonitorWebRoute GET /rolebox/status", () => {
  it("returns 200 with the composed status JSON", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/status");

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toContain("application/json");

    const body = json<{
      ok: boolean;
      loops: { count: number; states: Array<Record<string, unknown>> };
      engineGraphs: unknown[];
      sessions: {
        count: number;
        mostRecentId: string | null;
        activeRoles: Record<string, string | null>;
      };
    }>(res);

    expect(body.ok).toBe(true);
    // Loop summary projected from LoopCoordinator.getAllLoopStates().
    expect(body.loops.count).toBe(1);
    expect(body.loops.states[0]).toMatchObject({
      originSessionId: "origin-1",
      agent: "emperor",
      phase: "awaiting_worker",
      current: 2,
      total: 3,
      mode: "inherit",
      cancelRequested: false,
      roundCount: 0,
    });
    expect(typeof body.loops.states[0].startedAt).toBe("number");
    expect(typeof body.loops.states[0].updatedAt).toBe("number");
    expect(typeof body.loops.states[0].roundStartedAt).toBe("number");
    // Engine-graph snapshot over a fresh empty state dir → empty array.
    expect(body.engineGraphs).toEqual([]);
    // Session census: count + most recent id (s2 has the newer event) +
    // per-session active roles (both base agent → null).
    expect(body.sessions.count).toBe(2);
    expect(body.sessions.mostRecentId).toBe("s2");
    expect(body.sessions.activeRoles).toEqual({ s1: null, s2: null });
  });

  it("reflects per-session active roles from the switcher", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const switched = await fixture.switcher.activate("alpha", "s1");
    expect(switched.ok).toBe(true);

    const res = await invoke(handler, "GET", "/rolebox/status");
    const body = json<{ sessions: { activeRoles: Record<string, string | null> } }>(res);

    expect(body.sessions.activeRoles).toEqual({ s1: "alpha", s2: null });
  });

  it("projects optional loop fields when present and omits them when absent", async () => {
    const fixture = await createFixture();
    const loopCoordinator = makeLoopCoordinator([
      makeLoopState({
        originSessionId: "origin-2",
        agent: "worker",
        phase: "error",
        errorReason: "round failed",
        parentLoopId: "origin-0",
        activeWorkerTaskId: "task-9",
        activeWorkerSessionId: "worker-9",
        rounds: [
          {
            round: 1,
            workerTaskId: "task-1",
            workerSessionId: "worker-1",
            startedAt: 10,
            completedAt: 20,
            durationMs: 10,
            status: "completed",
          },
        ],
      }),
    ]);
    const route = new DshRoleboxMonitorWebRoute(
      fixture.switcher,
      fixture.store,
      loopCoordinator,
      fixture.stateDir,
    );
    const { webServer, registered } = createFakeWebServer();
    route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/status");
    const body = json<{ loops: { count: number; states: Array<Record<string, unknown>> } }>(res);

    expect(body.loops.count).toBe(1);
    const state = body.loops.states[0];
    expect(state.originSessionId).toBe("origin-2");
    expect(state.phase).toBe("error");
    expect(state.errorReason).toBe("round failed");
    expect(state.parentLoopId).toBe("origin-0");
    expect(state.activeWorkerTaskId).toBe("task-9");
    expect(state.activeWorkerSessionId).toBe("worker-9");
    expect(state.roundCount).toBe(1);
    // `rounds` itself is never serialized — only the roundCount summary.
    expect("rounds" in state).toBe(false);
    // Optional fields absent on the source are omitted entirely.
    expect("errorReason" in body.loops.states[0]).toBe(true);
  });

  it("handles an empty store and empty loop registry", async () => {
    const fixture = await createFixture();
    const emptyStore = makeStore([]);
    const loopCoordinator = makeLoopCoordinator([]);
    const route = new DshRoleboxMonitorWebRoute(
      fixture.switcher,
      emptyStore,
      loopCoordinator,
      fixture.stateDir,
    );
    const { webServer, registered } = createFakeWebServer();
    route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/status");

    expect(res.status).toBe(200);
    const body = json<{
      loops: { count: number; states: unknown[] };
      sessions: { count: number; mostRecentId: string | null; activeRoles: Record<string, string | null> };
    }>(res);
    expect(body.loops.count).toBe(0);
    expect(body.loops.states).toEqual([]);
    expect(body.sessions.count).toBe(0);
    expect(body.sessions.mostRecentId).toBeNull();
    expect(body.sessions.activeRoles).toEqual({});
  });
});

// ── GET /rolebox/metrics ────────────────────────────────────────────────────

describe("DshRoleboxMonitorWebRoute GET /rolebox/metrics", () => {
  it("returns 200 with the metrics snapshot shape", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toContain("application/json");
    const body = json<{
      counters: Record<string, unknown>;
      gauges: Record<string, unknown>;
      histograms: Record<string, unknown>;
    }>(res);
    expect(typeof body.counters).toBe("object");
    expect(typeof body.gauges).toBe("object");
    expect(typeof body.histograms).toBe("object");
    expect(body.counters).not.toBeNull();
    expect(body.gauges).not.toBeNull();
    expect(body.histograms).not.toBeNull();
  });
});

// ── 404 / 405 ───────────────────────────────────────────────────────────────

describe("DshRoleboxMonitorWebRoute 404/405", () => {
  it("unknown routes under the prefix return 404 with a stable error body", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/nope");

    expect(res.status).toBe(404);
    expect(json<{ ok: boolean; error: string }>(res)).toEqual({ ok: false, error: "Not found" });
  });

  it("paths outside the prefix return 404", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/api/status");

    expect(res.status).toBe(404);
    expect(json<{ ok: boolean; error: string }>(res)).toEqual({ ok: false, error: "Not found" });
  });

  it("known paths with the wrong method return 405 (not 404)", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/status");

    expect(res.status).toBe(405);
    expect(json<{ ok: boolean; error: string }>(res)).toEqual({ ok: false, error: "Method not allowed" });
  });

  it("DELETE on the metrics path returns 405", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "DELETE", "/rolebox/metrics");

    expect(res.status).toBe(405);
    expect(json<{ ok: boolean; error: string }>(res)).toEqual({ ok: false, error: "Method not allowed" });
  });
});
