/// <reference types="bun-types" />

/**
 * DshRoleSwitchWebServer tests — the loopback HTTP surface for the dsh role
 * switcher, exercised against a real listening server (ephemeral port 0) with
 * a real DshRoleSwitcher wired to a fake SessionStore + fake cordis ctx
 * (platform-test convention).
 *
 * Verifies the documented route/error contract:
 *   - start() binds an ephemeral port and is idempotent
 *   - GET  /                      — self-contained HTML page with the role
 *                                    input box and the Switch button
 *   - GET  /api/roles             — switchable (primary-only) role list
 *   - POST /api/roles/switch      — round-trips a switch; the active role is
 *                                    then readable via GET /api/roles/active
 *   - POST /api/roles/switch with an unknown role → 400 `{ ok:false }`
 *   - DELETE /api/roles/active    — clears the active role
 *   - unknown routes → 404 `{ ok:false }`; known path + wrong method → 405
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RoleMode } from "../../src/constants.ts";
import {
  DshRoleSwitcher,
} from "../../src/platform/adapters/dsh/role-switcher.ts";
import {
  DshRoleSwitchWebServer,
} from "../../src/platform/adapters/dsh/web-role-switch-server.ts";
import {
  DshAgentRegistrar,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
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

// ── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Full fixture: primary roles `alpha`/`beta` + a subagent-mode `gamma` in the
 * catalog, a session `s1` in the store, and a real switcher + web server
 * (bound to an ephemeral loopback port by the beforeEach).
 */
async function createFixture() {
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
  const server = new DshRoleSwitchWebServer(switcher, store);
  return { switcher, store, server, s1 };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

let fixture: Fixture;

beforeEach(async () => {
  fixture = await createFixture();
  await fixture.server.start(0);
});

afterEach(async () => {
  await fixture.server.close();
});

/** Base URL of the running test server. */
function baseUrl(): string {
  return `http://127.0.0.1:${fixture.server.port}`;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("DshRoleSwitchWebServer lifecycle", () => {
  it("start() on port 0 binds an ephemeral port (port getter > 0)", () => {
    expect(fixture.server.port).toBeGreaterThan(0);
  });

  it("start() is idempotent (second call is a no-op, same port)", async () => {
    const port = fixture.server.port;
    await fixture.server.start(0);
    expect(fixture.server.port).toBe(port);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

describe("DshRoleSwitchWebServer routes", () => {
  it("GET / serves the page with the role input box and the switch button", async () => {
    const res = await fetch(`${baseUrl()}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<input id="role-input"');
    expect(html).toContain('<button type="submit">Switch</button>');
  });

  it("GET /api/roles returns the switchable roles (primary only)", async () => {
    const res = await fetch(`${baseUrl()}/api/roles`);

    expect(res.status).toBe(200);
    const roles = (await res.json()) as Array<{
      id: string;
      name: string;
      description: string;
      model: string | null;
      mode: string | null;
    }>;
    // Subagent-mode `gamma` is excluded; primary-only list sorted by id.
    expect(roles.map((r) => r.id)).toEqual(["alpha", "beta"]);
    for (const role of roles) {
      expect(role.mode).toBe(RoleMode.Primary);
      expect(typeof role.name).toBe("string");
      expect(typeof role.description).toBe("string");
      expect(role.model).toBeNull();
    }
  });

  it("POST /api/roles/switch round-trips a switch and the active role is readable", async () => {
    const res = await fetch(`${baseUrl()}/api/roles/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "alpha", session: "s1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, session: "s1", role: "alpha" });

    const active = await fetch(`${baseUrl()}/api/roles/active?session=s1`);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ session: "s1", role: "alpha" });
    expect(fixture.switcher.getActive("s1")).toBe("alpha");
  });

  it("POST /api/roles/switch with an unknown role returns 400 with a stable error body", async () => {
    const res = await fetch(`${baseUrl()}/api/roles/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ghost", session: "s1" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Unknown role");
    expect(fixture.switcher.getActive("s1")).toBeNull();
  });

  it("DELETE /api/roles/active clears the active role", async () => {
    await fetch(`${baseUrl()}/api/roles/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "alpha", session: "s1" }),
    });
    expect(fixture.switcher.getActive("s1")).toBe("alpha");

    const res = await fetch(`${baseUrl()}/api/roles/active?session=s1`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, session: "s1", role: null });
    expect(fixture.switcher.getActive("s1")).toBeNull();
  });

  it("unknown routes return 404 with a stable error body", async () => {
    const res = await fetch(`${baseUrl()}/api/nope`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "Not found" });
  });

  it("known paths with the wrong method return 405 (not 404)", async () => {
    // GET on a POST-only route: the path exists, so it must be 405.
    const res = await fetch(`${baseUrl()}/api/roles/switch`);

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: "Method not allowed" });
  });
});
