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
 *   - provider start() behavior with and without an onSpawn delegate
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
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";

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

  registerProvider(provider: DshSubagentProvider): () => void {
    this.providers.set(provider.name, provider);
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
): DshSubagentStartRequest {
  return {
    prompt: [{ type: "text", text: "user request" }],
    parent: {},
    signal: new AbortController().signal,
    agentOptions: { provider: "deepseek" },
    ...overrides,
  };
}

function makeRun(): DshSubagentRun {
  return {
    id: "run-1",
    result: Promise.resolve({ output: [] }),
    dispose: async () => {},
  };
}

// ── DshAgentRegistrar ───────────────────────────────────────────────────────

describe("DshAgentRegistrar", () => {
  let fake: FakeSubagentRuntime;
  let registrar: DshAgentRegistrar;

  beforeEach(() => {
    fake = new FakeSubagentRuntime();
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
    expect(provider.capabilities.depthLimit).toBe(7);
    expect(provider.capabilities.toolFilter).toEqual({
      allow: ["bash"],
      deny: ["rm"],
    });

    const bProvider = fake.getProvider("b")!;
    expect(bProvider.capabilities.toolFilter).toEqual({ allow: ["read"] });
    expect(bProvider.capabilities.depthLimit).toBeUndefined();
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

  it("start() throws DshSpawnNotWiredError when no onSpawn delegate is wired", async () => {
    const provider = registrar.buildProvider(makeDef());

    let error: unknown;
    try {
      await provider.start(makeRequest());
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DshSpawnNotWiredError);
    expect((error as DshSpawnNotWiredError).agentId).toBe("emperor--jinyiwei--ui");
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
