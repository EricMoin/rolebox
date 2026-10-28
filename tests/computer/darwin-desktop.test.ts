
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { darwinComputerUse } from "../../src/computer/drivers/darwin.ts";
import type { ComputerInputRequest, ComputerPlan } from "../../src/platform/system/types.ts";

function plan(request: ComputerInputRequest): ComputerPlan {
  const built = darwinComputerUse.inputPlan(request, {});
  if (typeof built === "string") throw new Error(built);
  expect(built.argv).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e", built.script!]);
  expect(built.requires).toEqual(["/usr/bin/osascript"]);
  return built;
}

function execute(request: ComputerInputRequest, globals: Record<string, unknown>): unknown {
  return runInNewContext(plan(request).script!, {
    ObjC: { import() {}, castRefToObject: (value: unknown) => value, deepUnwrap: (value: unknown) => value },
    ...globals,
  });
}

function nativeEvents(failDrag = false, trusted = true) {
  const posted: Array<{ type: string; x?: number; y?: number; vertical?: number; horizontal?: number }> = [];
  const sleeps: number[] = [];
  const api = {
    AXIsProcessTrusted: () => trusted,
    kCGHIDEventTap: "hid",
    kCGMouseButtonLeft: "left",
    kCGEventMouseMoved: "move",
    kCGEventLeftMouseDown: "down",
    kCGEventLeftMouseDragged: "drag",
    kCGEventLeftMouseUp: "up",
    kCGScrollEventUnitLine: "line",
    CGPointMake: (x: number, y: number) => ({ x, y }),
    CGEventCreateMouseEvent: (_source: unknown, type: string, point: { x: number; y: number }) => ({ type, ...point }),
    CGEventCreateScrollWheelEvent2: (_source: unknown, unit: string, count: number, vertical: number, horizontal: number) => {
      expect(unit).toBe("line");
      expect(count).toBe(2);
      return { type: "scroll", vertical, horizontal };
    },
    CGEventPost: (_tap: unknown, event: (typeof posted)[number]) => {
      if (failDrag && event.type === "drag") throw new Error("injected event failure");
      posted.push(event);
    },
    NSThread: { sleepForTimeInterval: (seconds: number) => sleeps.push(seconds) },
  };
  return { api, posted, sleeps };
}

describe("macOS desktop discovery", () => {
  it("returns screenshot-compatible ordinals, global screen points and backing scale", () => {
    const screens = [
      { id: 42, bounds: { origin: { x: 0, y: 0 }, size: { width: 1512, height: 982 } }, scale: 2 },
      { id: 91, bounds: { origin: { x: -1920, y: -100 }, size: { width: 1920, height: 1080 } }, scale: 1 },
    ];
    const result = execute({ action: "displays" }, { $: {
      NSScreen: { screens: { count: "2", objectAtIndex: (index: number) => ({
        deviceDescription: { objectForKey: () => ({ js: screens[index].id }) },
        backingScaleFactor: screens[index].scale,
      }) } },
      CGDisplayBounds: (id: number) => screens.find(screen => screen.id === id)!.bounds,
    } });
    expect(JSON.parse(String(result))).toEqual([
      { id: 1, x: 0, y: 0, width: 1512, height: 982, scale: 2, primary: true, name: "42" },
      { id: 2, x: -1920, y: -100, width: 1920, height: 1080, scale: 1, primary: false, name: "91" },
    ]);
    expect(plan({ action: "displays" }).permissionHint).toBeUndefined();
  });

  it("reports a missing GUI session", () => {
    expect(() => execute({ action: "displays" }, { $: { NSScreen: { screens: { count: 0 } } } })).toThrow("no displays");
  });
});

