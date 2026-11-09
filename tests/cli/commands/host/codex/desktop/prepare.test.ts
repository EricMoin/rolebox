import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import command from "../../../../../../src/cli/commands/host/codex/desktop/prepare.ts";
import { prepareCodexDesktopLauncher } from "../../../../../../src/platform/adapters/codex/desktop/launcher.ts";

vi.mock("../../../../../../src/platform/adapters/codex/desktop/launcher.ts", async original => ({
  ...await original<typeof import("../../../../../../src/platform/adapters/codex/desktop/launcher.ts")>(),
  prepareCodexDesktopLauncher: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function invoke(text: string) {
  const root = mkdtempSync(join(tmpdir(), "launcher-command-")); roots.push(root);
  const config = join(root, "input.json"); writeFileSync(config, text);
  const run = command.run as (context: { args: { config: string; output: string } }) => void;
  return () => run({ args: { config, output: join(root, "launcher") } });
}

it("parses configuration defaults and passes them to launcher preparation", () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const input = { codexPath: "/path/to/codex", nodePath: "/path/to/node", desktopExecutable: "/path/to/desktop",
    socketPath: "/path/to/private/socket", logPath: "/path/to/private/log" };
  invoke(JSON.stringify(input))();
  expect(prepareCodexDesktopLauncher).toHaveBeenCalledWith({ ...input, startupTimeoutMs: 15000, maxMessageBytes: 104857600 }, expect.stringMatching(/launcher$/));
});

it.each(['{"private-fixture-value":', '{"nodePath":"relative"}', "null"])("rejects invalid input without echoing its contents", input => {
  expect(invoke(input)).toThrow("invalid_config");
  expect(prepareCodexDesktopLauncher).not.toHaveBeenCalled();
});
