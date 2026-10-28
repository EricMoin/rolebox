/**
 * macOS computer-use driver — pure plans executed through the built-in osascript.
 * screencapture captures windows or global screen rectangles with geometry
 * verified before and after capture. A display is selected by its current bounds.
 *
 * A capture and the input that follows it are in different coordinate spaces:
 * images use raster pixels, while input uses screen points. Window captures
 * omit shadows and preserve the native raster. Rectangle captures compose
 * individual display intersections into a canvas sized to the logical extent.
 * Screenshot geometry and raster dimensions define the conversion to screen points.
 *
 * Key combinations use `/usr/bin/osascript` driving System Events through
 * `keystroke` and `key code`. macOS grants that only to a process the user has
 * trusted with Accessibility, and scripting System Events needs its own
 * Automation grant on top, which is why every input plan carries
 * {@link ComputerPlan.permissionHint}.
 *
 * Window enumeration is the one command here that does not touch System Events:
 * it runs `osascript -l JavaScript` against the window server's own list, so the
 * ids it prints are the native CGWindowIDs used by capture and focus and it needs
 * no Accessibility grant. A window title macOS withholds prints as an empty
 * column.
 *
 * Pointer movement, clicks, text input, scrolling and dragging use Quartz events
 * through JXA. Clicks send actual mouse events, including to custom views that
 * have no Accessibility press action. Focusing a window matches its window-server
 * identity to one unambiguous Accessibility window.
 *
 * Everything here is a pure function of its request: no builder reads this
 * host, so every plan is exercisable anywhere through `setPlatformForTest`.
 */

import type {
  ComputerCaptureRequest,
  ComputerCaptureGuard,
  ComputerInputRequest,
  ComputerPlan,
  ComputerPlanOrRefusal,
  SupportedComputerUse,
} from "../../platform/system/types.ts";
import { REGION_REFUSAL, usableWindowId, wholeRegion } from "./shared.ts";
import { DARWIN_GEOMETRY_SCRIPT, darwinCaptureGuardScript, darwinCaptureScript } from "./darwin-geometry.ts";

const OSASCRIPT = "/usr/bin/osascript";

/** Remediation for a reported macOS privacy denial. */
const INPUT_PERMISSION_HINT =
  "macOS gives input control only to a process the user has trusted with Accessibility (System Settings > Privacy & Security > Accessibility) to synthesize input and with Automation for System Events (System Settings > Privacy & Security > Automation) to script it. Approve the application launching the host and restart it if required. Automation remains a separate grant; computer_permissions cannot grant it automatically.";

const SCREEN_RECORDING_HINT =
  "macOS needs Screen Recording permission for native screenshots (System Settings > Privacy & Security > Screen Recording); grant it to the application launching the host and restart it if required.";

const QUARTZ_PERMISSION_HINT =
  "macOS needs Accessibility permission for input events (System Settings > Privacy & Security > Accessibility); grant it to the process that launched the host and restart that process.";

/**
 * Appended to every failure of the window listing. It is the one macOS plan
 * that needs no privacy grant at all: listing windows is not input.
 */
const WINDOW_LIST_PERMISSION_HINT =
  "the macOS window list comes from the window server and needs no Accessibility grant; the title column is empty when macOS withholds window names (control that under System Settings > Privacy & Security > Screen Recording).";

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

type KeyPress = { readonly statement: string; readonly javaScript: string } | { readonly refusal: string };

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
  const options = modifiers.length > 0 ? `, {using: ${JSON.stringify(modifiers)}}` : "";
  const lower = final.toLowerCase();
  const code = KEY_CODES[lower];
  if (code !== undefined) return {
    statement: `key code ${code}${using}`,
    javaScript: `Application('System Events').keyCode(${code}${options});`,
  };
  if (MODIFIERS[lower] !== undefined) {
    return { refusal: `"${final}" is a modifier and cannot be the key of a press; put modifiers first and end with a normal key.` };
  }
  if (final.length === 1) return {
    statement: `keystroke "${escapeAppleScript(final)}"${using}`,
    javaScript: `Application('System Events').keystroke(${JSON.stringify(final)}${options});`,
  };
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
    permissionHint: INPUT_PERMISSION_HINT,
  };
}

