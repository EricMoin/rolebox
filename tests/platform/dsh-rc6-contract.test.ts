/// <reference types="bun-types" />

/**
 * dsh contract probes against the REAL installed `@deepseek-ai/*` dist.
 *
 * These tests import the actual `@deepseek-ai/dsh-session` package from
 * `node_modules` (currently the installed `0.1.5-rc.1`, the version rolebox
 * runs) and mount it on a real `@deepseek-ai/cordis` Context — the same way
 * `tests/dsh-cordis-e2e.test.ts:41-42,337,352` mounts a real harness service
 * (`new Context()` then `await ctx.plugin(Service, {})`; mounting is async).
 *
 * The file retains its historical `rc6` name (the verify command and sibling
 * docs reference it); after the `0.1.5-rc.1` pin bump the assertions were
 * migrated to the current package API. Existing `tests/dsh-*.test.ts` /
 * `tests/platform/dsh-*.test.ts` suites exercise rolebox's own duck-typed
 * fakes, so they are self-consistent with whatever shape rolebox assumes and
 * cannot detect drift against the harness. This file probes the harness
 * directly, so it fails if the installed contract moves — it is intentionally
 * independent of `src/`.
 *
 * Covered assertions (audit finding -> installed-package source):
 *   (a) `session/event` delivers exactly 2 args — `(session, event)`; arg0 has
 *       no `type`, arg1 is the `{type,seq,time,data}` event.
 *       `dsh-session` `session/event` emit contract.
 *   (b) `session/created` and `session/flush` each deliver exactly 1 arg.
 *       `dsh-session` `SessionStore` dispatch contract.
 *   (c) `fork(s,{messageID})` throws `INVALID_BOUNDARY`; `fork(s,0)` succeeds.
 *       `dsh-session` `SessionForkErrorCode`.
 *   (d) `create(undefined,{directory})` yields a header WITHOUT `cwd`;
 *       `create(undefined,{meta:{cwd}})` yields one WITH `cwd`.
 *       `dsh-session` `CreateSessionOptions.meta.cwd`.
 *   (e) `session.header.version` is a number; there is no `formatVersion`.
 *       `dsh-session` `SessionHeader.version`.
 *   (f) an appended event envelope is `{type,seq,time:<number>,data}`.
 *       `dsh-session` `Session.append` return contract.
 *   (g) `todo/write` data is `{todos:TodoItem[]}`; `user/message` data IS the
 *       `UserMessage` (content top-level, no `.message`).
 *       `dsh-session` `SessionEventMap`.
 *   (h) `KNOWN_SESSION_EVENT_TYPES` excludes `rolebox/active-role`; a custom
 *       append carries no `ignorable`.
 *       `dsh-session` `known-event-types`.
 *   (i) the real fail-closed vocabulary gate `validateStoredEvents` refuses a
 *       log containing `rolebox/active-role` unless the envelope carries
 *       `ignorable: true`.
 *       `dsh-session-persistence/lib/types/storage-contract.d.ts`.
 *       Audit (the reload refusal).
 *   (j) the same exported `validateStoredEvents` gate refuses the exact stored
 *       log rolebox writes, and accepts the same log when `ignorable: true` is
 *       present (positive control).
 *       `dsh-session-persistence/lib/types/storage-contract.d.ts`. Audit.
 *   (k) fix-side regression: a real `DshRoleSwitcher.activate` against the
 *       real file-backed `ActiveRoleStore` sidecar writes ZERO custom events to
 *       a real `SessionStore` log, the real persistence vocabulary gate then
 *       accepts that log, and a fresh holder restores the selection from the
 *       sidecar alone. Audit (remedy end-to-end).
 *
 * `0.1.5-rc.1` API migration for (i)/(j)/(k): rc.6 reached the vocabulary gate
 * through an in-process `PersistenceCoordinator` (`assertEventsSupported` /
 * `load()`) built over a backend stub. That seam is gone — the abstract
 * `SessionPersistence` Service is instantiated only by a concrete backend
 * package, and the shared gate is now the exported pure function
 * `validateStoredEvents(meta, events, location?)`. The probes call that real
 * function directly, preserving the original contract intent.
 *
 * The `(h)` append and the `(i)/(j)` reload probes are the two halves of:
 * rolebox could write the event but the harness could not read the log back.
 * `(k)` is the executable proof of the remedy — the fixed code path no longer
 * writes the event, so the same reload succeeds.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionForkError,
} from "@deepseek-ai/dsh-session";
import {
  SessionFormatUnsupportedError,
  validateStoredEvents,
} from "@deepseek-ai/dsh-session-persistence";
import {
  DshRoleSwitcher,
  createActiveRoleRef,
} from "../../src/platform/adapters/dsh/role-switcher.ts";
import type { ActiveRolePersistence } from "../../src/platform/adapters/dsh/role-switcher.ts";
import { ActiveRoleStore } from "../../src/platform/adapters/dsh/active-role-store.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
  DshSubagentRuntime,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";

/** Fibers created by `mountStore()`, disposed after each test. */
let fibers: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const fiber of fibers) fiber.dispose();
  fibers = [];
});

