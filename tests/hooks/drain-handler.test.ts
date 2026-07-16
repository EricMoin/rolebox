import { describe, it, expect, mock } from "bun:test";
import { drainHandlerContext } from "../../src/hooks/drain-handler.ts";
import type { ResolvedFunction } from "../../src/types.ts";

// ── Local type for mock FunctionContext ──────────────────────────────────────

interface MockFunctionContext {
  injects: string[];
  pendingActivations: { activate: string[]; deactivate: string[] };
  continuationReasons: string[];
}

// ── Helper: create minimal mocks ─────────────────────────────────────────────

function mockFunctionContext(overrides?: Partial<MockFunctionContext>): MockFunctionContext {
  return {
    injects: [],
    pendingActivations: { activate: [], deactivate: [] },
    continuationReasons: [],
    ...overrides,
  } as unknown as MockFunctionContext;
}

function mockSessionState() {
  const active = new Set<string>();
  return {
    activate: mock((sid: string, names: string[]) => {
      for (const n of names) active.add(n);
    }),
    deactivate: mock((sid: string, name: string) => {
      active.delete(name);
    }),
    getActive: mock(() => active),
    _active: active,
  };
}

function mockRuntime() {
  const states = new Map<string, { kv: Record<string, unknown>; phase: string }>();
  return {
    init: mock((sid: string, name: string) => {
      const st = { kv: {} as Record<string, unknown>, phase: "active" };
      states.set(name, st);
      return st;
    }),
    get: mock((sid: string, name: string) => states.get(name)),
    markDirty: mock(() => {}),
    all: mock(() => states),
    _states: states,
  };
}

function makeFn(name: string, overrides?: Partial<ResolvedFunction>): ResolvedFunction {
  return {
    name,
    filePath: `/test/${name}.ts`,
    content: "",
    state_schema_version: 1,
    ...overrides,
  } as unknown as ResolvedFunction;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("drainHandlerContext", () => {
  it("drains injects into pendingCorrections", () => {
    const ctx = mockFunctionContext({ injects: ["inject-1", "inject-2"] });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();
    const allFns: ResolvedFunction[] = [];

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, allFns);

    expect(pc.get("sess-1")).toBe("inject-1\ninject-2");
  });

  it("caps injects at 4096 bytes (INJECT_CAP_BYTES)", () => {
    const bigInject = "x".repeat(3000);
    const ctx = mockFunctionContext({ injects: [bigInject, bigInject] });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    // First inject (3000 bytes) should be included, second should be capped (total > 4096)
    const result = pc.get("sess-1")!;
    expect(result.length).toBe(3000); // first inject fit, second was capped
  });

  it("activates up to ACTIVATION_CAP (3) functions", () => {
    const ctx = mockFunctionContext({
      pendingActivations: {
        activate: ["fn-a", "fn-b", "fn-c", "fn-d"], // 4 requests, cap at 3
        deactivate: [],
      },
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();
    const allFns = [makeFn("fn-a"), makeFn("fn-b"), makeFn("fn-c"), makeFn("fn-d")];

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, allFns);

    // fn-d should not be activated (beyond cap of 3)
    expect(ss.activate).toHaveBeenCalledTimes(3);
    expect(rt.init).toHaveBeenCalledTimes(3);
  });

  it("deactivates the current function", () => {
    const ctx = mockFunctionContext({
      pendingActivations: {
        activate: [],
        deactivate: ["fn-a"],
      },
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    expect(ss.deactivate).toHaveBeenCalledWith("sess-1", "fn-a");
  });

  it("does NOT deactivate a function other than the current one", () => {
    const ctx = mockFunctionContext({
      pendingActivations: {
        activate: [],
        deactivate: ["fn-b"], // different from current fnName "fn-a"
      },
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    // Self-deactivation rule: only current function can be deactivated
    expect(ss.deactivate).not.toHaveBeenCalled();
  });

  it("stashes continuation reasons into runtime state", () => {
    const ctx = mockFunctionContext({
      continuationReasons: ["need more data", "processing incomplete"],
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    // Initialize runtime state for fn-a
    rt.init("sess-1", "fn-a");

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    const st = rt.get("sess-1", "fn-a")!;
    expect(st.kv.__pendingContinuationReasons).toEqual(["need more data", "processing incomplete"]);
    expect(rt.markDirty).toHaveBeenCalled();
  });

  it("appends to existing continuation reasons", () => {
    const ctx = mockFunctionContext({
      continuationReasons: ["new reason"],
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    rt.init("sess-1", "fn-a");
    const st = rt.get("sess-1", "fn-a")!;
    st.kv.__pendingContinuationReasons = ["existing reason"];

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    expect(st.kv.__pendingContinuationReasons).toEqual(["existing reason", "new reason"]);
  });

  it("handles empty context gracefully (no injects, no activations, no reasons)", () => {
    const ctx = mockFunctionContext();
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, []);

    expect(pc.size).toBe(0);
    expect(ss.activate).not.toHaveBeenCalled();
    expect(ss.deactivate).not.toHaveBeenCalled();
    expect(rt.markDirty).not.toHaveBeenCalled();
  });

  it("initializes runtime for activated functions with correct schema version", () => {
    const ctx = mockFunctionContext({
      pendingActivations: {
        activate: ["fn-a"],
        deactivate: [],
      },
    });
    const pc = new Map<string, string>();
    const ss = mockSessionState();
    const rt = mockRuntime();
    const allFns = [makeFn("fn-a", { state_schema_version: 3 })];

    drainHandlerContext(ctx as any, "sess-1", "fn-a", pc, ss as any, rt as any, allFns);

    expect(rt.init).toHaveBeenCalledTimes(1);
    // schema version 3 from makeFn
    expect(rt.init.mock.calls[0][0]).toBe("sess-1");
    expect(rt.init.mock.calls[0][1]).toBe("fn-a");
  });
});
