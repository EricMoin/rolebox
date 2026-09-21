import * as cheerio from "cheerio";
import { z } from "zod";
import { defineTool } from "../platform/ports/tool-factory.ts";
import { createSubLogger } from "../logger.ts";
import { TokenBucket, fetchWithRetry, buildBrowserHeaders } from "./http-utils.ts";
import { detectBrowserCapabilities } from "./browser-detect.ts";
import { searchWithCrawlee } from "./crawlee-backend.ts";

const log = createSubLogger("web:search");

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

// Rate limiters
const jinaBucket = new TokenBucket(15); // 15 RPM for Jina (shared anonymous limit)
const ddgBucket = new TokenBucket(25); // 25 RPM for DuckDuckGo

/** Accept header for the DuckDuckGo HTML endpoint. */
const DDG_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

export function createWebSearchTool() {
  return defineTool({
    description:
      "Search the web for information. No API key required. " +
      "Supports multiple sources: general web search (Jina/DuckDuckGo), " +
      "Wikipedia, npm packages, and Hacker News.",
    args: {
      query: z.string().min(1).max(500).describe("Search query"),
      source: z
        .enum(["auto", "jina", "duckduckgo", "wikipedia", "npm", "hackernews"])
        .optional()
        .default("auto")
        .describe(
          "Search source. 'auto' routes intelligently based on query content.",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe("Maximum number of results to return"),
    },
    async execute(args) {
      const { source, max_results } = args;
      // Normalize once: trim the ends and collapse internal whitespace runs so
      // routing and every provider URL see the same single-spaced query.
      const query = args.query.trim().replace(/\s+/g, " ");
      log.info("Web search", { query, source, max_results });

      let results: SearchResult[] = [];

      switch (source) {
        case "jina":
          results = await searchJina(query, max_results);
          break;
        case "duckduckgo":
          results = await searchDuckDuckGo(query, max_results);
          break;
        case "wikipedia":
          results = await searchWikipedia(query, max_results);
          break;
        case "npm":
          results = await searchNpm(query, max_results);
          break;
        case "hackernews":
          results = await searchHackerNews(query, max_results);
          break;
        case "auto":
        default:
          results = await searchAuto(query, max_results);
          break;
      }

      // Deduplicate by normalized URL, keep first-seen order and the cap.
      const uniqueResults = dedupeResults(results).slice(0, max_results);

      if (uniqueResults.length === 0) {
        return `## No Results Found\n\nQuery: "${query}"\n\nNo results were found from the selected source(s). Try:\n- Different search terms\n- A different source (e.g., source: "duckduckgo" or source: "wikipedia")`;
      }

      return formatResults(uniqueResults, query);
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Jina Search (primary)
// ---------------------------------------------------------------------------

async function searchJina(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    await jinaBucket.acquire();
    const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: "text/markdown" } },
      1,
      500,
    );
    const text = await response.text();
    return parseJinaResults(text, maxResults);
  } catch (error) {
    log.warn("Jina search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function parseJinaResults(text: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Jina returns results as markdown sections with Title, URL Source, and content
  // Format: "Title: ...\nURL Source: ...\nMarkdown Content: ...\n---"
  // OR sections separated by headings
  const blocks = text.split(/\n---\n|\n#{1,3}\s/);

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const titleMatch =
      block.match(/Title:\s*(.+)/i) || block.match(/^(.+)\n/);
    const urlMatch =
      block.match(/URL Source:\s*(\S+)/i) || block.match(/(https?:\/\/\S+)/);
    if (titleMatch && urlMatch) {
      const snippet = block
        .replace(/Title:.*\n?/i, "")
        .replace(/URL Source:.*\n?/i, "")
        .replace(/Markdown Content:\s*/i, "")
        .trim()
        .slice(0, 200);
      results.push({
        title: titleMatch[1].trim(),
        url: urlMatch[1].trim(),
        snippet: snippet || "(no snippet)",
        source: "Jina",
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. DuckDuckGo (fallback)
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  // Prefer Crawlee for DDG if available (better anti-detection)
  const caps = await detectBrowserCapabilities();
  if (caps.crawlee) {
    const crawleeResults = await searchWithCrawlee(query, maxResults);
    if (crawleeResults.length > 0) {
      return crawleeResults.map(r => ({ ...r, source: "DuckDuckGo (Crawlee)" }));
    }
  }

  // Fall through to plain fetch if Crawlee fails or unavailable
  try {
    await ddgBucket.acquire();
    const response = await fetchWithRetry(
      "https://html.duckduckgo.com/html",
      {
        method: "POST",
        headers: {
          ...buildBrowserHeaders({ accept: DDG_ACCEPT }),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      },
      1,
      500,
    );
    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $(".result").each((_i, el) => {
      if (results.length >= maxResults) {
        return false; // break out of each loop
      }
      const $el = $(el);
      const titleEl = $el.find("h2 a");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href") || "";
      // Unwrap DuckDuckGo redirect URL
      const urlMatch = href.match(/uddg=([^&]+)/);
      const url = urlMatch ? decodeURIComponent(urlMatch[1]) : href;
      const snippet = $el.find(".result__snippet").text().trim();

      if (title && url && url.startsWith("http")) {
        results.push({
          title,
          url,
          snippet: snippet || "(no snippet)",
          source: "DuckDuckGo",
        });
      }
    });

    return results;
  } catch (error) {
    log.warn("DuckDuckGo search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 3. Wikipedia
// ---------------------------------------------------------------------------

async function searchWikipedia(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&origin=*`;
    const response = await fetchWithRetry(url, {}, 1, 500);
    const data = (await response.json()) as {
      query?: {
        search?: Array<{
          title: string;
          snippet: string;
          pageid: number;
        }>;
      };
    };
    const items = data.query?.search || [];
    return items.map((item) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
      snippet: item.snippet.replace(/<[^>]+>/g, "").trim() || "(no snippet)",
      source: "Wikipedia",
    }));
  } catch (error) {
    log.warn("Wikipedia search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. npm
// ---------------------------------------------------------------------------

async function searchNpm(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults}`;
    const response = await fetchWithRetry(url, {}, 1, 500);
    const data = (await response.json()) as {
      objects?: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          links?: { npm?: string };
        };
      }>;
    };
    const objects = data.objects || [];
    return objects.map((obj) => ({
      title: `${obj.package.name}@${obj.package.version}`,
      url:
        obj.package.links?.npm ||
        `https://www.npmjs.com/package/${obj.package.name}`,
      snippet: obj.package.description || "(no description)",
      source: "npm",
    }));
  } catch (error) {
    log.warn("npm search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 5. Hacker News (Algolia)
// ---------------------------------------------------------------------------

async function searchHackerNews(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${maxResults}`;
    const response = await fetchWithRetry(url, {}, 1, 500);
    const data = (await response.json()) as {
      hits?: Array<{
        title: string;
        url?: string;
        objectID: string;
        points?: number;
        num_comments?: number;
      }>;
    };
    const hits = data.hits || [];
    return hits.map((hit) => ({
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: `${hit.points || 0} points, ${hit.num_comments || 0} comments`,
      source: "Hacker News",
    }));
  } catch (error) {
    log.warn("Hacker News search failed", {
      query,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// 6. Auto routing
// ---------------------------------------------------------------------------

/**
 * Matches a whole query that is exactly one package name, scoped or not:
 * `@scope/name` or `name`, built from letters, digits, `.`, `_` and `-`.
 */
const PACKAGE_NAME_PATTERN = /^@?[a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)?$/i;

/** The npm/package keywords a package-lookup query may be wrapped in. */
const NPM_KEYWORDS = /npm|package/gi;

/**
 * The text to send to the npm registry, or null when the query is a general
 * search instead of a package lookup.
 *
 * Exactly two shapes are package lookups:
 *
 * 1. the whole trimmed query is one package name ("lodash", "@scope/name") —
 *    it is forwarded verbatim, because stripping keywords out of a real name
 *    would corrupt it ("npm-run-all");
 * 2. dropping the npm/package keywords and collapsing whitespace leaves
 *    exactly one package name ("npm lodash", "lodash npm package").
 *
 * A query that merely mentions a keyword ("python package manager
 * comparison") is a general search and must never reach the registry.
 *
 * @param query - Raw user query.
 */
function npmLookupQuery(query: string): string | null {
  const trimmed = query.trim();
  if (PACKAGE_NAME_PATTERN.test(trimmed)) return trimmed;

  const stripped = trimmed
    .replace(NPM_KEYWORDS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === "" || stripped.includes(" ")) return null;
  return PACKAGE_NAME_PATTERN.test(stripped) ? stripped : null;
}

async function searchAuto(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const lowerQuery = query.toLowerCase();

  // Detect specialized sources
  const npmQuery = npmLookupQuery(query);
  if (npmQuery !== null) {
    const npmResults = await searchNpm(npmQuery, maxResults);
    if (npmResults.length > 0) return npmResults;
  }

  if (lowerQuery.includes("wikipedia") || lowerQuery.includes("wiki")) {
    const wikiResults = await searchWikipedia(
      query.replace(/wikipedia|wiki/gi, "").trim() || query,
      maxResults,
    );
    if (wikiResults.length > 0) return wikiResults;
  }

  if (
    lowerQuery.includes("hacker news") ||
    lowerQuery.includes("hn ") ||
    lowerQuery.includes("hackernews")
  ) {
    const hnResults = await searchHackerNews(
      query.replace(/hacker\s*news|hn\s/gi, "").trim() || query,
      maxResults,
    );
    if (hnResults.length > 0) return hnResults;
  }

  // General search: try Jina first, fallback to DuckDuckGo
  const jinaResults = await searchJina(query, maxResults);
  if (jinaResults.length > 0) return jinaResults;

  log.info("Jina returned no results, falling back to DuckDuckGo", { query });
  return searchDuckDuckGo(query, maxResults);
}

// ---------------------------------------------------------------------------
// 7. Output formatter
// ---------------------------------------------------------------------------

/** Case-insensitive URL form used to detect duplicate results. */
function normalizeResultUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Drop duplicate results, keeping the first occurrence of each normalized URL
 * (lowercase host, no trailing slash) and the original first-seen order.
 *
 * @param results - Provider results, in provider order.
 */
function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeResultUrl(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

/** Escape markdown link delimiters so a title cannot break out of the link. */
function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, (char) => `\\${char}`);
}

function formatResults(results: SearchResult[], query: string): string {
  const lines = [`## Search Results for "${query}"\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **[${escapeLinkText(r.title)}](${r.url})** _(via ${r.source})_`);
    if (r.snippet) {
      lines.push(`   ${escapeLinkText(r.snippet)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
