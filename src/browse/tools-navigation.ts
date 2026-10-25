/**
 * Session and navigation tools: `browse_open`, `browse_close`, `browse_tabs`,
 * `browse_history` and `browse_wait`.
 *
 * These are the tools that decide where the browser is, as opposed to what it
 * reads or clicks. `browse_open` is idempotent per page name — it creates a
 * missing page, reuses an existing one and only navigates when a `url` is given
 * — so a model can call it again after an error without opening a second tab.
 * `browse_close` is the one operation that tears a session down: closing the
 * browser drops every page and its ref map, which is what the result says.
 *
 * Tabs are named pages inside one session (`main` is the default), and every
 * other browse tool takes the same `page` argument, so a result that names
 * `page` is always addressable again.
 */

import { z } from "zod";
import type { CanonicalToolDef } from "../platform/ports/tool-factory.ts";
import { browseErrorResult, browseResult } from "./results.ts";
import type { NavigationResult, TabInfo } from "./types.ts";
import type { BrowseSessionInfo } from "./session.ts";
import {
  BROWSE_DEFAULT_VIEWPORT,
  BROWSE_NAVIGATION_TIMEOUT_MS,
  BROWSE_PAGE_ARG,
  BROWSE_WAIT_TIMEOUT_MS,
  abortable,
  browseCall,
  browseResultContext,
  browseSessionKey,
  defineBrowseTool,
  invalidArgumentsError,
  quote,
  resolveTimeout,
  runOnPage,
  timeoutArg,
  validateNavigationUrl,
  type BrowseRuntime,
} from "./tool-helpers.ts";

// ── Shared rendering ─────────────────────────────────────────────────────────

/** One line per tab, marking the active page. */
function renderTabs(tabs: readonly TabInfo[]): string {
  return tabs
    .map(tab => {
      const marker = tab.active ? "*" : "-";
      const title = tab.title === "" ? "" : ` — ${quote(tab.title, 120)}`;
      return `${marker} ${tab.name}${tab.active ? " (active)" : ""}: ${tab.url === "" ? "about:blank" : tab.url}${title} [${tab.refCount} refs]`;
    })
    .join("\n");
}

/** The navigation line shared by open, tabs and history results. */
function renderNavigation(navigation: NavigationResult): string {
  const status = navigation.status === null ? "" : ` (HTTP ${navigation.status})`;
  const title = navigation.title === "" ? "" : ` — ${quote(navigation.title, 120)}`;
  return `Now at ${navigation.url}${status}${title}.`;
}

// ── browse_open ──────────────────────────────────────────────────────────────

