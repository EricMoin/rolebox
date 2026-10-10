/// <reference types="bun-types" />

/**
 * Per-OS computer-use plan builders.
 *
 * Every assertion below is about a plan built for a NAMED system, never about
 * this host: the builders are pure, so darwin, linux and win32 plans are all
 * exercised on whatever machine runs the suite. No plan is executed here.
 */

import { describe, expect, it } from "bun:test";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import { linuxComputerUse } from "../../src/computer/drivers/linux.ts";
import { unsupportedComputerUse } from "../../src/computer/drivers/unsupported.ts";
import { win32ComputerUse } from "../../src/computer/drivers/win32.ts";
import type {
  ComputerCaptureRequest,
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
} from "../../src/platform/system/types.ts";

const CAPTURE: ComputerCaptureRequest = { path: "/tmp/rolebox-shot.png" };
const LINUX_ENV: NodeJS.ProcessEnv = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

function planOf(built: ComputerPlanOrRefusal): ComputerPlan {
  if (typeof built === "string") throw new Error(`expected a plan, got the refusal: ${built}`);
  return built;
}

function refusalOf(built: ComputerPlanOrRefusal): string {
  if (typeof built !== "string") throw new Error(`expected a refusal, got the plan: ${built.argv.join(" ")}`);
  return built;
}

// ── darwin ───────────────────────────────────────────────────────────────────

