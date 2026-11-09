import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterEach, expect, it, vi } from "vitest";
import command from "../../../src/cli/commands/host.ts";
import { prepareCodexDesktopLauncher } from "../../../src/platform/adapters/codex/desktop/launcher.ts";

vi.mock("../../../src/platform/adapters/codex/desktop/launcher.ts", async original => ({
  ...await original<typeof import("../../../src/platform/adapters/codex/desktop/launcher.ts")>(),
  prepareCodexDesktopLauncher: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "host-command-")); roots.push(root);
  const path = join(root, "input.json"); writeFileSync(path, text); return path;
}

it("routes a selected harness, connection and action with its parsed options", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const input = { codexPath: "/path/to/codex", nodePath: "/path/to/node", desktopExecutable: "/path/to/desktop",
    socketPath: "/path/to/private/socket", logPath: "/path/to/private/log" };
  await runCommand(command, { rawArgs: ["codex", "desktop", "prepare", "--config", file(JSON.stringify(input)), "--output", "/path/to/private/launcher"] });
  expect(prepareCodexDesktopLauncher).toHaveBeenCalledWith({ ...input, startupTimeoutMs: 15000, maxMessageBytes: 104857600 }, "/path/to/private/launcher");
});

it("routes the probe to binding validation before opening a parent connection", async () => {
  await expect(runCommand(command, { rawArgs: ["codex", "desktop", "probe", "--binding", file("invalid JSON"), "--thread", "selected-chat"] }))
    .rejects.toThrow("Desktop binding must be JSON with pluginRoot, nodePath and pipePath strings");
  expect(prepareCodexDesktopLauncher).not.toHaveBeenCalled();
});

it.each([
  ["other"], ["codex", "other"], ["codex", "desktop", "other"],
])("rejects unknown route %j without invoking an adapter action", async (...rawArgs) => {
  await expect(runCommand(command, { rawArgs })).rejects.toThrow("Unknown command");
  expect(prepareCodexDesktopLauncher).not.toHaveBeenCalled();
});

it.each([
  [], ["codex"], ["codex", "desktop"],
])("requires an explicit action for route %j", async (...rawArgs) => {
  await expect(runCommand(command, { rawArgs })).rejects.toThrow("No command specified");
  expect(prepareCodexDesktopLauncher).not.toHaveBeenCalled();
});

it.each(["prepare", "probe"])("preserves required flags for %s through the group hierarchy", async action => {
  await expect(runCommand(command, { rawArgs: ["codex", "desktop", action] })).rejects.toThrow("Missing required argument");
  expect(prepareCodexDesktopLauncher).not.toHaveBeenCalled();
});