describe("macOS native pointer events", () => {
  type MouseEvent = { type: string; x: number; y: number; button: string; clickCount?: number };

  function pointerEnvironment(failDown = false) {
    const posted: MouseEvent[] = [];
    const api = {
      AXIsProcessTrusted: () => true,
      kCGHIDEventTap: "hid",
      kCGMouseButtonLeft: "left",
      kCGMouseButtonRight: "right",
      kCGMouseButtonCenter: "middle",
      kCGEventMouseMoved: "move",
      kCGEventLeftMouseDown: "left-down",
      kCGEventLeftMouseUp: "left-up",
      kCGEventRightMouseDown: "right-down",
      kCGEventRightMouseUp: "right-up",
      kCGEventOtherMouseDown: "middle-down",
      kCGEventOtherMouseUp: "middle-up",
      kCGMouseEventClickState: "click-state",
      CGPointMake: (x: number, y: number) => ({ x, y }),
      CGEventCreateMouseEvent: (_source: unknown, type: string, point: { x: number; y: number }, button: string) => ({ type, ...point, button }),
      CGEventSetIntegerValueField: (event: MouseEvent, field: string, value: number) => {
        expect(field).toBe("click-state");
        event.clickCount = value;
      },
      CGEventPost: (_tap: unknown, event: MouseEvent) => {
        if (failDown && event.type.endsWith("-down")) throw new Error("injected mouse failure");
        posted.push(event);
      },
      CGEventCreate: () => ({}),
      CGEventGetLocation: () => ({ x: -14, y: 27 }),
      NSThread: { sleepForTimeInterval() {} },
    };
    return { posted, globals: { $: api } };
  }

  it.each([
    [-100, 50, -100, 50],
    [100, -50, 100, -50],
    [-100.6, -50.2, -101, -50],
    [-0.2, 0, 0, 0],
  ] as const)("moves to rounded absolute screen points (%s, %s)", (x, y, expectedX, expectedY) => {
    const { posted, globals } = pointerEnvironment();
    execute({ action: "move", x, y }, globals);
    expect(posted).toEqual([{ type: "move", x: expectedX, y: expectedY, button: "left" }]);
  });

  it.each(["left", "right", "middle"] as const)("sends real %s down/up events with double-click counts", button => {
    const { posted, globals } = pointerEnvironment();
    const request = { action: "click", x: -100.6, y: 50.2, button, clicks: 2 } as const;
    execute(request, globals);
    expect(posted).toEqual([
      { type: "move", x: -101, y: 50, button: "left" },
      { type: `${button}-down`, x: -101, y: 50, button, clickCount: 1 },
      { type: `${button}-up`, x: -101, y: 50, button, clickCount: 1 },
      { type: `${button}-down`, x: -101, y: 50, button, clickCount: 2 },
      { type: `${button}-up`, x: -101, y: 50, button, clickCount: 2 },
    ]);
    expect(plan(request).permissionHint).not.toContain("Automation");
  });

  it.each(["left", "right", "middle"] as const)("releases %s after a failed click and provides cancellation cleanup", button => {
    const request = { action: "click", x: 10, y: 20, button, clicks: 1 } as const;
    const failed = pointerEnvironment(true);
    expect(() => execute(request, failed.globals)).toThrow("injected mouse failure");
    expect(failed.posted.at(-1)).toEqual({ type: `${button}-up`, x: 10, y: 20, button, clickCount: 1 });
    const cleanup = pointerEnvironment();
    runInNewContext(plan(request).cleanupPlan!.script!, {
      ObjC: { import() {} },
      ...cleanup.globals,
    });
    expect(cleanup.posted).toEqual([{ type: `${button}-up`, x: -14, y: 27, button }]);
  });

  it("requires only helpers shipped with macOS", () => {
    expect(darwinComputerUse.requiredBinaries).toEqual(["/usr/bin/osascript", "/usr/sbin/screencapture"]);
  });

  it("rejects invalid click or movement requests", () => {
    const request = { action: "click", x: 1, y: 2, button: "left", clicks: 1 } as const;
    expect(darwinComputerUse.inputPlan({ ...request, x: NaN }, {})).toContain("finite numbers");
    expect(darwinComputerUse.inputPlan({ ...request, clicks: 3 as 2 }, {})).toContain("1 or 2");
    expect(darwinComputerUse.inputPlan({ ...request, button: "unknown" as "left" }, {})).toContain("left, right or middle");
    expect(darwinComputerUse.inputPlan({ action: "move", x: Infinity, y: 0 }, {})).toContain("finite numbers");
  });
});

