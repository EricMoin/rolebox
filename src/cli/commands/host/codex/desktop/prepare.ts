import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { DesktopLauncherError, parseCodexDesktopLauncherConfig, prepareCodexDesktopLauncher } from "../../../../../platform/adapters/codex/desktop/launcher.ts";

export default defineCommand({
  meta: { name: "prepare", description: "Prepare an experimental desktop-owned shared Codex launcher (Unix)" },
  args: {
    config: { type: "string", required: true, description: "Launcher JSON configuration" },
    output: { type: "string", required: true, description: "New absolute executable path for CODEX_CLI_PATH" },
  },
  run({ args }) {
    let config;
    try { config = parseCodexDesktopLauncherConfig(JSON.parse(readFileSync(args.config, "utf8"))); }
    catch { throw new DesktopLauncherError("invalid_config"); }
    prepareCodexDesktopLauncher(config, args.output);
    process.stdout.write("Desktop launcher prepared. Activate it through the desktop launch environment.\n");
  },
});
