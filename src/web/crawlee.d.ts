/**
 * Minimal ambient declaration for runtime-detected `crawlee` module.
 * Only declared when the user has the package installed.
 * Full types are available from Crawlee's own type exports.
 */
declare module "crawlee" {
  interface CheerioCrawlerOptions {
    requestHandler: object;
    maxRequestsPerCrawl?: number;
    maxConcurrency?: number;
  }

  interface PlaywrightCrawlerOptions {
    requestHandler: object;
    maxRequestsPerCrawl?: number;
    maxConcurrency?: number;
    headless?: boolean;
  }

  interface CheerioRouter {
    addDefaultHandler(handler: ({ $ }: { $: cheerio.CheerioAPI }) => void): void;
  }

  interface PlaywrightPage {
    $(selector: string): Promise<PlaywrightElementHandle | null>;
    content(): Promise<string>;
  }

  interface PlaywrightElementHandle {
    innerHTML(): Promise<string>;
  }

  interface PlaywrightRouter {
    addDefaultHandler(
      handler: ({ page }: { page: PlaywrightPage }) => void,
    ): void;
  }

  interface CrawlerRunOptions {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    payload?: string;
  }

  export class CheerioCrawler {
    constructor(options: CheerioCrawlerOptions);
    run(requests: CrawlerRunOptions[]): Promise<void>;
  }

  export class PlaywrightCrawler {
    constructor(options: PlaywrightCrawlerOptions);
    run(requests: string[]): Promise<void>;
  }

  export function createCheerioRouter(): CheerioRouter;
  export function createPlaywrightRouter(): PlaywrightRouter;
}
