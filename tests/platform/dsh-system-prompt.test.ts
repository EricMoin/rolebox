/// <reference types="bun-types" />

/**
 * DshSystemPromptAdapter tests — the session-level system-prompt contribution
 * adapter (`src/platform/adapters/dsh/system-prompt.ts`) exercised against a
 * fake dsh system-prompt registry double that records every section()/
 * context() registration and returns disposers that record their invocation.
 *
 * Verifies:
 *   - register() registers a section named `rolebox:role` (order 50) and a
 *     context entry named `rolebox:context` (order 0)
 *   - the registered section text provider returns `''` before any role is
 *     active (no session id AND no active role both short-circuit to `''`)
 *   - after `activeRole.set('s1','tester')` against a registered `tester`
 *     AgentDefinition carrying a systemPrompt, the same provider call returns
 *     that full systemPrompt (and the rolebox `sessionId` spelling works too)
 *   - clearing the active role returns `''` again — live re-evaluation with
 *     no re-registration
 *   - the context provider returns the `<available_functions>` block for the
 *     active role's function map, and `''` when no role is active or the role
 *     has no resolved functions
 *   - dispose() invokes every recorded registry disposer (and is idempotent)
 *   - the adapter source stays free of @opencode-ai / @deepseek-ai imports
 *
 * @module
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FunctionSource } from "../../src/constants.ts";
import { DshSystemPromptAdapter } from "../../src/platform/adapters/dsh/system-prompt.ts";
import type {
  DshSystemPromptContext,
  DshSystemPromptContextEntry,
  DshSystemPromptRegistry,
  DshSystemPromptSection,
} from "../../src/platform/adapters/dsh/system-prompt.ts";
import { DshAgentRegistrar } from "../../src/platform/adapters/dsh/agent-registrar.ts";
import type {
  DshSubagentProvider,
  DshSubagentRuntime,
} from "../../src/platform/adapters/dsh/agent-registrar.ts";
import { createActiveRoleRef } from "../../src/platform/adapters/dsh/role-switcher.ts";
import type { AgentDefinition } from "../../src/platform/types.ts";
import type { ResolvedFunction } from "../../src/types.ts";

// ── Fakes (platform-test convention) ────────────────────────────────────────

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

/** Minimal AgentDefinition factory for the registrar catalog. */
function makeAgent(id: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    description: `description for ${id}`,
    systemPrompt: `You are ${id}.`,
    ...overrides,
  };
}

/** Minimal ResolvedFunction factory for the role function map. */
function makeFunction(name: string, description: string): ResolvedFunction {
  return {
    name,
    description,
    content: `content for ${name}`,
    filePath: `/fake/functions/${name}.ts`,
    source: FunctionSource.RoleLocal,
  };
}

/**
 * Fake dsh system-prompt registry — records every `section()`/`context()`
 * registration (so tests can inspect the registered entries and invoke their
 * `text` providers) and returns disposers that record their invocation, making
 * `dispose()` verifiable. Mirrors the real `@deepseek-ai/dsh-system-prompt`
 * registry surface: `section(entry) -> disposer`, `context(entry) -> disposer`.
 */
function createFakeRegistry() {
  const sections: DshSystemPromptSection[] = [];
  const contexts: DshSystemPromptContextEntry[] = [];
  const disposed: Array<{ kind: "section" | "context"; name: string }> = [];
  const registry: DshSystemPromptRegistry = {
    section(entry: DshSystemPromptSection): () => void {
      sections.push(entry);
      return () => {
        disposed.push({ kind: "section", name: entry.name });
      };
    },
    context(entry: DshSystemPromptContextEntry): () => void {
      contexts.push(entry);
      return () => {
        disposed.push({ kind: "context", name: entry.name });
      };
    },
  };
  return { registry, sections, contexts, disposed };
}

/**
 * Full fixture: a real DshAgentRegistrar (fake subagents seam) with the given
 * catalog, a real per-session ActiveRoleRef, a shared role-functions map, and
 * a DshSystemPromptAdapter wired to all of it. The roleFunctionsMap is
 * returned so tests can populate the active role's functions.
 */
function createFixture(agents: AgentDefinition[]) {
  const subagents = createFakeSubagents();
  const registrar = new DshAgentRegistrar({ subagents });
  const roleFunctionsMap = new Map<string, ResolvedFunction[]>();
  const activeRole = createActiveRoleRef();
  return {
    subagents,
    registrar,
    roleFunctionsMap,
    activeRole,
    async build() {
      await registrar.register(agents);
      return {
        activeRole,
        adapter: new DshSystemPromptAdapter({
          registrar,
          activeRole,
          roleFunctionsMap,
          directory: process.cwd(),
        }),
      };
    },
  };
}

// ── register(): registrations ───────────────────────────────────────────────

describe("DshSystemPromptAdapter.register", () => {
  it("registers a 'rolebox:role' section and a 'rolebox:context' context entry", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, sections, contexts } = createFakeRegistry();

    adapter.register(registry);

    // (a) the section registration.
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("rolebox:role");
    expect(sections[0].order).toBe(50);
    expect(typeof sections[0].text).toBe("function");

    // (a) the context registration.
    expect(contexts).toHaveLength(1);
    expect(contexts[0].name).toBe("rolebox:context");
    expect(contexts[0].order).toBe(0);
    expect(typeof contexts[0].text).toBe("function");
  });
});

// ── Section text provider ───────────────────────────────────────────────────