function javaScriptPlan(script: string, permissionHint?: string): ComputerPlan {
  return {
    argv: [OSASCRIPT, "-l", "JavaScript", "-e", script],
    windowsVerbatimArguments: false,
    script,
    requires: [OSASCRIPT],
    driver: "osascript",
    ...(permissionHint === undefined ? {} : { permissionHint }),
  };
}

function displayListingPlan(): ComputerPlan {
  return javaScriptPlan([
    DARWIN_GEOMETRY_SCRIPT,
    "JSON.stringify(computerDisplays());",
  ].join("\n"));
}

function focusPlan(windowId: number): ComputerPlanOrRefusal {
  if (!usableWindowId(windowId)) return "a window id must be a positive whole number (macOS window numbers come from computer_windows).";
  return javaScriptPlan([
    "ObjC.import('CoreGraphics');",
    "ObjC.import('ApplicationServices');",
    "if (!$.AXIsProcessTrusted()) throw new Error('Accessibility permission is not granted');",
    `var targetId = ${windowId};`,
    "function value(dict, key) { var o = dict.objectForKey(key); return (o === undefined || o === null) ? undefined : o.js; }",
    "function geometry(dict) { return ObjC.deepUnwrap(dict.objectForKey('kCGWindowBounds')); }",
    "function sameBounds(a, b) { return a.X === b.X && a.Y === b.Y && a.Width === b.Width && a.Height === b.Height; }",
    "var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));",
    "var target;",
    "for (var i = 0; i < Number(list.count); i++) {",
    "  var item = list.objectAtIndex(i);",
    "  if (Number(value(item, 'kCGWindowNumber')) === targetId && Number(value(item, 'kCGWindowLayer')) === 0) target = item;",
    "}",
    "if (!target) throw new Error('the requested window is not visible; refresh computer_windows');",
    "var pid = Number(value(target, 'kCGWindowOwnerPID'));",
    "var bounds = geometry(target);",
    "var title = value(target, 'kCGWindowName');",
    "var sameIdentity = 0;",
    "for (var i = 0; i < Number(list.count); i++) {",
    "  var item = list.objectAtIndex(i);",
    "  if (Number(value(item, 'kCGWindowOwnerPID')) !== pid || Number(value(item, 'kCGWindowLayer')) !== 0) continue;",
    "  if (sameBounds(geometry(item), bounds) && (title === undefined || title === null || title === '' || value(item, 'kCGWindowName') === title)) sameIdentity++;",
    "}",
    "if (sameIdentity !== 1) throw new Error('the window id cannot be matched unambiguously to an Accessibility window');",
    "var system = Application('System Events');",
    "var processes = system.processes.whose({unixId: pid})();",
    "if (processes.length !== 1) throw new Error('the window owner is no longer available');",
    "var process = processes[0];",
    "function matches(window) {",
    "  var position = window.position();",
    "  var size = window.size();",
    "  return position[0] === bounds.X && position[1] === bounds.Y && size[0] === bounds.Width && size[1] === bounds.Height && (title === undefined || title === null || title === '' || window.name() === title);",
    "}",
    "var windows = process.windows();",
    "var matchesFound = [];",
    "for (var i = 0; i < windows.length; i++) { if (matches(windows[i])) matchesFound.push(windows[i]); }",
    "if (matchesFound.length !== 1) throw new Error('the requested window has no unique Accessibility match; focus it manually');",
    "var window = matchesFound[0];",
    "process.frontmost = true;",
    "window.attributes.byName('AXMain').value = true;",
    "window.actions.byName('AXRaise').perform();",
    "var focused = false;",
    "for (var attempt = 0; attempt < 10; attempt++) {",
    "  delay(0.05);",
    "  var current = process.attributes.byName('AXFocusedWindow').value();",
    "  if (process.frontmost() && matches(current)) { focused = true; break; }",
    "}",
    "if (!focused) throw new Error('macOS did not focus the requested window');",
  ].join("\n"), INPUT_PERMISSION_HINT);
}

