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

      if (isDisabled || result.kind === "disabled") {
        log.info("Hot reload is disabled by env var");
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** disabled\n` +
          `**Details:** Hot reload is disabled via ROLEBOX_HOT_RELOAD env var.\n`
        );
      }

      if (result.kind === "busy") {
        log.info("Hot reload skipped — another reload is in progress");
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** skipped\n` +
          `**Details:** another hot reload is already in progress; nothing was changed.\n`
        );
      }

      if (result.kind === "failed") {
        log.warn("Hot reload failed", { error: result.reason });
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** failed\n` +
          `**Details:** ${result.reason}.\n`
        );
      }

      if (result.scope === "fast") {
        log.info("Hot reload completed", {
          scope: "fast",
          roleId: result.roleId,
          skills: result.skills,
        });
        return (
          "## Asset Hot Reload\n" +
          "\n" +
          `**Requested:** ${requestedLabel}\n` +
          `**Status:** completed\n` +
          `**Details:** skills re-resolved for role "${result.roleId}" (${result.skills} skills).\n`
        );
      }

      log.info("Hot reload completed", {
        scope: "full",
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
        `Discovered: ${result.discovered}, Resolved: ${result.resolved}, Skipped: ${result.skipped}.\n`
      );
    },
  });
}