describe("darwin computer-use plans", () => {
  it("captures the whole screen cursor-free with screencapture", () => {
    const plan = planOf(darwinComputerUse.capturePlan(CAPTURE, {}));
    expect(plan.argv).toEqual(["/usr/sbin/screencapture", "-x", CAPTURE.path]);
    expect(plan.driver).toBe("screencapture");
    expect(plan.requires).toEqual(["/usr/sbin/screencapture"]);
    expect(plan.script).toBeUndefined();
    expect(plan.permissionHint).toContain("Screen Recording");
  });

  it("captures one window, one region or one display with the OS's own flags", () => {
    expect(planOf(darwinComputerUse.capturePlan({ ...CAPTURE, windowId: 12345 }, {})).argv).toEqual([
      "/usr/sbin/screencapture", "-x", "-l", "12345", CAPTURE.path,
    ]);
    expect(planOf(darwinComputerUse.capturePlan({ ...CAPTURE, region: { x: 10, y: 20, w: 300, h: 200 } }, {})).argv).toEqual([
      "/usr/sbin/screencapture", "-x", "-R", "10,20,300,200", CAPTURE.path,
    ]);
    expect(planOf(darwinComputerUse.capturePlan({ ...CAPTURE, display: 1 }, {})).argv).toEqual([
      "/usr/sbin/screencapture", "-x", "-D", "1", CAPTURE.path,
    ]);
  });

  it("rounds a region to whole pixels and refuses a degenerate one", () => {
    expect(planOf(darwinComputerUse.capturePlan({ ...CAPTURE, region: { x: 10.4, y: 20.6, w: 300.2, h: 200.7 } }, {})).argv).toContain("10,21,300,201");
    expect(refusalOf(darwinComputerUse.capturePlan({ ...CAPTURE, region: { x: 0, y: 0, w: 0, h: 10 } }, {}))).toContain("at least one pixel");
  });

  it("refuses two capture targets at once instead of picking one", () => {
    const refusal = refusalOf(darwinComputerUse.capturePlan({ ...CAPTURE, windowId: 7, region: { x: 0, y: 0, w: 5, h: 5 } }, {}));
    expect(refusal).toContain("not both");
    expect(refusalOf(darwinComputerUse.capturePlan({ ...CAPTURE, windowId: 7, display: 1 }, {}))).toContain("does not select a display");
    expect(refusalOf(darwinComputerUse.capturePlan({ ...CAPTURE, windowId: -3 }, {}))).toContain("positive whole number");
  });

  it("clicks through System Events and moves/right-clicks through cliclick", () => {
    const click: ComputerInputRequest = { action: "click", x: 100, y: 200, button: "left", clicks: 1 };
    const left = planOf(darwinComputerUse.inputPlan(click, {}));
    expect(left.argv[0]).toBe("/usr/bin/osascript");
    expect(left.script).toContain("click at {100, 200}");
    expect(left.driver).toBe("osascript");

    const double = planOf(darwinComputerUse.inputPlan({ ...click, clicks: 2 }, {}));
    expect(double.script?.match(/click at \{100, 200\}/g)?.length).toBe(2);

    const right = planOf(darwinComputerUse.inputPlan({ ...click, button: "right" }, {}));
    expect(right.argv).toEqual(["cliclick", "rc:100,200"]);
    expect(right.requires).toEqual(["cliclick"]);

    const middle = planOf(darwinComputerUse.inputPlan({ ...click, button: "middle", clicks: 2 }, {}));
    expect(middle.argv).toEqual(["cliclick", "mc:100,200", "mc:100,200"]);

    const move = planOf(darwinComputerUse.inputPlan({ action: "move", x: 4, y: 5 }, {}));
    expect(move.argv).toEqual(["cliclick", "m:4,5"]);
  });

  it("refuses a window-targeted gesture, naming the frontmost-window rule", () => {
    for (const request of [
      { action: "click", x: 1, y: 2, button: "left", clicks: 1, windowId: 9 },
      { action: "type", text: "hi", windowId: 9 },
      { action: "key", keys: ["Return"], windowId: 9 },
    ] satisfies ComputerInputRequest[]) {
      const refusal = refusalOf(darwinComputerUse.inputPlan(request, {}));
      expect(refusal).toContain("frontmost application");
      expect(refusal).toContain(`computer_${request.action}`);
    }
  });

  it("types text as keystrokes, escaping AppleScript and pressing Return for newlines", () => {
    const plan = planOf(darwinComputerUse.inputPlan({ action: "type", text: 'a"b\\c\nd' }, {}));
    expect(plan.script).toContain('keystroke "a\\"b\\\\c"');
    expect(plan.script).toContain("key code 36");
    expect(plan.script).toContain('keystroke "d"');
    expect(refusalOf(darwinComputerUse.inputPlan({ action: "type", text: "" }, {}))).toContain("non-empty text");
  });

  it("presses keys with System Events modifiers and key codes", () => {
    const combo = planOf(darwinComputerUse.inputPlan({ action: "key", keys: ["cmd", "shift", "t"] }, {}));
    expect(combo.script).toBe('tell application "System Events" to keystroke "t" using {command down, shift down}');
    const named = planOf(darwinComputerUse.inputPlan({ action: "key", keys: ["Return"] }, {}));
    expect(named.script).toBe('tell application "System Events" to key code 36');
    expect(refusalOf(darwinComputerUse.inputPlan({ action: "key", keys: ["t", "Return"] }, {}))).toContain("not a modifier");
    expect(refusalOf(darwinComputerUse.inputPlan({ action: "key", keys: ["F13"] }, {}))).toContain("no key named");
    expect(refusalOf(darwinComputerUse.inputPlan({ action: "key", keys: ["cmd"] }, {}))).toContain("cannot be the key of a press");
  });

  it("lists windows through System Events, reading the CGWindow number", () => {
    const plan = planOf(darwinComputerUse.inputPlan({ action: "windows" }, {}));
    expect(plan.script).toContain("AXWindowNumber");
    expect(plan.script).toContain("every application process whose visible is true");
    const filtered = planOf(darwinComputerUse.inputPlan({ action: "windows", app: "Safari" }, {}));
    expect(filtered.script).toContain('every application process whose name is "Safari"');
    expect(filtered.script).toContain("no running process is named");
  });

  it("probes the Accessibility grant with one read-only System Events property", () => {
    const probe = planOf(darwinComputerUse.permissionProbe());
    expect(probe.argv).toEqual(["/usr/bin/osascript", "-e", 'tell application "System Events" to return UI elements enabled']);
    expect(probe.permissionHint).toContain("Accessibility");
  });
});

