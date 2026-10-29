
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";






import { FAKE_PNG_BYTES } from "./fixtures/fake-driver.ts";

// ── The mocked optional dependency ───────────────────────────────────────────

type AnyRecord = Record<string, any>;

let launchImpl: (options: AnyRecord) => AnyRecord = () => { throw new Error("launch not configured"); };
let attachImpl: (url: string, options: AnyRecord) => AnyRecord = () => { throw new Error("attach not configured"); };
let firefoxLaunchImpl: (options: AnyRecord) => AnyRecord = () => { throw new Error("firefox launch not configured"); };
let webkitLaunchImpl: (options: AnyRecord) => AnyRecord = () => { throw new Error("webkit launch not configured"); };

vi.doMock("playwright", () => ({
  chromium: {
    launch: (options: AnyRecord) => launchImpl(options),
    connectOverCDP: (url: string, options: AnyRecord) => attachImpl(url, options),
  },
  firefox: {
    launch: (options: AnyRecord) => firefoxLaunchImpl(options),
  },
  webkit: {
    launch: (options: AnyRecord) => webkitLaunchImpl(options),
  },
}));
const { AUTOMATION_CONTROLLED_ARG, DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS, DEFAULT_BROWSE_VIEWPORT, launchPlaywrightDriver, mapPlaywrightError, playwrightDriverFactory } = await import("../../src/browse/playwright-driver.ts");
type BrowseError = InstanceType<typeof BrowseError>;
const { BrowseError, browseError } = await import("../../src/browse/types.ts");
const { hasPngSignature } = await import("../../src/computer/png.ts");
const { configuredBrowsersPath, detectPlaywright, PLAYWRIGHT_GUIDANCE } = await import("../../src/browse/availability.ts");
const { BROWSE_ATTACHMENT_LIMIT_BYTES, browseCaptureDirectory, browseCaptureTimestamp, browseScreenshotResult, buildBrowseAttachment } = await import("../../src/browse/capture.ts");
const { browseErrorResult, browseResult, formatBrowseError, toBrowseError } = await import("../../src/browse/results.ts");

// ── Fake page, context and browser ───────────────────────────────────────────

let locatorCalls: Array<{ selector?: string; role?: string; name?: string; method: string; value?: unknown }> = [];

function fakeLocator(selector: string, before?: (method: string) => Promise<void> | void): AnyRecord {
  const run = async (method: string, value?: unknown) => {
    locatorCalls.push({ selector, method, value });
    await before?.(method);
  };
  return {
    click: async (options?: AnyRecord) => run("click", options),
    fill: async (value: string) => run("fill", value),
    pressSequentially: async (text: string) => run("pressSequentially", text),
    press: async (key: string) => run("press", key),
    hover: async (options?: AnyRecord) => run("hover", options),
    dragTo: async (target: unknown, options?: AnyRecord) => run("dragTo", { target, options }),
    selectOption: async (values: string[]) => {
      await run("selectOption", values);
      return [...values];
    },
    setInputFiles: async (files: string[]) => run("setInputFiles", files),
    scrollIntoViewIfNeeded: async () => run("scrollIntoViewIfNeeded"),
    waitFor: async (options?: AnyRecord) => run("waitFor", options),
  };
}

