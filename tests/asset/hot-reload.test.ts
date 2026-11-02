import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeToolContext } from "./helpers.ts";
import type { HotReloadResult } from "../../src/core/services/hot-reload-service.ts";

function makeMockService(
  result: HotReloadResult = {
    kind: "reloaded",
    scope: "full",
    discovered: 5,
    resolved: 4,
    skipped: 1,
  },
) {
  return {
    triggerReload: vi.fn(() => Promise.resolve(result)),
  };
}

describe("hot-reload", () => {
  describe("triggerReload dispatch", () => {
    it("calls triggerReload on the service", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService();
      const tool = createAssetHotReloadTool(service as any);
      await tool.execute({}, makeToolContext());
      expect(service.triggerReload).toHaveBeenCalledTimes(1);
    });

    it("reports success status with counts", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({
        kind: "reloaded",
        scope: "full",
        discovered: 3,
        resolved: 2,
        skipped: 1,
      });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("completed");
      expect(result).toContain("Discovered: 3");
      expect(result).toContain("Resolved: 2");
      expect(result).toContain("Skipped: 1");
    });

    it("reports the fast-reload scope with the role id and skill count", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({
        kind: "reloaded",
        scope: "fast",
        roleId: "consumer",
        skills: 3,
      });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("completed");
      expect(result).toContain('role "consumer"');
      expect(result).toContain("(3 skills)");
      expect(result).not.toContain("Discovered:");
    });

    it("reports skipped status when another reload is in progress", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ kind: "busy" });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("skipped");
      expect(result).toContain("another hot reload is already in progress; nothing was changed");
    });

    it("reports failed status with error message", async () => {
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({
        kind: "failed",
        reason: "resolver context fields not set on PluginContext",
      });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
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

    it("reports disabled status when env var is false even if the service reloaded", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "false";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService();
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("disabled");
      expect(result).toContain("ROLEBOX_HOT_RELOAD");
    });

    it("reports disabled status when env var is 0", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "0";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ kind: "disabled" });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("disabled");
    });

    it("reports disabled status when the service reports disabled", async () => {
      delete process.env.ROLEBOX_HOT_RELOAD;
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ kind: "disabled" });
      const tool = createAssetHotReloadTool(service as any);
      const result: string = await tool.execute({}, makeToolContext()) as string;
      expect(result).toContain("disabled");
      expect(result).toContain("ROLEBOX_HOT_RELOAD");
    });

    it("still calls triggerReload when env var disables it", async () => {
      process.env.ROLEBOX_HOT_RELOAD = "false";
      const { createAssetHotReloadTool } = await import("../../src/asset/hot-reload.ts");
      const service = makeMockService({ kind: "disabled" });
      const tool = createAssetHotReloadTool(service as any);
      await tool.execute({}, makeToolContext());
      expect(service.triggerReload).toHaveBeenCalled();
    });
  });


});
