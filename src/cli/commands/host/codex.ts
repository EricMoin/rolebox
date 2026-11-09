import { defineCommand } from "citty";

function loadDesktopCommand() {
  return import("./codex/desktop.ts").then((m) => m.default);
}

export default defineCommand({
  meta: { name: "codex", description: "Manage Codex host connections" },
  subCommands: {
    desktop: loadDesktopCommand,
  },
});
