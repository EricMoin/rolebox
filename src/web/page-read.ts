import { z } from "zod";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { createSubLogger } from "../logger.ts";
import { TokenBucket, fetchWithRetry, fetchWithTimeout, buildBrowserHeaders } from "./http-utils.ts";
import { detectBlockSignal, isJinaErrorBody } from "./bot-detection.ts";
import { decodeText, readBodyCapped } from "./response-body.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";
import { detectBrowserCapabilities } from "./browser-detect.ts";
import { validateUrl } from "./ssrf-guard.ts";
import { fetchWithPlaywright } from "./playwright-backend.ts";
import { fetchWithCrawlee } from "./crawlee-backend.ts";

const log = createSubLogger("web:read");

const MAX_OUTPUT_BYTES = 30 * 1024;

/** How many leading body characters are inspected for an interstitial. */
const BLOCK_INSPECT_CHARS = 8192;

// Rate limiter for Jina Reader (conservative 15 RPM for anonymous)
const jinaBucket = new TokenBucket(15);

/**
 * Mutable slot the local fetch fills in when it sees a bot-protection block,
 * so the caller's final error can say the site refused automated access. The
 * reason already names the provider, so that is the only thing carried.
 */
interface BlockContext {
  reason: string | null;
}

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
      "Use CSS selectors to extract specific content sections. " +
      "For simple page/article reads to clean markdown. For multi-format, multi-engine, or API fetching with custom headers, use web_fetch instead.",
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

      // SSRF protection
      const urlCheck = validateUrl(url);
      if (!urlCheck.ok) {
        log.warn("SSRF guard blocked URL", { url, reason: urlCheck.error });
        return formatError(url, `Blocked: ${urlCheck.error}`);
      }

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
      const block: BlockContext = { reason: null };
      const localResult = await tryLocalFetch(url, block);
      if (localResult) return localResult;

      // All failed
      if (block.reason !== null) {
        return formatError(
          url,
          `All sources failed. The site appears to be blocking automated access (${block.reason}). ` +
            'Try engine: "browser" to render the page with a real browser, or retry later.',
        );
      }
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

    const { bytes } = await readBodyCapped(response);
    let content = decodeText(bytes, response.headers.get("content-type")).text;

    if (isJinaErrorBody(content)) {
      log.warn("Jina Reader returned an error body", { url, status: response.status });
      return null;
    }

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

/**
 * Last-resort static fetch of a page, converted to markdown.
 *
 * Reads through {@link readBodyCapped}, decodes with the response charset and
 * classifies the result with {@link detectBlockSignal}: a corroborated block
 * (Cloudflare challenge, protection provider header or interstitial marker)
 * fills the caller's {@link BlockContext} and returns null, so the final error
 * can say the site refused automated access instead of pretending the page was
 * simply unavailable.
 *
 * @param url - Absolute target URL.
 * @param block - Mutable slot recording a block signal, when one was seen.
 * @returns Markdown, or null when the fetch failed or was blocked.
 */
async function tryLocalFetch(url: string, block: BlockContext): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(
      url,
      { headers: buildBrowserHeaders() },
      15000,
    );

    const contentType = response.headers.get("content-type") || "";
    const { bytes } = await readBodyCapped(response);
    const { text } = decodeText(bytes, contentType);

    const signal = detectBlockSignal({
      status: response.status,
      headers: response.headers,
      bodySample: text.slice(0, BLOCK_INSPECT_CHARS),
      // The sample is truncated, so declare the real size; otherwise the
      // advisory 2xx guard would misread a long legitimate page as blocked.
      bodyLength: text.length,
    });
    if (signal.blocked) {
      log.warn("Local fetch looks blocked", {
        url,
        status: response.status,
        provider: signal.provider,
        reason: signal.reason,
      });
      block.reason = signal.reason;
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text")) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const markdown = convertHtmlToMarkdown(text, url);

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
