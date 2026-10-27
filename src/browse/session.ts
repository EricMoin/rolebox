/**
 * Sessions, pages and refs: the stateful middle of the `browse_*` family.
 *
 * One {@link BrowseSessionManager} lives for the process and owns a record per
 * opaque session key (`main` page by default, at most eight named pages, one
 * active page). Browsers launch lazily on the first operation, every operation
 * for a session runs through a single serialized queue, and an idle session is
 * closed after ten minutes by an unref'd timer so a forgotten browser cannot keep
 * the process alive or hold memory forever.
 *
 * Ref lifetime is the contract this layer enforces:
 *
 * - a snapshot replaces the page's ref map with exactly the refs it printed;
 * - any navigation (goto/back/forward/reload) drops the map, because the DOM the
 *   refs named is gone;
 * - a ref that is not in the map is `stale_ref` before any Playwright call is
 *   made, and a ref whose element disappeared after the snapshot is translated
 *   from `element_not_found` into `stale_ref` — both tell the model to call
 *   `browse_snapshot` again.
 *
 * Each page record also holds the page's three capped event buffers
 * (console/pageerror/dialog, network, downloads) together with the reader cursor.
 * The manager creates the buffers and hands them to the page driver, whose event
 * listeners are their only writers, so a read-since-cursor returns exactly what
 * that page recorded.
 *
 * Attach mode (`cdp_url`) is owned by the driver: this manager only calls
 * `driver.close()`, and the driver leaves an externally owned browser running
 * while closing the pages it created.
 */

import { join } from "node:path";
import {
  browseError,
  createBrowsePageBuffers,
  isBrowseError,
  type ActionOptions,
  type BrowseError,
  type ActionResult,
  type BrowseBufferKind,
  type BrowseBufferRead,
  type BrowseDriver,
  type BrowseDriverFactory,
  type BrowseEngine,
  type BrowseLaunchOptions,
  type BrowsePageBuffers,
  type BrowsePageDriver,
  type BrowseSnapshot,
  type BrowseViewport,
  type ConsoleEntry,
  type CookieInput,
  type CookieRecord,
  type DialogState,
  type DownloadEntry,
  type DragOptions,
  type EvaluateOptions,
  type HoverOptions,
  type NavigateOptions,
  type NavigationResult,
  type NetworkEntry,
  type ReadFormat,
  type ReadOptions,
  type ReadResult,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ScrollOptions,
  type ScrollResult,
  type SnapshotOptions,
  type SnapshotRef,
  type TabInfo,
  type TargetPlan,
  type WaitOptions,
} from "./types.ts";
import { playwrightDriverFactory } from "./playwright-driver.ts";
import { formatSnapshotRef, parseSnapshotRefs } from "./snapshot.ts";

/** The page a session creates for itself when a caller names none. */
export const DEFAULT_PAGE_NAME = "main";

/** How many named pages one session may hold. */
export const DEFAULT_MAX_PAGES = 8;

/** How long a session may sit unused before its browser is closed. */
export const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;

/** Where downloads land, relative to the worktree. */
export const BROWSE_DOWNLOAD_SUBDIRECTORY = join(".rolebox", "browse", "downloads");

/** Construction-time defaults for every session this manager creates. */
export interface BrowseSessionManagerOptions {
  /** Worktree root; downloads are written below `.rolebox/browse/downloads`. */
  worktree: string;
  driverFactory?: BrowseDriverFactory;
  /** Injectable clock, so idle expiry is testable without sleeping. */
  now?: () => number;
  idleTtlMs?: number;
  maxPages?: number;
  engine?: BrowseEngine;
  headless?: boolean;
  viewport?: BrowseViewport;
  cdpUrl?: string;
  downloadsDirectory?: string;
  timeoutMs?: number;
}

/** Per-call session settings; launch settings only apply before the browser starts. */
export interface BrowseSessionSettings {
  signal?: AbortSignal;
  /** Named page to bind this operation to (default: the session's active page). */
  page?: string;
  engine?: BrowseEngine;
  headless?: boolean;
  viewport?: BrowseViewport;
  cdpUrl?: string;
  downloadsDirectory?: string;
  timeoutMs?: number;
}

