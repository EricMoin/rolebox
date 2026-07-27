/**
 * PI Extension Full Lifecycle Integration Tests.
 *
 * Covers the end-to-end lifecycle of the PI extension:
 *   1. Initialization — PiLightweightServiceStack.init() with real resolved roles,
 *      verifying tool registration count and per-tool structure.
 *   2. Extension Point Registration — tools registered via pi.registerTool() with
 *      correct names, descriptions, and execute functions.
 *   3. Hook Wiring — PiEventBridge normalization and emission: Pi events are
 *      mapped to canonical events, general and type-specific handlers fire.
 *   4. Asset Hot-Reload Trigger — createAssetHotReloadTool can be instantiated
 *      with a mock HotReloadService and executed, verifying completion status.
 *   5. Agent Registrar Sync — full PiAgentRegistrar.sync() cycle: add new agents,
 *      remove stale agents, detect unchanged agents.
 *   6. Graceful Degradation — PiLightweightServiceStack handles missing
 *      pi.registerTool, missing pi.on, and empty role lists without throwing.
 *
 * Follows bun:test conventions from tests/integration/helpers.ts and matches
 * the style of tests/pi-service-stack.test.ts.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { PiLightweightServiceStack } from "../src/platform/adapters/pi/service-stack.ts";
import { PiEventBridge, mapPiEventType } from "../src/platform/adapters/pi/event-bridge.ts";
import { PiAgentRegistrar } from "../src/platform/adapters/pi/agent-registrar.ts";
import { createAssetHotReloadTool } from "../src/asset/hot-reload.ts";
import type { HotReloadService } from "../src/core/services/hot-reload-service.ts";
import type { ResolvedRole, ResolvedSubAgent } from "../src/types.ts";

// ════════════════════════════════════════════════════════════════════════════
//  Fixtures
// ════════════════════════════════════════════════════════════════════════════

const emptyRole: ResolvedRole = {
  id: "test-role",
  config: {
    name: "Test Role",
    description: "A test role for PI full lifecycle tests",
    prompt: "You are a test role.",
  },
  prompt: "You are a test role.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
};

const childRole: ResolvedSubAgent = {
  id: "test-role--helper",
  config: {
    name: "Helper",
    description: "Helper subagent for lifecycle tests",
    prompt: "You are a helper.",
  },
  prompt: "You are a helper.",
  skills: [],
  functions: [],
  references: [],
  subagents: [],
  parentId: "test-role",
  inheritedFrom: {},
};

const roleWithSubagents: ResolvedRole = {
  ...emptyRole,
  subagents: [childRole],
};

/**
 * Mock Pi API that records registerTool calls.
 */
function createRecordingPi(): {
  pi: Record<string, any>;
  registeredNames: string[];
} {
  const registeredNames: string[] = [];
  const pi: Record<string, any> = {
    registerTool: (toolDef: any) => {
      registeredNames.push(toolDef.name);
    },
    on: mock(async () => {}),
  };
  return { pi, registeredNames };
}

/**
 * Mock Pi API with no registerTool function (graceful degradation scenario).
 */
function createBarePi(): Record<string, any> {
  return {
    on: mock(async () => {}),
  };
}

/**
 * Mock HotReloadService for asset_hot_reload tool testing.
 */
function createMockHotReloadService(): HotReloadService {
  return {
    name: "hot-reload-service",
    dependencies: [],
    init: mock(async () => {}),
    dispose: mock(async () => {}),
    health: () => ({ status: "healthy" as const }),
    isDegraded: () => false,
    triggerReload: mock(async () => ({
      success: true,
      disabled: false,
      discovered: 2,
      resolved: 2,
      skipped: 0,
    })),
  } as unknown as HotReloadService;
}

/**
 * Mock HotReloadService that simulates a failure.
 */
function createFailingHotReloadService(): HotReloadService {
  return {
    name: "hot-reload-service",
    dependencies: [],
    init: mock(async () => {}),
    dispose: mock(async () => {}),
    health: () => ({ status: "healthy" as const }),
    isDegraded: () => false,
    triggerReload: mock(async () => ({
      success: false,
      error: "Simulated reload failure",
    })),
  } as unknown as HotReloadService;
}

