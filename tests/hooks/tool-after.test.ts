import { describe, it, expect, mock, beforeEach } from "bun:test";
import { handleToolAfter } from "../../src/hooks/tool-after.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: { messages: mock(() => Promise.resolve([])) } as any,
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    roleMap: new Map(),
    dir: "/tmp/test",
    dispatchManager: {} as any,
    loopManager: {} as any,
    customHooks: { runHooks: mock(() => Promise.resolve()) } as any,
    ...overrides,
  };
}

function makeState(overrides?: Partial<HookState>): HookState {
  const s = new HookState();
  if (overrides) Object.assign(s, overrides);
  return s;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("handleToolAfter — early exit", () => {
  it("returns early when sessionID is missing", async () => {
    const deps = minimalDeps();
    const state = makeState();
    const customRunHooks = deps.customHooks!.runHooks as ReturnType<typeof mock>;

    await handleToolAfter(
      { sessionID: undefined, tool: "bash" },
      { result: "ok" },
      state,
      deps,
    );

    expect(customRunHooks).not.toHaveBeenCalled();
  });

  it("returns early when tool is missing", async () => {
    const deps = minimalDeps();
    const state = makeState();
    const customRunHooks = deps.customHooks!.runHooks as ReturnType<typeof mock>;

    await handleToolAfter(
      { sessionID: "sess-1", tool: undefined },
      { result: "ok" },
      state,
      deps,
    );

    expect(customRunHooks).not.toHaveBeenCalled();
  });
});

describe("handleToolAfter — dispatch_output still-running detection", () => {
  it("injects a correction when dispatch_output returned 'still running'", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "dispatch_output", args: { task_id: "bg_123" } },
      "still running",
      state,
      deps,
    );

    const correction = state.pendingCorrections.get("sess-1");
    expect(correction).toBeDefined();
    expect(correction).toContain("still running");
    expect(correction).toContain("dispatch_output");
  });

  it("does not inject correction when dispatch_output returns normally", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "dispatch_output", args: { task_id: "bg_123" } },
      "completed result",
      state,
      deps,
    );

    expect(state.pendingCorrections.has("sess-1")).toBe(false);
  });

  it("does not inject correction for non-dispatch_output tools", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "still running something", // matches string but wrong tool
      state,
      deps,
    );

    expect(state.pendingCorrections.has("sess-1")).toBe(false);
  });
});

describe("handleToolAfter — isDispatchError", () => {
  it("skips graph advance when output has an error field", async () => {
    const deps = minimalDeps({
      roleGraphMap: new Map([["agent-a", {} as any]]),
    });
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "task", args: { subagent_type: "helper", description: "test" } },
      { error: "Something went wrong" },
      state,
      deps,
    );

    // No correction stashed since advance was skipped
  });

  it("skips graph advance when output has a failure field", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "task", args: {} },
      { failure: "dispatch failed" },
      state,
      deps,
    );

    // Should not crash — advance is skipped
  });

  it("does not skip for normal output (no error/failure)", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "task", args: {} },
      { result: "success" },
      state,
      deps,
    );

    // Should not throw even without graph configured
  });
});

describe("handleToolAfter — hook lifecycle phases", () => {
  it("calls built-in hook in before phase (no active functions = early return)", async () => {
    const builtInRunHooks = mock(() => Promise.resolve());
    const state = makeState();
    state.sessionAgentRegistry.set("sess-1", "agent-a");

    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "ok",
      state,
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
      }),
    );

    // When no active functions, handleToolAfter returns early after
    // the function observe block, before built-in after hooks.
    // Only the "before" phase is called.
    expect(builtInRunHooks).toHaveBeenCalledTimes(1);
    expect(builtInRunHooks.mock.calls[0][1]).toBe("before");
  });

  it("calls custom hook in before phase (no active functions = early return)", async () => {
    const customRunHooks = mock(() => Promise.resolve());
    const state = makeState();
    state.sessionAgentRegistry.set("sess-1", "agent-a");

    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "ok",
      state,
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    // Only "before" phase when no active functions
    expect(customRunHooks).toHaveBeenCalledTimes(1);
    expect(customRunHooks.mock.calls[0][1]).toBe("before");
  });

  it("passes correct event type and context to runHooks", async () => {
    const customRunHooks = mock(() => Promise.resolve());
    const state = makeState();
    state.sessionAgentRegistry.set("sess-1", "agent-a");

    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "ok",
      state,
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    const beforeCall = customRunHooks.mock.calls[0];
    expect(beforeCall[0]).toBe("tool.execute.after");
    expect(beforeCall[1]).toBe("before");
    expect(beforeCall[3]).toMatchObject({ tool: "bash", args: { command: "ls" }, output: "ok" });
  });
});

describe("handleToolAfter — function observe and handlers", () => {
  it("does not throw when there are no active functions", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "ok",
      state,
      deps,
    );

    // Should not crash
  });

  it("handles function observe errors gracefully", async () => {
    const state = makeState();
    const deps = minimalDeps({
      roleFunctionsMap: new Map([["agent-a", [{ name: "fn1", content: "", description: "test", filePath: "/test/fn1.ts", source: "role-local" } as any]]]),
      session: {
        messages: mock(() => Promise.reject(new Error("network error"))),
      } as any,
    });
    state.sessionAgentRegistry.set("sess-1", "agent-a");

    // Should not throw — observe errors are caught
    await handleToolAfter(
      { sessionID: "sess-1", tool: "bash", args: { command: "ls" } },
      "ok",
      state,
      deps,
    );
  });
});

describe("handleToolAfter — result capture for graph termination", () => {
  it("does not crash when graph session state is uninitialized", async () => {
    const deps = minimalDeps();
    const state = makeState();

    await handleToolAfter(
      { sessionID: "sess-1", tool: "task", args: { subagent_type: "helper" } },
      { result: "data" },
      state,
      deps,
    );

    // Should not throw
  });
});
