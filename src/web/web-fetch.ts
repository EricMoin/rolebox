import { z } from "zod";
import * as cheerio from "cheerio";
import { defineTool } from "../platform/ports/tool-factory.ts";
import type { ToolResult } from "../platform/types.ts";
import { createSubLogger } from "../logger.ts";
import {
  TokenBucket,
  fetchWithRetry,
  fetchWithCloudflareRetry,
  buildBrowserHeaders,
} from "./http-utils.ts";
import { detectBlockSignal, isJinaErrorBody } from "./bot-detection.ts";
import { decodeText, readBodyCapped, toArrayBuffer } from "./response-body.ts";
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

/** How many leading body bytes are inspected for a bot-protection interstitial. */
const BLOCK_INSPECT_BYTES = 8192;

/**
 * Statuses that mean "try another engine": a server-declared rate limit (429)
 * or overload (503). A 403 is deliberately absent — this tool returns it with
 * its body and status unless bot-detection.ts corroborates a block from a
 * challenge header, a protection-provider header or an interstitial marker.
 */
const KILL_STATUSES = new Set([429, 503]);

/** Bot-protection attribution carried alongside a fetch result. */
interface BlockInfo {
  provider: string | null;
  reason: string;
}

interface FetchResult {
  body: ArrayBuffer;
  contentType: string;
  statusCode: number;
  /** Set when the response looks like a bot-protection interstitial. */
  block: BlockInfo | null;
}

/** Engines this tool can attempt, in the order the plan resolves them. */
type EngineId = "default" | "jina" | "reader" | "browser";

/** Retry budget handed to one Jina Reader request. */
interface JinaBudget {
  maxRetries: number;
  baseDelayMs: number;
}

/** An explicitly requested Jina engine keeps its patient retry budget. */
const JINA_EXPLICIT_BUDGET: JinaBudget = { maxRetries: 2, baseDelayMs: 2000 };

/** An automatic escalation must fail fast instead of stalling the whole tool. */
const JINA_ESCALATION_BUDGET: JinaBudget = { maxRetries: 1, baseDelayMs: 500 };

/** Everything one engine attempt needs. */
interface AttemptContext {
  url: string;
  headers: Record<string, string>;
  selector: string | undefined;
  timeoutSec: number;
  jinaBudget: JinaBudget;
}

/** One engine attempt: the result plus the pre-Readability HTML when relevant. */
interface AttemptOutcome {
  result: FetchResult;
  rawHtml?: string;
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
 *
 * The body is read through {@link readBodyCapped} so a hostile or endless
 * response cannot exhaust memory, and the response is classified with
 * {@link detectBlockSignal} so a challenge page can be told apart from real
 * content. Transport failures are logged and collapsed into a status-0 result
 * that carries no body, which is the signal the caller escalates on.
 *
 * @param url - Absolute request URL.
 * @param headers - Request headers, already merged with the browser profile.
 * @param timeoutSec - Per-attempt timeout in seconds.
 * @returns Body, content type, status code and any block signal.
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

    const { bytes } = await readBodyCapped(response);
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const signal = detectBlockSignal({
      status: response.status,
      headers: response.headers,
      bodySample: new TextDecoder("latin1").decode(bytes.subarray(0, BLOCK_INSPECT_BYTES)),
      // The sample above is truncated, so the real length must be declared:
      // otherwise the advisory 2xx size guard sees only 8 KB and a long
      // legitimate page that mentions an interstitial phrase reads as blocked.
      bodyLength: bytes.byteLength,
    });

    if (signal.blocked) {
      log.warn("Default fetch looks blocked", {
        url,
        status: response.status,
        provider: signal.provider,
        reason: signal.reason,
      });
    }

    return {
      body: toArrayBuffer(bytes),
      contentType,
      statusCode: response.status,
      block: signal.blocked ? { provider: signal.provider, reason: signal.reason } : null,
    };
  } catch (error) {
    log.warn("Default fetch failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { body: new ArrayBuffer(0), contentType: "", statusCode: 0, block: null };
  }
}

/**
 * Fetch via Jina Reader for instant, LLM-friendly markdown conversion.
 * Rate-limited with TokenBucket(15). Opt-in browser rendering via X-Engine header.
 *
 * The retry budget is a parameter: an explicitly requested Jina engine keeps
 * the patient budget, while an automatic escalation uses a cheaper one so a
 * failing provider fails fast. A Jina error body is a failure, not an answer —
 * the caller must escalate instead of returning the error text as content.
 *
 * @param url - Absolute target URL.
 * @param selector - Optional CSS selector forwarded as X-Target-Selector.
 * @param timeoutSec - Per-attempt timeout in seconds.
 * @param budget - Retry budget for the Jina request.
 * @returns Markdown bytes, or a status-0 result when Jina failed.
 */
