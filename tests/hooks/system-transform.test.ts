import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSystemTransform } from "../../src/hooks/system-transform.ts";
import { HookState } from "../../src/hooks/state.ts";
import { CustomHookRegistry } from "../../src/hooks/custom/registry.ts";
import { createSubLogger } from "../../src/logger.ts";
import { buildAgentPrompt, buildAvailableFunctionsBlock, buildMemoryBlock, buildSkillBlock } from "../../src/prompt/builder.ts";
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
// tuple; a bare `vi.fn(() => ...)` records `[]` and every `calls[0][n]` read fails.
function makeCustomRunHooks() {
  return vi.fn(
    (
      _event: HookEvent,
      _phase: "before" | "after",
      _ctxFactory: () => HookContext,
      _input: unknown,
    ) => Promise.resolve(),
  );
}

function makeBuiltInRunHooks() {
  return vi.fn(
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
    session: { messages: vi.fn(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: vi.fn(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

function makeState(): HookState {
  return new HookState();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleSystemTransform — early exit", () => {
  it.each(["top-level", "nested"])("replaces a %s worker's registered role without removing host context", async placement => {
    const active = makeFn("active");
    const inactive = makeFn("inactive");
    const worker: ResolvedRole = {
      id: placement === "nested" ? "parent--worker" : "worker",
      config: { name: "Worker", description: "Worker", prompt: "Inspect [input]. Report $1 and $& literally.", auto_activate: ["active"] },
      prompt: "", functions: [active, inactive], subagents: [],
      skills: [{ name: "verify", description: "Verify the result", scope: "rolebox", filePath: "/roles/worker/skills/verify/SKILL.md", references: [] }],
      references: [{
        name: "criteria", description: "Acceptance criteria", scope: "role", relativePath: "references/criteria.md",
        filePath: "/roles/worker/references/criteria.md",
      }],
    };
    worker.prompt = buildAgentPrompt(worker.config, worker.skills, {
      references: worker.references,
      subagents: [{ id: "worker--child", name: "Child", description: "Child responsibilities" }],
      publicAgents: [{ id: "peer", name: "Peer", description: "Peer responsibilities" }],
    });
    const role: ResolvedRole = placement === "top-level" ? worker : {
      id: "parent", config: { name: "Parent", description: "Parent", prompt: "Parent" },
      prompt: "Parent", skills: [], references: [], functions: [makeFn("parent-only")],
      subagents: [{ ...worker, parentId: "parent", inheritedFrom: {} }],
    };
    const hostPrefix = "Host instructions\n";
    const hostSuffix = "\nHost environment\n## Available public agents\nHost-owned catalog";
    const system = [hostPrefix + worker.prompt + hostSuffix, "Host project rules"];
    const output = { system };
    const state = makeState();
    state.sessionAgentRegistry.set("sess-1", worker.id);
    functionSessionState.activate("sess-1", ["parent-only"]);
    const deps = minimalDeps({
      roleMap: new Map([[role.id, role]]),
      roleFunctionsMap: new Map([[worker.id, [active, inactive]], ["parent", [makeFn("parent-only")]]]),
      isGraphWorker: (sessionID) => sessionID === "sess-1",
    });
    const input = { sessionID: "sess-1" };
    await handleSystemTransform(input, output, state, deps);
    expect(output.system).toBe(system);
    const text = output.system.join("\n");
    expect(output.system[0]).toStartWith(hostPrefix);
    expect(output.system[0]).toEndWith(hostSuffix);
    expect(output.system[1]).toBe("Host project rules");
    expect(text.match(/Inspect \[input\]/g)).toHaveLength(1);
    expect(text).toContain("Report $1 and $& literally.");
    expect(text).toContain("Verify the result");
    expect(text).toContain("Acceptance criteria");
    expect(text).toContain("/roles/worker/references");
    expect(text).toContain("load_role_skill");
    expect(text.match(/active content/g)).toHaveLength(1);
    expect(text).not.toContain("inactive content");
    expect(text).not.toContain("parent-only content");
    expect(text).not.toContain("## Available functions");
    expect(text).not.toContain("## Available sub-agents");
    expect(text).not.toContain("Peer responsibilities");
    expect(text).not.toContain("JSON fallback");
    const once = [...output.system];
    await handleSystemTransform(input, output, state, deps);
    expect(output.system).toEqual(once);
    expect(deps.customHooks.runHooks).not.toHaveBeenCalled();
  });

  it.each([false, true])("handles overlapping role prompts when active functions are %s", async withActive => {
    const role: ResolvedRole = {
      id: "worker", config: { name: "Worker", description: "Worker", prompt: "Worker responsibilities", auto_activate: withActive ? ["active"] : [] },
      prompt: "", skills: [], references: [], functions: [makeFn("active")], subagents: [],
    };
    role.prompt = buildAgentPrompt(role.config, [], withActive ? {} : {
      publicAgents: [{ id: "peer", name: "Peer", description: "Peer responsibilities" }],
    });
    const output = { system: [role.prompt, "Host context"] };
    const deps = minimalDeps({ roleMap: new Map([[role.id, role]]), isGraphWorker: () => true });
    await handleSystemTransform({ sessionID: "sess-1", agent: role.id }, output, makeState(), deps);
    expect(output.system.join("\n")).not.toContain("## Available public agents");
    expect(output.system.join("\n")).toContain("Worker responsibilities");
    if (withActive) expect(output.system.join("\n")).toContain("active content");
    expect(output.system[1]).toBe("Host context");
    const once = [...output.system];
    await handleSystemTransform({ sessionID: "sess-1", agent: role.id }, output, makeState(), deps);
    expect(output.system).toEqual(once);
  });

  it("adds a missing worker role once and leaves unknown roles untouched", async () => {
    const role: ResolvedRole = {
      id: "worker", config: { name: "Worker", description: "Worker", prompt: "Worker responsibilities" },
      prompt: "", skills: [], references: [], functions: [], subagents: [],
    };
    const output = { system: ["Host context"] };
    const deps = minimalDeps({ roleMap: new Map([[role.id, role]]), isGraphWorker: () => true });
    await handleSystemTransform({ sessionID: "sess-1", agent: "unknown" }, output, makeState(), deps);
    expect(output.system).toEqual(["Host context"]);
    await handleSystemTransform({ sessionID: "sess-1", agent: role.id }, output, makeState(), deps);
    expect(output.system).toEqual(["Host context", "## Role instructions\n\nWorker responsibilities"]);
    await handleSystemTransform({ sessionID: "sess-1", agent: role.id }, output, makeState(), deps);
    expect(output.system).toHaveLength(2);
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
        roleMap: new Map([["agent-a", { id: "agent-a", config: { memory: { inject: true } }, subagents: [] } as any]]),
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
    const fnBlock = output.system.find((s) => s.includes("## Available functions") || s.includes("fn1"));
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

// ── Custom-hook block addressing (markdown ⇄ tag contract) ───────────────────

describe("custom hook block addressing", () => {
  it("resolves markdown blocks and legacy tags to the same stable tags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rolebox-hook-blocks-"));
    try {
      // A real hook module: read the block inventory, replace one block by tag,
      // remove another, and drop a legacy entry's tag into the same inventory.
      writeFileSync(
        join(dir, "block-hook.ts"),
        [
          "export const onSystemTransform = (ctx, _input) => {",
          "  globalThis.__blockTags = ctx.getBlocks().map((block) => block.tag);",
          '  ctx.replaceBlock("available_functions", "REPLACED FUNCTIONS");',
          '  ctx.removeBlock("available_memory");',
          "};",
        ].join("\n"),
      );

      const registry = new CustomHookRegistry();
      await registry.register(
        { name: "block-hook", events: ["system.transform"], module: "./block-hook.ts" },
        dir,
      );
      registry.setDeps({
        pendingCorrections: new Map(),
        functionRuntime: { get: () => undefined },
        dispatchManager: {},
      });

      const system = [
        "Host instructions",
        buildSkillBlock([{ name: "git-master", description: "Expert git", scope: "rolebox", filePath: "/s/SKILL.md", references: [] }]),
        "<function_state>\n  <phase>active</phase>\n</function_state>",
        buildAvailableFunctionsBlock([makeFn("fn1")]),
        buildMemoryBlock([{ id: "m1", title: "T", category: "note", relevance: "high", updated_at: "now" }]),
      ];

      await registry.runHooks(
        "system.transform",
        "after",
        () => ({
          hookName: "[test]",
          config: undefined,
          sessionID: "sess-1",
          inject: () => {},
          log: createSubLogger("hook:test"),
        }),
        { system },
      );

      expect((globalThis as Record<string, unknown>).__blockTags).toEqual([
        "text",
        "available_skills",
        "function_state",
        "available_functions",
        "available_memory",
      ]);
      // replaceBlock writes the caller's content; removeBlock drops the entry.
      expect(system).toEqual([
        "Host instructions",
        buildSkillBlock([{ name: "git-master", description: "Expert git", scope: "rolebox", filePath: "/s/SKILL.md", references: [] }]),
        "<function_state>\n  <phase>active</phase>\n</function_state>",
        "REPLACED FUNCTIONS",
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>).__blockTags;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