/**
 * Mount the real `SessionStore` service on a fresh cordis Context. Mirrors the
 * async mount in `tests/dsh-cordis-e2e.test.ts` (a `Service` subclass loaded
 * through `ctx.plugin`), and returns the store reachable as `ctx.sessions`.
 */
async function mountStore() {
  const ctx = new Context();
  const fiber = await ctx.plugin(SessionStore as never, {} as never);
  fibers.push(fiber as unknown as { dispose(): void });
  return { ctx, sessions: ctx.sessions };
}

/** A minimal valid `user/message` payload (the data IS the `UserMessage`). */
function userMessage() {
  return {
    id: "m1",
    role: "user" as const,
    content: [{ type: "text" as const, text: "hello" }],
    source: { kind: "user" as const },
  };
}

/** A minimal valid `SessionHeader` for the `validateStoredEvents` probes. */
function storedHeader(id = "s1") {
  return { id, createdAt: 0, version: SESSION_FORMAT_VERSION, isSeeded: false };
}

/**
 * A stored `rolebox/active-role` envelope exactly as rolebox writes it.
 * `ignorable` is the marker rc.6 persistence requires to retain an unknown
 * event type; rolebox's `append()` cannot set it (that is the defect).
 */
function storedActiveRoleEvent(ignorable = false) {
  return {
    type: "rolebox/active-role",
    seq: 0,
    time: 0,
    data: { id: "tester" },
    ...(ignorable ? { ignorable: true } : {}),
  };
}

/** True for the custom event type rc.6 persistence refuses to reload. */
function isCustomSessionEvent(event: unknown): boolean {
  return (event as { type?: unknown }).type === "rolebox/active-role";
}

