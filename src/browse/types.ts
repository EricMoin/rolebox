/**
 * The shared vocabulary and the browser-driver port for rolebox's semantic
 * browser family (`browse_*`).
 *
 * Everything the tool layer needs to say about a browser lives here: the closed
 * error-code union, the target syntax a model may use, the snapshot/read shapes,
 * the per-page event records, and the {@link BrowsePageDriver} port that the one
 * Playwright module implements. No Playwright type leaks through this file — the
 * port only carries plain data, so the session manager, the capture helpers and
 * the tests can stand in their own driver.
 *
 * Two rules the rest of the module relies on:
 *
 * - A {@link BrowseError} is the only failure type a driver or the session
 *   manager raises. The tool layer catches it and renders one sentence plus a
 *   next step; nothing crosses a tool boundary as a thrown unknown.
 * - A ref is only meaningful inside the snapshot that produced it. The driver
 *   writes `data-rolebox-ref="eN"` onto the live element so the ref can be
 *   resolved by attribute after the snapshot, and the session map is replaced by
 *   every snapshot and dropped on navigation.
 */

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Every failure mode the browser family distinguishes.
 *
 * The union is closed on purpose: `metadata.code` is what a model reacts to, so
 * a new failure mode has to be named here rather than smuggled into a message.
 */
export type BrowseErrorCode =
  | "driver_unavailable"
  | "browser_launch_failed"
  | "browser_closed"
  | "no_such_page"
  | "page_limit"
  | "invalid_target"
  | "invalid_arguments"
  | "element_not_found"
  | "stale_ref"
  | "ambiguous_target"
  | "timeout"
  | "dialog_open"
  | "dialog_missing"
  | "navigation_failed"
  | "script_error"
  | "execution_context_destroyed"
  | "file_not_found"
  | "too_large"
  | "cancelled"
  | "protocol_error";

/** The fields a {@link BrowseError} is constructed from. */
export interface BrowseErrorOptions {
  code: BrowseErrorCode;
  /** The cause, phrased as a clause a caller can append to `Error: `. */
  message: string;
  /** The concrete next step, phrased as an instruction. */
  hint?: string;
  cause?: unknown;
}

/**
 * The browser family's failure type.
 *
 * `message` states what went wrong and `hint` what to do next, so the tool layer
 * can render exactly one actionable sentence without knowing the failure site.
 * A Playwright error is translated at the driver boundary and never escapes as
 * itself.
 */
export class BrowseError extends Error {
  readonly code: BrowseErrorCode;
  readonly hint?: string;

  constructor(options: BrowseErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowseError";
    this.code = options.code;
    this.hint = options.hint;
  }
}

/** Construct a {@link BrowseError} without repeating the object literal. */
export function browseError(
  code: BrowseErrorCode,
  message: string,
  hint?: string,
  cause?: unknown,
): BrowseError {
  return new BrowseError({ code, message, hint, cause });
}

/** Whether `value` is one of this module's failures (across duplicated module instances). */
export function isBrowseError(value: unknown): value is BrowseError {
  return value instanceof BrowseError
    || (typeof value === "object" && value !== null
      && (value as { name?: unknown }).name === "BrowseError"
      && typeof (value as { code?: unknown }).code === "string"
      && typeof (value as { message?: unknown }).message === "string");
}

// ── Targets ──────────────────────────────────────────────────────────────────

/**
 * What a `target` argument resolves to.
 *
 * `ref` is the only form that is tied to a snapshot; every other form is a live
 * query. The parser (`parseTarget`) is the single entry point and rejects
 * unknown prefixes rather than guessing, so a typo never silently matches text.
 */
export type TargetPlan =
  | { kind: "ref"; ref: string }
  | { kind: "css"; selector: string }
  | { kind: "text"; text: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "label"; text: string }
  | { kind: "placeholder"; text: string }
  | { kind: "alt"; text: string }
  | { kind: "title"; text: string }
  | { kind: "testid"; testId: string };

// ── Snapshots ────────────────────────────────────────────────────────────────