/** `browse_open` — create or reuse a named page, optionally navigating it. */
export function createBrowseOpenTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_open", {
    description:
      "Open the browser for this session and create or reuse a named page, optionally navigating to a URL. " +
      "The page defaults to the session's active page, initially main. " +
      "A missing page is created, an existing page is reused, and navigation only happens when url is given. " +
      "browser defaults to chromium, headless to true, wait_until to domcontentloaded and viewport to 1440x900; " +
      "browser, headless, cdp_url and viewport only apply before this session's browser has launched, so close the session first to change them. " +
      "Call browse_snapshot after open to read the page and get element refs. " +
      "The local browser can reach localhost development servers.",
    args: {
      url: z
        .string()
        .trim()
        .min(1)
        .max(4_000)
        .optional()
        .describe("Absolute URL to navigate to after the page exists; omit to only create or reuse the page"),
      page: BROWSE_PAGE_ARG,
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .default("chromium")
        .describe("Browser engine (default chromium); applied only before the session's browser launches"),
      headless: z
        .boolean()
        .optional()
        .default(true)
        .describe("Run without a visible window (default true); applied only before the browser launches"),
      cdp_url: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe("Attach to a Chromium already listening on this CDP endpoint instead of launching (chromium only)"),
      viewport: z
        .object({
          width: z.number().int().min(1).max(10_000).describe("Viewport width in CSS pixels"),
          height: z.number().int().min(1).max(10_000).describe("Viewport height in CSS pixels"),
        })
        .optional()
        .describe("Viewport for a new browser (default 1440x900); applied only before the browser launches"),
      timeout_ms: timeoutArg(BROWSE_NAVIGATION_TIMEOUT_MS),
      wait_until: z
        .enum(["load", "domcontentloaded", "networkidle", "commit"])
        .optional()
        .default("domcontentloaded")
        .describe("Navigation lifecycle event to wait for (default domcontentloaded)"),
    },
    async execute(args, context) {
      const session = browseSessionKey(context);
      const manager = runtime.manager(context.worktree);
      const pageName = args.page;
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_NAVIGATION_TIMEOUT_MS);
      const targetUrl = args.url === undefined ? undefined : validateNavigationUrl(args.url);
      if (args.cdp_url !== undefined && args.browser !== "chromium") {
        throw invalidArgumentsError("browse_open", "cdp_url is only supported with browser=chromium");
      }
      const state = { page: pageName ?? null, url: "", title: "" };
      try {
        const current = await abortable(context.abort, manager.info(session, context.abort));
        const existing = pageName === undefined
          ? undefined
          : current.pages.find(page => page.name === pageName);
        const settings = {
          signal: context.abort,
          engine: args.browser,
          headless: args.headless,
          viewport: args.viewport ?? BROWSE_DEFAULT_VIEWPORT,
          ...(args.cdp_url === undefined ? {} : { cdpUrl: args.cdp_url }),
          ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
        };
        let info: BrowseSessionInfo;
        if (pageName === undefined) {
          info = await abortable(context.abort, manager.ensure(session, settings));
        } else if (existing === undefined) {
          info = await abortable(context.abort, manager.newPage(session, pageName, settings));
        } else {
          info = await abortable(context.abort, manager.selectPage(session, pageName, settings));
        }
        const created = current.pages.every(page => page.name !== (info.active ?? ""));

        const activeName = info.active ?? "";
        let navigation: NavigationResult | null = null;
        if (targetUrl !== undefined) {
          navigation = await abortable(context.abort, manager.run(session, page => page.goto(targetUrl, {
            timeoutMs,
            waitUntil: args.wait_until,
          }), { page: activeName, signal: context.abort }));
        }

        const tab = info.pages.find(page => page.name === activeName);
        state.page = activeName === "" ? null : activeName;
        state.url = navigation?.url ?? tab?.url ?? "";
        state.title = navigation?.title ?? tab?.title ?? "";

        const head = created
          ? `Created page ${quote(activeName)}`
          : pageName === undefined
            ? `Opened page ${quote(activeName)}`
            : `Reused page ${quote(activeName)}`;
        const lines = [`${head} in ${info.engine ?? args.browser}.`];
        if (navigation !== null) lines.push(renderNavigation(navigation));
        lines.push("Call browse_snapshot to read the page and get element refs.");
        return browseResult({
          title: `Open: ${activeName === "" ? session : activeName}`,
          output: lines.join("\n"),
          context: browseResultContext("browse_open", session, state),
          metadata: {
            browser: info.engine ?? args.browser,
            headless: args.headless,
            attached: info.attached,
            created,
            navigated: navigation !== null,
            status: navigation?.status ?? null,
            wait_until: args.wait_until,
            timeout_ms: timeoutMs,
            page_count: info.pages.length,
            tabs: info.pages.map(page => page.name),
          },
        });
      } catch (error) {
        return browseErrorResult(browseResultContext("browse_open", session, state), error);
      }
    },
  });
}

// ── browse_close ─────────────────────────────────────────────────────────────

