import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerOperationQueue } from "../../src/computer/queue.ts";
import { runComputerPlan } from "../../src/computer/exec.ts";
import { captureResult, ensureCaptureDirectory } from "../../src/computer/capture.ts";
import { createComputerTools } from "../../src/computer/tools.ts";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import type { ComputerInputRequest, ComputerPlan } from "../../src/platform/system/types.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

const directories: string[] = [];
const originalDarwin = { ...darwinComputerUse };
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "rolebox-cua-runtime-"));
  directories.push(path);
  return path;
}
function context(): CanonicalToolContext {
  const worktree = temporaryDirectory();
  return { worktree, directory: worktree, sessionID: "test", messageID: "test", agent: "test",
    abort: new AbortController().signal, metadata() {}, async ask() {} };
}
function command(script: string): ComputerPlan {
  return { argv: [process.execPath, "-e", script], requires: [process.execPath], windowsVerbatimArguments: false, driver: "fixture" };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  Object.assign(darwinComputerUse, originalDarwin);
  setPlatformForTest(undefined);
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("desktop operation queue", () => {
  it("serializes observations and input, then recovers after a rejected operation", async () => {
    const queue = new ComputerOperationQueue();
    const held = deferred();
    const events: string[] = [];
    const signal = new AbortController().signal;
    const first = queue.run(async () => { events.push("first"); await held.promise; events.push("done"); }, signal);
    const second = queue.run(async () => { events.push("second"); throw new Error("fixture failure"); }, signal).catch(error => error.message);
    const third = queue.run(async () => { events.push("third"); return "ok"; }, signal);
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    held.resolve();
    await first;
    expect(await second).toBe("fixture failure");
    expect(await third).toBe("ok");
    expect(events).toEqual(["first", "done", "second", "third"]);
  });

  it("cancels waiting work promptly without executing it or overtaking active work", async () => {
    const queue = new ComputerOperationQueue();
    const held = deferred();
    const first = queue.run(() => held.promise, new AbortController().signal);
    const controller = new AbortController();
    let ran = false;
    const pending = queue.run(async () => { ran = true; }, controller.signal).catch(error => error.message);
    controller.abort();
    expect(await pending).toContain("cancelled before");
    expect(ran).toBe(false);
    held.resolve();
    await first;
    await queue.run(async () => {}, new AbortController().signal);
    expect(ran).toBe(false);
  });
});

describe("bounded command execution", () => {
  it("keeps stdout structured while retaining stderr for diagnostics", async () => {
    const result = await runComputerPlan(command("process.stderr.write('helper warning\\n'); process.stdout.write('{\"bounds\":42}')"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toBe('{"bounds":42}');
      expect(result.output).toContain("helper warning");
    }
  });

  it.skipIf(process.platform === "win32")("identifies a native helper terminated by a signal", async () => {
    const result = await runComputerPlan(command("process.kill(process.pid, 'SIGKILL')"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("terminated by signal SIGKILL");
      expect(result.error).not.toContain("status null");
    }
  });

  it("runs release cleanup after timeout, without replaying the gesture", async () => {
    const path = join(temporaryDirectory(), "released");
    const result = await runComputerPlan({ ...command("setTimeout(() => {}, 10000)"),
      cleanupPlan: command(`require('node:fs').writeFileSync(${JSON.stringify(path)}, 'released')`),
    }, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("within 100ms");
    expect(existsSync(path)).toBe(true);
  });

  it("does not start an aborted command or its release cleanup", async () => {
    const path = join(temporaryDirectory(), "unexpected");
    const controller = new AbortController();
    controller.abort();
    const result = await runComputerPlan({ ...command("process.exit(0)"),
      cleanupPlan: command(`require('node:fs').writeFileSync(${JSON.stringify(path)}, '')`),
    }, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("does not release the mouse when a geometry guard refused before input", async () => {
    const path = join(temporaryDirectory(), "unexpected-release");
    const cleanupPlan = command(`require('node:fs').writeFileSync(${JSON.stringify(path)}, '')`);
    const guarded = { ...command("process.stderr.write('helper warning\\nROLEBOX_SCREENSHOT_STALE: screenshot geometry changed; take a fresh screenshot'); process.exit(3)"),
      inputGuardFailureMarker: "ROLEBOX_SCREENSHOT_STALE", cleanupPlan };
    const result = await runComputerPlan(guarded);
    expect(result).toMatchObject({ ok: false, inputNotStarted: true });
    if (!result.ok) {
      expect(result.error).toContain("screenshot geometry changed; take a fresh screenshot");
      expect(result.error).not.toContain("ROLEBOX_SCREENSHOT_STALE");
    }
    expect(existsSync(path)).toBe(false);
    await runComputerPlan({ ...guarded, ...command("process.stderr.write('input failed'); process.exit(3)") });
    expect(existsSync(path)).toBe(true);
  });

  it("reports release failures and bounds helper output", async () => {
    const result = await runComputerPlan({ ...command("process.exit(1)"), cleanupPlan: command("process.exit(2)") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Mouse release could not be confirmed");
    const excessive = await runComputerPlan(command("process.stdout.write('x'.repeat(2 * 1024 * 1024))"));
    expect(excessive.ok).toBe(false);
    if (!excessive.ok) expect(excessive.error).toContain("bytes and was stopped");
  });
});

describe("desktop tool contract", () => {
  const inputs = {
    computer_click: { x: -30, y: 20 },
    computer_move: { x: 30, y: 20 },
    computer_type: { text: "example" },
    computer_key: { keys: ["Return"] },
    computer_scroll: { direction: "down", x: 30, y: 20 },
    computer_drag: { from_x: 30, from_y: 20, to_x: 40, to_y: 50 },
  };

  for (const platform of ["darwin", "linux", "win32"] as const) {
    it(`accepts an explicit window on every input tool on ${platform}`, async () => {
      setPlatformForTest(platform);
      const tools = createComputerTools();
      const ctx = context();
      for (const [name, args] of Object.entries(inputs)) {
        const result = await tools[name].execute({ ...args, window_id: 4242, dry_run: true }, ctx) as any;
        expect(result.metadata).toMatchObject({ dry_run: true, window_id: 4242 });
        const report = JSON.parse(result.output);
        expect(report.script).toContain("4242");
        const invalid = await tools[name].execute({ ...args, window_id: 0, dry_run: true }, ctx) as any;
        expect(invalid.output).toContain(`invalid ${name} arguments: window_id`);
      }
      expect(existsSync(join(ctx.worktree, ".rolebox"))).toBe(false);
    });
  }

  it("forwards each input target without retaining a previous selection", async () => {
    setPlatformForTest("darwin");
    const received: ComputerInputRequest[] = [];
    darwinComputerUse.inputPlan = request => { received.push(request); return command(""); };
    const tools = createComputerTools();
    const ctx = context();
    for (const [name, args] of Object.entries(inputs)) {
      for (const window_id of [42, 43, undefined]) {
        const result = await tools[name].execute({ ...args, window_id }, ctx) as any;
        expect(result.metadata.window_id).toBe(window_id);
        expect(received.at(-1)).toMatchObject({ action: name.slice("computer_".length), windowId: window_id });
      }
    }
  });

  it("keeps concurrent window focus and input plans in separate queue slots", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    const path = join(ctx.worktree, "events.jsonl");
    darwinComputerUse.inputPlan = request => {
      if (request.action !== "type") throw new Error("unexpected fixture action");
      return command(`
        const fs = require('node:fs');
        const append = event => fs.appendFileSync(${JSON.stringify(path)}, JSON.stringify(event) + '\\n');
        append(['focus', ${request.windowId}]);
        setTimeout(() => append(['input', ${request.windowId}]), 30);
      `);
    };
    const tool = createComputerTools().computer_type;
    const results = await Promise.all([42, 43].map(window_id => tool.execute({ window_id, text: "example" }, ctx)));
    expect(results.every(result => typeof result !== "string" && !result.output.startsWith("Error:"))).toBe(true);
    expect(readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
      ["focus", 42], ["input", 42], ["focus", 43], ["input", 43],
    ]);
  });

  it("reports the requested window when targeted input fails", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.inputPlan = () => command("process.stderr.write('window does not exist'); process.exit(3)");
    const result = await createComputerTools().computer_type.execute({ window_id: 42, text: "example" }, context()) as any;
    expect(result.output).toContain("Error:");
    expect(result.output).toContain("window does not exist");
    expect(result.metadata.window_id).toBe(42);
    expect(result.output).not.toContain("Typed");
  });

  it("retains release failure diagnostics when the tool deadline expires", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.inputPlan = () => ({ ...command("setTimeout(() => {}, 10000)"), cleanupPlan: command("process.exit(7)") });
    const result = await createComputerTools().computer_drag.execute({ from_x: 0, from_y: 0, to_x: 2, to_y: 2, timeout_ms: 100 }, context()) as any;
    expect(result.metadata.timed_out).toBe(true);
    expect(result.output).toContain("Mouse release could not be confirmed");
  });

  it("reports independent input and screen-capture permissions without prompting", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.permissionProbe = () => command("process.stdout.write('granted')");
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('not granted')");
    const tools = createComputerTools();
    const status = await tools.computer_status.execute({}, context()) as any;
    const report = JSON.parse(status.output);
    expect(report.input_permission.granted).toBe(true);
    expect(report.screen_capture.granted).toBe(false);
    const permissions = await tools.computer_permissions.execute({}, context()) as any;
    expect(permissions.metadata.granted).toBe(true);
    expect(permissions.metadata.screen_capture.granted).toBe(false);
  });
  for (const platform of ["darwin", "linux", "win32"] as const) {
    it(`plans every new operation on ${platform} without touching the desktop`, async () => {
      setPlatformForTest(platform);
      const tools = createComputerTools();
      const ctx = context();
      const calls = {
        computer_displays: {}, computer_focus: { window_id: 42 },
        computer_scroll: { direction: "down" },
        computer_drag: { from_x: -30, from_y: 2, to_x: 40, to_y: 50 },
      };
      for (const [name, args] of Object.entries(calls)) {
        const result = await tools[name].execute({ ...args, dry_run: true }, ctx) as any;
        expect(result.metadata.dry_run).toBe(true);
        expect(JSON.parse(result.output).argv.length).toBeGreaterThan(0);
        if (name === "computer_drag") expect(JSON.parse(result.output).cleanup.argv.length).toBeGreaterThan(0);
      }
      const status = await tools.computer_status.execute({ dry_run: true }, ctx) as any;
      const report = JSON.parse(status.output);
      expect(report.operations.scroll.planned).toBe(true);
      expect(report.input_permission.checked).toBe(false);
      expect(report.helpers).toBeUndefined();
      expect(existsSync(join(ctx.worktree, ".rolebox"))).toBe(false);
    });
  }

  it("rejects invalid numbers, timeouts, wheel counts and partial positions", async () => {
    const tools = createComputerTools();
    const ctx = context();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["computer_scroll", { direction: "up", amount: 101 }],
      ["computer_scroll", { direction: "up", x: 2 }],
      ["computer_move", { x: Infinity, y: 0 }],
      ["computer_drag", { from_x: 0, from_y: 0, to_x: 1, to_y: 1, duration_ms: 99 }],
      ["computer_windows", { timeout_ms: 120001 }],
      ["computer_focus", { window_id: -1 }],
      ["computer_screenshot", { display: 0, region: { x: 0, y: 0, w: 10, h: 10 } }],
    ];
    for (const [name, args] of calls) {
      const result = await tools[name].execute({ ...args, dry_run: true }, ctx) as any;
      expect(result.output.startsWith("Error:")).toBe(true);
    }
  });
});

describe("capture coordinates and files", () => {
  it("preserves existing custom parent directory modes", () => {
    const path = temporaryDirectory();
    chmodSync(path, 0o755);
    const before = statSync(path).mode;
    ensureCaptureDirectory(path, false);
    expect(statSync(path).mode).toBe(before);
  });

  it("refuses an unverified screen-capture grant before running the screenshot helper", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    const marker = join(ctx.worktree, "unexpected");
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('not granted')");
    darwinComputerUse.capturePlan = () => command(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`);
    const result = await createComputerTools().computer_screenshot.execute({}, ctx) as any;
    expect(result.output).toContain("Screen Recording permission");
    expect(existsSync(marker)).toBe(false);
  });

  it("writes a private capture without changing the custom parent directory mode", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    chmodSync(ctx.worktree, 0o755);
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12);
    png.writeUInt32BE(20, 16); png.writeUInt32BE(10, 20);
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('granted')");
    const geometry = { bounds: { x: 0, y: 0, w: 20, h: 10 }, displays: [
      { id: 1, x: 0, y: 0, width: 20, height: 10, scale: 2, primary: true },
    ] };
    darwinComputerUse.capturePlan = request => command(`require('node:fs').writeFileSync(${JSON.stringify(request.path)}, Buffer.from('${png.toString("base64")}', 'base64')); process.stdout.write(${JSON.stringify(JSON.stringify(geometry))})`);
    const before = statSync(ctx.worktree).mode;
    const result = await createComputerTools().computer_screenshot.execute({ path: "custom.png" }, ctx) as any;
    expect(result.attachments).toHaveLength(1);
    expect(statSync(ctx.worktree).mode).toBe(before);
    if (process.platform !== "win32") expect(statSync(join(ctx.worktree, "custom.png")).mode & 0o777).toBe(0o600);
  });

  it("does not invent window geometry for legacy callers without a snapshot", () => {
    const path = join(temporaryDirectory(), "capture.png");
    const png = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12);
    png.writeUInt32BE(20, 16); png.writeUInt32BE(10, 20);
    writeFileSync(path, png);
    const crop = captureResult(path, "linux", "fixture", { region: { x: -100, y: 50, w: 20, h: 10 } }) as any;
    expect(crop.metadata.origin).toEqual({ x: -100, y: 50 });
    expect(crop.metadata.pixel_scale).toBe(1);
    expect(crop.output).toContain("origin (-100, 50)");
    const window = captureResult(path, "darwin", "fixture", { windowId: 42 }) as any;
    expect(window.metadata.origin).toBeNull();
    expect(window.output).toContain("origin of this window/display capture is unknown");
    expect(window.output).toContain("does not declare a reliable pixel_scale");
  });
});
