import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { runComputerPlan } from "../../src/computer/exec.ts";
import { createComputerTools } from "../../src/computer/tools.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import type { ComputerPlan } from "../../src/platform/system/types.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

const originalDarwin = { ...darwinComputerUse };
const directories: string[] = [];
function context(): CanonicalToolContext {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-permission-"));
  directories.push(directory);
  return { worktree: directory, directory, sessionID: "test", messageID: "test", agent: "test",
    abort: new AbortController().signal, metadata() {}, async ask() {} };
}
function command(script: string): ComputerPlan {
  return { argv: [process.execPath, "-e", script], requires: [process.execPath], windowsVerbatimArguments: false, driver: "fixture" };
}
function token(granted: boolean): ComputerPlan {
  return command(`process.stdout.write('${granted ? "granted" : "not granted"}')`);
}
function fileProbe(path: string): ComputerPlan {
  return command(`process.stdout.write(require('node:fs').existsSync(${JSON.stringify(path)}) ? 'granted' : 'not granted')`);
}
function approve(path: string): ComputerPlan {
  return command(`require('node:fs').writeFileSync(${JSON.stringify(path)}, 'approved'); process.stdout.write('granted')`);
}
afterEach(() => {
  Object.assign(darwinComputerUse, originalDarwin);
  setPlatformForTest(undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("permission recovery", () => {
  for (const denial of ["Accessibility permission is not granted", "osascript is not allowed to send keystrokes. (1002)", "Not authorized to send Apple events to System Events. (-1743)"]) {
    it(`returns an actionable permission denial for ${denial}`, async () => {
      setPlatformForTest("darwin");
      darwinComputerUse.inputPlan = () => ({ ...command(`console.error(${JSON.stringify(denial)}); process.exit(1)`), permissionHint: "OS grant instructions." });
      const result = await createComputerTools().computer_click.execute({ x: 1, y: 2 }, context()) as any;
      expect(result.metadata.error_code).toBe("permission_denied");
      expect(result.metadata.next_action).toEqual({ tool: "computer_permissions", args: { request: true } });
      expect(result.output).toContain("computer_permissions({request:true})");
      expect(result.output).toContain("OS grant instructions");
    });
  }

  it("does not label missing helpers, timeouts or generic command errors as permission denials", async () => {
    const plans = [
      { ...command("process.exit(1)"), requires: ["/missing-rolebox-test-helper"] },
      command("setTimeout(() => {}, 10000)"),
      command("console.error('no visible window belongs to this app'); process.exit(1)"),
      command("console.error('EACCES: permission denied, open output.png'); process.exit(1)"),
    ];
    for (const plan of plans) {
      const result = await runComputerPlan({ ...plan, permissionHint: "Call computer_permissions for an OS grant." }, { timeoutMs: 100 });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.permission).toBeUndefined();
      expect(result.error).not.toContain("computer_permissions");
    }
  });

  it("routes denied screenshot access to the permission tool before capturing", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    darwinComputerUse.capturePermissionProbe = () => token(false);
    darwinComputerUse.capturePlan = () => approve(join(ctx.worktree, "unexpected"));
    const result = await createComputerTools().computer_screenshot.execute({}, ctx) as any;
    expect(result.metadata.error_code).toBe("permission_denied");
    expect(result.metadata.permission).toBe("screen_capture");
    expect(result.metadata.next_action.args).toEqual({ request: true });
    expect(existsSync(join(ctx.worktree, "unexpected"))).toBe(false);
  });

  it("does not request grants when a probe fails to run", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    darwinComputerUse.permissionProbe = () => command("console.error('probe unavailable'); process.exit(1)");
    darwinComputerUse.capturePermissionProbe = () => command("process.exit(1)");
    darwinComputerUse.permissionPrompt = () => approve(join(ctx.worktree, "input"));
    darwinComputerUse.capturePermissionPrompt = () => approve(join(ctx.worktree, "capture"));
    const result = await createComputerTools().computer_permissions.execute({ request: true }, ctx) as any;
    expect(result.metadata.error_code).toBe("permission_unverified");
    expect(result.metadata.permission_requested).toBe(false);
    expect(result.output).not.toContain("computer_permissions({request:true})");
    expect(existsSync(join(ctx.worktree, "input"))).toBe(false);
    expect(existsSync(join(ctx.worktree, "capture"))).toBe(false);
  });
});

