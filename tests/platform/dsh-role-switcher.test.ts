/// <reference types="bun-types" />

/**
 * DshRoleSwitcher tests — the in-session active-role switcher for the dsh
 * platform, exercised on a fake cordis ctx (on/emit double) plus a fake
 * SessionStore, following the existing platform-test convention
 * (tests/platform/dsh-hook-provider.test.ts, tests/platform/dsh-session.test.ts).
 *
 * Verifies:
 *   - listRoles() lists primary-mode roles only, sorted by id
 *   - activate() of a known primary role updates the per-session holder and
 *     appends a log-only `rolebox/active-role` event with data `{ id }`
 *   - activate() of an unknown / non-primary role returns `{ ok: false, error }`
 *     without touching state
 *   - activate(null) clears the active role and appends `{ id: null }`
 *   - the `session/created` listener restores the LAST persisted active role
 *     (and clears stale selections / explicit clears)
 *   - dispose() unsubscribes the restore listener
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { RoleMode } from "../../src/constants.ts";
import {
  DshRoleSwitcher,
  ACTIVE_ROLE_EVENT,
} from "../../src/platform/adapters/dsh/role-switcher.ts";
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

/**
 * Fake cordis ctx — records `on` subscriptions per event and lets tests
 * drive them via `emit`, exactly like the cordis Context event bus
 * (`ctx.on` / `ctx.emit`).
 */
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

/** Fake dsh subagent runtime for the registrar (registerProvider/getProvider/list). */
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

/**
 * Full fixture: a real DshAgentRegistrar (fake subagents seam) with the given
 * catalog, a fake SessionStore containing session `s1`, and a
 * DshRoleSwitcher wired to the fake ctx.
 */
async function createFixture(agents: AgentDefinition[]) {
  const { ctx, listeners } = createFakeCtx();
  const subagents = createFakeSubagents();
  const registrar = new DshAgentRegistrar({ subagents });
  await registrar.register(agents);
  const s1 = makeSession("s1");
  const store = makeStore([s1]);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx });
  return { ctx, listeners, registrar, subagents, store, s1, switcher };
}

// ── listRoles ───────────────────────────────────────────────────────────────

describe("DshRoleSwitcher.listRoles", () => {
  it("lists primary-mode roles only, sorted by id", async () => {
    const { switcher } = await createFixture([
      makeAgent("gamma", { mode: RoleMode.Subagent }),
      makeAgent("beta", { mode: RoleMode.Primary }),
      makeAgent("alpha", { mode: RoleMode.Primary }),
      makeAgent("delta", { mode: RoleMode.All }),
      makeAgent("epsilon"), // no mode → primary default
    ]);

    const ids = switcher.listRoles().map((a) => a.id);
    expect(ids).toEqual(["alpha", "beta", "epsilon"]);
  });
});

// ── activate ────────────────────────────────────────────────────────────────

describe("DshRoleSwitcher.activate", () => {
  it("activate of a known primary role updates state and appends the active-role event", async () => {
    const { switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("alpha", "s1");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("s1")).toBe("alpha");

    const session = store.get("s1")!;
    const events = session.events.filter((e) => e.type === ACTIVE_ROLE_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ id: "alpha" });
  });

  it("activate of an unknown role returns { ok: false } and does not change state", async () => {
    const { switcher } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("ghost", "s1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown role");
    expect(switcher.getActive("s1")).toBeNull();
  });

  it("activate of a non-primary (subagent-mode) role returns { ok: false }", async () => {
    const { switcher } = await createFixture([
      makeAgent("gamma", { mode: RoleMode.Subagent }),
    ]);

    const result = await switcher.activate("gamma", "s1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a primary role");
    expect(switcher.getActive("s1")).toBeNull();
  });

  it("activate still succeeds when the session is absent from the store (append is best-effort)", async () => {
    const { switcher } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("alpha", "no-such-session");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("no-such-session")).toBe("alpha");
  });

  it("clear (activate null) resets the active role and appends { id: null }", async () => {
    const { switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    await switcher.activate("alpha", "s1");
    expect(switcher.getActive("s1")).toBe("alpha");

    const result = await switcher.activate(null, "s1");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("s1")).toBeNull();

    const session = store.get("s1")!;
    const last = session.events
      .filter((e) => e.type === ACTIVE_ROLE_EVENT)
      .at(-1);
    expect(last?.data).toEqual({ id: null });
  });
});

// ── session/created restore ─────────────────────────────────────────────────

describe("DshRoleSwitcher session/created restore", () => {
  it("restores the LAST persisted active role for the new session", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
      makeAgent("beta", { mode: RoleMode.Primary }),
    ]);
    const s1 = store.get("s1")!;
    s1.append(ACTIVE_ROLE_EVENT, { id: "alpha" }, {});
    s1.append(ACTIVE_ROLE_EVENT, { id: "beta" }, {});

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBe("beta");
  });

  it("restores the base agent when the last persisted event is a clear", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    const s1 = store.get("s1")!;
    s1.append(ACTIVE_ROLE_EVENT, { id: "alpha" }, {});
    s1.append(ACTIVE_ROLE_EVENT, { id: null }, {});

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBeNull();
  });

  it("clears a persisted role that is no longer registered (stale selection)", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    const s1 = store.get("s1")!;
    s1.append(ACTIVE_ROLE_EVENT, { id: "ghost" }, {});

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBeNull();
  });

  it("leaves a session without active-role events untouched", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    const s1 = store.get("s1")!;
    s1.append("user/message", { message: { role: "user", content: [] } }, {});

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBeNull();
  });

  it("accepts a session-id string payload (falls back to a store lookup)", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    const s1 = store.get("s1")!;
    s1.append(ACTIVE_ROLE_EVENT, { id: "alpha" }, {});

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("alpha");
  });
});

// ── dispose ─────────────────────────────────────────────────────────────────

describe("DshRoleSwitcher.dispose", () => {
  it("unsubscribes the session/created listener", async () => {
    const { ctx, switcher, store } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    switcher.dispose();

    const s1 = store.get("s1")!;
    s1.append(ACTIVE_ROLE_EVENT, { id: "alpha" }, {});
    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBeNull();
  });
});