/** What a session currently looks like. */
export interface BrowseSessionInfo {
  session: string;
  active: string | null;
  pages: TabInfo[];
  engine: BrowseEngine | null;
  /** True when the browser was attached over CDP rather than launched. */
  attached: boolean;
}

interface PageRecord {
  name: string;
  driver: BrowsePageDriver;
  /** The refs the latest snapshot of this page printed. */
  refs: Map<string, SnapshotRef>;
  /** The buffers the page driver writes into, held per page for read/clear. */
  buffers: BrowsePageBuffers;
  /** How far each buffer has been read by this session. */
  cursors: { console: number; network: number; downloads: number };
}

interface SessionRecord {
  key: string;
  settings: BrowseLaunchOptions;
  driver: BrowseDriver | null;
  pages: Map<string, PageRecord>;
  active: string | null;
  /** Tail of the per-session operation queue; never rejects. */
  tail: Promise<void>;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/**
 * The page handle an operation receives.
 *
 * Every method wraps the driver with the two things the driver itself does not
 * know: which refs exist for this page right now, and how a target failure should
 * be phrased for the next model turn. Navigation methods clear the ref map.
 */
export class BrowseSessionPage {
  constructor(
    private readonly record: SessionRecord,
    private readonly page: PageRecord,
    private readonly signal?: AbortSignal,
  ) {}

  /** The page's name inside its session. */
  get name(): string {
    return this.page.name;
  }

  /** The refs the latest snapshot of this page assigned. */
  get refs(): ReadonlyMap<string, SnapshotRef> {
    return this.page.refs;
  }

  /** How many refs the latest snapshot assigned. */
  get refCount(): number {
    return this.page.refs.size;
  }

  /** The underlying driver port, for diagnostics only. */
  get driver(): BrowsePageDriver {
    return this.page.driver;
  }

  // ── Snapshot and navigation ──

  /** Snapshot the page and replace the ref map with what it printed. */
  async snapshot(options?: SnapshotOptions): Promise<BrowseSnapshot> {
    const snapshot = await this.perform("snapshot the page", () => this.page.driver.snapshot(options));
    this.replaceRefs(snapshot);
    return snapshot;
  }

  async goto(url: string, options?: NavigateOptions): Promise<NavigationResult> {
    try {
      return await this.perform("navigate", () => this.page.driver.goto(url, options));
    } finally {
      this.page.refs.clear();
    }
  }

  async back(options?: NavigateOptions): Promise<NavigationResult> {
    try {
      return await this.perform("go back", () => this.page.driver.back(options));
    } finally {
      this.page.refs.clear();
    }
  }

  async forward(options?: NavigateOptions): Promise<NavigationResult> {
    try {
      return await this.perform("go forward", () => this.page.driver.forward(options));
    } finally {
      this.page.refs.clear();
    }
  }

  async reload(options?: NavigateOptions): Promise<NavigationResult> {
    try {
      return await this.perform("reload", () => this.page.driver.reload(options));
    } finally {
      this.page.refs.clear();
    }
  }

  async waitForLoadState(
    state?: Parameters<BrowsePageDriver["waitForLoadState"]>[0],
    options?: { timeoutMs?: number },
  ): Promise<void> {
    await this.perform("wait for the page", () => this.page.driver.waitForLoadState(state, options));
  }

  async read(format: ReadFormat, options?: ReadOptions): Promise<ReadResult> {
    return this.perform("read the page", () => this.page.driver.read(format, options));
  }

  // ── Element actions ──

  async click(target: TargetPlan, options?: ActionOptions): Promise<ActionResult> {
    return this.targetAction(target, "click", plan => this.page.driver.click(plan, options));
  }

  async fill(target: TargetPlan, value: string, options?: ActionOptions): Promise<ActionResult> {
    return this.targetAction(target, "fill", plan => this.page.driver.fill(plan, value, options));
  }

  async type(target: TargetPlan, text: string, options?: ActionOptions): Promise<ActionResult> {
    return this.targetAction(target, "type", plan => this.page.driver.type(plan, text, options));
  }

