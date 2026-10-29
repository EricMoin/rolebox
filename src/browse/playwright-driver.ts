/**
 * The one module that value-imports Playwright.
 *
 * Everything above this boundary — the session manager, the tools, the tests —
 * talks to {@link BrowsePageDriver}. This file narrows the optional peer
 * dependency at a single point (the dynamic `await import("playwright")`), with
 * local structural types for exactly the calls it makes, in the same style as
 * `src/web/playwright-backend.ts`. Module load therefore starts no browser, opens
 * no socket and loads no Playwright code; `playwrightDriverFactory.status()`
 * answers availability synchronously from `detectPlaywright()`.
 *
 * Behavior worth naming:
 *
 * - A launched browser gets `chromiumSandbox` kept on for Chromium (Playwright's
 *   own default is off) and the automation-controlled feature flag disabled.
 *   `connectOverCDP` attaches to a browser that already exists: its context is
 *   reused so cookies and logins survive, only pages this driver created are
 *   closed, and `Browser.close` is never sent.
 * - A `dialog` is only recorded. The page stays blocked until the session calls
 *   `acceptDialog`/`dismissDialog`; every other action refuses with
 *   `dialog_open`. Playwright's own effect of "a listener exists, so do not
 *   auto-dismiss" is exactly the behavior the family needs.
 * - Console, page errors, dialogs, network events and downloads go into the
 *   capped per-page buffers from `types.ts`; downloads are written under the
 *   session's `.rolebox/browse/downloads` directory as they arrive.
 * - Every Playwright error is translated into a {@link BrowseError} with a code
 *   and a next step (timeout, strict-mode ambiguity, closed target, invalid
 *   selector, missing browser).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { convertHtmlToMarkdown } from "../web/html-to-markdown.ts";
import { detectPlaywright } from "./availability.ts";
import {
  browseSnapshotWalker,
  formatTruncationMarker,
  isSnapshotPayload,
  serializeSnapshotOptions,
  snapshotResultFromPayload,
  SNAPSHOT_MAX_CHARS,
} from "./snapshot.ts";
import { BROWSE_REF_PATTERN, describeTarget } from "./target.ts";
import {
  BrowseError,
  browseError,
  createBrowsePageBuffers,
  type ActionOptions,
  type ActionResult,
  type BrowseBufferKind,
  type BrowseDriver,
  type BrowseDriverFactory,
  type BrowseEngine,
  type BrowseLaunchOptions,
  type BrowsePageBuffers,
  type BrowsePageDriver,
  type BrowsePoint,
  type BrowseSnapshot,
  type BrowseViewport,
  type CookieInput,
  type CookieRecord,
  type DialogState,
  type DragOptions,
  type DriverStatus,
  type EvaluateOptions,
  type HoverOptions,
  type LoadState,
  type NavigateOptions,
  type NavigationResult,
  type ReadFormat,
  type ReadOptions,
  type ReadResult,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ScrollOptions,
  type ScrollResult,
  type SnapshotOptions,
  type TargetPlan,
  type WaitOptions,
} from "./types.ts";

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Per-action timeout when a caller names none. */
export const DEFAULT_BROWSE_TIMEOUT_MS = 30_000;

/** How long launching one browser may take. */
export const DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS = 60_000;

/** A realistic desktop viewport, so the page is not in a 1280x720 test frame. */
export const DEFAULT_BROWSE_VIEWPORT: BrowseViewport = { width: 1366, height: 768 };

/** The longest a single `wait` may sleep. */
export const BROWSE_MAX_WAIT_MS = 60_000;

/** Default character cap for `read`. */
export const READ_DEFAULT_MAX_CHARS = 20_000;

/** Hard ceiling for `read`, even when a caller asks for more. */
export const READ_MAX_CHARS = 200_000;

/** The Chromium flag that keeps `navigator.webdriver` from identifying automation. */
export const AUTOMATION_CONTROLLED_ARG = "--disable-blink-features=AutomationControlled";

let nextSnapshotRefOffset = 0;

// ── Optional-dependency boundary ─────────────────────────────────────────────
//
// The ambient declaration for this optional peer dependency (src/web/playwright.d.ts)
// is deliberately tiny, so this module describes the calls it makes and narrows
// the dynamic-import result to that description once, below.

