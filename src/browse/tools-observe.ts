/**
 * Observation tools: `browse_status`, `browse_snapshot`, `browse_read`,
 * `browse_eval`, `browse_screenshot`, `browse_downloads`, `browse_console` and
 * `browse_network`.
 *
 * Observation is what keeps a browse turn honest: a snapshot or read is the
 * page's own content, a console/network read is what the page actually logged
 * and requested, and `browse_status` answers "can I browse at all?" without
 * launching anything. Everything here is read-only with two exceptions that are
 * explicit in their arguments: the buffers (`clear`) and the screenshot file.
 *
 * The console, network and download reads are cursor-based: each read returns
 * only what this session has not returned yet, so polling never repeats the same
 * events, and `metadata.cursor` lets a caller hold the position it has seen.
 */

import { z } from "zod";
import type { CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import { browseDownloadsDirectory, browseScreenshotResult } from "./capture.ts";
import { clampReadMaxChars, READ_MAX_CHARS, truncateReadContent } from "./playwright-driver.ts";
import { browseResult, toBrowseError } from "./results.ts";
import { SNAPSHOT_MAX_CHARS } from "./snapshot.ts";
import type { ConsoleEntry, DialogState, DownloadEntry, NetworkEntry, ReadFormat } from "./types.ts";
import {
  BROWSE_PAGE_ARG,
  BROWSE_ACTION_TIMEOUT_MS,
  BROWSE_READ_LIMIT_DEFAULT,
  BROWSE_READ_LIMIT_MAX,
  BROWSE_SCREENSHOT_TIMEOUT_MS,
  abortable,
  browseCall,
  browseResultContext,
  browseSessionKey,
  defineBrowseTool,
  invalidArgumentsError,
  oneLine,
  quote,
  resolveTimeout,
  resolveWorktreePath,
  runOnPage,
  timeoutArg,
  type BrowseRuntime,
} from "./tool-helpers.ts";

// ── browse_status ────────────────────────────────────────────────────────────

/** `browse_status` — driver, browser and session state, without launching. */
export function createBrowseStatusTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_status", {
    description:
      "Report whether browser automation is available: the Playwright module and version, the browser binary state, the active sessions and their pages, " +
      "and any pending dialog. It never launches a browser, so it is safe to call before the first browse action or after a driver error. " +
      "Playwright is an optional local dependency; when it is missing, the guidance names the install command.",
    args: {},
    async execute(_args, context) {
      const session = browseSessionKey(context);
      const manager = runtime.manager(context.worktree);
      const status = manager.status();
      const info = await abortable(context.abort, manager.info(session, context.abort));
      let dialog: DialogState | null = null;
      let dialogError: string | null = null;
      if (info.pages.length > 0) {
        try {
          dialog = await abortable(context.abort, manager.run(session, page => page.dialog(), { signal: context.abort }));
        } catch (error) {
          dialogError = toBrowseError(error).message;
        }
      }
      const activeTab = info.pages.find(tab => tab.active) ?? null;

      const lines: string[] = [];
      lines.push(status.available
        ? `Playwright: available${status.version === undefined ? "" : ` ${status.version}`}${status.resolvedPath === undefined ? "" : ` at ${status.resolvedPath}`}.`
        : `Playwright: unavailable — ${status.reason ?? "the driver did not say why"}.`);
      if (status.available) {
        lines.push(status.chromiumInstalled === true
          ? `Browser binaries: Chromium is installed${status.browsersPath === undefined ? "" : ` under ${status.browsersPath}`}.`
          : status.chromiumInstalled === false
            ? `Browser binaries: no Chromium build under ${status.browsersPath ?? "the configured browsers path"}.`
            : "Browser binaries: state unknown because PLAYWRIGHT_BROWSERS_PATH is not set; Playwright uses its own per-OS cache.");
      } else if (status.guidance !== undefined) {
        lines.push(`Install: ${status.guidance}`);
      }
      lines.push(info.pages.length === 0
        ? `Session ${quote(info.session)}: no pages and no browser running.`
        : `Session ${quote(info.session)}: ${info.engine ?? "browser not launched"}, ${info.pages.length} page(s), active ${quote(info.active ?? "")}${info.attached ? ", attached over CDP" : ""}.`);
      for (const tab of info.pages) {
        lines.push(`${tab.active ? "*" : "-"} ${tab.name}: ${tab.url === "" ? "about:blank" : tab.url}${tab.title === "" ? "" : ` — ${quote(tab.title, 120)}`} [${tab.refCount} refs]`);
      }
      if (dialog !== null) {
        lines.push(`Pending ${dialog.type} dialog: ${quote(dialog.message)}. Call browse_dialog to accept or dismiss it; the page is blocked until then.`);
      } else if (dialogError !== null) {
        lines.push(`Pending dialog: could not be read (${dialogError}).`);
      } else {
        lines.push("No dialog is open.");
      }

      return browseResult({
        title: "Browser status",
        output: lines.join("\n"),
        context: browseResultContext("browse_status", session, {
          page: activeTab?.name ?? info.active,
          url: activeTab?.url ?? "",
          title: activeTab?.title ?? "",
        }),
        metadata: {
          available: status.available,
          version: status.version ?? null,
          resolved_path: status.resolvedPath ?? null,
          browsers_path: status.browsersPath ?? null,
          chromium_installed: status.chromiumInstalled ?? null,
          guidance: status.guidance ?? null,
          engine: info.engine,
          attached: info.attached,
          session_count: manager.sessionCount,
          page_count: info.pages.length,
          active: info.active,
          tabs: info.pages.map(tab => tab.name),
          pages: info.pages,
          dialog,
          dialog_error: dialogError,
        },
      });
    },
  });
}

