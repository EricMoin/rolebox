import { DesktopLauncherError, runCodexDesktopLauncher } from "./launcher.ts";

try { await runCodexDesktopLauncher(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`rolebox desktop launcher: ${error instanceof DesktopLauncherError ? error.code : "startup_failed"}\n`);
  process.exitCode = 1;
}