  async press(key: string, target?: TargetPlan, options?: ActionOptions): Promise<ActionResult> {
    if (target === undefined) {
      return this.perform("press", () => this.page.driver.press(key, undefined, options));
    }
    return this.targetAction(target, "press", plan => this.page.driver.press(key, plan, options));
  }

  async select(target: TargetPlan, values: readonly string[], options?: ActionOptions): Promise<ActionResult> {
    return this.targetAction(target, "select", plan => this.page.driver.select(plan, values, options));
  }

  async hover(target: TargetPlan, options?: HoverOptions): Promise<ActionResult> {
    return this.targetAction(target, "hover", plan => this.page.driver.hover(plan, options));
  }

  async drag(source: TargetPlan, target: TargetPlan, options?: DragOptions): Promise<ActionResult> {
    this.assertNotCancelled();
    const from = this.resolveTarget(source);
    const to = this.resolveTarget(target);
    try {
      return await this.perform("drag", () => this.page.driver.drag(from, to, options));
    } catch (error) {
      throw this.translateDragFailure(from, to, error);
    }
  }

  async scroll(options?: ScrollOptions): Promise<ScrollResult> {
    if (options?.target === undefined && options?.at === undefined) {
      return this.perform("scroll", () => this.page.driver.scroll(options));
    }
    const target = options.target === undefined ? undefined : this.resolveTarget(options.target);
    const at = options.at === undefined ? undefined : this.resolveTarget(options.at);
    try {
      return await this.perform("scroll", () => this.page.driver.scroll({
        ...options,
        ...(target === undefined ? {} : { target }),
        ...(at === undefined ? {} : { at }),
      }));
    } catch (error) {
      const failed = target ?? at;
      if (failed === undefined) throw asBrowseError(error, "scroll");
      throw this.translateTargetFailure(failed, error, "scroll");
    }
  }

  async wait(options?: WaitOptions): Promise<void> {
    if (options?.target === undefined) {
      await this.perform("wait", () => this.page.driver.wait(options));
      return;
    }
    const target = this.resolveTarget(options.target);
    try {
      await this.perform("wait", () => this.page.driver.wait({ ...options, target }));
    } catch (error) {
      throw this.translateTargetFailure(target, error, "wait");
    }
  }

  async evaluate<T = unknown>(expression: string, arg?: unknown, options?: EvaluateOptions): Promise<T> {
    return this.perform("evaluate", () => this.page.driver.evaluate<T>(expression, arg, {
      ...options, signal: options?.signal ?? this.signal,
    }));
  }

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return this.perform("screenshot", () => this.page.driver.screenshot(options));
  }

  async upload(target: TargetPlan, files: readonly string[], options?: ActionOptions): Promise<ActionResult> {
    return this.targetAction(target, "upload", plan => this.page.driver.upload(plan, files, options));
  }

  // ── Page state ──

  /** The current URL, read locally from the page. */
  get url(): string {
    return this.page.driver.url();
  }

  /** The document title. */
  async title(): Promise<string> {
    try {
      return await this.page.driver.title();
    } catch {
      return "";
    }
  }

  /** The page's row in `browse_tabs`. */
  async tab(): Promise<TabInfo> {
    return {
      name: this.page.name,
      url: this.page.driver.url(),
      title: await this.title(),
      active: this.record.active === this.page.name,
      refCount: this.page.refs.size,
    };
  }

  /** Page cookies (context-level). */
  async cookies(): Promise<CookieRecord[]> {
    return this.perform("read cookies", () => this.page.driver.cookies());
  }

  async setCookies(cookies: readonly CookieInput[]): Promise<void> {
    await this.perform("set cookies", () => this.page.driver.setCookies(cookies));
  }

  async clearCookies(): Promise<void> {
    await this.perform("clear cookies", () => this.page.driver.clearCookies());
  }

  // ── Buffers and dialogs ──

  /** Console messages, page errors and dialogs recorded since `since` (or the last read). */
  console(since?: number): BrowseBufferRead<ConsoleEntry> {
    return this.readBuffer("console", since);
  }

