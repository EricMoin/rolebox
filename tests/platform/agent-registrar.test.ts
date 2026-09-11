/// <reference types="bun-types" />

/**
 * DshAgentRegistrar tests — IAgentRegistrar adapter for the dsh subagent
 * catalog, exercised against a fake `ctx.subagents` double.
 *
 * Verifies:
 *   - AgentDefinition → SubagentProvider translation (name, capabilities,
 *     system prompt prepend, model merge)
 *   - register()/unregister()/sync()/list() idempotency against the fake
 *     registry, including disposer-driven platform-artifact cleanup
 *   - sync() diff semantics: added (new + changed) / removed / unchanged
 *   - provider start() delegation order: onSpawn → registered host provider
 *     (`spawnProviderName`, default "spawn") → `DshSpawnNotWiredError`, plus
 *     the recursion guard for a host name colliding with a rolebox agent id
 *   - the adapter source stays free of @opencode-ai / @deepseek-ai imports
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DshAgentRegistrar,
  DshSpawnNotWiredError,
  DshSpawnRecursionError,
  __setLoggerForTest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshAgentOptions,
  DshProviderRouteProbe,
  DshSubagentProvider,
  DshSubagentResult,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  DshResolvedSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";

// type-level regression: `DshSubagentRun.result` resolves with the real
// `SubagentResult` shape (not `unknown`), which is what lets the dispatch
// adapter read `run.result` without a cast. Erased at runtime; `tsc` gates it.
type _AssertTrue<T extends true> = T;
type _DshSubagentRunResultTyped = _AssertTrue<
  DshSubagentRun["result"] extends Promise<DshSubagentResult> ? true : false
>;

// Capture the module logger's diagnostics so the unwired-registrar message can
// be asserted without polluting test output. The constructor emits this at
// `info` level (informational, not a failure claim), so `info` is the captured
// level. Swapping the module logger is safe because the runner isolates per
// file (mirrors tests/resolver-recursive.test.ts).
const capturedInfos: unknown[][] = [];
// Provider-route safety path emits `warn` when a split provider has no
// registered dsh llm adapter; captured separately so the degrade tests can
// assert exactly ONE warning without touching the info-diagnostic assertions.
const capturedWarns: unknown[][] = [];
__setLoggerForTest({
  warn: (...args: unknown[]) => {
    capturedWarns.push(args);
  },
  debug: () => {},
  error: () => {},
  info: (...args: unknown[]) => {
    capturedInfos.push(args);
  },
  silly: () => {},
  trace: () => {},
  fatal: () => {},
  getSubLogger: () => ({}),
  attachTransport: () => {},
} as any);

// ── Fake dsh registry double ────────────────────────────────────────────────

/**
 * In-memory fake of the dsh `ctx.subagents` seam (SubagentRuntime §4.3).
 * Tracks registrations and disposals so tests can assert that the adapter
 * cleans up platform artifacts (the disposer removes the provider).
 */
class FakeSubagentRuntime implements DshSubagentRuntime {
  readonly providers = new Map<string, DshSubagentProvider>();
  /** Provider names in registration order. */
  readonly registrations: string[] = [];
  /** Provider names in disposer-invocation order. */
  readonly disposals: string[] = [];
  /** start() requests each registered provider has received, keyed by name. */
  private readonly startCalls = new Map<string, DshSubagentStartRequest[]>();

  registerProvider(provider: DshSubagentProvider): () => void {
    const calls: DshSubagentStartRequest[] = [];
    this.startCalls.set(provider.name, calls);
    const inner = provider.start.bind(provider);
    // Wrap start() so tests can observe delegation (and prove non-re-entry)
    // without every provider double re-implementing call recording.
    this.providers.set(provider.name, {
      ...provider,
      start: (request: DshResolvedSubagentStartRequest) => {
        calls.push(request);
        return inner(request);
      },
    });
    this.registrations.push(provider.name);
    return () => {
      this.providers.delete(provider.name);
      this.disposals.push(provider.name);
    };
  }