describe("macOS Screen Recording permission probe", () => {
  function probePlan(): ComputerPlan {
    const result = darwinComputerUse.capturePermissionProbe!();
    if (typeof result === "string") throw new Error(result);
    return result;
  }

  it.each([true, false])("prints exactly one permission token for granted=%s without requesting access", granted => {
    const probe = probePlan();
    const tokens: string[] = [];
    let prompted = false;
    runInNewContext(probe.script!, {
      ObjC: { import() {}, bindFunction: (name: string, signature: unknown) => {
        expect(name).toBe("CGPreflightScreenCaptureAccess");
        expect(signature).toEqual(["bool", []]);
      } },
      $: {
        CGPreflightScreenCaptureAccess: () => granted,
        CGRequestScreenCaptureAccess: () => { prompted = true; return true; },
      },
      console: { log: (token: string) => tokens.push(token) },
    });
    expect(tokens).toEqual([granted ? "granted" : "not granted"]);
    expect(prompted).toBe(false);
    expect(probe.argv).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e", probe.script!]);
    expect(probe.permissionHint).toContain("Screen Recording");
    expect(probe.script).not.toContain("CGRequestScreenCaptureAccess");
    expect(probe.script).not.toContain("AXIsProcessTrusted");
  });

  it("does not invent a grant when the native API is absent", () => {
    const tokens: string[] = [];
    for (const native of [{}, new Proxy({}, { get() { throw new Error("missing native symbol"); } })]) {
      expect(() => runInNewContext(probePlan().script!, {
        ObjC: { import() {}, bindFunction() {} }, $: native, console: { log: (token: string) => tokens.push(token) },
      })).toThrow("no Screen Recording permission probe");
    }
    expect(() => runInNewContext(probePlan().script!, {
      ObjC: { import() {}, bindFunction() { throw new Error("missing symbol"); } },
      $: {}, console: { log: (token: string) => tokens.push(token) },
    })).toThrow("no Screen Recording permission probe");
    expect(tokens).toEqual([]);
  });
});

describe("macOS Accessibility permission prompt", () => {
  it.each([true, false])("bridges the CFString option key before building the native dictionary for granted=%s", granted => {
    const prompt = darwinComputerUse.permissionPrompt!();
    if (typeof prompt === "string") throw new Error(prompt);
    const rawKey = { type: "{__CFString=}" };
    const nativeKey = { value: "AXTrustedCheckOptionPrompt" };
    const tokens: string[] = [];
    runInNewContext(prompt.script!, {
      ObjC: {
        import() {},
        castRefToObject: (value: unknown) => {
          expect(value).toBe(rawKey);
          return nativeKey;
        },
      },
      $: {
        kAXTrustedCheckOptionPrompt: rawKey,
        NSDictionary: {
          dictionaryWithObjectForKey: (value: boolean, key: unknown) => {
            expect(key).toBe(nativeKey);
            return { prompt: value };
          },
        },
        AXIsProcessTrustedWithOptions: (options: { prompt: boolean }) => {
          expect(options.prompt).toBe(true);
          return granted;
        },
      },
      console: { log: (token: string) => tokens.push(token) },
    });
    expect(tokens).toEqual([granted ? "granted" : "not granted"]);
  });
});

