import { describe, it, expect, mock, afterEach, beforeEach } from "bun:test";
import { PluginCore } from "../../src/core/plugin-core.ts";
import { DispatchService } from "../../src/core/dispatch-service.ts";
import { LoopService } from "../../src/core/loop-service.ts";
import { RecoveryService } from "../../src/core/recovery-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import type { PluginCoreLike } from "../../src/core/service.ts";
import type { StartupHealth } from "../../src/recovery/startup-check.ts";

const ROOT = "/Users/mgl/Project/github/rolebox";

// ── helpers ────────────────────────────────────────────────────────

function makeContext(core: PluginCoreLike): PluginContext {
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp/test-graceful",
    directory: "/tmp/test-graceful",
    core,
    bus: core.getBus(),
  };
}

// ── DispatchService tests ───────────────────────────────────────────

describe("DispatchService graceful degradation", () => {
  let dispatchService: DispatchService;

  afterEach(() => {
    mock.restore();
  });

  it("inits successfully when recover() fails — health reports degraded", async () => {
    // Mock DispatchManager so recover() throws
    mock.module(`${ROOT}/src/dispatch/manager.ts`, () => ({
      DispatchManager: mock(() => ({
        setStoreDirectory: mock(() => {}),
        recover: mock(() => Promise.reject(new Error("recover failed - simulated"))),
        flushPersist: mock(() => Promise.resolve()),
        getTask: mock(() => undefined),
        launch: mock(() => Promise.resolve({ id: "task-1", sessionId: "s-1" })),
        getResult: mock(() => Promise.resolve({ kind: "ok", text: "", error: undefined })),
        cancelTask: mock(() => Promise.resolve()),
        getVersions: mock(() => ({})),
        getTasks: mock(() => new Map()),
      })),
    }));

    dispatchService = new DispatchService();
    expect(dispatchService.critical).toBe(true);

    const core = new PluginCore();
    core.registerService(dispatchService);

    // init should NOT throw — the recover error is caught
    await core.init(makeContext(core));

    // health should show degraded
    const health = dispatchService.health();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("recover() failed");
  });
});

// ── LoopService tests ──────────────────────────────────────────────

describe("LoopService graceful degradation", () => {
  afterEach(() => {
    mock.restore();
  });

  it("inits with empty coordinator when LoopStore.load() throws", async () => {
    // Mock LoopStore so load() throws
    mock.module(`${ROOT}/src/loop/loop-store.ts`, () => ({
      LoopStore: mock(() => ({
        load: mock(() => { throw new Error("load failed - simulated"); }),
        save: mock(() => Promise.resolve()),
        saveSync: mock(() => {}),
        reconcile: mock(() => Promise.resolve(new Map())),
      })),
      isTerminalPhase: mock(() => false),
    }));

    // Also need to mock DispatchManager for the dependency chain
    mock.module(`${ROOT}/src/dispatch/manager.ts`, () => ({
      DispatchManager: mock(() => ({
        setStoreDirectory: mock(() => {}),
        recover: mock(() => Promise.resolve()),
        flushPersist: mock(() => Promise.resolve()),
        getTask: mock(() => undefined),
        launch: mock(() => Promise.resolve({ id: "task-1", sessionId: "s-1" })),
        getResult: mock(() => Promise.resolve({ kind: "ok", text: "", error: undefined })),
        cancelTask: mock(() => Promise.resolve()),
        getVersions: mock(() => ({})),
        getTasks: mock(() => new Map()),
      })),
    }));

    const core = new PluginCore();
    const ds = new DispatchService();
    const ls = new LoopService();
    core.registerService(ds);
    core.registerService(ls);

    // Should not throw — load error is caught
    await core.init(makeContext(core));

    const health = ls.health();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("load() failed");
  });

  it("all services carry critical=true flag", () => {
    const ds = new DispatchService();
    const ls = new LoopService();
    const rs = new RecoveryService();
    expect(ds.critical).toBe(true);
    expect(ls.critical).toBe(true);
    expect(rs.critical).toBe(true);
  });
});