  /** Network lifecycle events recorded since `since` (or the last read). */
  network(since?: number): BrowseBufferRead<NetworkEntry> {
    return this.readBuffer("network", since);
  }

  /** Downloads recorded since `since` (or the last read). */
  downloads(since?: number): BrowseBufferRead<DownloadEntry> {
    return this.readBuffer("downloads", since);
  }

  /** Clear one buffer, or all three when no kind is given. */
  clearBuffers(kind?: BrowseBufferKind): void {
    if (kind !== undefined) {
      this.page.buffers[kind].clear();
      this.page.cursors[kind] = this.page.buffers[kind].cursor;
      return;
    }
    for (const name of ["console", "network", "downloads"] as const) {
      this.page.buffers[name].clear();
      this.page.cursors[name] = this.page.buffers[name].cursor;
    }
  }

  /** The dialog currently blocking the page, or null. */
  async dialog(): Promise<DialogState | null> {
    return this.perform("read the dialog", () => this.page.driver.dialog());
  }

  async acceptDialog(promptText?: string): Promise<void> {
    await this.perform("accept the dialog", () => this.page.driver.acceptDialog(promptText));
  }

  async dismissDialog(): Promise<void> {
    await this.perform("dismiss the dialog", () => this.page.driver.dismissDialog());
  }

  // ── Internals ──

  private async perform<T>(action: string, operation: () => Promise<T>): Promise<T> {
    this.assertNotCancelled();
    try {
      return await operation();
    } catch (error) {
      throw asBrowseError(error, action);
    }
  }

  /** Resolve a ref against the page's current map, before touching the browser. */
  private resolveTarget(target: TargetPlan): TargetPlan {
    if (target.kind !== "ref") return target;
    const known = this.page.refs.get(target.ref);
    if (known === undefined) {
      throw browseError(
        "stale_ref",
        `ref ${target.ref} is stale: it is not in the current snapshot of page "${this.page.name}"`,
        "Call browse_snapshot again to refresh element refs, then retry.",
      );
    }
    return target;
  }

  /** Run a target action, translating a vanished ref into `stale_ref`. */
  private async targetAction(
    target: TargetPlan,
    action: string,
    operation: (plan: TargetPlan) => Promise<ActionResult>,
  ): Promise<ActionResult> {
    this.assertNotCancelled();
    const plan = this.resolveTarget(target);
    try {
      return await operation(plan);
    } catch (error) {
      throw this.translateTargetFailure(plan, error, action);
    }
  }

  private assertNotCancelled(): void {
    if (this.signal?.aborted) {
      throw browseError("cancelled", "the browse call was cancelled before the next action", "Retry once the host turn is active again.");
    }
  }

  private translateTargetFailure(target: TargetPlan, error: unknown, action: string): BrowseError {
    const browse = asBrowseError(error, action);
    if (target.kind === "ref" && (browse.code === "element_not_found" || browse.code === "stale_ref")) {
      const known = this.page.refs.get(target.ref);
      this.page.refs.delete(target.ref);
      return browseError(
        "stale_ref",
        known === undefined
          ? `ref ${target.ref} no longer names an element on page "${this.page.name}"`
          : `${formatSnapshotRef(known)} is stale on page "${this.page.name}"`,
        "Call browse_snapshot again to get current refs, then retry the action.",
        browse,
      );
    }
    return browse;
  }

  /**
   * Translate a drag endpoint that vanished into `stale_ref`.
   *
   * Playwright reports which selector failed, but not which endpoint of the
   * drag it was; when neither endpoint is named, both refs are dropped so the
   * next model turn starts from a fresh snapshot instead of guessing.
   */
  private translateDragFailure(source: TargetPlan, target: TargetPlan, error: unknown): BrowseError {
    const browse = asBrowseError(error, "drag");
    if (browse.code !== "element_not_found" && browse.code !== "stale_ref") return browse;
    const refs = [source, target].filter(
      (endpoint): endpoint is { kind: "ref"; ref: string } => endpoint.kind === "ref",
    );
    if (refs.length === 0) return browse;
    const named = refs.filter(ref => browse.message.includes(`data-rolebox-ref="${ref.ref}"`));
    const stale = named.length === 0 ? refs : named;
    for (const ref of stale) this.page.refs.delete(ref.ref);
    const labels = stale.map(ref => `ref ${ref.ref}`).join(" and ");
    return browseError(
      "stale_ref",
      `${labels} ${stale.length === 1 ? "is" : "are"} stale on page "${this.page.name}"`,
      "Call browse_snapshot again to get current refs, then retry the drag.",
      browse,
    );
  }