describe("macOS Unicode text input", () => {
  type KeyEvent = { key: number; down: boolean; flags?: number; text?: string };

  function keyboardEnvironment(trusted = true, failDown = false) {
    const posted: KeyEvent[] = [];
    const api = Object.assign((text: string) => ({
      dataUsingEncoding: (encoding: string) => {
        expect(encoding).toBe("utf16le");
        return { length: text.length * 2, bytes: text };
      },
    }), {
      AXIsProcessTrusted: () => trusted,
      NSUTF16LittleEndianStringEncoding: "utf16le",
      kCGHIDEventTap: "hid",
      CGEventCreateKeyboardEvent: (_source: unknown, key: number, down: boolean): KeyEvent => ({ key, down }),
      CGEventSetFlags: (event: KeyEvent, flags: number) => { event.flags = flags; },
      CGEventKeyboardSetUnicodeString: (event: KeyEvent, length: number, bytes: string) => {
        expect(length).toBe(bytes.length);
        event.text = bytes;
      },
      CGEventPost: (_tap: unknown, event: KeyEvent) => {
        if (failDown && event.down) throw new Error("injected keyboard failure");
        posted.push(event);
      },
      NSThread: { sleepForTimeInterval() {} },
    });
    return { posted, globals: {
      $: api,
      ObjC: {
        import() {},
        bindFunction: (name: string, signature: unknown) => {
          expect(name).toBe("CGEventKeyboardSetUnicodeString");
          expect(signature).toEqual(["void", ["void *", "unsigned long", "void *"]]);
        },
      },
    } };
  }

  it("preserves Unicode text in bounded native events without splitting surrogate pairs", () => {
    const text = 'x'.repeat(19) + '🧪 中文 e\u0301 "quote" \\path';
    const { posted, globals } = keyboardEnvironment();
    execute({ action: "type", text }, globals);
    const chunks = posted.filter(event => event.down).map(event => event.text!);
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("x".repeat(19));
    expect(chunks[1].startsWith("🧪")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u);
    }
    for (let index = 0; index < posted.length; index += 2) {
      expect(posted[index]).toEqual({ key: 0, down: true, flags: 0, text: chunks[index / 2] });
      expect(posted[index + 1]).toEqual({ key: 0, down: false, flags: 0, text: chunks[index / 2] });
    }
    expect(plan({ action: "type", text }).permissionHint).not.toContain("Automation");
  });

  it("normalizes newlines to Return and keeps Tab as a key event", () => {
    const { posted, globals } = keyboardEnvironment();
    execute({ action: "type", text: "a\r\nb\rc\nd\t\n" }, globals);
    expect(posted.filter(event => event.down).map(event => event.text ?? event.key)).toEqual(["a", 36, "b", 36, "c", 36, "d", 48, 36]);
  });

  it("does not post input without Accessibility permission", () => {
    const { posted, globals } = keyboardEnvironment(false);
    expect(() => execute({ action: "type", text: "hello" }, globals)).toThrow("Accessibility permission");
    expect(posted).toEqual([]);
  });

  it("releases the key when posting key-down fails", () => {
    const { posted, globals } = keyboardEnvironment(true, true);
    expect(() => execute({ action: "type", text: "中" }, globals)).toThrow("injected keyboard failure");
    expect(posted).toEqual([{ key: 0, down: false, flags: 0, text: "中" }]);
  });

  it.each(["\ud800", "a\udc00b"])("refuses malformed UTF-16 text before creating a native plan", text => {
    expect(darwinComputerUse.inputPlan({ action: "type", text }, {})).toContain("unpaired UTF-16 surrogate");
  });
});