// ── linux ────────────────────────────────────────────────────────────────────

describe("linux computer-use plans", () => {
  it("captures the X11 root window through import, with a scrot fallback in the script", () => {
    const plan = planOf(linuxComputerUse.capturePlan(CAPTURE, LINUX_ENV));
    expect(plan.argv[0]).toBe("/bin/sh");
    expect(plan.driver).toBe("import");
    expect(plan.script).toContain("import -window root '/tmp/rolebox-shot.png'");
    expect(plan.script).toContain("scrot -o");
    expect(plan.script).toContain("exit 127");
    expect(plan.requires).toEqual(["/bin/sh"]);
  });

  it("crops a region, addresses one window, and selects a display by prefixing DISPLAY", () => {
    const region = planOf(linuxComputerUse.capturePlan({ ...CAPTURE, region: { x: 10, y: 20, w: 300, h: 200 } }, LINUX_ENV));
    expect(region.script).toContain("import -window root -crop 300x200+10+20 +repage");
    const window = planOf(linuxComputerUse.capturePlan({ ...CAPTURE, windowId: 42 }, LINUX_ENV));
    expect(window.script).toContain("import -window 42");
    // The window branch has no scrot fallback: scrot cannot address a window.
    expect(window.script).not.toContain("scrot -o");
    const display = planOf(linuxComputerUse.capturePlan({ ...CAPTURE, display: 1 }, LINUX_ENV));
    expect(display.script).toContain("env DISPLAY=:1 import -window root");
  });

  it("refuses a Wayland session for capture and for input", () => {
    const waylandEnv: NodeJS.ProcessEnv = { XDG_SESSION_TYPE: "wayland" };
    expect(refusalOf(linuxComputerUse.capturePlan(CAPTURE, waylandEnv))).toContain("Wayland session");
    expect(refusalOf(linuxComputerUse.inputPlan({ action: "move", x: 1, y: 2 }, waylandEnv))).toContain("drives X11 only");
    expect(refusalOf(linuxComputerUse.inputPlan({ action: "click", x: 1, y: 2, button: "left", clicks: 1 }, { WAYLAND_DISPLAY: "wayland-0" }))).toContain("Wayland");
    expect(planOf(linuxComputerUse.capturePlan(CAPTURE, LINUX_ENV)).driver).toBe("import");
  });

  it("drives input with xdotool argv — no shell, so typed text is never re-parsed", () => {
    const click = planOf(linuxComputerUse.inputPlan({ action: "click", x: 100, y: 200, button: "left", clicks: 1 }, LINUX_ENV));
    expect(click.argv).toEqual(["xdotool", "mousemove", "--sync", "100", "200", "click", "1"]);

    const doubleRight = planOf(linuxComputerUse.inputPlan({ action: "click", x: 100, y: 200, button: "right", clicks: 2, windowId: 42 }, LINUX_ENV));
    expect(doubleRight.argv).toEqual([
      "xdotool", "mousemove", "--sync", "--window", "42", "100", "200",
      "click", "--window", "42", "--repeat", "2", "--delay", "100", "3",
    ]);

    const move = planOf(linuxComputerUse.inputPlan({ action: "move", x: 1, y: 2 }, LINUX_ENV));
    expect(move.argv).toEqual(["xdotool", "mousemove", "--sync", "1", "2"]);

    const type = planOf(linuxComputerUse.inputPlan({ action: "type", text: "$(rm -rf /) 'quoted'" }, LINUX_ENV));
    expect(type.argv).toEqual(["xdotool", "type", "--delay", "12", "--", "$(rm -rf /) 'quoted'"]);

    const key = planOf(linuxComputerUse.inputPlan({ action: "key", keys: ["ctrl", "shift", "t"] }, LINUX_ENV));
    expect(key.argv).toEqual(["xdotool", "key", "--clearmodifiers", "ctrl+shift+t"]);
    expect(planOf(linuxComputerUse.inputPlan({ action: "key", keys: ["Return"] }, LINUX_ENV)).argv).toEqual([
      "xdotool", "key", "--clearmodifiers", "Return",
    ]);
    expect(planOf(linuxComputerUse.inputPlan({ action: "key", keys: ["cmd", "c"] }, LINUX_ENV)).argv).toEqual([
      "xdotool", "key", "--clearmodifiers", "super+c",
    ]);
    expect(refusalOf(linuxComputerUse.inputPlan({ action: "key", keys: ["t", "Return"] }, LINUX_ENV))).toContain("not a modifier");
  });

  it("lists windows with an xdotool search loop", () => {
    const plan = planOf(linuxComputerUse.inputPlan({ action: "windows" }, LINUX_ENV));
    expect(plan.script).toContain("xdotool search --onlyvisible --name ''");
    expect(plan.script).toContain("xdotool getwindowname");
    const filtered = planOf(linuxComputerUse.inputPlan({ action: "windows", app: "fire fox" }, LINUX_ENV));
    expect(filtered.script).toContain("--name 'fire fox'");
  });

  it("probes the session type and the helper inside the script", () => {
    const probe = planOf(linuxComputerUse.permissionProbe());
    expect(probe.driver).toBe("xdotool");
    expect(probe.script).toContain("XDG_SESSION_TYPE");
    expect(probe.script).toContain("command -v xdotool");
    expect(probe.requires).toEqual(["/bin/sh"]);
  });
});