interface PlaywrightLocatorLike {
  click(options?: {
    timeout?: number;
    force?: boolean;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    modifiers?: readonly string[];
    position?: BrowsePoint;
    delay?: number;
  }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(text: string, options?: { timeout?: number; delay?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  hover(options?: {
    timeout?: number;
    force?: boolean;
    modifiers?: readonly string[];
    position?: BrowsePoint;
  }): Promise<void>;
  dragTo(target: PlaywrightLocatorLike, options?: {
    timeout?: number;
    force?: boolean;
    sourcePosition?: BrowsePoint;
    targetPosition?: BrowsePoint;
    steps?: number;
  }): Promise<void>;
  selectOption(values: readonly string[], options?: { timeout?: number }): Promise<string[]>;
  setInputFiles(files: readonly string[], options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
  screenshot(options?: { type?: "png" | "jpeg"; quality?: number; timeout?: number }): Promise<Uint8Array>;
}

interface PlaywrightConsoleMessageLike {
  type(): string;
  text(): string;
  location(): { url?: string } | undefined;
}

interface PlaywrightDialogLike {
  type(): string;
  message(): string;
  defaultValue(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

interface PlaywrightRequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  failure(): { errorText?: string } | null;
}

interface PlaywrightResponseLike {
  url(): string;
  status(): number;
  request(): PlaywrightRequestLike;
}

interface PlaywrightDownloadLike {
  suggestedFilename(): string;
  url(): string;
  saveAs(path: string): Promise<void>;
  failure(): Promise<string | null>;
  path(): Promise<string | null>;
}

interface PlaywrightCookieLike {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  pages(): PlaywrightPageLike[];
  cookies(): Promise<PlaywrightCookieLike[]>;
  addCookies(cookies: readonly CookieInput[]): Promise<void>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
}

interface PlaywrightPageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<PlaywrightResponseLike | null>;
  goBack(options?: { waitUntil?: string; timeout?: number }): Promise<PlaywrightResponseLike | null>;
  goForward(options?: { waitUntil?: string; timeout?: number }): Promise<PlaywrightResponseLike | null>;
  reload(options?: { waitUntil?: string; timeout?: number }): Promise<PlaywrightResponseLike | null>;
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  evaluate<T = unknown>(pageFunction: unknown, arg?: unknown): Promise<T>;
  locator(selector: string): PlaywrightLocatorLike;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): PlaywrightLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): PlaywrightLocatorLike;
  getByLabel(text: string, options?: { exact?: boolean }): PlaywrightLocatorLike;
  getByPlaceholder(text: string, options?: { exact?: boolean }): PlaywrightLocatorLike;
  getByAltText(text: string, options?: { exact?: boolean }): PlaywrightLocatorLike;
  getByTitle(text: string, options?: { exact?: boolean }): PlaywrightLocatorLike;
  getByTestId(testId: string): PlaywrightLocatorLike;
  screenshot(options?: {
    fullPage?: boolean;
    type?: "png" | "jpeg";
    quality?: number;
    timeout?: number;
  }): Promise<Uint8Array>;
  waitForURL(
    url: string | RegExp | ((url: URL) => boolean),
    options?: { timeout?: number },
  ): Promise<void>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  on(event: "console", handler: (message: PlaywrightConsoleMessageLike) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "dialog", handler: (dialog: PlaywrightDialogLike) => void): void;
  on(event: "request", handler: (request: PlaywrightRequestLike) => void): void;
  on(event: "response", handler: (response: PlaywrightResponseLike) => void): void;
  on(event: "requestfailed", handler: (request: PlaywrightRequestLike) => void): void;
  on(event: "download", handler: (download: PlaywrightDownloadLike) => void): void;
  on(event: "close", handler: () => void): void;
  isClosed(): boolean;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
}

interface PlaywrightBrowserLike {
  newContext(options?: { viewport?: BrowseViewport }): Promise<PlaywrightContextLike>;
  contexts(): PlaywrightContextLike[];
  close(): Promise<void>;
  isConnected(): boolean;
}

interface PlaywrightBrowserTypeLike {
  launch(options?: {
    headless?: boolean;
    args?: string[];
    timeout?: number;
    chromiumSandbox?: boolean;
    viewport?: BrowseViewport;
  }): Promise<PlaywrightBrowserLike>;
  connectOverCDP(endpointURL: string, options?: { timeout?: number }): Promise<PlaywrightBrowserLike>;
}

interface PlaywrightModuleLike {
  chromium?: PlaywrightBrowserTypeLike;
  firefox?: PlaywrightBrowserTypeLike;
  webkit?: PlaywrightBrowserTypeLike;
}

// ── Factory and launch ───────────────────────────────────────────────────────

/**
 * The installed Playwright version, read from the resolved module's manifest.
 *
 * Resolution already proved the package exists; this only answers "which
 * version" for `browse_status`, and a manifest that cannot be read simply
 * leaves the version unknown rather than failing the status call.
 */
function resolvedModuleVersion(resolvedPath: string | undefined): string | undefined {
  if (resolvedPath === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(resolvedPath), "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null) return undefined;
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" && version.trim() !== "" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The default driver factory.
 *
 * `status()` resolves the module without loading it and reads the installed
 * version from the package manifest; `launch()` is the only place a browser
 * process is created.
 */
export const playwrightDriverFactory: BrowseDriverFactory = {
  status(): DriverStatus {
    const availability = detectPlaywright();
    const version = resolvedModuleVersion(availability.resolvedPath);
    return {
      available: availability.available,
      resolvedPath: availability.resolvedPath,
      ...(version === undefined ? {} : { version }),
      reason: availability.reason,
      browsersPath: availability.browsersPath,
      chromiumInstalled: availability.chromiumInstalled,
      guidance: availability.guidance,
    };
  },
  launch(options?: BrowseLaunchOptions): Promise<BrowseDriver> {
    return launchPlaywrightDriver(options);
  },
};

/**
 * Launch a browser (or attach to one over CDP) and return its driver.
 *
 * Playwright is imported here, at the boundary, and only here. A missing module
 * or browser is a {@link BrowseError} with the install command as its hint.
 */
export async function launchPlaywrightDriver(options: BrowseLaunchOptions = {}): Promise<BrowseDriver> {
  const availability = detectPlaywright();
  if (!availability.available) {
    throw browseError(
      "driver_unavailable",
      availability.reason ?? "the playwright module is not available",
      availability.guidance,
    );
  }

  let module: PlaywrightModuleLike;
  try {
    // The one assertion at this boundary: the ambient declaration is too narrow,
    // so the import result is narrowed to the contract used in this file.
    module = (await import("playwright")) as unknown as PlaywrightModuleLike;
  } catch (error) {
    throw browseError(
      "driver_unavailable",
      `the playwright module resolved but could not be loaded (${errorMessage(error)})`,
      availability.guidance,
      error,
    );
  }

  const engine: BrowseEngine = options.engine ?? "chromium";
  const browserType = module[engine];
  if (browserType === undefined) {
    throw browseError(
      "driver_unavailable",
      `playwright exposes no ${engine} browser type`,
      "Use engine=chromium, firefox or webkit.",
    );
  }

  const viewport = options.viewport ?? DEFAULT_BROWSE_VIEWPORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSE_TIMEOUT_MS;
  const launchTimeout = DEFAULT_BROWSE_LAUNCH_TIMEOUT_MS;
  const cdpUrl = options.cdpUrl?.trim();

  if (cdpUrl !== undefined && cdpUrl !== "") {
    if (engine !== "chromium") {
      throw browseError(
        "browser_launch_failed",
        `CDP attach is only available for chromium, not ${engine}`,
        "Use engine=chromium with cdp_url, or launch a browser instead of attaching.",
      );
    }
    let browser: PlaywrightBrowserLike;
    try {
      browser = await browserType.connectOverCDP(cdpUrl, { timeout: launchTimeout });
    } catch (error) {
      throw browseError(
        "browser_launch_failed",
        `could not attach to the Chromium at ${cdpUrl} (${firstSentence(errorMessage(error))})`,
        "Check that the endpoint is running and reachable, or launch a browser instead of attaching.",
        error,
      );
    }
    // Attach mode: reuse the existing context so cookies/logins survive. Only
    // create one when the browser has none; never close the browser itself.
    const existing = browser.contexts()[0];
    const context = existing ?? await browser.newContext({ viewport });
    return new PlaywrightBrowserDriver({
      engine,
      browser,
      context,
      owned: false,
      contextOwned: existing === undefined,
      viewport,
      downloadsDirectory: options.downloadsDirectory,
      timeoutMs,
    });
  }

  let browser: PlaywrightBrowserLike;
  try {
    browser = await browserType.launch({
      headless: options.headless !== false,
      // The automation flag is Chromium-specific; other engines ignore args at
      // best and can fail at worst.
      ...(engine === "chromium" ? { args: [AUTOMATION_CONTROLLED_ARG] } : {}),
      // Playwright's own Chromium default is no sandbox; this family keeps it on
      // unless a host explicitly opts out for a constrained environment.
      ...(engine === "chromium" ? { chromiumSandbox: options.chromiumSandbox !== false } : {}),
      timeout: launchTimeout,
      viewport,
    });
  } catch (error) {
    throw mapLaunchError(error, engine);
  }

  let context: PlaywrightContextLike;
  try {
    context = await browser.newContext({ viewport });
  } catch (error) {
    await closeQuietly(() => browser.close());
    throw mapLaunchError(error, engine);
  }

  return new PlaywrightBrowserDriver({
    engine,
    browser,
    context,
    owned: true,
    contextOwned: true,
    viewport,
    downloadsDirectory: options.downloadsDirectory,
    timeoutMs,
  });
}

// ── Error translation ────────────────────────────────────────────────────────

/** The message of any caught value, without a stack. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line of a message, clipped — long Playwright errors are multi-line. */
function firstSentence(value: string): string {
  const line = value.split("\n")[0]?.trim() ?? value;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

/** Whether an error came from Playwright's timeout machinery. */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  return error.message.includes("Timeout") && error.message.includes("exceeded");
}

function mapEvaluationError(error: unknown): BrowseError {
  if (error instanceof BrowseError) return error;
  if (error instanceof Error && ["TimeoutError", "TargetClosedError", "ProtocolError"].includes(error.name)) {
    return mapPlaywrightError(error, "evaluate the expression");
  }
  const message = errorMessage(error);
  const detail = message.replace(/^(?:page|frame)\.evaluate:\s*/, "").replace(/^Evaluation failed:\s*/, "");
  const scriptError = /^(?:Error|[\w$]+(?:Error|Exception)):/.test(detail)
    || /\bUtilityScript\.evaluate\b|__playwright_evaluation_script__/.test(message);
  if (scriptError) {
    let hint = "Inspect expression and the current page with browse_snapshot; handle the thrown exception or rejected Promise before evaluating again.";
    if (/^TypeError:/.test(detail) && /\b(?:null|undefined)\b/.test(detail)) {
      hint = "Check the selected page and DOM selector with browse_snapshot; wait for the element with browse_wait and guard null or undefined before accessing its properties.";
    } else if (/^SyntaxError:/.test(detail)) {
      hint = "Fix the JavaScript syntax in expression before evaluating again.";
    } else if (/^ReferenceError:/.test(detail)) {
      hint = "Check variable names and page globals in expression; values from the host process are not available in the page.";
    }
    return browseError(
      "script_error",
      `the page script threw an exception (${firstSentence(message)})`,
      hint,
      error,
    );
  }
  if (/execution context (?:was destroyed|is not available)|cannot find context with (?:specified )?id|frame was detached/i.test(detail)) {
    return browseError(
      "execution_context_destroyed",
      `the page execution context became unavailable (${firstSentence(message)})`,
      "Wait for navigation to finish, then call browse_snapshot to confirm the selected page before evaluating again.",
      error,
    );
  }
  return mapPlaywrightError(error, "evaluate the expression");
}

/**
 * Translate any Playwright failure into a {@link BrowseError}.
 *
 * Codes are chosen so a model can act: `timeout` waits or re-snapshots,
 * `ambiguous_target` switches to a ref, `browser_closed` opens a new page,
 * `invalid_target` fixes the selector, `navigation_failed` fixes the URL.
 */
export function mapPlaywrightError(error: unknown, action: string): BrowseError {
  if (error instanceof BrowseError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();

  if (isTimeoutError(error)) {
    return browseError(
      "timeout",
      `${action} timed out (${firstSentence(message)})`,
      "Wait for the page to settle, raise timeout_ms, or call browse_snapshot to see the current state.",
      error,
    );
  }
  if (lower.includes("strict mode violation")) {
    return browseError(
      "ambiguous_target",
      `${action} matched more than one element (${firstSentence(message)})`,
      "Call browse_snapshot and use the element ref (for example e12) so exactly one element is targeted.",
      error,
    );
  }
  if (lower.includes("not a valid selector") || lower.includes("while parsing css selector")
    || (lower.includes("unexpected token") && lower.includes("selector"))) {
    return browseError(
      "invalid_target",
      `${action} received an invalid CSS selector (${firstSentence(message)})`,
      "Pass a plain CSS selector such as css=#submit, or use a ref from browse_snapshot.",
      error,
    );
  }
  if (lower.includes("has been closed") || lower.includes("target closed")
    || lower.includes("browser has been closed") || lower.includes("target page, context or browser")) {
    return browseError(
      "browser_closed",
      `${action} could not run because the page or browser is closed (${firstSentence(message)})`,
      "Open a page again with browse_tabs action=new, or start a new session.",
      error,
    );
  }
  if (lower.includes("element is not attached") || lower.includes("not attached to the dom")) {
    return browseError(
      "stale_ref",
      `${action} hit an element that is no longer in the DOM (${firstSentence(message)})`,
      "Call browse_snapshot again to refresh element refs, then retry.",
      error,
    );
  }
  if (lower.includes("executable doesn't exist") || lower.includes("is not installed")
    || lower.includes("browser is not installed")) {
    return browseError(
      "browser_launch_failed",
      `${action} failed because the browser binary is missing (${firstSentence(message)})`,
      "Run `npx playwright install chromium` (or the engine you selected) and retry.",
      error,
    );
  }
  if (lower.includes("net::err") || lower.includes("ns_error") || lower.includes("navigation failed")
    || lower.includes("cannot navigate to invalid url")) {
    return browseError(
      "navigation_failed",
      `${action} could not complete the navigation (${firstSentence(message)})`,
      "Check the URL, whether the site is reachable, and whether it refuses automated access.",
      error,
    );
  }
  return browseError(
    "protocol_error",
    `${action} failed (${firstSentence(message)})`,
    "Retry; if it persists, call browse_status to check the driver and the page state.",
    error,
  );
}

/** Launch failures get install/sandbox guidance instead of a generic retry. */
function mapLaunchError(error: unknown, engine: BrowseEngine): BrowseError {
  if (error instanceof BrowseError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes("executable doesn't exist") || lower.includes("browser is not installed")
    || lower.includes("is not installed") || lower.includes("playwright install")) {
    return browseError(
      "browser_launch_failed",
      `could not start ${engine}: ${firstSentence(message)}`,
      `Run \`npx playwright install ${engine}\` and retry.`,
      error,
    );
  }
  if (lower.includes("sandbox") || lower.includes("operation not permitted")
    || lower.includes("permission denied") || lower.includes("failed to launch")) {
    return browseError(
      "browser_launch_failed",
      `could not start ${engine}: ${firstSentence(message)}`,
      "This host may forbid the browser's own sandbox or require a display; check its permissions, or retry with chromium_sandbox=false only where that risk is acceptable.",
      error,
    );
  }
  return browseError(
    "browser_launch_failed",
    `could not start ${engine}: ${firstSentence(message)}`,
    `Check that this process may launch a browser and that \`npx playwright install ${engine}\` has completed.`,
    error,
  );
}

/** Close a resource without letting a close failure mask the real result. */
async function closeQuietly(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch {
    // A close failure on an already-dead resource carries no useful information.
  }
}

// ── Browser driver ───────────────────────────────────────────────────────────

interface BrowserDriverOptions {
  engine: BrowseEngine;
  browser: PlaywrightBrowserLike;
  context: PlaywrightContextLike;
  owned: boolean;
  contextOwned: boolean;
  viewport: BrowseViewport;
  downloadsDirectory?: string;
  timeoutMs: number;
}

/** One launched (or attached) browser and the pages this driver created. */
class PlaywrightBrowserDriver implements BrowseDriver {
  readonly engine: BrowseEngine;
  readonly owned: boolean;
  private readonly browser: PlaywrightBrowserLike;
  private readonly context: PlaywrightContextLike;
  private readonly contextOwned: boolean;
  private readonly downloadsDirectory?: string;
  private readonly timeoutMs: number;
  private readonly pages = new Set<BrowsePageDriver>();
  private closed = false;

  constructor(options: BrowserDriverOptions) {
    this.engine = options.engine;
    this.owned = options.owned;
    this.browser = options.browser;
    this.context = options.context;
    this.contextOwned = options.contextOwned;
    this.downloadsDirectory = options.downloadsDirectory;
    this.timeoutMs = options.timeoutMs;
  }

  async newPage(buffers?: BrowsePageBuffers): Promise<BrowsePageDriver> {
    if (this.closed) {
      throw browseError("browser_closed", "the browser is closed", "Launch the session again to open a page.");
    }
    let page: PlaywrightPageLike;
    try {
      page = await this.context.newPage();
    } catch (error) {
      throw mapPlaywrightError(error, "open a page");
    }
    const driver = new PlaywrightPageDriver(page, this.context, {
      downloadsDirectory: this.downloadsDirectory,
      timeoutMs: this.timeoutMs,
      buffers,
    });
    this.pages.add(driver);
    return driver;
  }

  async closePage(page: BrowsePageDriver): Promise<void> {
    this.pages.delete(page);
    await page.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of [...this.pages]) {
      await closeQuietly(() => page.close());
    }
    this.pages.clear();
    if (this.contextOwned) await closeQuietly(() => this.context.close());
    // Playwright closes an owned browser, but only disconnects a connectOverCDP client.
    await closeQuietly(() => this.browser.close());
  }
}

// ── Page driver ──────────────────────────────────────────────────────────────

interface PageDriverOptions {
  downloadsDirectory?: string;
  timeoutMs: number;
  buffers?: BrowsePageBuffers;
}

/** One Playwright page, exposed only through {@link BrowsePageDriver}. */
class PlaywrightPageDriver implements BrowsePageDriver {
  readonly buffers: BrowsePageBuffers;
  private readonly page: PlaywrightPageLike;
  private readonly context: PlaywrightContextLike;
  private readonly downloadsDirectory?: string;
  private readonly timeoutMs: number;
  private pendingDialog: PlaywrightDialogLike | null = null;
  /** Actions waiting to be told that a dialog has just blocked the page. */
  private readonly dialogWaiters = new Set<(dialog: PlaywrightDialogLike) => void>();
  private closed = false;
  private downloadSequence = 0;

  constructor(page: PlaywrightPageLike, context: PlaywrightContextLike, options: PageDriverOptions) {
    this.page = page;
    this.context = context;
    this.downloadsDirectory = options.downloadsDirectory;
    this.timeoutMs = options.timeoutMs;
    this.buffers = options.buffers ?? createBrowsePageBuffers();
    this.attachListeners();
  }

  // ── Event capture ──

  private attachListeners(): void {
    this.page.on("console", message => {
      this.buffers.console.push({
        kind: "console",
        level: message.type(),
        text: message.text(),
        url: message.location()?.url ?? this.safeUrl(),
        timestamp: Date.now(),
      });
    });
    this.page.on("pageerror", error => {
      this.buffers.console.push({
        kind: "pageerror",
        level: "error",
        text: `${error.name}: ${error.message}`,
        url: this.safeUrl(),
        timestamp: Date.now(),
      });
    });
    this.page.on("dialog", dialog => {
      // Record only: accepting here would make a confirm() unanswerable and hide
      // the decision from the model. Every other action now refuses until the
      // session resolves it.
      this.pendingDialog = dialog;
      let type = "dialog";
      let message = "";
      try {
        type = dialog.type();
        message = dialog.message();
      } catch {
        // The dialog vanished between the event and this read.
      }
      this.buffers.console.push({
        kind: "dialog",
        level: type,
        text: message,
        url: this.safeUrl(),
        timestamp: Date.now(),
      });
      // The Playwright call that triggered the dialog is now blocked until it is
      // handled. Tell the waiting action immediately instead of letting it sit
      // until its timeout.
      for (const waiter of [...this.dialogWaiters]) waiter(dialog);
    });
    this.page.on("request", request => {
      this.buffers.network.push({
        event: "request",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        timestamp: Date.now(),
      });
    });
    this.page.on("response", response => {
      this.buffers.network.push({
        event: "response",
        method: response.request().method(),
        url: response.url(),
        resourceType: response.request().resourceType(),
        status: response.status(),
        ok: response.status() < 400,
        timestamp: Date.now(),
      });
    });
    this.page.on("requestfailed", request => {
      this.buffers.network.push({
        event: "failed",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText ?? "request failed",
        timestamp: Date.now(),
      });
    });
    this.page.on("download", download => {
      void this.saveDownload(download);
    });
    this.page.on("close", () => {
      this.closed = true;
      this.pendingDialog = null;
      this.dialogWaiters.clear();
    });
  }

  private async saveDownload(download: PlaywrightDownloadLike): Promise<void> {
    const filename = download.suggestedFilename() || "download";
    const url = download.url();
    const timestamp = Date.now();
    let savedPath: string | undefined;
    let bytes: number | undefined;
    let status: "completed" | "failed" = "failed";
    let errorText: string | undefined;
    try {
      if (this.downloadsDirectory !== undefined) {
        mkdirSync(this.downloadsDirectory, { recursive: true, mode: 0o700 });
        savedPath = join(this.downloadsDirectory, this.downloadFileName(filename));
        await download.saveAs(savedPath);
      } else {
        savedPath = (await download.path()) ?? undefined;
      }
      const failure = await download.failure();
      if (failure !== null) {
        errorText = failure;
      } else {
        status = "completed";
      }
      if (savedPath !== undefined && existsSync(savedPath)) bytes = statSync(savedPath).size;
    } catch (error) {
      errorText = errorMessage(error);
    }
    this.buffers.downloads.push({ filename, url, path: savedPath, bytes, status, error: errorText, timestamp });
  }

  private downloadFileName(suggested: string): string {
    this.downloadSequence += 1;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
    const safe = basename(suggested).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "download";
    return `${stamp}-${String(this.downloadSequence).padStart(3, "0")}-${safe}`;
  }

  // ── Guards ──

  private safeUrl(): string {
    try {
      return this.page.url();
    } catch {
      return "";
    }
  }

  private async safeTitle(): Promise<string> {
    // A blocking dialog also blocks title evaluation; report no title rather
    // than making a tab listing wait out the page timeout.
    if (this.pendingDialog !== null) return "";
    try {
      return await this.page.title();
    } catch {
      return "";
    }
  }

  /** Refuse to act on a closed page or while a dialog blocks it. */
  private assertReady(action: string): void {
    if (this.isClosed()) {
      throw browseError(
        "no_such_page",
        `cannot ${action}: the page is closed`,
        "Open a page with browse_tabs action=new, then retry.",
      );
    }
    if (this.pendingDialog !== null) {
      let type = "dialog";
      let message = "";
      try {
        type = this.pendingDialog.type();
        message = this.pendingDialog.message();
      } catch {
        // Fall back to the generic names below.
      }
      throw browseError(
        "dialog_open",
        `cannot ${action} while a ${type} dialog is open${message === "" ? "" : ` ("${message.slice(0, 200)}")`}`,
        "Handle it first with browse_dialog accept=true or accept=false (dismiss).",
      );
    }
  }

  /**
   * Run one page operation, translating its failure.
   *
   * The operation races the page's dialog signal: a `confirm()`/`alert()`/
   * `prompt()` opened by this very action leaves the Playwright call blocked
   * until someone handles it, so the action reports `dialog_open` at once rather
   * than waiting out its timeout. The blocked call is left to finish after the
   * dialog is handled; its late outcome is not this call's to report.
   */
  private async run<T>(action: string, operation: () => Promise<T>): Promise<T> {
    const signal = this.dialogSignal(action);
    try {
      const work = operation();
      work.catch(() => undefined);
      return await Promise.race([work, signal.promise]);
    } catch (error) {
      throw mapPlaywrightError(error, action);
    } finally {
      signal.cancel();
    }
  }

  /** A promise that rejects with `dialog_open` when the next dialog appears. */
  private dialogSignal(action: string): { promise: Promise<never>; cancel: () => void } {
    let waiter: ((dialog: PlaywrightDialogLike) => void) | undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      waiter = dialog => {
        let type = "dialog";
        let message = "";
        try {
          type = dialog.type();
          message = dialog.message();
        } catch {
          // Fall back to the generic names below.
        }
        reject(browseError(
          "dialog_open",
          `${action} opened a ${type} dialog${message === "" ? "" : ` ("${message.slice(0, 200)}")`}`,
          "Handle it with browse_dialog accept=true or accept=false (dismiss); the page stays blocked until then.",
        ));
      };
      this.dialogWaiters.add(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (waiter !== undefined) this.dialogWaiters.delete(waiter);
      },
    };
  }

  // ── Navigation ──

  async goto(url: string, options?: NavigateOptions): Promise<NavigationResult> {
    this.assertReady("navigate");
    if (url.trim() === "") {
      throw browseError("navigation_failed", "the URL to navigate to is empty", "Pass an absolute URL such as https://example.com.");
    }
    const response = await this.run(`navigate to ${url}`, () => this.page.goto(url, {
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return { url: this.safeUrl(), title: await this.safeTitle(), status: response?.status() ?? null };
  }

  async back(options?: NavigateOptions): Promise<NavigationResult> {
    this.assertReady("go back");
    await this.run("go back", () => this.page.goBack({
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return { url: this.safeUrl(), title: await this.safeTitle(), status: null };
  }

  async forward(options?: NavigateOptions): Promise<NavigationResult> {
    this.assertReady("go forward");
    await this.run("go forward", () => this.page.goForward({
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return { url: this.safeUrl(), title: await this.safeTitle(), status: null };
  }

  async reload(options?: NavigateOptions): Promise<NavigationResult> {
    this.assertReady("reload");
    const response = await this.run("reload", () => this.page.reload({
      waitUntil: options?.waitUntil ?? "domcontentloaded",
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return { url: this.safeUrl(), title: await this.safeTitle(), status: response?.status() ?? null };
  }

  url(): string {
    return this.safeUrl();
  }

  async title(): Promise<string> {
    return this.safeTitle();
  }

  async waitForLoadState(state: LoadState = "load", options?: { timeoutMs?: number }): Promise<void> {
    this.assertReady("wait for the page");
    await this.run("wait for the page", () => this.page.waitForLoadState(state, {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
  }

  // ── Snapshot and read ──

  async snapshot(options?: SnapshotOptions): Promise<BrowseSnapshot> {
    this.assertReady("snapshot");
    // A capped snapshot cannot print more refs than characters; reserve before awaiting concurrent pages.
    const serialized = { ...serializeSnapshotOptions(options), refOffset: nextSnapshotRefOffset };
    nextSnapshotRefOffset += SNAPSHOT_MAX_CHARS;
    const payload = await this.run("snapshot the page", () => this.page.evaluate(
      browseSnapshotWalker,
      serialized,
    ) as Promise<unknown>);
    if (!isSnapshotPayload(payload)) {
      throw browseError(
        "protocol_error",
        "the page returned a malformed snapshot payload",
        "Reload the page and call browse_snapshot again.",
      );
    }
    if (payload.error === "invalid_selector") {
      throw browseError(
        "invalid_target",
        `the snapshot selector "${serialized.selector ?? ""}" is not valid CSS`,
        "Pass a plain CSS selector such as css=#main, or omit the selector to snapshot the whole page.",
      );
    }
    if (!payload.matched) {
      throw browseError(
        "element_not_found",
        `no element matches the snapshot selector "${serialized.selector ?? ""}"`,
        "Call browse_snapshot without a selector to see the page, then choose a selector that exists.",
      );
    }
    let text = payload.text;
    if (payload.truncated && !text.includes("[... truncated:")) {
      text = `${text === "" ? "" : `${text}\n`}${formatTruncationMarker(payload.truncatedNodes)}`;
    }
    return {
      ...snapshotResultFromPayload(payload, this.safeUrl(), await this.safeTitle()),
      refs: payload.refs,
    };
  }

  async read(format: ReadFormat, options?: ReadOptions): Promise<ReadResult> {
    this.assertReady("read the page");
    const selector = options?.selector?.trim() === "" ? null : options?.selector ?? null;
    const maxChars = clampReadMaxChars(options?.maxChars);
    let raw: string;
    switch (format) {
      case "html":
        raw = await this.readHtml(selector);
        break;
      case "text":
        raw = await this.readText(selector);
        break;
      case "markdown":
        raw = convertHtmlToMarkdown(await this.readHtml(selector), this.safeUrl());
        break;
      case "links":
        raw = await this.readLinks(selector);
        break;
      case "table":
        raw = await this.readTables(selector);
        break;
      default:
        throw browseError(
          "invalid_target",
          `unknown read format "${String(format)}"`,
          "Use markdown, text, html, links or table.",
        );
    }
    const { content, truncated } = truncateReadContent(raw, maxChars);
    return { format, content, url: this.safeUrl(), title: await this.safeTitle(), truncated };
  }

  private async readHtml(selector: string | null): Promise<string> {
    const html = await this.run("read the page as HTML", () => this.page.evaluate((scope: string | null) => {
      if (scope === null) return document.documentElement?.outerHTML ?? "";
      const element = document.querySelector(scope);
      return element === null ? null : element.outerHTML;
    }, selector) as Promise<string | null>);
    if (html === null) {
      throw browseError(
        "element_not_found",
        `no element matches the read selector "${selector ?? ""}"`,
        "Call browse_read without a selector, or use a selector that exists.",
      );
    }
    return html;
  }

  private async readText(selector: string | null): Promise<string> {
    const text = await this.run("read the page as text", () => this.page.evaluate((scope: string | null) => {
      const element = scope === null ? document.body : document.querySelector(scope);
      if (element === null) return null;
      const html = element as HTMLElement;
      return typeof html.innerText === "string" ? html.innerText : element.textContent ?? "";
    }, selector) as Promise<string | null>);
    if (text === null) {
      throw browseError(
        "element_not_found",
        `no element matches the read selector "${selector ?? ""}"`,
        "Call browse_read without a selector, or use a selector that exists.",
      );
    }
    return text;
  }

  private async readLinks(selector: string | null): Promise<string> {
    const links = await this.run("read the page links", () => this.page.evaluate((scope: string | null) => {
      const root = scope === null ? document.body : document.querySelector(scope);
      if (root === null) return null;
      const anchors = root.querySelectorAll("a[href]");
      const out: Array<{ text: string; href: string }> = [];
      for (let index = 0; index < anchors.length; index += 1) {
        const anchor = anchors[index] as HTMLAnchorElement;
        const label = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
        out.push({ text: label.slice(0, 200), href: anchor.href });
      }
      return out;
    }, selector) as Promise<Array<{ text: string; href: string }> | null>);
    if (links === null) {
      throw browseError(
        "element_not_found",
        `no element matches the read selector "${selector ?? ""}"`,
        "Call browse_read without a selector, or use a selector that exists.",
      );
    }
    if (links.length === 0) return "(no links found)";
    return links.map(link => `- [${link.text === "" ? link.href : link.text}](${link.href})`).join("\n");
  }

  private async readTables(selector: string | null): Promise<string> {
    const tables = await this.run("read the page tables", () => this.page.evaluate((scope: string | null) => {
      const root = scope === null ? document.body : document.querySelector(scope);
      if (root === null) return null;
      const nodes = root.querySelectorAll("table");
      const out: string[] = [];
      for (let index = 0; index < nodes.length; index += 1) out.push(nodes[index].outerHTML);
      return out;
    }, selector) as Promise<string[] | null>);
    if (tables === null) {
      throw browseError(
        "element_not_found",
        `no element matches the read selector "${selector ?? ""}"`,
        "Call browse_read without a selector, or use a selector that exists.",
      );
    }
    if (tables.length === 0) return "(no tables found)";
    return tables.map(table => convertHtmlToMarkdown(table)).join("\n\n");
  }

  // ── Actions ──

  private locatorFor(target: TargetPlan): PlaywrightLocatorLike {
    switch (target.kind) {
      case "ref":
        if (!BROWSE_REF_PATTERN.test(target.ref)) {
          throw browseError(
            "invalid_target",
            `"${target.ref}" is not a snapshot ref`,
            "Use a ref exactly as browse_snapshot printed it, for example e12.",
          );
        }
        return this.page.locator(`[data-rolebox-ref="${target.ref}"]`);
      case "css":
        if (target.selector.trim() === "") {
          throw browseError("invalid_target", "the CSS selector is empty", "Pass a selector such as css=#submit.");
        }
        return this.page.locator(target.selector);
      case "text":
        return this.page.getByText(target.text, { exact: false });
      case "role":
        return this.page.getByRole(target.role, target.name === undefined
          ? undefined
          : { name: target.name, exact: false });
      case "label":
        return this.page.getByLabel(target.text, { exact: false });
      case "placeholder":
        return this.page.getByPlaceholder(target.text, { exact: false });
      case "alt":
        return this.page.getByAltText(target.text, { exact: false });
      case "title":
        return this.page.getByTitle(target.text, { exact: false });
      case "testid":
        return this.page.getByTestId(target.testId);
    }
  }

  private async actionResult(
    action: string,
    target: TargetPlan,
    extra: Pick<ActionResult, "value" | "values"> = {},
  ): Promise<ActionResult> {
    return {
      action,
      target: describeTarget(target),
      url: this.safeUrl(),
      title: await this.safeTitle(),
      ...extra,
    };
  }

  async click(target: TargetPlan, options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("click");
    const locator = this.locatorFor(target);
    const repeat = Math.max(1, options?.repeat ?? 1);
    const intervalMs = Math.max(0, options?.intervalMs ?? 0);
    for (let index = 0; index < repeat; index += 1) {
      await this.run(`click ${describeTarget(target)}`, () => locator.click({
        timeout: options?.timeoutMs ?? this.timeoutMs,
        force: options?.force === true,
        ...(options?.button === undefined ? {} : { button: options.button }),
        ...(options?.clickCount === undefined ? {} : { clickCount: options.clickCount }),
        ...(options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }),
        ...(options?.position === undefined ? {} : { position: options.position }),
        ...(options?.delayMs === undefined ? {} : { delay: options.delayMs }),
      }));
      if (index + 1 < repeat && intervalMs > 0) {
        await this.run("wait between clicks", () => this.page.waitForTimeout(intervalMs));
      }
    }
    return this.actionResult("click", target);
  }

  async fill(target: TargetPlan, value: string, options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("fill");
    const locator = this.locatorFor(target);
    await this.run(`fill ${describeTarget(target)}`, () => locator.fill(value, {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return this.actionResult("fill", target, { value });
  }

  async type(target: TargetPlan, text: string, options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("type");
    const locator = this.locatorFor(target);
    await this.run(`type into ${describeTarget(target)}`, () => locator.pressSequentially(text, {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return this.actionResult("type", target, { value: text });
  }

  async press(key: string, target?: TargetPlan, options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("press");
    if (key.trim() === "") {
      throw browseError("invalid_target", "the key to press is empty", "Pass a key such as Enter or Control+A.");
    }
    if (target === undefined) {
      await this.run(`press ${key}`, () => this.page.keyboard.press(key));
      return {
        action: "press",
        target: `key=${key}`,
        url: this.safeUrl(),
        title: await this.safeTitle(),
        value: key,
      };
    }
    const locator = this.locatorFor(target);
    await this.run(`press ${key} on ${describeTarget(target)}`, () => locator.press(key, {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return this.actionResult("press", target, { value: key });
  }

  async select(target: TargetPlan, values: readonly string[], options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("select");
    if (values.length === 0) {
      throw browseError("invalid_target", "no option value was given to select", "Pass at least one option value.");
    }
    const locator = this.locatorFor(target);
    const selected = await this.run(`select ${describeTarget(target)}`, () => locator.selectOption([...values], {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return this.actionResult("select", target, { values: selected });
  }

  async hover(target: TargetPlan, options?: HoverOptions): Promise<ActionResult> {
    this.assertReady("hover");
    const locator = this.locatorFor(target);
    await this.run(`hover ${describeTarget(target)}`, () => locator.hover({
      timeout: options?.timeoutMs ?? this.timeoutMs,
      force: options?.force === true,
      ...(options?.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }),
      ...(options?.position === undefined ? {} : { position: options.position }),
    }));
    const holdMs = Math.max(0, options?.holdMs ?? 0);
    if (holdMs > 0) await this.run("hold the pointer", () => this.page.waitForTimeout(holdMs));
    return this.actionResult("hover", target);
  }

  async drag(source: TargetPlan, target: TargetPlan, options?: DragOptions): Promise<ActionResult> {
    this.assertReady("drag");
    const sourceLocator = this.locatorFor(source);
    const targetLocator = this.locatorFor(target);
    await this.run(
      `drag ${describeTarget(source)} to ${describeTarget(target)}`,
      () => sourceLocator.dragTo(targetLocator, {
        timeout: options?.timeoutMs ?? this.timeoutMs,
        force: options?.force === true,
        ...(options?.sourcePosition === undefined ? {} : { sourcePosition: options.sourcePosition }),
        ...(options?.targetPosition === undefined ? {} : { targetPosition: options.targetPosition }),
        ...(options?.steps === undefined ? {} : { steps: options.steps }),
      }),
    );
    return {
      action: "drag",
      target: `${describeTarget(source)} -> ${describeTarget(target)}`,
      url: this.safeUrl(),
      title: await this.safeTitle(),
    };
  }

  async scroll(options?: ScrollOptions): Promise<ScrollResult> {
    this.assertReady("scroll");
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    if (options?.target !== undefined) {
      const locator = this.locatorFor(options.target);
      await this.run(`scroll to ${describeTarget(options.target)}`, () => locator.scrollIntoViewIfNeeded({ timeout }));
      return { url: this.safeUrl(), title: await this.safeTitle() };
    }
    if (options?.to === "top" || options?.to === "bottom") {
      await this.run(`scroll to the ${options.to}`, () => this.page.evaluate((where: string) => {
        window.scrollTo(0, where === "bottom" ? document.body.scrollHeight : 0);
      }, options.to));
      return { url: this.safeUrl(), title: await this.safeTitle() };
    }
    const deltaX = options?.deltaX ?? 0;
    const deltaY = options?.deltaY ?? 0;
    if (options?.at !== undefined) {
      const at = this.locatorFor(options.at);
      await this.run(`move the pointer to ${describeTarget(options.at)}`, () => at.hover({
        timeout,
        ...(options.atPosition === undefined ? {} : { position: options.atPosition }),
      }));
    }
    await this.run("wheel the page", async () => {
      const pressed: string[] = [];
      try {
        for (const modifier of options?.modifiers ?? []) {
          await this.page.keyboard.down(modifier);
          pressed.push(modifier);
        }
        await this.page.mouse.wheel(deltaX, deltaY);
      } finally {
        for (const modifier of [...pressed].reverse()) {
          try {
            await this.page.keyboard.up(modifier);
          } catch {
            // The page may have closed while the wheel was in flight.
          }
        }
      }
    });
    return { url: this.safeUrl(), title: await this.safeTitle() };
  }

  async wait(options?: WaitOptions): Promise<void> {
    this.assertReady("wait");
    if (options?.target !== undefined) {
      const locator = this.locatorFor(options.target);
      await this.run(`wait for ${describeTarget(options.target)}`, () => locator.waitFor({
        state: "visible",
        timeout: options.timeoutMs ?? this.timeoutMs,
      }));
      return;
    }
    const expectedUrl = options?.url?.trim();
    if (expectedUrl !== undefined && expectedUrl !== "") {
      await this.run(`wait for the URL ${expectedUrl}`, () => this.page.waitForURL(
        candidate => candidate.toString().includes(expectedUrl),
        { timeout: options?.timeoutMs ?? this.timeoutMs },
      ));
      return;
    }
    const milliseconds = Math.min(Math.max(options?.milliseconds ?? 1000, 0), BROWSE_MAX_WAIT_MS);
    await this.run("wait", () => this.page.waitForTimeout(milliseconds));
  }

  async evaluate<T = unknown>(expression: string, arg?: unknown, options?: EvaluateOptions): Promise<T> {
    this.assertReady("evaluate");
    if (expression.trim() === "") {
      throw browseError("invalid_target", "the expression to evaluate is empty", "Pass a JavaScript expression such as document.title.");
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw browseError("cancelled", "the evaluation was cancelled before it ran", "Retry once the host turn is active again.");
    }
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      const stop = (code: "timeout" | "cancelled", message: string) => {
        reject(browseError(code, message, "The page was closed to stop evaluation; reopen it with browse_open."));
        void this.close();
      };
      timer = setTimeout(() => stop("timeout", `the evaluation exceeded ${timeoutMs}ms`), timeoutMs);
      onAbort = () => stop("cancelled", "the evaluation was cancelled by the host turn");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await this.run("evaluate the expression", () => Promise.race([
        this.page.evaluate(expression, arg).catch(error => { throw mapEvaluationError(error); }) as Promise<T>, interrupted,
      ]));
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    this.assertReady("screenshot");
    const mime: ScreenshotResult["mime"] = options?.format === "jpeg" ? "image/jpeg" : "image/png";
    const settings: { type: "png" | "jpeg"; quality?: number; timeout: number } = {
      type: mime === "image/jpeg" ? "jpeg" : "png",
      timeout: options?.timeoutMs ?? this.timeoutMs,
      ...(mime === "image/jpeg" && options?.quality !== undefined ? { quality: options.quality } : {}),
    };
    const selector = options?.selector?.trim();
    const bytes = selector === undefined || selector === ""
      ? await this.run("take a screenshot", () => this.page.screenshot({
        ...settings,
        fullPage: options?.fullPage === true,
      }))
      : await this.run(`take a screenshot of ${selector}`, () => this.page.locator(selector).screenshot(settings));
    return { bytes: new Uint8Array(bytes), mime };
  }

  async upload(target: TargetPlan, files: readonly string[], options?: ActionOptions): Promise<ActionResult> {
    this.assertReady("upload");
    if (files.length === 0) {
      throw browseError("invalid_target", "no file was given to upload", "Pass at least one absolute path to an existing file.");
    }
    for (const file of files) {
      if (!existsSync(file)) {
        throw browseError(
          "file_not_found",
          `the upload file "${file}" does not exist`,
          "Pass an absolute path to a file that exists on this machine.",
        );
      }
      if (!statSync(file).isFile()) {
        throw browseError(
          "file_not_found",
          `the upload path "${file}" is not a file`,
          "Pass an absolute path to a regular file.",
        );
      }
    }
    const locator = this.locatorFor(target);
    await this.run(`upload to ${describeTarget(target)}`, () => locator.setInputFiles([...files], {
      timeout: options?.timeoutMs ?? this.timeoutMs,
    }));
    return this.actionResult("upload", target, { values: [...files] });
  }

  // ── Cookies ──

  async cookies(): Promise<CookieRecord[]> {
    this.assertReady("read cookies");
    const cookies = await this.run("read cookies", () => this.context.cookies());
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    }));
  }

  async setCookies(cookies: readonly CookieInput[]): Promise<void> {
    this.assertReady("set cookies");
    for (const cookie of cookies) {
      if (cookie.url === undefined && cookie.domain === undefined) {
        throw browseError(
          "invalid_target",
          `cookie "${cookie.name}" has neither a url nor a domain`,
          "Give each cookie a url, or a domain together with a path.",
        );
      }
    }
    await this.run("set cookies", () => this.context.addCookies(cookies));
  }

  async clearCookies(): Promise<void> {
    this.assertReady("clear cookies");
    await this.run("clear cookies", () => this.context.clearCookies());
  }

  // ── Buffers and dialogs ──

  clearBuffers(kind?: BrowseBufferKind): void {
    if (kind === undefined) {
      this.buffers.console.clear();
      this.buffers.network.clear();
      this.buffers.downloads.clear();
      return;
    }
    this.buffers[kind].clear();
  }

  async dialog(): Promise<DialogState | null> {
    const dialog = this.pendingDialog;
    if (dialog === null) return null;
    let type = "dialog";
    let message = "";
    let defaultValue = "";
    try {
      type = dialog.type();
      message = dialog.message();
      defaultValue = dialog.defaultValue();
    } catch {
      // The dialog was already dismissed by the page.
    }
    return { type, message, defaultValue, open: true };
  }

  async acceptDialog(promptText?: string): Promise<void> {
    const dialog = this.requireDialog("accept");
    try {
      await this.run("accept the dialog", () => promptText === undefined ? dialog.accept() : dialog.accept(promptText));
    } finally {
      this.pendingDialog = null;
    }
  }

  async dismissDialog(): Promise<void> {
    const dialog = this.requireDialog("dismiss");
    try {
      await this.run("dismiss the dialog", () => dialog.dismiss());
    } finally {
      this.pendingDialog = null;
    }
  }

  private requireDialog(action: string): PlaywrightDialogLike {
    if (this.pendingDialog === null) {
      throw browseError(
        "dialog_missing",
        `cannot ${action} a dialog because none is open`,
        "Call browse_dialog to inspect the page; the dialog may already have been handled.",
      );
    }
    return this.pendingDialog;
  }

  isClosed(): boolean {
    return this.closed || this.page.isClosed();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingDialog = null;
    await closeQuietly(() => this.page.close());
  }
}

// ── Read helpers ─────────────────────────────────────────────────────────────

/** Clamp a requested read cap into `[1, READ_MAX_CHARS]`. */
export function clampReadMaxChars(value?: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return READ_DEFAULT_MAX_CHARS;
  return Math.min(Math.max(Math.trunc(value), 1), READ_MAX_CHARS);
}

/**
 * Cut read content to the cap at a line boundary when one is close enough, so a
 * markdown table or code block is not split through the middle.
 */
export function truncateReadContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  const head = content.slice(0, maxChars);
  const lastNewline = head.lastIndexOf("\n");
  const cut = lastNewline > maxChars * 0.8 ? head.slice(0, lastNewline) : head;
  const remaining = content.length - cut.length;
  return {
    content: `${cut}\n\n[... truncated: ${remaining} more characters]`,
    truncated: true,
  };
}