async function fetchViaJina(
  url: string,
  selector: string | undefined,
  timeoutSec: number,
  budget: JinaBudget,
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
    const response = await fetchWithRetry(
      jinaUrl,
      { headers },
      budget.maxRetries,
      budget.baseDelayMs,
      timeoutSec * 1000,
    );

    const { bytes } = await readBodyCapped(response);
    const { text, charset } = decodeText(bytes, response.headers.get("content-type"));

    if (isJinaErrorBody(text)) {
      log.warn("Jina Reader returned an error body", { url, status: response.status, charset });
      return { body: new ArrayBuffer(0), contentType: "", statusCode: 0, block: null };
    }

    const encoded = new TextEncoder().encode(text);

    log.info("Jina Reader succeeded", { url, bytes: encoded.byteLength, charset });
    return {
      body: toArrayBuffer(encoded),
      contentType: "text/markdown",
      statusCode: response.status,
      block: null,
    };
  } catch (error) {
    log.warn("Jina Reader failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { body: new ArrayBuffer(0), contentType: "", statusCode: 0, block: null };
  }
}

/**
 * Fetch via browser automation (Crawlee PlaywrightCrawler → raw Playwright fallback).
 * Detects available backends at runtime via dynamic import.
 *
 * @param url - Absolute target URL.
 * @param selector - Optional CSS selector for the content region.
 * @param timeoutSec - Navigation timeout in seconds.
 * @returns Rendered markdown bytes, or a status-0 result when no backend produced HTML.
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
    const encoded = new TextEncoder().encode(result);
    log.info("Browser fetch succeeded", { url, bytes: encoded.byteLength });
    return {
      body: toArrayBuffer(encoded),
      contentType: "text/markdown",
      statusCode: 200,
      block: null,
    };
  }

  log.warn("All browser backends exhausted", { url });
  return { body: new ArrayBuffer(0), contentType: "", statusCode: 0, block: null };
}

/**
 * Run one engine attempt.
 *
 * The reader engine is the static fetch plus Mozilla Readability; it returns
 * the raw HTML alongside the extracted article so metadata extraction keeps
 * working exactly as it did before.
 *
 * @param engine - Engine to run.
 * @param context - URL, headers, selector, timeout and Jina budget.
 * @returns The attempt result and, for the reader engine, the source HTML.
 */
async function runEngine(engine: EngineId, context: AttemptContext): Promise<AttemptOutcome> {
  const { url, headers, selector, timeoutSec, jinaBudget } = context;

  switch (engine) {
    case "jina":
      return { result: await fetchViaJina(url, selector, timeoutSec, jinaBudget) };
    case "browser":
      return { result: await fetchViaBrowser(url, selector, timeoutSec) };
    case "reader": {
      const result = await fetchDefault(url, headers, timeoutSec);
      if (result.statusCode === 0 || result.body.byteLength === 0) {
        return { result };
      }

      const { text: html } = decodeText(new Uint8Array(result.body), result.contentType);
      const article = await extractArticle(html, url);
      if (article === null) {
        log.info("Readability returned null, using raw HTML", { url });
        return { result, rawHtml: html };
      }

      log.info("Readability extracted article", {
        title: article.title,
        length: article.length,
      });
      const encoded = new TextEncoder().encode(article.content);
      return {
        result: {
          body: toArrayBuffer(encoded),
          contentType: "text/html",
          statusCode: result.statusCode,
          block: result.block,
        },
        rawHtml: html,
      };
    }
    case "default":
    default:
      return { result: await fetchDefault(url, headers, timeoutSec) };
  }
}

/**
 * Ordered engines to try for the requested engine, stopping at the first
 * usable result. A browser backend only appears when one is installed.
 *
 * @param engine - Engine the caller asked for.
 * @param browserAvailable - Whether playwright or crawlee is installed.
 */
function planAttempts(engine: EngineId, browserAvailable: boolean): EngineId[] {
  switch (engine) {
    case "jina":
      return browserAvailable ? ["jina", "default", "browser"] : ["jina", "default"];
    case "reader":
      return browserAvailable ? ["reader", "jina", "browser"] : ["reader", "jina"];
    case "browser":
      // No browser backend installed: the static fetch is the honest fallback.
      return browserAvailable ? ["browser", "default", "jina"] : ["default", "jina"];
    case "default":
    default:
      return browserAvailable ? ["default", "jina", "browser"] : ["default", "jina"];
  }
}

/**
 * Why a result is not good enough to answer with, or null when it is usable.
 *
 * Escalation happens on a transport failure, an empty body, a corroborated
 * block signal or a 429/503 kill status. A bare 403 is returned with its body
 * and status, as are ordinary client errors (401/404/410, ...).
 *
 * @param result - One engine attempt result.
 */
function escalationReason(result: FetchResult): string | null {
  if (result.statusCode === 0) return "transport failure (status 0)";
  if (result.body.byteLength === 0) return "empty response body";
  if (result.block !== null) return result.block.reason;
  if (KILL_STATUSES.has(result.statusCode)) return `HTTP ${result.statusCode} is a bot-protection status`;
  return null;
}

/**
 * Compose the failure paragraph shown when every planned engine failed.
 *
 * Names the engines that were attempted, the last block reason when there was
 * one, and the two escalation levers the caller still has.
 *
 * @param attempted - Engines that ran, in order.
 * @param lastBlock - Last block signal seen, if any.
 * @param lastStatus - Last non-zero HTTP status seen, if any.
 */
