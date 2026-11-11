/**
 * Linux computer-use driver — X11 only, and honest about it.
 *
 * Capture crops the current root screen to a RandR monitor, window client area
 * or region. Both ImageMagick `import` and the `scrot` fallback use those exact
 * bounds. Geometry is checked before and after capture, and again before input
 * derived from the image.
 *
 * Input is `xdotool` (XTEST). Text uses direct argv; drag uses a numeric-only
 * shell plan so it can release the button if movement fails.
 *
 * A Wayland session is an explicit refusal, not a silent failure: scrot,
 * import and xdotool cannot inject through a Wayland compositor, and rolebox
 * declares no Wayland driver.
 */

import type {
  ComputerCaptureRequest,
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
  SupportedComputerUse,
} from "../../../platform/system/types.ts";
import { shellQuote, usableWindowId } from "../shared.ts";
import { linuxDisplayScript, linuxGeometryJson, linuxGeometryScript, linuxTargetRefusal } from "./geometry.ts";
import {
  LINUX_CAPTURE_GUARD_SCRIPT, LINUX_CAPTURE_SCRIPT, LINUX_DRAG_SCRIPT, LINUX_FOCUS_CHECK_SCRIPT,
  LINUX_LIST_DISPLAYS_SCRIPT, LINUX_PERMISSION_PROBE_SCRIPT, LINUX_WINDOWS_SCRIPT,
} from "./native-scripts.ts";

const SH = "/bin/sh";
const XDOTOOL = "xdotool";

const CAPTURE_INSTALL_HINT =
  "install ImageMagick (import) or scrot, for example: apt-get install imagemagick scrot, dnf install ImageMagick scrot, or pacman -S imagemagick scrot.";

const XDOTOOL_INSTALL_HINT =
  "install xdotool, for example: apt-get install xdotool, dnf install xdotool, or pacman -S xdotool.";

const DISPLAY_INSTALL_HINT =
  "install xrandr with RandR 1.5 support (x11-xserver-utils on Debian/Ubuntu, xrandr on Fedora, or xorg-xrandr on Arch).";

/** The refusal a Wayland session gets, or `null` on an X11 session. */
function waylandRefusal(env: NodeJS.ProcessEnv): string | null {
  const waylandDisplay = env.WAYLAND_DISPLAY;
  const sessionType = env.XDG_SESSION_TYPE?.toLowerCase();
  const isWayland = sessionType === "wayland" || (waylandDisplay !== undefined && waylandDisplay.length > 0);
  if (!isWayland) return null;
  return "this is a Wayland session, and rolebox's Linux driver drives X11 only (scrot, import and xdotool cannot inject through a Wayland compositor); log in to an X11 desktop session. Xwayland does not provide control of the full Wayland desktop.";
}

function capturePlan(request: ComputerCaptureRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal {
  const wayland = waylandRefusal(env);
  if (wayland !== null) return wayland;
  const refusal = linuxTargetRefusal(request);
  if (refusal !== null) return refusal;
  const path = shellQuote(request.path);
  const script = [
    "set -e",
    linuxGeometryScript(request, env),
    `rolebox_capture_path=${path}`,
    `rolebox_capture_install_hint=${shellQuote(CAPTURE_INSTALL_HINT)}`,
    LINUX_CAPTURE_SCRIPT,
  ].join("\n");

  return {
    argv: [SH, "-c", script],
    windowsVerbatimArguments: false,
    script,
    requires: [SH, "xrandr", "awk", ...(request.windowId === undefined ? [] : [XDOTOOL])],
    driver: "import",
  };
}

// ── xdotool input ────────────────────────────────────────────────────────────

/** xdotool button numbers: 1 left, 2 middle, 3 right. */
const BUTTONS: Record<string, number> = { left: 1, middle: 2, right: 3 };

/** X11 keysym names for the keys that are not a single character. */
const KEYSYMS: Record<string, string> = {
  return: "Return",
  enter: "Return",
  tab: "Tab",
  space: "space",
  escape: "Escape",
  esc: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  print: "Print",
  capslock: "Caps_Lock",
  f1: "F1",
  f2: "F2",
  f3: "F3",
  f4: "F4",
  f5: "F5",
  f6: "F6",
  f7: "F7",
  f8: "F8",
  f9: "F9",
  f10: "F10",
  f11: "F11",
  f12: "F12",
};

/** xdotool modifier names, keyed by the names a caller may pass. */
const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "super",
  cmd: "super",
  command: "super",
  super: "super",
  win: "super",
};

