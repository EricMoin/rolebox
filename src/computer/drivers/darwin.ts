/**
 * macOS computer-use driver — pure plan builders over the two helpers macOS
 * already ships.
 *
 * Capture is `/usr/sbin/screencapture`, whose own flags choose the target:
 * `-l <windowid>` captures exactly one window, `-R x,y,w,h` one rectangle,
 * `-D <display>` one display, and no target flag the whole virtual screen.
 * `-x` suppresses the shutter sound; screencapture leaves the pointer OUT
 * unless `-C` is passed, so every plan here is cursor-free.
 *
 * Input is `/usr/bin/osascript` driving System Events: `click at {x, y}`,
 * `keystroke`, `key code`, and window enumeration. macOS grants that only to a
 * process the user has trusted with Accessibility, which is why every input
 * plan carries {@link ComputerPlan.permissionHint}.
 *
 * Two gestures System Events has no primitive for — moving the pointer, and a
 * right or middle click — are built on the `cliclick` helper rather than faked
 * with a modifier click that means something else. `cliclick` is NOT part of
 * macOS, so those plans name it in `requires` and the executor refuses with the
 * install command when it is absent.
 *
 * Everything here is a pure function of its request: no builder reads this
 * host, so every plan is exercisable anywhere through `setPlatformForTest`.
 */

import type {
  ComputerCaptureRequest,
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
  SupportedComputerUse,
} from "../../platform/system/types.ts";
import { REGION_REFUSAL, usableWindowId, wholeRegion } from "./shared.ts";

const SCREENCAPTURE = "/usr/sbin/screencapture";
const OSASCRIPT = "/usr/bin/osascript";
const CLICLICK = "cliclick";

/** Appended to every failure of a plan that needs a macOS privacy grant. */
const ACCESSIBILITY_HINT =
  "macOS gives input control only to a process the user has trusted with Accessibility permission (System Settings > Privacy & Security > Accessibility); grant it to the terminal or agent process and restart that process.";

const SCREEN_RECORDING_HINT =
  "macOS needs Screen Recording permission for screencapture to include window contents (System Settings > Privacy & Security > Screen Recording); without it the PNG contains only the desktop wallpaper.";

/** Quote one string as an AppleScript literal: backslash and quote escaped. */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** System Events modifier names, keyed by the names a caller may pass. */
const MODIFIERS: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  shift: "shift down",
  alt: "option down",
  option: "option down",
  ctrl: "control down",
  control: "control down",
};

/** macOS virtual key codes for the keys that have no single-character name. */
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  help: 114,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

type KeyPress = { readonly statement: string } | { readonly refusal: string };

/**
 * Turn one key list into the System Events statement that presses it.
 *
 * The list is modifiers first and exactly one final key — `["cmd", "shift",
 * "t"]` — because that is what a keystroke IS; a second normal key is refused
 * rather than serialized into a combination that would type something else.
 */
function keyPress(keys: readonly string[]): KeyPress {
  const parts = keys.map(key => key.trim()).filter(key => key.length > 0);
  if (parts.length === 0) return { refusal: 'computer_key needs at least one key name, such as ["cmd", "shift", "t"].' };

  const final = parts[parts.length - 1];
  const modifiers: string[] = [];
  for (const name of parts.slice(0, -1)) {
    const modifier = MODIFIERS[name.toLowerCase()];
    if (modifier === undefined) {
      return {
        refusal: `"${name}" is not a modifier, and only the last key of a press may be a normal key (modifiers: cmd, shift, alt, ctrl).`,
      };
    }
    modifiers.push(modifier);
  }
  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  const lower = final.toLowerCase();
  const code = KEY_CODES[lower];
  if (code !== undefined) return { statement: `key code ${code}${using}` };
  if (MODIFIERS[lower] !== undefined) {
    return { refusal: `"${final}" is a modifier and cannot be the key of a press; put modifiers first and end with a normal key.` };
  }
  if (final.length === 1) return { statement: `keystroke "${escapeAppleScript(final)}"${using}` };
  return {
    refusal: `macOS has no key named "${final}"; pass a single character or one of ${Object.keys(KEY_CODES).join(", ")}.`,
  };
}

// ── Plans ────────────────────────────────────────────────────────────────────

function osascriptPlan(script: string): ComputerPlan {
  return {
    argv: [OSASCRIPT, "-e", script],
    windowsVerbatimArguments: false,
    script,
    requires: [OSASCRIPT],
    driver: "osascript",
    permissionHint: ACCESSIBILITY_HINT,
  };
}

function cliclickPlan(commands: readonly string[]): ComputerPlan {
  return {
    argv: [CLICLICK, ...commands],
    windowsVerbatimArguments: false,
    requires: [CLICLICK],
    driver: "cliclick",
    permissionHint: ACCESSIBILITY_HINT,
  };
}

/** Why one window cannot be the target of an input gesture on macOS. */
function windowTargetingRefusal(action: string): string {
  return `macOS sends ${action} to the frontmost application, not to a named window; activate the window first (computer_click or the app itself) and call computer_${action} again without window_id.`;
}

