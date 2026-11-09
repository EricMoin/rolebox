import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import command, { readCodexDesktopBinding } from "../../../../../../src/cli/commands/host/codex/desktop/probe.ts";
import type { CodexDesktopBridgeOptions } from "../../../../../../src/platform/adapters/codex/desktop/bridge.ts";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), inspect: vi.fn(), close: vi.fn(), parent: vi.fn() }));
vi.mock("../../../../../../src/platform/adapters/codex/desktop/bridge.ts", () => ({
  DEFAULT_DESKTOP_BRIDGE_RESPONSE_BYTES: 16 * 1024 * 1024, probeCodexDesktopBridge: mocks.probe,
}));
vi.mock("../../../../../../src/platform/adapters/codex/parent-notifications.ts", () => ({
  CodexParentNotifications: mocks.parent,
}));

let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.clearAllMocks(); exitCode = process.exitCode; process.exitCode = undefined;
  mocks.inspect.mockResolvedValue({ available: true, reason: "loaded" });
  mocks.parent.mockImplementation(function () { return { inspect: mocks.inspect, close: mocks.close }; });
  mocks.probe.mockResolvedValue({ status: "ready", stage: "tools/call", code: "verified", toolCount: 1, readOnlyToolVerified: true });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); process.exitCode = exitCode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "rolebox-bridge-config-")); roots.push(root);
  const path = join(root, "binding.json"); writeFileSync(path, text); return path;
}

it("reads only the three explicit desktop binding fields", () => {
  const binding = { pluginRoot: "/path/to/plugin", nodePath: "/path/to/node", pipePath: "/path/to/desktop.sock" };
  expect(readCodexDesktopBinding(file(JSON.stringify({ ...binding, unrelated: "ignored" })))).toEqual(binding);
});

it.each(["invalid JSON", "null", '{}', '{"pluginRoot":12,"nodePath":"node","pipePath":"pipe"}'])("rejects malformed binding %s without echoing its contents", text => {
  expect(() => readCodexDesktopBinding(file(text))).toThrow("Desktop binding must be JSON with pluginRoot, nodePath and pipePath strings");
});

function invoke(extra: Record<string, unknown> = {}) {
  const binding = file(JSON.stringify({ pluginRoot: "/path/to/plugin", nodePath: "/path/to/node", pipePath: "/path/to/desktop.sock" }));
  const run = command.run as (context: { args: Record<string, unknown> }) => Promise<void>;
  return run({ args: { binding, thread: "selected-chat", "timeout-ms": "1234", "max-response-bytes": "2097152", ...extra } });
}

it("forwards command options and verifies the parent again before closing it", async () => {
  await invoke({ socket: "/path/to/control.sock" });
  expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ threadId: "selected-chat", timeoutMs: 1234, maxResponseBytes: 2097152 }));
  expect(mocks.parent.mock.calls[0]![0].env.ROLEBOX_CODEX_PARENT_SOCKET).toBe("/path/to/control.sock");
  expect(mocks.inspect).toHaveBeenCalledWith("selected-chat");
  expect(mocks.close).toHaveBeenCalledOnce(); expect(process.exitCode).toBeUndefined();
});

it("uses exit 2 and owner-only permissions for a blocked report, including an existing file", async () => {
  const report = file("old report");
  mocks.probe.mockResolvedValue({ status: "blocked", stage: "initialize", code: "timeout", toolCount: 0, readOnlyToolVerified: false });
  await invoke({ report });
  expect(process.exitCode).toBe(2);
  expect(statSync(report).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ bridge: expect.objectContaining({ code: "timeout" }), parentNotificationAvailableAfter: true, hostConfigurationChanged: false });
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("cancels the probe through the registered SIGINT handler and removes signal listeners", async () => {
  const before = process.listeners("SIGINT"); const beforeTerm = process.listeners("SIGTERM");
  mocks.probe.mockImplementation((options: CodexDesktopBridgeOptions) => new Promise(resolve => {
    options.signal!.addEventListener("abort", () => resolve({ status: "blocked", stage: "initialize", code: "cancelled", toolCount: 0, readOnlyToolVerified: false }), { once: true });
  }));
  const pending = invoke();
  const cancel = process.listeners("SIGINT").find(listener => !before.includes(listener));
  expect(cancel).toBeDefined(); cancel!("SIGINT"); await pending;
  expect(process.exitCode).toBe(2); expect(mocks.close).toHaveBeenCalledOnce();
  expect(process.listeners("SIGINT")).toEqual(before); expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
});

it("closes the parent and removes listeners even if the probe or report write throws", async () => {
  const before = process.listeners("SIGINT");
  mocks.probe.mockRejectedValueOnce(new Error("probe failed"));
  await expect(invoke()).rejects.toThrow("probe failed");
  expect(mocks.close).toHaveBeenCalledOnce(); expect(process.listeners("SIGINT")).toEqual(before);
  const directory = mkdtempSync(join(tmpdir(), "bridge-report-")); roots.push(directory);
  await expect(invoke({ report: directory })).rejects.toThrow();
  expect(mocks.close).toHaveBeenCalledTimes(2); expect(process.listeners("SIGINT")).toEqual(before);
});
