/// <reference types="bun-types" />

/**
 * DshRoleSwitcher tests — the in-session active-role switcher for the dsh
 * platform, exercised on a fake cordis ctx (on/emit double) plus a fake
 * SessionStore and an in-memory ActiveRolePersistence sidecar double
 * (following the existing platform-test convention:
 * tests/platform/dsh-hook-provider.test.ts, tests/platform/dsh-session.test.ts).
 *
 * sidecar cutover: active-role durability moved OFF the dsh session event log
 * (`rolebox/active-role` broke rc.6 reload) and ONTO a rolebox-owned sidecar.
 * These tests pin the new contract:
 *   - listRoles() lists primary-mode roles only, sorted by id
 *   - activate() of a known primary role updates the holder and persists an
 *     entry `{ sessionId, roleId, updatedAt }` through the injected seam
 *   - activate() of an unknown / non-primary role returns `{ ok: false, error }`
 *     without touching state or persistence
 *   - activate(null) records an explicit `roleId: null` clear
 *   - the holder hydrates synchronously from `persistence.load()` at creation
 *   - the `session/created` listener restores with the three-source precedence:
 *     (1) sidecar entry (incl. an explicit clear), (2) read-only adoption of a
 *     previous `rolebox/active-role` event into the sidecar, (3) fork
 *     inheritance via `header.parentSession`; a stale role is cleared and no
 *     path ever appends to the session log
 *   - dispose() unsubscribes the restore listener
 *   - no `session.append(...)` call and no platform-SDK import remains
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RoleMode } from "../../src/constants.ts";
import {
  DshRoleSwitcher,
  createActiveRoleRef,
} from "../../src/platform/adapters/dsh/role-switcher.ts";
import type { ActiveRolePersistence } from "../../src/platform/adapters/dsh/role-switcher.ts";
import { DshSkillProvider } from "../../src/platform/adapters/dsh/skill-provider.ts";
import type { ActiveRoleEntry } from "../../src/platform/adapters/dsh/active-role-store.ts";
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
function makeSession(
  id: string,
  events: DshSessionEventLike[] = [],
  header: Record<string, unknown> = { cwd: process.cwd() },
): DshSessionLike {
  return {
    id,
    seq: events.length,
    events,
    header,
    append(type: string, data: unknown) {
      const evt = { id, seq: events.length, type, data, time: Date.now() } as DshSessionEventLike;
      events.push(evt);
      return evt;
    },
    deriveMessages: () => [],
  };
}

/**
 * A previous legacy `rolebox/active-role` session event. `id: null` models the
 * old explicit clear. Rolebox now only READS these (read-only adoption).
 */