/** One element ref assigned by a snapshot. */
export interface SnapshotRef {
  /** The ref as printed in the snapshot, e.g. `e12`. */
  ref: string;
  /** The role the ref was assigned under. */
  role: string;
  /** The accessible name at snapshot time, whitespace-collapsed and clipped. */
  name: string;
}

/** Options accepted by a snapshot call. */
export interface SnapshotOptions {
  /** CSS selector restricting the snapshot to one subtree. */
  selector?: string;
  /** Character cap for the snapshot text (default 20000, hard maximum 100000). */
  maxChars?: number;
  /** Also print `text "..."` leaves so the snapshot reads like page content. */
  full?: boolean;
}

/** The model-facing snapshot shape every driver returns. */
export interface SnapshotResult {
  text: string;
  nodeCount: number;
  refCount: number;
  truncated: boolean;
  url: string;
  title: string;
}

/**
 * A snapshot plus the refs it assigned.
 *
 * The extra `refs` registry is what lets the session replace its per-page ref
 * map without re-parsing the text; {@link SnapshotResult} stays the small
 * shape a tool reports.
 */
export interface BrowseSnapshot extends SnapshotResult {
  refs: readonly SnapshotRef[];
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The representations `browse_read` can ask a page for. */
export type ReadFormat = "markdown" | "text" | "html" | "links" | "table";

/** Options accepted by a read call. */
export interface ReadOptions {
  /** CSS selector restricting the read to one subtree. */
  selector?: string;
  /** Character cap (default 20000, hard maximum 200000). */
  maxChars?: number;
}

/** The result of reading a page in one representation. */
export interface ReadResult {
  format: ReadFormat;
  content: string;
  url: string;
  title: string;
  truncated: boolean;
}

// ── Tabs, buffers and dialogs ────────────────────────────────────────────────

/** One named page in a session, as reported by `browse_tabs`. */
export interface TabInfo {
  name: string;
  url: string;
  title: string;
  active: boolean;
  refCount: number;
}

/** What produced a console-buffer entry. */
export type ConsoleEntryKind = "console" | "pageerror" | "dialog";

/** One console message, uncaught page error or dialog, in arrival order. */
export interface ConsoleEntry {
  seq: number;
  kind: ConsoleEntryKind;
  /** Console level (`log`, `warning`, …), `error` for page errors, or the dialog type. */
  level: string;
  text: string;
  url: string;
  timestamp: number;
}

/** Which network lifecycle event a buffer entry records. */
export type NetworkEventKind = "request" | "response" | "failed";

/** One network lifecycle event, in arrival order. */
export interface NetworkEntry {
  seq: number;
  event: NetworkEventKind;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  error?: string;
  timestamp: number;
}

/** Whether a download finished writing or failed. */
export type DownloadStatus = "completed" | "failed";

/** One download, including the path its bytes were saved to. */
export interface DownloadEntry {
  seq: number;
  filename: string;
  url: string;
  /** Absolute path the bytes were saved to, when the save succeeded. */
  path?: string;
  bytes?: number;
  status: DownloadStatus;
  error?: string;
  timestamp: number;
}

/** The dialog currently blocking a page, if any. */
export interface DialogState {
  type: string;
  message: string;
  defaultValue: string;
  open: boolean;
}

/** A cookie as read from the browser context. */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** A cookie to write into the browser context; domain/path or `url` is required. */
export type CookieInput = Pick<CookieRecord, "name" | "value">
  & Partial<Omit<CookieRecord, "name" | "value">>
  & { url?: string };

// ── Capped buffers ───────────────────────────────────────────────────────────

/** How many entries each per-page buffer keeps before dropping the oldest. */
export const BROWSE_BUFFER_LIMITS = {
  console: 1000,
  network: 2000,
  downloads: 100,
} as const;

/** The three per-page buffers a session page exposes. */
export type BrowseBufferKind = keyof typeof BROWSE_BUFFER_LIMITS;

/** A read of a buffer, positioned after the caller's cursor. */
export interface BrowseBufferRead<T> {
  entries: T[];
  /**
   * The highest sequence number issued so far — pass it back as `since` to read
   * only what arrives next, even when this read returned nothing.
   */
  cursor: number;
}

/**
 * A fixed-capacity, cursor-readable event log.
 *
 * The buffer issues the sequence numbers itself, so a reader can say "everything
 * after 42" without coordinating with the writer. Once the cap is reached the
 * oldest entries are dropped, while the cursor keeps increasing — a reader that
 * fell further behind than the cap is told only what is still retained.
 */
export class BrowseEventBuffer<T extends { seq: number }> {
  private entries: T[] = [];
  private nextSeq = 1;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`BrowseEventBuffer limit must be a positive integer, received ${String(limit)}`);
    }
  }

  /** How many entries are currently retained. */
  get size(): number {
    return this.entries.length;
  }

  /** The highest sequence number issued so far. */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  /** Append an entry; the buffer stamps it with the next sequence number. */
  push(entry: Omit<T, "seq">): T {
    // The one assertion here: the buffer is the only place a sequence number is
    // issued, so spreading `{...entry, seq}` *is* a T once `seq` is added.
    const item = { ...entry, seq: this.nextSeq } as T;
    this.nextSeq += 1;
    this.entries.push(item);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return item;
  }

  /** Entries newer than `since`, plus the cursor to pass to the next read. */
  read(since = 0): BrowseBufferRead<T> {
    return { entries: this.entries.filter(entry => entry.seq > since), cursor: this.cursor };
  }

  /** Drop every retained entry; the cursor is not rewound. */
  clear(): void {
    this.entries.length = 0;
  }
}

