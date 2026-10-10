/**
 * Linux computer-use driver — X11 only, and honest about it.
 *
 * Capture prefers ImageMagick's `import` (`-window root` for the whole screen,
 * `-window <id>` for one X11 window, `-crop w x h + x + y` for a region) and
 * falls back to `scrot`, which cannot address one window. Both are looked up by
 * the shell script the plan carries, so the plan itself stays a pure value: it
 * names the helpers it will try instead of probing for them here.
 *
 * Input is `xdotool` (XTEST), invoked as argv — no shell, so a typed string
 * cannot be re-parsed as shell syntax.
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
} from "../../platform/system/types.ts";
import { REGION_REFUSAL, shellQuote, usableWindowId, wholeRegion } from "./shared.ts";

const SH = "/bin/sh";
const XDOTOOL = "xdotool";

const CAPTURE_INSTALL_HINT =
  "install ImageMagick (import) or scrot, for example: apt-get install imagemagick scrot, dnf install ImageMagick scrot, or pacman -S imagemagick scrot.";

const XDOTOOL_INSTALL_HINT =
  "install xdotool, for example: apt-get install xdotool, dnf install xdotool, or pacman -S xdotool.";

/** The refusal a Wayland session gets, or `null` on an X11 session. */
function waylandRefusal(env: NodeJS.ProcessEnv): string | null {
  const waylandDisplay = env.WAYLAND_DISPLAY;
  const sessionType = env.XDG_SESSION_TYPE?.toLowerCase();
  const isWayland = sessionType === "wayland" || (waylandDisplay !== undefined && waylandDisplay.length > 0);
  if (!isWayland) return null;
  return "this is a Wayland session, and rolebox's Linux driver drives X11 only (scrot, import and xdotool cannot inject through a Wayland compositor); log in to an X11 session, or run under Xwayland with DISPLAY set so the target windows are X11 clients.";
}

