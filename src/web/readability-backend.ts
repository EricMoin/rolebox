import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:readability");

export interface ArticleResult {
  title: string;
  content: string;
  excerpt: string | null;
  byline: string | null;
  length: number;
}

/**
 * Extract a readable article from HTML using Mozilla's Readability library.
 *
 * Uses dynamic import so the optional @mozilla/readability and linkedom
 * packages are only loaded when this function is actually called. Returns
 * null if either package is not installed or if the page cannot be parsed
 * into an article.
 *
 * @param html - Raw HTML string of the page
 * @param url - The page URL (used for resolving relative URLs internally)
 * @returns An ArticleResult with cleaned content, or null on failure
 */
export async function extractArticle(
  html: string,
  url: string,
): Promise<ArticleResult | null> {
  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);

    const { document } = parseHTML(html);
    const result = new Readability(document).parse();

    if (!result) {
      log.warn("Readability parse returned null", { url });
      return null;
    }

    const article: ArticleResult = {
      title: result.title || "Untitled",
      content: result.content || "",
      excerpt: result.excerpt || null,
      byline: result.byline || null,
      length: result.length || 0,
    };

    log.info("Article extracted successfully", {
      url,
      title: article.title,
      length: article.length,
    });

    return article;
  } catch (error) {
    log.warn("Readability extraction failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