// ── browse_snapshot ──────────────────────────────────────────────────────────

/** `browse_snapshot` — write refs and return the page's semantic tree. */
export function createBrowseSnapshotTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_snapshot", {
    description:
      "Snapshot the page as an ARIA-shaped text tree and assign element refs (e1, e2, ...) in DOM order. " +
      "This is the only way to obtain refs: a snapshot replaces the page's previous refs, and navigation or a DOM change makes older refs stale. " +
      "selector restricts the tree to one CSS subtree, full also prints text leaves, and max_chars caps the text (default 20000, maximum 100000). " +
      "Act on refs from the latest snapshot; re-snapshot after the page changes.",
    args: {
      page: BROWSE_PAGE_ARG,
      full: z.boolean().optional().describe("Also print text leaves so the snapshot reads like page content"),
      selector: z.string().trim().min(1).max(2_000).optional().describe("CSS selector restricting the snapshot to one subtree"),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(SNAPSHOT_MAX_CHARS)
        .optional()
        .describe("Maximum characters of snapshot text (default 20000, maximum 100000)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_snapshot", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const snapshot = await page.snapshot({
          ...(args.selector === undefined ? {} : { selector: args.selector }),
          ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
          full: args.full === true,
        });
        const output = snapshot.text === ""
          ? `The page printed no accessible content (${snapshot.url}). It may still be loading, or the content may be inside an iframe or a canvas.`
          : snapshot.text;
        return browseResult({
          title: `Snapshot: ${oneLine(snapshot.title === "" ? snapshot.url : snapshot.title, 120)}`,
          output,
          context: resultContext({ url: snapshot.url, title: snapshot.title }),
          metadata: {
            ref_count: snapshot.refCount,
            node_count: snapshot.nodeCount,
            truncated: snapshot.truncated,
            chars: snapshot.text.length,
            selector: args.selector ?? null,
            full: args.full === true,
          },
        });
      });
    },
  });
}

// ── browse_read ──────────────────────────────────────────────────────────────

/** `browse_read` — read the page as markdown, text, HTML, links or tables. */
export function createBrowseReadTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_read", {
    description:
      "Read the page content as markdown (default), text, html, links or table. " +
      "markdown converts the page's HTML through the shared web reader, text returns visible text, html returns markup, " +
      "links lists anchors as markdown links, and table renders tables as markdown. " +
      "selector restricts the read to one CSS subtree and max_chars caps the result (default 20000, maximum 200000). " +
      "Use it for article-like content; use browse_snapshot when you need element refs to act on.",
    args: {
      page: BROWSE_PAGE_ARG,
      format: z
        .enum(["markdown", "text", "html", "links", "table"])
        .optional()
        .default("markdown")
        .describe("Representation to read (default markdown)"),
      selector: z.string().trim().min(1).max(2_000).optional().describe("CSS selector restricting the read to one subtree"),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(READ_MAX_CHARS)
        .optional()
        .describe("Maximum characters of content (default 20000, maximum 200000)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_read", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const format: ReadFormat = args.format;
        const read = await page.read(format, {
          ...(args.selector === undefined ? {} : { selector: args.selector }),
          ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
        });
        const output = read.content === ""
          ? `The page returned no ${format} content (${read.url}).`
          : read.content;
        return browseResult({
          title: `Read: ${oneLine(read.title === "" ? read.url : read.title, 120)} (${format})`,
          output,
          context: resultContext({ url: read.url, title: read.title }),
          metadata: {
            format,
            truncated: read.truncated,
            chars: read.content.length,
            selector: args.selector ?? null,
          },
        });
      });
    },
  });
}

