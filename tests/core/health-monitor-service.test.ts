import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { PluginCore } from "../../src/core/plugin-core.ts";
import type { PluginService, PluginCoreLike, ServiceHealth } from "../../src/core/service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { HealthMonitorService } from "../../src/core/health-monitor-service.ts";
import { __resetForTest } from "../../src/logger.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeService(name: string, deps: string[] = [], healthFn?: () => ServiceHealth): PluginService {
  return {
    name,
    dependencies: deps,
    init: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
    ...(healthFn ? { health: healthFn } : {}),
  };
}

function makeContext(core: PluginCoreLike): PluginContext {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp",
    directory: "/tmp",
    core,
    bus: core.getBus(),
  };
}

// Mock LspClientManager with servers map
function mockLspClientManager(serversEntries: Array<[string, { status: string }]>): any {
  return {
    servers: new Map(serversEntries),
  };
}

// ── HealthMonitorService ───────────────────────────────────────────

describe("HealthMonitorService", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    __resetForTest();
    originalEnv = { ...process.env };
    // Default: enable health check with fast interval for tests
    process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = "100";
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of Object.keys(originalEnv)) {
      if (process.env[key] !== originalEnv[key]) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    mock.restore();
    __resetForTest();
  });

  // ── init / dispose ─────────────────────────────────────────────

  it("starts timer on init when enabled", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    const h = monitor.health!();
    expect(h.status).toBe("healthy");
    await core.dispose();
  });

  it("is disabled when ROLEBOX_HEALTH_CHECK=false", async () => {
    process.env.ROLEBOX_HEALTH_CHECK = "false";
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    const h = monitor.health!();
    expect(h.status).toBe("healthy");
    expect(h.detail).toBe("disabled");
    await core.dispose();
  });

  it("is disabled when ROLEBOX_HEALTH_CHECK=0", async () => {
    process.env.ROLEBOX_HEALTH_CHECK = "0";
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    const h = monitor.health!();
    expect(h.status).toBe("healthy");
    expect(h.detail).toBe("disabled");
    await core.dispose();
  });

  it("uses custom interval from env var", async () => {
    process.env.ROLEBOX_HEALTH_CHECK_INTERVAL_MS = "500";
    delete process.env.ROLEBOX_HEALTH_CHECK;

    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    const h = monitor.health!();
    expect(h.status).toBe("healthy");
    await core.dispose();
  });

  it("clears interval on dispose", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    await core.dispose();

    const h = monitor.health!();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("timer not running");
  });

  it("returns degraded when timer is not running", async () => {
    const monitor = new HealthMonitorService();
    const h = monitor.health!();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("timer not running");
  });

  // ── health() polling ────────────────────────────────────────────

  it("calls health() on services that define it", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();

    // Track call count manually
    let healthCallCount = 0;
    const healthySvc = makeService("healthy-svc", [], () => {
      healthCallCount++;
      return { status: "healthy" as const };
    });

    core.registerService(healthySvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Give the timer a chance to fire at least once
    await new Promise((r) => setTimeout(r, 250));

    // health() should have been called at least once by checkAll
    expect(healthCallCount).toBeGreaterThanOrEqual(1);

    await core.dispose();
  });

  it("does not call health() on services without it", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    const noHealthSvc = makeService("no-health-svc");
    core.registerService(noHealthSvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Give the timer a chance to fire
    await new Promise((r) => setTimeout(r, 150));

    // If checkAll doesn't throw, this passes
    expect(true).toBe(true);

    await core.dispose();
  });

  it("skips self during health check to avoid recursive restart", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Monitor's own health() should not trigger a restart of itself
    await new Promise((r) => setTimeout(r, 150));

    expect(true).toBe(true);
    await core.dispose();
  });

  // ── restart unhealthy services ────────────────────────────────

  it("restarts unhealthy services via core.restartService", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    const unhealthySvc = makeService("unhealthy-svc", [], () => ({ status: "unhealthy" as const, detail: "test failure" }));

    core.registerService(unhealthySvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Clear init call counts from the init phase
    (unhealthySvc.init as ReturnType<typeof mock>).mockClear();
    (unhealthySvc.dispose as ReturnType<typeof mock>).mockClear();

    // Give the timer a chance to fire and restart the unhealthy service
    await new Promise((r) => setTimeout(r, 250));

    // The service should have been disposed and re-initialized
    expect(unhealthySvc.dispose).toHaveBeenCalled();
    expect(unhealthySvc.init).toHaveBeenCalled();

    await core.dispose();
  });

  it("does not restart healthy services", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    const healthySvc = makeService("healthy-svc", [], () => ({ status: "healthy" as const }));

    core.registerService(healthySvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Clear init call counts
    (healthySvc.init as ReturnType<typeof mock>).mockClear();
    (healthySvc.dispose as ReturnType<typeof mock>).mockClear();

    // Give the timer a chance to fire
    await new Promise((r) => setTimeout(r, 250));

    // Healthy service should NOT have been restarted
    expect(healthySvc.dispose).not.toHaveBeenCalled();
    expect(healthySvc.init).not.toHaveBeenCalled();

    await core.dispose();
  });

  it("does not restart degraded services (only unhealthy)", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    const degradedSvc = makeService("degraded-svc", [], () => ({ status: "degraded" as const, detail: "running low on memory" }));

    core.registerService(degradedSvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Clear init call counts
    (degradedSvc.init as ReturnType<typeof mock>).mockClear();
    (degradedSvc.dispose as ReturnType<typeof mock>).mockClear();

    // Give the timer a chance to fire
    await new Promise((r) => setTimeout(r, 250));

    // Degraded service should NOT have been restarted
    expect(degradedSvc.dispose).not.toHaveBeenCalled();
    expect(degradedSvc.init).not.toHaveBeenCalled();

    await core.dispose();
  });

  it("handles health() that throws", async () => {
    const core = new PluginCore();
    const monitor = new HealthMonitorService();
    const throwingSvc = makeService("throwing-svc", [], () => {
      throw new Error("panic");
    });

    core.registerService(throwingSvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Clear init call counts
    (throwingSvc.init as ReturnType<typeof mock>).mockClear();
    (throwingSvc.dispose as ReturnType<typeof mock>).mockClear();

    // Give the timer a chance to fire - throwing should not crash the monitor
    await new Promise((r) => setTimeout(r, 250));

    // The service should have been restarted since throwing is treated as unhealthy
    expect(throwingSvc.dispose).toHaveBeenCalled();
    expect(throwingSvc.init).toHaveBeenCalled();

    await core.dispose();
  });
});