  /** Replace the ref map from a snapshot, with a text fallback for driver stand-ins. */
  private replaceRefs(snapshot: BrowseSnapshot): void {
    let refs = snapshot.refs;
    if (refs.length === 0 && snapshot.text !== "") {
      refs = parseSnapshotRefs(snapshot.text);
    }
    this.page.refs = new Map(refs.map(ref => [ref.ref, ref]));
  }

  private readBuffer<K extends BrowseBufferKind>(kind: K, since?: number): BrowseBufferRead<BufferEntry<K>> {
    const buffer = this.page.buffers[kind];
    const cursor = since ?? this.page.cursors[kind];
    const read = buffer.read(cursor);
    this.page.cursors[kind] = Math.max(this.page.cursors[kind], read.cursor);
    return read as BrowseBufferRead<BufferEntry<K>>;
  }
}

/** The entry type of each buffer kind, for the typed read above. */
type BufferEntry<K extends BrowseBufferKind> = K extends "console"
  ? ConsoleEntry
  : K extends "network"
    ? NetworkEntry
    : DownloadEntry;

/** Translate any thrown value into a {@link BrowseError}. */
function asBrowseError(error: unknown, action: string): BrowseError {
  if (isBrowseError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return browseError(
    "protocol_error",
    `${action} failed (${message})`,
    "Retry; if it persists, check browse_status for the driver and the page.",
    error,
  );
}

/**
 * One manager per process; sessions are created on first use and closed when idle,
 * when their host turn ends, or on {@link BrowseSessionManager.dispose}.
 */
export class BrowseSessionManager {
  private readonly worktree: string;
  private readonly factory: BrowseDriverFactory;
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly maxPages: number;
  private readonly base: BrowseLaunchOptions;
  private readonly sessions = new Map<string, SessionRecord>();
  private disposed = false;

  constructor(options: BrowseSessionManagerOptions) {
    this.worktree = options.worktree;
    this.factory = options.driverFactory ?? playwrightDriverFactory;
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.base = {
      engine: options.engine ?? "chromium",
      headless: options.headless ?? true,
      viewport: options.viewport,
      cdpUrl: options.cdpUrl,
      downloadsDirectory: options.downloadsDirectory ?? join(this.worktree, BROWSE_DOWNLOAD_SUBDIRECTORY),
      timeoutMs: options.timeoutMs,
    };
  }

  /** Whether the driver can start at all, answered without launching. */
  status(): ReturnType<BrowseDriverFactory["status"]> {
    return this.factory.status();
  }

  /** How many live sessions this manager holds (a test seam). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Run one operation against a session's active page (or `settings.page`).
   *
   * Operations for the same session are serialized. The browser and default page
   * are created on the first call. Do not call another manager method from inside
   * `operation`: it would queue behind the operation it is running in.
   */
  async run<T>(
    sessionKey: string,
    operation: (page: BrowseSessionPage) => Promise<T>,
    settings?: BrowseSessionSettings,
  ): Promise<T> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      try {
        const page = await this.ensurePage(record, settings?.page, settings?.signal);
        this.assertNotCancelled(settings?.signal);
        try {
          return await operation(new BrowseSessionPage(record, page, settings?.signal));
        } finally {
          if (page.driver.isClosed()) this.forgetPage(record, page);
        }
      } finally {
        this.touch(record);
      }
    }, settings?.signal);
  }

  /** Launch the browser and ensure the active page exists. */
  async ensure(sessionKey: string, settings?: BrowseSessionSettings): Promise<BrowseSessionInfo> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      try {
        await this.ensurePage(record, settings?.page, settings?.signal);
        return this.buildInfo(record);
      } finally {
        this.touch(record);
      }
    }, settings?.signal);
  }

  /** The session's tabs, without launching a browser that is not running. */
  async pages(sessionKey: string, settings?: BrowseSessionSettings): Promise<TabInfo[]> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      return this.tabInfos(record);
    }, settings?.signal);
  }

  /** Open a named page and make it active. */
  async newPage(sessionKey: string, name: string, settings?: BrowseSessionSettings): Promise<BrowseSessionInfo> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      try {
        await this.ensureDriver(record);
        this.assertNotCancelled(settings?.signal);
        const pageName = normalizePageName(name);
        if (record.pages.has(pageName)) {
          throw browseError(
            "protocol_error",
            `page "${pageName}" already exists in this session`,
            "Choose another name, or select the existing page with browse_tabs action=select.",
          );
        }
        await this.createPage(record, pageName);
        record.active = pageName;
        return this.buildInfo(record);
      } finally {
        this.touch(record);
      }
    }, settings?.signal);
  }

  /** Make an existing page active. */
  async selectPage(sessionKey: string, name: string, settings?: BrowseSessionSettings): Promise<BrowseSessionInfo> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      const pageName = normalizePageName(name);
      if (!record.pages.has(pageName)) {
        throw browseError(
          "no_such_page",
          `page "${pageName}" does not exist in this session`,
          `Open it with browse_tabs action=new name="${pageName}", or select one of: ${this.pageNames(record)}.`,
        );
      }
      record.active = pageName;
      return this.buildInfo(record);
    }, settings?.signal);
  }

  /** Close a page (the active one by default) and pick a new active page. */
  async closePage(sessionKey: string, name?: string, settings?: BrowseSessionSettings): Promise<BrowseSessionInfo> {
    this.assertNotDisposed();
    const record = this.recordFor(sessionKey, settings);
    return this.enqueue(record, async () => {
      this.assertOpen(record);
      this.applySettings(record, settings);
      this.touch(record);
      // Closing "the active page" in an empty session is a no-op; closing a
      // *named* page that does not exist is an error even when none are open.
      if (record.pages.size === 0 && name === undefined) return this.buildInfo(record);
      const pageName = name === undefined ? record.active ?? DEFAULT_PAGE_NAME : normalizePageName(name);
      const page = record.pages.get(pageName);
      if (page === undefined) {
        throw browseError(
          "no_such_page",
          `page "${pageName}" does not exist in this session`,
          `Use one of: ${this.pageNames(record)}.`,
        );
      }
      this.forgetPage(record, page);
      await this.closePageDriver(page);
      return this.buildInfo(record);
    }, settings?.signal);
  }

  /** The session's current info, without launching anything. */
  async info(sessionKey: string, signal?: AbortSignal): Promise<BrowseSessionInfo> {
    this.assertNotCancelled(signal);
    const record = this.sessions.get(sessionKey.trim());
    if (record === undefined) {
      return { session: sessionKey, active: null, pages: [], engine: null, attached: false };
    }
    this.assertNotDisposed();
    return this.enqueue(record, async () => {
      this.touch(record);
      return this.buildInfo(record);
    }, signal);
  }

  /** Close one session and its browser. Unknown keys are a no-op. */
  async close(sessionKey: string, signal?: AbortSignal): Promise<void> {
    this.assertNotCancelled(signal);
    const record = this.sessions.get(sessionKey.trim());
    if (record === undefined) return;
    await this.enqueue(record, async () => {
      if (this.sessions.get(record.key) === record) this.sessions.delete(record.key);
      await this.closeRecord(record);
    }, signal);
  }

  /** Close every session; the manager cannot be used afterwards. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      await this.enqueue(record, async () => {
        await this.closeRecord(record);
      });
    }
  }

  /**
   * Close every session whose idle TTL has expired and return their keys.
   *
   * The idle timer calls this, and tests call it with an injected clock. The
   * expiry decision and the close happen inside the session's queue, so a
   * session that starts working concurrently is not torn down underneath its
   * operation.
   */
  async sweepIdle(): Promise<string[]> {
    const now = this.now();
    const closed: string[] = [];
    for (const record of [...this.sessions.values()]) {
      if (now - record.lastUsed < this.idleTtlMs) continue;
      const expired = await this.enqueue(record, async () => {
        if (this.now() - record.lastUsed < this.idleTtlMs) return false;
        await this.closeRecord(record);
        return true;
      });
      if (!expired) continue;
      if (this.sessions.get(record.key) === record) this.sessions.delete(record.key);
      closed.push(record.key);
    }
    return closed;
  }

  // ── Internals ──

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw browseError(
        "protocol_error",
        "the browse session manager was disposed",
        "Create a new manager for this process before using browse again.",
      );
    }
  }

  private assertOpen(record: SessionRecord): void {
    if (record.closed) {
      throw browseError(
        "no_such_page",
        "the session was closed or expired",
        "Run the operation again to start a new session.",
      );
    }
  }

  private recordFor(sessionKey: string, settings?: BrowseSessionSettings): SessionRecord {
    this.assertNotCancelled(settings?.signal);
    const key = sessionKey.trim();
    if (key === "") {
      throw browseError(
        "protocol_error",
        "the session key is empty",
        "Pass the host session id as the session key.",
      );
    }
    let record = this.sessions.get(key);
    if (record === undefined || record.closed) {
      record = {
        key,
        settings: { ...this.base },
        driver: null,
        pages: new Map(),
        active: null,
        tail: Promise.resolve(),
        lastUsed: this.now(),
        timer: null,
        closed: false,
      };
      this.sessions.set(key, record);
    }
    return record;
  }

  private applySettings(record: SessionRecord, settings?: BrowseSessionSettings): void {
    if (settings === undefined || record.driver !== null) return;
    if (settings.engine !== undefined) record.settings.engine = settings.engine;
    if (settings.headless !== undefined) record.settings.headless = settings.headless;
    if (settings.viewport !== undefined) record.settings.viewport = settings.viewport;
    if (settings.cdpUrl !== undefined) record.settings.cdpUrl = settings.cdpUrl;
    if (settings.downloadsDirectory !== undefined) record.settings.downloadsDirectory = settings.downloadsDirectory;
    if (settings.timeoutMs !== undefined) record.settings.timeoutMs = settings.timeoutMs;
  }

  private assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw browseError("cancelled", "the browse call was cancelled before it ran", "Retry once the host turn is active again.");
    }
  }

  private enqueue<T>(record: SessionRecord, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = record.tail.then(() => {
      this.assertNotCancelled(signal);
      return task();
    });
    record.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private touch(record: SessionRecord): void {
    record.lastUsed = this.now();
    this.scheduleIdle(record);
  }

  private scheduleIdle(record: SessionRecord): void {
    if (this.idleTtlMs <= 0 || record.closed) return;
    if (record.timer !== null) clearTimeout(record.timer);
    const timer = setTimeout(() => {
      record.timer = null;
      void this.sweepIdle().finally(() => {
        if (!record.closed && record.timer === null) this.scheduleIdle(record);
      }).catch(() => undefined);
    }, this.idleTtlMs);
    timer.unref?.();
    record.timer = timer;
  }

  private async ensureDriver(record: SessionRecord): Promise<BrowseDriver> {
    if (record.driver !== null) return record.driver;
    const status = this.factory.status();
    if (!status.available) {
      throw browseError(
        "driver_unavailable",
        status.reason ?? "the browser driver is unavailable",
        status.guidance,
      );
    }
    try {
      record.driver = await this.factory.launch(record.settings);
    } catch (error) {
      if (isBrowseError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw browseError(
        "browser_launch_failed",
        `the browser could not start (${message})`,
        "Check that this process may launch a browser and that the Playwright browser binaries are installed.",
        error,
      );
    }
    return record.driver;
  }

  private async ensurePage(record: SessionRecord, requested?: string, signal?: AbortSignal): Promise<PageRecord> {
    await this.ensureDriver(record);
    this.assertNotCancelled(signal);
    if (requested !== undefined) {
      const pageName = normalizePageName(requested);
      const existing = record.pages.get(pageName);
      if (existing === undefined) {
        throw browseError(
          "no_such_page",
          `page "${pageName}" does not exist in this session`,
          `Open it with browse_tabs action=new name="${pageName}", or use one of: ${this.pageNames(record)}.`,
        );
      }
      record.active = pageName;
      return existing;
    }
    const active = record.active === null ? undefined : record.pages.get(record.active);
    if (active !== undefined) return active;
    const existingMain = record.pages.get(DEFAULT_PAGE_NAME);
    if (existingMain !== undefined) {
      record.active = DEFAULT_PAGE_NAME;
      return existingMain;
    }
    const page = await this.createPage(record, DEFAULT_PAGE_NAME);
    record.active = DEFAULT_PAGE_NAME;
    return page;
  }

  private async createPage(record: SessionRecord, name: string): Promise<PageRecord> {
    if (record.pages.size >= this.maxPages) {
      throw browseError(
        "page_limit",
        `this session already has the maximum of ${this.maxPages} pages`,
        "Close a page with browse_tabs action=close, then open a new one.",
      );
    }
    const driver = await this.ensureDriver(record);
    // The session creates the capped buffers and hands them to the driver, which
    // is their only writer; the page record keeps them so reads, cursors and
    // clears are the session's policy.
    const buffers = createBrowsePageBuffers();
    let pageDriver: BrowsePageDriver;
    try {
      pageDriver = await driver.newPage(buffers);
    } catch (error) {
      throw asBrowseError(error, "open a page");
    }
    const page: PageRecord = {
      name,
      driver: pageDriver,
      refs: new Map(),
      buffers,
      cursors: { console: 0, network: 0, downloads: 0 },
    };
    record.pages.set(name, page);
    return page;
  }

  private async tabInfos(record: SessionRecord): Promise<TabInfo[]> {
    const tabs: TabInfo[] = [];
    for (const page of record.pages.values()) {
      let title = "";
      try {
        title = await page.driver.title();
      } catch {
        title = "";
      }
      let url = "";
      try {
        url = page.driver.url();
      } catch {
        url = "";
      }
      tabs.push({
        name: page.name,
        url,
        title,
        active: record.active === page.name,
        refCount: page.refs.size,
      });
    }
    return tabs;
  }

  private async buildInfo(record: SessionRecord): Promise<BrowseSessionInfo> {
    return {
      session: record.key,
      active: record.active,
      pages: await this.tabInfos(record),
      engine: record.driver?.engine ?? null,
      attached: record.driver !== null && !record.driver.owned,
    };
  }

  private pageNames(record: SessionRecord): string {
    const names = [...record.pages.keys()];
    return names.length === 0 ? "(no pages yet)" : names.join(", ");
  }

  private async closePageDriver(page: PageRecord): Promise<void> {
    try {
      await page.driver.close();
    } catch {
      // A page that is already closed needs no further handling.
    }
  }

  private forgetPage(record: SessionRecord, page: PageRecord): void {
    page.refs.clear();
    record.pages.delete(page.name);
    if (record.active === page.name) {
      record.active = record.pages.has(DEFAULT_PAGE_NAME)
        ? DEFAULT_PAGE_NAME
        : record.pages.keys().next().value ?? null;
    }
  }

  private async closeRecord(record: SessionRecord): Promise<void> {
    if (record.closed) return;
    record.closed = true;
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    for (const page of [...record.pages.values()]) {
      await this.closePageDriver(page);
    }
    record.pages.clear();
    record.active = null;
    if (record.driver !== null) {
      try {
        await record.driver.close();
      } catch {
        // Disposal closes as much as the driver can close.
      }
      record.driver = null;
    }
  }
}

/** Validate and normalize a page name. */
export function normalizePageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw browseError(
      "invalid_target",
      "the page name is empty",
      `Use a short name such as "${DEFAULT_PAGE_NAME}".`,
    );
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(trimmed)) {
    throw browseError(
      "invalid_target",
      `the page name "${trimmed}" is invalid`,
      "Use 1-40 letters, digits, hyphens or underscores.",
    );
  }
  return trimmed;
}