/** `browse_close` — close one page, or the whole session browser. */
export function createBrowseCloseTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_close", {
    description:
      "Close one page, or the whole browser session when no page is given or all is true. " +
      "Closing a page drops that page's snapshot refs and leaves the other pages running; closing the session closes every page and the browser, " +
      "so the next browse call starts a fresh browser. Use it when a browsing task is finished.",
    args: {
      page: BROWSE_PAGE_ARG,
      all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Close the whole browser session even when a page is named (default false)"),
    },
    async execute(args, context) {
      const session = browseSessionKey(context);
      const manager = runtime.manager(context.worktree);
      try {
        if (args.all || args.page === undefined) {
          const current = await abortable(context.abort, manager.info(session, context.abort));
          const names = current.pages.map(page => page.name);
          await abortable(context.abort, manager.close(session, context.abort));
          const output = names.length === 0
            ? `No browser session was open for ${quote(session)}; nothing to close.`
            : `Closed the browser for session ${quote(session)} and its ${names.length} page(s) (${names.join(", ")}); every page and its snapshot refs are gone. Call browse_open to start again.`;
          return browseResult({
            title: "Closed the browser session",
            output,
            context: browseResultContext("browse_close", session, { page: null }),
            metadata: { closed: "session", pages_closed: names.length, remaining: 0, tabs: [], active: null },
          });
        }

        const pageName = args.page;
        const info = await abortable(context.abort, manager.closePage(session, pageName, { signal: context.abort }));
        const remaining = info.pages.map(page => page.name);
        const output = remaining.length === 0
          ? `Closed page ${quote(pageName)}; no pages remain in session ${quote(session)}. The browser is still running, so browse_open or browse_tabs action=new starts the next page.`
          : `Closed page ${quote(pageName)}; ${remaining.length} page(s) remain (active ${quote(info.active ?? "")}). Snapshot refs for the closed page are gone.`;
        return browseResult({
          title: `Closed page: ${pageName}`,
          output,
          context: browseResultContext("browse_close", session, { page: info.active ?? null }),
          metadata: {
            closed: "page",
            closed_page: pageName,
            pages_closed: 1,
            remaining: remaining.length,
            tabs: remaining,
            active: info.active,
          },
        });
      } catch (error) {
        return browseErrorResult(browseResultContext("browse_close", session, { page: args.page ?? null }), error);
      }
    },
  });
}

// ── browse_tabs ──────────────────────────────────────────────────────────────

