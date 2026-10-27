/**
 * A complete in-memory stand-in for the browser-driver port.
 *
 * Session tests need the driver contract without a browser: this fake records the
 * calls the session layer makes, exposes the same capped buffers a real page
 * driver owns, supports a configurable delay (to prove the session serializes its
 * queue) and can be told to fail a click the way Playwright does when a ref's
 * element has been removed. No test that imports this file launches anything.
 */

import {
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
  type BrowseSnapshot,
  type CookieInput,
  type CookieRecord,
  type DialogState,
  type DownloadEntry,
  type DragOptions,
  type DriverStatus,
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
  type SnapshotRef,
  type TargetPlan,
  type WaitOptions,
} from "../../../src/browse/types.ts";
import { describeTarget } from "../../../src/browse/target.ts";

/** A minimal PNG signature plus IHDR, enough for byte-shape assertions. */
export const FAKE_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

/** One fake page. */
export class FakePageDriver implements BrowsePageDriver {
  readonly buffers: BrowsePageBuffers;
  readonly calls: string[] = [];
  readonly clickTargets: TargetPlan[] = [];
  readonly clickOptions: Array<ActionOptions | undefined> = [];
  readonly hoverOptions: Array<HoverOptions | undefined> = [];
  readonly scrollOptions: Array<ScrollOptions | undefined> = [];
  readonly dragCalls: Array<{ source: TargetPlan; target: TargetPlan; options?: DragOptions }> = [];
  readonly acceptedDialogs: Array<string | undefined> = [];
  readonly writtenCookies: Array<readonly CookieInput[]> = [];
  readonly uploadedFiles: string[] = [];
  readonly evaluatedExpressions: string[] = [];

  currentUrl = "about:blank";
  titleText = "Fake page";
  snapshotText = "";
  snapshotRefs: SnapshotRef[] = [];
  clickError: unknown = null;
  dragError: unknown = null;
  dialogState: DialogState | null = null;
  cookiesValue: CookieRecord[] = [];
  screenshotResult: ScreenshotResult = { bytes: FAKE_PNG_BYTES, mime: "image/png" };
  evaluateResult: unknown = undefined;

  closed = false;
  inFlight = 0;
  maxConcurrent = 0;
  dismissCount = 0;
  closeCount = 0;
  readFormats: ReadFormat[] = [];

  /** Milliseconds every async operation takes, to exercise the session queue. */
  delayMs = 0;

  constructor(delayMs = 0, buffers?: BrowsePageBuffers) {
    this.delayMs = delayMs;
    this.buffers = buffers ?? createBrowsePageBuffers();
  }