describe("independent permission requests", () => {
  it("requests both missing grants, then verifies them with independent probes", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    const input = join(ctx.worktree, "input"), capture = join(ctx.worktree, "capture");
    darwinComputerUse.permissionProbe = () => fileProbe(input);
    darwinComputerUse.capturePermissionProbe = () => fileProbe(capture);
    darwinComputerUse.permissionPrompt = () => approve(input);
    darwinComputerUse.capturePermissionPrompt = () => approve(capture);
    const result = await createComputerTools().computer_permissions.execute({ request: true }, ctx) as any;
    expect(result.metadata.granted).toBe(true);
    expect(result.metadata.input_permission).toMatchObject({ checked: true, granted: true, requested: true });
    expect(result.metadata.screen_capture).toMatchObject({ checked: true, granted: true, requested: true });
    expect(result.metadata.permission_requested).toBe(true);
    expect(result.metadata.error_code).toBeUndefined();
  });

  it.each([true, false])("requests only the missing grant when input is granted=%s", async granted => {
    setPlatformForTest("darwin");
    const ctx = context();
    const input = join(ctx.worktree, "input"), capture = join(ctx.worktree, "capture");
    darwinComputerUse.permissionProbe = () => token(granted);
    darwinComputerUse.capturePermissionProbe = () => token(!granted);
    darwinComputerUse.permissionPrompt = () => approve(input);
    darwinComputerUse.capturePermissionPrompt = () => approve(capture);
    const result = await createComputerTools().computer_permissions.execute({ request: true }, ctx) as any;
    expect(existsSync(input)).toBe(!granted);
    expect(existsSync(capture)).toBe(granted);
    expect(result.metadata.granted).toBe(granted);
    expect(result.metadata.screen_capture.granted).toBe(!granted);
    expect(result.metadata.next_action.type).toBe("user_action");
    expect(result.metadata.next_action.recheck).toEqual({ tool: "computer_permissions", args: {} });
  });

  it("does not treat a successful request command as a grant or repeat the request", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    let requests = 0;
    darwinComputerUse.permissionProbe = () => token(true);
    darwinComputerUse.capturePermissionProbe = () => token(false);
    darwinComputerUse.permissionPrompt = () => { throw new Error("already granted"); };
    darwinComputerUse.capturePermissionPrompt = () => { requests++; return token(true); };
    const tools = createComputerTools();
    const requested = await tools.computer_permissions.execute({ request: true }, ctx) as any;
    expect(requested.metadata.granted).toBe(true);
    expect(requested.metadata.screen_capture.granted).toBe(false);
    expect(requested.metadata.next_action.type).toBe("user_action");
    expect(requested.output).toContain("do not loop permission requests");
    await tools.computer_permissions.execute({}, ctx);
    expect(requests).toBe(1);
  });

  it("does not request any permission when both probes report granted", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.permissionProbe = () => token(true);
    darwinComputerUse.capturePermissionProbe = () => token(true);
    darwinComputerUse.permissionPrompt = darwinComputerUse.capturePermissionPrompt = () => { throw new Error("unnecessary prompt"); };
    const result = await createComputerTools().computer_permissions.execute({ request: true }, context()) as any;
    expect(result.metadata.permission_requested).toBe(false);
    expect(result.metadata.granted).toBe(true);
    expect(result.metadata.screen_capture.granted).toBe(true);
  });

  it("reports a failed request without losing the independently probed denial", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.permissionProbe = () => token(true);
    darwinComputerUse.capturePermissionProbe = () => token(false);
    darwinComputerUse.capturePermissionPrompt = () => command("console.error('request API unavailable'); process.exit(1)");
    const result = await createComputerTools().computer_permissions.execute({ request: true }, context()) as any;
    expect(result.metadata.granted).toBe(true);
    expect(result.metadata.screen_capture.granted).toBe(false);
    expect(result.metadata.screen_capture.request_error).toContain("request API unavailable");
    expect(result.metadata.next_action.type).toBe("user_action");
  });

  it("dry-runs both request plans and never executes either", async () => {
    setPlatformForTest("darwin");
    const result = await createComputerTools().computer_permissions.execute({ request: true, dry_run: true }, context()) as any;
    const report = JSON.parse(result.output);
    expect(report.request_only_if_missing).toBe(true);
    expect(report.script).toContain("AXIsProcessTrustedWithOptions");
    expect(report.input_permission_probe.script).toContain("AXIsProcessTrusted()");
    expect(report.capture_permission_request.script).toContain("CGRequestScreenCaptureAccess");
    expect(report.capture_permission_probe.script).toContain("CGPreflightScreenCaptureAccess");
    expect(result.metadata.granted).toBeUndefined();
  });
});

describe("macOS screen permission request plan", () => {
  it.each([true, false])("binds the request API and reports its boolean response (%s)", granted => {
    const plan = darwinComputerUse.capturePermissionPrompt!();
    if (typeof plan === "string") throw new Error(plan);
    const tokens: string[] = [];
    let requests = 0;
    runInNewContext(plan.script!, {
      ObjC: { import() {}, bindFunction(name: string, signature: unknown) {
        expect(name).toBe("CGRequestScreenCaptureAccess");
        expect(signature).toEqual(["bool", []]);
      } },
      $: { CGRequestScreenCaptureAccess() { requests++; return granted; } },
      console: { log(token: string) { tokens.push(token); } },
    });
    expect(requests).toBe(1);
    expect(tokens).toEqual([granted ? "granted" : "not granted"]);
  });

  it("fails explicitly when the native request API is absent", () => {
    const plan = darwinComputerUse.capturePermissionPrompt!();
    if (typeof plan === "string") throw new Error(plan);
    expect(() => runInNewContext(plan.script!, { ObjC: { import() {}, bindFunction() {} }, $: {} }))
      .toThrow("no Screen Recording permission request API");
  });
});