function fakePage(): AnyRecord {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  const state = {
    closed: false,
    closeCount: 0,
    url: "https://example.com/",
    title: "Example",
    selectorLocators: [] as string[],
    roleCalls: [] as AnyRecord[],
    goto: [] as Array<{ url: string; options?: AnyRecord }>,
    screenshotOptions: [] as AnyRecord[],
    keyCalls: [] as Array<{ kind: string; key: string }>,
    wheelCalls: [] as Array<{ deltaX: number; deltaY: number }>,
    beforeLocatorAction: undefined as ((method: string) => Promise<void> | void) | undefined,
  };
  const locator = (selector: string) => fakeLocator(selector, state.beforeLocatorAction);
  const page: AnyRecord = {
    state,
    on(event: string, handler: (payload?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    emit(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    goto: async (url: string, options?: AnyRecord) => {
      state.goto.push({ url, options });
      state.url = url;
      return { status: () => 200 };
    },
    goBack: async () => ({ status: () => 200 }),
    goForward: async () => null,
    reload: async () => ({ status: () => 200 }),
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    url: () => state.url,
    title: async () => state.title,
    content: async () => "<html><body>Example</body></html>",
    evaluate: async (pageFunction: unknown, arg?: unknown) => {
      if (typeof pageFunction === "function") return (pageFunction as (value: unknown) => unknown)(arg);
      return `evaluated:${String(pageFunction)}`;
    },
    locator: (selector: string) => {
      state.selectorLocators.push(selector);
      return locator(selector);
    },
    getByRole: (role: string, options?: AnyRecord) => {
      state.roleCalls.push({ role, options });
      return locator(`role=${role}`);
    },
    getByText: (text: string) => locator(`text=${text}`),
    getByLabel: (text: string) => locator(`label=${text}`),
    getByPlaceholder: (text: string) => locator(`placeholder=${text}`),
    getByAltText: (text: string) => locator(`alt=${text}`),
    getByTitle: (text: string) => locator(`title=${text}`),
    getByTestId: (id: string) => locator(`testid=${id}`),
    screenshot: async (options?: AnyRecord) => {
      state.screenshotOptions.push(options ?? {});
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    },
    keyboard: {
      press: async (key: string) => {
        state.keyCalls.push({ kind: "press", key });
      },
      down: async (key: string) => {
        state.keyCalls.push({ kind: "down", key });
      },
      up: async (key: string) => {
        state.keyCalls.push({ kind: "up", key });
      },
    },
    mouse: {
      wheel: async (deltaX: number, deltaY: number) => {
        state.wheelCalls.push({ deltaX, deltaY });
      },
    },
    isClosed: () => state.closed,
    close: async () => {
      state.closed = true;
      state.closeCount += 1;
    },
  };
  return page;
}

function fakeContext(page: AnyRecord): AnyRecord {
  const state = {
    newPageCount: 0,
    closeCount: 0,
    cookieReads: 0,
    writtenCookies: [] as AnyRecord[],
    cleared: 0,
  };
  const context: AnyRecord = {
    state,
    newPage: async () => {
      state.newPageCount += 1;
      return page;
    },
    pages: () => [page],
    cookies: async () => {
      state.cookieReads += 1;
      return [{
        name: "sid",
        value: "abc",
        domain: "example.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      }];
    },
    addCookies: async (cookies: AnyRecord[]) => {
      state.writtenCookies.push(...cookies);
    },
    clearCookies: async () => {
      state.cleared += 1;
    },
    close: async () => {
      state.closeCount += 1;
    },
  };
  return context;
}

interface FakeBrowserHarness {
  page: AnyRecord;
  context: AnyRecord;
  browser: AnyRecord;
  browserState: { closeCount: number; contexts: AnyRecord[]; newContextOptions: AnyRecord[] };
}

function fakeBrowser(options: { contexts?: AnyRecord[]; context?: AnyRecord; page?: AnyRecord } = {}): FakeBrowserHarness {
  const page = options.page ?? fakePage();
  const context = options.context ?? fakeContext(page);
  const browserState = {
    closeCount: 0,
    contexts: options.contexts ?? [],
    newContextOptions: [] as AnyRecord[],
  };
  const browser: AnyRecord = {
    state: browserState,
    newContext: async (contextOptions?: AnyRecord) => {
      browserState.newContextOptions.push(contextOptions ?? {});
      return context;
    },
    contexts: () => browserState.contexts,
    close: async () => {
      browserState.closeCount += 1;
    },
    isConnected: () => true,
  };
  return { page, context, browser, browserState };
}

afterEach(() => {
  locatorCalls = [];
});

// ── Launch and attach ────────────────────────────────────────────────────────

describe("launchPlaywrightDriver", () => {
  it("launches chromium with the sandbox on, the automation flag and the viewport", async () => {
    const harness = fakeBrowser();
    let launchOptions: AnyRecord = {};
    launchImpl = options => {
      launchOptions = options;
      return harness.browser;
    };

    const driver = await launchPlaywrightDriver({
      headless: true,
      downloadsDirectory: join(tmpdir(), "rolebox-browse-driver-test"),
    });

    expect(driver.engine).toBe("chromium");
    expect(driver.owned).toBe(true);
    expect(launchOptions.headless).toBe(true);
    expect(launchOptions.args).toEqual([AUTOMATION_CONTROLLED_ARG]);
    expect(launchOptions.chromiumSandbox).toBe(true);
    expect(launchOptions.viewport).toEqual(DEFAULT_BROWSE_VIEWPORT);
    expect(launchOptions.timeout).toBe(DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS);
    expect(harness.browserState.newContextOptions).toEqual([{ viewport: DEFAULT_BROWSE_VIEWPORT }]);

    const pageDriver = await driver.newPage();
    expect(harness.context.state.newPageCount).toBe(1);
    expect(pageDriver.isClosed()).toBe(false);

    await driver.close();
    expect(harness.page.state.closeCount).toBe(1);
    expect(harness.browserState.closeCount).toBe(1);
  });

  it("honors headless=false and chromiumSandbox=false", async () => {
    const harness = fakeBrowser();
    let launchOptions: AnyRecord = {};
    launchImpl = options => {
      launchOptions = options;
      return harness.browser;
    };

    const driver = await launchPlaywrightDriver({ headless: false, chromiumSandbox: false });
    expect(launchOptions.headless).toBe(false);
    expect(launchOptions.chromiumSandbox).toBe(false);
    await driver.close();
  });

  it("does not pass Chromium flags to firefox", async () => {
    const harness = fakeBrowser();
    let firefoxOptions: AnyRecord = {};
    firefoxLaunchImpl = options => {
      firefoxOptions = options;
      return harness.browser;
    };

    const driver = await launchPlaywrightDriver({ engine: "firefox" });
    expect(driver.engine).toBe("firefox");
    expect(firefoxOptions.args).toBeUndefined();
    expect(firefoxOptions.chromiumSandbox).toBeUndefined();
    await driver.close();
  });

  it("maps a missing browser binary to browser_launch_failed with the install command", async () => {
    launchImpl = () => {
      throw new Error("Executable doesn't exist at /ms-playwright/chromium-9999/chrome");
    };

    try {
      await launchPlaywrightDriver();
      throw new Error("expected the launch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowseError);
      const browse = error as BrowseError;
      expect(browse.code).toBe("browser_launch_failed");
      expect(browse.hint).toContain("npx playwright install chromium");
    }
  });

  it("attaches over CDP, releases its connection and leaves the shared context open", async () => {
    const harness = fakeBrowser();
    const existingContext = fakeContext(harness.page);
    harness.browserState.contexts = [existingContext];
    let attachCall: { url: string; options: AnyRecord } | undefined;
    attachImpl = (url, options) => {
      attachCall = { url, options };
      return harness.browser;
    };

    const driver = await launchPlaywrightDriver({ cdpUrl: "http://127.0.0.1:9222" });

    expect(driver.owned).toBe(false);
    expect(attachCall!.url).toBe("http://127.0.0.1:9222");
    expect(attachCall!.options.timeout).toBe(DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS);
    expect(harness.browserState.newContextOptions).toEqual([]);

    const pageDriver = await driver.newPage();
    expect(existingContext.state.newPageCount).toBe(1);
    expect(pageDriver.isClosed()).toBe(false);

    await driver.close();
    expect(harness.page.state.closeCount).toBe(1);
    expect(harness.browserState.closeCount).toBe(1);
    expect(existingContext.state.closeCount).toBe(0);
  });

  it("refuses a non-chromium CDP attach before connecting", async () => {
    let connected = false;
    attachImpl = () => {
      connected = true;
      return fakeBrowser().browser;
    };
    try {
      await launchPlaywrightDriver({ engine: "firefox", cdpUrl: "http://127.0.0.1:9222" });
      throw new Error("expected the attach to be refused");
    } catch (error) {
      expect((error as BrowseError).code).toBe("browser_launch_failed");
      expect(connected).toBe(false);
    }
  });
});

describe("playwrightDriverFactory.status", () => {
  it("reports the installed playwright entry point", () => {
    const status = playwrightDriverFactory.status();
    expect(status.available).toBe(true);
    expect(status.resolvedPath).toContain("playwright");
  });
});

// ── Error translation ────────────────────────────────────────────────────────

describe("mapPlaywrightError", () => {
  function codeOf(error: unknown): string {
    return mapPlaywrightError(error, "click").code;
  }

  it("passes a BrowseError through unchanged", () => {
    const original = browseError("stale_ref", "gone", "snapshot");
    expect(mapPlaywrightError(original, "click")).toBe(original);
  });

  it("maps TimeoutError to timeout", () => {
    const error = new Error("locator.click: Timeout 30000ms exceeded.");
    error.name = "TimeoutError";
    const mapped = mapPlaywrightError(error, "click");
    expect(mapped.code).toBe("timeout");
    expect(mapped.hint).toContain("browse_snapshot");
  });

  it("maps a strict-mode violation to ambiguous_target", () => {
    const mapped = mapPlaywrightError(new Error("strict mode violation: locator resolved to 3 elements"), "click");
    expect(mapped.code).toBe("ambiguous_target");
    expect(mapped.hint).toContain("ref");
  });

  it("maps a closed target to browser_closed", () => {
    const mapped = mapPlaywrightError(new Error("Target page, context or browser has been closed"), "click");
    expect(mapped.code).toBe("browser_closed");
  });

  it("maps an invalid CSS selector to invalid_target", () => {
    const mapped = mapPlaywrightError(new Error("Unexpected token \"#\" while parsing css selector \"#>x\""), "click");
    expect(mapped.code).toBe("invalid_target");
  });

  it("maps a detached element to stale_ref", () => {
    const mapped = mapPlaywrightError(new Error("Element is not attached to the DOM"), "click");
    expect(mapped.code).toBe("stale_ref");
    expect(mapped.hint).toContain("browse_snapshot");
  });

  it("maps a network navigation failure to navigation_failed", () => {
    const mapped = mapPlaywrightError(new Error("net::ERR_NAME_NOT_RESOLVED at https://nope.invalid"), "navigate");
    expect(mapped.code).toBe("navigation_failed");
  });

  it("maps an unknown failure to protocol_error with the original message", () => {
    const mapped = mapPlaywrightError(new Error("something unexpected"), "click");
    expect(mapped.code).toBe("protocol_error");
    expect(mapped.message).toContain("something unexpected");
    expect(mapped.hint).toBeDefined();
  });

  it("produces the same code for a non-Error value", () => {
    expect(codeOf("plain string failure")).toBe("protocol_error");
  });
});

// ── Page behavior ────────────────────────────────────────────────────────────

async function openPage(harness: FakeBrowserHarness): Promise<{ driver: AnyRecord; pageDriver: AnyRecord }> {
  launchImpl = () => harness.browser;
  const driver = await launchPlaywrightDriver();
  const pageDriver = await driver.newPage();
  return { driver, pageDriver };
}

describe("PlaywrightPageDriver", () => {
  it.each([
    ["page.evaluate: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')", "script_error", "browse_wait"],
    ["page.evaluate: TypeError: Cannot read properties of undefined (reading 'value')", "script_error", "guard null or undefined"],
    ["page.evaluate: SyntaxError: Unexpected end of input", "script_error", "syntax"],
    ["page.evaluate: ReferenceError: missingVariable is not defined", "script_error", "page globals"],
    ["page.evaluate: Error: custom failure", "script_error", "expression"],
    ["page.evaluate: SecurityError: Blocked a frame with a different origin", "script_error", "expression"],
    ["page.evaluate: Evaluation failed: TypeError: value is null", "script_error", "browse_wait"],
    ["page.evaluate: CustomFailure: rejected\n    at UtilityScript.evaluate (<anonymous>:303:30)", "script_error", "expression"],
    ["page.evaluate: Error: Target page, context or browser has been closed", "script_error", "expression"],
    ["page.evaluate: Error: net::ERR_FAILED", "script_error", "expression"],
    ["page.evaluate: Error: Timeout 100ms exceeded", "script_error", "expression"],
    ["page.evaluate: Error: Execution context was destroyed", "script_error", "expression"],
    ["page.evaluate: Execution context was destroyed, most likely because of a navigation.", "execution_context_destroyed", "navigation"],
    ["page.evaluate: Cannot find context with specified id", "execution_context_destroyed", "browse_snapshot"],
    ["page.evaluate: Frame was detached", "execution_context_destroyed", "navigation"],
    ["page.evaluate: Target page, context or browser has been closed", "browser_closed", "browse_tabs"],
    ["page.evaluate: Protocol error (Runtime.callFunctionOn): Session closed", "protocol_error", "browse_status"],
    ["page.evaluate: unexpected driver failure", "protocol_error", "browse_status"],
    ["page.evaluate: plain thrown value", "protocol_error", "browse_status"],
  ])("classifies evaluation failure %s as %s", async (message, code, hint) => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    const original = new Error(message);
    harness.page.evaluate = async () => { throw original; };
    try {
      const error = await pageDriver.evaluate("expression").catch((error: unknown) => error) as BrowseError;
      expect(error).toBeInstanceOf(BrowseError);
      expect(error.code).toBe(code);
      expect(error.cause).toBe(original);
      expect(error.message).toContain(message.split("\n")[0].replace(/\.$/, ""));
      expect(error.hint).toContain(hint);
      if (code === "script_error" || code === "execution_context_destroyed") {
        expect(error.hint).not.toMatch(/browse_status|driver|retry/i);
      }
      expect(pageDriver.isClosed()).toBe(false);
    } finally {
      await driver.close();
    }
  });

  it.each([
    ["TimeoutError", "page.evaluate: TimeoutError: Timeout 100ms exceeded", "timeout"],
    ["TargetClosedError", "page.evaluate: Target page, context or browser has been closed", "browser_closed"],
    ["ProtocolError", "page.evaluate: ProtocolError: Session closed", "protocol_error"],
  ])("preserves Playwright's %s driver error", async (name, message, code) => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    const original = new Error(message);
    original.name = name;
    harness.page.evaluate = async () => { throw original; };
    try {
      await expect(pageDriver.evaluate("expression")).rejects.toMatchObject({ code, cause: original });
    } finally {
      await driver.close();
    }
  });

  it("preserves a classified evaluation failure", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    const original = browseError("cancelled", "the evaluation was cancelled", "Reopen the page.");
    harness.page.evaluate = async () => { throw original; };
    try {
      await expect(pageDriver.evaluate("expression")).rejects.toBe(original);
    } finally {
      await driver.close();
    }
  });

  it("times out an unresolved evaluation and closes its page", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    harness.page.evaluate = () => new Promise(() => undefined);
    try {
      const evaluation = pageDriver.evaluate("new Promise(() => {})", undefined, { timeoutMs: 20 });
      const outcome = await Promise.race([
        evaluation.then(() => "completed", (error: unknown) => (error as BrowseError).code),
        new Promise(resolve => setTimeout(() => resolve("unsettled"), 100)),
      ]);
      expect(outcome).toBe("timeout");
      expect(pageDriver.isClosed()).toBe(true);
      expect(harness.page.state.closeCount).toBe(1);
    } finally {
      await driver.close();
    }
  });

  it("blocks actions while a dialog is pending and resolves it only through the dialog port", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    const accepted: Array<string | undefined> = [];
    harness.page.emit("dialog", {
      type: () => "confirm",
      message: () => "Are you sure?",
      defaultValue: () => "",
      accept: async (promptText?: string) => accepted.push(promptText),
      dismiss: async () => accepted.push("dismissed"),
    });

    expect(await pageDriver.dialog()).toEqual({
      type: "confirm",
      message: "Are you sure?",
      defaultValue: "",
      open: true,
    });
    // A title evaluation would block on the dialog; report no title instead.
    expect(await pageDriver.title()).toBe("");
    try {
      await pageDriver.click({ kind: "ref", ref: "e1" });
      throw new Error("expected the click to be refused");
    } catch (error) {
      expect((error as BrowseError).code).toBe("dialog_open");
      expect((error as BrowseError).hint).toContain("browse_dialog");
    }
    expect(harness.page.state.selectorLocators).toEqual([]);

    await pageDriver.acceptDialog("yes");
    expect(accepted).toEqual(["yes"]);
    expect(await pageDriver.dialog()).toBeNull();

    const result = await pageDriver.click({ kind: "ref", ref: "e1" });
    expect(result.target).toBe("ref=e1");
    expect(harness.page.state.selectorLocators).toEqual(['[data-rolebox-ref="e1"]']);
    await driver.close();
  });

  it("reports dialog_open promptly when the action itself opens a dialog", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    harness.page.state.beforeLocatorAction = async (method: string) => {
      if (method !== "click") return;
      harness.page.emit("dialog", {
        type: () => "confirm",
        message: () => "Sure?",
        defaultValue: () => "",
        accept: async () => undefined,
        dismiss: async () => undefined,
      });
      // Playwright leaves the triggering call blocked until the dialog is handled.
      await new Promise<void>(() => undefined);
    };

    const started = Date.now();
    try {
      await pageDriver.click({ kind: "ref", ref: "e1" });
      throw new Error("expected dialog_open");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowseError);
      const browse = error as BrowseError;
      expect(browse.code).toBe("dialog_open");
      expect(browse.message).toContain("opened a confirm dialog");
      expect(browse.message).toContain("Sure?");
      expect(browse.hint).toContain("browse_dialog");
    }
    // It must not wait for the action's 30s timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pageDriver.dialog()).toMatchObject({ type: "confirm", message: "Sure?" });
    await pageDriver.acceptDialog();
    expect(await pageDriver.dialog()).toBeNull();
    await driver.close();
  });

  it("records console, page errors, network events and downloads into capped buffers", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "rolebox-browse-downloads-"));
    const harness = fakeBrowser();
    launchImpl = () => harness.browser;
    const driver = await launchPlaywrightDriver({ downloadsDirectory: downloads });
    const pageDriver = await driver.newPage() as AnyRecord;

    harness.page.emit("console", {
      type: () => "warning",
      text: () => "careful",
      location: () => ({ url: "https://example.com/app.js" }),
    });
    harness.page.emit("pageerror", new TypeError("boom"));
    const request = { url: () => "https://example.com/api", method: () => "POST", resourceType: () => "fetch", failure: () => null };
    harness.page.emit("request", request);
    harness.page.emit("response", {
      url: () => "https://example.com/api",
      status: () => 201,
      request: () => request,
    });
    harness.page.emit("requestfailed", {
      ...request,
      url: () => "https://example.com/broken",
      failure: () => ({ errorText: "net::ERR_FAILED" }),
    });
    harness.page.emit("download", {
      suggestedFilename: () => "report.csv",
      url: () => "https://example.com/report.csv",
      saveAs: async (path: string) => {
        writeFileSync(path, "a,b\n1,2\n");
      },
      failure: async () => null,
      path: async () => null,
    });

    expect(pageDriver.buffers.console.size).toBe(2);
    const consoleEntries = pageDriver.buffers.console.read(0).entries;
    expect(consoleEntries[0].kind).toBe("console");
    expect(consoleEntries[0].level).toBe("warning");
    expect(consoleEntries[0].text).toBe("careful");
    expect(consoleEntries[0].url).toBe("https://example.com/app.js");
    expect(consoleEntries[1].kind).toBe("pageerror");
    expect(consoleEntries[1].text).toContain("TypeError: boom");

    expect(pageDriver.buffers.network.size).toBe(3);
    const network = pageDriver.buffers.network.read(0).entries;
    expect(network[0]).toMatchObject({ event: "request", method: "POST", resourceType: "fetch" });
    expect(network[1]).toMatchObject({ event: "response", status: 201, ok: true });
    expect(network[2]).toMatchObject({ event: "failed", error: "net::ERR_FAILED" });

    for (let attempt = 0; attempt < 100 && pageDriver.buffers.downloads.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const download = pageDriver.buffers.downloads.read(0).entries[0];
    expect(download.filename).toBe("report.csv");
    expect(download.status).toBe("completed");
    expect(download.bytes).toBe(8);
    expect(download.path!.startsWith(downloads)).toBe(true);
    expect(readFileSync(download.path!, "utf8")).toBe("a,b\n1,2\n");
    expect(existsSync(download.path!)).toBe(true);

    pageDriver.clearBuffers();
    expect(pageDriver.buffers.console.size).toBe(0);
    expect(pageDriver.buffers.network.size).toBe(0);

    await driver.close();
    rmSync(downloads, { recursive: true, force: true });
  });

  it("returns screenshot bytes and mime without writing a file", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    const screenshot = await pageDriver.screenshot({ fullPage: true });
    expect(screenshot.mime).toBe("image/png");
    expect(hasPngSignature(screenshot.bytes)).toBe(true);
    expect(harness.page.state.screenshotOptions[0].fullPage).toBe(true);

    const jpeg = await pageDriver.screenshot({ format: "jpeg", quality: 70 });
    expect(jpeg.mime).toBe("image/jpeg");
    expect(harness.page.state.screenshotOptions[1]).toMatchObject({ type: "jpeg", quality: 70 });
    await driver.close();
  });

  it("resolves targets to the documented Playwright locators", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    await pageDriver.click({ kind: "css", selector: "#save" });
    await pageDriver.click({ kind: "role", role: "button", name: "Save" });
    await pageDriver.click({ kind: "label", text: "Email" });
    await pageDriver.click({ kind: "placeholder", text: "Your name" });
    await pageDriver.click({ kind: "alt", text: "Logo" });
    await pageDriver.click({ kind: "title", text: "Close" });
    await pageDriver.click({ kind: "testid", testId: "go" });

    // Only css/ref targets go through page.locator(); the role/label/... forms
    // use Playwright's dedicated engines, which the fake page tracks separately.
    expect(harness.page.state.selectorLocators).toEqual(["#save"]);
    expect(harness.page.state.roleCalls[0]).toEqual({ role: "button", options: { name: "Save", exact: false } });
    await driver.close();
  });

  it("passes a click point, hold delay, triple count and repeats to the locator", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    await pageDriver.click({ kind: "ref", ref: "e1" }, {
      position: { x: 11, y: 22 },
      delayMs: 35,
      clickCount: 3,
      repeat: 2,
      intervalMs: 5,
      modifiers: ["Control"],
    });

    const clicks = locatorCalls.filter(call => call.method === "click");
    expect(clicks).toHaveLength(2);
    expect(clicks[0]!.value).toMatchObject({
      position: { x: 11, y: 22 },
      delay: 35,
      clickCount: 3,
      modifiers: ["Control"],
    });
    await driver.close();
  });

  it("drags with source and target positions and steps", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    await pageDriver.drag({ kind: "css", selector: "#source" }, { kind: "css", selector: "#target" }, {
      sourcePosition: { x: 3, y: 4 },
      targetPosition: { x: 8, y: 9 },
      steps: 4,
      force: true,
    });

    const drag = locatorCalls.find(call => call.method === "dragTo");
    expect(drag?.value).toMatchObject({
      options: {
        sourcePosition: { x: 3, y: 4 },
        targetPosition: { x: 8, y: 9 },
        steps: 4,
        force: true,
      },
    });
    await driver.close();
  });

  it("hovers a point with modifiers and holds there", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    await pageDriver.hover({ kind: "ref", ref: "e1" }, {
      position: { x: 7, y: 8 },
      modifiers: ["Shift"],
      force: true,
      holdMs: 1,
    });

    expect(locatorCalls.find(call => call.method === "hover")?.value).toMatchObject({
      position: { x: 7, y: 8 },
      modifiers: ["Shift"],
      force: true,
    });
    await driver.close();
  });

  it("wheels over a chosen point with modifiers held", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    await pageDriver.scroll({
      at: { kind: "ref", ref: "e1" },
      atPosition: { x: 5, y: 6 },
      deltaX: 10,
      deltaY: -20,
      modifiers: ["Control"],
    });

    expect(locatorCalls.find(call => call.method === "hover")?.value).toMatchObject({
      position: { x: 5, y: 6 },
    });
    expect(harness.page.state.keyCalls).toEqual([
      { kind: "down", key: "Control" },
      { kind: "up", key: "Control" },
    ]);
    expect(harness.page.state.wheelCalls).toEqual([{ deltaX: 10, deltaY: -20 }]);
    await driver.close();
  });

  it("refuses a malformed ref before touching the page", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    try {
      await pageDriver.click({ kind: "ref", ref: "not-a-ref" });
      throw new Error("expected invalid_target");
    } catch (error) {
      expect((error as BrowseError).code).toBe("invalid_target");
    }
    expect(harness.page.state.selectorLocators).toEqual([]);
    await driver.close();
  });

  it("reads and writes cookies through the context", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);

    expect(await pageDriver.cookies()).toEqual([{
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }]);
    await pageDriver.setCookies([{ name: "theme", value: "dark", url: "https://example.com" }]);
    expect(harness.context.state.writtenCookies).toEqual([{ name: "theme", value: "dark", url: "https://example.com" }]);

    try {
      await pageDriver.setCookies([{ name: "bad", value: "x" }]);
      throw new Error("expected invalid_target");
    } catch (error) {
      expect((error as BrowseError).code).toBe("invalid_target");
    }
    await pageDriver.clearCookies();
    expect(harness.context.state.cleared).toBe(1);
    await driver.close();
  });

  it("refuses to upload a file that does not exist", async () => {
    const harness = fakeBrowser();
    const { driver, pageDriver } = await openPage(harness);
    try {
      await pageDriver.upload({ kind: "css", selector: "input[type=file]" }, [join(tmpdir(), "rolebox-does-not-exist.txt")]);
      throw new Error("expected file_not_found");
    } catch (error) {
      expect((error as BrowseError).code).toBe("file_not_found");
    }
    expect(locatorCalls).toEqual([]);
    await driver.close();
  });
});