  private async operation<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    this.calls.push(name);
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      await delay(this.delayMs);
      return await work();
    } finally {
      this.inFlight -= 1;
    }
  }

  private async action(action: string, target: TargetPlan): Promise<ActionResult> {
    return {
      action,
      target: describeTarget(target),
      url: this.currentUrl,
      title: this.titleText,
    };
  }

  async goto(url: string, _options?: NavigateOptions): Promise<NavigationResult> {
    return this.operation("goto", () => {
      this.currentUrl = url;
      return { url, title: this.titleText, status: 200 };
    });
  }

  async back(_options?: NavigateOptions): Promise<NavigationResult> {
    return this.operation("back", () => ({ url: this.currentUrl, title: this.titleText, status: null }));
  }

  async forward(_options?: NavigateOptions): Promise<NavigationResult> {
    return this.operation("forward", () => ({ url: this.currentUrl, title: this.titleText, status: null }));
  }

  async reload(_options?: NavigateOptions): Promise<NavigationResult> {
    return this.operation("reload", () => ({ url: this.currentUrl, title: this.titleText, status: 200 }));
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.titleText;
  }

  async waitForLoadState(_state?: LoadState, _options?: { timeoutMs?: number }): Promise<void> {
    await this.operation("waitForLoadState", () => undefined);
  }

  async snapshot(options?: SnapshotOptions): Promise<BrowseSnapshot> {
    return this.operation("snapshot", () => {
      this.calls.push(`snapshot:${options?.selector ?? "page"}`);
      return {
        text: this.snapshotText,
        nodeCount: this.snapshotText === "" ? 0 : this.snapshotText.split("\n").length,
        refCount: this.snapshotRefs.length,
        truncated: false,
        url: this.currentUrl,
        title: this.titleText,
        refs: [...this.snapshotRefs],
      };
    });
  }

  async read(format: ReadFormat, _options?: ReadOptions): Promise<ReadResult> {
    return this.operation("read", () => {
      this.readFormats.push(format);
      return {
        format,
        content: `read:${format}`,
        url: this.currentUrl,
        title: this.titleText,
        truncated: false,
      };
    });
  }

  async click(target: TargetPlan, options?: ActionOptions): Promise<ActionResult> {
    this.clickTargets.push(target);
    this.clickOptions.push(options);
    return this.operation("click", async () => {
      if (this.clickError !== null) throw this.clickError;
      return this.action("click", target);
    });
  }

  async fill(target: TargetPlan, value: string, _options?: ActionOptions): Promise<ActionResult> {
    return this.operation("fill", async () => ({ ...(await this.action("fill", target)), value }));
  }

  async type(target: TargetPlan, text: string, _options?: ActionOptions): Promise<ActionResult> {
    return this.operation("type", async () => ({ ...(await this.action("type", target)), value: text }));
  }

  async press(key: string, target?: TargetPlan, _options?: ActionOptions): Promise<ActionResult> {
    return this.operation("press", async () => {
      if (target === undefined) {
        return { action: "press", target: `key=${key}`, url: this.currentUrl, title: this.titleText, value: key };
      }
      return { ...(await this.action("press", target)), value: key };
    });
  }

  async select(target: TargetPlan, values: readonly string[], _options?: ActionOptions): Promise<ActionResult> {
    return this.operation("select", async () => ({ ...(await this.action("select", target)), values: [...values] }));
  }

  async hover(target: TargetPlan, options?: HoverOptions): Promise<ActionResult> {
    this.hoverOptions.push(options);
    return this.operation("hover", () => this.action("hover", target));
  }

  async drag(source: TargetPlan, target: TargetPlan, options?: DragOptions): Promise<ActionResult> {
    this.dragCalls.push({ source, target, ...(options === undefined ? {} : { options }) });
    return this.operation("drag", async () => {
      if (this.dragError !== null) throw this.dragError;
      return this.action("drag", source);
    });
  }

  async scroll(options?: ScrollOptions): Promise<ScrollResult> {
    this.scrollOptions.push(options);
    return this.operation("scroll", () => ({ url: this.currentUrl, title: this.titleText }));
  }

  async wait(_options?: WaitOptions): Promise<void> {
    await this.operation("wait", () => undefined);
  }

  async evaluate<T = unknown>(expression: string, _arg?: unknown): Promise<T> {
    return this.operation("evaluate", () => {
      this.evaluatedExpressions.push(expression);
      return (this.evaluateResult === undefined ? expression : this.evaluateResult) as T;
    });
  }

  async screenshot(_options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return this.operation("screenshot", () => this.screenshotResult);
  }

  async upload(target: TargetPlan, files: readonly string[], _options?: ActionOptions): Promise<ActionResult> {
    return this.operation("upload", async () => {
      this.uploadedFiles.push(...files);
      return { ...(await this.action("upload", target)), values: [...files] };
    });
  }

  async cookies(): Promise<CookieRecord[]> {
    return this.operation("cookies", () => [...this.cookiesValue]);
  }

  async setCookies(cookies: readonly CookieInput[]): Promise<void> {
    await this.operation("setCookies", () => {
      this.writtenCookies.push(cookies);
    });
  }

  async clearCookies(): Promise<void> {
    await this.operation("clearCookies", () => {
      this.cookiesValue = [];
    });
  }

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
    return this.dialogState;
  }

  async acceptDialog(promptText?: string): Promise<void> {
    if (this.dialogState === null) throw browseError("dialog_missing", "no dialog", "Call browse_dialog first.");
    this.acceptedDialogs.push(promptText);
    this.dialogState = null;
  }

  async dismissDialog(): Promise<void> {
    if (this.dialogState === null) throw browseError("dialog_missing", "no dialog", "Call browse_dialog first.");
    this.dismissCount += 1;
    this.dialogState = null;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCount += 1;
  }

  /** Push a console entry as the page's listeners would. */
  pushConsole(text: string): void {
    this.buffers.console.push({ kind: "console", level: "log", text, url: this.currentUrl, timestamp: Date.now() });
  }

  /** Push a network entry as the page's listeners would. */
  pushNetwork(url: string): void {
    this.buffers.network.push({
      event: "response",
      method: "GET",
      url,
      resourceType: "document",
      status: 200,
      ok: true,
      timestamp: Date.now(),
    });
  }

  /** Push a download entry as the page's listeners would. */
  pushDownload(filename: string): DownloadEntry {
    return this.buffers.downloads.push({
      filename,
      url: `https://example.com/${filename}`,
      path: `/tmp/${filename}`,
      bytes: 10,
      status: "completed",
      timestamp: Date.now(),
    });
  }
}