// ── win32 ────────────────────────────────────────────────────────────────────

describe("win32 computer-use plans", () => {
  it("captures through PowerShell System.Drawing, quoting the path", () => {
    const plan = planOf(win32ComputerUse.capturePlan({ path: "C:\\Users\\o'brien\\shot.png" }, {}));
    expect(plan.argv[0]).toBe("powershell");
    expect(plan.argv).toContain("-STA");
    expect(plan.requires).toEqual(["powershell"]);
    expect(plan.script).toContain("[System.Windows.Forms.SystemInformation]::VirtualScreen");
    expect(plan.script).toContain("$bitmap.Save('C:\\Users\\o''brien\\shot.png'");
    expect(plan.script).toContain("CopyFromScreen");
  });

  it("captures one display, one region or one window", () => {
    const display = planOf(win32ComputerUse.capturePlan({ ...CAPTURE, display: 2 }, {}));
    expect(display.script).toContain("[System.Windows.Forms.Screen]::AllScreens");
    expect(display.script).toContain("$screens[2].Bounds");
    const region = planOf(win32ComputerUse.capturePlan({ ...CAPTURE, region: { x: 10, y: 20, w: 300, h: 200 } }, {}));
    expect(region.script).toContain("$width = 300");
    expect(region.script).toContain("$sourceY = 20");
    const window = planOf(win32ComputerUse.capturePlan({ ...CAPTURE, windowId: 66000 }, {}));
    expect(window.script).toContain("GetWindowRect");
    expect(window.script).toContain("[IntPtr]66000");
    expect(refusalOf(win32ComputerUse.capturePlan({ ...CAPTURE, windowId: 66000, region: { x: 0, y: 0, w: 5, h: 5 } }, {}))).toContain("not both");
    expect(refusalOf(win32ComputerUse.capturePlan({ ...CAPTURE, region: { x: 0, y: 0, w: 0, h: 5 } }, {}))).toContain("at least one pixel");
  });

  it("clicks and moves with mouse_event through the UI thread", () => {
    const left = planOf(win32ComputerUse.inputPlan({ action: "click", x: 10, y: 20, button: "left", clicks: 1 }, {}));
    expect(left.script).toContain("SetCursorPos(10, 20)");
    expect(left.script).toContain("mouse_event(0x0002");
    expect(left.script).toContain("mouse_event(0x0004");
    const rightDouble = planOf(win32ComputerUse.inputPlan({ action: "click", x: 1, y: 2, button: "right", clicks: 2 }, {}));
    expect(rightDouble.script?.match(/mouse_event\(0x0008/g)?.length).toBe(2);
    const middle = planOf(win32ComputerUse.inputPlan({ action: "click", x: 1, y: 2, button: "middle", clicks: 1 }, {}));
    expect(middle.script).toContain("mouse_event(0x0020");
    const move = planOf(win32ComputerUse.inputPlan({ action: "move", x: 7, y: 8 }, {}));
    expect(move.script).toContain("SetCursorPos(7, 8)");
    expect(refusalOf(win32ComputerUse.inputPlan({ action: "click", x: 1, y: 2, button: "left", clicks: 1, windowId: 5 }, {}))).toContain("focused window");
  });

  it("types and presses keys through SendKeys with its syntax escaped", () => {
    const typed = planOf(win32ComputerUse.inputPlan({ action: "type", text: "a+b{c}(d)\ne\tf" }, {}));
    expect(typed.script).toContain("SendWait('a{+}b{{}c{}}{(}d{)}{ENTER}e{TAB}f')");
    const combo = planOf(win32ComputerUse.inputPlan({ action: "key", keys: ["ctrl", "shift", "t"] }, {}));
    expect(combo.script).toContain("SendWait('^+t')");
    expect(planOf(win32ComputerUse.inputPlan({ action: "key", keys: ["Return"] }, {})).script).toContain("SendWait('{ENTER}')");
    expect(refusalOf(win32ComputerUse.inputPlan({ action: "key", keys: ["win", "e"] }, {}))).toContain("Windows key");
    expect(refusalOf(win32ComputerUse.inputPlan({ action: "key", keys: ["ctrl", "Nope"] }, {}))).toContain("no key named");
  });

  it("lists windows from Get-Process MainWindowHandle", () => {
    const plan = planOf(win32ComputerUse.inputPlan({ action: "windows" }, {}));
    expect(plan.script).toContain("Get-Process");
    expect(plan.script).toContain("MainWindowHandle");
    const filtered = planOf(win32ComputerUse.inputPlan({ action: "windows", app: "note" }, {}));
    expect(filtered.script).toContain("ProcessName -like '*note*'");
  });

  it("probes whether the session is interactive", () => {
    const probe = planOf(win32ComputerUse.permissionProbe());
    expect(probe.script).toContain("UserInteractive");
    expect(probe.driver).toBe("powershell");
  });
});

// ── purity and the unsupported system ────────────────────────────────────────

describe("plan builders", () => {
  it("are pure: the same request yields the same plan, whatever the host environment", () => {
    const request: ComputerInputRequest = { action: "click", x: 3, y: 4, button: "left", clicks: 1 };
    const first = planOf(linuxComputerUse.inputPlan(request, { XDG_SESSION_TYPE: "x11" }));
    const second = planOf(linuxComputerUse.inputPlan(request, { XDG_SESSION_TYPE: "x11", EXTRA: "ignored" }));
    expect(second).toEqual(first);
    expect(planOf(darwinComputerUse.inputPlan(request, {}))).toEqual(planOf(darwinComputerUse.inputPlan(request, { WAYLAND_DISPLAY: "x" })));
    expect(planOf(win32ComputerUse.capturePlan(CAPTURE, {}))).toEqual(planOf(win32ComputerUse.capturePlan(CAPTURE, {})));
  });

  it("declare the helpers they call, so the executor can refuse a missing one", () => {
    expect(darwinComputerUse.requiredBinaries).toContain("cliclick");
    expect(linuxComputerUse.requiredBinaries).toContain("xdotool");
    expect(win32ComputerUse.requiredBinaries).toEqual(["powershell"]);
    for (const facts of [darwinComputerUse, linuxComputerUse, win32ComputerUse]) {
      expect(facts.supported).toBe(true);
      expect(facts.installHint.length).toBeGreaterThan(0);
    }
  });

  it("refuse an unlisted platform by name instead of inventing a driver", () => {
    const facts = unsupportedComputerUse("posix", "POSIX (unlisted platform)");
    expect(facts.supported).toBe(false);
    expect(facts.refusal).toContain("posix");
    expect(facts.refusal).toContain("macOS");
  });
});
