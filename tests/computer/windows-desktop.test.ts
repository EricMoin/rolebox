/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { win32ComputerUse } from "../../src/computer/drivers/win32.ts";
import type { ComputerInputRequest, ComputerPlan, ComputerPlanOrRefusal } from "../../src/platform/system/types.ts";

function plan(result: ComputerPlanOrRefusal): ComputerPlan {
  if (typeof result === "string") throw new Error(result);
  return result;
}

describe("Windows desktop CUA", () => {
  it("captures the primary display by default", () => {
    const built = plan(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png" }, {}));
    expect(built.script).toContain("$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds");
    expect(built.script).not.toContain("VirtualScreen");
  });

  it("uses the same physical coordinate space for display discovery, screenshots and gestures", () => {
    const requests = [
      { action: "displays" },
      { action: "move", x: -100, y: 50 },
      { action: "click", x: -100, y: 50, button: "left", clicks: 1 },
      { action: "scroll", direction: "down", amount: 2 },
      { action: "drag", fromX: -100, fromY: 50, toX: 100, toY: 250, durationMs: 200 },
    ] satisfies ComputerInputRequest[];
    const plans = [
      ...requests.map(request => plan(win32ComputerUse.inputPlan(request, {}))),
      ...[{}, { display: 1 }, { windowId: 42 }, { region: { x: -100, y: 0, w: 100, h: 100 } }].map(target => plan(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png", ...target }, {}))),
    ];
    for (const built of plans) {
      expect(built.script).toContain("SetThreadDpiAwarenessContext(new IntPtr(-4))");
      expect(built.script).toContain("[RoleboxDpi]::Enable()");
      const dpiIndex = built.script!.indexOf("[RoleboxDpi]::Enable()");
      for (const operation of ["$screens =", "$bounds =", "::SetCursorPos(", "::GetWindowRect("]) {
        const index = built.script!.indexOf(operation);
        if (index >= 0) expect(dpiIndex).toBeLessThan(index);
      }
    }
  });

  it("returns a JSON array with indices matching screenshot selection and actual monitor scaling", () => {
    const built = plan(win32ComputerUse.inputPlan({ action: "displays" }, {}));
    expect(built.script).toContain("$screens = [System.Windows.Forms.Screen]::AllScreens");
    expect(built.script).toContain("id = $index");
    expect(built.script).toContain("GetScaleFactorForMonitor($monitor, [ref]$scale)");
    expect(built.script).toContain("scale = $scale / 100.0");
    expect(built.script).toContain("ConvertTo-Json -InputObject $displays -Compress");
    expect(built.script).toContain("$displays = @(");
    expect(plan(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png", display: 1 }, {})).script).toContain("$screens[1].Bounds");
    expect(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png", display: -1 }, {})).toContain("non-negative index");
  });

  it("verifies focus after restoring a minimized window", () => {
    const built = plan(win32ComputerUse.inputPlan({ action: "focus", windowId: 1234 }, {}));
    expect(built.script).toContain("$handle = [IntPtr]1234");
    expect(built.script).toContain("IsWindow($handle)");
    expect(built.script).toContain("IsIconic($handle)");
    expect(built.script).toContain("ShowWindowAsync($handle, 9)");
    expect(built.script).toContain("SetForegroundWindow($handle)");
    expect(built.script).toContain("GetForegroundWindow() -ne $handle");
    expect(built.script).toContain("Windows refused foreground activation");
  });

  it("sends signed wheel deltas on the correct axis", () => {
    for (const [direction, flag, delta] of [
      ["up", "0x0800", 360], ["down", "0x0800", -360],
      ["left", "0x01000", -360], ["right", "0x01000", 360],
    ] as const) {
      const built = plan(win32ComputerUse.inputPlan({ action: "scroll", direction, amount: 3 }, {}));
      expect(built.script).toContain(`mouse_event(${flag}, 0, 0, ${delta}, [UIntPtr]::Zero)`);
      expect(built.script).toContain("int data");
    }
    const pointed = plan(win32ComputerUse.inputPlan({ action: "scroll", direction: "down", amount: 1, x: -100.4, y: 50.6 }, {}));
    expect(pointed.script).toContain("SetCursorPos(-100, 51)");
  });

  it("places mouse-down and interpolated drag motion inside a finally-protected release", () => {
    const built = plan(win32ComputerUse.inputPlan({ action: "drag", fromX: -10, fromY: 20, toX: 200, toY: 300, durationMs: 1000 }, {}));
    const script = built.script!;
    const down = script.indexOf("[RoleboxMouse]::mouse_event(0x0002");
    const release = script.indexOf("[RoleboxMouse]::mouse_event(0x0004");
    expect(script.lastIndexOf("try {", down)).toBeGreaterThan(script.indexOf("SetCursorPos(-10, 20)"));
    expect(script.indexOf("} finally {", down)).toBeLessThan(release);
    expect(script).toContain("$step -le 50");
    expect(script).toContain("SetCursorPos($x, $y)");
    expect(script).toContain("throw 'could not move the pointer during drag'");
    expect(built.cleanupPlan?.script).toContain("[RoleboxMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)");
    expect(built.cleanupPlan?.script).not.toContain("::SetCursorPos(");
    expect(built.cleanupPlan?.script).not.toContain("::mouse_event(0x0002");
  });

  it("rejects invalid gestures and chords ending in modifiers before starting PowerShell", () => {
    for (const request of [
      { action: "focus", windowId: -1 },
      { action: "scroll", direction: "up", amount: 0 },
      { action: "scroll", direction: "up", amount: 101 },
      { action: "scroll", direction: "up", amount: 1.5 },
      { action: "scroll", direction: "up", amount: 1, y: 5 },
      { action: "scroll", direction: "up", amount: 1, x: Infinity, y: 5 },
      { action: "drag", fromX: 0, fromY: 0, toX: 10, toY: 10, durationMs: 5001 },
      { action: "drag", fromX: NaN, fromY: 0, toX: 10, toY: 10, durationMs: 200 },
      { action: "key", keys: ["ctrl", "shift"] },
    ] satisfies ComputerInputRequest[]) expect(typeof win32ComputerUse.inputPlan(request, {})).toBe("string");
  });
});
