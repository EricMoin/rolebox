import { defineTool } from "../platform/ports/tool-factory.ts";
import type { HotReloadService } from "../core/services/hot-reload-service.ts";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("asset-hot-reload");

// ── Public factory ───────────────────────────────────────────────────────────

export function createAssetHotReloadTool(hotReloadService: HotReloadService) {
  return defineTool({
    description:
      "Trigger hot-reload of rolebox assets (roles, skills, references, functions). " +
      "Currently triggers a full re-discovery and re-resolution of all roles regardless of type/name filters.",

    args: {},

    async execute(_input: Record<string, never>) {

      // Check if hot reload is disabled via env var
      const isDisabled =
        process.env.ROLEBOX_HOT_RELOAD === "false" ||
        process.env.ROLEBOX_HOT_RELOAD === "0";

      // Await trigger regardless — it's a no-op when disabled
      const result = await hotReloadService.triggerReload();

      const requestedLabel = "assets (full reload)";

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
        log.warn("Hot reload failed", { error: result.error });
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** failed\n` +
          `**Details:** ${result.error ?? "Unknown error"}.\n`
        );
      }

      log.info("Hot reload completed", {
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
