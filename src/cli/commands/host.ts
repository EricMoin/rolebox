import { defineCommand } from "citty";

function loadCodexCommand() {
  return import("./host/codex.ts").then((m) => m.default);
}

export default defineCommand({
  meta: { name: "host", description: "Manage harness host connections and IPC adapters" },
  subCommands: {
    codex: loadCodexCommand,
  },
});
