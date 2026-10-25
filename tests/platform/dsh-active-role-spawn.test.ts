
/**
 * Dsh active-role spawn seam tests — prove that activating a role for a
 * session CHANGES the prompt/system prompt of agents spawned for that
 * session, and that clearing the role restores the base behavior.
 *
 * Root cause this guards against (subtask 1): `DshRoleSwitcher.activate()`
 * wrote the per-session active role into the holder, but the holder was only
 * read by `GET /rolebox/roles/active` — no message/spawn path consulted it,
 * so switching a role in the web UI had no effect on the conversation. The
 * fix: `DshAgentRegistrar` consumes the same shared holder when a spawn is
 * COMPOSED (`composeSpawnRequest` reads `request.sessionId` → `activeRole.get`
 * → prepends the active role's system prompt + applies its model override).
 *
 * On dsh 0.2.x that composition is a CALL-SITE step: a rolebox provider declares
 * `prepareContinuable`, so the runtime takes the LOCAL activation path and never
 * calls the provider's `start()`. The fixture's `start` therefore composes first
 * and activates second — the same order the production adapters use.
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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RoleMode } from "../../src/constants.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
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
 * Fake dsh subagent runtime (`SubagentRuntime`, dsh 0.2.x). It records the
 * registered providers and implements `startActivation`, ROUTING on
 * `prepareContinuable` exactly as the real service does
 * (`packages/subagent/subagent/src/index.ts:269-284`): a provider that declares
 * it takes the LOCAL path, where the runtime composes the child itself and NEVER
 * calls the provider's `start()`.
 *
 * Every rolebox agent provider declares `prepareContinuable`, so this is the path
 * a production spawn takes — and therefore the role prompt, the active-role
 * override, the context blocks and the model override must already be applied by
 * the caller ({@link createFixture}'s `start`, which calls
 * `DshAgentRegistrar.composeSpawnRequest` the way both production adapters do)
 * before `startActivation` sees the request.
 */
