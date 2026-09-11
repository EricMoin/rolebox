import { createSubLogger } from "../logger.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";

const log = createSubLogger("web:playwright");

/**
 * Fetch a page using Playwright headless browser.
 *
 * Only called when Playwright is confirmed available via
 * `detectBrowserCapabilities()` — the dynamic import may throw
 * if the package is not installed.
 *
 * @param url - The URL to fetch
 * @param options - Optional settings (selector, timeout)
 * @returns Markdown string or null on failure
 */
export async function fetchWithPlaywright(
  url: string,
  options?: { selector?: string; timeout?: number },
): Promise<string | null> {
  try {
    // Dynamic import — only resolved if playwright is installed
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();

      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: options?.timeout ?? 30000,
      });

      let html: string;
      if (options?.selector) {
        const element = await page.$(options.selector);
        html = element ? await element.innerHTML() : await page.content();
      } else {
        html = await page.content();
      }

      await browser.close();

      const markdown = convertHtmlToMarkdown(html, url);
      const byteLen = Buffer.byteLength(markdown);
      log.info("Playwright fetch succeeded", { url, bytes: byteLen });
      return markdown;
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    log.warn("Playwright fetch failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
