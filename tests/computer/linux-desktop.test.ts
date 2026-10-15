/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxComputerUse } from "../../src/computer/drivers/linux.ts";
import type { ComputerInputRequest, ComputerPlan, ComputerPlanOrRefusal } from "../../src/platform/system/types.ts";

const ENV = { XDG_SESSION_TYPE: "x11", DISPLAY: ":7.0" };
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
  writeFileSync(join(directory, "xdotool"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$TRACE"',
    'if [ "$1" = sleep ] && [ "${FAIL_DRAG:-}" = 1 ]; then exit 9; fi',
    'if [ "$1" = getmouselocation ] && [ "${FAIL_ACCESS:-}" = 1 ]; then exit 8; fi',
    'if [ "$1" = getactivewindow ]; then',
    '  if [ "${FAIL_FOCUS:-}" = 1 ]; then exit 8; fi',
    '  printf "%s\\n" "${ACTIVE_WINDOW:-42}"',
    'fi',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(directory, "xdpyinfo"), [
    "#!/bin/sh",
    'printf "%s\\n" "$FAKE_INFO"',
    'exit "${FAKE_EXIT:-0}"',
  ].join("\n"), { mode: 0o700 });
  return { trace, env: { ...ENV, PATH: `${directory}:/usr/bin:/bin`, TRACE: trace } };
}

describe("Linux desktop CUA", () => {
  it("selects an X11 screen on the existing server and preserves remote display names", () => {
    for (const [connection, target] of [[":7.0", ":7.2"], ["localhost:10.1", "localhost:10.2"], ["example.test:3", "example.test:3.2"]]) {
      const built = plan(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", display: 2 }, { ...ENV, DISPLAY: connection }));
      expect(built.script).toContain(`env DISPLAY='${target}' import`);
      expect(built.script).toContain(`env DISPLAY='${target}' scrot`);
    }
    expect(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", display: -1 }, ENV)).toContain("non-negative screen index");
    expect(linuxComputerUse.capturePlan({ path: "/tmp/cua.png", display: 0 }, {})).toContain("valid DISPLAY");
  });

  it.skipIf(process.platform === "win32")("enumerates screen roots as JSON with screenshot-compatible ids", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({ action: "displays" }, ENV));
    const result = spawnSync(built.argv[0], built.argv.slice(1), {
      env: { ...env, FAKE_INFO: "default screen number: 1\nscreen #0:\n  dimensions: 3840x1080 pixels (900x250 millimeters)\nscreen #1:\n  dimensions: 1920x1200 pixels (400x300 millimeters)" },
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 0, x: 0, y: 0, width: 3840, height: 1080, scale: 1, primary: false },
      { id: 1, x: 0, y: 0, width: 1920, height: 1200, scale: 1, primary: true },
    ]);
  });

  it.skipIf(process.platform === "win32")("does not report an empty successful display list after an X server error", () => {
    const { env } = fixture();
    const built = plan(linuxComputerUse.inputPlan({ action: "displays" }, ENV));
    for (const overrides of [{ FAKE_EXIT: "8" }, { FAKE_INFO: "not a display listing" }]) {
      const result = spawnSync(built.argv[0], built.argv.slice(1), { env: { ...env, ...overrides }, encoding: "utf8" });
      expect(result.status).not.toBe(0);
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
    expect(built.argv).toEqual(["xdotool", "mousemove", "--sync", "--", "100", "200", "click", "--window", "42", "1"]);
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
