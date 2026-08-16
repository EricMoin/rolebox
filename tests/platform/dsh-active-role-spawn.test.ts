/// <reference types="bun-types" />

/**
 * Dsh active-role spawn seam tests — prove that activating a role for a
 * session CHANGES the prompt/system prompt of agents spawned for that
 * session, and that clearing the role restores the base behavior.
 *
 * Root cause this guards against (subtask 1): `DshRoleSwitcher.activate()`
 * wrote the per-session active role into the holder, but the holder was only
 * read by `GET /rolebox/roles/active` — no message/spawn path consulted it,
 * so switching a role in the web UI had no effect on the conversation. The
 * fix: `DshAgentRegistrar` now consumes the same shared holder at spawn time
 * (`buildProvider().start()` reads `request.sessionId` → `activeRole.get` →
 * prepends the active role's system prompt + applies its model override).
 *
 * Verifies:
 *   - activate(role, session) then spawn for THAT session includes the
 *     role's systemPrompt (prepended ahead of the definition's own) and the
 *     role's model override
 *   - activate(null, session) (clear) restores the base definition behavior
 *   - a different session without an active role keeps base behavior
 *   - spawning the active role's own definition does NOT double-prepend
 *   - a spawn request without a sessionId falls back to base behavior
 *   - the dispatch adapter threads the parent/origin session id onto the
 *     spawn request (the loop path key == the dock's session key)
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RoleMode } from "../../src/constants.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  DshSpawnContextProvider,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import {
  DshRoleSwitcher,
  createActiveRoleRef,
} from "../../src/platform/adapters/dsh/role-switcher.ts";
import type { DshCordisContext } from "../../src/platform/adapters/dsh/event-bridge.ts";
import type {
  DshSessionEventLike,
  DshSessionLike,
  DshSessionStoreLike,
} from "../../src/platform/adapters/dsh/session.ts";
import { DshDispatchAdapter } from "../../src/platform/adapters/dsh/dispatch.ts";
import type { DshSubagentDispatchRuntime } from "../../src/platform/adapters/dsh/dispatch.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";

// ── Fakes (platform-test convention) ────────────────────────────────────────

/**
 * Fake cordis ctx — records `on` subscriptions per event and lets tests
 * drive them via `emit`, exactly like the cordis Context event bus.
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

/**
 * Fake dsh subagent runtime — records registered providers and, on `start`,
 * routes through the registered provider's `start()` (like the real
 * `SubagentRuntime.start(name, request)`).
 */
function createFakeSubagents(): DshSubagentDispatchRuntime {
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
    async start(name: string, request: DshSubagentStartRequest) {
      const provider = providers.get(name);
      if (!provider) throw new Error(`no provider for ${name}`);
      return provider.start(request);
    },
  };
}

/** Minimal AgentDefinition factory for the catalog. */
function makeAgent(
  id: string,
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
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

/** Resolve a spawn request's text blocks into a flat prompt string. */
function promptText(blocks: DshSubagentStartRequest["prompt"]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** A fake run whose result resolves immediately (provider start() returns). */
function makeRun(): DshSubagentRun {
  return {
    id: "run-1",
    result: Promise.resolve({ output: [] }),
    dispose: async () => {},
  };
}

/** A bare start request (the dispatch adapter's shape, plus sessionId). */
function spawnRequest(sessionId?: string): DshSubagentStartRequest {
  return {
    prompt: [{ type: "text", text: "user request" }],
    parent: {},
    signal: new AbortController().signal,
    sessionId,
  };
}

/**
 * Full fixture mirroring the real dsh-plugin wiring: ONE shared activeRole
 * holder feeding BOTH the registrar (read at spawn) and the switcher (write
 * on activate/clear), a fake subagents seam that routes start() through the
 * registered provider, and the dsh dispatch adapter over that seam.
 *
 * The registrar is wired with an `onSpawn` delegate that captures the FULLY
 * TRANSFORMED start request (the request a real spawn-provider adapter would
 * receive — the point where the active role has already been applied) and
 * returns a fake run. An optional `contextProvider` wires the spawn-time
 * context-injection seam (the dsh counterpart of the system-transform hook).
 */
async function createFixture(
  agents: AgentDefinition[],
  opts: { contextProvider?: DshSpawnContextProvider } = {},
) {
  const { ctx, listeners } = createFakeCtx();
  const subagents = createFakeSubagents();
  const activeRole = createActiveRoleRef();
  const spawned: Array<{
    definition: AgentDefinition;
    request: DshSubagentStartRequest;
  }> = [];
  const registrar = new DshAgentRegistrar({
    subagents,
    activeRole,
    contextProvider: opts.contextProvider,
    onSpawn: async (definition, request) => {
      spawned.push({ definition, request });
      return makeRun();
    },
  });
  await registrar.register(agents);
  const s1 = makeSession("s1");
  const store = makeStore([s1]);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx, activeRole });
  const dispatch = new DshDispatchAdapter({ subagents, directory: process.cwd() });
  return {
    ctx,
    listeners,
    registrar,
    subagents,
    store,
    s1,
    switcher,
    activeRole,
    dispatch,
    spawned,
  };
}