function makeLegacyEvent(id: string | null): DshSessionEventLike {
  return { type: "rolebox/active-role", seq: 0, time: 1, data: { id } };
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
 * In-memory {@link ActiveRolePersistence} double. `load()` returns a COPY
 * (matching the file-backed store, which rebuilds a fresh map); `save()`
 * snapshots each call so tests can assert the persisted payload.
 */
function createFakePersistence(initial: Record<string, string | null> = {}): {
  persistence: ActiveRolePersistence;
  saves: Array<Map<string, ActiveRoleEntry>>;
} {
  const state = new Map<string, ActiveRoleEntry>();
  for (const [sessionId, roleId] of Object.entries(initial)) {
    state.set(sessionId, { sessionId, roleId, updatedAt: 1 });
  }
  const saves: Array<Map<string, ActiveRoleEntry>> = [];
  return {
    persistence: {
      load: () => new Map(state),
      save: (sessions) => {
        saves.push(new Map(sessions));
      },
    },
    saves,
  };
}

/**
 * Full fixture: a real DshAgentRegistrar (fake subagents seam) with the given
 * catalog, a fake SessionStore containing session `s1`, a fake sidecar
 * persistence, and a DshRoleSwitcher wired to the fake ctx.
 */
async function createFixture(
  agents: AgentDefinition[],
  initial: Record<string, string | null> = {},
  s1Events: DshSessionEventLike[] = [],
  options: {
    onActiveRoleChanged?: (sessionId: string, roleId: string | null) => void;
  } = {},
) {
  const { ctx, listeners } = createFakeCtx();
  const subagents = createFakeSubagents();
  const registrar = new DshAgentRegistrar({ subagents });
  await registrar.register(agents);
  const s1 = makeSession("s1", s1Events);
  const store = makeStore([s1]);
  const { persistence, saves } = createFakePersistence(initial);
  const activeRole = createActiveRoleRef(persistence);
  const switcher = new DshRoleSwitcher({
    registrar,
    store,
    ctx,
    activeRole,
    ...(options.onActiveRoleChanged
      ? { onActiveRoleChanged: options.onActiveRoleChanged }
      : {}),
  });
  return { ctx, listeners, registrar, subagents, store, s1, switcher, activeRole, persistence, saves };
}

/**
 * Let queued microtasks settle — the `session/flush` drain is fire-and-forget
 * from the cordis listener's perspective.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build a switcher around a caller-supplied persistence seam (used to drive
 * throwing/rejecting sidecar saves).
 */
async function createSwitcherWithPersistence(
  persistence: ActiveRolePersistence,
  agents: AgentDefinition[] = [makeAgent("alpha", { mode: RoleMode.Primary })],
) {
  const { ctx } = createFakeCtx();
  const subagents = createFakeSubagents();
  const registrar = new DshAgentRegistrar({ subagents });
  await registrar.register(agents);
  const store = makeStore([makeSession("s1")]);
  const activeRole = createActiveRoleRef(persistence);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx, activeRole });
  return { ctx, switcher, activeRole };
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
  it("activate of a known primary role updates state and persists a sidecar entry", async () => {
    const { switcher, saves } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("alpha", "s1");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("s1")).toBe("alpha");
    expect(saves).toHaveLength(1);
    expect(saves[0].get("s1")).toMatchObject({ sessionId: "s1", roleId: "alpha" });
  });

  it("activate of an unknown role returns { ok: false } and does not change state or persist", async () => {
    const { switcher, saves } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("ghost", "s1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown role");
    expect(switcher.getActive("s1")).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it("activate of a non-primary (subagent-mode) role returns { ok: false } and does not persist", async () => {
    const { switcher, saves } = await createFixture([
      makeAgent("gamma", { mode: RoleMode.Subagent }),
    ]);

    const result = await switcher.activate("gamma", "s1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a primary role");
    expect(switcher.getActive("s1")).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it("activate does not require the session to exist in the dsh SessionStore", async () => {
    const { switcher, saves } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);

    const result = await switcher.activate("alpha", "no-such-session");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("no-such-session")).toBe("alpha");
    expect(saves.at(-1)?.get("no-such-session")).toMatchObject({
      sessionId: "no-such-session",
      roleId: "alpha",
    });
  });

  it("clear (activate null) resets the active role and records an explicit roleId: null", async () => {
    const { switcher, saves } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    await switcher.activate("alpha", "s1");
    expect(switcher.getActive("s1")).toBe("alpha");

    const result = await switcher.activate(null, "s1");

    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("s1")).toBeNull();
    expect(saves.at(-1)?.get("s1")).toMatchObject({ sessionId: "s1", roleId: null });
  });
});

// ── onActiveRoleChanged (subtask 7 skill-catalog refresh hook) ──────────────

