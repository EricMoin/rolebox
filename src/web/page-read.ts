import { z } from "zod";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { createSubLogger } from "../logger.ts";
import { TokenBucket, fetchWithRetry, fetchWithTimeout, BROWSER_USER_AGENT } from "./http-utils.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";
import { detectBrowserCapabilities } from "./browser-detect.ts";
import { fetchWithPlaywright } from "./playwright-backend.ts";
import { fetchWithCrawlee } from "./crawlee-backend.ts";

const log = createSubLogger("web:read");

const MAX_OUTPUT_BYTES = 30 * 1024;

// Rate limiter for Jina Reader (conservative 15 RPM for anonymous)
const jinaBucket = new TokenBucket(15);

/**
 * Factory function to create the web_read tool.
 * Reads a URL and converts it to clean LLM-friendly Markdown.
 * Primary backend: Jina Reader (no API key needed).
 * Fallback: Local fetch + Cheerio + Turndown.
 */
export function createPageReadTool() {
  return defineTool({
    description:
      "Fetch a URL and convert its content to clean, LLM-friendly Markdown. " +
      "No API key required. Supports JS-rendered pages via 'browser' engine. " +
      "Use CSS selectors to extract specific content sections.",
    args: {
      url: z.string().url().describe("Full URL of the page to read"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector to extract specific content (e.g. '.main-content', '#article')"),
      engine: z
        .enum(["default", "browser"])
        .optional()
        .default("default")
        .describe("Render engine: 'default' for static HTML, 'browser' for JS-heavy SPAs"),
    },
    async execute(args) {
      const { url, selector, engine } = args;
      log.info("Reading page", { url, selector, engine });

      // Try Jina Reader first
      const jinaResult = await tryJinaReader(url, selector, engine);
      if (jinaResult) return jinaResult;
      // Browser fallback: try Playwright/Crawlee when JS rendering is needed
      // or when Jina failed and a browser engine is requested
      const caps = await detectBrowserCapabilities();
      const needsBrowser = engine === "browser";

      if (needsBrowser && caps.crawlee) {
        log.info("Jina failed, falling back to Crawlee PlaywrightCrawler", { url });
        const crawleeResult = await fetchWithCrawlee(url, selector);
        if (crawleeResult) return crawleeResult;
      } else if (needsBrowser && caps.playwright) {
        log.info("Jina failed, falling back to raw Playwright", { url });
        const pwResult = await fetchWithPlaywright(url, { selector });
        if (pwResult) return pwResult;
      }

      // Final fallback: local fetch + Turndown
      log.info("All browser backends exhausted, falling back to local fetch", { url });
      const localResult = await tryLocalFetch(url);
      if (localResult) return localResult;

      // All failed
      return formatError(url, "All sources failed. The URL may be inaccessible or blocking automated access.");
    },
  });
}

async function tryJinaReader(
  url: string,
  selector: string | undefined,
  engine: string,
): Promise<string | null> {
  try {
    await jinaBucket.acquire();

    const headers: Record<string, string> = {
      Accept: "text/markdown",
      "X-Timeout": "15",
    };

    if (engine === "browser") {
      headers["X-Engine"] = "browser";
    }

    if (selector) {
      headers["X-Target-Selector"] = selector;
    }

    // Jina Reader: prepend r.jina.ai/ to the target URL
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetchWithRetry(jinaUrl, { headers }, 2, 2000);

    let content = await response.text();

    // Truncate if too long
    if (Buffer.byteLength(content, "utf-8") > MAX_OUTPUT_BYTES) {
      const buf = Buffer.from(content, "utf-8").subarray(0, MAX_OUTPUT_BYTES);
      content = buf.toString("utf-8");
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline > MAX_OUTPUT_BYTES * 0.8) {
        content = content.slice(0, lastNewline);
      }
      content += "\n\n... (truncated to 30KB)";
    }

    log.info("Jina Reader succeeded", { url, bytes: Buffer.byteLength(content) });
    return content;
  } catch (error) {
    log.warn("Jina Reader failed", { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function tryLocalFetch(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      15000,
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = await response.text();
    const markdown = convertHtmlToMarkdown(html, url);

    log.info("Local fetch succeeded", { url, bytes: Buffer.byteLength(markdown) });
    return markdown;
  } catch (error) {
    log.warn("Local fetch failed", { url, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function formatError(url: string, message: string): string {
  return `## Error Reading Page\n\n**URL:** ${url}\n\n**Error:** ${message}\n\nTry:\n- Verify the URL is correct and accessible\n- Use \`engine: "browser"\` for JavaScript-rendered pages\n- Use a \`selector\` to target specific content`;
}
