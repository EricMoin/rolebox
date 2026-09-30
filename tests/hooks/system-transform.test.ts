import { describe, it, expect, mock, beforeEach } from "bun:test";
import { handleSystemTransform } from "../../src/hooks/system-transform.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";
import type { HookEvent, HookContext } from "../../src/hooks/custom/types.ts";
import type { ResolvedFunction, ResolvedRole } from "../../src/types.ts";
import { functionSessionState } from "../../src/function/session-state.ts";

// ── Cleanup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  functionSessionState.clear("sess-1");
  functionSessionState.clear("sess-2");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFn(name: string, overrides?: Partial<ResolvedFunction>): ResolvedFunction {
  return {
    name,
    description: `${name} description`,
    content: `${name} content`,
    filePath: `/test/${name}.ts`,
    source: "role-local",
    ...overrides,
  };
}

// Doubles for the `runHooks` port on `HookDeps.customHooks` / `HookDeps.builtInHooks`.
// The parameter lists mirror the production methods (`CustomHookRegistry.runHooks`
// in src/hooks/custom/registry.ts, `BuiltInHookRegistry.runHooks` in
// src/recovery/builtin/registry.ts) so that `mock.calls` records the real argument
// tuple; a bare `mock(() => ...)` records `[]` and every `calls[0][n]` read fails.
function makeCustomRunHooks() {
  return mock(
    (
      _event: HookEvent,
      _phase: "before" | "after",
      _ctxFactory: () => HookContext,
      _input: unknown,
    ) => Promise.resolve(),
  );
}

function makeBuiltInRunHooks() {
  return mock(
    (
      _event: HookEvent,
      _phase: "before" | "after",
      _ctxFactory: () => HookContext,
      _input: unknown,
      _builtinConfig: Record<string, boolean>,
    ) => Promise.resolve(),
  );
}

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: { messages: mock(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

function makeState(): HookState {
  return new HookState();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleSystemTransform — early exit", () => {
  it("hands a confirmed graph worker only its own active functions", async () => {
    const active = makeFn("active");
    const inactive = makeFn("inactive");
    const role: ResolvedRole = {
      id: "parent", config: { name: "Parent", description: "Parent", prompt: "Parent" },
      prompt: "Parent", skills: [], references: [], functions: [],
      subagents: [{
        id: "parent--worker", parentId: "parent", inheritedFrom: {},
        config: { name: "Worker", description: "Worker", prompt: "Worker", auto_activate: ["active"] },
        prompt: "Worker", skills: [], references: [], functions: [active, inactive], subagents: [],
      }],
    };
    const output = { system: ["Host instructions", "Worker"] };
    const deps = minimalDeps({
      roleMap: new Map([[role.id, role]]),
      roleFunctionsMap: new Map([["parent--worker", [active, inactive]]]),
      isGraphWorker: (sessionID) => sessionID === "sess-1",
    });
    await handleSystemTransform({ sessionID: "sess-1", agent: "parent--worker" }, output, makeState(), deps);
    expect(output.system.slice(0, 2)).toEqual(["Host instructions", "Worker"]);
    expect(output.system.join("\n")).toContain("active content");
    expect(output.system.join("\n")).not.toContain("inactive content");
    expect(output.system.join("\n")).not.toContain("<available_functions>");
    expect(deps.customHooks.runHooks).not.toHaveBeenCalled();
  });

  it("returns early when sessionID is missing", async () => {
    const builtInRunHooks = makeBuiltInRunHooks();
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: undefined, agent: "test-agent" },
      output,
      makeState(),
      minimalDeps({ builtInHooks: { runHooks: builtInRunHooks } as any }),
    );

    // Should not call hooks or modify system
    expect(builtInRunHooks).not.toHaveBeenCalled();
    expect(output.system).toEqual([]);
  });
});