/** `browse_tabs` — list, create, select and close the session's named pages. */
export function createBrowseTabsTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_tabs", {
    description:
      "Manage the session's tabs, which are named pages: " +
      "action=list lists them without launching a browser, action=new creates and activates a page (a name is required), " +
      "action=select activates an existing page (a name is required), and action=close closes the named page or the active page. " +
      "url only applies to action=new, which navigates the new page after creating it. " +
      "Every other browse tool accepts the same page name, and the active page is what a call without page uses.",
    args: {
      action: z
        .enum(["list", "new", "select", "close"])
        .describe("list, new, select or close"),
      page: BROWSE_PAGE_ARG,
      url: z
        .string()
        .trim()
        .min(1)
        .max(4_000)
        .optional()
        .describe("Absolute URL to navigate to, only with action=new"),
    },
    async execute(args, context) {
      const session = browseSessionKey(context);
      const manager = runtime.manager(context.worktree);
      const pageName = args.page;
      try {
        if (args.action === "list") {
          if (pageName !== undefined) throw invalidArgumentsError("browse_tabs", "action=list does not take page");
          if (args.url !== undefined) throw invalidArgumentsError("browse_tabs", "action=list does not take url");
          const tabs = await abortable(context.abort, manager.pages(session, { signal: context.abort }));
          const active = tabs.find(tab => tab.active)?.name ?? null;
          const output = tabs.length === 0
            ? `No pages are open in session ${quote(session)}; browse_open creates one.`
            : renderTabs(tabs);
          return browseResult({
            title: `Tabs: ${tabs.length}`,
            output,
            context: browseResultContext("browse_tabs", session, {
              page: active,
              url: tabs.find(tab => tab.active)?.url ?? "",
              title: tabs.find(tab => tab.active)?.title ?? "",
            }),
            metadata: { tabs: tabs.map(tab => tab.name), pages: tabs, active, count: tabs.length, action_name: "list" },
          });
        }

        if (args.url !== undefined && args.action !== "new") {
          throw invalidArgumentsError("browse_tabs", `url only applies to action=new, not action=${args.action}`);
        }
        if (args.action === "new") {
          if (pageName === undefined) throw invalidArgumentsError("browse_tabs", "action=new requires page");
          const url = args.url === undefined ? undefined : validateNavigationUrl(args.url);
          const info = await abortable(context.abort, manager.newPage(session, pageName, { signal: context.abort }));
          let navigation: NavigationResult | null = null;
          if (url !== undefined) {
            navigation = await abortable(context.abort, manager.run(session, page => page.goto(url, {
              timeoutMs: BROWSE_NAVIGATION_TIMEOUT_MS,
              waitUntil: "domcontentloaded",
            }), { page: pageName, signal: context.abort }));
          }
          const tab = info.pages.find(page => page.name === pageName);
          const lines = [`Created and activated page ${quote(pageName ?? "")}.`];
          if (navigation !== null) lines.push(renderNavigation(navigation));
          lines.push(renderTabs(info.pages));
          return browseResult({
            title: `New tab: ${pageName ?? ""}`,
            output: lines.join("\n"),
            context: browseResultContext("browse_tabs", session, {
              page: pageName ?? null,
              url: navigation?.url ?? tab?.url ?? "",
              title: navigation?.title ?? tab?.title ?? "",
            }),
            metadata: {
              action_name: "new",
              created: pageName ?? "",
              navigated: navigation !== null,
              status: navigation?.status ?? null,
              tabs: info.pages.map(page => page.name),
              pages: info.pages,
              active: info.active,
              count: info.pages.length,
            },
          });
        }

        if (args.action === "select") {
          if (pageName === undefined) throw invalidArgumentsError("browse_tabs", "action=select requires page");
          const info = await abortable(context.abort, manager.selectPage(session, pageName, { signal: context.abort }));
          const tab = info.pages.find(page => page.name === pageName);
          return browseResult({
            title: `Selected tab: ${pageName ?? ""}`,
            output: `Active page is now ${quote(pageName ?? "")}${tab === undefined ? "" : `: ${tab.url === "" ? "about:blank" : tab.url}`}. Call browse_snapshot to read it.`,
            context: browseResultContext("browse_tabs", session, {
              page: pageName ?? null,
              url: tab?.url ?? "",
              title: tab?.title ?? "",
            }),
            metadata: {
              action_name: "select",
              tabs: info.pages.map(page => page.name),
              pages: info.pages,
              active: info.active,
              count: info.pages.length,
            },
          });
        }

        const before = await abortable(context.abort, manager.pages(session, { signal: context.abort }));
        if (before.length === 0) {
          return browseResult({
            title: "Tabs: 0",
            output: `No pages are open in session ${quote(session)}; nothing to close.`,
            context: browseResultContext("browse_tabs", session, { page: null }),
            metadata: {
              action_name: "close",
              closed_page: pageName ?? null,
              tabs: [],
              pages: [],
              active: null,
              count: 0,
            },
          });
        }
        const info = await abortable(context.abort, manager.closePage(session, pageName, { signal: context.abort }));
        const remaining = info.pages.map(page => page.name);
        return browseResult({
          title: `Closed tab: ${pageName ?? "active"}`,
          output: pageName === undefined
            ? `Closed the active page; ${remaining.length} page(s) remain${remaining.length === 0 ? "" : ` (${remaining.join(", ")})`}.`
            : `Closed page ${quote(pageName)}; ${remaining.length} page(s) remain${remaining.length === 0 ? "" : ` (${remaining.join(", ")})`}.`,
          context: browseResultContext("browse_tabs", session, { page: info.active ?? null }),
          metadata: {
            action_name: "close",
            closed_page: pageName ?? null,
            tabs: remaining,
            pages: info.pages,
            active: info.active,
            count: remaining.length,
          },
        });
      } catch (error) {
        return browseErrorResult(browseResultContext("browse_tabs", session, { page: pageName ?? null }), error);
      }
    },
  });
}

// ── browse_history ───────────────────────────────────────────────────────────