describe("DshRoleSwitcher onActiveRoleChanged", () => {
  it("fires once per applied switch and once per clear, carrying the new state", async () => {
    const calls: Array<{ sessionId: string; roleId: string | null }> = [];
    const { switcher } = await createFixture(
      [
        makeAgent("alpha", { mode: RoleMode.Primary }),
        makeAgent("beta", { mode: RoleMode.Primary }),
      ],
      {},
      [],
      { onActiveRoleChanged: (sessionId, roleId) => calls.push({ sessionId, roleId }) },
    );

    await switcher.activate("alpha", "s1");
    expect(calls).toEqual([{ sessionId: "s1", roleId: "alpha" }]);

    await switcher.activate(null, "s1");
    expect(calls).toEqual([
      { sessionId: "s1", roleId: "alpha" },
      { sessionId: "s1", roleId: null },
    ]);
  });

  it("does not fire for a rejected switch (unknown / non-primary role)", async () => {
    const calls: unknown[] = [];
    const { switcher } = await createFixture(
      [makeAgent("gamma", { mode: RoleMode.Subagent })],
      {},
      [],
      { onActiveRoleChanged: (...args) => calls.push(args) },
    );

    expect((await switcher.activate("ghost", "s1")).ok).toBe(false);
    expect((await switcher.activate("gamma", "s1")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fires on a session/created restore (the active set changed too)", async () => {
    const calls: Array<{ sessionId: string; roleId: string | null }> = [];
    const { ctx } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
      [],
      { onActiveRoleChanged: (sessionId, roleId) => calls.push({ sessionId, roleId }) },
    );

    ctx.emit("session/created", "s1");

    expect(calls).toEqual([{ sessionId: "s1", roleId: "alpha" }]);
  });

  it("a throwing hook never fails the switch", async () => {
    const { switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [],
      {
        onActiveRoleChanged: () => {
          throw new Error("hook exploded");
        },
      },
    );

    const result = await switcher.activate("alpha", "s1");
    expect(result).toEqual({ ok: true });
    expect(switcher.getActive("s1")).toBe("alpha");
  });

  it("a role switch triggers exactly one control.invalidate() (provider integration)", async () => {
    let invalidations = 0;
    const provider = new DshSkillProvider(
      { roles: [], activeRole: { snapshot: () => new Map() } },
      {
        signal: new AbortController().signal,
        invalidate: () => invalidations++,
      },
    );
    const { switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [],
      { onActiveRoleChanged: () => provider.invalidate() },
    );

    await switcher.activate("alpha", "s1");

    expect(invalidations).toBe(1);
  });
});

// ── ActiveRoleRef: sidecar hydration + async write ──────────────────────────

describe("createActiveRoleRef sidecar hydration", () => {
  it("hydrates synchronously from persistence.load() at construction", () => {
    const { persistence, saves } = createFakePersistence({ s1: "alpha", s2: null });

    const ref = createActiveRoleRef(persistence);

    expect(ref.get("s1")).toBe("alpha");
    expect(ref.get("s2")).toBeNull(); // explicit clear persisted
    expect(ref.get("s3")).toBeNull(); // never written
    expect(saves).toHaveLength(0); // hydration is a read, not a write
  });

  it("without persistence the holder is in-memory only and never writes", () => {
    const ref = createActiveRoleRef();

    expect(ref.get("s1")).toBeNull();
    ref.set("s1", "alpha");
    expect(ref.get("s1")).toBe("alpha");
    ref.set("s1", null);
    expect(ref.get("s1")).toBeNull();
  });

  it("a load() that throws degrades to an empty holder instead of failing construction", () => {
    const persistence: ActiveRolePersistence = {
      load: () => {
        throw new Error("boom");
      },
      save: () => {},
    };

    const ref = createActiveRoleRef(persistence);
    expect(ref.get("s1")).toBeNull();
  });

  it("a save() that throws synchronously does not fail the in-memory set", () => {
    const persistence: ActiveRolePersistence = {
      load: () => null,
      save: () => {
        throw new Error("disk full");
      },
    };

    const ref = createActiveRoleRef(persistence);
    expect(() => ref.set("s1", "alpha")).not.toThrow();
    expect(ref.get("s1")).toBe("alpha");
  });
});

// ── session/created restore ─────────────────────────────────────────────────

describe("DshRoleSwitcher session/created restore", () => {
  it("restores the persisted active role for the new session", async () => {
    const { ctx, switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("alpha");
  });

  it("restores the base agent when the persisted entry is an explicit clear", async () => {
    const { ctx, switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: null },
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
  });

  it("clears a persisted role that is no longer registered (stale selection)", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "ghost" },
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
    expect(saves.at(-1)?.get("s1")).toMatchObject({ sessionId: "s1", roleId: null });
  });

  it("clears a persisted role that is no longer primary", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("gamma", { mode: RoleMode.Subagent })],
      { s1: "gamma" },
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
    expect(saves.at(-1)?.get("s1")).toMatchObject({ roleId: null });
  });

  it("leaves a session without a sidecar entry untouched", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it("accepts a session-id string payload (falls back to a store lookup)", async () => {
    const { ctx, switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("alpha");
  });

  it("accepts a Session object payload directly", async () => {
    const { ctx, switcher, s1 } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBe("alpha");
  });

  it("a fork inherits its parent's active role (header.parentSession)", async () => {
    const { ctx, switcher, store, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );
    const fork = makeSession("s1-fork", [], {
      cwd: process.cwd(),
      parentSession: "s1",
    });
    // Register the fork so id-only payload resolution could find it too.
    (store as unknown as { create(id?: string): DshSessionLike }).create("s1-fork");

    ctx.emit("session/created", fork);

    expect(switcher.getActive("s1-fork")).toBe("alpha");
    // The inherited selection is persisted under the fork's own id.
    expect(saves.at(-1)?.get("s1-fork")).toMatchObject({
      sessionId: "s1-fork",
      roleId: "alpha",
    });
  });

  it("a fork with its own entry does not inherit the parent's selection", async () => {
    const { ctx, switcher } = await createFixture(
      [
        makeAgent("alpha", { mode: RoleMode.Primary }),
        makeAgent("beta", { mode: RoleMode.Primary }),
      ],
      { s1: "alpha", "s1-fork": "beta" },
    );
    const fork = makeSession("s1-fork", [], {
      cwd: process.cwd(),
      parentSession: "s1",
    });

    ctx.emit("session/created", fork);

    expect(switcher.getActive("s1-fork")).toBe("beta");
  });

  it("a fork whose parent has no active role stays at the base agent", async () => {
    const { ctx, switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
    );
    const fork = makeSession("s1-fork", [], {
      cwd: process.cwd(),
      parentSession: "s1",
    });

    ctx.emit("session/created", fork);

    expect(switcher.getActive("s1-fork")).toBeNull();
  });
});

