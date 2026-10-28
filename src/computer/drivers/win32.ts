/**
 * Windows computer-use driver — PowerShell, one script per plan.
 *
 * Capture is System.Drawing: native monitor bounds by default or display index,
 * an explicit rectangle for a region, and `GetWindowRect` for one window.
 * `Graphics.CopyFromScreen` writes straight into a bitmap saved as PNG.
 *
 * Input is `System.Windows.Forms`: `Cursor`/`SetCursorPos` + `mouse_event` for
 * pointer moves and clicks, `SendKeys.SendWait` for text and key presses, and
 * `EnumWindows` for the window listing (each top-level window has its own
 * HWND, including multiple windows owned by the same process).
 *
 * PowerShell is not part of every Windows install rolebox runs on, and UIPI
 * still blocks synthetic input aimed at an elevated window, so the plan names
 * `powershell` in `requires` and the executor refuses with a remediation when
 * it is missing.
 *
 * Every script is a pure function of its request — the only host fact a builder
 * touches is the environment it was handed.
 */

import type {
  ComputerCaptureGuard,
  ComputerCaptureRequest,
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
  SupportedComputerUse,
} from "../../platform/system/types.ts";
import { REGION_REFUSAL, powerShellQuote, usableWindowId, wholeRegion } from "./shared.ts";

const POWERSHELL = "powershell";

const INSTALL_HINT =
  "Windows PowerShell (powershell.exe) ships with Windows; if it was removed, install it from Microsoft, or run rolebox on a host that has it.";

const DPI_API = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class RoleboxDpi {",
  '  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);',
  '  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);',
  '  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] static extern bool IsProcessDPIAware();',
  "  public static void Enable() {",
  "    try {",
  "      if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;",
  "      if (SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero) return;",
  '      throw new InvalidOperationException("could not enable per-monitor DPI awareness");',
  "    } catch (EntryPointNotFoundException) { }",
  "    try {",
  "      if (SetProcessDpiAwareness(2) == 0) return;",
  '      throw new InvalidOperationException("could not enable per-monitor DPI awareness");',
  "    } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }",
  '    if (!SetProcessDPIAware() && !IsProcessDPIAware()) throw new InvalidOperationException("could not enable DPI awareness");',
  "  }",
  "}",
  "'@",
  "[RoleboxDpi]::Enable()",
].join("\n");

/** The P/Invoke block the mouse plans compile once per run. */
const MOUSE_API = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class RoleboxMouse {",
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);',
  "}",
  "'@",
].join("\n");

/** The P/Invoke block the single-window capture compiles once per run. */
const WINDOW_API = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public struct RoleboxRect { public int Left; public int Top; public int Right; public int Bottom; }",
  "public class RoleboxWindowApi {",
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RoleboxRect rect);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  "}",
  "'@",
].join("\n");

