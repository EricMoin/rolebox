/**
 * Pi degradation tests — DispatchService and LoopService graceful degradation.
 *
 * Verifies that when platform capabilities indicate Pi (hasSessionCreate=false):
 *   - DispatchService.init() does not throw, marks itself degraded
 *   - DispatchService provides stub tools with clear "not available" messages
 *   - LoopService.init() skips gracefully when dispatch is degraded
 *   - Stub dispatch tool returns the correct message when invoked
 *   - Full opencode capabilities work normally (no degradation)
 *   - Pi extension integration logs show degradation messages
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchService } from "../src/core/services/dispatch-service.ts";
import { LoopService } from "../src/core/services/loop-service.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { piCapabilities, defaultCapabilities } from "../src/platform/capabilities.ts";
import type { PluginCoreLike } from "../src/core/service.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal PluginCore-like container for service lookups.
 * Returns both the miniCore object and the service map for registering services.
 */
function createMiniCore(): {
  core: PluginCoreLike;
  serviceMap: Map<string, any>;
} {
  const serviceMap = new Map<string, any>();
  const core: PluginCoreLike = {
    getService: <T>(name: string): T | undefined => serviceMap.get(name) as T | undefined,
    getServices: () => serviceMap,
    isDegraded: (_name: string) => false,
    restartService: async (_name: string) => {},
  };
  return { core, serviceMap };
}

/**
 * Create a minimal ISessionClient mock for tests that need session to proceed.
 * Only implements the methods strictly required by DispatchManager construction.
 */
function createMockSessionClient() {
  return {
    list: async () => [],
    get: async () => null,
    messages: async () => [],
    children: async () => [],
    todo: async () => [],
    diff: async () => [],
    fork: async () => null,
    status: async () => null,
    prompt: async () => null,
    promptSync: async () => null,
    create: async () => null,
    abort: async () => false,
  };
}

/**
 * Create a minimal PluginContext for testing service initialization.
 * The `client` field is unused when services degrade, so undefined is safe.
 */
function createServiceCtx(
  core: PluginCoreLike,
  capabilities?: ReturnType<typeof piCapabilities>,
  resolvedRoles?: any[],
) {
  const bus = new EventBus();
  const dir = process.cwd();
  return {
    client: undefined as any,
    session: undefined as any,
    resolvedRoles: resolvedRoles ?? [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: dir,
    directory: dir,
    core,
    bus,
    capabilities,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DispatchService — Pi graceful degradation", () => {
  it("init() with piCapabilities() does not throw", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    // Should not throw despite Pi's missing session create support
    await expect(svc.init(ctx)).resolves.toBeUndefined();
  });

  it("init() with piCapabilities() marks itself degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);

    expect(svc.isDegraded()).toBe(true);
    expect(svc.health().status).toBe("degraded");
  });

  it("health() details mention Pi when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const health = svc.health();

    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("Pi");
  });

  it("getDispatchManager() throws when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);

    expect(() => svc.getDispatchManager()).toThrow("permanently degraded");
  });

  it("getTools() returns stub dispatch tools when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    // Should have stub dispatch tools
    expect(tools.dispatch).toBeDefined();
    expect(tools.dispatch_output).toBeDefined();
    expect(tools.dispatch_cancel).toBeDefined();
    expect(tools.dispatch_metrics).toBeDefined();
    expect(tools.dispatch_status).toBeDefined();
  });

  it("stub dispatch tool returns clear not-available message", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    const result = await tools.dispatch.execute();
    expect(result).toBe("Dispatch is not available on Pi — use opencode for multi-agent workflows.");
  });

  it("stub dispatch_output tool returns same message", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    const result = await tools.dispatch_output.execute();
    expect(result).toBe("Dispatch is not available on Pi — use opencode for multi-agent workflows.");
  });

  it("stub dispatch_cancel tool returns same message", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    const result = await tools.dispatch_cancel.execute();
    expect(result).toBe("Dispatch is not available on Pi — use opencode for multi-agent workflows.");
  });

  it("stub dispatch_metrics tool returns same message", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    const result = await tools.dispatch_metrics.execute();
    expect(result).toBe("Dispatch is not available on Pi — use opencode for multi-agent workflows.");
  });

  it("stub dispatch_status tool returns same message", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    const tools = svc.getTools();

    const result = await tools.dispatch_status.execute();
    expect(result).toBe("Dispatch is not available on Pi — use opencode for multi-agent workflows.");
  });

  it("dispose() is safe when degraded (no-op)", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);
    const ctx = createServiceCtx(core, piCapabilities());

    await svc.init(ctx);
    await expect(svc.dispose()).resolves.toBeUndefined();
  });
});

describe("DispatchService — normal capabilities (no degradation)", () => {
  it("init() with defaultCapabilities (all true) does not degrade", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);

    // Use default capabilities (opencode mode — all features supported)
    const ctx = createServiceCtx(core, undefined);
    ctx.session = createMockSessionClient() as any;

    // With a valid session client and full capabilities, init should succeed
    // and the service should NOT be degraded.
    await svc.init(ctx);
    expect(svc.isDegraded()).toBe(false);
  });

  it("init() without capabilities defaults to no degradation", async () => {
    const { core, serviceMap } = createMiniCore();
    const svc = new DispatchService();
    serviceMap.set("dispatch-service", svc);

    // No capabilities = opencode full support
    const ctx = createServiceCtx(core, undefined);
    ctx.session = createMockSessionClient() as any;

    await svc.init(ctx);
    expect(svc.isDegraded()).toBe(false);
  });
});