const QUARTZ_INPUT_SCRIPT = [
  "ObjC.import('CoreGraphics');",
  "ObjC.import('ApplicationServices');",
  "ObjC.import('Foundation');",
  "if (!$.AXIsProcessTrusted()) throw new Error('Accessibility permission is not granted');",
  "function postMouse(type, x, y, button, clickCount) {",
  "  if (button === undefined) button = $.kCGMouseButtonLeft;",
  "  var event = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);",
  "  if (!event) throw new Error('macOS could not create a mouse event');",
  "  if (clickCount !== undefined) $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clickCount);",
  "  $.CGEventPost($.kCGHIDEventTap, event);",
  "}",
].join("\n");

function mouseReleasePlan(button: string, up: string): ComputerPlan {
  return javaScriptPlan([
    QUARTZ_INPUT_SCRIPT,
    "var current = $.CGEventCreate(null);",
    "if (!current) throw new Error('macOS could not read the pointer position');",
    "var point = $.CGEventGetLocation(current);",
    `postMouse($.${up}, point.x, point.y, $.${button});`,
  ].join("\n"), QUARTZ_PERMISSION_HINT);
}

function clickPlan(request: Extract<ComputerInputRequest, { action: "click" }>): ComputerPlanOrRefusal {
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "click coordinates must be finite numbers.";
  if (request.clicks !== 1 && request.clicks !== 2) return "clicks must be 1 or 2.";
  const buttons = {
    left: ["kCGMouseButtonLeft", "kCGEventLeftMouseDown", "kCGEventLeftMouseUp"],
    right: ["kCGMouseButtonRight", "kCGEventRightMouseDown", "kCGEventRightMouseUp"],
    middle: ["kCGMouseButtonCenter", "kCGEventOtherMouseDown", "kCGEventOtherMouseUp"],
  } as const;
  const events = buttons[request.button];
  if (events === undefined) return "click button must be left, right or middle.";
  const [button, down, up] = events;
  const click = javaScriptPlan([
    QUARTZ_INPUT_SCRIPT,
    `postMouse($.kCGEventMouseMoved, ${x}, ${y});`,
    "$.NSThread.sleepForTimeInterval(0.02);",
    `for (var i = 1; i <= ${request.clicks}; i++) {`,
    "  try {",
    `    postMouse($.${down}, ${x}, ${y}, $.${button}, i);`,
    "    $.NSThread.sleepForTimeInterval(0.02);",
    "  } finally {",
    `    postMouse($.${up}, ${x}, ${y}, $.${button}, i);`,
    "  }",
    `  if (i < ${request.clicks}) $.NSThread.sleepForTimeInterval(0.05);`,
    "}",
  ].join("\n"), QUARTZ_PERMISSION_HINT);
  return { ...click, cleanupPlan: mouseReleasePlan(button, up) };
}

function movePlan(request: Extract<ComputerInputRequest, { action: "move" }>): ComputerPlanOrRefusal {
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "pointer coordinates must be finite numbers.";
  return javaScriptPlan([
    QUARTZ_INPUT_SCRIPT,
    `postMouse($.kCGEventMouseMoved, ${x}, ${y});`,
  ].join("\n"), QUARTZ_PERMISSION_HINT);
}

function scrollPlan(request: Extract<ComputerInputRequest, { action: "scroll" }>): ComputerPlanOrRefusal {
  if (!["up", "down", "left", "right"].includes(request.direction)) return "scroll direction must be up, down, left or right.";
  if (!Number.isInteger(request.amount) || request.amount < 1 || request.amount > 100) return "scroll amount must be a whole number from 1 to 100 wheel ticks.";
  if ((request.x === undefined) !== (request.y === undefined)) return "scroll coordinates must include both x and y.";
  const statements = [QUARTZ_INPUT_SCRIPT];
  if (request.x !== undefined && request.y !== undefined) {
    if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) return "scroll coordinates must be finite numbers.";
    statements.push(`postMouse($.kCGEventMouseMoved, ${Math.round(request.x)}, ${Math.round(request.y)});`);
    statements.push("$.NSThread.sleepForTimeInterval(0.05);");
  }
  const vertical = request.direction === "up" ? request.amount : request.direction === "down" ? -request.amount : 0;
  const horizontal = request.direction === "left" ? request.amount : request.direction === "right" ? -request.amount : 0;
  statements.push(
    `var event = $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitLine, 2, ${vertical}, ${horizontal}, 0);`,
    "if (!event) throw new Error('macOS could not create a scroll event');",
    "$.CGEventPost($.kCGHIDEventTap, event);",
  );
  return javaScriptPlan(statements.join("\n"), QUARTZ_PERMISSION_HINT);
}

