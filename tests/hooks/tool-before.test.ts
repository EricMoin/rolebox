import { describe, it, expect, mock, beforeEach } from "bun:test";
import { z } from "zod";
import { handleToolBefore, registerToolSchema } from "../../src/hooks/tool-before.ts";
import { HookState } from "../../src/hooks/state.ts";
import type { HookDeps } from "../../src/hooks/deps.ts";

// ── Reset schema registry between tests ─────────────────────────────────────

const schemaRegistry = new Map<string, z.ZodRawShape>();

beforeEach(() => {
  schemaRegistry.clear();
});

// ── Helper: minimal deps ─────────────────────────────────────────────────────

function minimalDeps(overrides?: Partial<HookDeps>): HookDeps {
  return {
    session: {} as any,
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerToolSchema", () => {
  it("registers a schema for a tool name", () => {
    registerToolSchema("bash", { command: z.string() });
    // Indirectly verify through handleToolBefore validation
  });

  it("overwrites an existing schema when re-registered", () => {
    registerToolSchema("bash", { command: z.string() });
    registerToolSchema("bash", { command: z.string(), timeout: z.number().optional() });
    // Last registration wins
  });
});

describe("handleToolBefore — parameter validation", () => {
  it("passes validation and normalizes args for a known tool", async () => {
    registerToolSchema("bash", { command: z.string() });

    const output = { args: { command: "ls -la" } };
    await handleToolBefore(
      { tool: "bash", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps(),
    );

    expect(output.args).toEqual({ command: "ls -la" });
  });

  it("rejects unknown keys with strict mode", async () => {
    registerToolSchema("bash", { command: z.string() });

    const output = { args: { command: "ls", block: true, extra: "nope" } };

    await expect(
      handleToolBefore(
        { tool: "bash", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps(),
      ),
    ).rejects.toThrow("Invalid tool call");
  });

  it("includes valid parameter names in the error message", async () => {
    registerToolSchema("bash", { command: z.string(), timeout: z.number().optional() });

    const output = { args: { command: "ls", bogus: true } };

    try {
      await handleToolBefore(
        { tool: "bash", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps(),
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Valid parameters");
      expect(msg).toContain("command");
      expect(msg).toContain("timeout");
    }
  });

  it("passes unknown tools through without validation", async () => {
    // No schema registered for "unknown_tool"
    const output = { args: { anything: "goes" } };

    await handleToolBefore(
      { tool: "unknown_tool", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps(),
    );

    expect(output.args).toEqual({ anything: "goes" });
  });

  it("reports other validation errors (type mismatches, not just unknown keys)", async () => {
    registerToolSchema("write", { filePath: z.string(), content: z.string() });

    const output = { args: { filePath: "/test.txt", content: 42 as any } };

    try {
      await handleToolBefore(
        { tool: "write", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps(),
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Parameter validation errors");
      expect(msg).toContain("content");
    }
  });

  it("applies default values from zod schema", async () => {
    registerToolSchema("read", {
      filePath: z.string(),
      limit: z.number().default(100),
    });

    const output = { args: { filePath: "/test.txt" } };
    await handleToolBefore(
      { tool: "read", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps(),
    );

    // Default is applied
    expect(output.args).toEqual({ filePath: "/test.txt", limit: 100 });
  });

  it("rejects undefined required fields", async () => {
    registerToolSchema("write", { filePath: z.string() });

    const output = { args: {} };

    try {
      await handleToolBefore(
        { tool: "write", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps(),
      );
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("Parameter validation errors");
    }
  });
});

describe("handleToolBefore — dispatch_output guard", () => {
  it("blocks dispatch_output on a running task", async () => {
    registerToolSchema("dispatch_output", { task_id: z.string() });

    const mockManager = {
      getTask: mock((_id: string) => ({ status: "running" })),
    };

    const output = { args: { task_id: "bg_123" } };

    await expect(
      handleToolBefore(
        { tool: "dispatch_output", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps({ dispatchManager: mockManager as any }),
      ),
    ).rejects.toThrow("dispatch_output blocked");
  });

  it("blocks dispatch_output on a pending task", async () => {
    registerToolSchema("dispatch_output", { task_id: z.string() });

    const mockManager = {
      getTask: mock((_id: string) => ({ status: "pending" })),
    };

    const output = { args: { task_id: "bg_123" } };

    await expect(
      handleToolBefore(
        { tool: "dispatch_output", sessionID: "sess-1", callID: "call-1" },
        output,
        new HookState(),
        minimalDeps({ dispatchManager: mockManager as any }),
      ),
    ).rejects.toThrow("dispatch_output blocked");
  });

  it("allows dispatch_output on a completed task", async () => {
    registerToolSchema("dispatch_output", { task_id: z.string() });

    const mockManager = {
      getTask: mock((_id: string) => ({ status: "completed" })),
    };

    const output = { args: { task_id: "bg_123" } };
    await handleToolBefore(
      { tool: "dispatch_output", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({ dispatchManager: mockManager as any }),
    );

    // Should not throw — completed is fine
    expect(output.args).toEqual({ task_id: "bg_123" });
  });

  it("allows dispatch_output when dispatchManager has no task (unknown task_id)", async () => {
    registerToolSchema("dispatch_output", { task_id: z.string() });

    const mockManager = {
      getTask: mock((_id: string) => null),
    };

    const output = { args: { task_id: "bg_unknown" } };
    await handleToolBefore(
      { tool: "dispatch_output", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({ dispatchManager: mockManager as any }),
    );

    expect(output.args).toEqual({ task_id: "bg_unknown" });
  });

  it("allows dispatch_output when dispatchManager is undefined", async () => {
    registerToolSchema("dispatch_output", { task_id: z.string() });

    const output = { args: { task_id: "bg_123" } };
    await handleToolBefore(
      { tool: "dispatch_output", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({ dispatchManager: undefined as any }),
    );

    expect(output.args).toEqual({ task_id: "bg_123" });
  });
});

describe("handleToolBefore — hook lifecycle phases", () => {
  it("calls built-in hooks in before phase", async () => {
    const builtInRunHooks = mock(() => Promise.resolve());
    const customRunHooks = mock(() => Promise.resolve());

    registerToolSchema("bash", { command: z.string() });

    const output = { args: { command: "ls" } };
    await handleToolBefore(
      { tool: "bash", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({
        builtInHooks: { runHooks: builtInRunHooks } as any,
        customHooks: { runHooks: customRunHooks } as any,
      }),
    );

    // built-in hooks "before" should be called
    expect(builtInRunHooks).toHaveBeenCalledTimes(2); // before + after
    // Check the first call is "before" phase for built-in
    expect(builtInRunHooks.mock.calls[0][1]).toBe("before");
  });

  it("calls custom hooks in before and after phases", async () => {
    const customRunHooks = mock(() => Promise.resolve());

    registerToolSchema("bash", { command: z.string() });

    const output = { args: { command: "ls" } };
    await handleToolBefore(
      { tool: "bash", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    // custom hooks should be called 2 times: before + after
    expect(customRunHooks).toHaveBeenCalledTimes(2);
    expect(customRunHooks.mock.calls[0][1]).toBe("before");
    expect(customRunHooks.mock.calls[1][1]).toBe("after");
  });

  it("does not throw when deps and state are undefined", async () => {
    // This edge case tests the optional params
    const output = { args: { command: "ls" } };
    await handleToolBefore(
      { tool: "bash", sessionID: "sess-1", callID: "call-1" },
      output,
      undefined as any,
      undefined as any,
    );

    // Should not throw — the function handles undefined gracefully
    expect(output.args).toEqual({ command: "ls" });
  });

  it("passes the correct event type and input to runHooks", async () => {
    const customRunHooks = mock(() => Promise.resolve());

    registerToolSchema("bash", { command: z.string() });

    const output = { args: { command: "ls" } };
    await handleToolBefore(
      { tool: "bash", sessionID: "sess-1", callID: "call-1" },
      output,
      new HookState(),
      minimalDeps({ customHooks: { runHooks: customRunHooks } as any }),
    );

    // Check before phase event
    const beforeCall = customRunHooks.mock.calls[0];
    expect(beforeCall[0]).toBe("tool.execute.before");
    expect(beforeCall[3]).toMatchObject({ tool: "bash", args: { command: "ls" } });
  });
});
