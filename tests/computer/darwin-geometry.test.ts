import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { DARWIN_COMPOSITE_SCRIPT } from "../../src/computer/drivers/darwin-geometry.ts";
import { readPngSize } from "../../src/computer/png.ts";
import type { ComputerCaptureGeometry, ComputerCaptureGuard, ComputerCaptureRequest, ComputerInputRequest } from "../../src/platform/system/types.ts";

type Rect = { origin: { x: number; y: number }; size: { width: number; height: number } };
type Raster = { width: number; height: number };

function nativeEnvironment() {
  const state = {
    displays: [
      { id: 42, x: 0, y: 0, width: 1512, height: 982, scale: 2 },
      { id: 91, x: -1920, y: -100, width: 1920, height: 1080, scale: 1 },
    ],
    window: { x: -200, y: 30, w: 500, h: 300 },
    windowVisible: true,
    onCapture: () => {},
    onFocus: () => {},
    commandStatus: 0,
    launchFails: false,
    createFails: false,
    nilData: false,
    emptyData: false,
    nilSource: false,
    nilImage: false,
    nilDestination: false,
    emptyImage: false,
    writeFails: false,
  };
  const captures: Array<{ rect?: Rect; argv: string[]; launchPath: string }> = [];
  const writes: Array<{ path: string; image: Raster }> = [];
  const events: unknown[] = [];
  const retained: Raster[] = [];
  const released: Raster[] = [];
  const draws: Array<{ destination: Rect; image: Raster }> = [];
  const canvases: Raster[] = [];
  const releasedCanvases: Raster[] = [];
  const clears: Rect[] = [];
  const files = new Map<string, Raster>();
  const created: Array<{ path: string; mode: number }> = [];
  const removed: string[] = [];
  const sources: Array<{ image: Raster }> = [];
  const cfReferences = new Set<unknown>();
  const releasedObjects: unknown[] = [];
  const masks: number[] = [];
  const nil = { isNil: () => true, toString: () => "[id nil]" };
  const nilReference = () => {};
  const api = Object.assign((value: string) => value, {
    umask: (mask: number) => { masks.push(mask); return 0o022; },
    NSScreen: { get screens() { return { count: state.displays.length, objectAtIndex: (i: number) => ({
      deviceDescription: { objectForKey: () => ({ js: state.displays[i].id }) }, backingScaleFactor: state.displays[i].scale,
    }) }; } },
    CGDisplayBounds: (id: number): Rect => {
      const display = state.displays.find(item => item.id === id)!;
      return { origin: { x: display.x, y: display.y }, size: { width: display.width, height: display.height } };
    },
    CGWindowListCopyWindowInfo: () => ({ count: state.windowVisible ? 1 : 0, objectAtIndex: () => ({ objectForKey: (key: string) => {
      if (key === "kCGWindowBounds") return { X: state.window.x, Y: state.window.y, Width: state.window.w, Height: state.window.h };
      return { js: ({ kCGWindowNumber: 9, kCGWindowLayer: 0, kCGWindowOwnerPID: 55, kCGWindowName: "Target" } as Record<string, unknown>)[key] };
    } }) }),
    CGRectMake: (x: number, y: number, width: number, height: number): Rect => ({ origin: { x, y }, size: { width, height } }),
    NSFileManager: { defaultManager: {
      createFileAtPathContentsAttributes: (path: string, _data: unknown, attrs: { NSFilePosixPermissions: number }) => {
        created.push({ path, mode: attrs.NSFilePosixPermissions });
        return !state.createFails;
      },
      removeItemAtPathError: (path: string) => { removed.push(path); files.delete(path); return true; },
    } },
    NSData: {
      data: { length: 0 },
      dataWithContentsOfFile: (path: string) => state.nilData ? nil : { length: state.emptyData ? 0 : 1, image: files.get(path) },
    },
    NSTask: { alloc: { get init() {
      return {
        launchPath: "", arguments: [] as string[],
        get launch() {
          if (state.launchFails) throw new Error("could not launch native capture");
          const call = { argv: [...this.arguments], launchPath: this.launchPath } as typeof captures[number];
          let image: Raster;
          const regionIndex = this.arguments.indexOf("-R");
          if (regionIndex !== -1) {
            const [x, y, width, height] = this.arguments[regionIndex + 1].split(",").map(Number);
            call.rect = { origin: { x, y }, size: { width, height } };
            const display = state.displays.find(item => x >= item.x && y >= item.y && x + width <= item.x + item.width && y + height <= item.y + item.height);
            expect(display).toBeDefined();
            image = { width: width * display!.scale, height: height * display!.scale };
          } else {
            expect(this.arguments).toContain("-l");
            image = { width: state.window.w * 2, height: state.window.h * 2 };
          }
          captures.push(call);
          state.onCapture();
          if (state.commandStatus === 0) files.set(this.arguments.at(-1)!, image);
          return undefined;
        },
        get waitUntilExit() { return undefined; },
        get terminationStatus() { return state.commandStatus; },
      };
    } } },
    CGImageSourceCreateWithData: (data: { image: Raster }) => {
      if (state.nilSource) return nilReference;
      const source = { image: data.image };
      sources.push(source);
      cfReferences.add(source);
      return source;
    },
    CGImageSourceCreateImageAtIndex: (source: { image: Raster }) => {
      if (state.nilImage) return nilReference;
      const image = state.emptyImage ? { width: 0, height: 0 } : source.image;
      retained.push(image);
      return image;
    },
    CFRelease: (value: { wrapped: unknown }) => {
      expect(value).toHaveProperty("wrapped");
      releasedObjects.push(value.wrapped);
    },
    NSURL: { fileURLWithPath: (path: string) => path },
    CGImageGetWidth: (image: Raster) => image.width,
    CGImageGetHeight: (image: Raster) => image.height,
    CGImageRetain: (image: Raster) => { retained.push(image); return image; },
    CGImageRelease: (image: Raster) => released.push(image),
    CGColorSpaceCreateDeviceRGB: () => ({}),
    CGColorSpaceRelease() {},
    CGBitmapContextCreate: (_data: unknown, width: number, height: number) => { const canvas = { width, height }; canvases.push(canvas); return canvas; },
    CGContextClearRect: (_canvas: unknown, rect: Rect) => clears.push(rect),
    CGContextSetInterpolationQuality() {},
    CGContextDrawImage: (_canvas: unknown, destination: Rect, image: Raster) => draws.push({ destination, image }),
    CGBitmapContextCreateImage: (canvas: Raster) => { const image = { ...canvas }; retained.push(image); return image; },
    CGContextRelease: (canvas: Raster) => releasedCanvases.push(canvas),
    CGImageDestinationCreateWithURL: (path: string) => {
      if (state.nilDestination) return nilReference;
      const destination = { path };
      cfReferences.add(destination);
      return destination;
    },
    CGImageDestinationAddImage: (destination: { path: string }, image: Raster) => writes.push({ path: destination.path, image }),
    CGImageDestinationFinalize: () => !state.writeFails,
    AXIsProcessTrusted: () => true,
    kCGHIDEventTap: "hid", kCGMouseButtonLeft: "left", kCGEventMouseMoved: "move",
    kCGEventLeftMouseDown: "down", kCGEventLeftMouseUp: "up", kCGEventLeftMouseDragged: "drag",
    CGPointMake: (x: number, y: number) => ({ x, y }),
    CGEventCreateMouseEvent: (_source: unknown, type: string, point: unknown) => ({ type, point }),
    CGEventSetIntegerValueField() {},
    CGEventCreateScrollWheelEvent2: () => ({ type: "scroll" }),
    CGEventPost: (_tap: unknown, event: unknown) => events.push(event),
    NSThread: { sleepForTimeInterval() {} },
  });
  const axWindow = {
    position: () => [state.window.x, state.window.y], size: () => [state.window.w, state.window.h], name: () => "Target",
    attributes: { byName: () => ({ set value(_value: boolean) {} }) },
    actions: { byName: () => ({ perform: () => state.onFocus() }) },
  };
  let frontmost = false;
  const process = {
    get frontmost(): boolean | (() => boolean) { return () => frontmost; },
    set frontmost(value: boolean | (() => boolean)) { frontmost = value === true; },
    windows: () => [axWindow],
    attributes: { byName: () => ({ value: () => axWindow }) },
  };
  const globals = {
    $: api,
    ObjC: { import() {}, bindFunction() {}, unwrap: (value: unknown) => value, deepUnwrap: (value: unknown) => value,
      castRefToObject: (value: unknown) => value === nilReference ? nil : cfReferences.has(value) ? { wrapped: value } : value },
    Application: () => ({ processes: { whose: () => () => [process] } }),
    delay() {},
  };
  function geometry(window = true): ComputerCaptureGeometry {
    const first = state.displays[0];
    return {
      bounds: window ? { ...state.window } : { x: first.x, y: first.y, w: first.width, h: first.height },
      displays: state.displays.map((display, i) => ({ ...display, id: i + 1, name: String(display.id), primary: i === 0 })),
    };
  }
  return { state, globals, captures, writes, events, geometry, retained, released, draws, canvases, releasedCanvases, clears,
    files, created, removed, sources, releasedObjects, masks };
}