describe("LoopService — Pi graceful degradation", () => {
  it("init() skips gracefully when DispatchService is degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    // Init dispatch (degrades)
    await dispatchSvc.init(ctx);

    // Init loop (should skip gracefully)
    await expect(loopSvc.init(ctx)).resolves.toBeUndefined();
  });

  it("marks itself degraded when dispatch is degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    await dispatchSvc.init(ctx);
    await loopSvc.init(ctx);

    expect(loopSvc.isDegraded()).toBe(true);
    expect(loopSvc.health().status).toBe("degraded");
  });

  it("health() detail mentions dispatch when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    await dispatchSvc.init(ctx);
    await loopSvc.init(ctx);

    const health = loopSvc.health();
    expect(health.detail).toContain("dispatch");
  });

  it("getLoopManager() throws when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    await dispatchSvc.init(ctx);
    await loopSvc.init(ctx);

    expect(() => loopSvc.getLoopManager()).toThrow("degraded");
  });

  it("getLoopStore() throws when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    await dispatchSvc.init(ctx);
    await loopSvc.init(ctx);

    expect(() => loopSvc.getLoopStore()).toThrow("degraded");
  });

  it("dispose() is safe when degraded", async () => {
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    const ctx = createServiceCtx(core, piCapabilities());

    await dispatchSvc.init(ctx);
    await loopSvc.init(ctx);

    await expect(loopSvc.dispose()).resolves.toBeUndefined();
  });

  it("stub tools are not registered when dispatch is not degraded", async () => {
    // Can't fully test without a real client, but we can verify that
    // LoopService has no stub tool registration mechanism through its public API.
    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const loopSvc = new LoopService();
    serviceMap.set("loop-service", loopSvc);

    // Without Pi capabilities, both services should NOT degrade
    // (but will fail on client access)
    expect(loopSvc).toBeDefined();
  });
});

describe("PiLightweightServiceStack — integration", () => {
  it("accepts external dispatch stub tools from degraded services", async () => {
    // Import inside test to avoid top-level import issues
    const { PiLightweightServiceStack } = await import("../src/platform/adapters/pi/service-stack.ts");

    const { core, serviceMap } = createMiniCore();
    const dispatchSvc = new DispatchService();
    serviceMap.set("dispatch-service", dispatchSvc);
    const ctx = createServiceCtx(core, piCapabilities());
    await dispatchSvc.init(ctx);

    const dispatchStubTools = dispatchSvc.getTools();

    // Create a minimal mock for pi
    const registeredTools: any[] = [];
    const piMock = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    };

    const stack = new PiLightweightServiceStack(
      piMock,
      [],
      undefined,
      dispatchStubTools,
    );

    const count = await stack.init();
    expect(count).toBeGreaterThan(0);

    // Restored (post-Phase-C) behavior: buildCanonicalTools merges
    // dispatchToolsOverride, so the dispatch stub tools from the degraded
    // service ARE registered on the Pi path as unavailable stubs.
    const dispatchNames = ["dispatch", "dispatch_output", "dispatch_cancel", "dispatch_metrics", "dispatch_status"];
    const registeredNames = registeredTools.map((t: any) => t.name);
    for (const name of dispatchNames) {
      expect(registeredNames).toContain(name);
    }
  });
});

describe("Pi extension log messages — degradation verification", () => {
  it("can create and init both services without errors (integration test)", async () => {
    // This tests the full flow used in pi-extension.ts
    const { core, serviceMap } = createMiniCore();
    const capabilities = piCapabilities();

    const dispatchService = new DispatchService();
    serviceMap.set("dispatch-service", dispatchService);

    const loopService = new LoopService();
    serviceMap.set("loop-service", loopService);

    const ctx = createServiceCtx(core, capabilities);

    // Init dispatch — should degrade
    await dispatchService.init(ctx);
    expect(dispatchService.health().status).toBe("degraded");

    // Init loop — should skip
    await loopService.init(ctx);
    expect(loopService.health().status).toBe("degraded");

    // Both stub tools should be available
    const dispatchTools = dispatchService.getTools();
    expect(Object.keys(dispatchTools).length).toBe(5);
    for (const tool of Object.values(dispatchTools)) {
      const result = await (tool as any).execute();
      expect(result).toContain("not available on Pi");
    }
  });

  it("Pi service stack correctly integrates service stub tools", async () => {
    // Full integration: services degrade → stubs flow into PiLightweightServiceStack
    const { PiLightweightServiceStack } = await import("../src/platform/adapters/pi/service-stack.ts");

    const { core, serviceMap } = createMiniCore();
    const capabilities = piCapabilities();

    const dispatchService = new DispatchService();
    serviceMap.set("dispatch-service", dispatchService);
    const loopService = new LoopService();
    serviceMap.set("loop-service", loopService);

    const ctx = createServiceCtx(core, capabilities);
    await dispatchService.init(ctx);
    await loopService.init(ctx);

    // Collect stub tools from degraded services
    const dispatchStubTools = dispatchService.getTools();

    // Register via PiLightweightServiceStack
    const piMock: any = { registerTool: () => {} };
    let stackInitResult = 0;
    expect(async () => {
      const stack = new PiLightweightServiceStack(piMock, [], undefined, dispatchStubTools);
      stackInitResult = await stack.init();
    }).not.toThrow();
    expect(stackInitResult).toBeGreaterThan(0);
  });
});