// ── browse_eval ──────────────────────────────────────────────────────────────

/** Serialize an evaluated value as text or indented JSON. */
function serializeEvaluation(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** The short type name a result reports for an evaluated value. */
function evaluationType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `browse_eval` — evaluate one expression in the page and return its value. */
export function createBrowseEvalTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_eval", {
    description:
      "Evaluate a JavaScript expression in the page and return its value. " +
      "A string result is returned as text; anything else is serialized as indented JSON. " +
      "The result is capped by max_chars (default 20000, maximum 200000). " +
      "timeout_ms limits evaluation (default 15000); a timeout or cancellation closes the page to stop unfinished JavaScript. " +
      "Prefer browse_read or browse_snapshot when a dedicated representation exists, and never use eval to bypass an action that a browse tool provides.",
    args: {
      expression: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("JavaScript expression to evaluate in the page"),
      page: BROWSE_PAGE_ARG,
      timeout_ms: timeoutArg(BROWSE_ACTION_TIMEOUT_MS),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(READ_MAX_CHARS)
        .optional()
        .describe("Maximum characters of serialized result (default 20000, maximum 200000)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_eval", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const value = await page.evaluate<unknown>(args.expression, undefined, {
          timeoutMs: resolveTimeout(args.timeout_ms, BROWSE_ACTION_TIMEOUT_MS),
        });
        const maxChars = clampReadMaxChars(args.max_chars);
        const serialized = serializeEvaluation(value);
        const { content, truncated } = truncateReadContent(serialized, maxChars);
        return browseResult({
          title: `Eval: ${oneLine(args.expression, 80)}`,
          output: content,
          context: resultContext({ url: page.url }),
          metadata: {
            result_type: evaluationType(value),
            truncated,
            chars: content.length,
            max_chars: maxChars,
          },
        });
      });
    },
  });
}

// ── browse_screenshot ────────────────────────────────────────────────────────

/** Resolve and check the capture path a screenshot call names. */
function screenshotTargetPath(worktree: string, path: string, format: "png" | "jpeg"): string {
  const hint = format === "jpeg"
    ? "Pass a worktree-relative path ending in .jpg or .jpeg, or omit path to write under .rolebox/browse."
    : "Pass a worktree-relative path ending in .png, or omit path to write under .rolebox/browse.";
  const resolved = resolveWorktreePath(worktree, path, hint);
  const lower = resolved.toLowerCase();
  const allowed = format === "jpeg"
    ? lower.endsWith(".jpg") || lower.endsWith(".jpeg")
    : lower.endsWith(".png");
  if (!allowed) {
    throw invalidArgumentsError("browse_screenshot", `the path "${path}" does not end with the ${format} extension`);
  }
  return resolved;
}

