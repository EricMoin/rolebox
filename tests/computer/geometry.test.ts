import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ComputerScreenshotRegistry, parseCaptureGeometry } from "../../src/computer/geometry.ts";
import { captureResult } from "../../src/computer/capture.ts";
import { createComputerTools } from "../../src/computer/tools.ts";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { setPlatformForTest } from "../../src/platform/system/index.ts";
import type { ComputerCaptureGeometry, ComputerInputRequest, ComputerPlan } from "../../src/platform/system/types.ts";
import type { CanonicalToolContext } from "../../src/platform/types.ts";

const owner = { sessionID: "test", worktree: "/fixture", platform: "darwin" };
const displays = [
  { id: 1, name: "main", x: 0, y: 0, width: 1000, height: 800, scale: 2, primary: true },
  { id: 2, name: "left", x: -1000, y: -100, width: 1000, height: 800, scale: 1, primary: false },
];
const geometry: ComputerCaptureGeometry = { bounds: { x: -200, y: 50, w: 400, h: 200 }, displays };
const screenshot = { ...owner, target: { windowId: 42 }, geometry, width: 800, height: 400 };
const originalDarwin = { ...darwinComputerUse };
const directories: string[] = [];

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

function context(): CanonicalToolContext {
  const worktree = mkdtempSync(join(tmpdir(), "rolebox-geometry-"));
  directories.push(worktree);
  return { ...owner, worktree, directory: worktree, messageID: "test", agent: "test", abort: new AbortController().signal, metadata() {}, async ask() {} };
}

function command(script: string): ComputerPlan {
  return { argv: [process.execPath, "-e", script], requires: [process.execPath], windowsVerbatimArguments: false, driver: "fixture" };
}