function capturePlan(request: ComputerCaptureRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal {
  const wayland = waylandRefusal(env);
  if (wayland !== null) return wayland;
  if (request.windowId !== undefined && request.region !== undefined) {
    return "an X11 capture takes one window (-window) or one region (-crop), not both; pass window_id or region.";
  }
  const path = shellQuote(request.path);
  const screen = request.display === undefined ? "" : `env DISPLAY=:${request.display} `;

  let script: string;
  if (request.windowId !== undefined) {
    if (!usableWindowId(request.windowId)) {
      return "a window id must be a positive whole number (X11 window ids come from computer_windows).";
    }
    script = [
      "if command -v import >/dev/null 2>&1; then",
      `  exec ${screen}import -window ${request.windowId} ${path}`,
      "fi",
      `echo 'capturing one X11 window needs ImageMagick import; ${CAPTURE_INSTALL_HINT}' >&2`,
      "exit 127",
    ].join("\n");
  } else if (request.region !== undefined) {
    const region = wholeRegion(request.region);
    if (region === null) return REGION_REFUSAL;
    script = [
      "if command -v import >/dev/null 2>&1; then",
      `  exec ${screen}import -window root -crop ${region.w}x${region.h}+${region.x}+${region.y} +repage ${path}`,
      "fi",
      "if command -v scrot >/dev/null 2>&1; then",
      `  exec ${screen}scrot -o -a ${region.x},${region.y},${region.w},${region.h} ${path}`,
      "fi",
      `echo 'no X11 screenshot helper is installed; ${CAPTURE_INSTALL_HINT}' >&2`,
      "exit 127",
    ].join("\n");
  } else {
    script = [
      "if command -v import >/dev/null 2>&1; then",
      `  exec ${screen}import -window root ${path}`,
      "fi",
      "if command -v scrot >/dev/null 2>&1; then",
      `  exec ${screen}scrot -o ${path}`,
      "fi",
      `echo 'no X11 screenshot helper is installed; ${CAPTURE_INSTALL_HINT}' >&2`,
      "exit 127",
    ].join("\n");
  }

  return {
    argv: [SH, "-c", script],
    windowsVerbatimArguments: false,
    script,
    requires: [SH],
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
  if (MODIFIERS[lower] !== undefined && parts.length === 1) {
    return { refusal: `"${final}" is a modifier and cannot be the key of a press; put modifiers first and end with a normal key.` };
  }
  combo.push(KEYSYMS[lower] ?? final);
  return { combo: combo.join("+") };
}

function inputPlan(request: ComputerInputRequest, env: NodeJS.ProcessEnv): ComputerPlanOrRefusal {
  const wayland = waylandRefusal(env);
  if (wayland !== null) return wayland;

  switch (request.action) {
    case "windows": {
      const app = request.app === undefined || request.app.trim().length === 0 ? null : request.app.trim();
      const search = app === null ? "--onlyvisible --name ''" : `--onlyvisible --name ${shellQuote(app)}`;
      // xdotool search prints ids only; the names come from one call per window.
      const script = [
        `ids=$(xdotool search ${search} 2>/dev/null) || ids=''`,
        "for id in $ids; do",
        '  name=$(xdotool getwindowname "$id" 2>/dev/null) || continue',
        `  printf '%s\\t%s\\n' "$id" "$name"`,
        "done",
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
      const argv = [XDOTOOL, "mousemove", "--sync"];
      if (request.windowId !== undefined) {
        if (!usableWindowId(request.windowId)) return "a window id must be a positive whole number.";
        argv.push("--window", String(request.windowId));
      }
      argv.push(String(x), String(y), "click");
      if (request.windowId !== undefined) argv.push("--window", String(request.windowId));
      if (request.clicks === 2) argv.push("--repeat", "2", "--delay", "100");
      argv.push(String(BUTTONS[request.button]));
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "move": {
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
      const argv = [XDOTOOL, "mousemove", "--sync", String(x), String(y)];
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "type": {
      if (request.text.length === 0) return "computer_type needs non-empty text.";
      const argv = [XDOTOOL, "type"];
      if (request.windowId !== undefined) {
        if (!usableWindowId(request.windowId)) return "a window id must be a positive whole number.";
        argv.push("--window", String(request.windowId));
      }
      argv.push("--delay", "12", "--", request.text);
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
    case "key": {
      const combo = keyCombo(request.keys);
      if ("refusal" in combo) return combo.refusal;
      const argv = [XDOTOOL, "key", "--clearmodifiers"];
      if (request.windowId !== undefined) {
        if (!usableWindowId(request.windowId)) return "a window id must be a positive whole number.";
        argv.push("--window", String(request.windowId));
      }
      argv.push(combo.combo);
      return { argv, windowsVerbatimArguments: false, requires: [XDOTOOL], driver: "xdotool" };
    }
  }
}

/** The Linux computer-use facts, declared once for the linux descriptor. */
export const linuxComputerUse: SupportedComputerUse = {
  supported: true,
  requiredBinaries: ["import", "scrot", XDOTOOL],
  installHint: `${CAPTURE_INSTALL_HINT} ${XDOTOOL_INSTALL_HINT}`,
  capturePlan(request, env) {
    return capturePlan(request, env);
  },
  inputPlan(request, env) {
    return inputPlan(request, env);
  },
  permissionProbe() {
    // X11 has no per-application input permission model; what can stop a
    // command here is the session type and a missing helper, so the probe
    // reports both and exits non-zero only when input really cannot run.
    const script = [
      'if [ "${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then',
      "  echo 'Wayland session: rolebox drives X11 only, so input cannot be injected here.' >&2",
      "  exit 3",
      "fi",
      "if ! command -v xdotool >/dev/null 2>&1; then",
      `  echo '${XDOTOOL_INSTALL_HINT}' >&2`,
      "  exit 4",
      "fi",
      "echo 'X11 session: no per-application input permission is required, and xdotool is installed.'",
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