function capture(request: Partial<ComputerCaptureRequest>, env = nativeEnvironment()) {
  const plan = darwinComputerUse.capturePlan({ path: "/tmp/capture.png", ...request }, {});
  if (typeof plan === "string") throw new Error(plan);
  return { ...env, result: JSON.parse(String(runInNewContext(plan.script!, env.globals))) as ComputerCaptureGeometry };
}

describe("macOS mapped screenshots", () => {
  it("captures a secondary display by its negative global bounds and records physical identity", () => {
    const result = capture({ display: 2 });
    expect(result.captures[0].rect).toEqual({ origin: { x: -1920, y: -100 }, size: { width: 1920, height: 1080 } });
    expect(result.result.bounds).toEqual({ x: -1920, y: -100, w: 1920, h: 1080 });
    expect(result.result.displays.map(display => [display.name, display.scale])).toEqual([["42", 2], ["91", 1]]);
    expect(result.writes[0]).toEqual({ path: "/tmp/capture.png", image: { width: 1920, height: 1080 } });
    expect(result.retained).toEqual(result.released);
  });

  it("composes a region spanning 1x and 2x displays into one point per pixel", () => {
    const result = capture({ region: { x: -250, y: 20, w: 600, h: 300 } });
    expect(result.captures.map(item => item.rect)).toEqual([
      { origin: { x: 0, y: 20 }, size: { width: 350, height: 300 } },
      { origin: { x: -250, y: 20 }, size: { width: 250, height: 300 } },
    ]);
    expect(result.draws).toEqual([
      { destination: { origin: { x: 250, y: 0 }, size: { width: 350, height: 300 } }, image: { width: 700, height: 600 } },
      { destination: { origin: { x: 0, y: 0 }, size: { width: 250, height: 300 } }, image: { width: 250, height: 300 } },
    ]);
    expect(result.result.bounds).toEqual({ x: -250, y: 20, w: 600, h: 300 });
    expect(result.writes[0].image).toEqual({ width: 600, height: 300 });
    expect(result.retained).toEqual(result.released);
    expect(result.canvases).toEqual(result.releasedCanvases);
  });

  it("places displays above the main screen at the top of the output", () => {
    const env = nativeEnvironment();
    env.state.displays[1] = { id: 91, x: 0, y: -1080, width: 1920, height: 1080, scale: 1 };
    const result = capture({ region: { x: 10, y: -100, w: 300, h: 250 } }, env);
    expect(result.captures.map(item => item.rect)).toEqual([
      { origin: { x: 10, y: 0 }, size: { width: 300, height: 150 } },
      { origin: { x: 10, y: -100 }, size: { width: 300, height: 100 } },
    ]);
    expect(result.draws.map(item => item.destination)).toEqual([
      { origin: { x: 0, y: 0 }, size: { width: 300, height: 150 } },
      { origin: { x: 0, y: 150 }, size: { width: 300, height: 100 } },
    ]);
  });

  it("clears display-layout gaps and draws mirror overlaps in deterministic display order", () => {
    const env = nativeEnvironment();
    env.state.displays[1].x = -2020;
    env.state.displays.push({ ...env.state.displays[0], id: 101, scale: 1 });
    const result = capture({ region: { x: -200, y: 20, w: 400, h: 100 } }, env);
    expect(result.clears).toEqual([{ origin: { x: 0, y: 0 }, size: { width: 400, height: 100 } }]);
    expect(result.draws.map(item => item.destination)).toEqual([
      { origin: { x: 200, y: 0 }, size: { width: 200, height: 100 } },
      { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
      { origin: { x: 200, y: 0 }, size: { width: 200, height: 100 } },
    ]);
  });

  it("captures a spanning window at its native raster size without shadow padding", () => {
    const result = capture({ windowId: 9 });
    expect(result.result.bounds).toEqual({ x: -200, y: 30, w: 500, h: 300 });
    expect(result.captures[0]).toEqual({ launchPath: "/usr/sbin/screencapture", argv: ["-x", "-t", "png", "-o", "-l", "9", "/tmp/capture.png"] });
    expect(result.writes[0].image).toEqual({ width: 1000, height: 600 });
  });

  it.each(["move", "resize", "scale", "disconnect", "reorder"])("rejects %s during capture before writing PNG or reporting geometry", mutation => {
    const env = nativeEnvironment();
    env.state.onCapture = () => {
      if (mutation === "move") env.state.window.x += 500;
      if (mutation === "resize") env.state.window.w += 10;
      if (mutation === "scale") env.state.displays[1].scale = 2;
      if (mutation === "disconnect") env.state.displays.pop();
      if (mutation === "reorder") env.state.displays.reverse();
    };
    expect(() => capture({ windowId: 9 }, env)).toThrow("screenshot geometry changed");
    expect(env.writes).toEqual([]);
  });

  it.each([
    ["launchFails", "could not launch native capture"],
    ["nilData", "screencapture did not produce an image"],
    ["emptyData", "screencapture did not produce an image"],
    ["nilSource", "screencapture did not produce a readable image"],
    ["nilImage", "screencapture returned an empty screenshot image"],
    ["emptyImage", "screencapture returned an empty screenshot image"],
    ["nilDestination", "could not open the screenshot PNG destination"],
    ["writeFails", "could not write the screenshot PNG"],
  ] as const)("propagates native %s failures without returning geometry", (failure, message) => {
    const env = nativeEnvironment();
    env.state[failure] = true;
    expect(() => capture({ display: 2 }, env)).toThrow(message);
    if (failure !== "writeFails") expect(env.writes).toEqual([]);
    expect(env.retained).toEqual(env.released);
    expect(env.canvases).toEqual(env.releasedCanvases);
    expect(env.removed).toEqual(["/tmp/capture.png"]);
    expect(env.files.size).toBe(0);
    for (const source of env.sources) expect(env.releasedObjects).toContain(source);
  });

  it("refuses to run the helper when its private intermediate file cannot be created", () => {
    const env = nativeEnvironment();
    env.state.createFails = true;
    expect(() => capture({ windowId: 9 }, env)).toThrow("private screenshot file");
    expect(env.captures).toEqual([]);
    expect(env.writes).toEqual([]);
  });

  it("reports a failing command and removes its intermediate file before decoding", () => {
    const env = nativeEnvironment();
    env.state.commandStatus = 1;
    expect(() => capture({ windowId: 9 }, env)).toThrow("screencapture failed with status 1");
    expect(env.removed).toEqual(["/tmp/capture.png"]);
    expect(env.sources).toEqual([]);
    expect(env.writes).toEqual([]);
  });

  it("creates private files and removes each intermediate before writing the composed image", () => {
    const result = capture({ region: { x: -250, y: 20, w: 600, h: 300 } });
    expect(result.masks).toEqual([0o077]);
    expect(result.created).toEqual(Array.from({ length: 3 }, () => ({ path: "/tmp/capture.png", mode: 0o600 })));
    expect(result.removed).toEqual(["/tmp/capture.png", "/tmp/capture.png"]);
    expect(result.files.size).toBe(0);
    expect(result.releasedObjects).toHaveLength(result.sources.length + 1);
    for (const source of result.sources) expect(result.releasedObjects).toContain(source);
  });

  it("releases earlier tiles and the canvas if a later tile fails", () => {
    const env = nativeEnvironment();
    env.state.onCapture = () => { if (env.captures.length === 2) env.state.commandStatus = 3; };
    expect(() => capture({ region: { x: -250, y: 20, w: 600, h: 300 } }, env)).toThrow("screencapture failed with status 3");
    expect(env.captures).toHaveLength(2);
    expect(env.retained).toEqual(env.released);
    expect(env.canvases).toEqual(env.releasedCanvases);
    expect(env.writes).toEqual([]);
    expect(env.removed).toHaveLength(2);
    expect(env.files.size).toBe(0);
  });

  it("checks topology again after all display tiles have been captured", () => {
    const env = nativeEnvironment();
    env.state.onCapture = () => { if (env.captures.length === 2) env.state.displays[1].scale = 2; };
    expect(() => capture({ region: { x: -250, y: 20, w: 600, h: 300 } }, env)).toThrow("screenshot geometry changed");
    expect(env.captures).toHaveLength(2);
    expect(env.retained).toEqual(env.released);
    expect(env.canvases).toEqual(env.releasedCanvases);
    expect(env.writes).toEqual([]);
  });

  it("refuses a region outside all displays without leaving an allocated canvas", () => {
    const env = nativeEnvironment();
    expect(() => capture({ region: { x: 30000, y: 30000, w: 20, h: 20 } }, env)).toThrow("does not intersect");
    expect(env.canvases).toEqual(env.releasedCanvases);
    expect(env.captures).toEqual([]);
  });

  it("passes a quoted path literally through NSTask arguments without invoking a shell", () => {
    const path = "/tmp/capture 'quoted' \"double\" $(ignored); file.png";
    const result = capture({ windowId: 9, path });
    expect(result.captures).toEqual([{ launchPath: "/usr/sbin/screencapture", argv: ["-x", "-t", "png", "-o", "-l", "9", path] }]);
    expect(result.writes[0].path).toBe(path);
    expect(result.created.every(file => file.path === path && file.mode === 0o600)).toBe(true);
    expect(result.removed).toEqual([path]);
  });

  it("rejects a display removed before capture", () => {
    const env = nativeEnvironment();
    env.state.displays.pop();
    expect(() => capture({ display: 2 }, env)).toThrow("no longer available");
    expect(env.captures).toEqual([]);
  });
});

describe("macOS native bitmap compositor", () => {
  it.skipIf(process.platform !== "darwin")("preserves synthetic tile orientation, mixed resolution and transparent gaps without desktop access", () => {
    const redBlue1x = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAEUlEQVR4nGP4z8AARAz//wMAEfgD/XUCLkgAAAAASUVORK5CYII=";
    const redBlue2x = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAAECAYAAACk7+45AAAAFUlEQVR4nGP4z8DwH4QZ4AwojWAAABcbD/HVzGBuAAAAAElFTkSuQmCC";
    const script = [
      "ObjC.import('Foundation'); ObjC.import('CoreGraphics'); ObjC.import('ImageIO');",
      DARWIN_COMPOSITE_SCRIPT,
      `var encoded = ${JSON.stringify([redBlue1x, redBlue2x])};`,
      "var images = encoded.map(function (base64) {",
      "  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(base64, 0);",
      "  var source = $.CGImageSourceCreateWithData(data, null);",
      "  return $.CGImageSourceCreateImageAtIndex(source, 0, null);",
      "});",
      "var bounds = {x: -2, y: -2, w: 4, h: 4};",
      "var displays = [{x: -2, y: -2, width: 1, height: 2}, {x: 0, y: 0, width: 1, height: 2}];",
      "var image = computerCompositeCapture(bounds, displays, function (rect) { return $.CGImageRetain(images[rect.x < 0 ? 0 : 1]); });",
      "var raw = ObjC.castRefToObject($.CGDataProviderCopyData($.CGImageGetDataProvider(image)));",
      "var png = $.NSMutableData.data;",
      "var destination = $.CGImageDestinationCreateWithData(png, $('public.png'), 1, null);",
      "$.CGImageDestinationAddImage(destination, image, null);",
      "if (!$.CGImageDestinationFinalize(destination)) throw new Error('could not encode the synthetic PNG');",
      "var result = {raw: ObjC.unwrap(raw.base64EncodedStringWithOptions(0)), png: ObjC.unwrap(png.base64EncodedStringWithOptions(0))};",
      "$.CGImageRelease(image); images.forEach(function (source) { $.CGImageRelease(source); });",
      "JSON.stringify(result);",
    ].join("\n");
    const result = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 5000 })) as { raw: string; png: string };
    const raw = Buffer.from(result.raw, "base64");
    const pixel = (x: number, y: number) => [...raw.subarray((y * 4 + x) * 4, (y * 4 + x + 1) * 4)];
    expect(readPngSize(Buffer.from(result.png, "base64"))).toEqual({ width: 4, height: 4 });
    expect(pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(0, 1)).toEqual([0, 0, 255, 255]);
    const scaledRed = pixel(2, 2);
    const scaledBlue = pixel(2, 3);
    expect(scaledRed[0]).toBeGreaterThan(200);
    expect(scaledRed[2]).toBeLessThan(55);
    expect(scaledBlue[0]).toBeLessThan(55);
    expect(scaledBlue[2]).toBeGreaterThan(200);
    expect([scaledRed[1], scaledRed[3], scaledBlue[1], scaledBlue[3]]).toEqual([0, 255, 0, 255]);
    for (const [x, y] of [[1, 0], [3, 0], [0, 2], [1, 2], [3, 3]]) expect(pixel(x, y)).toEqual([0, 0, 0, 0]);
  });
});

