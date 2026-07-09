import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { HotReloadService } from "../core/services/hot-reload-service.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("asset-hot-reload");

// ── Public factory ───────────────────────────────────────────────────────────

export function createAssetHotReloadTool(hotReloadService: HotReloadService) {
  return tool({
    description:
      "Trigger hot-reload of rolebox assets (roles, skills, references, functions). " +
      "Currently triggers a full re-discovery and re-resolution of all roles regardless of type/name filters. " +
      "The type and name arguments are accepted for forward compatibility.",

    args: {
      type: z
        .enum(["skill", "function", "reference", "role"])
        .optional()
        .default("role")
        .describe("Asset type to reload (currently triggers full reload regardless)"),
      name: z
        .string()
        .optional()
        .describe("Specific asset name to reload (currently triggers full reload regardless)"),
    },

    async execute(input) {
      const assetType = input.type ?? "role";
      const assetName = input.name;

      // Check if hot reload is disabled via env var
      const isDisabled =
        process.env.ROLEBOX_HOT_RELOAD === "false" ||
        process.env.ROLEBOX_HOT_RELOAD === "0";

      // Await trigger regardless — it's a no-op when disabled
      const result = await hotReloadService.triggerReload();

      const requestedLabel = assetName ? `${assetType} (${assetName})` : `${assetType} (all)`;

      if (isDisabled || result.disabled) {
        log.info("Hot reload is disabled by env var");
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** disabled\n` +
          `**Details:** Hot reload is disabled via ROLEBOX_HOT_RELOAD env var.\n`
        );
      }

      if (!result.success) {
        log.warn("Hot reload failed", { type: assetType, name: assetName ?? "all", error: result.error });
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** failed\n` +
          `**Details:** ${result.error ?? "Unknown error"}.\n`
        );
      }

      log.info("Hot reload completed", {
        type: assetType,
        name: assetName ?? "all",
        discovered: result.discovered,
        resolved: result.resolved,
        skipped: result.skipped,
      });
      return (
        "## Asset Hot Reload\n" +
        "\n" +
        `**Requested:** ${requestedLabel}\n` +
        `**Status:** completed\n` +
        `**Details:** Roles re-discovered and re-resolved. ` +
        `Discovered: ${result.discovered ?? 0}, Resolved: ${result.resolved ?? 0}, Skipped: ${result.skipped ?? 0}.\n`
      );
    },
  });
}