// ── Availability ─────────────────────────────────────────────────────────────

describe("detectPlaywright", () => {
  it("resolves the module without evaluating it", () => {
    const availability = detectPlaywright();
    expect(availability.available).toBe(true);
    expect(availability.resolvedPath).toBeDefined();
    expect(availability.resolvedPath).toContain("playwright");
    expect(availability.reason).toBeUndefined();
  });

  it("reads the browser cache only when the environment states it", () => {
    expect(configuredBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright" })).toBe("/cache/ms-playwright");
    expect(configuredBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "   " })).toBeUndefined();
    expect(configuredBrowsersPath({})).toBeUndefined();
  });

  it("names both install commands in its guidance", () => {
    expect(PLAYWRIGHT_GUIDANCE).toContain("npm install playwright");
    expect(PLAYWRIGHT_GUIDANCE).toContain("npx playwright install chromium");
  });
});

// ── Capture and result helpers ───────────────────────────────────────────────

const RESULT_CONTEXT = {
  action: "screenshot",
  session: "session-1",
  page: "main",
  url: "https://example.com/",
  title: "Example",
};

describe("browseScreenshotResult", () => {
  it("writes a PNG under .rolebox/browse and returns one canonical attachment", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-capture-"));
    try {
      const result = browseScreenshotResult({
        worktree,
        screenshot: { bytes: FAKE_PNG_BYTES, mime: "image/png" },
        context: RESULT_CONTEXT,
      });
      expect(typeof result).not.toBe("string");
      const object = result as Exclude<typeof result, string>;
      expect(object.output.startsWith("[image: image/png, ")).toBe(true);
      expect(object.metadata!.driver).toBe("playwright");
      expect(object.metadata!.action).toBe("screenshot");
      expect(object.metadata!.width).toBe(800);
      expect(object.metadata!.height).toBe(600);
      expect(object.metadata!.bytes).toBe(FAKE_PNG_BYTES.byteLength);

      const path = object.metadata!.path as string;
      expect(path.startsWith(browseCaptureDirectory(worktree))).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).byteLength).toBe(FAKE_PNG_BYTES.byteLength);

      expect(object.attachments).toHaveLength(1);
      const attachment = object.attachments![0];
      expect(attachment.type).toBe("file");
      expect(attachment.mime).toBe("image/png");
      expect(attachment.url.startsWith("data:image/png;base64,")).toBe(true);
      expect(attachment.filename).toBe(basename(path));
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("rejects an attachment over the 32 MiB limit without writing a file", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rolebox-browse-capture-"));
    try {
      const result = browseScreenshotResult({
        worktree,
        screenshot: { bytes: new Uint8Array(BROWSE_ATTACHMENT_LIMIT_BYTES + 1), mime: "image/png" },
        context: RESULT_CONTEXT,
      });
      const object = result as Exclude<typeof result, string>;
      expect(object.output.startsWith("Error: ")).toBe(true);
      expect(object.metadata!.error).toBe(true);
      expect(object.metadata!.code).toBe("too_large");
      expect(existsSync(browseCaptureDirectory(worktree))).toBe(false);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("builds the canonical data: attachment and a UTC capture stamp", () => {
    expect(buildBrowseAttachment(new Uint8Array([1, 2]), "image/png", "shot.png")).toEqual({
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AQI=",
      filename: "shot.png",
    });
    expect(browseCaptureTimestamp(new Date("2026-10-25T01:28:05.123Z"))).toBe("20261025T012805123Z");
  });
});

describe("browse result helpers", () => {
  it("reports the canonical metadata on success", () => {
    const result = browseResult({ title: "Snapshot", output: "ok", context: RESULT_CONTEXT });
    expect(typeof result).not.toBe("string");
    const object = result as Exclude<typeof result, string>;
    expect(object.metadata).toMatchObject({
      driver: "playwright",
      action: "screenshot",
      session: "session-1",
      page: "main",
      url: "https://example.com/",
      title: "Example",
    });
    expect(object.metadata!.error).toBeUndefined();
  });

  it("renders a failure as one actionable sentence with code metadata", () => {
    const result = browseErrorResult(
      { action: "click", session: "session-1", page: "main" },
      browseError("stale_ref", "ref e3 is stale", "Call browse_snapshot again."),
    );
    const object = result as Exclude<typeof result, string>;
    expect(object.output).toBe("Error: ref e3 is stale; call browse_snapshot again.");
    expect(object.metadata).toMatchObject({
      driver: "playwright",
      action: "click",
      session: "session-1",
      error: true,
      code: "stale_ref",
    });
    expect(object.metadata!.hint).toBe("Call browse_snapshot again.");
  });

  it("coerces an unknown thrown value into protocol_error", () => {
    const error = toBrowseError(new Error("boom"));
    expect(error.code).toBe("protocol_error");
    expect(formatBrowseError(error)).toContain("boom");
    expect(formatBrowseError(error).endsWith(".")).toBe(true);
  });
});