afterEach(() => {
  Object.assign(darwinComputerUse, originalDarwin);
  setPlatformForTest(undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("screenshot coordinate mapping", () => {
  it("maps both halves of a mixed-scale spanning window using its actual raster extent", () => {
    const registry = new ComputerScreenshotRegistry();
    const id = registry.remember(screenshot);
    expect(registry.map(id, { action: "move", x: 100, y: 40 }, owner)).toMatchObject({ x: -150, y: 70, windowId: 42 });
    expect(registry.map(id, { action: "move", x: 600, y: 40 }, owner)).toMatchObject({ x: 100, y: 70, windowId: 42 });
    expect(registry.map(id, { action: "drag", fromX: 100, fromY: 40, toX: 600, toY: 40, durationMs: 500 }, owner))
      .toMatchObject({ fromX: -150, fromY: 70, toX: 100, toY: 70, captureGuard: { geometry, target: { windowId: 42 } } });
  });

  it("uses physical pixels on a Windows monitor with 150% UI scaling", () => {
    const registry = new ComputerScreenshotRegistry();
    const windowsOwner = { ...owner, platform: "win32" };
    const id = registry.remember({ ...screenshot, ...windowsOwner, target: { display: 2 }, width: 400, height: 200,
      geometry: { ...geometry, displays: displays.map(display => ({ ...display, scale: 1.5 })) } });
    expect(registry.map(id, { action: "click", x: 120, y: 60, button: "left", clicks: 1 }, windowsOwner))
      .toMatchObject({ x: -80, y: 110, windowId: undefined });
  });

  it("maps each axis independently when raster rounding produces different ratios", () => {
    const registry = new ComputerScreenshotRegistry();
    const id = registry.remember({ ...screenshot, width: 600, height: 250 });
    expect(registry.map(id, { action: "move", x: 300, y: 125 }, owner)).toMatchObject({ x: 0, y: 150 });
    expect(registry.map(id, { action: "move", x: 599, y: 249 }, owner)).toMatchObject({ x: 199, y: 249 });
  });

  it("maps a fresh screenshot after a window crosses monitors and changes scale", () => {
    const registry = new ComputerScreenshotRegistry();
    const old = registry.remember(screenshot);
    const moved = { bounds: { x: 300, y: 200, w: 400, h: 200 }, displays };
    const fresh = registry.remember({ ...screenshot, geometry: moved, width: 400, height: 200 });
    const request = { action: "move", x: 100, y: 50 } as const;
    expect(registry.map(old, request, owner)).toMatchObject({ x: -150, y: 75, captureGuard: { geometry } });
    expect(registry.map(fresh, request, owner)).toMatchObject({ x: 400, y: 250, captureGuard: { geometry: moved } });
  });

  it("rejects points outside the image, monitor gaps, and scroll without a point", () => {
    const registry = new ComputerScreenshotRegistry();
    const id = registry.remember(screenshot);
    for (const [x, y] of [[-1, 0], [800, 0], [0, 400], [Infinity, 0]]) {
      expect(() => registry.map(id, { action: "move", x, y }, owner)).toThrow("inside the captured image");
    }
    expect(() => registry.map(id, { action: "scroll", direction: "down", amount: 3 }, owner)).toThrow("both x and y");
    const gapId = registry.remember({ ...screenshot, geometry: { bounds: { x: -200, y: -100, w: 400, h: 200 }, displays } });
    expect(() => registry.map(gapId, { action: "move", x: 600, y: 40 }, owner)).toThrow("gap between displays");
  });

  it("rejects another window, session or platform and expires bounded snapshots", () => {
    let time = 0;
    const registry = new ComputerScreenshotRegistry(() => time, 2, 100);
    const first = registry.remember(screenshot);
    const request = { action: "move", x: 1, y: 1 } as const;
    expect(() => registry.map(first, { ...request, windowId: 43 }, owner)).toThrow("must match");
    for (const other of [{ ...owner, sessionID: "other" }, { ...owner, worktree: "/other" }, { ...owner, platform: "win32" }]) {
      expect(() => registry.map(first, request, other)).toThrow("another session");
    }
    const second = registry.remember(screenshot);
    registry.remember(screenshot);
    expect(() => registry.map(first, request, owner)).toThrow("expired");
    time = 100;
    expect(() => registry.map(second, request, owner)).toThrow("expired");
  });

  it("does not let a non-window screenshot imply an unobserved window target", () => {
    const registry = new ComputerScreenshotRegistry();
    const id = registry.remember({ ...screenshot, target: { display: 1 } });
    expect(() => registry.map(id, { action: "move", x: 1, y: 1, windowId: 42 }, owner)).toThrow("take a screenshot of that window");
  });

  it("validates geometry and preserves monitor identities", () => {
    expect(parseCaptureGeometry(JSON.stringify(geometry))).toEqual(geometry);
    for (const invalid of [{}, { ...geometry, displays: [] }, { ...geometry, bounds: { x: 0, y: 0, w: 0, h: 20 } },
      { ...geometry, displays: [displays[0], displays[0]] }]) {
      expect(() => parseCaptureGeometry(JSON.stringify(invalid))).toThrow("invalid screen geometry");
    }
  });

  it("keeps stored geometry independent of a previously returned guard", () => {
    const registry = new ComputerScreenshotRegistry();
    const id = registry.remember(screenshot);
    const request = { action: "move", x: 100, y: 50 } as const;
    const mapped = registry.map(id, request, owner);
    (mapped.captureGuard!.geometry.bounds as { x: number }).x = 999;
    expect(registry.map(id, request, owner)).toMatchObject({ x: -150, y: 75, captureGuard: { geometry } });
  });
});

describe("screenshot geometry transport", () => {
  it("reports known window origins and fractional scales even without PNG density", () => {
    const ctx = context();
    const path = join(ctx.worktree, "capture.png");
    writeFileSync(path, png(600, 300));
    const result = captureResult(path, "darwin", "fixture", { windowId: 42 }, geometry) as any;
    expect(result.metadata).toMatchObject({ origin: { x: -200, y: 50 }, pixel_scale: 1.5, pixel_scale_x: 1.5, pixel_scale_y: 1.5,
      screen_bounds: geometry.bounds, displays });
    expect(result.output).not.toContain("unknown");
    expect(result.output).not.toContain("does not declare");
  });

  it("passes image coordinates through the public tools with a native stale-geometry guard", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    let currentGeometry = geometry;
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('granted')");
    darwinComputerUse.capturePlan = request => command(`
      require('node:fs').writeFileSync(${JSON.stringify(request.path)}, Buffer.from('${png(800, 400).toString("base64")}', 'base64'));
      process.stderr.write('non-fatal capture warning\\n');
      process.stdout.write(${JSON.stringify(JSON.stringify(currentGeometry))});
    `);
    const received: ComputerInputRequest[] = [];
    darwinComputerUse.inputPlan = request => {
      received.push(request);
      if ("captureGuard" in request && !isDeepStrictEqual(request.captureGuard?.geometry, currentGeometry)) {
        return command("process.stderr.write('screenshot geometry changed; take a fresh screenshot'); process.exit(3)");
      }
      return command("");
    };
    const tools = createComputerTools();
    const captured = await tools.computer_screenshot.execute({ window_id: 42 }, ctx) as any;
    expect(captured.metadata.origin).toEqual({ x: -200, y: 50 });
    const screenshot_id = captured.metadata.screenshot_id;
    expect(typeof screenshot_id).toBe("string");
    for (const [name, args] of [
      ["computer_click", { x: 600, y: 40 }], ["computer_move", { x: 600, y: 40 }],
      ["computer_scroll", { direction: "down", x: 600, y: 40 }],
      ["computer_drag", { from_x: 100, from_y: 40, to_x: 600, to_y: 40 }],
    ] as const) {
      const result = await tools[name].execute({ ...args, screenshot_id }, ctx) as any;
      expect(result.output, result.output).not.toMatch(/^Error:/);
      expect(result.metadata).toMatchObject({ window_id: 42, screenshot_id });
      expect(received.at(-1)).toMatchObject({ captureGuard: { geometry, target: { windowId: 42 } } });
    }
    expect(received[0]).toMatchObject({ x: 100, y: 70 });
    const count = received.length;
    const wrong = await tools.computer_click.execute({ screenshot_id, window_id: 43, x: 1, y: 1 }, ctx) as any;
    expect(wrong.output).toContain("must match");
    expect(received).toHaveLength(count);
    currentGeometry = { ...geometry, bounds: { ...geometry.bounds, x: 300 } };
    const stale = await tools.computer_click.execute({ screenshot_id, x: 1, y: 1 }, ctx) as any;
    expect(stale.output).toContain("take a fresh screenshot");
    const fresh = await tools.computer_screenshot.execute({ window_id: 42 }, ctx) as any;
    const moved = await tools.computer_click.execute({ screenshot_id: fresh.metadata.screenshot_id, x: 100, y: 100 }, ctx) as any;
    expect(moved.metadata).toMatchObject({ x: 350, y: 100 });
  });

  it("refuses to publish an unmapped screenshot when the helper gives no geometry", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('granted')");
    darwinComputerUse.capturePlan = () => command("process.stdout.write('{}')");
    const result = await createComputerTools().computer_screenshot.execute({}, context()) as any;
    expect(result.output).toContain("invalid screen geometry");
    expect(result.attachments).toBeUndefined();
  });

  it("parses monitor discovery independently of native warnings", async () => {
    setPlatformForTest("darwin");
    darwinComputerUse.inputPlan = () => command(`process.stderr.write('non-fatal display warning\\n'); process.stdout.write(${JSON.stringify(JSON.stringify(displays))})`);
    const result = await createComputerTools().computer_displays.execute({}, context()) as any;
    expect(result.metadata.displays).toEqual(displays);
    expect(result.metadata.count).toBe(2);
  });

  it("guards the actual rounded crop instead of the unrounded region arguments", async () => {
    setPlatformForTest("darwin");
    const ctx = context();
    const rounded = { bounds: { x: 10, y: 21, w: 400, h: 200 }, displays };
    darwinComputerUse.capturePermissionProbe = () => command("process.stdout.write('granted')");
    darwinComputerUse.capturePlan = request => command(`
      require('node:fs').writeFileSync(${JSON.stringify(request.path)}, Buffer.from('${png(400, 200).toString("base64")}', 'base64'));
      process.stdout.write(${JSON.stringify(JSON.stringify(rounded))});
    `);
    const received: ComputerInputRequest[] = [];
    darwinComputerUse.inputPlan = request => { received.push(request); return command(""); };
    const tools = createComputerTools();
    const result = await tools.computer_screenshot.execute({ region: { x: 10.4, y: 20.6, w: 400.1, h: 199.8 } }, ctx) as any;
    const clicked = await tools.computer_click.execute({ screenshot_id: result.metadata.screenshot_id, x: 100, y: 50 }, ctx) as any;
    expect(clicked.output).not.toMatch(/^Error:/);
    expect(received[0]).toMatchObject({ x: 110, y: 71, captureGuard: { target: { region: rounded.bounds }, geometry: rounded } });
  });
});