/** `browse_screenshot` — capture the page or one element as an image attachment. */
export function createBrowseScreenshotTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_screenshot", {
    description:
      "Capture a PNG (default) or JPEG screenshot and return it as an image attachment. " +
      "The file is written to a UTC-stamped path under .rolebox/browse in the worktree, or to the worktree-relative path you give (it must end in .png, .jpg or .jpeg). " +
      "selector captures only that element, full_page captures the whole scrollable page, and format=jpeg accepts quality 0-100. " +
      "Use it to observe layout that text cannot show, and browse_snapshot instead when you need refs.",
    args: {
      page: BROWSE_PAGE_ARG,
      selector: z.string().trim().min(1).max(2_000).optional().describe("CSS selector capturing only that element"),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page instead of the viewport"),
      path: z
        .string()
        .trim()
        .min(1)
        .max(1_000)
        .optional()
        .describe("Worktree-relative file path; its extension must match the format"),
      format: z.enum(["png", "jpeg"]).optional().default("png").describe("Image format (default png)"),
      quality: z.number().int().min(0).max(100).optional().describe("JPEG quality 0-100; only valid with format=jpeg"),
      timeout_ms: timeoutArg(BROWSE_SCREENSHOT_TIMEOUT_MS),
    },
    async execute(args, context) {
      const format = args.format;
      if (args.quality !== undefined && format !== "jpeg") {
        throw invalidArgumentsError("browse_screenshot", "quality requires format=jpeg");
      }
      const targetPath = args.path === undefined ? null : screenshotTargetPath(context.worktree, args.path, format);
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_SCREENSHOT_TIMEOUT_MS);
      const call = browseCall({ runtime, action: "browse_screenshot", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const screenshot = await page.screenshot({
          fullPage: args.full_page === true,
          format,
          ...(args.quality === undefined ? {} : { quality: args.quality }),
          ...(args.selector === undefined ? {} : { selector: args.selector }),
          timeoutMs,
        });
        const title = await page.title();
        return browseScreenshotResult({
          worktree: context.worktree,
          screenshot,
          context: resultContext({ url: page.url, title }),
          ...(targetPath === null ? {} : { path: targetPath }),
          metadata: {
            format,
            selector: args.selector ?? null,
            full_page: args.full_page === true,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}

// ── browse_downloads ─────────────────────────────────────────────────────────

/** `browse_downloads` — list the downloads the page produced. */
export function createBrowseDownloadsTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_downloads", {
    description:
      "List the downloads this page produced since the last read. " +
      "Downloads are saved automatically by the core under .rolebox/browse/downloads in the worktree, and each entry reports its filename, status, byte count and saved path. " +
      "clear=true also empties the buffer after reading (default false, so a finished download stays visible until you close the page).",
    args: {
      page: BROWSE_PAGE_ARG,
      clear: z.boolean().optional().default(false).describe("Clear the download buffer after this read (default false)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_downloads", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const read = page.downloads();
        const entries: DownloadEntry[] = read.entries;
        if (args.clear) page.clearBuffers("downloads");
        const output = entries.length === 0
          ? `No new downloads were recorded since the last read. Downloads are saved under ${browseDownloadsDirectory(context.worktree)}.`
          : entries.map(renderDownload).join("\n");
        return browseResult({
          title: `Downloads: ${entries.length}`,
          output,
          context: resultContext({ url: page.url }),
          metadata: {
            count: entries.length,
            cursor: read.cursor,
            cleared: args.clear,
            downloads: entries,
            directory: browseDownloadsDirectory(context.worktree),
          },
        });
      });
    },
  });
}

function renderDownload(entry: DownloadEntry): string {
  const bytes = entry.bytes === undefined ? "" : `, ${entry.bytes} bytes`;
  const path = entry.path === undefined ? "" : `, saved to ${entry.path}`;
  const error = entry.error === undefined ? "" : ` (${oneLine(entry.error, 120)})`;
  return `#${entry.seq} ${entry.filename} — ${entry.status}${bytes}${path}${error}`;
}

// ── browse_console ───────────────────────────────────────────────────────────

function renderConsole(entry: ConsoleEntry): string {
  const kind = entry.kind === "console" ? entry.level : `${entry.kind}/${entry.level}`;
  const where = entry.url === "" ? "" : ` (${entry.url})`;
  return `#${entry.seq} ${kind}: ${oneLine(entry.text, 500)}${where}`;
}

/** `browse_console` — read buffered console messages and page errors. */
export function createBrowseConsoleTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_console", {
    description:
      "Read console messages, uncaught page errors and dialog events recorded since the last browse_console read. " +
      "level filters by message level (log, info, warning, error, debug) or by kind (pageerror, dialog), limit caps the most recent entries returned (default 100, maximum 1000), " +
      "and clear defaults to true so the next read starts fresh. " +
      "A read advances the cursor past every entry it saw, so a filter narrows one read rather than re-reading the buffer. " +
      "Use it first when a page misbehaves: a JavaScript error explains a click that did nothing.",
    args: {
      page: BROWSE_PAGE_ARG,
      level: z.string().trim().min(1).max(40).optional().describe("Only entries at this level or kind, for example error or pageerror"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(BROWSE_READ_LIMIT_MAX)
        .optional()
        .default(BROWSE_READ_LIMIT_DEFAULT)
        .describe(`Return at most this many recent entries (default ${BROWSE_READ_LIMIT_DEFAULT}, maximum ${BROWSE_READ_LIMIT_MAX})`),
      clear: z.boolean().optional().default(true).describe("Clear the console buffer after this read (default true)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_console", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const read = page.console();
        const entries = read.entries;
        if (args.clear) page.clearBuffers("console");
        const levels: Record<string, number> = {};
        for (const entry of entries) levels[entry.level] = (levels[entry.level] ?? 0) + 1;
        const level = args.level === undefined ? "all" : args.level.toLowerCase();
        const matched = level === "all"
          ? entries
          : entries.filter(entry => entry.level.toLowerCase() === level || entry.kind.toLowerCase() === level);
        const shown = matched.slice(-args.limit);
        const output = shown.length === 0
          ? level === "all"
            ? "No console messages or page errors were recorded since the last read."
            : `No ${quote(level)} console entries were recorded since the last read.`
          : shown.map(renderConsole).join("\n");
        return browseResult({
          title: `Console: ${shown.length}`,
          output,
          context: resultContext({ url: page.url }),
          metadata: {
            count: shown.length,
            matched: matched.length,
            total: entries.length,
            cursor: read.cursor,
            cleared: args.clear,
            level: args.level ?? null,
            levels,
            limit: args.limit,
          },
        });
      });
    },
  });
}