describe("macOS scroll and drag events", () => {
  it.each([
    ["up", 7, 0], ["down", -7, 0], ["left", 0, 7], ["right", 0, -7],
  ] as const)("scrolls %s in wheel ticks", (direction, vertical, horizontal) => {
    const { api, posted } = nativeEvents();
    execute({ action: "scroll", direction, amount: 7 }, { $: api });
    expect(posted).toEqual([{ type: "scroll", vertical, horizontal }]);
  });

  it("moves to rounded global points before targeted scrolling", () => {
    const { api, posted } = nativeEvents();
    execute({ action: "scroll", direction: "down", amount: 1, x: -22.6, y: 10.2 }, { $: api });
    expect(posted).toEqual([{ type: "move", x: -23, y: 10 }, { type: "scroll", vertical: -1, horizontal: 0 }]);
  });

  it("drags for the requested duration and releases at the destination", () => {
    const { api, posted, sleeps } = nativeEvents();
    execute({ action: "drag", fromX: -20, fromY: 10, toX: 100, toY: 80, durationMs: 320 }, { $: api });
    expect(posted.slice(0, 2)).toEqual([{ type: "move", x: -20, y: 10 }, { type: "down", x: -20, y: 10 }]);
    expect(posted.filter(event => event.type === "drag")).toHaveLength(20);
    expect(posted.at(-1)).toEqual({ type: "up", x: 100, y: 80 });
    expect(sleeps.reduce((sum, duration) => sum + duration, 0)).toBeCloseTo(0.32);
  });

  it("releases the button even when a drag event fails", () => {
    const { api, posted } = nativeEvents(true);
    expect(() => execute({ action: "drag", fromX: 0, fromY: 0, toX: 70, toY: 70, durationMs: 100 }, { $: api })).toThrow("injected event failure");
    expect(posted.at(-1)?.type).toBe("up");
  });

  it("provides a separate cancellation cleanup that releases at the current pointer without moving", () => {
    const cleanup = plan({ action: "drag", fromX: 0, fromY: 0, toX: 70, toY: 70, durationMs: 100 }).cleanupPlan;
    expect(cleanup).toBeDefined();
    const { api, posted } = nativeEvents();
    runInNewContext(cleanup!.script!, {
      ObjC: { import() {} },
      $: { ...api, CGEventCreate: () => ({}), CGEventGetLocation: () => ({ x: 14, y: -27 }) },
    });
    expect(posted).toEqual([{ type: "up", x: 14, y: -27 }]);
  });

  it("refuses to post input when Accessibility is denied", () => {
    const { api, posted } = nativeEvents(false, false);
    expect(() => execute({ action: "scroll", direction: "up", amount: 2 }, { $: api })).toThrow("Accessibility permission");
    expect(posted).toEqual([]);
  });

  it("rejects invalid scroll coordinates, direction and amounts", () => {
    const base = { action: "scroll", direction: "up", amount: 1 } as const;
    for (const amount of [0, 101, 1.5, NaN, Infinity]) {
      expect(darwinComputerUse.inputPlan({ ...base, amount }, {})).toContain("whole number from 1 to 100");
    }
    expect(darwinComputerUse.inputPlan({ ...base, x: 1 }, {})).toContain("both x and y");
    expect(darwinComputerUse.inputPlan({ ...base, y: 1 }, {})).toContain("both x and y");
    expect(darwinComputerUse.inputPlan({ ...base, x: Infinity, y: 1 }, {})).toContain("finite numbers");
    expect(darwinComputerUse.inputPlan({ ...base, direction: "diagonal" as "up" }, {})).toContain("direction");
  });

  it("rejects invalid drag coordinates and durations", () => {
    const base = { action: "drag", fromX: 0, fromY: 0, toX: 70, toY: 70, durationMs: 100 } as const;
    for (const durationMs of [0, 99, 5001, 100.5, NaN, Infinity]) {
      expect(darwinComputerUse.inputPlan({ ...base, durationMs }, {})).toContain("100 to 5000");
    }
    expect(darwinComputerUse.inputPlan({ ...base, toY: NaN }, {})).toContain("finite numbers");
    expect(plan({ ...base, durationMs: 5000 }).permissionHint).toContain("Accessibility");
  });
});