function dragPlan(request: Extract<ComputerInputRequest, { action: "drag" }>): ComputerPlanOrRefusal {
  const coordinates = [request.fromX, request.fromY, request.toX, request.toY];
  if (!coordinates.every(Number.isFinite)) return "drag coordinates must be finite numbers.";
  if (!Number.isInteger(request.durationMs) || request.durationMs < 100 || request.durationMs > 5000) return "drag duration_ms must be a whole number from 100 to 5000 milliseconds.";
  const [fromX, fromY, toX, toY] = coordinates.map(Math.round);
  const drag = javaScriptPlan([
    QUARTZ_INPUT_SCRIPT,
    `var fromX = ${fromX}, fromY = ${fromY}, toX = ${toX}, toY = ${toY};`,
    `var steps = ${Math.ceil(request.durationMs / 16)};`,
    `var interval = ${request.durationMs / 1000} / steps;`,
    "var x = fromX, y = fromY;",
    "postMouse($.kCGEventMouseMoved, x, y);",
    "try {",
    "  postMouse($.kCGEventLeftMouseDown, x, y);",
    "  for (var i = 1; i <= steps; i++) {",
    "    $.NSThread.sleepForTimeInterval(interval);",
    "    x = fromX + (toX - fromX) * i / steps;",
    "    y = fromY + (toY - fromY) * i / steps;",
    "    postMouse($.kCGEventLeftMouseDragged, x, y);",
    "  }",
    "} finally {",
    "  postMouse($.kCGEventLeftMouseUp, x, y);",
    "}",
  ].join("\n"), QUARTZ_PERMISSION_HINT);
  return {
    ...drag,
    cleanupPlan: mouseReleasePlan("kCGMouseButtonLeft", "kCGEventLeftMouseUp"),
  };
}

function typePlan(text: string): ComputerPlanOrRefusal {
  if (text.length === 0) return "computer_type needs non-empty text.";
  const segments: Array<string | number> = [];
  for (const part of text.split(/(\r\n|\r|\n|\t)/)) {
    if (part === "\t") {
      segments.push(48);
      continue;
    }
    if (/^[\r\n]+$/.test(part)) {
      segments.push(36);
      continue;
    }
    let chunk = "";
    for (const character of part) {
      const code = character.charCodeAt(0);
      if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return "computer_type text contains an unpaired UTF-16 surrogate.";
      if (chunk.length + character.length > 20) {
        segments.push(chunk);
        chunk = "";
      }
      chunk += character;
    }
    if (chunk.length > 0) segments.push(chunk);
  }
  return javaScriptPlan([
    "ObjC.import('CoreGraphics');",
    "ObjC.import('ApplicationServices');",
    "ObjC.import('Foundation');",
    "if (!$.AXIsProcessTrusted()) throw new Error('Accessibility permission is not granted');",
    // NSData.bytes is a void pointer; JXA's UniChar pointer metadata rejects it.
    "ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']]);",
    `var segments = ${JSON.stringify(segments)};`,
    "for (var i = 0; i < segments.length; i++) {",
    "  var segment = segments[i];",
    "  var isText = typeof segment === 'string';",
    "  var key = isText ? 0 : segment;",
    "  var down = $.CGEventCreateKeyboardEvent(null, key, true);",
    "  var up = $.CGEventCreateKeyboardEvent(null, key, false);",
    "  if (!down || !up) throw new Error('macOS could not create a keyboard event');",
    "  $.CGEventSetFlags(down, 0);",
    "  $.CGEventSetFlags(up, 0);",
    "  if (isText) {",
    "    var data = $(segment).dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);",
    "    if (!data || Number(data.length) !== segment.length * 2) throw new Error('macOS could not encode the input text');",
    "    $.CGEventKeyboardSetUnicodeString(down, segment.length, data.bytes);",
    "    $.CGEventKeyboardSetUnicodeString(up, segment.length, data.bytes);",
    "  }",
    "  try { $.CGEventPost($.kCGHIDEventTap, down); }",
    "  finally { $.CGEventPost($.kCGHIDEventTap, up); }",
    "  $.NSThread.sleepForTimeInterval(0.005);",
    "}",
  ].join("\n"), QUARTZ_PERMISSION_HINT);
}