/**
 * Disable hot-reload env var for tests that verify disabled path.
 * Restores original value after test.
 */
function withHotReloadDisabled(): () => void {
  const original = process.env.ROLEBOX_HOT_RELOAD;
  process.env.ROLEBOX_HOT_RELOAD = "false";
  return () => {
    if (original === undefined) {
      delete process.env.ROLEBOX_HOT_RELOAD;
    } else {
      process.env.ROLEBOX_HOT_RELOAD = original;
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 1: Initialization
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Initialization", () => {
  it("PiLightweightServiceStack.init() with valid roles returns positive count", async () => {
    const { pi } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    const count = await stack.init();

    // Must register at least the core tools
    expect(count).toBeGreaterThan(0);
  });

  it("PiLightweightServiceStack.init() with role list containing subagents succeeds", async () => {
    const { pi } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [roleWithSubagents]);
    const count = await stack.init();

    expect(count).toBeGreaterThan(0);
  });

  it("init with empty role list still registers core standalone and session tools", async () => {
    const { pi } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, []);
    const count = await stack.init();

    // Core standalone tools are registered even without roles
    expect(count).toBeGreaterThan(0);
  });

  it("exposes sessionAdapter and toolFactory after construction", async () => {
    const { pi } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);

    expect(stack.sessionAdapter).toBeDefined();
    expect(stack.toolFactory).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section 2: Extension Point Registration
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Extension Point Registration", () => {
  it("registers core standalone tools via pi.registerTool", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    // Core standalone tools that must always be registered
    const coreTools = [
      "hashline_read",
      "hashline_edit",
      "memory_write",
      "memory_recall",
      "memory_list",
      "web_search",
      "web_read",
      "web_fetch",
      "signal",
      "asset_search",
      "asset_inspect",
      "reference_search",
    ];

    for (const toolName of coreTools) {
      expect(registeredNames).toContain(toolName);
    }
  });

  it("does NOT register dispatch_* tools on Pi (graph-only orchestration)", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    // dispatch_* is graph-superseded: no stubs, no shims — exposing the names
    // would invite bare dispatch calls that bypass the graph engine.
    const dispatchTools = [
      "dispatch",
      "dispatch_output",
      "dispatch_cancel",
      "dispatch_metrics",
      "dispatch_status",
    ];

    for (const toolName of dispatchTools) {
      expect(registeredNames).not.toContain(toolName);
    }
  });

  it("registers session tools when sessionAdapter is available", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    const sessionTools = [
      "session_list",
      "session_read",
      "session_info",
      "session_diff",
      "session_fork",
    ];

    for (const toolName of sessionTools) {
      expect(registeredNames).toContain(toolName);
    }
  });

  it("does NOT register deprecated alias tools (session_inspect, session_changes, session_branch)", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    expect(registeredNames).not.toContain("session_inspect");
    expect(registeredNames).not.toContain("session_changes");
    expect(registeredNames).not.toContain("session_branch");
  });

  it("registers session_search and asset_validate as optional tools", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    expect(registeredNames).toContain("session_search");
    expect(registeredNames).toContain("asset_validate");
  });

  it("does not register duplicate tool names", async () => {
    const { pi, registeredNames } = createRecordingPi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    // All names should be unique
    const uniqueNames = new Set(registeredNames);
    expect(uniqueNames.size).toBe(registeredNames.length);
  });

  it("each registered tool has a valid name, description, and execute function", async () => {
    const compiledDefs: any[] = [];
    const pi: Record<string, any> = {
      registerTool: (toolDef: any) => {
        compiledDefs.push(toolDef);
      },
      on: mock(async () => {}),
    };

    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    await stack.init();

    for (const def of compiledDefs) {
      expect(def).toBeDefined();
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.execute).toBe("function");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section 3: Hook Wiring — PiEventBridge
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Hook Wiring", () => {
  it("PiEventBridge maps session_start to canonical session.created", () => {
    const type = mapPiEventType("session_start");
    expect(type).toBe("session.created");
  });

  it("PiEventBridge maps agent_end to canonical session.idle", () => {
    const type = mapPiEventType("agent_end");
    expect(type).toBe("session.idle");
  });

  it("PiEventBridge maps message_end to canonical message.completed", () => {
    const type = mapPiEventType("message_end");
    expect(type).toBe("message.completed");
  });

  it("PiEventBridge maps tool_call to canonical part.created", () => {
    const type = mapPiEventType("tool_call");
    expect(type).toBe("part.created");
  });

  it("PiEventBridge maps unknown event type to 'unknown'", () => {
    const type = mapPiEventType("nonexistent_event");
    expect(type).toBe("unknown");
  });

  it("PiEventBridge normalize extracts type and properties from a raw Pi event", () => {
    const bridge = new PiEventBridge();
    const raw = {
      type: "session_start",
      sessionId: "ses_123",
      timestamp: 1700000000000,
    };
    const canonical = bridge.normalize(raw);

    expect(canonical.type).toBe("session.created");
    expect(canonical.rawType).toBe("session_start");
    expect(canonical.properties.sessionId).toBe("ses_123");
  });

  it("PiEventBridge normalize returns unknown for null input", () => {
    const bridge = new PiEventBridge();
    const canonical = bridge.normalize(null);
    expect(canonical.type).toBe("unknown");
    expect(canonical.properties).toEqual({});
  });

  it("PiEventBridge emit dispatches to general-purpose handlers", async () => {
    const bridge = new PiEventBridge();
    const received: any[] = [];

    const unsubscribe = bridge.on(async (event) => {
      received.push(event);
    });

    const event = bridge.normalize({
      type: "session_start",
      sessionId: "ses_456",
    });
    await bridge.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("session.created");
    expect(received[0].properties.sessionId).toBe("ses_456");

    unsubscribe();
  });

  it("PiEventBridge emit dispatches to type-specific handlers", async () => {
    const bridge = new PiEventBridge();
    const received: any[] = [];

    const unsubscribe = bridge.onType("message.created", async (event) => {
      received.push(event);
    });

    // Emit matching event
    await bridge.emit({
      type: "message.created",
      rawType: "message_start",
      properties: { text: "hello" },
    });

    expect(received).toHaveLength(1);
    expect(received[0].properties.text).toBe("hello");

    // Emit non-matching event — should NOT trigger
    await bridge.emit({
      type: "session.created",
      rawType: "session_start",
      properties: {},
    });

    // Still only 1 — the session event did not trigger the message handler
    expect(received).toHaveLength(1);

    unsubscribe();
  });

  it("PiEventBridge on returns an unsubscribe function that removes the handler", async () => {
    const bridge = new PiEventBridge();
    const received: any[] = [];

    const unsubscribe = bridge.on(async (event) => {
      received.push(event);
    });

    // Emit once — should be received
    await bridge.emit(bridge.normalize({ type: "agent_start" }));
    expect(received).toHaveLength(1);

    // Unsubscribe
    unsubscribe();

    // Emit again — should NOT be received
    await bridge.emit(bridge.normalize({ type: "agent_end" }));
    expect(received).toHaveLength(1); // Still 1
  });

  it("PiEventBridge emit aggregates errors but continues dispatching", async () => {
    const bridge = new PiEventBridge();
    const goodHandler = mock(async () => {});
    const badHandler = mock(async () => {
      throw new Error("Handler failure");
    });

    bridge.on(goodHandler);
    bridge.on(badHandler);

    // emit should throw an AggregateError, but both handlers should have been called
    await expect(
      bridge.emit(bridge.normalize({ type: "tool_call" })),
    ).rejects.toThrow();
    expect(goodHandler).toHaveBeenCalledTimes(1);
    expect(badHandler).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section 4: Asset Hot-Reload Trigger
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Asset Hot-Reload Trigger", () => {
  it("createAssetHotReloadTool returns a tool with description, args, and execute", () => {
    const service = createMockHotReloadService();
    const tool = createAssetHotReloadTool(service);

    expect(tool.description).toContain("hot-reload");
    expect(tool.args).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("asset_hot_reload tool execute returns completion status on success", async () => {
    const service = createMockHotReloadService();
    const tool = createAssetHotReloadTool(service);
    const result = await tool.execute({} as any, {} as any);

    expect(result).toContain("completed");
    expect(result).toContain("Discovered: 2");
    expect(result).toContain("Resolved: 2");
  });

  it("asset_hot_reload tool execute returns failure status on error", async () => {
    const service = createFailingHotReloadService();
    const tool = createAssetHotReloadTool(service);
    const result = await tool.execute({} as any, {} as any);

    expect(result).toContain("failed");
    expect(result).toContain("Simulated reload failure");
  });

  it("asset_hot_reload tool returns disabled status when ROLEBOX_HOT_RELOAD=false", async () => {
    const restore = withHotReloadDisabled();
    try {
      const service = createMockHotReloadService();
      const tool = createAssetHotReloadTool(service);
      const result = await tool.execute({} as any, {} as any);

      expect(result).toContain("disabled");
    } finally {
      restore();
    }
  });

  it("asset_hot_reload tool executes and returns completion status", async () => {
    const service = createMockHotReloadService();
    const tool = createAssetHotReloadTool(service);
    const result = await tool.execute({} as any, {} as any);

    expect(result).toContain("completed");
    expect(result).toContain("assets (full reload)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section 5: Agent Registrar Sync
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Agent Registrar Sync", () => {
  it("PiAgentRegistrar.register adds agents to the registry", async () => {
    const registrar = new PiAgentRegistrar();
    await registrar.register([
      {
        id: "agent-1",
        name: "Agent One",
        description: "First test agent",
        model: "claude-3",
        systemPrompt: "You are Agent One.",
      },
    ]);

    const agents = registrar.getRegisteredAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent-1");
  });

  it("PiAgentRegistrar.sync detects added, removed, and unchanged agents", async () => {
    const registrar = new PiAgentRegistrar();

    // Register initial set
    await registrar.register([
      { id: "agent-1", name: "Agent One", description: "First", model: "gpt-4", systemPrompt: "" },
      { id: "agent-2", name: "Agent Two", description: "Second", model: "gpt-4", systemPrompt: "" },
    ]);

    // Sync with one removed (agent-2), one added (agent-3), one unchanged (agent-1)
    const diff = await registrar.sync([
      { id: "agent-1", name: "Agent One", description: "First", model: "gpt-4", systemPrompt: "" },
      { id: "agent-3", name: "Agent Three", description: "Third", model: "claude-3", systemPrompt: "" },
    ]);

    expect(diff.added).toContain("agent-3");
    expect(diff.removed).toContain("agent-2");
    expect(diff.unchanged).toContain("agent-1");
  });

  it("PiAgentRegistrar.sync detects changed agents as added", async () => {
    const registrar = new PiAgentRegistrar();

    await registrar.register([
      { id: "agent-1", name: "Agent One", description: "Original desc", model: "gpt-4", systemPrompt: "" },
    ]);

    // Same ID but different description — should be "added" (changed)
    const diff = await registrar.sync([
      { id: "agent-1", name: "Agent One", description: "Updated desc", model: "gpt-4", systemPrompt: "" },
    ]);

    expect(diff.added).toContain("agent-1");
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("PiAgentRegistrar.unregister removes specific agents", async () => {
    const registrar = new PiAgentRegistrar();
    await registrar.register([
      { id: "agent-1", name: "Agent One", description: "First", model: "", systemPrompt: "" },
      { id: "agent-2", name: "Agent Two", description: "Second", model: "", systemPrompt: "" },
    ]);

    await registrar.unregister(["agent-1"]);

    const agents = registrar.getRegisteredAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent-2");
  });

  it("PiAgentRegistrar.registerSkillPath and getSkillPaths work correctly", () => {
    const registrar = new PiAgentRegistrar();

    registrar.registerSkillPath("agent-1", "/tmp/skills/agent-1");
    registrar.registerSkillPath("agent-2", "/tmp/skills/agent-2");

    const paths = registrar.getSkillPaths();
    expect(paths).toContain("/tmp/skills/agent-1");
    expect(paths).toContain("/tmp/skills/agent-2");
  });

  it("PiAgentRegistrar.unregister removes associated skill paths", async () => {
    const registrar = new PiAgentRegistrar();
    await registrar.register([
      { id: "agent-1", name: "Agent One", description: "First", model: "", systemPrompt: "" },
    ]);
    registrar.registerSkillPath("agent-1", "/tmp/skills/agent-1");

    await registrar.unregister(["agent-1"]);

    const paths = registrar.getSkillPaths();
    expect(paths).not.toContain("/tmp/skills/agent-1");
  });

  it("PiAgentRegistrar.list returns sorted agent IDs", async () => {
    const registrar = new PiAgentRegistrar();
    await registrar.register([
      { id: "z-agent", name: "Z Agent", description: "Last", model: "", systemPrompt: "" },
      { id: "a-agent", name: "A Agent", description: "First", model: "", systemPrompt: "" },
    ]);

    const ids = await registrar.list();
    expect(ids).toEqual(["a-agent", "z-agent"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Section 6: Graceful Degradation
// ════════════════════════════════════════════════════════════════════════════

describe("PI Extension — Graceful Degradation", () => {
  it("PiLightweightServiceStack handles missing pi.registerTool gracefully (returns 0)", async () => {
    const pi = createBarePi();
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);

    // Should not throw when pi.registerTool is missing
    const count = await stack.init();
    // All tools fail to register — but init returns 0 instead of throwing
    expect(count).toBe(0);
  });

  it("PiLightweightServiceStack handles completely empty Pi object gracefully", async () => {
    const pi: Record<string, any> = {};
    const stack = new PiLightweightServiceStack(pi, [emptyRole]);

    // Should not throw when pi has no methods at all
    await expect(stack.init()).resolves.toBe(0);
  });

  it("PiLightweightServiceStack handles pi.on missing gracefully", async () => {
    // This matches the pattern used in pi-extension.ts where pi.on is guarded
    const pi: Record<string, any> = {
      registerTool: mock(() => {}),
      // Intentionally no 'on' method
    };

    const stack = new PiLightweightServiceStack(pi, [emptyRole]);
    const count = await stack.init();

    // Tool registration works even without pi.on
    expect(count).toBeGreaterThan(0);
  });
  it("PiLightweightServiceStack with null pi throws TypeError", async () => {
    const stack = new PiLightweightServiceStack(null, [emptyRole]);

    // null pi causes a TypeError when accessing registerTool
    await expect(stack.init()).rejects.toThrow();
  });
  it("PiLightweightServiceStack with throwing registerTool propagates error", async () => {
    const pi: Record<string, any> = {
      registerTool: mock(() => {
        throw new Error("Pi registration error");
      }),
    };

    const stack = new PiLightweightServiceStack(pi, [emptyRole]);

    // Error from registerTool propagates through init
    await expect(stack.init()).rejects.toThrow("Pi registration error");
  });
  it("mapPiEventType returns 'unknown' for undefined/null input", () => {
    // The function is called by normalize — we test edge cases directly
    const bridge = new PiEventBridge();
    const canonical = bridge.normalize(undefined);
    expect(canonical.type).toBe("unknown");

    const canonicalNull = bridge.normalize(null);
    expect(canonicalNull.type).toBe("unknown");
  });

  it("PiAgentRegistrar.unregister handles non-existent agent IDs silently", async () => {
    const registrar = new PiAgentRegistrar();

    // Should not throw when unregistering an ID that was never registered
    await expect(
      registrar.unregister(["never-registered-id"]),
    ).resolves.toBeUndefined();
  });

  it("PiAgentRegistrar.sync with empty new set removes all agents", async () => {
    const registrar = new PiAgentRegistrar();
    await registrar.register([
      { id: "agent-1", name: "Agent One", description: "First", model: "", systemPrompt: "" },
    ]);

    const diff = await registrar.sync([]);

    expect(diff.removed).toContain("agent-1");
    expect(diff.added).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(registrar.getRegisteredAgents()).toHaveLength(0);
  });

  it("asset_hot_reload tool handles null type gracefully", async () => {
    const service = createMockHotReloadService();
    const tool = createAssetHotReloadTool(service);

    // Missing type should default to "role"
    const result = await tool.execute({} as any, {} as any);
    expect(result).toContain("completed");
  });
});