  getProvider(name: string): DshSubagentProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Register a NON-rolebox host provider (e.g. dsh's in-process `spawn`) under
   * `name`, recording every start() request it receives.
   */
  registerHostProvider(name: string, run: DshSubagentRun = makeRun()): void {
    this.registerProvider({
      name,
      capabilities: {
        agentOptions: false,
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
      start: async () => run,
    });
  }

  /** start() requests recorded for a provider name (empty if never called). */
  startCallsFor(name: string): DshSubagentStartRequest[] {
    return this.startCalls.get(name) ?? [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "emperor--jinyiwei--ui",
    name: "UI",
    description: "Front-end department",
    systemPrompt: "You are the UI department.",
    model: "claude-sonnet",
    tools: { allow: ["bash"], deny: ["rm"] },
    maxSteps: 5,
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<DshSubagentStartRequest> = {},
): DshResolvedSubagentStartRequest {
  return {
    prompt: [{ type: "text", text: "user request" }],
    parent: {},
    signal: new AbortController().signal,
    agentOptions: { provider: "deepseek" },
    // The dsh service resolves and stamps the durable child descriptor before
    // dispatching to a provider's start(); `{}` stands in for it here.
    descriptor: {},
    ...overrides,
  };
}

function makeRun(): DshSubagentRun {
  return {
    id: "run-1",
    result: Promise.resolve({ output: [], stopReason: "completed" }),
    dispose: async () => {},
  };
}

// ── DshAgentRegistrar ───────────────────────────────────────────────────────

describe("DshAgentRegistrar", () => {
  let fake: FakeSubagentRuntime;
  let registrar: DshAgentRegistrar;

  beforeEach(() => {
    fake = new FakeSubagentRuntime();
    capturedWarns.length = 0;
    registrar = new DshAgentRegistrar({ subagents: fake });
  });

  it("register() registers a provider per definition with translated metadata", async () => {
    const a = makeDef({ id: "a", maxSteps: 7 });
    const b = makeDef({ id: "b", maxSteps: undefined, tools: { allow: ["read"], deny: undefined } });
    await registrar.register([a, b]);

    expect(fake.list()).toEqual(["a", "b"]);
    const provider = fake.getProvider("a")!;
    expect(provider.name).toBe("a");
    expect(provider.inheritsParentContext).toBe(false);
    // dsh 0.1.5-rc.1 requires all five SubagentCapabilities booleans; rolebox's
    // provider honors only the start-time `agentOptions` request option (it
    // forwards it into the delegated start), so `agentOptions` is true and the
    // remaining four are false. The definition's catalog config
    // (maxSteps/tools) is not mapped.
    expect(provider.capabilities).toEqual({
      agentOptions: true,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    });

    const bProvider = fake.getProvider("b")!;
    expect(bProvider.capabilities).toEqual({
      agentOptions: true,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    });
  });

  it("buildCapabilities advertises exactly the five required 0.1.5-rc.1 booleans, all boolean", () => {
    // Regression: a missing/extra key or a non-boolean value fails here.
    // dsh 0.1.5-rc.1 `SubagentCapabilities` —
    // packages/subagent/subagent/src/types.ts:130-136.
    const capabilities = registrar.buildProvider(makeDef()).capabilities;
    expect(Object.keys(capabilities).sort()).toEqual([
      "agentOptions",
      "depthLimit",
      "outputSchema",
      "persona",
      "toolFilter",
    ]);
    for (const value of Object.values(capabilities)) {
      expect(typeof value).toBe("boolean");
    }
    expect(capabilities.agentOptions).toBe(true);
  });

  it("register() is idempotent for identical definitions", async () => {
    const def = makeDef();
    await registrar.register([def]);
    await registrar.register([def]);

    expect(fake.registrations).toEqual([def.id]);
    expect(await registrar.list()).toEqual([def.id]);

    // One registration ⇒ exactly one disposer on unregister.
    await registrar.unregister([def.id]);
    expect(fake.disposals).toEqual([def.id]);
  });

  it("register() replaces a changed definition and disposes the stale registration", async () => {
    const captured: DshSubagentStartRequest[] = [];
    const withSpawn = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (_definition, request) => {
        captured.push(request);
        return makeRun();
      },
    });

    const def = makeDef({ systemPrompt: "old prompt" });
    await withSpawn.register([def]);
    await withSpawn.register([makeDef({ systemPrompt: "new prompt" })]);

    expect(fake.registrations).toEqual([def.id, def.id]);
    expect(fake.disposals).toEqual([def.id]);

    // The fake now holds the NEW provider; its start must use the new prompt.
    const result = await fake.getProvider(def.id)!.start(makeRequest());
    expect(result.id).toBe("run-1");
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt[0]).toEqual({
      type: "text",
      text: "new prompt",
    });
  });

  it("unregister() disposes the dsh registration and is a no-op for unknown ids", async () => {
    await registrar.register([makeDef({ id: "a" }), makeDef({ id: "b" })]);

    await registrar.unregister(["a", "ghost"]);

    expect(fake.list()).toEqual(["b"]);
    expect(fake.disposals).toEqual(["a"]);
    expect(await registrar.list()).toEqual(["b"]);
  });

  it("sync() reports added/removed/unchanged consistent with the fake registry", async () => {
    const a = makeDef({ id: "a", model: "claude-sonnet" });
    const b = makeDef({ id: "b" });
    await registrar.register([a, b]);

    // One updated entry: a changes (model), b disappears.
    const updatedA = makeDef({ id: "a", model: "gpt-5" });
    const result = await registrar.sync([updatedA]);

    expect(result.added).toEqual(["a"]); // changed ⇒ added
    expect(result.removed).toEqual(["b"]);
    expect(result.unchanged).toEqual([]);

    // Fake registry reflects the delta: only a remains, with the new model.
    expect(fake.list()).toEqual(["a"]);
    // b was removed; the stale a registration was disposed on replacement.
    expect(fake.disposals.sort()).toEqual(["a", "b"]);
    const provider = fake.getProvider("a")!;
    expect(provider.name).toBe("a");
  });

  it("sync() reports unchanged when definitions are identical", async () => {
    const a = makeDef({ id: "a" });
    const b = makeDef({ id: "b" });
    await registrar.sync([a, b]);

    const result = await registrar.sync([a, b]);

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged.sort()).toEqual(["a", "b"]);
    expect(fake.registrations).toEqual(["a", "b"]); // no re-registration
    expect(fake.disposals).toEqual([]);
  });

  it("sync() adds new agents and disposes removed ones together", async () => {
    const a = makeDef({ id: "a" });
    await registrar.register([a]);

    const b = makeDef({ id: "b" });
    const result = await registrar.sync([b]);

    expect(result.added).toEqual(["b"]);
    expect(result.removed).toEqual(["a"]);
    expect(result.unchanged).toEqual([]);
    expect(fake.list()).toEqual(["b"]);
    expect(fake.disposals).toEqual(["a"]);
  });

  it("list() returns registered ids sorted", async () => {
    await registrar.register([makeDef({ id: "b" }), makeDef({ id: "a" })]);
    expect(await registrar.list()).toEqual(["a", "b"]);
  });

  it("getRegisteredAgents() returns registered definitions sorted by id", async () => {
    const b = makeDef({ id: "b", description: "B department" });
    const a = makeDef({ id: "a", description: "A department" });
    await registrar.register([b, a]);

    const agents = registrar.getRegisteredAgents();
    expect(agents.map((def) => def.id)).toEqual(["a", "b"]);
    // The stored definitions themselves are returned, not re-built copies.
    expect(agents).toEqual([a, b]);

    // unregister() drops the entry from the accessor.
    await registrar.unregister(["a"]);
    expect(registrar.getRegisteredAgents().map((def) => def.id)).toEqual(["b"]);
  });

  it("getRegisteredAgents() reflects definitions applied via sync()", async () => {
    const a = makeDef({ id: "a", model: "claude-sonnet" });
    const b = makeDef({ id: "b" });
    await registrar.sync([a, b]);
    expect(registrar.getRegisteredAgents().map((def) => def.id)).toEqual(["a", "b"]);

    // A changed definition replaces the catalog entry.
    const updatedA = makeDef({ id: "a", model: "gpt-5" });
    await registrar.sync([updatedA]);
    expect(registrar.getRegisteredAgents()).toEqual([updatedA]);
  });

  it("start() prepends the system prompt and merges the model into agentOptions", async () => {
    const captured: Array<{
      definition: AgentDefinition;
      request: DshSubagentStartRequest;
    }> = [];
    const withSpawn = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (definition, request) => {
        captured.push({ definition, request });
        return makeRun();
      },
    });

    const provider = withSpawn.buildProvider(makeDef());
    await provider.start(makeRequest());

    expect(captured).toHaveLength(1);
    const { definition, request } = captured[0];
    expect(definition.id).toBe("emperor--jinyiwei--ui");
    expect(request.prompt[0]).toEqual({
      type: "text",
      text: "You are the UI department.",
    });
    expect(request.prompt[1]).toEqual({ type: "text", text: "user request" });
    expect(request.agentOptions).toEqual({
      provider: "deepseek",
      model: "claude-sonnet",
    });
    // Unrelated request fields pass through untouched.
    expect(request.parent).toEqual({});
  });

  it("start() leaves the prompt and agentOptions untouched when def has neither", async () => {
    const captured: Array<{ request: DshSubagentStartRequest }> = [];
    const withSpawn = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (_def, request) => {
        captured.push({ request });
        return makeRun();
      },
    });

    const provider = withSpawn.buildProvider(makeDef({ systemPrompt: "", model: undefined }));
    await provider.start(makeRequest({ agentOptions: undefined }));

    expect(captured[0].request.prompt).toEqual([{ type: "text", text: "user request" }]);
    expect(captured[0].request.agentOptions).toBeUndefined();
  });

  // ── model → provider + model mapping (shared splitModel) ───────────────────
  // A resolved "<provider>/<model-id>" definition model sets BOTH AgentOptions
  // fields so the spawn routes through the definition's provider; a bare model
  // keeps the legacy model-only override and leaves the base provider intact.

  /** Start a provider built from `def`, capturing the request onSpawn receives. */
  async function startCapturing(
    def: AgentDefinition,
    base: DshAgentOptions | undefined,
    providerRoutes?: DshProviderRouteProbe,
  ): Promise<DshSubagentStartRequest> {
    const captured: DshSubagentStartRequest[] = [];
    const wired = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (_definition, request) => {
        captured.push(request);
        return makeRun();
      },
      ...(providerRoutes ? { providerRoutes } : {}),
    });
    await wired.buildProvider(def).start(makeRequest({ agentOptions: base }));
    return captured[0];
  }

  it("(a) splits 'openrouter/openai/gpt-4o-mini' into provider + model", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter/openai/gpt-4o-mini" }),
      { provider: "deepseek" },
    );
    expect(request.agentOptions).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
  });

  it("(b) keeps a multi-segment model id after the first slash", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter-anthropic/anthropic/claude-opus-5" }),
      { provider: "deepseek", maxTokens: 4096 },
    );
    expect(request.agentOptions).toEqual({
      provider: "openrouter-anthropic",
      model: "anthropic/claude-opus-5",
      maxTokens: 4096,
    });
  });

  it("(c) a bare 'claude-sonnet' leaves the base provider intact", async () => {
    const request = await startCapturing(
      makeDef({ model: "claude-sonnet" }),
      { provider: "deepseek" },
    );
    expect(request.agentOptions).toEqual({
      provider: "deepseek",
      model: "claude-sonnet",
    });
  });

  it("(d) no definition model leaves agentOptions untouched", async () => {
    const base: DshAgentOptions = { provider: "deepseek", model: "runtime-default" };
    const request = await startCapturing(makeDef({ model: undefined }), base);
    expect(request.agentOptions).toBe(base);
  });

  // ── provider-route safety path ────────────────────────────────────────────
  // A split provider dsh has no registered llm adapter for must not turn a
  // working spawn into a hard NO_ADAPTER failure. With a providerRoutes probe
  // wired, an unregistered route degrades to a model-only override (base
  // provider untouched) and logs ONE warning; a registered route still emits
  // { provider, model }; no probe preserves the pure split (subtask 3).

  it("(e) degrades an unregistered split provider to model-only with one warning", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter/openai/gpt-4o-mini" }),
      { provider: "openai" },
      () => ["openai"],
    );
    // The definition's provider is dropped; the base provider is untouched and
    // the model id is still applied.
    expect(request.agentOptions).toEqual({
      provider: "openai",
      model: "openai/gpt-4o-mini",
    });
    expect(capturedWarns).toHaveLength(1);
    const warning = String(capturedWarns[0][0]);
    expect(warning).toContain("openrouter");
    expect(warning).toContain("no registered dsh llm adapter");
    expect(warning).toContain("model-only");
    expect(warning).toContain("NO_ADAPTER");
  });

  it("(f) emits provider + model when the split provider IS registered", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter/openai/gpt-4o-mini" }),
      { provider: "openai" },
      () => ["openrouter", "openai"],
    );
    expect(request.agentOptions).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
    expect(capturedWarns).toHaveLength(0);
  });

  it("(g) preserves the split when no providerRoutes probe is wired (subtask 3 behavior)", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter/openai/gpt-4o-mini" }),
      { provider: "openai" },
    );
    expect(request.agentOptions).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
    expect(capturedWarns).toHaveLength(0);
  });

  it("(h) degrades a multi-segment model id safely when the provider is unregistered", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter-anthropic/anthropic/claude-opus-5" }),
      { provider: "openai", maxTokens: 4096 },
      () => ["openai"],
    );
    expect(request.agentOptions).toEqual({
      provider: "openai",
      model: "anthropic/claude-opus-5",
      maxTokens: 4096,
    });
    expect(capturedWarns).toHaveLength(1);
  });

  it("(i) a throwing route probe degrades safely instead of failing the spawn", async () => {
    const request = await startCapturing(
      makeDef({ model: "openrouter/openai/gpt-4o-mini" }),
      { provider: "openai" },
      () => {
        throw new Error("llm service unavailable");
      },
    );
    expect(request.agentOptions).toEqual({
      provider: "openai",
      model: "openai/gpt-4o-mini",
    });
    expect(capturedWarns).toHaveLength(1);
  });

  // ── Host-provider delegation (no onSpawn) ──────────────────────────────────
  // With no `onSpawn`, start() forwards the RESOLVED request to the host
  // provider named by `spawnProviderName` (default "spawn"), refusing a name
  // that collides with a rolebox agent id. The cases below pin that order.

  it("(i) delegates to the registered 'spawn' host provider with the composed request", async () => {
    fake.registerHostProvider("spawn");
    const provider = registrar.buildProvider(makeDef());

    const parent = { id: "parent-1" };
    const signal = new AbortController().signal;
    const descriptor = { childId: "child-1", durable: true };
    const run = await provider.start(makeRequest({ parent, signal, descriptor }));

    expect(run.id).toBe("run-1");
    const calls = fake.startCallsFor("spawn");
    expect(calls).toHaveLength(1);
    const delegated = calls[0];
    // Composed prompt: definition systemPrompt prepended, request preserved.
    expect(delegated.prompt).toEqual([
      { type: "text", text: "You are the UI department." },
      { type: "text", text: "user request" },
    ]);
    // Merged agentOptions: definition model wins over the request default.
    expect(delegated.agentOptions).toEqual({
      provider: "deepseek",
      model: "claude-sonnet",
    });
    // parent / signal / descriptor forwarded untouched (identity preserved).
    expect(delegated.parent).toBe(parent);
    expect(delegated.signal).toBe(signal);
    expect(delegated.descriptor).toBe(descriptor);
  });

  it("(ii) spawnProviderName selects a differently-named host provider", async () => {
    fake.registerHostProvider("fork");
    const custom = new DshAgentRegistrar({
      subagents: fake,
      spawnProviderName: "fork",
    });

    await custom.buildProvider(makeDef()).start(makeRequest());

    expect(fake.startCallsFor("fork")).toHaveLength(1);
    // The default "spawn" name was never targeted (nor registered).
    expect(fake.startCallsFor("spawn")).toHaveLength(0);
    expect(fake.startCallsFor("fork")[0].prompt[0]).toEqual({
      type: "text",
      text: "You are the UI department.",
    });
  });

  it("(iii) onSpawn takes precedence over a registered host provider", async () => {
    fake.registerHostProvider("spawn");
    const captured: DshSubagentStartRequest[] = [];
    const withSpawn = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (_definition, request) => {
        captured.push(request);
        return makeRun();
      },
    });

    await withSpawn.buildProvider(makeDef()).start(makeRequest());

    expect(captured).toHaveLength(1);
    // The registered host provider was never consulted.
    expect(fake.startCallsFor("spawn")).toHaveLength(0);
  });

  it("(iv) rejects DshSpawnNotWiredError naming the host and registered providers", async () => {
    // A host provider under a DIFFERENT name plus a rolebox agent id: neither
    // is the default "spawn" target, so both must appear in the error's list.
    fake.registerHostProvider("fork");
    await registrar.register([makeDef({ id: "alpha" })]);
    const provider = registrar.buildProvider(makeDef());

    const error = await provider.start(makeRequest()).catch((err) => err);
    expect(error).toBeInstanceOf(DshSpawnNotWiredError);
    const notWired = error as DshSpawnNotWiredError;
    expect(notWired.agentId).toBe("emperor--jinyiwei--ui");
    expect(notWired.hostName).toBe("spawn");
    expect(notWired.message).toContain(
      "no host provider named 'spawn' is registered",
    );
    expect(notWired.message).toContain("(registered: fork, alpha)");
  });

  it("(v) refuses delegation when spawnProviderName collides with a rolebox agent id", async () => {
    const rec = new DshAgentRegistrar({
      subagents: fake,
      spawnProviderName: "alpha",
    });
    await rec.register([makeDef({ id: "alpha" }), makeDef({ id: "beta" })]);

    // Drive the spawn through the registered provider so the fake records
    // every start() that actually runs.
    const error = await fake
      .getProvider("beta")!
      .start(makeRequest())
      .catch((err) => err);

    expect(error).toBeInstanceOf(DshSpawnRecursionError);
    const recursion = error as DshSpawnRecursionError;
    expect(recursion.agentId).toBe("beta");
    expect(recursion.hostName).toBe("alpha");
    expect(recursion.message).toContain("collides with a rolebox agent id");
    // The colliding provider's start() was never re-entered.
    expect(fake.startCallsFor("alpha")).toHaveLength(0);
  });
});

