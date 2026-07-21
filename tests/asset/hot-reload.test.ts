import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

function makeMockService(overrides: Record<string, any> = {}) {
  return {
    triggerReload: mock(() => Promise.resolve({
      success: true,
      discovered: 5,
      resolved: 4,
      skipped: 1,
      ...overrides,
    })),
  };
}

describe("hot-reload", () => {
  describe("triggerReload dispatch", () => {
    it("calls triggerReload on the service", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService();
      const tool = createAssetHotReloadTool(service as any);
      await tool.execute({}) as any;
      expect(service.triggerReload).toHaveBeenCalledTimes(1);
    });

    it("reports success status with counts", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ success: true, discovered: 3, resolved: 2, skipped: 1 });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}) as any;
      expect(result).toContain("completed");
      expect(result).toContain("Discovered: 3");
      expect(result).toContain("Resolved: 2");
      expect(result).toContain("Skipped: 1");
    });

    it("reports failed status with error message", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({
        success: false,
        error: "resolver context fields not set on PluginContext",
      });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}) as any;
      expect(result).toContain("failed");
      expect(result).toContain("resolver context fields not set on PluginContext");
    });
  });

  describe("disabled mode", () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV };
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it("reports disabled status when env var is false", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "false";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ disabled: true, success: false });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}) as any;
      expect(result).toContain("disabled");
      expect(result).toContain("ROLEBOX_HOT_RELOAD");
    });

    it("reports disabled status when env var is 0", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "0";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ disabled: true, success: false });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}) as any;
      expect(result).toContain("disabled");
    });

    it("still calls triggerReload when env var disables it", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "false";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ disabled: true, success: false });
      const tool = createAssetHotReloadTool(service as any);
      await tool.execute({}) as any;
      expect(service.triggerReload).toHaveBeenCalled();
    });
  });


});