/** Minimal dsh subagent runtime seam for the real `DshAgentRegistrar`. */
function fakeSubagents(): DshSubagentRuntime {
  const providers = new Map<string, DshSubagentProvider>();
  return {
    registerProvider(provider: DshSubagentProvider) {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (name: string) => providers.get(name),
    list: () => [...providers.keys()],
  };
}

/** A primary-mode `AgentDefinition` for the switcher catalog. */
function roleAgent(id: string): AgentDefinition {
  return {
    id,
    name: id,
    description: `role ${id}`,
    systemPrompt: `You are ${id}.`,
  };
}

/**
 * `0.1.5-rc.1` API migration note.
 *
 * rc.6 exposed the persistence gate through an in-process
 * `PersistenceCoordinator` instance (`assertEventsSupported` / `load()`) built
 * over a caller-supplied backend stub. `0.1.5-rc.1` replaces that seam: the
 * abstract `SessionPersistence` Service is instantiated only by a concrete
 * backend package, and the shared fail-closed vocabulary gate is now the
 * exported pure function `validateStoredEvents(meta, events, location?)`
 * (`dsh-session-persistence/lib/types/storage-contract.d.ts`; runtime
 * `lib/index.js`). The `(i)`/`(j)` probes below therefore exercise
 * `validateStoredEvents` directly — it is the same real harness predicate the
 * old coordinator path delegated to, now reachable without a backend stub.
 */

describe("rc.6 contract: real @deepseek-ai/dsh-session dist", () => {
  it("(a) session/event delivers exactly 2 args: Session then SessionEvent", async () => {
    const { ctx, sessions } = await mountStore();
    let captured: unknown[] | undefined;
    ctx.on("session/event", (...args: any[]) => {
      captured = args;
    });

    const session = sessions.create();
    session.append("todo/write", { todos: [{ content: "x", status: "pending" }] });

    expect(captured).toBeDefined();
    // Exactly two arguments — the emitter passes `[this, event]`.
    expect(captured!.length).toBe(2);
    const [arg0, arg1] = captured as [any, any];
    // arg0 is the Session: it has no `type` discriminator.
    expect(arg0).toBe(session);
    expect(arg0.type).toBeUndefined();
    expect(arg0.id).toBe(session.id);
    // arg1 is the appended event.
    expect(arg1.type).toBe("todo/write");
    expect(typeof arg1.seq).toBe("number");
    expect(typeof arg1.time).toBe("number");
    expect(arg1.data).toEqual({ todos: [{ content: "x", status: "pending" }] });
  });

  it("(b) session/created and session/flush each deliver exactly 1 arg", async () => {
    const { ctx, sessions } = await mountStore();
    let createdArgs: unknown[] | undefined;
    let flushArgs: unknown[] | undefined;
    ctx.on("session/created", (...args: any[]) => {
      createdArgs = args;
    });
    ctx.on("session/flush", (...args: any[]) => {
      flushArgs = args;
    });

    const session = sessions.create();
    expect(createdArgs).toBeDefined();
    expect(createdArgs!.length).toBe(1);
    expect(createdArgs![0]).toBe(session);

    const participated = await sessions.flush(session);
    expect(participated).toBe(true);
    expect(flushArgs).toBeDefined();
    expect(flushArgs!.length).toBe(1);
    expect(flushArgs![0]).toBe(session);
  });

  it("(c) fork boundary is a seq: {messageID} throws INVALID_BOUNDARY, 0 succeeds", async () => {
    const { sessions } = await mountStore();
    const session = sessions.create();
    session.append("todo/write", { todos: [] });

    let thrown: unknown;
    try {
      sessions.fork(session, { messageID: "m1" } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SessionForkError);
    expect((thrown as SessionForkError).code).toBe("INVALID_BOUNDARY");

    const child = sessions.fork(session, 0);
    expect(child).toBeDefined();
    expect(child.id).not.toBe(session.id);
  });

  it("(d) create reads meta.cwd, not a top-level directory", async () => {
    const { sessions } = await mountStore();

    const withDirectory = sessions.create(undefined, {
      directory: "/tmp/rolebox-rc6-ignored",
    } as never);
    expect(withDirectory.header.cwd).toBeUndefined();

    const withMeta = sessions.create(undefined, {
      meta: { cwd: "/tmp/rolebox-rc6" },
    });
    expect(withMeta.header.cwd).toBe("/tmp/rolebox-rc6");
  });

  it("(e) session.header exposes version:number, not formatVersion", async () => {
    const { sessions } = await mountStore();
    const session = sessions.create();
    const header = session.header as unknown as Record<string, unknown>;
    expect(typeof header.version).toBe("number");
    expect("formatVersion" in header).toBe(false);
  });

  it("(f) an appended event envelope is {type,seq,time:number,data}", async () => {
    const { sessions } = await mountStore();
    const session = sessions.create();
    const event = session.append("todo/write", { todos: [] }) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(event).sort()).toEqual(["data", "seq", "time", "type"]);
    expect(event.type).toBe("todo/write");
    expect(typeof event.seq).toBe("number");
    expect(typeof event.time).toBe("number");
    expect(event.data).toEqual({ todos: [] });
  });

  it("(g) todo/write data is {todos}; user/message data IS the UserMessage", async () => {
    const { sessions } = await mountStore();
    const session = sessions.create();

    const todoEvent = session.append("todo/write", {
      todos: [{ content: "a", status: "pending" }],
    });
    expect(Object.keys(todoEvent.data)).toEqual(["todos"]);
    expect(Array.isArray(todoEvent.data.todos)).toBe(true);
    expect(todoEvent.data.todos[0]).toEqual({ content: "a", status: "pending" });

    const userEvent = session.append("user/message", userMessage() as never, {
      surfaceOp: "append",
    });
    const data = userEvent.data as unknown as Record<string, unknown>;
    // The data IS the UserMessage: content is top-level, no `.message` wrapper.
    expect(Array.isArray(data.content)).toBe(true);
    expect(data.content).toEqual([{ type: "text", text: "hello" }]);
    expect("message" in data).toBe(false);
    expect(data.id).toBe("m1");
    expect(data.role).toBe("user");
  });

  it("(h) KNOWN_SESSION_EVENT_TYPES excludes rolebox/active-role; custom append has no ignorable", async () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has("rolebox/active-role")).toBe(false);
    expect(KNOWN_SESSION_EVENT_TYPES.has("user/message")).toBe(true);

    const { sessions } = await mountStore();
    const session = sessions.create();
    // `rolebox/active-role` is outside the rc.6 `SessionEventMap`, so the
    // append surface is invoked through a structural cast (rolebox does the
    // same via its duck-typed store).
    const appendCustom = session.append.bind(session) as unknown as (
      type: string,
      data: unknown,
    ) => unknown;
    const event = appendCustom("rolebox/active-role", {
      id: "tester",
    }) as Record<string, unknown>;
    expect(event.type).toBe("rolebox/active-role");
    expect(event.data).toEqual({ id: "tester" });
    expect("ignorable" in event).toBe(false);
  });

  it("(i) validateStoredEvents refuses rolebox/active-role without ignorable", () => {
    // `validateStoredEvents` is the `0.1.5-rc.1` public fail-closed vocabulary
    // gate (`dsh-session-persistence/lib/types/storage-contract.d.ts`) — the
    // same real predicate the retired `assertEventsSupported` method wrapped.
    // Unknown type + no `ignorable` -> refuse.
    expect(() =>
      validateStoredEvents(storedHeader(), [storedActiveRoleEvent()] as never),
    ).toThrow(SessionFormatUnsupportedError);

    // Positive control: the SAME unknown type WITH the marker is retained, so
    // the refusal is specifically the missing `ignorable`, not the type alone.
    expect(() =>
      validateStoredEvents(storedHeader(), [storedActiveRoleEvent(true)] as never),
    ).not.toThrow();
  });

  it("(j) validateStoredEvents refuses rolebox's stored log, ignorable:true is retained", () => {
    // `0.1.5-rc.1` removed the backend-mounted `coordinator.load()` public path
    // in favour of the per-session `SessionPersistence` Service (abstract;
    // instantiated only by a concrete backend package) plus the exported
    // `validateStoredEvents` gate. This probe asserts that same contract on the
    // real gate: rolebox's stored log is refused, and the SAME log with
    // `ignorable: true` is retained.
    let reloadError: unknown;
    try {
      validateStoredEvents(storedHeader(), [storedActiveRoleEvent()] as never);
    } catch (error) {
      reloadError = error;
    }
    expect(reloadError).toBeInstanceOf(SessionFormatUnsupportedError);
    expect((reloadError as SessionFormatUnsupportedError).message).toContain(
      "not marked ignorable",
    );

    // Positive control through the same gate: the marker makes the stored log
    // loadable.
    const retained = validateStoredEvents(storedHeader(), [
      storedActiveRoleEvent(true),
    ] as never);
    expect((retained[0] as unknown as { type: string }).type).toBe(
      "rolebox/active-role",
    );
  });

  it("(k) regression: real sidecar activation logs zero custom events and reloads", async () => {
    // End-to-end through the FIXED code path, not a predicate restatement:
    // a real SessionStore session receives a real DshRoleSwitcher activation
    // whose durability is the real file-backed ActiveRoleStore sidecar. The
    // assertion is the invariant — the custom event never enters the log,
    // so the real persistence vocabulary gate can reload the session, and the
    // selection round-trips through the sidecar alone.
    const { ctx, sessions } = await mountStore();
    const session = sessions.create("s1" as never);
    session.append("todo/write", { todos: [] });

    const tempDir = mkdtempSync(join(tmpdir(), "rc6-active-role-"));
    try {
      // The real sidecar behind the switcher's `ActiveRolePersistence` seam.
      // `ActiveRoleStore.save` returns the store's serialized write promise, so
      // the test can await the durable round-trip before restoring.
      const sidecar = new ActiveRoleStore(tempDir);
      const writes: Array<Promise<void> | void> = [];
      const persistence: ActiveRolePersistence = {
        load: () => sidecar.load(),
        save: (entries) => {
          const write = sidecar.save(entries);
          writes.push(write);
          return write;
        },
      };
      const activeRole = createActiveRoleRef(persistence);

      const registrar = new DshAgentRegistrar({ subagents: fakeSubagents() });
      await registrar.register([roleAgent("alpha")]);
      const switcher = new DshRoleSwitcher({
        registrar,
        store: sessions as never,
        ctx,
        activeRole,
      });

      // A genuine activation: validated against the catalog, persisted to the
      // sidecar, and — under the sidecar — never written to the session event log.
      const result = await switcher.activate("alpha", "s1");
      expect(result).toEqual({ ok: true });
      await Promise.all(writes);

      // (1) ZERO custom session events: the exact type the harness refuses.
      // `0.1.5-rc.1` exposes the log through `snapshotEvents()` (the old
      // `.events` field is gone), returning a detached frozen snapshot.
      const storedEvents = session.snapshotEvents();
      expect(storedEvents.filter(isCustomSessionEvent)).toEqual([]);

      // (2) The real fail-closed gate reloads the real session log. Before the
      // sidecar this rejected with SessionFormatUnsupportedError
      // ("not marked ignorable") because the custom event was in the log.
      const reloaded = validateStoredEvents(session.header, [
        ...storedEvents,
      ] as never);
      expect(reloaded.some(isCustomSessionEvent)).toBe(false);

      // (3) Round-trip restore: a fresh holder over the same sidecar restores
      // the selection — the fix's durability source, with no log event.
      const restored = createActiveRoleRef(new ActiveRoleStore(tempDir));
      expect(restored.get("s1")).toBe("alpha");

      switcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
