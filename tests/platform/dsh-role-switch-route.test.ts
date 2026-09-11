/// <reference types="bun-types" />

/**
 * DshRoleSwitchWebRoute tests — the structural adapter registering the dsh
 * role switcher's REST surface as a `prefix` route on the host web server.
 *
 * Unlike the loopback-server tests (which bind a real TCP socket), these
 * tests exercise the adapter against a FAKE registrar double: the registered
 * `{ kind: 'prefix', path: '/rolebox', handler }` route is captured and the
 * handler is invoked directly with mock req/res — no `node:http` server is
 * ever created.
 *
 * Verifies the documented route/error contract:
 *   - register() captures exactly one prefix route at `/rolebox` and returns
 *     a disposer that unregisters it
 *   - GET    /rolebox/roles          — switchable (primary-only) role list
 *   - GET    /rolebox/roles/active   — `{ session, role }`
 *   - POST   /rolebox/roles/switch   — round-trips a switch
 *   - POST   /rolebox/roles/switch with an unknown role → 400 `{ ok:false }`
 *   - POST   /rolebox/roles/switch with a missing role → 400
 *   - POST   /rolebox/roles/switch with malformed JSON → 400
 *   - POST   /rolebox/roles/switch with an oversized body → 413
 *   - DELETE /rolebox/roles/active   — clears the active role
 *   - session resolution: explicit session wins → most recent store session
 *     → `"default"`
 *   - unknown sub-routes → 404 `{ ok:false }`; known path + wrong method
 *     → 405
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RoleMode } from "../../src/constants.ts";
import { DshRoleSwitcher } from "../../src/platform/adapters/dsh/role-switcher.ts";
import {
  DshRoleSwitchWebRoute,
  ROLE_SWITCH_ROUTE_PREFIX,
} from "../../src/platform/adapters/dsh/web-role-switch-route.ts";
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
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockReq(method, path);
  const res = new MockRes();
  const pending = handler(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  if (body !== undefined) req.push(body);
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
 * Full fixture: primary roles `alpha`/`beta` + a subagent-mode `gamma` in the
 * catalog, a session `s1` in the store, and a real switcher + route adapter.
 */
async function createFixture(options?: { maxBodyBytes?: number }) {
  const { ctx } = createFakeCtx();
  const registrar = new DshAgentRegistrar({ subagents: createFakeSubagents() });
  await registrar.register([
    makeAgent("beta", { mode: RoleMode.Primary }),
    makeAgent("alpha", { mode: RoleMode.Primary }),
    makeAgent("gamma", { mode: RoleMode.Subagent }),
  ]);
  const s1 = makeSession("s1");
  const store = makeStore([s1]);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx });
  const route = new DshRoleSwitchWebRoute(switcher, store, options);
  return { switcher, store, route, s1 };
}

// ── Registration ────────────────────────────────────────────────────────────

describe("DshRoleSwitchWebRoute registration", () => {
  it("register() captures exactly one prefix route at /rolebox with a handler", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();

    fixture.route.register(webServer);

    expect(registered).toHaveLength(1);
    expect(registered[0].kind).toBe("prefix");
    expect(registered[0].path).toBe("/rolebox");
    expect(registered[0].path).toBe(ROLE_SWITCH_ROUTE_PREFIX);
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

// ── Routes ──────────────────────────────────────────────────────────────────

describe("DshRoleSwitchWebRoute routes", () => {
  it("GET /rolebox/roles returns the switchable roles (primary only)", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/roles");

    expect(res.status).toBe(200);
    const roles = json<
      Array<{
        id: string;
        name: string;
        description: string;
        model: string | null;
        mode: string | null;
      }>
    >(res);
    // Subagent-mode `gamma` is excluded; primary-only list sorted by id.
    expect(roles.map((r) => r.id)).toEqual(["alpha", "beta"]);
    for (const role of roles) {
      expect(role.mode).toBe(RoleMode.Primary);
      expect(typeof role.name).toBe("string");
      expect(typeof role.description).toBe("string");
      expect(role.model).toBeNull();
    }
  });

  it("GET /rolebox/roles/active returns { session, role } (null for base)", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/roles/active?session=s1");

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ session: "s1", role: null });
  });

  it("POST /rolebox/roles/switch round-trips a switch and the active role is readable", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      role: "alpha",
      session: "s1",
    }));

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, session: "s1", role: "alpha" });

    const active = await invoke(handler, "GET", "/rolebox/roles/active?session=s1");
    expect(active.status).toBe(200);
    expect(json(active)).toEqual({ session: "s1", role: "alpha" });
    expect(fixture.switcher.getActive("s1")).toBe("alpha");
  });

  it("POST /rolebox/roles/switch with an unknown role returns 400 with a stable error body", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      role: "ghost",
      session: "s1",
    }));

    expect(res.status).toBe(400);
    const body = json<{ ok: boolean; error: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Unknown role");
    expect(fixture.switcher.getActive("s1")).toBeNull();
  });

  it("POST /rolebox/roles/switch with a missing role field returns 400", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      session: "s1",
    }));

    expect(res.status).toBe(400);
    expect(json(res)).toEqual({ ok: false, error: "Missing or invalid 'role' field" });
  });

  it("POST /rolebox/roles/switch with malformed JSON returns 400", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", "{not json");

    expect(res.status).toBe(400);
    expect(json(res)).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("POST /rolebox/roles/switch with an oversized body returns 413", async () => {
    const fixture = await createFixture({ maxBodyBytes: 8 });
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      role: "alpha",
      session: "s1",
    }));

    expect(res.status).toBe(413);
    expect(json(res)).toEqual({ ok: false, error: "Request body too large" });
    expect(fixture.switcher.getActive("s1")).toBeNull();
  });

  it("DELETE /rolebox/roles/active clears the active role", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      role: "alpha",
      session: "s1",
    }));
    expect(fixture.switcher.getActive("s1")).toBe("alpha");

    const res = await invoke(handler, "DELETE", "/rolebox/roles/active?session=s1");

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, session: "s1", role: null });
    expect(fixture.switcher.getActive("s1")).toBeNull();
  });
});