describe("DshAgentRegistrar onSpawn wiring diagnostic", () => {
  let fake: FakeSubagentRuntime;

  beforeEach(() => {
    fake = new FakeSubagentRuntime();
    capturedInfos.length = 0;
    capturedWarns.length = 0;
  });

  it("(a) an unwired registrar logs one diagnostic at construction and start() still rejects", async () => {
    const unwired = new DshAgentRegistrar({ subagents: fake });

    // ONE informational diagnostic at construction (registration time), naming
    // the delegation target — not deferred to the first failed spawn.
    expect(capturedInfos).toHaveLength(1);
    const message = String(capturedInfos[0][0]);
    expect(message).toContain("no onSpawn delegate wired");
    expect(message).toContain("target the 'spawn' host provider");

    await unwired.register([makeDef()]);
    const provider = fake.getProvider("emperor--jinyiwei--ui")!;
    // No fabricated spawn: start() still rejects with the real error.
    await expect(provider.start(makeRequest())).rejects.toThrow(
      DshSpawnNotWiredError,
    );
    // register() + a failed start() did not emit a second diagnostic.
    expect(capturedInfos).toHaveLength(1);
  });

  it("(b) a registrar with onSpawn logs no diagnostic and delegates to the delegate", async () => {
    const spawned: string[] = [];
    const wired = new DshAgentRegistrar({
      subagents: fake,
      onSpawn: async (definition) => {
        spawned.push(definition.id);
        return makeRun();
      },
    });

    expect(capturedInfos).toHaveLength(0);

    await wired.register([makeDef()]);
    const provider = fake.getProvider("emperor--jinyiwei--ui")!;
    const run = await provider.start(makeRequest());
    expect(run.id).toBe("run-1");
    expect(spawned).toEqual(["emperor--jinyiwei--ui"]);
  });
});

describe("DshAgentRegistrar import boundary", () => {
  const FILE = resolve(
    import.meta.dir,
    "../../src/platform/adapters/dsh/agent-registrar.ts",
  );

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

  it("contains no @opencode-ai or @deepseek-ai imports", () => {
    const specifiers = extractImportSpecifiers(readFileSync(FILE, "utf-8"));
    const forbidden = specifiers.filter(
      (s) => s.includes("@opencode-ai/") || s.includes("@deepseek-ai/"),
    );
    expect(forbidden, `${FILE} imports platform SDK packages`).toEqual([]);
  });
});