/** A context provider emitting a marker block for the active role's session. */
function markerContextProvider(): DshSpawnContextProvider {
  return (sessionId) => {
    return [
      {
        type: "text",
        text: `<rolebox_context role="${sessionId}">functions, memory, references</rolebox_context>`,
      },
    ];
  };
}

// ── Spawn seam: activated role reaches the spawned prompt ───────────────────

describe("dsh active-role spawn seam", () => {
  it("activate(role) then spawn for that session includes the role's systemPrompt + model", async () => {
    const { switcher, subagents, spawned, activeRole } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
        model: "base-model",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-model",
      }),
    ]);

    const result = await switcher.activate("alpha", "s1");
    expect(result).toEqual({ ok: true });
    expect(activeRole.get("s1")).toBe("alpha");

    await subagents.start("base", spawnRequest("s1"));

    expect(spawned).toHaveLength(1);
    expect(spawned[0].definition.id).toBe("base");
    expect(spawned[0].request.sessionId).toBe("s1");

    // The ACTIVE ROLE's prompt leads, ahead of the spawned definition's own.
    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are ALPHA, the active role.");
    expect(text).toContain("You are the base agent.");
    expect(text).toContain("user request");
    // Role's model override wins over the definition's.
    expect(spawned[0].request.agentOptions?.model).toBe("alpha-model");
  });

  it("activate(null)/clear restores the base definition behavior", async () => {
    const { switcher, subagents, spawned, activeRole } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
        model: "base-model",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-model",
      }),
    ]);

    await switcher.activate("alpha", "s1");
    await switcher.activate(null, "s1"); // clear
    expect(activeRole.get("s1")).toBeNull();

    await subagents.start("base", spawnRequest("s1"));

    expect(spawned).toHaveLength(1);
    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("a session WITHOUT an active role keeps base behavior", async () => {
    const { subagents, spawned } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
        model: "base-model",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-model",
      }),
    ]);

    await subagents.start("base", spawnRequest("other-session"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("spawning the ACTIVE ROLE's own definition does not double-prepend its prompt", async () => {
    const { switcher, subagents, spawned } = await createFixture([
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-model",
      }),
    ]);

    await switcher.activate("alpha", "s1");

    await subagents.start("alpha", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    // Exactly one occurrence — the definition's own prompt, not duplicated.
    expect(text.match(/You are ALPHA/g)).toHaveLength(1);
  });

  it("a spawn request WITHOUT a sessionId falls back to base behavior", async () => {
    const { switcher, subagents, spawned } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
      }),
    ]);
    await switcher.activate("alpha", "s1");

    await subagents.start("base", spawnRequest(undefined));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
  });
});

// ── Context injection seam: dsh context reaches the spawned role prompt ──────