function focusEnvironment(options: { duplicateCG?: boolean; duplicateAX?: boolean; focusWrong?: boolean; missing?: boolean; sibling?: boolean } = {}) {
  const actions: string[] = [];
  const bounds = { X: 20, Y: 30, Width: 400, Height: 300 };
  function windowInfo(id: number) {
    const data: Record<string, unknown> = {
      kCGWindowNumber: id, kCGWindowLayer: 0, kCGWindowOwnerPID: 55,
      kCGWindowBounds: options.sibling && id === 10 ? { ...bounds, X: 500 } : bounds, kCGWindowName: "Target",
    };
    return { objectForKey: (key: string) => key === "kCGWindowBounds" ? data[key] : { js: data[key] } };
  }
  const target = {
    position: () => [20, 30], size: () => [400, 300], name: () => "Target",
    attributes: { byName: (name: string) => ({ set value(_value: boolean) { actions.push(name); focusedWindow = target; } }) },
    actions: { byName: (name: string) => ({ perform: () => actions.push(name) }) },
  };
  let focusedWindow = target;
  const sibling = {
    ...target,
    position: () => [500, 30],
    attributes: { byName: (name: string) => ({ set value(_value: boolean) { actions.push(name); focusedWindow = sibling; } }) },
  };
  let frontmost = false;
  const process = {
    get frontmost(): (() => boolean) | boolean { return () => frontmost; },
    set frontmost(value: boolean | (() => boolean)) { frontmost = value === true; actions.push("activate"); },
    windows: () => options.duplicateAX ? [target, target] : options.sibling ? [target, sibling] : [target],
    attributes: { byName: (name: string) => ({ value: () => {
      expect(name).toBe("AXFocusedWindow");
      return options.focusWrong ? { ...target, position: () => [200, 300] } : focusedWindow;
    } }) },
  };
  const windows = options.missing ? [] : options.duplicateCG || options.sibling ? [windowInfo(9), windowInfo(10)] : [windowInfo(9)];
  return { actions, focusedPosition: () => focusedWindow.position(), globals: {
    $: { AXIsProcessTrusted: () => true, CGWindowListCopyWindowInfo: () => ({ count: String(windows.length), objectAtIndex: (i: number) => windows[i] }) },
    Application: () => ({ processes: { whose: ({ unixId }: { unixId: number }) => {
      expect(unixId).toBe(55);
      return () => [process];
    } } }),
    delay() {},
  } };
}

describe("macOS exact window focus", () => {
  it("raises the uniquely matched window and checks AXFocusedWindow", () => {
    const { actions, globals } = focusEnvironment();
    execute({ action: "focus", windowId: 9 }, globals);
    expect(actions).toEqual(["activate", "AXMain", "AXRaise"]);
  });

  it.each([{ duplicateCG: true }, { duplicateAX: true }, { missing: true }])("rejects missing or ambiguous windows before activating a process: %j", options => {
    const { actions, globals } = focusEnvironment(options);
    expect(() => execute({ action: "focus", windowId: 9 }, globals)).toThrow();
    expect(actions).toEqual([]);
  });

  it("does not claim success when the process activates but the wrong window is focused", () => {
    const { actions, globals } = focusEnvironment({ focusWrong: true });
    expect(() => execute({ action: "focus", windowId: 9 }, globals)).toThrow("did not focus");
    expect(actions).toContain("activate");
  });

  it("rejects invalid window IDs", () => {
    for (const windowId of [0, -1, 1.5, NaN, Infinity]) {
      expect(darwinComputerUse.inputPlan({ action: "focus", windowId }, {})).toContain("positive whole number");
    }
  });
});