const WINDOW_LIST_API = [
  "Add-Type @'",
  "using System;",
  "using System.Collections.Generic;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "public class RoleboxWindowList {",
  "  private delegate bool EnumWindowsProc(IntPtr handle, IntPtr data);",
  '  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);',
  '  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int capacity);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);',
  "  public static IntPtr[] VisibleWindows() {",
  "    var windows = new List<IntPtr>();",
  "    if (!EnumWindows(delegate(IntPtr handle, IntPtr data) {",
  "      if (IsWindowVisible(handle)) windows.Add(handle);",
  "      return true;",
  '    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "could not enumerate desktop windows");',
  "    return windows.ToArray();",
  "  }",
  "}",
  "'@",
].join("\n");

// Use AllScreens' enumeration order without its cache when checking topology twice.
const DISPLAY_API = [
  "Add-Type @'",
  "using System;",
  "using System.Collections.Generic;",
  "using System.Runtime.InteropServices;",
  "public struct RoleboxMonitorRect { public int Left; public int Top; public int Right; public int Bottom; }",
  "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "public struct RoleboxMonitorInfo {",
  "  public int Size; public RoleboxMonitorRect Monitor; public RoleboxMonitorRect Work; public uint Flags;",
  "  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;",
  "}",
  "public class RoleboxDisplay {",
  "  public int id; public int x; public int y; public int width; public int height;",
  "  public double scale; public bool primary; public string name;",
  "}",
  "public class RoleboxDisplayApi {",
  "  private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);",
  '  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr data);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref RoleboxMonitorInfo info);',
  '  [DllImport("shcore.dll")] private static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);',
  "  public static RoleboxDisplay[] Snapshot() {",
  "    var monitors = new List<IntPtr>();",
  "    if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data) {",
  "      monitors.Add(monitor); return true;",
  '    }, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "could not enumerate displays");',
  "    var displays = new List<RoleboxDisplay>();",
  "    foreach (var monitor in monitors) {",
  "      var info = new RoleboxMonitorInfo(); info.Size = Marshal.SizeOf(typeof(RoleboxMonitorInfo));",
  '      if (!GetMonitorInfo(monitor, ref info)) throw new InvalidOperationException("could not read monitor bounds");',
  "      int scale;",
  '      if (GetScaleFactorForMonitor(monitor, out scale) != 0 || scale <= 0) throw new InvalidOperationException("could not read monitor scale");',
  "      var bounds = info.Monitor;",
  '      if (bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) throw new InvalidOperationException("display has empty bounds");',
  "      displays.Add(new RoleboxDisplay { id = displays.Count, x = bounds.Left, y = bounds.Top,",
  "        width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top,",
  "        scale = scale / 100.0, primary = (info.Flags & 1) != 0, name = info.Device });",
  "    }",
  '    if (displays.Count == 0) throw new InvalidOperationException("no displays are available");',
  "    return displays.ToArray();",
  "  }",
  "}",
  "'@",
].join("\n");

/** mouse_event flag pairs: left, right, middle down/up. */
const BUTTON_FLAGS: Record<string, { down: string; up: string }> = {
  left: { down: "0x0002", up: "0x0004" },
  right: { down: "0x0008", up: "0x0010" },
  middle: { down: "0x0020", up: "0x0040" },
};

/** SendKeys tokens for the keys that are not a single character. */
const SEND_KEYS: Record<string, string> = {
  return: "{ENTER}",
  enter: "{ENTER}",
  tab: "{TAB}",
  space: " ",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DEL}",
  insert: "{INSERT}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  f1: "{F1}",
  f2: "{F2}",
  f3: "{F3}",
  f4: "{F4}",
  f5: "{F5}",
  f6: "{F6}",
  f7: "{F7}",
  f8: "{F8}",
  f9: "{F9}",
  f10: "{F10}",
  f11: "{F11}",
  f12: "{F12}",
};

/** SendKeys modifier prefixes, keyed by the names a caller may pass. */
const SEND_MODIFIERS: Record<string, string> = {
  ctrl: "^",
  control: "^",
  shift: "+",
  alt: "%",
  option: "%",
};

/** Key names that mean the Windows key, which SendKeys cannot send at all. */
const WINDOWS_KEY_NAMES = ["win", "meta", "cmd", "command", "super"];

/** Characters SendKeys reads as syntax, written the way it wants them literal. */
const SEND_ESCAPES: Record<string, string> = {
  "+": "{+}",
  "^": "{^}",
  "%": "{%}",
  "~": "{~}",
  "(": "{(}",
  ")": "{)}",
  "[": "{[}",
  "]": "{]}",
  "{": "{{}",
  "}": "{}}",
};

/**
 * Escape text for `SendKeys.SendWait`: the characters SendKeys treats as
 * syntax become brace groups, and a newline (which SendKeys cannot type
 * literally) becomes the ENTER key.
 */
export function escapeSendKeys(text: string): string {
  let escaped = "";
  for (const character of text) {
    if (character === "\r") continue;
    if (character === "\n") {
      escaped += "{ENTER}";
    } else if (character === "\t") {
      escaped += "{TAB}";
    } else {
      escaped += SEND_ESCAPES[character] ?? character;
    }
  }
  return escaped;
}

type KeyStroke = { readonly stroke: string } | { readonly refusal: string };

/** The Windows key has no SendKeys token, as a modifier or as the key. */
function windowsKeyRefusal(name: string): string {
  return `SendKeys cannot synthesize the Windows key ("${name}"); use ctrl, shift or alt, or perform the action inside the application.`;
}

/** One SendKeys stroke: modifiers first, exactly one final key. */
function keyStroke(keys: readonly string[]): KeyStroke {
  const parts = keys.map(key => key.trim()).filter(key => key.length > 0);
  if (parts.length === 0) return { refusal: 'computer_key needs at least one key name, such as ["ctrl", "shift", "t"].' };
  const stroke: string[] = [];
  for (const name of parts.slice(0, -1)) {
    const lower = name.toLowerCase();
    if (WINDOWS_KEY_NAMES.includes(lower)) return { refusal: windowsKeyRefusal(name) };
    const modifier = SEND_MODIFIERS[lower];
    if (modifier === undefined) {
      return {
        refusal: `"${name}" is not a modifier, and only the last key of a press may be a normal key (modifiers: ctrl, shift, alt).`,
      };
    }
    stroke.push(modifier);
  }
  const final = parts[parts.length - 1];
  const lower = final.toLowerCase();
  if (SEND_MODIFIERS[lower] !== undefined) {
    return { refusal: `"${final}" is a modifier and cannot be the key of a press; put modifiers first and end with a normal key.` };
  }
  const named = SEND_KEYS[lower];
  if (named !== undefined) {
    stroke.push(named);
  } else if (WINDOWS_KEY_NAMES.includes(lower)) {
    return { refusal: windowsKeyRefusal(final) };
  } else if ([...final].length === 1) {
    stroke.push(escapeSendKeys(final));
  } else {
    return {
      refusal: `Windows has no key named "${final}"; pass a single character or one of ${Object.keys(SEND_KEYS).join(", ")}.`,
    };
  }
  return { stroke: stroke.join("") };
}

// ── Plans ────────────────────────────────────────────────────────────────────

function powerShellPlan(script: string): ComputerPlan {
  return {
    argv: [POWERSHELL, "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    windowsVerbatimArguments: false,
    script,
    requires: [POWERSHELL],
    driver: "powershell",
  };
}

const GEOMETRY_CHANGED = "screenshot geometry changed; take a fresh screenshot";
const INPUT_GUARD_FAILURE_MARKER = "ROLEBOX_SCREENSHOT_STALE";

function pointerPlan(script: string, guard: ComputerCaptureGuard | undefined): ComputerPlan {
  return { ...powerShellPlan(script), ...(guard === undefined ? {} : { inputGuardFailureMarker: INPUT_GUARD_FAILURE_MARKER }) };
}

type CaptureTarget = Omit<ComputerCaptureRequest, "path">;

function captureTargetRefusal(target: CaptureTarget): string | undefined {
  if (target.display !== undefined && (!Number.isInteger(target.display) || target.display < 0)) {
    return "a Windows display must be a non-negative index from computer_displays.";
  }
  if ([target.windowId, target.region, target.display].filter(value => value !== undefined).length > 1) {
    return "a Windows capture takes one window, region or display, not both; pass only one target.";
  }
  if (target.windowId !== undefined && !usableWindowId(target.windowId)) {
    return "a window id must be a positive whole number (Windows window ids come from computer_windows).";
  }
  if (target.region !== undefined && wholeRegion(target.region) === null) return REGION_REFUSAL;
}

function geometryStatements(target: CaptureTarget, windowApiInstalled = false): string[] {
  let bounds: string[];
  if (target.windowId !== undefined) {
    bounds = [
      "$rect = New-Object RoleboxRect",
      `if (-not [RoleboxWindowApi]::GetWindowRect([IntPtr]${target.windowId}, [ref]$rect)) { throw 'window ${target.windowId} does not exist' }`,
      "$bounds = [ordered]@{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }",
    ];
  } else if (target.region !== undefined) {
    const region = wholeRegion(target.region)!;
    bounds = [`$bounds = [ordered]@{ x = ${region.x}; y = ${region.y}; w = ${region.w}; h = ${region.h} }`];
  } else {
    bounds = target.display === undefined ? [
      "$primary = @($displays | Where-Object { $_.primary })",
      "if ($primary.Count -ne 1) { throw 'could not identify the primary display' }",
      "$display = $primary[0]",
    ] : [
      `if (${target.display} -ge $displays.Count) { throw 'display ${target.display} does not exist' }`,
      `$display = $displays[${target.display}]`,
    ];
    bounds.push("$bounds = [ordered]@{ x = $display.x; y = $display.y; w = $display.width; h = $display.height }");
  }
  return [
    DISPLAY_API,
    ...(target.windowId !== undefined && !windowApiInstalled ? [WINDOW_API] : []),
    "function Get-RoleboxGeometry {",
    "  $displays = @([RoleboxDisplayApi]::Snapshot())",
    ...bounds,
    "  if ($bounds.w -le 0 -or $bounds.h -le 0) { throw 'capture target has empty bounds' }",
    "  return [PSCustomObject]@{ bounds = [PSCustomObject]$bounds; displays = $displays }",
    "}",
    "function Assert-RoleboxGeometry($expected, $actual) {",
    "  foreach ($field in @('x', 'y', 'w', 'h')) {",
    `    if ($expected.bounds.$field -ne $actual.bounds.$field) { throw '${GEOMETRY_CHANGED}' }`,
    "  }",
    `  if ($expected.displays.Count -ne $actual.displays.Count) { throw '${GEOMETRY_CHANGED}' }`,
    "  for ($index = 0; $index -lt $expected.displays.Count; $index++) {",
    "    foreach ($field in @('id', 'x', 'y', 'width', 'height', 'scale', 'primary', 'name')) {",
    `      if ($expected.displays[$index].$field -cne $actual.displays[$index].$field) { throw '${GEOMETRY_CHANGED}' }`,
    "    }",
    "  }",
    "}",
  ];
}

function captureGuardStatements(guard: ComputerCaptureGuard | undefined, windowApiInstalled: boolean): string[] {
  if (guard === undefined) return [];
  return [
    ...geometryStatements(guard.target, windowApiInstalled),
    `$expectedGeometry = ConvertFrom-Json -InputObject ${powerShellQuote(JSON.stringify(guard.geometry))}`,
    "try {",
    "  $currentGeometry = Get-RoleboxGeometry",
    "  Assert-RoleboxGeometry $expectedGeometry $currentGeometry",
    `} catch { throw '${INPUT_GUARD_FAILURE_MARKER}: ${GEOMETRY_CHANGED}' }`,
  ];
}

function capturePlan(request: ComputerCaptureRequest): ComputerPlanOrRefusal {
  const refusal = captureTargetRefusal(request);
  if (refusal !== undefined) return refusal;
  const path = powerShellQuote(request.path);
  return powerShellPlan([
    "$ErrorActionPreference = 'Stop'",
    DPI_API,
    "Add-Type -AssemblyName System.Drawing",
    ...geometryStatements(request),
    "$beforeGeometry = Get-RoleboxGeometry",
    "$sourceX = $beforeGeometry.bounds.x",
    "$sourceY = $beforeGeometry.bounds.y",
    "$width = $beforeGeometry.bounds.w",
    "$height = $beforeGeometry.bounds.h",
    "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
    "try {",
    "  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "  try {",
    "    $graphics.CopyFromScreen($sourceX, $sourceY, 0, 0, $bitmap.Size)",
    `    $bitmap.Save(${path}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "  } finally { $graphics.Dispose() }",
    "} finally { $bitmap.Dispose() }",
    "try {",
    "  $afterGeometry = Get-RoleboxGeometry",
    "  Assert-RoleboxGeometry $beforeGeometry $afterGeometry",
    `} catch { throw '${GEOMETRY_CHANGED}' }`,
    "ConvertTo-Json -InputObject $beforeGeometry -Depth 6 -Compress",
  ].join("\n"));
}

function focusStatements(windowId: number | undefined): string[] {
  if (windowId === undefined) return [];
  return [
    WINDOW_API,
    `$handle = [IntPtr]${windowId}`,
    "if (-not [RoleboxWindowApi]::IsWindow($handle)) { throw 'window does not exist' }",
    "if ([RoleboxWindowApi]::IsIconic($handle)) { [void][RoleboxWindowApi]::ShowWindowAsync($handle, 9) }",
    "[void][RoleboxWindowApi]::SetForegroundWindow($handle)",
    "for ($attempt = 0; $attempt -lt 20 -and [RoleboxWindowApi]::GetForegroundWindow() -ne $handle; $attempt++) { Start-Sleep -Milliseconds 50 }",
    "if ([RoleboxWindowApi]::GetForegroundWindow() -ne $handle) { throw 'Windows refused foreground activation; select the target window manually and retry' }",
  ];
}

function inputPlan(request: ComputerInputRequest): ComputerPlanOrRefusal {
  if ("windowId" in request && request.windowId !== undefined && !usableWindowId(request.windowId)) {
    return "a window id must be a positive whole number.";
  }
  const captureGuard = "captureGuard" in request ? request.captureGuard : undefined;
  if (captureGuard !== undefined) {
    const refusal = captureTargetRefusal(captureGuard.target);
    if (refusal !== undefined) return refusal;
  }
  switch (request.action) {
    case "displays": {
      return powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        DISPLAY_API,
        "$displays = @([RoleboxDisplayApi]::Snapshot())",
        "ConvertTo-Json -InputObject $displays -Compress",
      ].join("\n"));
    }
    case "focus": {
      return powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        ...focusStatements(request.windowId),
      ].join("\n"));
    }
    case "scroll": {
      if (!Number.isInteger(request.amount) || request.amount < 1 || request.amount > 100) return "scroll amount must be an integer from 1 to 100 wheel ticks.";
      if ((request.x === undefined) !== (request.y === undefined)) return "scroll coordinates x and y must be supplied together.";
      if (!["up", "down", "left", "right"].includes(request.direction)) return "scroll direction must be up, down, left or right.";
      const movement: string[] = [];
      if (request.x !== undefined && request.y !== undefined) {
        if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) return "scroll coordinates must be finite numbers.";
        movement.push(`if (-not [RoleboxMouse]::SetCursorPos(${Math.round(request.x)}, ${Math.round(request.y)})) { throw 'could not move the pointer' }`);
      }
      const horizontal = request.direction === "left" || request.direction === "right";
      const delta = request.amount * 120 * (request.direction === "down" || request.direction === "left" ? -1 : 1);
      return pointerPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        MOUSE_API,
        ...focusStatements(request.windowId),
        ...captureGuardStatements(request.captureGuard, request.windowId !== undefined),
        ...movement,
        `[RoleboxMouse]::mouse_event(${horizontal ? "0x01000" : "0x0800"}, 0, 0, ${delta}, [UIntPtr]::Zero)`,
      ].join("\n"), request.captureGuard);
    }
    case "drag": {
      const points = [request.fromX, request.fromY, request.toX, request.toY];
      if (!points.every(Number.isFinite)) return "drag coordinates must be finite numbers.";
      if (!Number.isInteger(request.durationMs) || request.durationMs < 100 || request.durationMs > 5000) return "drag duration must be an integer from 100 to 5000 milliseconds.";
      const [fromX, fromY, toX, toY] = points.map(Math.round);
      const steps = Math.min(100, Math.ceil(request.durationMs / 20));
      const drag = pointerPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        MOUSE_API,
        ...focusStatements(request.windowId),
        ...captureGuardStatements(request.captureGuard, request.windowId !== undefined),
        `if (-not [RoleboxMouse]::SetCursorPos(${fromX}, ${fromY})) { throw 'could not move the pointer to the drag origin' }`,
        "try {",
        "  [RoleboxMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
        `  for ($step = 1; $step -le ${steps}; $step++) {`,
        `    Start-Sleep -Milliseconds ${Math.round(request.durationMs / steps)}`,
        `    $x = [int][Math]::Round(${fromX} + (${toX} - ${fromX}) * $step / ${steps})`,
        `    $y = [int][Math]::Round(${fromY} + (${toY} - ${fromY}) * $step / ${steps})`,
        "    if (-not [RoleboxMouse]::SetCursorPos($x, $y)) { throw 'could not move the pointer during drag' }",
        "  }",
        "} finally {",
        "  [RoleboxMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
        "}",
      ].join("\n"), request.captureGuard);
      return {
        ...drag,
        cleanupPlan: powerShellPlan([
          "$ErrorActionPreference = 'Stop'", MOUSE_API,
          "[RoleboxMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
        ].join("\n")),
      };
    }
    case "windows": {
      const app = request.app === undefined || request.app.trim().length === 0 ? null : request.app.trim();
      const filter =
        app === null
          ? "$true"
          : `$ownerName -like ${powerShellQuote(`*${app}*`)} -or $title -like ${powerShellQuote(`*${app}*`)}`;
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          WINDOW_LIST_API,
          "foreach ($handle in [RoleboxWindowList]::VisibleWindows()) {",
          "  $ownerId = [uint32]0",
          "  [void][RoleboxWindowList]::GetWindowThreadProcessId($handle, [ref]$ownerId)",
          "  $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue",
          "  $ownerName = if ($null -eq $owner) { '' } else { $owner.ProcessName }",
          "  $titleBuffer = New-Object System.Text.StringBuilder(32768)",
          "  [void][RoleboxWindowList]::GetWindowText($handle, $titleBuffer, $titleBuffer.Capacity)",
          "  $title = $titleBuffer.ToString()",
          `  if (${filter}) { @($handle.ToInt64(), $ownerName, $title) -join ([char]9) }`,
          "}",
        ].join("\n"),
      );
    }
    case "click": {
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "click coordinates must be finite numbers.";
      const flags = BUTTON_FLAGS[request.button];
      const press = [
        `[RoleboxMouse]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)`,
        "Start-Sleep -Milliseconds 30",
        `[RoleboxMouse]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)`,
      ];
      const clicks = request.clicks === 2 ? [...press, "Start-Sleep -Milliseconds 40", ...press] : press;
      return pointerPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          DPI_API,
          MOUSE_API,
          ...focusStatements(request.windowId),
          ...captureGuardStatements(request.captureGuard, request.windowId !== undefined),
          `if (-not [RoleboxMouse]::SetCursorPos(${x}, ${y})) { Write-Error 'could not move the pointer to ${x},${y}'; exit 3 }`,
          "Start-Sleep -Milliseconds 40",
          ...clicks,
        ].join("\n"),
        request.captureGuard,
      );
    }
    case "move": {
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
      return pointerPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          DPI_API,
          MOUSE_API,
          ...focusStatements(request.windowId),
          ...captureGuardStatements(request.captureGuard, request.windowId !== undefined),
          `if (-not [RoleboxMouse]::SetCursorPos(${x}, ${y})) { Write-Error 'could not move the pointer to ${x},${y}'; exit 3 }`,
        ].join("\n"),
        request.captureGuard,
      );
    }
    case "type": {
      if (request.text.length === 0) return "computer_type needs non-empty text.";
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.Windows.Forms",
          ...focusStatements(request.windowId),
          `[System.Windows.Forms.SendKeys]::SendWait(${powerShellQuote(escapeSendKeys(request.text))})`,
        ].join("\n"),
      );
    }
    case "key": {
      const stroke = keyStroke(request.keys);
      if ("refusal" in stroke) return stroke.refusal;
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.Windows.Forms",
          ...focusStatements(request.windowId),
          `[System.Windows.Forms.SendKeys]::SendWait(${powerShellQuote(stroke.stroke)})`,
        ].join("\n"),
      );
    }
  }
}

/** The Windows computer-use facts, declared once for the win32 descriptor. */
export const win32ComputerUse: SupportedComputerUse = {
  supported: true,
  requiredBinaries: [POWERSHELL],
  installHint: INSTALL_HINT,
  capturePlan(request) {
    return capturePlan(request);
  },
  inputPlan(request) {
    return inputPlan(request);
  },
  permissionProbe() {
    // There is no requestable per-application grant here: a successful exit IS
    // the grant, so `readsProbeOutput` stays absent and the printed sentence is
    // prose for the caller, never a permission token.
    return powerShellPlan(
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) { Write-Error 'this Windows session is not interactive, so no window can receive input'; exit 3 }",
        "'Windows input needs no per-application permission grant; this session is interactive and SendKeys is available.'",
      ].join("\n"),
    );
  },
};
