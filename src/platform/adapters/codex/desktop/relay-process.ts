import { runCodexDesktopRelay } from "./relay.ts";

try { await runCodexDesktopRelay(process.argv[2] ?? "", Number(process.argv[3])); }
catch {
  process.stderr.write("rolebox desktop relay: startup_failed\n");
  process.exitCode = 1;
}