function windowInputPlan(windowId: number | undefined, input: ComputerPlanOrRefusal, guard?: ComputerCaptureGuard): ComputerPlanOrRefusal {
  if (typeof input === "string" || (windowId === undefined && guard === undefined)) return input;
  const scripts: string[] = [];
  if (windowId !== undefined) {
    const focus = focusPlan(windowId);
    if (typeof focus === "string") return focus;
    scripts.push(`(function () {\n${focus.script}\n})();`);
  }
  if (guard !== undefined) scripts.push(`(function () {\n${darwinCaptureGuardScript(guard)}\n})();`);
  scripts.push(input.script!);
  const combined = javaScriptPlan(scripts.join("\n"), windowId === undefined ? input.permissionHint : INPUT_PERMISSION_HINT);
  return {
    ...combined,
    ...(guard === undefined ? {} : { inputGuardFailureMarker: "ROLEBOX_SCREENSHOT_STALE" }),
    ...(input.cleanupPlan === undefined ? {} : { cleanupPlan: input.cleanupPlan }),
  };
}

function capturePlan(request: ComputerCaptureRequest): ComputerPlanOrRefusal {
  if (request.windowId !== undefined && request.region !== undefined) {
    return "a screenshot takes one window or one region, not both; pass window_id or region.";
  }
  if (request.windowId !== undefined && request.display !== undefined) {
    return "a single-window capture does not select a display; pass window_id or display.";
  }
  if (request.region !== undefined && request.display !== undefined) {
    return "a region is expressed in global screen coordinates and already selects its own displays, so pass region or display, not both.";
  }
  if (request.display !== undefined && (!Number.isInteger(request.display) || request.display < 1)) {
    return "macOS counts displays from 1 (1 is the main display, 2 the next), so pass a display of 1 or more.";
  }
  let target = request;
  if (request.windowId !== undefined) {
    if (!usableWindowId(request.windowId)) {
      return "a window id must be a positive whole number (macOS window numbers come from computer_windows).";
    }
  } else if (request.region !== undefined) {
    const region = wholeRegion(request.region);
    if (region === null) return REGION_REFUSAL;
    target = { ...request, region };
  }
  return {
    ...javaScriptPlan(darwinCaptureScript(target), SCREEN_RECORDING_HINT),
    driver: "screencapture",
    requires: [OSASCRIPT, "/usr/sbin/screencapture"],
  };
}

/**
 * The JXA script that lists one line per visible window: window number, the
 * owning process and the title, tab-separated.
 *
 * The window number is the CGWindowID used by capture and focus, and the window
 * server's own list (`CGWindowListCopyWindowInfo`) is the only place macOS
 * exposes it: System Events' window attributes carry no `AXWindowNumber` on
 * current macOS at all, so reading the id through AppleScript left every window
 * with the -1 placeholder. `ObjC.castRefToObject` is what makes the returned
 * CFArrayRef readable — `ObjC.deepUnwrap` and a bare `.js` on the ref itself do
 * not work, while a per-value `.js` does.
 *
 * The bridge hands a CFArrayRef's `count` back as a string, so the script
 * coerces it with `Number` rather than trusting its type; anything that is not a
 * non-negative number is the unreadable-list error.
 *
 * The optional owner filter arrives as `run(argv)[0]` and is never interpolated
 * into this script, so an application name with quotes or backslashes needs no
 * escaping. Only layer 0 is listed: the desktop picture, the menu bar and the
 * Dock live in other layers and are not windows a caller can capture or click.
 * A filter that matches nothing is an error naming the filter, not an empty
 * list, because an empty list is indistinguishable from a broken listing.
 */
