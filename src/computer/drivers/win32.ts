/**
 * Windows computer-use driver — PowerShell, one script per plan.
 *
 * Capture is System.Drawing: `Screen.PrimaryScreen.Bounds` by default,
 * `Screen.AllScreens[n].Bounds` for one display, an explicit
 * rectangle for a region, and a `GetWindowRect` P/Invoke for one window.
 * `Graphics.CopyFromScreen` writes straight into a bitmap saved as PNG.
 *
 * Input is `System.Windows.Forms`: `Cursor`/`SetCursorPos` + `mouse_event` for
 * pointer moves and clicks, `SendKeys.SendWait` for text and key presses, and
 * `Get-Process` for the window listing (a window id here is the process's
 * `MainWindowHandle`).
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

const DISPLAY_API = [
  "Add-Type @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public struct RoleboxMonitorRect { public int Left; public int Top; public int Right; public int Bottom; }",
  "public class RoleboxDisplayApi {",
  '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RoleboxMonitorRect rect, uint flags);',
  '  [DllImport("shcore.dll")] public static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);',
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

function capturePlan(request: ComputerCaptureRequest): ComputerPlanOrRefusal {
  if (request.display !== undefined && (!Number.isInteger(request.display) || request.display < 0)) {
    return "a Windows display must be a non-negative index from computer_displays.";
  }
  if (request.windowId !== undefined && request.region !== undefined) {
    return "a Windows capture takes one window or one region, not both; pass window_id or region.";
  }
  if (request.windowId !== undefined && request.display !== undefined) {
    return "a single-window capture does not select a display; pass window_id or display.";
  }
  const path = powerShellQuote(request.path);
  const save = [
    "try {",
    "  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "  try {",
    "    $graphics.CopyFromScreen($sourceX, $sourceY, 0, 0, $bitmap.Size)",
    `    $bitmap.Save(${path}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "  } finally { $graphics.Dispose() }",
    "} finally { $bitmap.Dispose() }",
  ];

  if (request.windowId !== undefined) {
    if (!usableWindowId(request.windowId)) {
      return "a window id must be a positive whole number (Windows window ids come from computer_windows).";
    }
    return powerShellPlan(
      [
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        "Add-Type -AssemblyName System.Drawing",
        WINDOW_API,
        "$rect = New-Object RoleboxRect",
        `if (-not [RoleboxWindowApi]::GetWindowRect([IntPtr]${request.windowId}, [ref]$rect)) { Write-Error 'window ${request.windowId} does not exist'; exit 3 }`,
        "$width = $rect.Right - $rect.Left",
        "$height = $rect.Bottom - $rect.Top",
        `if ($width -le 0 -or $height -le 0) { Write-Error 'window ${request.windowId} has an empty rectangle'; exit 3 }`,
        "$sourceX = $rect.Left",
        "$sourceY = $rect.Top",
        "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
        ...save,
      ].join("\n"),
    );
  }

  let source: string[];
  if (request.region !== undefined) {
    const region = wholeRegion(request.region);
    if (region === null) return REGION_REFUSAL;
    source = [
      "$sourceX = " + region.x,
      "$sourceY = " + region.y,
      "$width = " + region.w,
      "$height = " + region.h,
    ];
  } else if (request.display !== undefined) {
    source = [
      "$screens = [System.Windows.Forms.Screen]::AllScreens",
      `if (${request.display} -ge $screens.Count) { Write-Error 'display ${request.display} does not exist; this session has ' + $screens.Count + ' display(s)'; exit 3 }`,
      `$bounds = $screens[${request.display}].Bounds`,
      "$sourceX = $bounds.X",
      "$sourceY = $bounds.Y",
      "$width = $bounds.Width",
      "$height = $bounds.Height",
    ];
  } else {
    source = [
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$sourceX = $bounds.X",
      "$sourceY = $bounds.Y",
      "$width = $bounds.Width",
      "$height = $bounds.Height",
    ];
  }
  return powerShellPlan(
    [
      "$ErrorActionPreference = 'Stop'",
      DPI_API,
      "Add-Type -AssemblyName System.Drawing",
      "Add-Type -AssemblyName System.Windows.Forms",
      ...source,
      "$bitmap = New-Object System.Drawing.Bitmap($width, $height)",
      ...save,
    ].join("\n"),
  );
}

/** Why one window cannot be the target of an input gesture through SendKeys. */
function windowTargetingRefusal(action: string): string {
  return `SendKeys and mouse_event send ${action} to the focused window, not to a named one; bring the window to the foreground and call computer_${action} again without window_id.`;
}

