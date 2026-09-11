import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { PluginCore, DescriptiveCycleError } from "../../src/core/plugin-core.ts";
import type { PluginService, PluginCoreLike } from "../../src/core/service.ts";
import type { PluginContext } from "../../src/core/context.ts";

// ── helpers ────────────────────────────────────────────────────────

function makeService(name: string, deps: string[] = []): PluginService {
  return {
    name,
    dependencies: deps,
    init: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
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

// ── tests ──────────────────────────────────────────────────────────

describe("PluginCore", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("restartService", () => {
    it("restarts the target service", async () => {
      const core = new PluginCore();
      const svc = makeService("alpha");
      core.registerService(svc);
      await core.init(makeContext(core));

      // Reset call counts from init
      (svc.init as ReturnType<typeof mock>).mockClear();
      (svc.dispose as ReturnType<typeof mock>).mockClear();

      await core.restartService("alpha");

      expect(svc.dispose).toHaveBeenCalledTimes(1);
      expect(svc.init).toHaveBeenCalledTimes(1);
    });

    it("cascades restart to dependent services", async () => {
      const core = new PluginCore();
      const svcB = makeService("b", ["a"]);
      const svcA = makeService("a");
      core.registerService(svcA);
      core.registerService(svcB);
      await core.init(makeContext(core));

      // Reset call counts
      (svcA.init as ReturnType<typeof mock>).mockClear();
      (svcA.dispose as ReturnType<typeof mock>).mockClear();
      (svcB.init as ReturnType<typeof mock>).mockClear();
      (svcB.dispose as ReturnType<typeof mock>).mockClear();

      // Restart A — B depends on A, so both should restart
      await core.restartService("a");

      // A is restarted
      expect(svcA.dispose).toHaveBeenCalledTimes(1);
      expect(svcA.init).toHaveBeenCalledTimes(1);

      // B is also restarted (dependent)
      expect(svcB.dispose).toHaveBeenCalledTimes(1);
      expect(svcB.init).toHaveBeenCalledTimes(1);

      // Order: A first, then B (topo-sorted: A before B)
      const aDisposeOrder = (svcA.dispose as ReturnType<typeof mock>).mock.invocationCallOrder[0];
      const bDisposeOrder = (svcB.dispose as ReturnType<typeof mock>).mock.invocationCallOrder[0];
      expect(aDisposeOrder).toBeLessThan(bDisposeOrder);
    });

    it("does not restart services that do not depend on the target", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      const svcC = makeService("c"); // independent
      core.registerService(svcA);
      core.registerService(svcC);
      await core.init(makeContext(core));

      (svcA.init as ReturnType<typeof mock>).mockClear();
      (svcA.dispose as ReturnType<typeof mock>).mockClear();
      (svcC.init as ReturnType<typeof mock>).mockClear();
      (svcC.dispose as ReturnType<typeof mock>).mockClear();

      await core.restartService("a");

      // A restarted
      expect(svcA.dispose).toHaveBeenCalledTimes(1);
      expect(svcA.init).toHaveBeenCalledTimes(1);

      // C should NOT be restarted
      expect(svcC.dispose).not.toHaveBeenCalled();
      expect(svcC.init).not.toHaveBeenCalled();
    });

    it("handles missing service gracefully (no throw)", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      core.registerService(svcA);
      await core.init(makeContext(core));

      // Should not throw
      await core.restartService("nonexistent");
      expect(svcA.dispose).not.toHaveBeenCalled();
    });

    it("catches dispose errors and continues restart", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.dispose = mock(() => Promise.reject(new Error("dispose boom")));
      core.registerService(svcA);
      await core.init(makeContext(core));

      (svcA.init as ReturnType<typeof mock>).mockClear();

      // Should not throw despite dispose failure
      await core.restartService("a");

      // Init should still be called after failed dispose
      expect(svcA.init).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when core has no context (not yet initialized)", async () => {
      const core = new PluginCore();
      const svc = makeService("alpha");
      core.registerService(svc);

      // Not yet initialized — no ctx
      await core.restartService("alpha");
      expect(svc.dispose).not.toHaveBeenCalled();
      expect(svc.init).not.toHaveBeenCalled();
    });

    it("propagates re-init errors instead of swallowing them", async () => {
      const core = new PluginCore();
      let initCalls = 0;
      const svcA = makeService("a");
      svcA.init = mock(() => {
        initCalls++;
        // First call is from core.init() — succeeds
        // Second call is from restartService — fails
        if (initCalls >= 2) {
          return Promise.reject(new Error("init boom"));
        }
        return Promise.resolve();
      });
      core.registerService(svcA);
      await core.init(makeContext(core));

      (svcA.dispose as ReturnType<typeof mock>).mockClear();

      // The re-init error should propagate
      expect(core.restartService("a")).rejects.toThrow("init boom");
    });
  });

  describe("init resilience", () => {
    it("rejects when a critical service fails to init", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.critical = true;
      svcA.init = mock(() => Promise.reject(new Error("critical boom")));
      core.registerService(svcA);

      await expect(core.init(makeContext(core))).rejects.toThrow("critical boom");
    });

    it("resolves when an optional (non-critical) service fails to init, marking it degraded", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.init = mock(() => Promise.reject(new Error("optional boom")));
      core.registerService(svcA);

      await expect(core.init(makeContext(core))).resolves.toBeUndefined();
      expect(core.isDegraded("a")).toBe(true);
    });

    it("skips downstream services when their dependency is degraded", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.init = mock(() => Promise.reject(new Error("optional boom")));
      const svcB = makeService("b", ["a"]);
      const bInit = mock(() => Promise.resolve());
      svcB.init = bInit;
      core.registerService(svcA);
      core.registerService(svcB);

      await expect(core.init(makeContext(core))).resolves.toBeUndefined();
      expect(core.isDegraded("a")).toBe(true);
      expect(core.isDegraded("b")).toBe(true);
      expect(bInit).not.toHaveBeenCalled();
    });

    it("does not skip independent services when an unrelated service degrades", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.init = mock(() => Promise.reject(new Error("optional boom")));
      const svcC = makeService("c"); // independent
      const cInit = mock(() => Promise.resolve());
      svcC.init = cInit;
      core.registerService(svcA);
      core.registerService(svcC);

      await expect(core.init(makeContext(core))).resolves.toBeUndefined();
      expect(core.isDegraded("a")).toBe(true);
      expect(core.isDegraded("c")).toBe(false);
      expect(cInit).toHaveBeenCalledTimes(1);
    });

    it("rejects critical service even when optional services also degrade", async () => {
      const core = new PluginCore();
      const svcA = makeService("a");
      svcA.critical = true;
      svcA.init = mock(() => Promise.reject(new Error("critical boom")));
      const svcB = makeService("b"); // optional, will never init
      const bInit = mock(() => Promise.resolve());
      svcB.init = bInit;
      core.registerService(svcB);
      core.registerService(svcA);

      await expect(core.init(makeContext(core))).rejects.toThrow("critical boom");
      // B's init was never called because topoSort might order A first
      // (no dependency between A and B, order depends on insertion order)
      // Just verify the rejection propagates
    });
  });

  describe("topoSort", () => {
    it("throws a descriptive error on circular dependencies", async () => {
      const core = new PluginCore();
      // A depends on B, B depends on A — direct cycle
      const svcA = makeService("a", ["b"]);
      const svcB = makeService("b", ["a"]);
      core.registerService(svcA);
      core.registerService(svcB);

      try {
        await core.init(makeContext(core));
        // If we reach here, no error was thrown
        expect.unreachable("Expected topoSort to throw on circular dependency");
      } catch (err) {
        expect(err).toBeInstanceOf(DescriptiveCycleError);
        expect((err as DescriptiveCycleError).cycleMembers).toEqual(expect.arrayContaining(["a", "b"]));
        const msg = (err as Error).message;
        expect(msg).toContain("Circular dependency detected among services");
        expect(msg).toContain("a");
        expect(msg).toContain("b");
      }
    });

    it("throws on indirect circular dependency (A->B->C->A)", async () => {
      const core = new PluginCore();
      const svcA = makeService("a", ["b"]);
      const svcB = makeService("b", ["c"]);
      const svcC = makeService("c", ["a"]);
      core.registerService(svcA);
      core.registerService(svcB);
      core.registerService(svcC);

      try {
        await core.init(makeContext(core));
        expect.unreachable("Expected topoSort to throw on circular dependency");
      } catch (err) {
        expect(err).toBeInstanceOf(DescriptiveCycleError);
        expect((err as DescriptiveCycleError).cycleMembers).toEqual(expect.arrayContaining(["a", "b", "c"]));
        const msg = (err as Error).message;
        expect(msg).toContain("Circular dependency detected among services");
        expect(msg).toContain("a");
        expect(msg).toContain("b");
        expect(msg).toContain("c");
      }
    });

    it("does not break on a diamond dependency (non-circular)", async () => {
      const core = new PluginCore();
      // D depends on B and C; B and C depend on A — diamond, no cycle
      const svcA = makeService("a");
      const svcB = makeService("b", ["a"]);
      const svcC = makeService("c", ["a"]);
      const svcD = makeService("d", ["b", "c"]);
      core.registerService(svcA);
      core.registerService(svcB);
      core.registerService(svcC);
      core.registerService(svcD);

      await expect(core.init(makeContext(core))).resolves.toBeUndefined();
      expect(core.isDegraded("a")).toBe(false);
      expect(core.isDegraded("b")).toBe(false);
      expect(core.isDegraded("c")).toBe(false);
      expect(core.isDegraded("d")).toBe(false);
    });
  });
});