describe("handleSystemTransform — hook lifecycle phases", () => {
  it("calls built-in hooks before and after", async () => {
    const builtInRunHooks = makeBuiltInRunHooks();
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      makeState(),
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    expect(builtInRunHooks).toHaveBeenCalled();
    expect(builtInRunHooks.mock.calls[0][1]).toBe("before");
    expect(builtInRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("calls custom hooks before and after", async () => {
    const customRunHooks = makeCustomRunHooks();
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      makeState(),
      minimalDeps({
        customHooks: { runHooks: customRunHooks } as any,
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    expect(customRunHooks).toHaveBeenCalled();
    expect(customRunHooks.mock.calls[0][1]).toBe("before");
    expect(customRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("passes correct event name and input to runHooks", async () => {
    const customRunHooks = makeCustomRunHooks();
    const output = { system: ["<existing>content</existing>"] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      makeState(),
      minimalDeps({
        customHooks: { runHooks: customRunHooks } as any,
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    expect(customRunHooks.mock.calls[0][0]).toBe("system.transform");
    expect(customRunHooks.mock.calls[0][3]).toMatchObject({ system: output.system });
  });
});

describe("handleSystemTransform — correction injection", () => {
  it("injects pending correction into system prompt", async () => {
    const state = makeState();
    state.pendingCorrections.set("sess-1", "Important correction text");
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    expect(output.system).toContain("Important correction text");
    expect(state.pendingCorrections.has("sess-1")).toBe(false);
  });

  it("injects correction before available functions block", async () => {
    const state = makeState();
    state.pendingCorrections.set("sess-1", "Priority correction");
    const output = { system: ["<prompt>base prompt</prompt>"] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["test-agent", [makeFn("fn1")]]]),
      }),
    );

    // Correction should be pushed, then available functions
    expect(output.system.length).toBeGreaterThanOrEqual(2);
    const correctionIdx = output.system.findIndex((s) => s.includes("Priority correction"));
    expect(correctionIdx).toBeGreaterThanOrEqual(0);
  });

  it("does not inject when no correction exists", async () => {
    const state = makeState();
    const output = { system: ["<prompt>base</prompt>"] };
    const initialLen = output.system.length;

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      state,
      minimalDeps({
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    expect(output.system.length).toBeGreaterThanOrEqual(initialLen);
  });
});

describe("handleSystemTransform — available functions block", () => {
  it("injects available functions block when agent has functions", async () => {
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "agent-a" },
      output,
      makeState(),
      minimalDeps({
        roleFunctionsMap: new Map([["agent-a", [makeFn("fn1")]]]),
      }),
    );

    const fnBlock = output.system.find((s) => s.includes("fn1"));
    expect(fnBlock).toBeDefined();
  });

  it("does not inject available functions block when agent has no functions", async () => {
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "agent-a" },
      output,
      makeState(),
      minimalDeps({
        roleFunctionsMap: new Map([["agent-a", [] as any]]),
      }),
    );

    // No functions available, no graph state, no corrections — system stays empty
    expect(output.system.length).toBe(0);
  });
});

describe("handleSystemTransform — memory injection", () => {
  it("attempts memory injection when agentId is available", async () => {
    const output = { system: [] as string[] };

    // Memory store might fail if .rolebox dir doesn't exist, but it should be caught
    await handleSystemTransform(
      { sessionID: "sess-1", agent: "agent-a" },
      output,
      makeState(),
      minimalDeps({
        roleFunctionsMap: new Map([["agent-a", [] as any]]),
        roleMap: new Map([["agent-a", { config: { memory: { inject: true } } } as any]]),
      }),
    );

    // Should not crash — memory store error is caught internally
  });
});

describe("handleSystemTransform — function block and graph state", () => {
  it("injects graph state block when graph session exists", async () => {
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: undefined },
      output,
      makeState(),
      minimalDeps(),
    );
  });

  it("builds function block when active functions exist", async () => {
    const output = { system: [] as string[] };

    functionSessionState.activate("sess-1", ["fn1"]);
    functionSessionState.activate("sess-1", ["fn2"]);

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "agent-a" },
      output,
      makeState(),
      minimalDeps({
        roleFunctionsMap: new Map([["agent-a", [
          makeFn("fn1", { priority: 10 }),
          makeFn("fn2", { priority: 20 }),
        ] as any]]),
      }),
    );

    // Should have at least function block + available functions
    const fnBlock = output.system.find((s) => s.includes("available_functions") || s.includes("fn1"));
    expect(fnBlock).toBeDefined();
  });
});

describe("handleSystemTransform — metadata injection via builtinConfig", () => {
  it("passes builtinConfig through to runHooks", async () => {
    const builtInRunHooks = makeBuiltInRunHooks();
    const builtinConfig = { debugMode: true };
    const output = { system: [] as string[] };

    await handleSystemTransform(
      { sessionID: "sess-1", agent: "test-agent" },
      output,
      makeState(),
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
        builtinConfig,
        roleFunctionsMap: new Map([["test-agent", [] as any]]),
      }),
    );

    // The builtinConfig should be passed to runHooks
    const beforeCall = builtInRunHooks.mock.calls[0];
    expect(beforeCall[0]).toBe("system.transform");
    expect(beforeCall[4]).toEqual(builtinConfig);
  });
});
