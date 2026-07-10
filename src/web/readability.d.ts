/**
 * Minimal ambient declarations for runtime-detected optional modules:
 * - @mozilla/readability — article content extraction
 * - linkedom — lightweight DOM parser
 *
 * Full types are available from the respective packages when installed.
 */

declare module "@mozilla/readability" {
  export interface ReadabilityParseResult {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
  }

  export class Readability {
    constructor(document: Document);
    parse(): ReadabilityParseResult | null;
  }
}

declare module "linkedom" {
  export function parseHTML(
    html: string,
  ): {
    document: Document;
    customElements: object;
  };
}
