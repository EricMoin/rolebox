import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:html-md");

const MAX_OUTPUT_BYTES = 30 * 1024; // 30KB

// Elements to remove from HTML before conversion
const REMOVE_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg",
  "nav", "footer", "header", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  ".ads", ".advertisement", ".cookie-banner", ".popup",
].join(", ");

// Configure Turndown for LLM-friendly output
function createTurndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    hr: "---",
  });
  td.use(gfm);
  // Remove empty links and images with no meaningful content
  td.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return td;
}

const turndown = createTurndownService();

/**
 * Convert raw HTML to clean, LLM-friendly Markdown.
 * Strips navigation, scripts, ads, and other boilerplate.
 * Truncates output to 30KB.
 */
export function convertHtmlToMarkdown(html: string, url?: string): string {
  try {
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $(REMOVE_SELECTORS).remove();

    // Try to extract main content area, fallback to full body
    let content = $("main").html()
      || $("article").html()
      || $("[role='main']").html()
      || $(".content, .post, .article, .entry-content, #content, #main").first().html()
      || $("body").html()
      || html;

    // Convert HTML to Markdown
    let markdown = turndown.turndown(content);

    // Clean up excessive whitespace (3+ newlines → 2)
    markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

    // Add source attribution
    if (url) {
      markdown = `> Source: ${url}\n\n${markdown}`;
    }

    // Truncate if needed
    if (Buffer.byteLength(markdown, "utf-8") > MAX_OUTPUT_BYTES) {
      // Find a safe truncation point (don't cut mid-word)
      const truncated = Buffer.from(markdown, "utf-8").subarray(0, MAX_OUTPUT_BYTES).toString("utf-8");
      const lastNewline = truncated.lastIndexOf("\n");
      markdown = (lastNewline > MAX_OUTPUT_BYTES * 0.8 ? truncated.slice(0, lastNewline) : truncated)
        + "\n\n... (truncated to 30KB)";
    }

    return markdown;
  } catch (error) {
    log.warn("HTML-to-Markdown conversion failed", { url, error });
    // Fallback: strip HTML tags naively
    const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const result = url ? `> Source: ${url}\n\n${stripped}` : stripped;
    return result.slice(0, MAX_OUTPUT_BYTES);
  }
}