function windowListingScript(): string {
  return [
    "ObjC.import('CoreGraphics');",
    "function value(dict, key) { var o = dict.objectForKey(key); return (o === undefined || o === null) ? undefined : o.js; }",
    "function run(argv) {",
    "  var filter = (argv && argv.length > 0) ? String(argv[0]).toLowerCase() : '';",
    "  var opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;",
    "  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID));",
    "  if (list === undefined || list === null) {",
    "    throw new Error('the window server did not return a window list this script can read');",
    "  }",
    "  var count = Number(list.count);",
    "  if (!(count >= 0)) {",
    "    throw new Error('the window server did not return a window list this script can read');",
    "  }",
    "  var out = [];",
    "  for (var i = 0; i < count; i++) {",
    "    var d = list.objectAtIndex(i);",
    "    if (value(d, 'kCGWindowLayer') !== 0) continue;",
    "    var owner = String(value(d, 'kCGWindowOwnerName') || '');",
    "    if (filter.length > 0 && owner.toLowerCase().indexOf(filter) === -1) continue;",
    "    var name = value(d, 'kCGWindowName');",
    "    out.push(value(d, 'kCGWindowNumber') + '\\t' + owner + '\\t' + ((name === undefined || name === null) ? '' : String(name)));",
    "  }",
    "  if (out.length === 0 && filter.length > 0) {",
    "    throw new Error('no visible window belongs to a process whose name contains \"' + filter + '\"');",
    "  }",
    "  return out.join('\\n');",
    "}",
  ].join("\n");
}

/**
 * The window-listing plan: `osascript -l JavaScript` with the script as its own
 * `-e` argument and the owner filter as the trailing argv element the script
 * reads, so a filter never becomes script text.
 */
function windowListingPlan(app: string | null): ComputerPlan {
  const script = windowListingScript();
  return {
    argv: [OSASCRIPT, "-l", "JavaScript", "-e", script, ...(app === null ? [] : [app])],
    windowsVerbatimArguments: false,
    script,
    requires: [OSASCRIPT],
    driver: "osascript",
    permissionHint: WINDOW_LIST_PERMISSION_HINT,
  };
}

function inputPlan(request: ComputerInputRequest): ComputerPlanOrRefusal {
  switch (request.action) {
    case "displays": return displayListingPlan();
    case "focus": return focusPlan(request.windowId);
    case "scroll": return windowInputPlan(request.windowId, scrollPlan(request), request.captureGuard);
    case "drag": return windowInputPlan(request.windowId, dragPlan(request), request.captureGuard);
    case "windows": {
      const app = request.app === undefined || request.app.trim().length === 0 ? null : request.app.trim();
      return windowListingPlan(app);
    }
    case "click": return windowInputPlan(request.windowId, clickPlan(request), request.captureGuard);
    case "move": return windowInputPlan(request.windowId, movePlan(request), request.captureGuard);
    case "type": return windowInputPlan(request.windowId, typePlan(request.text));
    case "key": {
      const press = keyPress(request.keys);
      if ("refusal" in press) return press.refusal;
      if (request.windowId !== undefined) return windowInputPlan(request.windowId, javaScriptPlan(press.javaScript));
      return osascriptPlan(`tell application "System Events" to ${press.statement}`);
    }
  }
}

// ── The TCC Accessibility probe and prompt ───────────────────────────────────
//
// Input on macOS is gated by TCC's Accessibility grant, and that grant belongs
// to the PROCESS that asks for it — not to the machine. `tell application
// "System Events" to return UI elements enabled` reads a GLOBAL System Events
// UI-scripting preference and answers true even while the OS is already blocking
// this process's input, so it can never be a permission probe. The real TCC API
// is `AXIsProcessTrusted` / `AXIsProcessTrustedWithOptions`, which JXA binds once
// `ObjC.import('ApplicationServices')` has run.

/** The one token the probe prints when this process is trusted for input. */
const DARWIN_PROBE_GRANTED = "granted";
/** The one token the probe prints when this process is NOT trusted for input. */
const DARWIN_PROBE_DENIED = "not granted";

/**
 * The JXA body that reads one TCC Accessibility answer and prints exactly one
 * token: `granted` or `not granted`, and nothing else.
 *
 * `console.log` is what puts the token on the process's own stderr as a clean
 * line — osascript echoes only a script's final VALUE, which a call returning
 * `undefined` suppresses, so the answer is never doubled. The `$.NSLog` spelling
 * is deliberately not used: it prefixes every line with a date and a PID
 * (`2026-10-13 13:55:42.315 osascript[31311:60752701] granted`), which an
 * exact-token verdict could not read as a grant.
 */
