import { createSubLogger } from "../logger.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";

const log = createSubLogger("web:crawlee");

interface CrawleeSearchResult {
  title: string;
  url: string;
  snippet: string;
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
    const { CheerioCrawler, createCheerioRouter } = await import("crawlee");

    const results: CrawleeSearchResult[] = [];
    const router = createCheerioRouter();

    router.addDefaultHandler(async ({ $ }) => {
      $(".result").each((_i: number, el: any): boolean | void => {
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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
 * Fetch a page using Crawlee's PlaywrightCrawler for JS-heavy pages
 * with built-in anti-detection and session management.
 *
 * Only called when Crawlee (with Playwright dependency available) is
 * confirmed via `detectBrowserCapabilities()`.
 */
export async function fetchWithCrawlee(
  url: string,
  selector?: string,
): Promise<string | null> {
  try {
    const { PlaywrightCrawler, createPlaywrightRouter } = await import(
      "crawlee"
    );

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

    await crawler.run([url]);

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