// ── browse_network ───────────────────────────────────────────────────────────

function isNetworkFailure(entry: NetworkEntry): boolean {
  return entry.event === "failed" || entry.ok === false;
}

function renderNetwork(entry: NetworkEntry): string {
  const status = entry.status === undefined ? (isNetworkFailure(entry) ? "FAILED" : "-") : String(entry.status);
  const error = entry.error === undefined ? "" : ` (${oneLine(entry.error, 120)})`;
  return `#${entry.seq} ${entry.method} ${status} ${entry.url} [${entry.resourceType}]${error}`;
}

/** `browse_network` — read buffered request, response and failure records. */
export function createBrowseNetworkTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_network", {
    description:
      "Read network request, response and failure records collected since the last browse_network read. " +
      "filter matches a substring of the URL or resource type, method matches an HTTP method, status matches a response status, " +
      "failed_only keeps failed requests, limit caps the most recent entries returned (default 100, maximum 1000), and clear defaults to true. " +
      "A read advances the cursor past every entry it saw, so a filter narrows one read rather than re-reading the buffer. " +
      "Use it to find the request behind a broken page instead of guessing at the cause.",
    args: {
      page: BROWSE_PAGE_ARG,
      filter: z.string().trim().min(1).max(500).optional().describe("Only entries whose URL or resource type contains this text"),
      method: z.string().trim().min(1).max(20).optional().describe("Only this HTTP method, for example GET or POST"),
      status: z.number().int().min(100).max(599).optional().describe("Only this HTTP response status"),
      failed_only: z.boolean().optional().default(false).describe("Only failed requests and responses (default false)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(BROWSE_READ_LIMIT_MAX)
        .optional()
        .default(BROWSE_READ_LIMIT_DEFAULT)
        .describe(`Return at most this many recent entries (default ${BROWSE_READ_LIMIT_DEFAULT}, maximum ${BROWSE_READ_LIMIT_MAX})`),
      clear: z.boolean().optional().default(true).describe("Clear the network buffer after this read (default true)"),
    },
    async execute(args, context) {
      const call = browseCall({ runtime, action: "browse_network", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const read = page.network();
        const entries = read.entries;
        if (args.clear) page.clearBuffers("network");
        const needle = args.filter?.toLowerCase();
        let matched = entries;
        if (needle !== undefined) {
          matched = matched.filter(entry =>
            entry.url.toLowerCase().includes(needle) || entry.resourceType.toLowerCase().includes(needle));
        }
        if (args.method !== undefined) {
          const method = args.method.toUpperCase();
          matched = matched.filter(entry => entry.method.toUpperCase() === method);
        }
        if (args.status !== undefined) {
          matched = matched.filter(entry => entry.status === args.status);
        }
        if (args.failed_only) matched = matched.filter(isNetworkFailure);

        const shown = matched.slice(-args.limit);
        const methods: Record<string, number> = {};
        for (const entry of entries) methods[entry.method] = (methods[entry.method] ?? 0) + 1;
        const failed = entries.filter(isNetworkFailure).length;
        const output = shown.length === 0
          ? `No network records matched since the last read (${entries.length} new record(s) were filtered out).`
          : shown.map(renderNetwork).join("\n");
        return browseResult({
          title: `Network: ${shown.length}`,
          output,
          context: resultContext({ url: page.url }),
          metadata: {
            count: shown.length,
            matched: matched.length,
            total: entries.length,
            failed,
            methods,
            cursor: read.cursor,
            cleared: args.clear,
            filter: args.filter ?? null,
            method: args.method ?? null,
            status: args.status ?? null,
            failed_only: args.failed_only,
            limit: args.limit,
          },
        });
      });
    },
  });
}
