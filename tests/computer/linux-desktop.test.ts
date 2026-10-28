
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxComputerUse } from "../../src/computer/drivers/linux.ts";
import type { ComputerCaptureGeometry, ComputerInputRequest, ComputerPlan, ComputerPlanOrRefusal } from "../../src/platform/system/types.ts";

const ENV = { XDG_SESSION_TYPE: "x11", DISPLAY: ":7.0" };
const MONITORS = "Monitors: 2\n 0: +HDMI-1 1920/500x1080/300+0+0  HDMI-1\n 1: +*DP-1 2560/600x1440/340+1920+0  DP-1";
const ROOT_INFO = "Screen 0: minimum 8 x 8, current 4480 x 1440, maximum 32767 x 32767";
const WINDOW_INFO = "WINDOW=42\nX=2000\nY=100\nWIDTH=800\nHEIGHT=600\nSCREEN=0";
const DISPLAYS = [
  { id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: false, name: "HDMI-1" },
  { id: 1, x: 1920, y: 0, width: 2560, height: 1440, scale: 1, primary: true, name: "DP-1" },
];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function plan(result: ComputerPlanOrRefusal): ComputerPlan {
  if (typeof result === "string") throw new Error(result);
  return result;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rolebox-x11-plan-"));
  directories.push(directory);
  const trace = join(directory, "trace");
  const geometryTrace = join(directory, "geometry-trace");
  writeFileSync(join(directory, "xdotool"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$TRACE"',
    'if [ "$1" = windowactivate ] && [ "${FAIL_ACTIVATE:-}" = 1 ]; then exit 7; fi',
    'if [ "$1" = windowactivate ]; then : > "$FOCUSED"; fi',
    'if [ "$1" = sleep ] && [ "${FAIL_DRAG:-}" = 1 ]; then exit 9; fi',
    'if [ "$1" = getmouselocation ] && [ "${FAIL_ACCESS:-}" = 1 ]; then exit 8; fi',
    'if [ "$1" = getactivewindow ]; then',
    '  if [ "${FAIL_FOCUS:-}" = 1 ]; then exit 8; fi',
    '  printf "%s\\n" "${ACTIVE_WINDOW:-42}"',
    'fi',
    'if [ "$1" = getwindowgeometry ]; then',
    '  if [ -f "$CAPTURED" ] && [ -n "${AFTER_WINDOW_INFO:-}" ]; then printf "%s\\n" "$AFTER_WINDOW_INFO";',
    '  elif [ -f "$FOCUSED" ] && [ -n "${FOCUS_WINDOW_INFO:-}" ]; then printf "%s\\n" "$FOCUS_WINDOW_INFO";',
    '  else printf "%s\\n" "$WINDOW_INFO"; fi',
    'fi',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(directory, "xrandr"), [
    "#!/bin/sh",
    'printf "xrandr %s DISPLAY=%s\\n" "$*" "$DISPLAY" >> "$GEOMETRY_TRACE"',
    'if [ "${FAKE_EXIT:-0}" != 0 ]; then exit "$FAKE_EXIT"; fi',
    'if [ "$1" = --listactivemonitors ]; then',
    '  if [ -f "$CAPTURED" ] && [ -n "${AFTER_MONITORS:-}" ]; then printf "%s\\n" "$AFTER_MONITORS";',
    '  else printf "%s\\n" "$MONITOR_INFO"; fi',
    'elif [ "$1" = --current ]; then printf "%s\\n" "$ROOT_INFO";',
    'else exit 9; fi',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(directory, "import"), [
    "#!/bin/sh",
    'printf "import %s DISPLAY=%s\\n" "$*" "$DISPLAY" >> "$GEOMETRY_TRACE"',
    ': > "$CAPTURED"',
  ].join("\n"), { mode: 0o700 });
  return { trace, geometryTrace, env: {
    ...ENV, PATH: `${directory}:/usr/bin:/bin`, TRACE: trace, GEOMETRY_TRACE: geometryTrace,
    CAPTURED: join(directory, "captured"), FOCUSED: join(directory, "focused"),
    MONITOR_INFO: MONITORS, ROOT_INFO, WINDOW_INFO,
  } };
}

describe("Linux desktop CUA", () => {
  it.skipIf(process.platform === "win32")("captures actual monitors on the current X screen and defaults to the primary monitor", () => {
    for (const display of [undefined, 0, 1]) {
      const { env, geometryTrace } = fixture();
      const built = plan(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", display }, ENV));
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const selected = DISPLAYS[display ?? 1];
      expect(JSON.parse(result.stdout)).toEqual({
        bounds: { x: selected.x, y: selected.y, w: selected.width, h: selected.height }, displays: DISPLAYS,
      });
      expect(readFileSync(geometryTrace, "utf8")).toContain(`import -window root -crop ${selected.width}x${selected.height}+${selected.x}+${selected.y} +repage /tmp/cua.png DISPLAY=:7.0`);
    }
    expect(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", display: -1 }, ENV)).toContain("non-negative monitor id");
  });

  it.skipIf(process.platform === "win32")("enumerates RandR monitor bounds, primary flag and names with screenshot-compatible ids", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({ action: "displays" }, ENV));
    const result = spawnSync(built.argv[0], built.argv.slice(1), {
      env,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(DISPLAYS);
  });

  it.skipIf(process.platform === "win32")("does not report an empty successful display list after an X server error", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({ action: "displays" }, ENV));
    for (const overrides of [{ FAKE_EXIT: "8" }, { MONITOR_INFO: "not a display listing" }, { MONITOR_INFO: "Monitors: 0" }]) {
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
      expect(result.status).not.toBe(0);
    }
  });

  it.skipIf(process.platform === "win32")("preserves signed monitor origins and safely serializes monitor names", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({ action: "displays" }, ENV));
    const result = spawnSync(built.argv[0], built.argv.slice(1), {
      env: { ...env, MONITOR_INFO: 'Monitors: 1\n 0: +*Panel "test"\\name 1920/500x1080/300-1920+100  HDMI-1' }, encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 0, x: -1920, y: 100, width: 1920, height: 1080, scale: 1, primary: true, name: 'Panel "test"\\name' },
    ]);
  });

  it.skipIf(process.platform === "win32")("captures exact window and spanning-region bounds without changing the X screen", () => {
    for (const [target, bounds] of [
      [{ windowId: 42 }, { x: 2000, y: 100, w: 800, h: 600 }],
      [{ region: { x: 1800, y: 1000, w: 500, h: 300 } }, { x: 1800, y: 1000, w: 500, h: 300 }],
    ] as const) {
      const { env, geometryTrace } = fixture();
      const built = plan(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", ...target }, ENV));
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ bounds, displays: DISPLAYS });
      expect(readFileSync(geometryTrace, "utf8")).toContain(`import -window root -crop ${bounds.w}x${bounds.h}+${bounds.x}+${bounds.y}`);
    }
  });

  it.skipIf(process.platform === "win32")("rejects absent monitors, offscreen bounds and windows on another X screen before capture", () => {
    for (const [target, overrides] of [
      [{ display: 99 }, {}],
      [{ region: { x: -1, y: 0, w: 100, h: 100 } }, {}],
      [{ region: { x: 4400, y: 0, w: 100, h: 100 } }, {}],
      [{ windowId: 42 }, { WINDOW_INFO: WINDOW_INFO.replace("SCREEN=0", "SCREEN=1") }],
      [{ windowId: 42 }, { WINDOW_INFO: WINDOW_INFO.replace("X=2000", "X=-10") }],
      [{ windowId: 42 }, { WINDOW_INFO: "WINDOW=42\nX=1\nY=2\nWIDTH=5" }],
    ] as const) {
      const { env, geometryTrace } = fixture();
      const built = plan(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", ...target }, ENV));
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(readFileSync(geometryTrace, "utf8")).not.toContain("import ");
    }
  });

  it.skipIf(process.platform === "win32")("rejects captures when the source window or display layout changes during capture", () => {
    for (const overrides of [
      { AFTER_WINDOW_INFO: WINDOW_INFO.replace("X=2000", "X=2100") },
      { AFTER_MONITORS: MONITORS.replace("2560/600x1440", "2500/600x1440") },
    ]) {
      const { env } = fixture();
      const built = plan(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", windowId: 42 }, ENV));
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("screenshot geometry changed; take a fresh screenshot");
    }
  });

  it("focuses a window and generates vertical and horizontal wheel gestures", () => {
    expect(plan(linuxComputerUse.inputPlan({ action: "focus", windowId: 42 }, ENV)).script).toContain("xdotool windowactivate --sync 42");
    for (const [direction, button] of [["up", "4"], ["down", "5"], ["left", "6"], ["right", "7"]] as const) {
      expect(plan(linuxComputerUse.inputPlan({ action: "scroll", direction, amount: 3 }, ENV)).argv).toEqual(["xdotool", "click", "--repeat", "3", "--delay", "20", button]);
    }
    expect(plan(linuxComputerUse.inputPlan({ action: "scroll", direction: "down", amount: 1, x: 10.4, y: 20.8 }, ENV)).argv.slice(0, 6)).toEqual(["xdotool", "mousemove", "--sync", "--", "10", "21"]);
  });

  it.skipIf(process.platform === "win32")("verifies the active window even when activation reports success", () => {
    const built = plan(linuxComputerUse.inputPlan({ action: "focus", windowId: 42 }, ENV));
    for (const [overrides, status] of [[{}, 0], [{ ACTIVE_WINDOW: "99" }, 3], [{ FAIL_FOCUS: "1" }, 3]] as const) {
      const { env, trace } = fixture();
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
      expect(result.status).toBe(status);
      expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(["windowactivate --sync 42", "getactivewindow"]);
      if (status !== 0) expect(result.stderr).toMatch(/could not verify|refused foreground activation/);
    }
  });

  it("keeps window-targeted click coordinates absolute", () => {
    const built = plan(linuxComputerUse.inputPlan({ action: "click", x: 100, y: 200, button: "left", clicks: 1, windowId: 42 }, ENV));
    expect(built.argv.slice(4)).toEqual(["xdotool", "mousemove", "--sync", "--", "100", "200", "click", "1"]);
    expect(built.script).toContain("xdotool windowactivate --sync 42");
    expect(built.script).toContain('exec "$@"');
  });

  const targetedInputs = [
    { action: "click", x: -100, y: 200, button: "right", clicks: 2 },
    { action: "move", x: -100, y: 200 },
    { action: "type", text: "literal $(exit 17) 'quoted' `exit 18`" },
    { action: "key", keys: ["ctrl", "t"] },
    { action: "scroll", direction: "down", amount: 2, x: -100, y: 200 },
    { action: "drag", fromX: -100, fromY: 200, toX: 100, toY: 300, durationMs: 200 },
  ] satisfies ComputerInputRequest[];

  it.skipIf(process.platform === "win32")("validates screenshot geometry after focus before each pointer gesture", () => {
    const geometry: ComputerCaptureGeometry = {
      displays: DISPLAYS.map(display => ({
        name: display.name, primary: display.primary, scale: display.scale, height: display.height,
        width: display.width, y: display.y, x: display.x, id: display.id,
      })),
      bounds: { h: 600, w: 800, y: 100, x: 2000 },
    };
    for (const request of targetedInputs) {
      if (request.action === "type" || request.action === "key") continue;
      for (const changed of [false, true]) {
        const { env, trace } = fixture();
        const built = plan(linuxComputerUse.inputPlan({ ...request, windowId: 42, captureGuard: { target: { windowId: 42 }, geometry } }, ENV));
        expect(built.inputGuardFailureMarker).toBe("ROLEBOX_SCREENSHOT_STALE");
        const result = spawnSync(built.argv[0], built.argv.slice(1), {
          env: { ...env, ...(changed ? { FOCUS_WINDOW_INFO: WINDOW_INFO.replace("X=2000", "X=2100") } : {}) }, encoding: "utf8",
        });
        const calls = readFileSync(trace, "utf8").trim().split("\n");
        expect(calls.slice(0, 3)).toEqual(["windowactivate --sync 42", "getactivewindow", "getwindowgeometry --shell 42"]);
        if (changed) {
          expect(result.status).toBe(3);
          expect(result.stderr).toContain("screenshot geometry changed; take a fresh screenshot");
          expect(result.stderr).toContain("ROLEBOX_SCREENSHOT_STALE");
          expect(calls).toHaveLength(3);
        } else {
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          expect(calls.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it.skipIf(process.platform === "win32")("refuses a guarded gesture when another monitor changes even if target bounds stay the same", () => {
    const { env, geometryTrace } = fixture();
    const built = plan(linuxComputerUse.inputPlan({
      action: "click", x: 20, y: 30, button: "left", clicks: 1,
      captureGuard: { target: { display: 0 }, geometry: { bounds: { x: 0, y: 0, w: 1920, h: 1080 }, displays: DISPLAYS } },
    }, ENV));
    const result = spawnSync(built.argv[0], built.argv.slice(1), {
      env: { ...env, MONITOR_INFO: MONITORS.replace("2560/600x1440", "2500/600x1440") }, encoding: "utf8",
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("screenshot geometry changed; take a fresh screenshot");
    expect(readFileSync(geometryTrace, "utf8")).toContain("xrandr --listactivemonitors");
  });

  it.skipIf(process.platform === "win32")("marks failed geometry queries as a pre-input refusal", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({
      action: "move", x: 20, y: 30,
      captureGuard: { target: { display: 0 }, geometry: { bounds: { x: 0, y: 0, w: 1920, h: 1080 }, displays: DISPLAYS } },
    }, ENV));
    const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, FAKE_EXIT: "8" }, encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("ROLEBOX_SCREENSHOT_STALE: screenshot geometry changed; take a fresh screenshot");
  });

  it.skipIf(process.platform === "win32")("focuses and verifies each requested window before every targeted input", () => {
    for (const request of targetedInputs) {
      for (const windowId of [42, 99]) {
        const built = plan(linuxComputerUse.inputPlan({ ...request, windowId }, ENV));
        const { env, trace } = fixture();
        const result = spawnSync(built.argv[0], built.argv.slice(1), {
          env: { ...env, ACTIVE_WINDOW: String(windowId) }, encoding: "utf8",
        });
        expect(result.status).toBe(0);
        const calls = readFileSync(trace, "utf8").trim().split("\n");
        expect(calls.slice(0, 2)).toEqual([`windowactivate --sync ${windowId}`, "getactivewindow"]);
        expect(calls.length).toBeGreaterThan(2);
        expect(calls.slice(2).join("\n")).not.toContain("--window");
        if (request.action === "type") expect(calls[2]).toBe(`type --delay 12 -- ${request.text}`);
        if (request.action === "drag") expect(calls.at(-1)).toBe("mouseup 1");
      }
    }
  });

  it.skipIf(process.platform === "win32")("sends no input when a target is missing, activation is refused or focus cannot be verified", () => {
    for (const request of targetedInputs) {
      const built = plan(linuxComputerUse.inputPlan({ ...request, windowId: 42 }, ENV));
      for (const [overrides, status, calls] of [
        [{ FAIL_ACTIVATE: "1" }, 7, ["windowactivate --sync 42"]],
        [{ ACTIVE_WINDOW: "99" }, 3, ["windowactivate --sync 42", "getactivewindow"]],
        [{ FAIL_FOCUS: "1" }, 3, ["windowactivate --sync 42", "getactivewindow"]],
      ] as const) {
        const { env, trace } = fixture();
        const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
        expect(result.status).toBe(status);
        expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(calls);
      }
    }
  });

  it("rejects invalid window ids on every targeted input", () => {
    for (const request of targetedInputs) {
      for (const windowId of [0, -1, 1.5, NaN, Infinity]) {
        expect(linuxComputerUse.inputPlan({ ...request, windowId }, ENV)).toContain("positive whole number");
      }
    }
  });

  it("terminates option parsing before negative coordinates throughout command chains", () => {
    for (const request of [
      { action: "move", x: -100, y: -200 },
      { action: "click", x: -100, y: -200, button: "left", clicks: 1 },
      { action: "scroll", direction: "down", amount: 2, x: -100, y: -200 },
    ] satisfies ComputerInputRequest[]) {
      const built = plan(linuxComputerUse.inputPlan(request, ENV));
      expect(built.argv.slice(0, 6)).toEqual(["xdotool", "mousemove", "--sync", "--", "-100", "-200"]);
      if (request.action !== "move") expect(built.argv[6]).toBe("click");
    }
    const drag = plan(linuxComputerUse.inputPlan({ action: "drag", fromX: -100, fromY: -200, toX: -50, toY: -100, durationMs: 200 }, ENV));
    const movements = [...drag.script!.matchAll(/mousemove(?: --sync)? -- (-?\d+) (-?\d+)/g)];
    expect(movements).toHaveLength(11);
    expect(movements[0].slice(1)).toEqual(["-100", "-200"]);
    expect(movements.at(-1)!.slice(1)).toEqual(["-50", "-100"]);
  });

  it.skipIf(process.platform === "win32")("releases the drag button after both successful motion and a helper failure", () => {
    const built = plan(linuxComputerUse.inputPlan({ action: "drag", fromX: 5, fromY: 8, toX: 105, toY: 208, durationMs: 200 }, ENV));
    expect(built.cleanupPlan?.argv).toEqual(["xdotool", "mouseup", "1"]);
    for (const failure of [false, true]) {
      const { env, trace } = fixture();
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, FAIL_DRAG: failure ? "1" : "0" }, encoding: "utf8" });
      expect(result.status).toBe(failure ? 9 : 0);
      const calls = readFileSync(trace, "utf8").trim().split("\n");
      expect(calls[0]).toBe("mousemove --sync -- 5 8");
      expect(calls[1]).toBe("mousedown 1");
      expect(calls[2]).toEndWith("mousemove -- 105 208");
      expect(calls.at(-1)).toBe("mouseup 1");
    }
  });

  it.skipIf(process.platform === "win32")("checks actual X server access and rejects Wayland before input discovery", () => {
    const built = plan(linuxComputerUse.permissionProbe());
    const { env, trace } = fixture();
    const denied = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, FAIL_ACCESS: "1" }, encoding: "utf8" });
    expect(denied.status).toBe(6);
    expect(denied.stderr).toContain("cannot access the X server");
    expect(readFileSync(trace, "utf8")).toBe("getmouselocation\n");
    const allowed = spawnSync(built.argv[0], built.argv.slice(1), { env, encoding: "utf8" });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("xdotool can access the X server");
    const missing = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, DISPLAY: "" }, encoding: "utf8" });
    expect(missing.status).toBe(5);
    const wayland = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, XDG_SESSION_TYPE: "Wayland" }, encoding: "utf8" });
    expect(wayland.status).toBe(3);
  });

  it("rejects malformed gestures, modifier-only chords and Wayland for every new operation", () => {
    const invalid: ComputerInputRequest[] = [
      { action: "focus", windowId: 0 },
      { action: "scroll", direction: "down", amount: 0 },
      { action: "scroll", direction: "down", amount: 101 },
      { action: "scroll", direction: "down", amount: 1.5 },
      { action: "scroll", direction: "down", amount: 1, x: 5 },
      { action: "scroll", direction: "down", amount: 1, x: 5, y: NaN },
      { action: "drag", fromX: 0, fromY: 0, toX: 5, toY: 5, durationMs: 99 },
      { action: "drag", fromX: 0, fromY: 0, toX: Infinity, toY: 5, durationMs: 200 },
      { action: "key", keys: ["ctrl", "shift"] },
    ];
    for (const request of invalid) expect(typeof linuxComputerUse.inputPlan(request, ENV)).toBe("string");
    for (const request of [
      { action: "displays" }, { action: "focus", windowId: 42 },
      { action: "scroll", direction: "down", amount: 1 },
      { action: "drag", fromX: 0, fromY: 0, toX: 5, toY: 5, durationMs: 200 },
    ] satisfies ComputerInputRequest[]) {
      expect(linuxComputerUse.inputPlan(request, { ...ENV, WAYLAND_DISPLAY: "wayland-0" })).toContain("Wayland session");
    }
  });
});
