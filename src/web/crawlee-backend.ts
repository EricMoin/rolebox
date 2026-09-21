import type { CheerioAPI } from "cheerio";
import { createSubLogger } from "../logger.ts";
import { buildBrowserHeaders } from "./http-utils.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";

const log = createSubLogger("web:crawlee");

interface CrawleeSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Accept header for the DuckDuckGo HTML endpoint. */
const DDG_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

// ── Optional-dependency boundary ─────────────────────────────────────────────
//
// `crawlee` is an optional peer dependency ("crawlee": ">=3.0.0",
// peerDependenciesMeta.optional). The ambient declarations in crawlee.d.ts are
// too narrow for the options this module uses, so instead of extending them it
// describes everything it calls with the local structural types below and
// narrows the dynamic-import result once, at the boundary.

/** One crawl request: a URL plus the request-level options Crawlee accepts. */
interface CrawleeRequestLike {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: string;
}

/** The part of Crawlee's crawler API this module runs. */
interface CrawleeCrawlerLike {
  run(requests: Array<string | CrawleeRequestLike>): Promise<void>;
}

/** Handler context Crawlee passes to a Cheerio router. */
interface CrawleeCheerioContext {
  $: CheerioAPI;
}

interface CrawleeCheerioRouterLike {
  addDefaultHandler(handler: (context: CrawleeCheerioContext) => void | Promise<void>): void;
}

interface CrawleeElementHandleLike {
  innerHTML(): Promise<string>;
}

interface CrawleePageLike {
  $(selector: string): Promise<CrawleeElementHandleLike | null>;
  content(): Promise<string>;
}

/** Handler context Crawlee passes to a Playwright router. */
interface CrawleePlaywrightContext {
  page: CrawleePageLike;
}

interface CrawleePlaywrightRouterLike {
  addDefaultHandler(handler: (context: CrawleePlaywrightContext) => void | Promise<void>): void;
}

interface CrawleeCheerioCrawlerOptions {
  requestHandler: CrawleeCheerioRouterLike;
  maxRequestsPerCrawl?: number;
  maxConcurrency?: number;
}

interface CrawleePlaywrightCrawlerOptions {
  requestHandler: CrawleePlaywrightRouterLike;
  maxRequestsPerCrawl?: number;
  maxConcurrency?: number;
  headless?: boolean;
}

/** Structural view of the `crawlee` module. */
interface CrawleeModuleLike {
  CheerioCrawler?: new (options: CrawleeCheerioCrawlerOptions) => CrawleeCrawlerLike;
  PlaywrightCrawler?: new (options: CrawleePlaywrightCrawlerOptions) => CrawleeCrawlerLike;
  createCheerioRouter?: () => CrawleeCheerioRouterLike;
  createPlaywrightRouter?: () => CrawleePlaywrightRouterLike;
}

/**
 * Load the optional `crawlee` module.
 *
 * The single assertion at this boundary is deliberate: the package is an
 * optional peer dependency whose ambient declarations are too narrow for the
 * options used here, so the dynamic import result is narrowed once to the
 * structural interfaces above, which are the contract this module relies on.
 *
 * Deliberately not configured here: session pools, retryOnBlocked and
 * launchContext. Their names and availability differ across the crawlee 3.x
 * range this package claims support for, and an unverifiable option risks a
 * runtime throw that silently disables the whole backend.
 */
async function loadCrawlee(): Promise<CrawleeModuleLike> {
  const mod: unknown = await import("crawlee");
  return mod as CrawleeModuleLike;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search DuckDuckGo using Crawlee's CheerioCrawler for better anti-detection.
 *
 * Only called when Crawlee is confirmed available via
 * `detectBrowserCapabilities()` — the dynamic import may throw
 * if the package is not installed.
 */
export async function searchWithCrawlee(
  query: string,
  maxResults: number,
): Promise<CrawleeSearchResult[]> {
  try {
    const { CheerioCrawler, createCheerioRouter } = await loadCrawlee();
    if (CheerioCrawler === undefined || createCheerioRouter === undefined) {
      log.warn("Crawlee module exposes no CheerioCrawler", { query });
      return [];
    }

    const results: CrawleeSearchResult[] = [];
    const router = createCheerioRouter();

    router.addDefaultHandler(({ $ }) => {
      $(".result").each((_i, el) => {
        if (results.length >= maxResults) return false;
        const $el = $(el);
        const titleEl = $el.find("h2 a");
        const title = titleEl.text().trim();
        const href = titleEl.attr("href") || "";
        const urlMatch = href.match(/uddg=([^&]+)/);
        const url = urlMatch ? decodeURIComponent(urlMatch[1]) : href;
        const snippet = $el.find(".result__snippet").text().trim();

        if (title && url && url.startsWith("http")) {
          results.push({ title, url, snippet: snippet || "(no snippet)" });
        }
      });
    });

    const crawler = new CheerioCrawler({
      requestHandler: router,
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
    });

    await crawler.run([
      {
        url: "https://html.duckduckgo.com/html",
        method: "POST",
        headers: {
          ...buildBrowserHeaders({ accept: DDG_ACCEPT }),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      },
    ]);

    log.info("Crawlee DDG search succeeded", {
      query,
      resultCount: results.length,
    });
    return results;
  } catch (error) {
    log.warn("Crawlee search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page fetch
// ---------------------------------------------------------------------------

/**
 * Fetch a page using Crawlee's PlaywrightCrawler for JS-heavy pages.
 *
 * Only called when Crawlee (with Playwright dependency available) is
 * confirmed via `detectBrowserCapabilities()`. The request carries the shared
 * browser header profile so the network request looks like the same client the
 * static fetch pretends to be.
 */
export async function fetchWithCrawlee(
  url: string,
  selector?: string,
): Promise<string | null> {
  try {
    const { PlaywrightCrawler, createPlaywrightRouter } = await loadCrawlee();
    if (PlaywrightCrawler === undefined || createPlaywrightRouter === undefined) {
      log.warn("Crawlee module exposes no PlaywrightCrawler", { url });
      return null;
    }

    let html = "";
    const router = createPlaywrightRouter();

    router.addDefaultHandler(async ({ page }) => {
      if (selector) {
        const element = await page.$(selector);
        html = element ? await element.innerHTML() : await page.content();
      } else {
        html = await page.content();
      }
    });

    const crawler = new PlaywrightCrawler({
      requestHandler: router,
      maxRequestsPerCrawl: 1,
      maxConcurrency: 1,
      headless: true,
    });

    await crawler.run([{ url, headers: buildBrowserHeaders() }]);

    if (!html) return null;

    const markdown = convertHtmlToMarkdown(html, url);
    const byteLen = Buffer.byteLength(markdown);
    log.info("Crawlee page fetch succeeded", { url, bytes: byteLen });
    return markdown;
  } catch (error) {
    log.warn("Crawlee page fetch failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
