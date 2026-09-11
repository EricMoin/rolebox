import { z } from "zod";
import * as cheerio from "cheerio";
import { defineTool } from "../platform/ports/tool-factory.ts";
import type { ToolResult } from "../platform/types.ts";
import { createSubLogger } from "../logger.ts";
import {
  TokenBucket,
  fetchWithTimeout,
  fetchWithRetry,
  fetchWithCloudflareRetry,
  BROWSER_USER_AGENT,
} from "./http-utils.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";
import { detectBrowserCapabilities } from "./browser-detect.ts";
import { fetchWithPlaywright } from "./playwright-backend.ts";
import { fetchWithCrawlee } from "./crawlee-backend.ts";
import { detectContentType } from "./mime-detect.ts";
import type { ContentTypeInfo } from "./mime-detect.ts";
import { extractMetadata } from "./metadata-extract.ts";
import type { PageMetadata } from "./metadata-extract.ts";
import { extractArticle } from "./readability-backend.ts";
import { validateUrl } from "./ssrf-guard.ts";

const log = createSubLogger("web:fetch");

// Rate limiter for Jina Reader (conservative 15 RPM for anonymous)
const jinaBucket = new TokenBucket(15);

// ── Internal types ───────────────────────────────────────────────────────────

interface FetchResult {
  body: ArrayBuffer;
  contentType: string;
  statusCode: number;
}

// ── Accept header builder ────────────────────────────────────────────────────

/**
 * Build a q-weighted Accept header based on the desired output format.
 * Helps servers return content in the preferred format.
 */
function buildAcceptHeader(format: string): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1";
    case "json":
      return "application/json;q=1.0, text/json;q=0.9, */*;q=0.1";
    case "raw":
    case "auto":
    default:
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  }
}

// ── Fetch engines ────────────────────────────────────────────────────────────

/**
 * Default HTTP fetch with Cloudflare retry support.
 * Returns raw response body as ArrayBuffer with status code and content type.
 */