/** The three capped logs that belong to one page. */
export interface BrowsePageBuffers {
  readonly console: BrowseEventBuffer<ConsoleEntry>;
  readonly network: BrowseEventBuffer<NetworkEntry>;
  readonly downloads: BrowseEventBuffer<DownloadEntry>;
}

/** Create an empty set of per-page buffers with the shared caps. */
export function createBrowsePageBuffers(): BrowsePageBuffers {
  return {
    console: new BrowseEventBuffer<ConsoleEntry>(BROWSE_BUFFER_LIMITS.console),
    network: new BrowseEventBuffer<NetworkEntry>(BROWSE_BUFFER_LIMITS.network),
    downloads: new BrowseEventBuffer<DownloadEntry>(BROWSE_BUFFER_LIMITS.downloads),
  };
}

// ── Driver vocabulary ────────────────────────────────────────────────────────

/** Which Playwright engine a session drives. */
export type BrowseEngine = "chromium" | "firefox" | "webkit";

/** A CSS-pixel viewport for a new browser context. */
export interface BrowseViewport {
  width: number;
  height: number;
}

/** How to start (or attach to) a browser for one session. */
export interface BrowseLaunchOptions {
  engine?: BrowseEngine;
  headless?: boolean;
  viewport?: BrowseViewport;
  /** Attach to a Chromium already listening on this CDP endpoint instead of launching. */
  cdpUrl?: string;
  /** Directory downloads are saved into; created on demand. */
  downloadsDirectory?: string;
  /** Default per-action timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Chromium only: whether to keep Chromium's own sandbox. Defaults to `true`;
   * the live test lowers it only when a host cannot run a sandboxed browser.
   */
  chromiumSandbox?: boolean;
}

/** What the factory can say about the driver before anything is launched. */
export interface DriverStatus {
  available: boolean;
  /** Absolute path of the resolved `playwright` entry point, when installed. */
  resolvedPath?: string;
  /** The installed `playwright` package version, when it can be read. */
  version?: string;
  /** Why the driver is unavailable, when it is. */
  reason?: string;
  /** Where Playwright looks for browser binaries, when the environment states it. */
  browsersPath?: string;
  /** Whether a Chromium build is present under {@link browsersPath}. */
  chromiumInstalled?: boolean;
  /** The command that fixes an unavailable driver. */
  guidance?: string;
}