/** One fake browser. */
export class FakeBrowserDriver implements BrowseDriver {
  readonly engine: BrowseEngine;
  readonly owned: boolean;
  readonly pages: FakePageDriver[] = [];
  closed = false;
  closeCount = 0;

  constructor(
    engine: BrowseEngine,
    owned: boolean,
    private readonly configurePage?: (page: FakePageDriver, index: number) => void,
  ) {
    this.engine = engine;
    this.owned = owned;
  }

  async newPage(buffers?: BrowsePageBuffers): Promise<BrowsePageDriver> {
    // The fake records into the session-supplied buffers, exactly as a real
    // driver does; the port exposes them as `buffers`.
    const page = new FakePageDriver(0, buffers);
    this.configurePage?.(page, this.pages.length);
    this.pages.push(page);
    return page;
  }

  async closePage(page: BrowsePageDriver): Promise<void> {
    await page.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCount += 1;
    for (const page of this.pages) await page.close();
  }
}

/** A factory that hands out {@link FakeBrowserDriver} instances. */
export class FakeDriverFactory implements BrowseDriverFactory {
  launchCount = 0;
  launchOptions: BrowseLaunchOptions[] = [];
  drivers: FakeBrowserDriver[] = [];
  available: boolean;
  reason: string | undefined;
  guidance = "Run `npm install playwright` and `npx playwright install chromium`.";
  owned: boolean;
  engine: BrowseEngine;
  configurePage: ((page: FakePageDriver, index: number) => void) | undefined;

  constructor(options: {
    available?: boolean;
    reason?: string;
    guidance?: string;
    owned?: boolean;
    engine?: BrowseEngine;
    configurePage?: (page: FakePageDriver, index: number) => void;
  } = {}) {
    this.available = options.available ?? true;
    this.reason = options.reason;
    this.guidance = options.guidance ?? this.guidance;
    this.owned = options.owned ?? true;
    this.engine = options.engine ?? "chromium";
    this.configurePage = options.configurePage;
  }

  get lastDriver(): FakeBrowserDriver | undefined {
    return this.drivers[this.drivers.length - 1];
  }

  get lastPage(): FakePageDriver | undefined {
    const driver = this.lastDriver;
    return driver?.pages[driver.pages.length - 1];
  }

  status(): DriverStatus {
    return {
      available: this.available,
      resolvedPath: this.available ? "/fake/playwright/index.js" : undefined,
      reason: this.reason,
      guidance: this.guidance,
    };
  }

  async launch(options?: BrowseLaunchOptions): Promise<BrowseDriver> {
    this.launchCount += 1;
    this.launchOptions.push({ ...options });
    const driver = new FakeBrowserDriver(options?.engine ?? this.engine, this.owned, this.configurePage);
    this.drivers.push(driver);
    return driver;
  }
}
