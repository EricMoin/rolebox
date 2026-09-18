import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import { DispatchManager } from "../../src/dispatch/core/manager.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { createMockClient } from "../dispatch/helpers.ts";
import { __resetForTest } from "../../src/logger.ts";
import { hookState } from "../../src/hooks/state.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<PluginContext>): PluginContext {
  const suffix = Math.random().toString(36).slice(2);
  return {
    client: {} as any,
    resolvedRoles: [],
    roleFunctionsMap: new Map(),
    roleGraphMap: new Map(),
    rawDirectory: "/tmp/dsp-test-" + suffix,
    directory: "/tmp/dsp-test-" + suffix,
    core: undefined as any,
    bus: undefined as any,
    capabilities: undefined,
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────

describe("DispatchService", () => {
  beforeEach(() => {
    __resetForTest();
  });

  afterEach(() => {
    mock.restore();
    __resetForTest();
  });

  describe("degraded init", () => {
    it("sets degraded=true when hasSessionCreate=false and no sessionClient", async () => {
      const svc = new DispatchService();
      const ctx = makeContext({
        capabilities: {
          hasSessionCreate: false,
          hasBackgroundTasks: true,
          hasSessionFork: false,
          hasSessionAbort: true,
          hasAgentFileSync: false,
          hasMultiStepTools: true,
          hasEventStream: true,
          hasSessionStatus: true,
          platformId: "pi",
        },
      });
      await svc.init(ctx);

      expect(svc.isDegraded()).toBe(true);
      expect(svc.getDegradedDetail()).toContain("session create not supported");
    });

    it("getTools() returns stub tools when degraded", async () => {
      const svc = new DispatchService();
      const ctx = makeContext({
        capabilities: {
          hasSessionCreate: false,
          platformId: "pi",
        } as any,
      });
      await svc.init(ctx);

      const tools = svc.getTools();
      expect(tools.dispatch).toBeDefined();
      expect(tools.dispatch_output).toBeDefined();
      expect(tools.dispatch_cancel).toBeDefined();
      expect(tools.dispatch_metrics).toBeDefined();
      expect(tools.dispatch_status).toBeDefined();

      const result = await tools.dispatch.execute();
      expect(result).toContain("not available");
    });

    it("health() reports degraded when degraded", async () => {
      const svc = new DispatchService();
      const ctx = makeContext({
        capabilities: { hasSessionCreate: false, platformId: "pi" } as any,
      });
      await svc.init(ctx);

      const h = svc.health();
      expect(h.status).toBe("degraded");
    });

    it("getDispatchManager() throws when degraded", async () => {
      const svc = new DispatchService();
      const ctx = makeContext({
        capabilities: { hasSessionCreate: false, platformId: "pi" } as any,
      });
      await svc.init(ctx);

      expect(() => svc.getDispatchManager()).toThrow("permanently degraded");
    });
  });

  describe("healthy init (injected sessionClient)", () => {
    it("getDispatchManager() returns a manager and health() reports healthy", async () => {
      const mockClient = createMockClient();
      const svc = new DispatchService({ sessionClient: mockClient });
      const ctx = makeContext();
      await svc.init(ctx);

      const mgr = svc.getDispatchManager();
      expect(mgr).toBeDefined();
      expect(mgr.constructor.name).toBe("DispatchManager");

      const h = svc.health();
      expect(h.status).toBe("healthy");
    });

    it("getTools() returns real dispatch tools when healthy", async () => {
      const mockClient = createMockClient();
      const svc = new DispatchService({ sessionClient: mockClient });
      const ctx = makeContext();
      await svc.init(ctx);

      const tools = svc.getTools() as Record<string, any>;

      // The five restored dispatch_* tools are present.
      for (const key of ["dispatch", "dispatch_output", "dispatch_status", "dispatch_cancel", "dispatch_metrics"]) {
        expect(tools[key]).toBeDefined();
      }

      // dispatch_metrics exec returns a metrics summary (does not need a task).
      const metricsResult = await tools.dispatch_metrics.execute({ format: "summary", export_path: undefined });
      expect(metricsResult).toContain("Dispatch Metrics");

      // dispatch_status with no tasks returns the "no tasks" summary, not an error.
      const statusResult = await tools.dispatch_status.execute(
        { task_id: undefined },
        { sessionID: "sess-healthy-test", messageID: "", agent: "", directory: ctx.directory, worktree: "", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} },
      );
      expect(statusResult).toContain("Task Status");
    });
  });

  describe("subagent maps", () => {
    it("getResolvedSubagents and getSubagentModelKey return filled maps with roles", async () => {
      const mockClient = createMockClient();
      const svc = new DispatchService({ sessionClient: mockClient });
      const ctx = makeContext({
        resolvedRoles: [
          {
            id: "test-role",
            config: { model: "gpt-4" },
            prompt: "",
            skills: [],
            functions: [],
            references: [],
            subagents: [
              {
                id: "child-agent",
                config: {},
                prompt: "",
                skills: [],
                functions: [],
                references: [],
                subagents: [],
                parentId: "test-role",
                inheritedFrom: {},
              },
            ],
          },
        ] as any,
      });
      await svc.init(ctx);

      const resolved = svc.getResolvedSubagents();
      expect(resolved.has("child-agent")).toBe(true);
      expect(resolved.get("child-agent")!.parentFullId).toBe("test-role");

      const modelKeys = svc.getSubagentModelKey();
      expect(modelKeys.has("child-agent")).toBe(true);
    });
  });

  describe("health variations", () => {
    it("returns unhealthy when dispatchManager is undefined", async () => {
      // Access health() without calling init — manager is undefined
      const svc = new DispatchService();
      // Bypass degraded — reach the manager-not-initialized branch
      // We test this via reflection: health() checks !this.dispatchManager
      // The service starts without being initialized, so !dispatchManager is true
      // but degraded is also false, so we get "unhealthy"
      const h = svc.health();
      expect(h.status).toBe("unhealthy");
      expect(h.detail).toContain("DispatchManager not initialized");
    });
  });

  describe("flushPersistSync (exit path)", () => {
    it("is a no-op before init", () => {
      const svc = new DispatchService();
      expect(() => svc.flushPersistSync()).not.toThrow();
    });

    it("is a no-op when degraded", async () => {
      const svc = new DispatchService();
      const ctx = makeContext({
        capabilities: { hasSessionCreate: false, platformId: "pi" } as any,
      });
      await svc.init(ctx);

      expect(() => svc.flushPersistSync()).not.toThrow();
    });

    it("delegates to the manager exactly once when healthy", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-flush-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const mockManager = {
        dispose: mock(async () => {}),
        updateDispatchConfigs: mock(() => {}),
        isOperational: mock(() => true),
        flushPersistSync: mock(() => {}),
      };
      hookState.managerMap.set(ctx.rawDirectory, mockManager as any);
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        svc.flushPersistSync();
        expect(mockManager.flushPersistSync).toHaveBeenCalledTimes(1);
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("restart teardown", () => {
    it("dispose() evicts the cached manager so init() rebuilds a fresh one", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-restart-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        const maps = svc.getResolvedSubagents();
        const m1 = svc.getDispatchManager();
        expect((m1 as any).store.readOnly).toBe(false);

        await svc.dispose();
        expect(hookState.managerMap.has(ctx.rawDirectory)).toBe(false);

        await svc.init(ctx);
        const m2 = svc.getDispatchManager();
        expect(m2).not.toBe(m1);
        // Fresh store re-acquired the state lock (the old manager released it)
        expect((m2 as any).store.readOnly).toBe(false);
        // Map identity preserved for dispatch tool closures
        expect(svc.getResolvedSubagents()).toBe(maps);
        expect(svc.health().status).toBe("healthy");
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("dispose() disposes and evicts a cached injected manager", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-injected-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const mockManager = {
        dispose: mock(async () => {}),
        updateDispatchConfigs: mock(() => {}),
        isOperational: mock(() => true),
      };
      hookState.managerMap.set(ctx.rawDirectory, mockManager as any);
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        expect(svc.getDispatchManager()).toBe(mockManager as any);

        await svc.dispose();
        expect(mockManager.dispose).toHaveBeenCalledTimes(1);
        expect(hookState.managerMap.has(ctx.rawDirectory)).toBe(false);
      } finally {
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("health() reports unhealthy when the periodic pipeline has stopped", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-health-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        expect(svc.health().status).toBe("healthy");

        // Simulate a zombie: timers stopped but the manager is still cached
        svc.getDispatchManager().flushPersistSync();

        const h = svc.health();
        expect(h.status).toBe("unhealthy");
        expect(h.detail).toContain("periodic pipeline");
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("health() is config-aware: a configured budget limit with a disarmed sampler is unhealthy", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-health-budget-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      // Pre-seed the cache so init() reuses a manager with a budget limit set.
      const manager = new DispatchManager(createMockClient(), { maxCostPerRequest: 1 });
      manager.setStoreDirectory(dir);
      hookState.managerMap.set(ctx.rawDirectory, manager);
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        // Configured limit + armed sampler → healthy.
        expect(svc.health().status).toBe("healthy");

        // Disarm ONLY the budget sampler — the outbox sweeper keeps running.
        const deps = (manager as any).orchestrator.d;
        clearInterval(deps._budgetSamplerTimer);
        deps._budgetSamplerTimer = undefined;

        const h = svc.health();
        expect(h.status).toBe("unhealthy");
        expect(h.detail).toContain("periodic pipeline");
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("health() stays healthy with no budget limits configured (sampler legitimately absent)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-health-nobudget-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        await svc.init(ctx);
        expect((svc.getDispatchManager() as any).orchestrator.d._budgetSamplerTimer).toBeUndefined();
        expect(svc.health().status).toBe("healthy");
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("recover() failure does not latch — a later successful recover reports healthy", async () => {
      const dir = mkdtempSync(join(tmpdir(), "dsp-recover-"));
      const ctx = makeContext({ rawDirectory: dir, directory: dir });
      const svc = new DispatchService({ sessionClient: createMockClient() });

      try {
        // A regular FILE where the state directory belongs makes
        // TaskStateStore.tryLock() fail (ENOTDIR) → createDispatchManager
        // returns recoverError instead of throwing.
        writeFileSync(join(dir, ".rolebox"), "not a directory", "utf-8");

        await svc.init(ctx);
        expect(svc.health().status).toBe("degraded");
        expect(svc.health().detail).toContain("recover() failed");

        rmSync(join(dir, ".rolebox"), { force: true });
        await svc.dispose();

        await svc.init(ctx);
        expect(svc.health().status).toBe("healthy");
      } finally {
        await svc.dispose();
        hookState.managerMap.delete(ctx.rawDirectory);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