/** A launched browser plus the pages this driver created. */
export interface BrowseDriver {
  readonly engine: BrowseEngine;
  /** True when this driver launched the browser, false when attached over CDP. */
  readonly owned: boolean;
  /**
   * Create a page. When `buffers` is given the driver records into them, so the
   * caller (the session manager) owns the cap policy; otherwise the driver
   * creates a fresh set with the shared limits.
   */
  newPage(buffers?: BrowsePageBuffers): Promise<BrowsePageDriver>;
  closePage(page: BrowsePageDriver): Promise<void>;
  /**
   * Release the driver. An owned browser is closed; an attached browser is left
   * running — only the pages this driver created are closed and no
   * `Browser.close` is sent.
   */
  close(): Promise<void>;
}

/** How long to wait for a navigation and which lifecycle event ends it. */
export interface NavigateOptions {
  timeoutMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

/** Where a navigation ended up and what the page calls itself. */
export interface NavigationResult {
  url: string;
  title: string;
  /** The HTTP status of the main document, or null when there was no response. */
  status: number | null;
}

/** A modifier key a click, hover or wheel may hold down. */
export type BrowseModifier = "Alt" | "Control" | "Meta" | "Shift";

/** A point relative to an element's padding-box top-left, in CSS pixels. */
export interface BrowsePoint {
  x: number;
  y: number;
}

/** Per-action options shared by clicking, typing and the other gestures. */
export interface ActionOptions {
  timeoutMs?: number;
  /** Bypass actionability checks (Playwright `force`). */
  force?: boolean;
  /** Mouse button for a click; ignored by the other gestures. */
  button?: "left" | "right" | "middle";
  /** 1 for a single click, 2 for a double click, 3 for a triple click. */
  clickCount?: 1 | 2 | 3;
  /** Modifier keys held down during the action. */
  modifiers?: readonly BrowseModifier[];
  /** Where inside the element to act; the centre is used when omitted. */
  position?: BrowsePoint;
  /** Hold the mouse button down this long between down and up, in milliseconds. */
  delayMs?: number;
  /** How many separate clicks to perform, each with `clickCount` presses. */
  repeat?: number;
  /** Pause between repeated clicks, in milliseconds. */
  intervalMs?: number;
}

/** Options for moving the pointer over an element. */
export interface HoverOptions {
  timeoutMs?: number;
  force?: boolean;
  position?: BrowsePoint;
  modifiers?: readonly BrowseModifier[];
  /** Keep the pointer over the element this long after moving there. */
  holdMs?: number;
}

/** Options for dragging one element onto another. */
export interface DragOptions {
  timeoutMs?: number;
  force?: boolean;
  /** Where inside the source to press, relative to its padding box. */
  sourcePosition?: BrowsePoint;
  /** Where inside the destination to release, relative to its padding box. */
  targetPosition?: BrowsePoint;
  /** Interpolated pointer moves between press and release (default 1). */
  steps?: number;
}

/** What an element action did, and where the page stood afterwards. */
export interface ActionResult {
  action: string;
  /** The canonical form of the target, e.g. `ref=e12` or `role=button[name="Save"]`. */
  target: string;
  url: string;
  title: string;
  /** The value a `fill`/`type` wrote. */
  value?: string;
  /** The options a `select` ended up with. */
  values?: string[];
}

/** How a scroll should move the page. */
export interface ScrollOptions {
  target?: TargetPlan;
  deltaX?: number;
  deltaY?: number;
  /** Jump the document to its top or bottom instead of wheeling. */
  to?: "top" | "bottom";
  /** Move the pointer over this element before wheeling. */
  at?: TargetPlan;
  /** Where inside `at` to put the pointer. */
  atPosition?: BrowsePoint;
  /** Modifiers held while wheeling, e.g. Control for browser zoom. */
  modifiers?: readonly BrowseModifier[];
  timeoutMs?: number;
}

/** Where a scroll left the page. */
export interface ScrollResult {
  url: string;
  title: string;
}

/** What a `wait` call waits for. */
export interface WaitOptions {
  /** Sleep for this many milliseconds (capped by the driver). */
  milliseconds?: number;
  /** Wait until this target is visible. */
  target?: TargetPlan;
  /** Wait until the page URL contains this text. */
  url?: string;
  timeoutMs?: number;
}

/** Interrupted evaluation closes its page so unfinished JavaScript cannot block later calls. */
export interface EvaluateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** How a screenshot is captured. */
export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  /** JPEG quality, 0-100. */
  quality?: number;
  /** Capture only the element matching this CSS selector. */
  selector?: string;
  timeoutMs?: number;
}