// ── legacy-event adoption (restore precedence path 2) ───────────────────────

describe("DshRoleSwitcher legacy-event adoption", () => {
  it("adopts a legacy rolebox/active-role event into the sidecar", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [makeLegacyEvent("alpha")],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("alpha");
    expect(saves.at(-1)?.get("s1")).toMatchObject({
      sessionId: "s1",
      roleId: "alpha",
    });
  });

  it("adopts the LAST legacy event when the log carries several", async () => {
    const { ctx, switcher } = await createFixture(
      [
        makeAgent("alpha", { mode: RoleMode.Primary }),
        makeAgent("beta", { mode: RoleMode.Primary }),
      ],
      {},
      [makeLegacyEvent("alpha"), makeLegacyEvent("beta")],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("beta");
  });

  it("adopts a legacy explicit clear (id: null) as the base agent", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [makeLegacyEvent("alpha"), makeLegacyEvent(null)],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
    expect(saves.at(-1)?.get("s1")).toMatchObject({ sessionId: "s1", roleId: null });
  });

  it("clears a stale legacy role that is no longer registered", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [makeLegacyEvent("ghost")],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
    expect(saves.at(-1)?.get("s1")).toMatchObject({ roleId: null });
  });

  it("prefers a sidecar entry over a legacy event (sidecar precedence)", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [
        makeAgent("alpha", { mode: RoleMode.Primary }),
        makeAgent("beta", { mode: RoleMode.Primary }),
      ],
      { s1: "beta" },
      [makeLegacyEvent("alpha")],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBe("beta");
    expect(saves.every((s) => s.get("s1")?.roleId !== "alpha")).toBe(true);
  });

  it("prefers a sidecar explicit clear over a legacy role", async () => {
    const { ctx, switcher } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: null },
      [makeLegacyEvent("alpha")],
    );

    ctx.emit("session/created", "s1");

    expect(switcher.getActive("s1")).toBeNull();
  });

  it("adopts a legacy event without appending to the session log", async () => {
    const { ctx, switcher, s1 } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [makeLegacyEvent("alpha")],
    );
    const before = s1.events.length;

    ctx.emit("session/created", s1);

    expect(switcher.getActive("s1")).toBe("alpha");
    expect(s1.events.length).toBe(before);
  });

  it("a fork inherits its parent's legacy selection when the parent has no sidecar entry", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      {},
      [makeLegacyEvent("alpha")],
    );
    const fork = makeSession("s1-fork", [], {
      cwd: process.cwd(),
      parentSession: "s1",
    });

    ctx.emit("session/created", fork);

    expect(switcher.getActive("s1-fork")).toBe("alpha");
    expect(saves.at(-1)?.get("s1-fork")).toMatchObject({ roleId: "alpha" });
  });
});

// ── dispose ─────────────────────────────────────────────────────────────────

describe("DshRoleSwitcher.dispose", () => {
  it("unsubscribes the session/created listener", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "ghost" },
    );
    switcher.dispose();

    ctx.emit("session/created", "s1");

    // The listener would have cleared the stale "ghost" selection; with it
    // unsubscribed the hydrated in-memory value is untouched.
    expect(switcher.getActive("s1")).toBe("ghost");
    expect(saves).toHaveLength(0);
  });
});

// ── session/flush durability checkpoint ───────────────────────────────
//
// The harness emits `session/flush` when it flushes a session's log; rolebox
// drains the workspace active-role sidecar on it (contract §4.1). The drain is
// bounded and non-throwing so a slow/failing disk never blocks the harness.