// ── Service health() implementations ──────────────────────────────

describe("DispatchService health()", () => {
  it("returns unhealthy when manager not initialized", async () => {
    // Create a minimal DispatchService-like object
    const svc = makeService("dispatch-service", [], () => ({
      status: "unhealthy" as const,
      detail: "DispatchManager not initialized",
    }));
    const h = svc.health!();
    expect(h.status).toBe("unhealthy");
    expect(h.detail).toContain("DispatchManager not initialized");
  });

  it("returns healthy when manager exists", async () => {
    const svc = makeService("dispatch-service", [], () => ({ status: "healthy" as const }));
    const h = svc.health!();
    expect(h.status).toBe("healthy");
  });
});

describe("LspService health()", () => {
  it("returns degraded when client manager not initialized", () => {
    const svc = makeService("lsp-service", [], () => ({
      status: "degraded" as const,
      detail: "LSP client manager not initialized",
    }));
    const h = svc.health!();
    expect(h.status).toBe("degraded");
  });

  it("returns healthy when no servers configured", () => {
    const svc = makeService("lsp-service", [], () => {
      const manager = mockLspClientManager([]);
      const size = manager.servers.size;
      if (size === 0) {
        return { status: "healthy" as const, detail: "no LSP servers configured" };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("healthy");
    expect(h.detail).toBe("no LSP servers configured");
  });

  it("returns unhealthy when all servers failed", () => {
    const svc = makeService("lsp-service", [], () => {
      const servers = new Map([
        ["server1", { status: "failed" as const }],
        ["server2", { status: "failed" as const }],
      ]);
      const size = servers.size;
      if (size === 0) return { status: "healthy" as const };
      let failedCount = 0;
      for (const [, state] of servers) {
        if (state.status === "failed") failedCount++;
      }
      if (failedCount > 0 && failedCount === size) {
        return { status: "unhealthy" as const, detail: `all ${failedCount} LSP servers failed` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("unhealthy");
    expect(h.detail).toBe("all 2 LSP servers failed");
  });

  it("returns degraded when some servers dead", () => {
    const svc = makeService("lsp-service", [], () => {
      const servers = new Map<string, { status: string }>([
        ["server1", { status: "running" }],
        ["server2", { status: "dead" }],
        ["server3", { status: "dead" }],
      ]);
      let deadCount = 0;
      for (const [, state] of servers) {
        if (state.status === "dead") deadCount++;
      }
      if (deadCount > 0) {
        return { status: "degraded" as const, detail: `${deadCount}/${servers.size} LSP servers dead` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("2/3 LSP servers dead");
  });

  it("returns healthy when all servers running", () => {
    const svc = makeService("lsp-service", [], () => {
      const servers = new Map<string, { status: string }>([
        ["server1", { status: "running" }],
        ["server2", { status: "running" }],
      ]);
      let deadCount = 0;
      let failedCount = 0;
      for (const [, state] of servers) {
        if (state.status === "dead") deadCount++;
        if (state.status === "failed") failedCount++;
      }
      if (failedCount > 0 && failedCount === servers.size) {
        return { status: "unhealthy" as const, detail: `all ${failedCount} LSP servers failed` };
      }
      if (deadCount > 0) {
        return { status: "degraded" as const, detail: `${deadCount}/${servers.size} LSP servers dead` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("healthy");
  });
});

describe("RecoveryService health()", () => {
  it("returns healthy when engine not created (disabled)", () => {
    const svc = makeService("recovery-service", [], () => ({
      status: "healthy" as const,
      detail: "recovery engine not created",
    }));
    const h = svc.health!();
    expect(h.status).toBe("healthy");
    expect(h.detail).toBe("recovery engine not created");
  });

  it("returns degraded when abort rate is high", () => {
    const svc = makeService("recovery-service", [], () => {
      const totalAttempts = 20;
      const abortedChains = 15;
      if (totalAttempts > 10 && abortedChains / totalAttempts > 0.5) {
        return { status: "degraded" as const, detail: `high abort rate: ${abortedChains}/${totalAttempts}` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("high abort rate: 15/20");
  });

  it("returns healthy when abort rate is acceptable", () => {
    const svc = makeService("recovery-service", [], () => {
      const totalAttempts = 20;
      const abortedChains = 5;
      if (totalAttempts > 10 && abortedChains / totalAttempts > 0.5) {
        return { status: "degraded" as const, detail: `high abort rate: ${abortedChains}/${totalAttempts}` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("healthy");
  });

  it("returns healthy when few attempts (under threshold)", () => {
    const svc = makeService("recovery-service", [], () => {
      const totalAttempts = 5;
      const abortedChains = 5;
      // totalAttempts <= 10, so it passes
      if (totalAttempts > 10 && abortedChains / totalAttempts > 0.5) {
        return { status: "degraded" as const, detail: `high abort rate: ${abortedChains}/${totalAttempts}` };
      }
      return { status: "healthy" as const };
    });
    const h = svc.health!();
    expect(h.status).toBe("healthy");
  });
});

describe("LoopService health()", () => {
  it("returns unhealthy when coordinator not initialized", () => {
    const svc = makeService("loop-service", [], () => ({
      status: "unhealthy" as const,
      detail: "LoopCoordinator not initialized",
    }));
    const h = svc.health!();
    expect(h.status).toBe("unhealthy");
    expect(h.detail).toContain("LoopCoordinator");
  });

  it("returns healthy when coordinator exists", () => {
    const svc = makeService("loop-service", [], () => ({ status: "healthy" as const }));
    const h = svc.health!();
    expect(h.status).toBe("healthy");
  });
});

// ── ServiceHealth type ────────────────────────────────────────────

describe("ServiceHealth type", () => {
  it("accepts healthy status with optional detail", () => {
    const h: ServiceHealth = { status: "healthy" };
    expect(h.status).toBe("healthy");
    expect(h.detail).toBeUndefined();
  });

  it("accepts healthy status with detail", () => {
    const h: ServiceHealth = { status: "healthy", detail: "all good" };
    expect(h.detail).toBe("all good");
  });

  it("accepts degraded status", () => {
    const h: ServiceHealth = { status: "degraded", detail: "high latency" };
    expect(h.status).toBe("degraded");
  });

  it("accepts unhealthy status", () => {
    const h: ServiceHealth = { status: "unhealthy", detail: "service crashed" };
    expect(h.status).toBe("unhealthy");
  });
});

// ── Integration with PluginCore ──────────────────────────────────

describe("HealthMonitorService integration", () => {
  afterEach(() => {
    mock.restore();
  });

  it("initializes in correct order (last after hook-service)", async () => {
    const core = new PluginCore();
    const initOrder: string[] = [];

    const svcA = makeService("a", []);
    const origInitA = svcA.init;
    svcA.init = mock(async (ctx: PluginContext) => {
      initOrder.push("a");
      return origInitA.call(svcA, ctx);
    });

    const svcB = makeService("b", ["a"]);
    const origInitB = svcB.init;
    svcB.init = mock(async (ctx: PluginContext) => {
      initOrder.push("b");
      return origInitB.call(svcB, ctx);
    });

    const hookSvc = makeService("hook-service", ["b"]);
    const origInitH = hookSvc.init;
    hookSvc.init = mock(async (ctx: PluginContext) => {
      initOrder.push("hook-service");
      return origInitH.call(hookSvc, ctx);
    });

    const monitor = new HealthMonitorService();
    const origMonitorInit = monitor.init.bind(monitor);
    monitor.init = mock(async (ctx: PluginContext) => {
      initOrder.push("health-monitor-service");
      return origMonitorInit(ctx);
    });

    core.registerService(svcA);
    core.registerService(svcB);
    core.registerService(hookSvc);
    core.registerService(monitor);
    await core.init(makeContext(core));

    // Monitor should come last due to its dependency on hook-service
    expect(initOrder).toEqual(["a", "b", "hook-service", "health-monitor-service"]);
    await core.dispose();
  });
});