async function fetchDefault(
  url: string,
  headers: Record<string, string>,
  timeoutSec: number,
): Promise<FetchResult> {
  try {
    const response = await fetchWithCloudflareRetry(
      url,
      { headers },
      timeoutSec * 1000,
    );

    const body = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/octet-stream";

    return {
      body,
      contentType,
      statusCode: response.status,
    };
  } catch (error) {
    log.warn("Default fetch failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { body: new ArrayBuffer(0), contentType: "", statusCode: 0 };
  }
}

/**
 * Fetch via Jina Reader for instant, LLM-friendly markdown conversion.
 * Rate-limited with TokenBucket(15). Opt-in browser rendering via X-Engine header.
 */
async function fetchViaJina(
  url: string,
  selector: string | undefined,
  timeoutSec: number,
): Promise<FetchResult> {
  try {
    await jinaBucket.acquire();

    const headers: Record<string, string> = {
      Accept: "text/markdown",
      "X-Timeout": String(timeoutSec),
    };

    if (selector) {
      headers["X-Target-Selector"] = selector;
    }

    // Jina Reader: prepend r.jina.ai/ to the target URL
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetchWithRetry(jinaUrl, { headers }, 2, 2000);

    const text = await response.text();
    const encoder = new TextEncoder();
    const encoded = encoder.encode(text);

    log.info("Jina Reader succeeded", { url, bytes: encoded.byteLength });
    return {
      body: encoded.buffer.slice(0, encoded.byteLength),
      contentType: "text/markdown",
      statusCode: response.status,
    };
  } catch (error) {
    log.warn("Jina Reader failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { body: new ArrayBuffer(0), contentType: "", statusCode: 0 };
  }
}

/**
 * Fetch via browser automation (Crawlee PlaywrightCrawler → raw Playwright fallback).
 * Detects available backends at runtime via dynamic import.
 */
async function fetchViaBrowser(
  url: string,
  selector: string | undefined,
  timeoutSec: number,
): Promise<FetchResult> {
  const caps = await detectBrowserCapabilities();
  let result: string | null = null;

  // Try Crawlee first (more robust with session management)
  if (caps.crawlee) {
    log.info("Using Crawlee browser backend", { url });
    result = await fetchWithCrawlee(url, selector);
  }

  // Fallback to raw Playwright
  if (result === null && caps.playwright) {
    log.info("Crawlee unavailable, falling back to raw Playwright", { url });
    result = await fetchWithPlaywright(url, { selector, timeout: timeoutSec * 1000 });
  }

  if (result !== null) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(result);
    log.info("Browser fetch succeeded", { url, bytes: encoded.byteLength });
    return {
      body: encoded.buffer.slice(0, encoded.byteLength),
      contentType: "text/markdown",
      statusCode: 200,
    };
  }

  log.warn("All browser backends exhausted", { url });
  return { body: new ArrayBuffer(0), contentType: "", statusCode: 0 };
}

// ── Attachment builders ──────────────────────────────────────────────────────

function buildImageAttachment(url: string, mime: string, body: ArrayBuffer): ToolResult {
  const bytes = body.byteLength;
  const base64 = Buffer.from(body).toString("base64");
  const dataUri = `data:${mime};base64,${base64}`;

  return {
    title: `Image: ${url}`,
    output: `[image: ${mime}, ${bytes} bytes]`,
    metadata: {},
    attachments: [
      {
        type: "file",
        mime,
        url: dataUri,
        filename: url.split("/").pop() || `image.${mime.split("/").pop()}`,
      },
    ],
  };
}

function buildPdfAttachment(url: string, body: ArrayBuffer): ToolResult {
  const bytes = body.byteLength;
  const base64 = Buffer.from(body).toString("base64");
  const dataUri = `data:application/pdf;base64,${base64}`;

  return {
    title: `PDF: ${url}`,
    output: `[pdf: application/pdf, ${bytes} bytes]`,
    metadata: {},
    attachments: [
      {
        type: "file",
        mime: "application/pdf",
        url: dataUri,
        filename: url.split("/").pop() || "document.pdf",
      },
    ],
  };
}

// ── HTML/Text processing helpers ─────────────────────────────────────────────

/**
 * Extract content from HTML using a CSS selector.
 * Returns the inner HTML of the first matching element, or the full HTML.
 */
function extractWithSelector(html: string, selector: string): string {
  try {
    const $ = cheerio.load(html);
    const el = $(selector).first();
    if (el.length) {
      return el.html() || html;
    }
    log.warn("CSS selector matched no elements", { selector });
    return html;
  } catch (error) {
    log.warn("CSS selector extraction failed", {
      selector,
      error: error instanceof Error ? error.message : String(error),
    });
    return html;
  }
}

/**
 * Strip all HTML tags, returning only visible text content.
 * Skips script, style, noscript, and SVG elements.
 */
function extractPlainText(html: string): string {
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript, svg").remove();
    const text = $("body").text() || $.root().text();
    return text.replace(/\s+/g, " ").trim();
  } catch (error) {
    log.warn("Plain text extraction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fallback: naive tag stripping
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

/**
 * Clean HTML by removing script, style, and noscript elements
 * while preserving structural HTML tags.
 */
function cleanHtml(html: string): string {
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    return $.html() || html;
  } catch (error) {
    log.warn("HTML cleaning failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return html;
  }
}

/**
 * Attempt to parse text as JSON and pretty-print it.
 * Falls back to the raw text if parsing fails.
 */
function tryParseJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Resolve the output format when format is "auto".
 * - JSON content type → "json"
 * - HTML content type → "markdown"
 * - Text content type → "text"
 * - Everything else → "raw"
 */
function resolveFormat(format: string, ct: ContentTypeInfo): string {
  if (format !== "auto") return format;
  if (ct.isJson) return "json";
  if (ct.isHtml) return "markdown";
  if (ct.isText) return "text";
  return "raw";
}

/**
 * Smartly truncate text at a paragraph/newline boundary within maxBytes.
 * Appends a truncated marker if the text was cut.
 * If text fits within maxBytes, returns it unchanged.
 */
function smartTruncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;

  const truncated = Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8");
  const marker = "\n\n... (truncated)";

  // Try to break at a paragraph boundary (double newline)
  const paraBreak = truncated.lastIndexOf("\n\n");
  if (paraBreak > maxBytes * 0.5) {
    return truncated.slice(0, paraBreak) + marker;
  }

  // Fallback to single newline boundary
  const lineBreak = truncated.lastIndexOf("\n");
  if (lineBreak > maxBytes * 0.3) {
    return truncated.slice(0, lineBreak) + marker;
  }

  // Last resort: break at word boundary
  const spaceBreak = truncated.lastIndexOf(" ");
  if (spaceBreak > 0) {
    return truncated.slice(0, spaceBreak) + marker;
  }

  return truncated + marker;
}

// ── Error formatting ─────────────────────────────────────────────────────────

const RECOVERY_SUGGESTIONS = [
  "Verify the URL is correct and accessible",
  'Use engine: "browser" for JavaScript-rendered pages',
  'Use a selector to target specific content (e.g. ".main-content")',
  'Try format: "raw" for binary content',
  'Use engine: "jina" for Jina Reader-powered fetching',
  'Use engine: "reader" for Mozilla Readability article extraction',
  'Increase timeout for slow pages (max 120s)',
];

function formatError(url: string, message: string): string {
  const suggestions = RECOVERY_SUGGESTIONS.map((s) => `- ${s}`).join("\n");
  return `## Error Fetching URL\n\n**URL:** ${url}\n\n**Error:** ${message}\n\nTry:\n${suggestions}`;
}

// ── Tool factory ─────────────────────────────────────────────────────────────

/**
 * Factory function to create the web_fetch tool.
 *
 * A comprehensive HTTP client that fetches URLs and converts content
 * to multiple output formats. Supports SSRF protection, multiple
 * rendering engines (static fetch, Jina Reader, browser automation,
 * Mozilla Readability), CSS selector extraction, content type
 * detection, smart truncation, and metadata extraction.
 */
export function createWebFetchTool() {
  return defineTool({
    description:
      "Fetch a URL and convert its content to the requested format. " +
      "Supports multiple rendering engines: 'default' (static HTTP), " +
      "'browser' (Playwright/Crawlee JS rendering), 'jina' (Jina Reader " +
      "optimized markdown), and 'reader' (Mozilla Readability article " +
      "extraction). Output formats include 'markdown', 'text', 'html', " +
      "'json', 'raw', and 'auto' (smart format selection). CSS selectors " +
      "extract specific sections. SSRF-protected. Smart truncation at " +
      "paragraph boundaries. Optional metadata extraction. " +
      "Versatile HTTP client with format/engine selection. For simple article reading to markdown, consider the lighter web_read.",
    args: {
      url: z.string().url().describe("Full URL of the page to fetch (http or https)"),
      format: z
        .enum(["markdown", "text", "html", "json", "raw", "auto"])
        .optional()
        .default("auto")
        .describe(
          "Output format. 'auto' selects based on content type. " +
            "'markdown' converts HTML to clean markdown. 'text' strips all " +
            "tags. 'html' returns sanitized HTML. 'json' parses and " +
            "pretty-prints JSON. 'raw' returns as-is (base64 for binary).",
        ),
      engine: z
        .enum(["default", "browser", "jina", "reader"])
        .optional()
        .default("default")
        .describe(
          "Rendering engine. 'default' for static fetch. 'browser' for " +
            "JS-rendered pages (requires playwright/crawlee). 'jina' uses " +
            "Jina Reader. 'reader' uses Mozilla Readability for article " +
            "extraction.",
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to extract specific content from the page " +
            "(e.g. '.main-content', '#article')",
        ),
      timeout: z
        .number()
        .min(1)
        .max(120)
        .optional()
        .default(30)
        .describe("Request timeout in seconds (1-120, default 30)"),
      max_size: z
        .number()
        .min(1024)
        .max(5242880)
        .optional()
        .default(51200)
        .describe("Maximum output size in bytes (default 50KB, max 5MB)"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Custom request headers to send"),
      include_metadata: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include page metadata (title, description, author, etc.) in the output"),
    },
    async execute(args) {
      const {
        url,
        format,
        engine,
        selector,
        timeout,
        max_size,
        headers: customHeaders,
        include_metadata,
      } = args;

      // ── Coalesce optional parameters with defaults ─────────────────────
      const effectiveTimeout = timeout ?? 30;
      const effectiveMaxSize = max_size ?? 51200;
      const effectiveFormat = format ?? "auto";
      const effectiveEngine = engine ?? "default";
      const effectiveIncludeMetadata = include_metadata ?? false;

      log.info("Fetching URL", { url, format: effectiveFormat, engine: effectiveEngine, selector, timeout: effectiveTimeout });

      // ── LAYER 1: Request Validation ──────────────────────────────────────
      // 1a. SSRF protection
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        log.warn("SSRF guard blocked URL", { url, reason: urlCheck.reason });
        return formatError(url, `Blocked: ${urlCheck.reason}`);
      }

      // 1b. Build format-aware Accept header
      const acceptHeader = buildAcceptHeader(effectiveFormat);

      // 1c. Assemble request headers
      const requestHeaders: Record<string, string> = {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: acceptHeader,
        "Accept-Language": "en-US,en;q=0.9",
        ...customHeaders,
      };

      // ── LAYER 2: Fetch with engine selection ─────────────────────────────
      let fetchResult: FetchResult;
      let rawHtml: string | undefined; // preserved for metadata extraction

      switch (effectiveEngine) {
        case "jina":
          fetchResult = await fetchViaJina(url, selector, effectiveTimeout);
          break;
        case "browser":
          fetchResult = await fetchViaBrowser(url, selector, effectiveTimeout);
          break;
        case "reader": {
          // Fetch raw HTML first
          fetchResult = await fetchDefault(url, requestHeaders, effectiveTimeout);
          if (fetchResult.statusCode > 0) {
            // Apply Readability extraction
            const html = new TextDecoder().decode(fetchResult.body);
            rawHtml = html; // preserve for metadata
            const article = await extractArticle(html, url);
            if (article) {
              log.info("Readability extracted article", {
                title: article.title,
                length: article.length,
              });
              const encoder = new TextEncoder();
              const encoded = encoder.encode(article.content);
              fetchResult = {
                body: encoded.buffer.slice(0, encoded.byteLength),
                contentType: "text/html",
                statusCode: fetchResult.statusCode,
              };
            } else {
              log.info("Readability returned null, using raw HTML", { url });
            }
          }
          break;
        }
        default:
          fetchResult = await fetchDefault(url, requestHeaders, effectiveTimeout);
          break;
      }

      // Check for empty/error response
      if (fetchResult.statusCode === 0 || fetchResult.body.byteLength === 0) {
        return formatError(url, "All sources failed. The URL may be inaccessible or blocking automated access.");
      }

      // ── LAYER 3: Content Type Detection ──────────────────────────────────
      const bodyBytes = new Uint8Array(fetchResult.body);
      const bodyStart = bodyBytes.slice(0, Math.min(16, bodyBytes.byteLength));
      const ct = detectContentType(fetchResult.contentType, bodyStart);

      log.info("Content type detected", {
        mime: ct.mime,
        isHtml: ct.isHtml,
        isImage: ct.isImage,
        isPdf: ct.isPdf,
        isText: ct.isText,
        isJson: ct.isJson,
        isSvg: ct.isSvg,
        isBinary: ct.isBinary,
      });

      // ── LAYER 4: Binary / Attachment Handling ────────────────────────────
      if (ct.isImage && !ct.isSvg) {
        return buildImageAttachment(url, ct.mime, fetchResult.body);
      }

      if (ct.isPdf) {
        return buildPdfAttachment(url, fetchResult.body);
      }

      if (ct.isBinary && !ct.isSvg) {
        return formatError(
          url,
          `Binary content (${ct.mime}, ${fetchResult.body.byteLength} bytes) ` +
            `cannot be displayed as text. Use format: "raw" to get base64.`,
        );
      }

      // ── LAYER 5: Text Content Decoding ───────────────────────────────────
      let textContent: string;
      try {
        textContent = new TextDecoder().decode(fetchResult.body);
      } catch (error) {
        log.warn("Text decoding failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return formatError(url, "Failed to decode response body as text");
      }

      // Save raw HTML for metadata extraction if not already saved
      if (rawHtml === undefined && ct.isHtml) {
        rawHtml = textContent;
      }

      // ── LAYER 6: CSS Selector Extraction ─────────────────────────────────
      if (selector && ct.isHtml) {
        log.info("Applying CSS selector extraction", { selector });
        textContent = extractWithSelector(textContent, selector);
      }

      // ── LAYER 7: Format Conversion ───────────────────────────────────────
      const resolvedFormat = resolveFormat(effectiveFormat, ct);
      let output: string;

      switch (resolvedFormat) {
        case "markdown":
          output = ct.isHtml ? convertHtmlToMarkdown(textContent, url) : textContent;
          break;
        case "text":
          output = ct.isHtml ? extractPlainText(textContent) : textContent;
          break;
        case "html":
          output = ct.isHtml ? cleanHtml(textContent) : textContent;
          break;
        case "json":
          output = tryParseJson(textContent);
          break;
        case "raw":
          output = textContent;
          break;
        default:
          output = textContent;
      }

      // ── LAYER 8: Post-Processing ─────────────────────────────────────────
      // Truncation
      output = smartTruncate(output, effectiveMaxSize);

      // Metadata injection
      if (effectiveIncludeMetadata && rawHtml) {
        const metadata = extractMetadata(rawHtml, url);
        log.info("Including page metadata", { title: metadata.title });
        return {
          title: `${url} (${ct.mime})`,
          output,
          metadata: metadata as unknown as Record<string, unknown>,
        };
      }

      return {
        title: `${url} (${ct.mime})`,
        output,
        metadata: {},
      };
    },
  });
}
