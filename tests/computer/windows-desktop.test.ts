
import { describe, expect, it } from "vitest";
import { win32ComputerUse } from "../../src/computer/drivers/win32.ts";
import { parseCaptureGeometry } from "../../src/computer/geometry.ts";
import type { ComputerCaptureGuard, ComputerCaptureRequest, ComputerInputRequest, ComputerPlan, ComputerPlanOrRefusal } from "../../src/platform/system/types.ts";

function plan(result: ComputerPlanOrRefusal): ComputerPlan {
  if (typeof result === "string") throw new Error(result);
  return result;
}

describe("Windows desktop CUA", () => {
  it("captures the primary display by default", () => {
    const built = plan(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png" }, {}));
    expect(built.script).toContain("$primary = @($displays | Where-Object { $_.primary })");
    expect(built.script).toContain("x = $display.x; y = $display.y");
    expect(built.script).toContain("$sourceX = $beforeGeometry.bounds.x");
    expect(built.script).toContain("$sourceY = $beforeGeometry.bounds.y");
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
    expect(built.script).toContain("EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero");
    expect(built.script).toContain("id = displays.Count");
    expect(built.script).toContain("GetScaleFactorForMonitor(monitor, out scale)");
    expect(built.script).toContain("scale = scale / 100.0");
    expect(built.script).toContain("name = info.Device");
    expect(built.script).toContain("ConvertTo-Json -InputObject $displays -Compress");
    expect(built.script).toContain("$displays = @(");
    expect(plan(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png", display: 1 }, {})).script).toContain("$display = $displays[1]");
    expect(win32ComputerUse.capturePlan({ path: "C:\\Temp\\cua.png", display: -1 }, {})).toContain("non-negative index");
  });

  const captureTargets: Omit<ComputerCaptureRequest, "path">[] = [
    {},
    { display: 1 },
    { windowId: 42 },
    { region: { x: -100, y: 0, w: 300, h: 200 } },
  ];

  it.each(captureTargets)("only reports capture geometry after a stable successful screenshot (%j)", target => {
    const script = plan(win32ComputerUse.capturePlan({ path: "capture.png", ...target }, {})).script!;
    const before = script.indexOf("$beforeGeometry = Get-RoleboxGeometry");
    const copy = script.indexOf("$graphics.CopyFromScreen($sourceX, $sourceY, 0, 0, $bitmap.Size)");
    const save = script.indexOf("$bitmap.Save(");
    const after = script.indexOf("$afterGeometry = Get-RoleboxGeometry");
    const verify = script.indexOf("Assert-RoleboxGeometry $beforeGeometry $afterGeometry");
    const report = script.indexOf("ConvertTo-Json -InputObject $beforeGeometry -Depth 6 -Compress");
    expect(before).toBeGreaterThan(0);
    expect(copy).toBeGreaterThan(before);
    expect(save).toBeGreaterThan(copy);
    expect(after).toBeGreaterThan(save);
    expect(verify).toBeGreaterThan(after);
    expect(report).toBeGreaterThan(verify);
    expect(script).toContain("$width = $beforeGeometry.bounds.w");
    expect(script).toContain("$height = $beforeGeometry.bounds.h");
    expect(script).toContain("New-Object System.Drawing.Bitmap($width, $height)");
    expect(script).toContain("screenshot geometry changed; take a fresh screenshot");
    expect(script).not.toContain("[System.Windows.Forms.Screen]::AllScreens");
  });

  const captureGuard: ComputerCaptureGuard = {
    target: { windowId: 1234 },
    geometry: {
      bounds: { x: -100, y: 50, w: 500, h: 400 },
      displays: [
        { id: 0, x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, primary: true, name: "Display 1" },
        { id: 1, x: -1920, y: 0, width: 1920, height: 1080, scale: 1, primary: false, name: "Display 2" },
      ],
    },
  };

  const guardedInputs = [
    { action: "click", x: -50, y: 60, button: "left", clicks: 1 },
    { action: "move", x: -50, y: 60 },
    { action: "scroll", direction: "down", amount: 2 },
    { action: "drag", fromX: -50, fromY: 60, toX: 100, toY: 250, durationMs: 200 },
  ] satisfies ComputerInputRequest[];

  it.each(guardedInputs)("checks captured bounds and every display after focus before $action", request => {
    const built = plan(win32ComputerUse.inputPlan({ ...request, windowId: 1234, captureGuard }, {}));
    const script = built.script!;
    const focus = script.indexOf("if ([RoleboxWindowApi]::GetForegroundWindow() -ne $handle)");
    const current = script.indexOf("$currentGeometry = Get-RoleboxGeometry");
    const verify = script.indexOf("Assert-RoleboxGeometry $expectedGeometry $currentGeometry");
    const input = script.search(/\[RoleboxMouse\]::(?:SetCursorPos|mouse_event)\(/);
    expect(focus).toBeGreaterThan(0);
    expect(current).toBeGreaterThan(focus);
    expect(verify).toBeGreaterThan(current);
    expect(input).toBeGreaterThan(verify);
    expect(script).toContain("GetWindowRect([IntPtr]1234, [ref]$rect)");
    expect(script).toContain("@('x', 'y', 'w', 'h')");
    expect(script).toContain("$expected.displays.Count -ne $actual.displays.Count");
    expect(script).toContain("@('id', 'x', 'y', 'width', 'height', 'scale', 'primary', 'name')");
    expect(script).toContain(JSON.stringify(captureGuard.geometry));
    expect(script).toContain("} catch { throw 'ROLEBOX_SCREENSHOT_STALE: screenshot geometry changed; take a fresh screenshot' }");
    expect(built.inputGuardFailureMarker).toBe("ROLEBOX_SCREENSHOT_STALE");
    expect(script.match(/public class RoleboxWindowApi/g)).toHaveLength(1);
    if (built.cleanupPlan !== undefined) {
      expect(built.cleanupPlan.script).not.toContain("Get-RoleboxGeometry");
      expect(built.cleanupPlan.script).not.toContain("SetForegroundWindow");
    }
  });

  it("compares named geometry fields after parsing JSON with a different property order", () => {
    const nativeGeometry = {
      displays: captureGuard.geometry.displays.map(display => ({ name: display.name, primary: display.primary, scale: display.scale,
        height: display.height, width: display.width, y: display.y, x: display.x, id: display.id })),
      bounds: { h: 400, w: 500, y: 50, x: -100 },
    };
    const parsedGeometry = parseCaptureGeometry(JSON.stringify(nativeGeometry));
    expect(JSON.stringify(parsedGeometry)).not.toBe(JSON.stringify(nativeGeometry));
    expect(parsedGeometry).toEqual(captureGuard.geometry);
    const script = plan(win32ComputerUse.inputPlan({ action: "move", x: 10, y: 20,
      captureGuard: { ...captureGuard, geometry: parsedGeometry } }, {})).script!;
    expect(script).toContain("$expected.bounds.$field -ne $actual.bounds.$field");
    expect(script).toContain("$expected.displays[$index].$field -cne $actual.displays[$index].$field");
    expect(script).not.toContain("ConvertTo-Json");
  });

  it.each(captureTargets)("uses the capture target's geometry when guarding without a focus target (%j)", target => {
    const script = plan(win32ComputerUse.inputPlan({ action: "move", x: 10, y: 20, captureGuard: { ...captureGuard, target } }, {})).script!;
    expect(script).toContain("Assert-RoleboxGeometry $expectedGeometry $currentGeometry");
    expect(script).not.toContain("SetForegroundWindow($handle)");
    if (target.windowId !== undefined) expect(script).toContain("GetWindowRect([IntPtr]42, [ref]$rect)");
    if (target.region !== undefined) expect(script).toContain("$bounds = [ordered]@{ x = -100; y = 0; w = 300; h = 200 }");
    if (target.display !== undefined) expect(script).toContain("$display = $displays[1]");
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

  it("enumerates each visible top-level window independently of its owning process", () => {
    const built = plan(win32ComputerUse.inputPlan({ action: "windows" }, {}));
    expect(built.script).toContain("EnumWindows(delegate(IntPtr handle, IntPtr data)");
    expect(built.script).toContain("if (IsWindowVisible(handle)) windows.Add(handle)");
    expect(built.script).toContain("foreach ($handle in [RoleboxWindowList]::VisibleWindows())");
    expect(built.script).toContain("GetWindowThreadProcessId($handle, [ref]$ownerId)");
    expect(built.script).toContain("GetWindowText($handle, $titleBuffer, $titleBuffer.Capacity)");
    expect(built.script).toContain("@($handle.ToInt64(), $ownerName, $title) -join ([char]9)");
    expect(built.script).not.toContain("MainWindowHandle");
    expect(built.script).not.toContain("MainWindowTitle");

    const filtered = plan(win32ComputerUse.inputPlan({ action: "windows", app: "Example's editor" }, {}));
    expect(filtered.script).toContain("$ownerName -like '*Example''s editor*' -or $title -like '*Example''s editor*'");
  });

  const targetedInputs = [
    { action: "click", x: -100, y: 50, button: "left", clicks: 1 },
    { action: "move", x: -100, y: 50 },
    { action: "type", text: "target window" },
    { action: "key", keys: ["ctrl", "a"] },
    { action: "scroll", direction: "down", amount: 2, x: -100, y: 50 },
    { action: "drag", fromX: -100, fromY: 50, toX: 100, toY: 250, durationMs: 200 },
  ] satisfies ComputerInputRequest[];

  it.each(targetedInputs)("focuses and verifies the requested window before $action", request => {
    const built = plan(win32ComputerUse.inputPlan({ ...request, windowId: 1234 }, {}));
    const script = built.script!;
    expect(script).toContain("$handle = [IntPtr]1234");
    const exists = script.indexOf("if (-not [RoleboxWindowApi]::IsWindow($handle)) { throw 'window does not exist' }");
    const activate = script.indexOf("[void][RoleboxWindowApi]::SetForegroundWindow($handle)");
    const verify = script.indexOf("if ([RoleboxWindowApi]::GetForegroundWindow() -ne $handle) { throw 'Windows refused foreground activation");
    expect(exists).toBeGreaterThan(0);
    expect(activate).toBeGreaterThan(exists);
    expect(verify).toBeGreaterThan(activate);
    const input = request.action === "key" || request.action === "type"
      ? script.indexOf("[System.Windows.Forms.SendKeys]::SendWait(")
      : script.indexOf("[RoleboxMouse]::SetCursorPos(");
    expect(input).toBeGreaterThan(verify);
    expect(built.argv.at(-1)).toBe(script);
    if (request.action === "drag") {
      expect(built.cleanupPlan?.script).not.toContain("SetForegroundWindow");
      expect(built.cleanupPlan?.script).toContain("[RoleboxMouse]::mouse_event(0x0004");
    }

    const untargeted = plan(win32ComputerUse.inputPlan(request, {}));
    expect(untargeted.script).not.toContain("SetForegroundWindow");
  });

  it("rejects invalid window targets on every input action before building a command", () => {
    for (const request of targetedInputs) {
      for (const windowId of [0, -1, 1.5, NaN, Infinity]) {
        expect(win32ComputerUse.inputPlan({ ...request, windowId }, {})).toContain("positive whole number");
      }
    }
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