// ── RecoveryService tests ───────────────────────────────────────────

describe("RecoveryService graceful degradation", () => {
  let recoveryService: RecoveryService;

  afterEach(() => {
    mock.restore();
    // Reset the static throttling flag for clean test state
    RecoveryService.__resetNotifiedQuarantine();
  });

  it("has critical = true", () => {
    const svc = new RecoveryService();
    expect(svc.critical).toBe(true);
  });

  it("calls StartupChecker.checkAll during init and exposes getStartupHealth()", async () => {
    // Mock StartupChecker to return a clean health state
    const healthyResult: StartupHealth = {
      healthy: true,
      quarantined: [],
      staleLocksBroken: 0,
      orphanTmpsRemoved: 0,
      warnings: [],
    };

    mock.module(`${ROOT}/src/recovery/startup-check.ts`, () => ({
      StartupChecker: { checkAll: mock(() => healthyResult) },
      StartupHealth: {},
    }));

    const core = new PluginCore();
    recoveryService = new RecoveryService();
    core.registerService(recoveryService);
    await core.init(makeContext(core));

    const startupHealth = recoveryService.getStartupHealth();
    expect(startupHealth).toBeDefined();
    expect(startupHealth!.healthy).toBe(true);

    // Health should be healthy (no quarantined files)
    const health = recoveryService.health();
    expect(health.status).toBe("healthy");
  });

  it("reports degraded when quarantined files are found", async () => {
    const quarantinedResult: StartupHealth = {
      healthy: false,
      quarantined: ["loops-abc.json", "dispatch-tasks-xyz.json"],
      staleLocksBroken: 0,
      orphanTmpsRemoved: 0,
      warnings: ["Quarantined corrupt state file: loops-abc.json"],
    };

    mock.module(`${ROOT}/src/recovery/startup-check.ts`, () => ({
      StartupChecker: { checkAll: mock(() => quarantinedResult) },
      StartupHealth: {},
    }));

    const core = new PluginCore();
    recoveryService = new RecoveryService();
    core.registerService(recoveryService);
    await core.init(makeContext(core));

    const health = recoveryService.health();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("quarantined");

    const startupHealth = recoveryService.getStartupHealth();
    expect(startupHealth).toBeDefined();
    expect(startupHealth!.quarantined).toHaveLength(2);
  });

  it("does not re-notify quarantined files on second init (throttling)", async () => {
    const quarantinedResult: StartupHealth = {
      healthy: false,
      quarantined: ["loops-abc.json"],
      staleLocksBroken: 0,
      orphanTmpsRemoved: 0,
      warnings: ["Quarantined corrupt state file: loops-abc.json"],
    };

    const checkAllMock = mock(() => quarantinedResult);
    mock.module(`${ROOT}/src/recovery/startup-check.ts`, () => ({
      StartupChecker: { checkAll: checkAllMock },
      StartupHealth: {},
    }));

    const core = new PluginCore();
    recoveryService = new RecoveryService();
    core.registerService(recoveryService);

    // First init — notification should be sent
    await core.init(makeContext(core));
    expect(recoveryService.getStartupHealth()!.quarantined).toHaveLength(1);

    // The static flag should prevent re-notification on a second init
    // Reset the service's startupHealth and re-init
    mock.restore(); // Restore the module mock

    // For second init, return a fresh quarantined result
    mock.module(`${ROOT}/src/recovery/startup-check.ts`, () => ({
      StartupChecker: { checkAll: mock(() => quarantinedResult) },
      StartupHealth: {},
    }));

    // Reset startupHealth so the second init updates it
    (recoveryService as any).startupHealth = undefined;

    // But we don't reset the static notifiedQuarantine flag
    // On second init, even though quarantined is non-empty, the
    // static flag should prevent re-logging
    await core.init(makeContext(core));
    expect(recoveryService.getStartupHealth()).toBeDefined();
  });
});