/** Raw screenshot bytes; capture.ts turns them into a file attachment. */
export interface ScreenshotResult {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
}

/** Lifecycle states Playwright can wait for. */
export type LoadState = "load" | "domcontentloaded" | "networkidle" | "commit";

/**
 * One browser page.
 *
 * Every member is asynchronous except `url`, `buffers` and `isClosed`, which are
 * synchronous reads of local state (the Playwright page's current URL, the event
 * logs, and whether the page was closed). A failing operation raises a
 * {@link BrowseError} and nothing else.
 */
export interface BrowsePageDriver {
  /** Navigate and wait for the requested lifecycle event. */
  goto(url: string, options?: NavigateOptions): Promise<NavigationResult>;
  back(options?: NavigateOptions): Promise<NavigationResult>;
  forward(options?: NavigateOptions): Promise<NavigationResult>;
  reload(options?: NavigateOptions): Promise<NavigationResult>;
  /** The page's current URL, without a round trip. */
  url(): string;
  /** The document title; empty when the page has none. */
  title(): Promise<string>;
  waitForLoadState(state?: LoadState, options?: { timeoutMs?: number }): Promise<void>;
  /** Walk the DOM into an ARIA-ref tree, assigning refs in DOM order. */
  snapshot(options?: SnapshotOptions): Promise<BrowseSnapshot>;
  /** Read the page as markdown, text, HTML, a link list or markdown tables. */
  read(format: ReadFormat, options?: ReadOptions): Promise<ReadResult>;
  click(target: TargetPlan, options?: ActionOptions): Promise<ActionResult>;
  fill(target: TargetPlan, value: string, options?: ActionOptions): Promise<ActionResult>;
  /** Type text key by key into a target. */
  type(target: TargetPlan, text: string, options?: ActionOptions): Promise<ActionResult>;
  /** Press one key, optionally on a target instead of the focused element. */
  press(key: string, target?: TargetPlan, options?: ActionOptions): Promise<ActionResult>;
  select(target: TargetPlan, values: readonly string[], options?: ActionOptions): Promise<ActionResult>;
  hover(target: TargetPlan, options?: HoverOptions): Promise<ActionResult>;
  /** Press on a source element, move, and release on a destination element. */
  drag(source: TargetPlan, target: TargetPlan, options?: DragOptions): Promise<ActionResult>;
  scroll(options?: ScrollOptions): Promise<ScrollResult>;
  wait(options?: WaitOptions): Promise<void>;
  /** Evaluate a JavaScript expression in the page and return its serializable value. */
  evaluate<T = unknown>(expression: string, arg?: unknown, options?: EvaluateOptions): Promise<T>;
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  upload(target: TargetPlan, files: readonly string[], options?: ActionOptions): Promise<ActionResult>;
  cookies(): Promise<CookieRecord[]>;
  setCookies(cookies: readonly CookieInput[]): Promise<void>;
  clearCookies(): Promise<void>;
  /** The capped console/pageerror/dialog log for this page. */
  readonly buffers: BrowsePageBuffers;
  /** Clear one buffer, or every buffer when no kind is given. */
  clearBuffers(kind?: BrowseBufferKind): void;
  /** The dialog currently blocking the page, or null. */
  dialog(): Promise<DialogState | null>;
  /** Accept the pending dialog, optionally answering a prompt. */
  acceptDialog(promptText?: string): Promise<void>;
  /** Dismiss the pending dialog. */
  dismissDialog(): Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * The seam between the session manager and a concrete automation library.
 *
 * `status()` is synchronous so a tool can answer "is the browser available?"
 * without importing anything heavy; `launch()` is where the dynamic import and
 * every browser process lives.
 */
export interface BrowseDriverFactory {
  status(): DriverStatus;
  launch(options?: BrowseLaunchOptions): Promise<BrowseDriver>;
}