type KeyCombo = { readonly combo: string } | { readonly refusal: string };

/** One `xdotool key` combo: modifiers first, exactly one final key. */
function keyCombo(keys: readonly string[]): KeyCombo {
  const parts = keys.map(key => key.trim()).filter(key => key.length > 0);
  if (parts.length === 0) return { refusal: 'computer_key needs at least one key name, such as ["ctrl", "shift", "t"].' };
  const combo: string[] = [];
  for (const name of parts.slice(0, -1)) {
    const modifier = MODIFIERS[name.toLowerCase()];
    if (modifier === undefined) {
      return {
        refusal: `"${name}" is not a modifier, and only the last key of a press may be a normal key (modifiers: ctrl, shift, alt, super).`,
      };
    }
    combo.push(modifier);
  }
  const final = parts[parts.length - 1];
  const lower = final.toLowerCase();
  if (MODIFIERS[lower] !== undefined) {
    return { refusal: `"${final}" is a modifier and cannot be the key of a press; put modifiers first and end with a normal key.` };
  }
  combo.push(KEYSYMS[lower] ?? final);
  return { combo: combo.join("+") };
}

function focusScript(windowId: number): string {
  return [
    "set -e",
    `rolebox_window_id=${windowId}`,
    `xdotool windowactivate --sync ${windowId}`,
    LINUX_FOCUS_CHECK_SCRIPT,
  ].join("\n");
}