function tccScript(trustCall: string): string {
  return [
    "ObjC.import('ApplicationServices');",
    "ObjC.import('Foundation');",
    `var PRINT_GRANTED = '${DARWIN_PROBE_GRANTED}';`,
    `var PRINT_DENIED = '${DARWIN_PROBE_DENIED}';`,
    `console.log(${trustCall} ? PRINT_GRANTED : PRINT_DENIED);`,
  ].join("\n");
}

/**
 * `osascript -l JavaScript` with one TCC script as its own `-e` argument.
 *
 * The script is a pure value like every other plan here; only the executor runs
 * it, so a caller can rehearse the exact prompt or probe with `dry_run`.
 */
function tccPlan(script: string): ComputerPlan {
  return {
    argv: [OSASCRIPT, "-l", "JavaScript", "-e", script],
    windowsVerbatimArguments: false,
    script,
    requires: [OSASCRIPT],
    driver: "osascript",
    permissionHint: INPUT_PERMISSION_HINT,
  };
}

/** The probe: read THIS process's own TCC Accessibility trust. */
function permissionProbePlan(): ComputerPlan {
  return tccPlan(tccScript("$.AXIsProcessTrusted()"));
}

function capturePermissionProbePlan(): ComputerPlan {
  return javaScriptPlan([
    "ObjC.import('CoreGraphics');",
    "try { ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); } catch (_) { throw new Error('this macOS version has no Screen Recording permission probe'); }",
    "var probe;",
    "try { probe = $.CGPreflightScreenCaptureAccess; } catch (_) { throw new Error('this macOS version has no Screen Recording permission probe'); }",
    "if (typeof probe !== 'function') throw new Error('this macOS version has no Screen Recording permission probe');",
    `console.log(probe() ? '${DARWIN_PROBE_GRANTED}' : '${DARWIN_PROBE_DENIED}');`,
  ].join("\n"), SCREEN_RECORDING_HINT);
}

function capturePermissionPromptPlan(): ComputerPlan {
  return javaScriptPlan([
    "ObjC.import('CoreGraphics');",
    "try { ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]); } catch (_) { throw new Error('this macOS version has no Screen Recording permission request API'); }",
    "var request;",
    "try { request = $.CGRequestScreenCaptureAccess; } catch (_) { throw new Error('this macOS version has no Screen Recording permission request API'); }",
    "if (typeof request !== 'function') throw new Error('this macOS version has no Screen Recording permission request API');",
    `console.log(request() ? '${DARWIN_PROBE_GRANTED}' : '${DARWIN_PROBE_DENIED}');`,
  ].join("\n"), SCREEN_RECORDING_HINT);
}

/**
 * The prompt: ask TCC to show its Accessibility dialog for this process and
 * report the answer it gives.
 *
 * `kAXTrustedCheckOptionPrompt` is what makes macOS show the dialog (and
 * register the app under System Settings > Privacy & Security > Accessibility)
 * instead of only answering. The dictionary spelling is
 * `dictionaryWithObjectForKey`; the widely repeated
 * `dictionaryWithObjectForDictionaryKey` is not a function (-2700) and must not
 * be used.
 */
function permissionPromptPlan(): ComputerPlan {
  return tccPlan(
    tccScript(
      "$.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey(true, ObjC.castRefToObject($.kAXTrustedCheckOptionPrompt)))",
    ),
  );
}

/** The macOS computer-use facts, declared once for the darwin descriptor. */
export const darwinComputerUse: SupportedComputerUse = {
  supported: true,
  requiredBinaries: [OSASCRIPT, "/usr/sbin/screencapture"],
  installHint:
    "macOS ships osascript and screencapture; native screenshots require Screen Recording permission.",
  capturePlan(request) {
    return capturePlan(request);
  },
  inputPlan(request) {
    return inputPlan(request);
  },
  permissionProbe() {
    return permissionProbePlan();
  },
  capturePermissionProbe() {
    return capturePermissionProbePlan();
  },
  capturePermissionPrompt() {
    return capturePermissionPromptPlan();
  },
  permissionPrompt() {
    return permissionPromptPlan();
  },
  readsProbeOutput: true,
};