function describeFailure(
  attempted: EngineId[],
  lastBlock: BlockInfo | null,
  lastStatus: number,
): string {
  const parts = [
    "All sources failed. The URL may be inaccessible or blocking automated access.",
    `Engines attempted: ${attempted.join(", ")}.`,
  ];
  if (lastBlock !== null) {
    parts.push(`Last block: ${lastBlock.reason}.`);
  } else if (lastStatus > 0) {
    parts.push(`Last response: HTTP ${lastStatus}.`);
  }
  parts.push('If the site is blocking automated access, try engine: "browser" or engine: "jina".');
  return parts.join(" ");
}

/**
 * Append the browser-unavailable note to a tool result's output.
 *
 * @param result - Result produced by a fetch path.
 * @param note - Trailing note, or null to return the result unchanged.
 */
function appendNote(result: ToolResult, note: string | null): ToolResult {
  if (note === null || typeof result === "string") return result;
  return { ...result, output: `${result.output}\n\n${note}` };
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

  // A cut at a byte boundary can leave a dangling multi-byte character as a
  // U+FFFD replacement character; drop it instead of printing a broken glyph.
  const cut = Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8");
  const truncated = cut.endsWith("\uFFFD") ? cut.slice(0, -1) : cut;
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
      if (!urlCheck.ok) {
        log.warn("SSRF guard blocked URL", { url, reason: urlCheck.error });
        return formatError(url, `Blocked: ${urlCheck.error}`);
      }

      // 1b. Build format-aware Accept header
      const acceptHeader = buildAcceptHeader(effectiveFormat);

      // 1c. Assemble request headers from the shared browser profile; explicit
      // caller headers always win over the profile.
      const requestHeaders: Record<string, string> = {
        ...buildBrowserHeaders({ accept: acceptHeader }),
        ...customHeaders,
      };

      // ── LAYER 2: Fetch with bounded engine escalation ────────────────────
      // Stop at the first usable result (not blocked, non-empty body). The
      // order is the requested engine first, then the fallbacks it allows.
      const caps = await detectBrowserCapabilities();
      const browserAvailable = caps.playwright || caps.crawlee;
      const attempts = planAttempts(effectiveEngine, browserAvailable);
      const browserNote =
        effectiveEngine === "browser" && !browserAvailable
          ? "> Note: browser engine unavailable (playwright/crawlee not installed); used static fetch."
          : null;
      if (browserNote !== null) {
        log.info("Browser engine requested but unavailable; using the static fetch", { url });
      }

      const attemptContext: AttemptContext = {
        url,
        headers: requestHeaders,
        selector,
        timeoutSec: effectiveTimeout,
        jinaBudget: effectiveEngine === "jina" ? JINA_EXPLICIT_BUDGET : JINA_ESCALATION_BUDGET,
      };

      let fetchResult: FetchResult | null = null;
      let rawHtml: string | undefined; // preserved for metadata extraction
      let lastBlock: BlockInfo | null = null;
      let lastStatus = 0;
      const attempted: EngineId[] = [];

      for (const engineId of attempts) {
        attempted.push(engineId);
        const outcome = await runEngine(engineId, attemptContext);
        lastBlock = outcome.result.block ?? lastBlock;
        if (outcome.result.statusCode > 0) lastStatus = outcome.result.statusCode;

        const reason = escalationReason(outcome.result);
        if (reason === null) {
          fetchResult = outcome.result;
          rawHtml = outcome.rawHtml;
          break;
        }
        log.info("Escalating to the next fetch engine", {
          url,
          engine: engineId,
          reason,
          status: outcome.result.statusCode,
        });
      }

      if (fetchResult === null) {
        return formatError(url, describeFailure(attempted, lastBlock, lastStatus));
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
        return appendNote(buildImageAttachment(url, ct.mime, fetchResult.body), browserNote);
      }

      if (ct.isPdf) {
        return appendNote(buildPdfAttachment(url, fetchResult.body), browserNote);
      }

      if (ct.isBinary && !ct.isSvg) {
        return formatError(
          url,
          `Binary content (${ct.mime}, ${fetchResult.body.byteLength} bytes) ` +
            `cannot be displayed as text. Use format: "raw" to get base64.`,
        );
      }

      // ── LAYER 5: Text Content Decoding ───────────────────────────────────
      // decodeText never throws: it falls back through BOM, header charset,
      // meta sniff and UTF-8, so a GBK/Big5 page reads instead of turning mojibake.
      const { text: decodedText, charset } = decodeText(
        new Uint8Array(fetchResult.body),
        fetchResult.contentType,
      );
      let textContent = decodedText;
      log.info("Decoded response body", { url, charset, bytes: fetchResult.body.byteLength });

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
      // Truncate first, then append the note so it is never cut off.
      output = smartTruncate(output, effectiveMaxSize);
      if (browserNote !== null) {
        output = `${output}\n\n${browserNote}`;
      }

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