describe("DshRoleSwitcher session/flush drain", () => {
  it("persists the active-role map when the harness emits session/flush", async () => {
    const { ctx, switcher, saves } = await createFixture([
      makeAgent("alpha", { mode: RoleMode.Primary }),
    ]);
    await switcher.activate("alpha", "s1");
    saves.length = 0; // isolate the checkpoint write from the switch write

    ctx.emit("session/flush", "s1");
    await flushMicrotasks();

    expect(saves).toHaveLength(1);
    expect(saves[0].get("s1")).toMatchObject({ sessionId: "s1", roleId: "alpha" });
  });

  it("flushes hydrated sidecar state even when no switch happened", async () => {
    const { ctx, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );
    // Hydration is a read, not a write.
    expect(saves).toHaveLength(0);

    ctx.emit("session/flush", "s1");
    await flushMicrotasks();

    expect(saves).toHaveLength(1);
    expect(saves[0].get("s1")?.roleId).toBe("alpha");
  });

  it("dispose() unsubscribes the session/flush listener", async () => {
    const { ctx, switcher, saves } = await createFixture(
      [makeAgent("alpha", { mode: RoleMode.Primary })],
      { s1: "alpha" },
    );
    switcher.dispose();

    ctx.emit("session/flush", "s1");
    await flushMicrotasks();

    expect(saves).toHaveLength(0);
  });

  it("a rejecting sidecar save does not throw into the flush handler", async () => {
    const { ctx } = await createSwitcherWithPersistence({
      load: () => new Map([["s1", { sessionId: "s1", roleId: "alpha", updatedAt: 1 }]]),
      save: () => Promise.reject(new Error("disk full")),
    });

    expect(() => ctx.emit("session/flush", "s1")).not.toThrow();
    await flushMicrotasks(); // let the handled rejection settle
  });

  it("a synchronously-throwing sidecar save does not throw into the flush handler", async () => {
    const { ctx } = await createSwitcherWithPersistence({
      load: () => null,
      save: () => {
        throw new Error("sync boom");
      },
    });

    expect(() => ctx.emit("session/flush", "s1")).not.toThrow();
    await flushMicrotasks();
  });

  it("flush() with no persistence is a non-throwing no-op", async () => {
    const ref = createActiveRoleRef();
    await expect(ref.flush()).resolves.toBeUndefined();
  });
});

// ── ActiveRoleRef.snapshot ──────────────────────────────────────────────────

describe("createActiveRoleRef snapshot", () => {
  it("returns an independent copy of the map", () => {
    const { persistence } = createFakePersistence({ s1: "alpha" });
    const ref = createActiveRoleRef(persistence);

    const snapshot = ref.snapshot();
    expect(snapshot.get("s1")?.roleId).toBe("alpha");

    snapshot.set("s2", { sessionId: "s2", roleId: "beta", updatedAt: 1 });
    expect(ref.has("s2")).toBe(false);
    expect(ref.get("s2")).toBeNull();
  });
});

// ── regression: no session-log event, no platform SDK import ────────────

describe("dsh role-switcher boundary", () => {
  const ROLE_SWITCHER = resolve(
    import.meta.dir,
    "../../src/platform/adapters/dsh/role-switcher.ts",
  );
  const BARREL = resolve(
    import.meta.dir,
    "../../src/platform/adapters/dsh/index.ts",
  );

  it("role-switcher no longer appends a session event", () => {
    const source = readFileSync(ROLE_SWITCHER, "utf-8");
    expect(source.includes("session.append(")).toBe(false);
    expect(source.includes("appendActiveRole")).toBe(false);
    expect(source.includes("scanActiveRole")).toBe(false);
  });

  it("the barrel no longer exports ACTIVE_ROLE_EVENT", () => {
    const source = readFileSync(BARREL, "utf-8");
    expect(source.includes("ACTIVE_ROLE_EVENT")).toBe(false);
  });

  it("the dsh role-switcher sources stay free of @opencode-ai / @deepseek-ai imports", () => {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    for (const file of [ROLE_SWITCHER, BARREL]) {
      const source = readFileSync(file, "utf-8");
      const specifiers: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(source)) !== null) {
        specifiers.push(match[1]);
      }
      const forbidden = specifiers.filter(
        (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
      );
      expect(forbidden, `${file} imports platform SDK packages`).toEqual([]);
    }
  });
});