function operationPlan(request: ComputerInputRequest): ComputerPlanOrRefusal {
  switch (request.action) {
    case "displays": {
      const script = [
        "set -e",
        linuxDisplayScript(),
        LINUX_LIST_DISPLAYS_SCRIPT,
      ].join("\n");
      return { argv: [SH, "-c", script], script, windowsVerbatimArguments: false, requires: [SH, "xrandr", "awk"], driver: "xdotool" };
    }
    case "focus": {
      if (!usableWindowId(request.windowId)) return "a window id must be a positive whole number.";
      const script = focusScript(request.windowId);
      return {
        argv: [SH, "-c", script],
        script,
        windowsVerbatimArguments: false,
        requires: [SH, XDOTOOL],
        driver: "xdotool",
      };
    }
    case "scroll": {
      if (!Number.isInteger(request.amount) || request.amount < 1 || request.amount > 100) return "scroll amount must be an integer from 1 to 100 wheel ticks.";
      if ((request.x === undefined) !== (request.y === undefined)) return "scroll coordinates x and y must be supplied together.";
      const buttons = { up: 4, down: 5, left: 6, right: 7 };
      const button = buttons[request.direction];
      if (button === undefined) return "scroll direction must be up, down, left or right.";
      const argv = [XDOTOOL];
      if (request.x !== undefined && request.y !== undefined) {
        if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) return "scroll coordinates must be finite numbers.";
        argv.push("mousemove", "--sync", "--", String(Math.round(request.x)), String(Math.round(request.y)));
      }
      argv.push("click", "--repeat", String(request.amount), "--delay", "20", String(button));
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "drag": {
      const points = [request.fromX, request.fromY, request.toX, request.toY];
      if (!points.every(Number.isFinite)) return "drag coordinates must be finite numbers.";
      if (!Number.isInteger(request.durationMs) || request.durationMs < 100 || request.durationMs > 5000) return "drag duration must be an integer from 100 to 5000 milliseconds.";
      const [fromX, fromY, toX, toY] = points.map(Math.round);
      const steps = Math.min(100, Math.ceil(request.durationMs / 20));
      const movement: string[] = [];
      for (let step = 1; step <= steps; step++) {
        movement.push("sleep", String(request.durationMs / steps / 1000), "mousemove", "--", String(Math.round(fromX + (toX - fromX) * step / steps)), String(Math.round(fromY + (toY - fromY) * step / steps)));
      }
      const script = [
        "set -e",
        `xdotool mousemove --sync -- ${fromX} ${fromY}`,
        LINUX_DRAG_SCRIPT,
        `xdotool ${movement.join(" ")}`,
      ].join("\n");
      return {
        argv: [SH, "-c", script], script, windowsVerbatimArguments: false, requires: [SH, XDOTOOL], driver: "xdotool",
        cleanupPlan: { argv: [XDOTOOL, "mouseup", "1"], windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" },
      };
    }
    case "windows": {
      const app = request.app === undefined || request.app.trim().length === 0 ? null : request.app.trim();
      const search = app === null ? "--onlyvisible --name ''" : `--onlyvisible --name ${shellQuote(app)}`;
      // xdotool search prints ids only; the names come from one call per window.
      const script = [
        `ids=$(xdotool search ${search} 2>/dev/null) || ids=''`,
        LINUX_WINDOWS_SCRIPT,
      ].join("\n");
      return {
        argv: [SH, "-c", script],
        windowsVerbatimArguments: false,
        script,
        requires: [SH, XDOTOOL],
        driver: "xdotool",
      };
    }
    case "click": {
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "click coordinates must be finite numbers.";
      const argv = [XDOTOOL, "mousemove", "--sync", "--"];
      argv.push(String(x), String(y), "click");
      if (request.clicks === 2) argv.push("--repeat", "2", "--delay", "100");
      argv.push(String(BUTTONS[request.button]));
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "move": {
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
      const argv = [XDOTOOL, "mousemove", "--sync", "--", String(x), String(y)];
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "type": {
      if (request.text.length === 0) return "computer_type needs non-empty text.";
      const argv = [XDOTOOL, "type"];
      argv.push("--delay", "12", "--", request.text);
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "key": {
      const combo = keyCombo(request.keys);
      if ("refusal" in combo) return combo.refusal;
      const argv = [XDOTOOL, "key", "--clearmodifiers"];
      argv.push(combo.combo);
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
  }
}

function inputPlan(request: ComputerInputRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal {
  const wayland = waylandRefusal(env);
  if (wayland !== null) return wayland;
  const windowId = request.action !== "focus" && "windowId" in request ? request.windowId : undefined;
  if (windowId !== undefined && !usableWindowId(windowId)) return "a window id must be a positive whole number.";
  const plan = operationPlan(request);
  const guard = "captureGuard" in request ? request.captureGuard : undefined;
  if (typeof plan === "string" || (windowId === undefined && guard === undefined)) return plan;
  if (guard !== undefined) {
    const refusal = linuxTargetRefusal(guard.target);
    if (refusal !== null) return refusal;
  }
  const script = [
    windowId === undefined ? "set -e" : focusScript(windowId),
    ...(guard === undefined ? [] : [
      linuxGeometryScript(guard.target, env),
      `rolebox_expected_geometry=${shellQuote(linuxGeometryJson(guard.geometry))}`,
      LINUX_CAPTURE_GUARD_SCRIPT,
    ]),
    'exec "$@"',
  ].join("\n");
  return {
    ...plan,
    ...(guard === undefined ? {} : { inputGuardFailureMarker: "ROLEBOX_SCREENSHOT_STALE" }),
    argv: [SH, "-c", script, "rolebox-computer", ...plan.argv],
    script,
    requires: [...new Set([SH, XDOTOOL, ...plan.requires, ...(guard === undefined ? [] : ["xrandr", "awk"])])],
  };
}

/** The Linux computer-use facts, declared once for the linux descriptor. */
export const linuxComputerUse: SupportedComputerUse = {
  supported: true,
  requiredBinaries: ["import", "scrot", XDOTOOL, "xrandr"],
  installHint: `${CAPTURE_INSTALL_HINT} ${XDOTOOL_INSTALL_HINT} ${DISPLAY_INSTALL_HINT}`,
  capturePlan(request, env) {
    return capturePlan(request, env);
  },
  inputPlan(request, env) {
    return inputPlan(request, env);
  },
  permissionProbe() {
    // A successful exit confirms the X connection, not XTEST or application
    // acceptance. The probe does not inject input while checking access.
    const script = [
      `rolebox_xdotool_install_hint=${shellQuote(XDOTOOL_INSTALL_HINT)}`,
      LINUX_PERMISSION_PROBE_SCRIPT,
    ].join("\n");
    return {
      argv: [SH, "-c", script],
      windowsVerbatimArguments: false,
      script,
      requires: [SH],
      driver: "xdotool",
    };
  },
};