// ── Session resolution ──────────────────────────────────────────────────────

describe("DshRoleSwitchWebRoute session resolution", () => {
  it("an explicit ?session= query wins for reads", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/roles/active?session=other");

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ session: "other", role: null });
  });

  it("an explicit body session wins for switches", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "POST", "/rolebox/roles/switch", JSON.stringify({
      role: "alpha",
      session: "custom",
    }));

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, session: "custom", role: "alpha" });
    expect(fixture.switcher.getActive("custom")).toBe("alpha");
  });

  it("falls back to the most recent session in the store", async () => {
    const fixture = await createFixture();
    const older = makeSession("old", [{ type: "turn/start", timestamp: 100 }]);
    const newer = makeSession("new", [{ type: "turn/start", timestamp: 200 }]);
    fixture.store = makeStore([older, newer]) as typeof fixture.store;
    // Rebuild the route against the two-session store.
    const route = new DshRoleSwitchWebRoute(fixture.switcher, fixture.store);
    const { webServer, registered } = createFakeWebServer();
    route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/roles/active");

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ session: "new", role: null });
  });

  it("falls back to the literal 'default' key with no sessions", async () => {
    const { ctx } = createFakeCtx();
    const registrar = new DshAgentRegistrar({ subagents: createFakeSubagents() });
    await registrar.register([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    const emptyStore = makeStore([]);
    const switcher = new DshRoleSwitcher({ registrar, store: emptyStore, ctx });
    const route = new DshRoleSwitchWebRoute(switcher, emptyStore);
    const { webServer, registered } = createFakeWebServer();
    route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/roles/active");

    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ session: "default", role: null });
  });
});

// ── 404 / 405 ───────────────────────────────────────────────────────────────

describe("DshRoleSwitchWebRoute 404/405", () => {
  it("unknown routes under the prefix return 404 with a stable error body", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/rolebox/nope");

    expect(res.status).toBe(404);
    expect(json(res)).toEqual({ ok: false, error: "Not found" });
  });

  it("paths outside the prefix return 404", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "GET", "/api/roles");

    expect(res.status).toBe(404);
    expect(json(res)).toEqual({ ok: false, error: "Not found" });
  });

  it("known paths with the wrong method return 405 (not 404)", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    // GET on a POST-only route: the path exists, so it must be 405.
    const res = await invoke(handler, "GET", "/rolebox/roles/switch");

    expect(res.status).toBe(405);
    expect(json(res)).toEqual({ ok: false, error: "Method not allowed" });
  });

  it("DELETE on the roles list path returns 405", async () => {
    const fixture = await createFixture();
    const { webServer, registered } = createFakeWebServer();
    fixture.route.register(webServer);
    const handler = registered[0].handler;

    const res = await invoke(handler, "DELETE", "/rolebox/roles");

    expect(res.status).toBe(405);
    expect(json(res)).toEqual({ ok: false, error: "Method not allowed" });
  });
});