/** `browse_history` — back, forward or reload the current page. */
export function createBrowseHistoryTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_history", {
    description:
      "Move through the current page's history: action=back, action=forward or action=reload. " +
      "Every navigation drops the page's snapshot refs, so call browse_snapshot again before acting on the new page.",
    args: {
      action: z.enum(["back", "forward", "reload"]).describe("back, forward or reload"),
      page: BROWSE_PAGE_ARG,
      timeout_ms: timeoutArg(BROWSE_NAVIGATION_TIMEOUT_MS),
    },
    async execute(args, context) {
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_NAVIGATION_TIMEOUT_MS);
      const call = browseCall({ runtime, action: "browse_history", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        const options = { timeoutMs, waitUntil: "domcontentloaded" as const };
        const navigation = args.action === "back"
          ? await page.back(options)
          : args.action === "forward"
            ? await page.forward(options)
            : await page.reload(options);
        const verb = args.action === "back" ? "Went back" : args.action === "forward" ? "Went forward" : "Reloaded";
        return browseResult({
          title: `History: ${args.action}`,
          output: `${verb}: ${renderNavigation(navigation)} Call browse_snapshot again because the previous refs are stale.`,
          context: resultContext({ url: navigation.url, title: navigation.title }),
          metadata: {
            history_action: args.action,
            status: navigation.status,
            timeout_ms: timeoutMs,
            refs_reset: true,
          },
        });
      });
    },
  });
}

// ── browse_wait ──────────────────────────────────────────────────────────────

/** `browse_wait` — wait for one of text, selector or URL (and optionally a load state). */
export function createBrowseWaitTool(runtime: BrowseRuntime): CanonicalToolDef {
  return defineBrowseTool("browse_wait", {
    description:
      "Wait until exactly one of text, selector or url appears: text matches visible text, selector is a CSS selector for a visible element, " +
      "and url waits until the page URL contains that text. " +
      "state optionally waits for a page lifecycle state (load, domcontentloaded, networkidle or commit) first. " +
      "Pass exactly one of text, selector or url; any other combination is rejected. " +
      "Waiting does not refresh snapshot refs, so call browse_snapshot after a wait that changed the page.",
    args: {
      page: BROWSE_PAGE_ARG,
      text: z.string().trim().min(1).max(1_000).optional().describe("Visible text to wait for"),
      selector: z.string().trim().min(1).max(2_000).optional().describe("CSS selector of an element to wait for"),
      url: z.string().trim().min(1).max(2_000).optional().describe("Text the page URL must contain"),
      state: z
        .enum(["load", "domcontentloaded", "networkidle", "commit"])
        .optional()
        .describe("Also wait for this page lifecycle state before the text, selector or URL"),
      timeout_ms: timeoutArg(BROWSE_WAIT_TIMEOUT_MS),
    },
    async execute(args, context) {
      const conditions = [args.text, args.selector, args.url].filter(value => value !== undefined);
      if (conditions.length !== 1) {
        throw invalidArgumentsError(
          "browse_wait",
          conditions.length === 0
            ? "exactly one of text, selector or url is required, but none was given"
            : `exactly one of text, selector or url is required, but ${conditions.length} were given`,
        );
      }
      const timeoutMs = resolveTimeout(args.timeout_ms, BROWSE_WAIT_TIMEOUT_MS);
      const call = browseCall({ runtime, action: "browse_wait", context, page: args.page });
      return runOnPage(call, context, async (page, resultContext) => {
        if (args.state !== undefined) await page.waitForLoadState(args.state, { timeoutMs });
        let waitedFor: "text" | "selector" | "url";
        let value: string;
        if (args.text !== undefined) {
          waitedFor = "text";
          value = args.text;
          await page.wait({ target: { kind: "text", text: args.text }, timeoutMs });
        } else if (args.selector !== undefined) {
          waitedFor = "selector";
          value = args.selector;
          await page.wait({ target: { kind: "css", selector: args.selector }, timeoutMs });
        } else if (args.url !== undefined) {
          waitedFor = "url";
          value = args.url;
          await page.wait({ url: value, timeoutMs });
        } else {
          // The exactly-one-condition check above makes this unreachable.
          throw invalidArgumentsError("browse_wait", "exactly one of text, selector or url is required");
        }
        const description = waitedFor === "text"
          ? `text ${quote(value)} appeared`
          : waitedFor === "selector"
            ? `${value} appeared`
            : `the page URL contains ${quote(value)}`;
        return browseResult({
          title: `Wait: ${waitedFor}`,
          output: `Waited up to ${timeoutMs}ms and ${description}${args.state === undefined ? "" : ` after the ${args.state} state`}; the page is at ${page.url}.`,
          context: resultContext({ url: page.url }),
          metadata: {
            waited_for: waitedFor,
            value,
            state: args.state ?? null,
            timeout_ms: timeoutMs,
          },
        });
      });
    },
  });
}
