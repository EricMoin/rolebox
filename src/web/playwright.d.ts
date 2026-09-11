/**
 * Minimal ambient declaration for runtime-detected `playwright` module.
 * Only declared when the user has the package installed.
 * Full types are available from @types/playwright or playwright's own type exports.
 */
declare module "playwright" {
  export interface Browser {
    newContext(options?: { userAgent?: string }): Promise<BrowserContext>;
    close(): Promise<void>;
  }

  export interface BrowserContext {
    newPage(): Promise<Page>;
  }

  export interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
    content(): Promise<string>;
    $(selector: string): Promise<ElementHandle | null>;
  }

  export interface ElementHandle {
    innerHTML(): Promise<string>;
  }

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}