describe("macOS screenshot guards", () => {
  const requests: ComputerInputRequest[] = [
    { action: "move", x: -100, y: 60 },
    { action: "click", x: -100, y: 60, button: "left", clicks: 1 },
    { action: "scroll", x: -100, y: 60, direction: "down", amount: 1 },
    { action: "drag", fromX: -100, fromY: 60, toX: 50, toY: 80, durationMs: 100 },
  ];
  function run(request: ComputerInputRequest, env: ReturnType<typeof nativeEnvironment>, guard: ComputerCaptureGuard) {
    const plan = darwinComputerUse.inputPlan({ ...request, captureGuard: guard } as ComputerInputRequest, {});
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.inputGuardFailureMarker).toBe("ROLEBOX_SCREENSHOT_STALE");
    return runInNewContext(plan.script!, env.globals);
  }

  it.each(requests)("delivers $action with matching geometry independent of JSON key order", request => {
    const env = nativeEnvironment();
    const geometry = env.geometry();
    const reordered = { ...geometry, bounds: { h: geometry.bounds.h, w: geometry.bounds.w, y: geometry.bounds.y, x: geometry.bounds.x } };
    run(request, env, { target: { windowId: 9 }, geometry: reordered });
    expect(env.events.length).toBeGreaterThan(0);
  });

  it.each(requests)("blocks $action after window movement, resizing, disappearance or display changes", request => {
    for (const mutation of ["move", "resize", "close", "scale", "disconnect"]) {
      const env = nativeEnvironment();
      const geometry = env.geometry();
      if (mutation === "move") env.state.window.x += 500;
      if (mutation === "resize") env.state.window.w += 10;
      if (mutation === "close") env.state.windowVisible = false;
      if (mutation === "scale") env.state.displays[1].scale = 2;
      if (mutation === "disconnect") env.state.displays.pop();
      expect(() => run(request, env, { target: { windowId: 9 }, geometry })).toThrow("ROLEBOX_SCREENSHOT_STALE");
      expect(env.events).toEqual([]);
    }
  });

  it("checks display changes after focusing the window and before moving the pointer", () => {
    const env = nativeEnvironment();
    const guard = { target: { windowId: 9 }, geometry: env.geometry() };
    env.state.onFocus = () => { env.state.displays[1].x -= 200; };
    expect(() => run({ action: "move", windowId: 9, x: -100, y: 60 }, env, guard)).toThrow("ROLEBOX_SCREENSHOT_STALE");
    expect(env.events).toEqual([]);
  });
});
