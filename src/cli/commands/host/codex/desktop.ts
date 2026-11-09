import { defineCommand } from "citty";

function loadPrepareCommand() {
  return import("./desktop/prepare.ts").then((m) => m.default);
}

function loadProbeCommand() {
  return import("./desktop/probe.ts").then((m) => m.default);
}

export default defineCommand({
  meta: { name: "desktop", description: "Connect a Codex desktop host through its Unix socket and IPC binding (experimental)" },
  subCommands: {
    prepare: loadPrepareCommand,
    probe: loadProbeCommand,
  },
});