function inputPlan(request: ComputerInputRequest): ComputerPlanOrRefusal {
  switch (request.action) {
    case "displays": {
      return powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        "Add-Type -AssemblyName System.Windows.Forms",
        DISPLAY_API,
        "$screens = [System.Windows.Forms.Screen]::AllScreens",
        "$displays = @(for ($index = 0; $index -lt $screens.Count; $index++) {",
        "  $screen = $screens[$index]",
        "  $bounds = $screen.Bounds",
        "  $rect = New-Object RoleboxMonitorRect",
        "  $rect.Left = $bounds.Left; $rect.Top = $bounds.Top; $rect.Right = $bounds.Right; $rect.Bottom = $bounds.Bottom",
        "  $monitor = [RoleboxDisplayApi]::MonitorFromRect([ref]$rect, 0)",
        "  $scale = 100",
        "  if ($monitor -eq [IntPtr]::Zero -or [RoleboxDisplayApi]::GetScaleFactorForMonitor($monitor, [ref]$scale) -ne 0) { throw 'could not read monitor scale' }",
        "  [PSCustomObject]@{ id = $index; x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height; scale = $scale / 100.0; primary = $screen.Primary }",
        "})",
        "ConvertTo-Json -InputObject $displays -Compress",
      ].join("\n"));
    }
    case "focus": {
      if (!usableWindowId(request.windowId)) return "a window id must be a positive whole number.";
      return powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        WINDOW_API,
        `$handle = [IntPtr]${request.windowId}`,
        "if (-not [RoleboxWindowApi]::IsWindow($handle)) { throw 'window does not exist' }",
        "if ([RoleboxWindowApi]::IsIconic($handle)) { [void][RoleboxWindowApi]::ShowWindowAsync($handle, 9) }",
        "[void][RoleboxWindowApi]::SetForegroundWindow($handle)",
        "for ($attempt = 0; $attempt -lt 20 -and [RoleboxWindowApi]::GetForegroundWindow() -ne $handle; $attempt++) { Start-Sleep -Milliseconds 50 }",
        "if ([RoleboxWindowApi]::GetForegroundWindow() -ne $handle) { throw 'Windows refused foreground activation; select the target window manually and retry' }",
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
      return powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        MOUSE_API,
        ...movement,
        `[RoleboxMouse]::mouse_event(${horizontal ? "0x01000" : "0x0800"}, 0, 0, ${delta}, [UIntPtr]::Zero)`,
      ].join("\n"));
    }
    case "drag": {
      const points = [request.fromX, request.fromY, request.toX, request.toY];
      if (!points.every(Number.isFinite)) return "drag coordinates must be finite numbers.";
      if (!Number.isInteger(request.durationMs) || request.durationMs < 100 || request.durationMs > 5000) return "drag duration must be an integer from 100 to 5000 milliseconds.";
      const [fromX, fromY, toX, toY] = points.map(Math.round);
      const steps = Math.min(100, Math.ceil(request.durationMs / 20));
      const drag = powerShellPlan([
        "$ErrorActionPreference = 'Stop'",
        DPI_API,
        MOUSE_API,
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
      ].join("\n"));
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
          ? "$_.MainWindowHandle -ne 0"
          : `$_.MainWindowHandle -ne 0 -and ($_.ProcessName -like ${powerShellQuote(`*${app}*`)} -or $_.MainWindowTitle -like ${powerShellQuote(`*${app}*`)})`;
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          `Get-Process | Where-Object { ${filter} } | ForEach-Object { @($_.MainWindowHandle, $_.ProcessName, $_.MainWindowTitle) -join ([char]9) }`,
        ].join("\n"),
      );
    }
    case "click": {
      if (request.windowId !== undefined) return windowTargetingRefusal("click");
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
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          DPI_API,
          MOUSE_API,
          `if (-not [RoleboxMouse]::SetCursorPos(${x}, ${y})) { Write-Error 'could not move the pointer to ${x},${y}'; exit 3 }`,
          "Start-Sleep -Milliseconds 40",
          ...clicks,
        ].join("\n"),
      );
    }
    case "move": {
      // The move request carries no window: a pointer position is a screen
      // position, and every driver here moves the real cursor.
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          DPI_API,
          MOUSE_API,
          `if (-not [RoleboxMouse]::SetCursorPos(${x}, ${y})) { Write-Error 'could not move the pointer to ${x},${y}'; exit 3 }`,
        ].join("\n"),
      );
    }
    case "type": {
      if (request.windowId !== undefined) return windowTargetingRefusal("type");
      if (request.text.length === 0) return "computer_type needs non-empty text.";
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.Windows.Forms",
          `[System.Windows.Forms.SendKeys]::SendWait(${powerShellQuote(escapeSendKeys(request.text))})`,
        ].join("\n"),
      );
    }
    case "key": {
      if (request.windowId !== undefined) return windowTargetingRefusal("key");
      const stroke = keyStroke(request.keys);
      if ("refusal" in stroke) return stroke.refusal;
      return powerShellPlan(
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.Windows.Forms",
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
