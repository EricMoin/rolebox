import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { DispatchService } from "../../src/core/services/dispatch-service.ts";
import type { PluginContext } from "../../src/core/context.ts";
import { createMockClient } from "../dispatch/helpers.ts";
import { __resetForTest } from "../../src/logger.ts";

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
});