describe("macOS window-targeted input", () => {
  const requests: ComputerInputRequest[] = [
    { action: "click", x: 40, y: 50, button: "left", clicks: 1, windowId: 9 },
    { action: "move", x: -20, y: 50, windowId: 9 },
    { action: "type", text: "hello", windowId: 9 },
    { action: "key", keys: ["cmd", "shift", "t"], windowId: 9 },
    { action: "scroll", direction: "down", amount: 2, x: 40, y: 50, windowId: 9 },
    { action: "drag", fromX: 40, fromY: 50, toX: 80, toY: 90, durationMs: 100, windowId: 9 },
  ];

  function environment(options: Parameters<typeof focusEnvironment>[0] = {}) {
    const focus = focusEnvironment(options);
    const { api } = nativeEvents();
    const inputs: unknown[] = [];
    const application = focus.globals.Application;
    const globals = {
      ...focus.globals,
      ObjC: { import() {}, bindFunction() {}, castRefToObject: (value: unknown) => value, deepUnwrap: (value: unknown) => value },
      $: Object.assign((text: string) => ({ dataUsingEncoding: () => ({ length: text.length * 2, bytes: text }) }), api, focus.globals.$, {
        CGEventSetIntegerValueField() {},
        CGEventCreateKeyboardEvent: (_source: unknown, key: number, down: boolean) => ({ key, down }),
        CGEventSetFlags() {},
        CGEventKeyboardSetUnicodeString: (event: Record<string, unknown>, _length: number, text: string) => { event.text = text; },
        CGEventPost: (_tap: unknown, event: unknown) => {
          expect(focus.actions).toEqual(["activate", "AXMain", "AXRaise"]);
          inputs.push(event);
        },
      }),
      Application: () => ({
        ...application(),
        keystroke: (key: string, modifiers: unknown) => {
          expect(focus.actions).toEqual(["activate", "AXMain", "AXRaise"]);
          inputs.push({ key, modifiers });
        },
        keyCode: (code: number, modifiers: unknown) => inputs.push({ code, modifiers }),
      }),
    };
    return { inputs, globals, actions: focus.actions };
  }

  it.each(requests)("focuses and verifies the requested window before $action input", request => {
    const { inputs, globals, actions } = environment();
    execute(request, globals);
    expect(actions).toEqual(["activate", "AXMain", "AXRaise"]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(plan(request).permissionHint).toContain("Automation");
  });

  it.each(requests)("sends no $action input when the requested window is missing, ambiguous or refused", request => {
    for (const options of [{ missing: true }, { duplicateCG: true }, { duplicateAX: true }, { focusWrong: true }]) {
      const { inputs, globals } = environment(options);
      expect(() => execute(request, globals)).toThrow();
      expect(inputs).toEqual([]);
    }
  });

  it("preserves native key codes and modifiers in a targeted shortcut", () => {
    const { inputs, globals } = environment();
    execute({ action: "key", keys: ["ctrl", "Return"], windowId: 9 }, globals);
    expect(inputs).toEqual([{ code: 36, modifiers: { using: ["control down"] } }]);
  });

  it("quotes a targeted character without interpreting it as script", () => {
    const { inputs, globals } = environment();
    execute({ action: "key", keys: ["cmd", '"'], windowId: 9 }, globals);
    expect(inputs).toEqual([{ key: '"', modifiers: { using: ["command down"] } }]);
  });

  it("switches between two windows with the same owner and title before delivering input", () => {
    const focus = focusEnvironment({ sibling: true });
    const received: Array<{ key: string; position: number[] }> = [];
    const globals = {
      ...focus.globals,
      Application: () => ({
        ...focus.globals.Application(),
        keystroke: (key: string) => received.push({ key, position: focus.focusedPosition() }),
      }),
    };
    execute({ action: "key", keys: ["a"], windowId: 9 }, globals);
    execute({ action: "key", keys: ["b"], windowId: 10 }, globals);
    execute({ action: "key", keys: ["c"], windowId: 9 }, globals);
    expect(received).toEqual([
      { key: "a", position: [20, 30] },
      { key: "b", position: [500, 30] },
      { key: "c", position: [20, 30] },
    ]);
  });

  it.each(requests)("refuses invalid window IDs before planning $action", request => {
    for (const windowId of [0, -1, 1.5, NaN, Infinity]) {
      expect(darwinComputerUse.inputPlan({ ...request, windowId } as ComputerInputRequest, {})).toContain("positive whole number");
    }
  });

  it("keeps drag cancellation cleanup independent of target focus", () => {
    const cleanup = plan(requests[5]).cleanupPlan!;
    expect(cleanup.script).toContain("kCGEventLeftMouseUp");
    expect(cleanup.script).not.toContain("AXRaise");
    expect(cleanup.script).not.toContain("kCGEventLeftMouseDown");
  });
});