function capturePlan(request: ComputerCaptureRequest): ComputerPlanOrRefusal {
  if (request.windowId !== undefined && request.region !== undefined) {
    return "screencapture takes one window (-l) or one region (-R), not both; pass window_id or region.";
  }
  if (request.windowId !== undefined && request.display !== undefined) {
    return "a single-window capture does not select a display; pass window_id or display.";
  }
  const args = ["-x"];
  if (request.windowId !== undefined) {
    if (!usableWindowId(request.windowId)) {
      return "a window id must be a positive whole number (macOS window numbers come from computer_windows).";
    }
    args.push("-l", String(request.windowId));
  } else if (request.region !== undefined) {
    const region = wholeRegion(request.region);
    if (region === null) return REGION_REFUSAL;
    args.push("-R", `${region.x},${region.y},${region.w},${region.h}`);
  }
  if (request.display !== undefined) args.push("-D", String(request.display));
  args.push(request.path);
  return {
    argv: [SCREENCAPTURE, ...args],
    windowsVerbatimArguments: false,
    requires: [SCREENCAPTURE],
    driver: "screencapture",
    permissionHint: SCREEN_RECORDING_HINT,
  };
}

/**
 * The AppleScript that lists one line per visible window: window number, the
 * owning process and the title, tab-separated. The window number is the CGWindow
 * id `screencapture -l` takes, which is why it is read from the AXWindowNumber
 * attribute rather than from System Events' own window index.
 */
function windowListingScript(app: string | null): string {
  const targets =
    app === null
      ? "every application process whose visible is true"
      : `(every application process whose name is "${escapeAppleScript(app)}")`;
  const guard =
    app === null
      ? ""
      : `  if (count of targets) is 0 then error "no running process is named \\"${escapeAppleScript(app)}\\""\n`;
  return [
    'tell application "System Events"',
    '  set out to ""',
    `  set targets to ${targets}`,
    guard.trimEnd(),
    "  repeat with p in targets",
    "    set pname to name of p",
    "    repeat with w in (every window of p)",
    "      set wid to -1",
    "      try",
    '        set wid to value of attribute "AXWindowNumber" of w',
    "      end try",
    "      set out to out & wid & tab & pname & tab & (name of w) & linefeed",
    "    end repeat",
    "  end repeat",
    "  return out",
    "end tell",
  ]
    .filter(line => line.length > 0)
    .join("\n");
}

function inputPlan(request: ComputerInputRequest): ComputerPlanOrRefusal {
  switch (request.action) {
    case "windows": {
      const app = request.app === undefined || request.app.trim().length === 0 ? null : request.app.trim();
      return osascriptPlan(windowListingScript(app));
    }
    case "click": {
      if (request.windowId !== undefined) return windowTargetingRefusal("click");
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "click coordinates must be finite numbers.";
      if (request.button === "left") {
        const click = `  click at {${x}, ${y}}`;
        const statements = request.clicks === 2 ? `${click}\n  delay 0.05\n${click}` : click;
        return osascriptPlan(`tell application "System Events"\n${statements}\nend tell`);
      }
      const command = request.button === "right" ? "rc" : "mc";
      const commands = Array.from({ length: request.clicks }, () => `${command}:${x},${y}`);
      return cliclickPlan(commands);
    }
    case "move": {
      // The move request carries no window: a pointer position is a screen
      // position, and every driver here moves the real cursor.
      const x = Math.round(request.x);
      const y = Math.round(request.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
      return cliclickPlan([`m:${x},${y}`]);
    }
    case "type": {
      if (request.windowId !== undefined) return windowTargetingRefusal("type");
      if (request.text.length === 0) return "computer_type needs non-empty text.";
      const statements: string[] = [];
      for (const [index, line] of request.text.split(/\r\n|\r|\n/).entries()) {
        if (index > 0) statements.push("  key code 36");
        if (line.length > 0) statements.push(`  keystroke "${escapeAppleScript(line)}"`);
      }
      return osascriptPlan(`tell application "System Events"\n${statements.join("\n")}\nend tell`);
    }
    case "key": {
      if (request.windowId !== undefined) return windowTargetingRefusal("key");
      const press = keyPress(request.keys);
      if ("refusal" in press) return press.refusal;
      return osascriptPlan(`tell application "System Events" to ${press.statement}`);
    }
  }
}

/** The macOS computer-use facts, declared once for the darwin descriptor. */
export const darwinComputerUse: SupportedComputerUse = {
  supported: true,
  requiredBinaries: [SCREENCAPTURE, OSASCRIPT, CLICLICK],
  installHint:
    "macOS ships screencapture and osascript at their absolute paths; install the cliclick pointer helper with: brew install cliclick.",
  capturePlan(request) {
    return capturePlan(request);
  },
  inputPlan(request) {
    return inputPlan(request);
  },
  permissionProbe() {
    return osascriptPlan('tell application "System Events" to return UI elements enabled');
  },
};
