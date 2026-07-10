import * as cheerio from "cheerio";
import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:metadata");

export interface PageMetadata {
  title: string | null;
  description: string | null;
  author: string | null;
  published: string | null;
  favicon: string | null;
  image: string | null;
  canonical: string | null;
  siteName: string | null;
  type: string | null;
}

/**
 * Resolve a potentially relative URL to an absolute URL using the base URL.
 * Returns null when the href is missing or unparseable.
 */
function resolveUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Extract page metadata from raw HTML by parsing <meta>, <link>, and <title> tags.
 *
 * Supports standard meta tags, Open Graph properties, and article-specific
 * attributes. All relative URLs are resolved against the provided baseUrl.
 *
 * @param html - Raw HTML string to parse
 * @param baseUrl - Base URL for resolving relative URLs
 * @returns A PageMetadata object with extracted values (null for missing fields)
 */
export function extractMetadata(html: string, baseUrl: string): PageMetadata {
  try {
    const $ = cheerio.load(html);

    // Title: <title> tag, fallback to og:title
    const title =
      $("title").first().text().trim()
      || $('meta[property="og:title"]').attr("content")?.trim()
      || null;

    // Description: <meta name="description">, fallback to og:description
    const description =
      $('meta[name="description"]').attr("content")?.trim()
      || $('meta[property="og:description"]').attr("content")?.trim()
      || null;

    // Author: <meta name="author"> or <meta property="article:author">
    const author =
      $('meta[name="author"]').attr("content")?.trim()
      || $('meta[property="article:author"]').attr("content")?.trim()
      || null;

    // Published date: <meta property="article:published_time"> or <meta name="date">
    const published =
      $('meta[property="article:published_time"]').attr("content")?.trim()
      || $('meta[name="date"]').attr("content")?.trim()
      || null;

    // Favicon: <link rel="icon"> or <link rel="shortcut icon">
    const faviconRel =
      $('link[rel="icon"]').attr("href")
      ?? $('link[rel="shortcut icon"]').attr("href");
    const favicon = resolveUrl(faviconRel, baseUrl);

    // Open Graph image
    const image = resolveUrl(
      $('meta[property="og:image"]').attr("content"),
      baseUrl,
    );

    // Canonical URL
    const canonical = resolveUrl(
      $('link[rel="canonical"]').attr("href"),
      baseUrl,
    );

    // Site name
    const siteName =
      $('meta[property="og:site_name"]').attr("content")?.trim() || null;

    // Open Graph type
    const type =
      $('meta[property="og:type"]').attr("content")?.trim() || null;

    log.info("Metadata extracted", {
      title: !!title,
      description: !!description,
      author: !!author,
      published: !!published,
      favicon: !!favicon,
      image: !!image,
      canonical: !!canonical,
      siteName: !!siteName,
      type: !!type,
    });

    return {
      title,
      description,
      author,
      published,
      favicon,
      image,
      canonical,
      siteName,
      type,
    };
  } catch (error) {
    log.warn("Metadata extraction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      title: null,
      description: null,
      author: null,
      published: null,
      favicon: null,
      image: null,
      canonical: null,
      siteName: null,
      type: null,
    };
  }
}