describe("dsh context injection reaches the spawned role prompt", () => {
  const CONTEXT_MARKER = '<rolebox_context role="s1">';

  it("with an active role, the injected context is present ALONGSIDE the role's prompt", async () => {
    const { switcher, subagents, spawned } = await createFixture(
      [
        makeAgent("base", {
          systemPrompt: "You are the base agent.",
          model: "base-model",
        }),
        makeAgent("alpha", {
          mode: RoleMode.Primary,
          systemPrompt: "You are ALPHA, the active role.",
          model: "alpha-model",
        }),
      ],
      { contextProvider: markerContextProvider() },
    );

    await switcher.activate("alpha", "s1");
    await subagents.start("base", spawnRequest("s1"));

    expect(spawned).toHaveLength(1);
    const text = promptText(spawned[0].request.prompt);
    // The dsh-injected context AND the role's prompt are BOTH in the
    // spawned agent's effective prompt.
    expect(text).toContain(CONTEXT_MARKER);
    expect(text).toContain("You are ALPHA, the active role.");
    expect(text).toContain("You are the base agent.");
    expect(text).toContain("user request");
    // Conventional order: injected context leads, then the active role's
    // complete materialized prompt, then the spawned definition's own.
    expect(text.indexOf(CONTEXT_MARKER)).toBeLessThan(
      text.indexOf("You are ALPHA, the active role."),
    );
    expect(text.indexOf("You are ALPHA, the active role.")).toBeLessThan(
      text.indexOf("You are the base agent."),
    );
    // Role's model override still applies.
    expect(spawned[0].request.agentOptions?.model).toBe("alpha-model");
  });

  it("spawning the ACTIVE ROLE's own definition carries the context (prompt not duplicated)", async () => {
    const { switcher, subagents, spawned } = await createFixture(
      [
        makeAgent("alpha", {
          mode: RoleMode.Primary,
          systemPrompt: "You are ALPHA, the active role.",
        }),
      ],
      { contextProvider: markerContextProvider() },
    );

    await switcher.activate("alpha", "s1");
    await subagents.start("alpha", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    // Context injected even though the redundant role-prompt prepend is
    // skipped; the role prompt itself appears exactly once.
    expect(text).toContain(CONTEXT_MARKER);
    expect(text.match(/You are ALPHA/g)).toHaveLength(1);
  });

  it("WITHOUT an active role the spawned prompt is unchanged (no context injection)", async () => {
    const { subagents, spawned } = await createFixture(
      [
        makeAgent("base", {
          systemPrompt: "You are the base agent.",
          model: "base-model",
        }),
        makeAgent("alpha", {
          mode: RoleMode.Primary,
          systemPrompt: "You are ALPHA, the active role.",
        }),
      ],
      { contextProvider: markerContextProvider() },
    );

    // No activate() — base session behavior.
    await subagents.start("base", spawnRequest("other-session"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain(CONTEXT_MARKER);
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("a context provider that returns nothing leaves the spawn unchanged", async () => {
    const { switcher, subagents, spawned } = await createFixture(
      [
        makeAgent("base", { systemPrompt: "You are the base agent." }),
        makeAgent("alpha", {
          mode: RoleMode.Primary,
          systemPrompt: "You are ALPHA, the active role.",
        }),
      ],
      // Wired but silent — behaves like a role with no functions/memory.
      { contextProvider: () => undefined },
    );

    await switcher.activate("alpha", "s1");
    await subagents.start("base", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are ALPHA, the active role.");
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain(CONTEXT_MARKER);
  });
});

// ── Dispatch threading ──────────────────────────────────────────────────────

describe("dsh dispatch threads the session id onto the spawn request", () => {
  it("dispatchRound carries the originSessionId (the dock's key) to start()", async () => {
    const { switcher, dispatch, spawned } = await createFixture([
      makeAgent("base", { systemPrompt: "You are the base agent." }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
      }),
    ]);
    await switcher.activate("alpha", "s1");

    const { workerTaskId } = await dispatch.dispatchRound({
      originSessionId: "s1",
      agent: "base",
      prompt: "round prompt",
    });
    expect(workerTaskId).toBeDefined();

    expect(spawned).toHaveLength(1);
    // Loop path: sessionId == originSessionId == the dock's session key.
    expect(spawned[0].request.sessionId).toBe("s1");
    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are ALPHA, the active role.");
    expect(text).toContain("round prompt");
  });
});

// ── Import boundary ─────────────────────────────────────────────────────────

describe("dsh active-role seam import boundary", () => {
  const FILES = [
    resolve(import.meta.dir, "../../src/platform/adapters/dsh/agent-registrar.ts"),
    resolve(import.meta.dir, "../../src/platform/adapters/dsh/dispatch.ts"),
    resolve(import.meta.dir, "../../src/platform/adapters/dsh/role-switcher.ts"),
  ];

  function extractImportSpecifiers(source: string): string[] {
    const importRe =
      /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  it("the dsh adapter sources stay free of @opencode-ai / @deepseek-ai imports", () => {
    for (const file of FILES) {
      const specifiers = extractImportSpecifiers(readFileSync(file, "utf-8"));
      const forbidden = specifiers.filter(
        (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
      );
      expect(forbidden, `${file} imports platform SDK packages`).toEqual([]);
    }
  });
});