describe("DshSystemPromptAdapter section provider", () => {
  const SECTION_CTX: DshSystemPromptContext = { agent: { id: "s1" }, sessionID: "s1" };

  it("returns '' before any role is active", async () => {
    const fixture = createFixture([makeAgent("tester", { systemPrompt: "You are the TESTER." })]);
    const { adapter } = await fixture.build();
    const { registry, sections } = createFakeRegistry();
    adapter.register(registry);

    // (b) the exact context shape from the acceptance criteria — no explicit
    //     session id: the provider falls back to `agent.id` as the session
    //     (the real harness context `{ agent, scope }` carries no separate
    //     session field), and with no role active it short-circuits to ''.
    expect(sections[0].text({ agent: { id: "s1" } })).toBe("");
    // (b) with a session id but no active role — the meaningful "no role" path.
    expect(sections[0].text(SECTION_CTX)).toBe("");
  });

  it("returns the active role's full systemPrompt once activeRole.set is applied", async () => {
    const fixture = createFixture([makeAgent("tester", { systemPrompt: "You are the TESTER." })]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, sections } = createFakeRegistry();
    adapter.register(registry);

    // (c) the same provider call now resolves through the active role.
    activeRole.set("s1", "tester");
    expect(sections[0].text(SECTION_CTX)).toBe("You are the TESTER.");
  });

  it("accepts the rolebox sessionId spelling on the context", async () => {
    const fixture = createFixture([makeAgent("tester", { systemPrompt: "You are the TESTER." })]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, sections } = createFakeRegistry();
    adapter.register(registry);

    activeRole.set("s1", "tester");
    expect(sections[0].text({ agent: { id: "s1" }, sessionId: "s1" })).toBe(
      "You are the TESTER.",
    );
  });

  it("re-evaluates live: clearing the active role returns '' again, no re-registration", async () => {
    const fixture = createFixture([makeAgent("tester", { systemPrompt: "You are the TESTER." })]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, sections } = createFakeRegistry();
    adapter.register(registry);

    activeRole.set("s1", "tester");
    expect(sections[0].text(SECTION_CTX)).toBe("You are the TESTER.");

    // (d) clear the active role — the SAME registered provider must now yield ''.
    activeRole.set("s1", null);
    expect(sections[0].text(SECTION_CTX)).toBe("");

    // The registry saw exactly ONE section registration — the provider was
    // re-evaluated in place, never re-registered.
    expect(sections).toHaveLength(1);
  });

  it("returns '' when the active id is not in the registrar catalog", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, sections } = createFakeRegistry();
    adapter.register(registry);

    // An active role that no longer resolves (stale switch) degrades to ''.
    activeRole.set("s1", "vanished");
    expect(sections[0].text(SECTION_CTX)).toBe("");
  });
});

// ── Context provider ────────────────────────────────────────────────────────

describe("DshSystemPromptAdapter context provider", () => {
  const CTX: DshSystemPromptContext = { agent: { id: "s1" }, sessionID: "s1" };

  it("returns the <available_functions> block for the active role's function map", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, contexts } = createFakeRegistry();
    adapter.register(registry);

    fixture.roleFunctionsMap.set("tester", [
      makeFunction("fn-a", "first function"),
      makeFunction("fn-b", "second function"),
    ]);
    activeRole.set("s1", "tester");
    const block = contexts[0].text(CTX);
    expect(block).toContain("<available_functions>");
    expect(block).toContain("<name>fn-a</name>");
    expect(block).toContain("<name>fn-b</name>");
  });

  it("returns '' when no role is active", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { adapter } = await fixture.build();
    const { registry, contexts } = createFakeRegistry();
    adapter.register(registry);

    fixture.roleFunctionsMap.set("tester", [makeFunction("fn-a", "first function")]);

    // (e) no active role → '' (the registry drops empty contributions).
    expect(contexts[0].text(CTX)).toBe("");
  });

  it("returns '' when the active role has no resolved functions", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { activeRole, adapter } = await fixture.build();
    const { registry, contexts } = createFakeRegistry();
    adapter.register(registry);

    activeRole.set("s1", "tester");

    // (e) active role but no function-map entry → ''.
    expect(contexts[0].text(CTX)).toBe("");
  });
});

// ── dispose() ───────────────────────────────────────────────────────────────

describe("DshSystemPromptAdapter.dispose", () => {
  it("invokes every recorded registry disposer", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { adapter } = await fixture.build();
    const { registry, disposed } = createFakeRegistry();
    adapter.register(registry);
    expect(disposed).toHaveLength(0);

    // (f) dispose releases both contributions (section first, then context,
    //     matching the register() order).
    adapter.dispose();
    expect(disposed).toEqual([
      { kind: "section", name: "rolebox:role" },
      { kind: "context", name: "rolebox:context" },
    ]);
  });

  it("is idempotent — a second dispose() invokes no further disposers", async () => {
    const fixture = createFixture([makeAgent("tester")]);
    const { adapter } = await fixture.build();
    const { registry, disposed } = createFakeRegistry();
    adapter.register(registry);

    adapter.dispose();
    const first = disposed.length;
    expect(first).toBe(2);

    adapter.dispose();
    expect(disposed).toHaveLength(first);
  });
});

// ── Import hygiene ─────────────────────────────────────────────────────────

describe("dsh-system-prompt import hygiene", () => {
  const FILE = resolve(import.meta.dir, "../../src/platform/adapters/dsh/system-prompt.ts");

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