function createFakeSubagents(): {
  subagents: DshSubagentDispatchRuntime;
  /** Every activation the runtime received, in call order. */
  activations: Array<{
    provider: string;
    label: string;
    request: DshSubagentStartRequest;
  }>;
} {
  const providers = new Map<string, DshSubagentProvider>();
  const activations: Array<{
    provider: string;
    label: string;
    request: DshSubagentStartRequest;
  }> = [];
  const subagents: DshSubagentDispatchRuntime = {
    registerProvider(provider: DshSubagentProvider): () => void {
      providers.set(provider.name, provider);
      return () => {
        providers.delete(provider.name);
      };
    },
    getProvider: (name: string) => providers.get(name),
    list: () => [...providers.keys()],
    async startActivation(spec) {
      const provider = providers.get(spec.provider);
      if (!provider) throw new Error(`no provider for ${spec.provider}`);
      activations.push({
        provider: spec.provider,
        label: spec.label,
        request: { ...spec.request, label: spec.label, signal: spec.signal },
      });
      const prepareContinuable = provider.prepareContinuable;
      if (prepareContinuable !== undefined) {
        // LOCAL path — the runtime owns identity, composition and prompt
        // delivery, so the provider's own start() is deliberately not called.
        await prepareContinuable({
          sessionId: spec.childId ?? "child-1",
          parent: spec.request.parent,
          signal: spec.signal,
        });
      }
      return {
        childId: spec.childId ?? "child-1",
        messageId: "message-1",
        result: Promise.resolve({ output: [], stopReason: "completed" }),
        dispose: async () => {},
      };
    },
  };
  return { subagents, activations };
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
 * holder feeding BOTH the registrar (read when a spawn is composed) and the
 * switcher (write on activate/clear), a fake 0.2.x subagents seam, and the dsh
 * dispatch adapter over that seam.
 *
 * WHY THE FIXTURE'S `start` EXISTS: on dsh 0.2.x a rolebox provider declares
 * `prepareContinuable`, so the runtime takes the LOCAL activation path and never
 * calls the provider's `start()`. Role materialization therefore happens at the
 * CALL SITE — `DshAgentRegistrar.composeSpawnRequest` — which is exactly what
 * `start` below does before handing the request to `startActivation`, and what
 * the dispatch adapter does through its `composeRequest` seam. An optional
 * `contextProvider` wires the spawn-time context-injection seam (the dsh
 * counterpart of the system-transform hook).
 *
 * `spawned` is what the runtime actually RECEIVED, i.e. the request the child is
 * created with; `provider` replaces the old `definition` field because the
 * runtime addresses an activation by provider name.
 */
async function createFixture(
  agents: AgentDefinition[],
  opts: { contextProvider?: DshSpawnContextProvider } = {},
) {
  const { ctx, listeners } = createFakeCtx();
  const { subagents, activations: spawned } = createFakeSubagents();
  const activeRole = createActiveRoleRef();
  const registrar = new DshAgentRegistrar({
    subagents,
    activeRole,
    contextProvider: opts.contextProvider,
  });
  await registrar.register(agents);
  const s1 = makeSession("s1");
  const store = makeStore([s1]);
  const switcher = new DshRoleSwitcher({ registrar, store, ctx, activeRole });
  const dispatch = new DshDispatchAdapter({
    subagents,
    directory: process.cwd(),
    // THE PRODUCTION CALL-SITE COMPOSER: a loop round's role prompt, context
    // and model are resolved here, not by the provider's dead start().
    composeRequest: (agent, request) => registrar.composeSpawnRequest(agent, request),
    // dsh requires a live parent Agent on every start request; this
    // fixture resolves a sentinel for the dispatch-threading test below.
    parentResolver: () => ({ id: "s1", inject: () => undefined }),
  });
  /**
   * Spawn ONE agent the way the production adapters do: compose the request at
   * the call site (applying the active role, the spawn context and the
   * definition's model), then activate it. `workerPrompt`, when given, is a
   * graph worker's COMPLETE prompt and replaces the role-prompt prepend.
   */
  const start = async (
    agentId: string,
    request: DshSubagentStartRequest,
    workerPrompt?: string,
  ) => {
    const composed = registrar.composeSpawnRequest(agentId, request, workerPrompt);
    return subagents.startActivation({
      provider: agentId,
      label: agentId,
      request: composed,
      signal: composed.signal,
      delivery: "caller",
    });
  };
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
    start,
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
  it("keeps graph workers on their target prompt and model, including primary targets", async () => {
    for (const mode of [RoleMode.Primary, RoleMode.Subagent]) {
      const { switcher, start, spawned } = await createFixture([
        makeAgent("coordinator", { mode: RoleMode.Primary, model: "parent-provider/parent-model" }),
        makeAgent("planner", { mode, model: "worker-provider/worker-model" }),
      ], {
        contextProvider: () => [{ type: "text", text: "parent functions" }],
      });
      await switcher.activate("coordinator", "s1");
      // The worker's COMPLETE prompt is the call-site composer's third argument;
      // on dsh 0.2.x it never travels through the provider's start().
      await start("planner", spawnRequest("s1"), "Worker planner instructions and own functions");
      expect(promptText(spawned[0].request.prompt)).toBe("Worker planner instructions and own functions\nuser request");
      expect(spawned[0].request.agentOptions).toEqual({ provider: "worker-provider", model: "worker-model" });
    }
  });

  it("uses a named subagent's own context without inheriting its parent's role", async () => {
    const contexts: string[] = [];
    const { switcher, start, spawned } = await createFixture([
      makeAgent("coordinator", { mode: RoleMode.Primary, model: "parent-model" }),
      makeAgent("planner", { mode: RoleMode.Subagent, model: "worker-model" }),
    ], {
      contextProvider: (_session, agentId) => {
        contexts.push(agentId ?? "parent");
        return [{ type: "text", text: `${agentId} functions` }];
      },
    });
    await switcher.activate("coordinator", "s1");
    await start("planner", spawnRequest("s1"));
    expect(contexts).toEqual(["planner"]);
    expect(promptText(spawned[0].request.prompt)).toBe("planner functions\nYou are planner.\nuser request");
    expect(spawned[0].request.agentOptions?.model).toBe("worker-model");
  });

  it("activate(role) then spawn for that session includes the role's systemPrompt + model", async () => {
    const { switcher, start, spawned, activeRole } = await createFixture([
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
    expect(result).toEqual({ ok: true, value: undefined });
    expect(activeRole.get("s1")).toBe("alpha");

    await start("base", spawnRequest("s1"));

    expect(spawned).toHaveLength(1);
    expect(spawned[0].provider).toBe("base");
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
    const { switcher, start, spawned, activeRole } = await createFixture([
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

    await start("base", spawnRequest("s1"));

    expect(spawned).toHaveLength(1);
    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("a session WITHOUT an active role keeps base behavior", async () => {
    const { start, spawned } = await createFixture([
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

    await start("base", spawnRequest("other-session"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("spawning the ACTIVE ROLE's own definition does not double-prepend its prompt", async () => {
    const { switcher, start, spawned } = await createFixture([
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-model",
      }),
    ]);

    await switcher.activate("alpha", "s1");

    await start("alpha", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    // Exactly one occurrence — the definition's own prompt, not duplicated.
    expect(text.match(/You are ALPHA/g)).toHaveLength(1);
  });

  it("a spawn request WITHOUT a sessionId falls back to base behavior", async () => {
    const { switcher, start, spawned } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
      }),
    ]);
    await switcher.activate("alpha", "s1");

    await start("base", spawnRequest(undefined));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain("ALPHA");
  });

  it("active-role override carries BOTH provider and model from a DIFFERENT provider", async () => {
    const { switcher, start, spawned } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
        model: "base-provider/base-model",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "alpha-provider/alpha-model",
      }),
    ]);

    // Before activation: the base definition's OWN resolved provider/model
    // apply (split via the shared splitModel helper at agent-registrar.ts:690).
    await start("base", spawnRequest("s1"));
    expect(spawned[0].request.agentOptions?.provider).toBe("base-provider");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");

    await switcher.activate("alpha", "s1");
    await start("base", spawnRequest("s1"));

    // After activation: the ACTIVE ROLE's resolved model is split into BOTH
    // fields (agent-registrar.ts:707), so the spawn routes through the role's
    // provider rather than the base definition's — the provider gap this
    // guards against.
    const active = spawned[1].request.agentOptions;
    expect(active?.provider).toBe("alpha-provider");
    expect(active?.model).toBe("alpha-model");
    expect(active?.provider).not.toBe(
      spawned[0].request.agentOptions?.provider,
    );
  });

  it("active-role override keeps a multi-segment model id after the first slash", async () => {
    const { switcher, start, spawned } = await createFixture([
      makeAgent("base", {
        systemPrompt: "You are the base agent.",
        model: "base-provider/base-model",
      }),
      makeAgent("alpha", {
        mode: RoleMode.Primary,
        systemPrompt: "You are ALPHA, the active role.",
        model: "openrouter-anthropic/anthropic/claude-opus-4.8",
      }),
    ]);

    await switcher.activate("alpha", "s1");
    await start("base", spawnRequest("s1"));

    // First-slash semantics survive the active-role merge: provider is the
    // segment before the first slash, model id keeps the remaining slashes.
    expect(spawned[0].request.agentOptions).toEqual({
      provider: "openrouter-anthropic",
      model: "anthropic/claude-opus-4.8",
    });
  });
});

// ── Context injection seam: dsh context reaches the spawned role prompt ──────

describe("dsh context injection reaches the spawned role prompt", () => {
  const CONTEXT_MARKER = '<rolebox_context role="s1">';

  it("with an active role, the injected context is present ALONGSIDE the role's prompt", async () => {
    const { switcher, start, spawned } = await createFixture(
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
    await start("base", spawnRequest("s1"));

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
    const { switcher, start, spawned } = await createFixture(
      [
        makeAgent("alpha", {
          mode: RoleMode.Primary,
          systemPrompt: "You are ALPHA, the active role.",
        }),
      ],
      { contextProvider: markerContextProvider() },
    );

    await switcher.activate("alpha", "s1");
    await start("alpha", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    // Context injected even though the redundant role-prompt prepend is
    // skipped; the role prompt itself appears exactly once.
    expect(text).toContain(CONTEXT_MARKER);
    expect(text.match(/You are ALPHA/g)).toHaveLength(1);
  });

  it("WITHOUT an active role the spawned prompt is unchanged (no context injection)", async () => {
    const { start, spawned } = await createFixture(
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
    await start("base", spawnRequest("other-session"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain(CONTEXT_MARKER);
    expect(text).not.toContain("ALPHA");
    expect(spawned[0].request.agentOptions?.model).toBe("base-model");
  });

  it("a context provider that returns nothing leaves the spawn unchanged", async () => {
    const { switcher, start, spawned } = await createFixture(
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
    await start("base", spawnRequest("s1"));

    const text = promptText(spawned[0].request.prompt);
    expect(text).toContain("You are ALPHA, the active role.");
    expect(text).toContain("You are the base agent.");
    expect(text).not.toContain(CONTEXT_MARKER);
  });
});

// ── Dispatch threading ──────────────────────────────────────────────────────

describe("dsh dispatch threads the session id onto the spawn request", () => {
  it("dispatchRound carries the originSessionId (the dock's key) onto the activation", async () => {
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
    resolve(import.meta.dirname, "../../src/platform/adapters/dsh/agent-registrar.ts"),
    resolve(import.meta.dirname, "../../src/platform/adapters/dsh/dispatch.ts"),
    resolve(import.meta.dirname, "../../src/platform/adapters/dsh/role-switcher.ts"),
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
