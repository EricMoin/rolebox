import { createSubLogger } from "../logger.ts";
import { BROWSER_USER_AGENT, buildBrowserHeaders } from "./http-utils.ts";
import { convertHtmlToMarkdown } from "./html-to-markdown.ts";

const log = createSubLogger("web:playwright");

// ── Optional-dependency boundary ─────────────────────────────────────────────
//
// `playwright` is an optional peer dependency (package.json
// peerDependenciesMeta). The ambient declarations in playwright.d.ts are too
// narrow for the options this module uses, so instead of extending them it
// describes everything it calls with the local structural types below and
// narrows the dynamic-import result once, at the boundary.

interface PlaywrightElementHandleLike {
  innerHTML(): Promise<string>;
}

interface PlaywrightPageLike {
  addInitScript(script: string): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void>;
  content(): Promise<string>;
  $(selector: string): Promise<PlaywrightElementHandleLike | null>;
  close(): Promise<void>;
}

interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

interface PlaywrightBrowserLike {
  newContext(options: {
    userAgent: string;
    viewport: { width: number; height: number };
    locale: string;
    timezoneId: string;
    extraHTTPHeaders: Record<string, string>;
  }): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

interface PlaywrightChromiumLike {
  launch(options: { headless: boolean; args: string[] }): Promise<PlaywrightBrowserLike>;
}

/**
 * Script injected before page scripts run: hides the automation flag the page
 * would otherwise read. Written as a string so the untyped boundary needs no
 * function-typed value.
 */
const HIDE_WEBDRIVER_SCRIPT =
  "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });";

/** Realistic desktop viewport; Playwright's 1280x720 default is a weak fingerprint. */
const VIEWPORT = { width: 1366, height: 768 };

/** How long a best-effort networkidle wait may take before it is abandoned. */
const NETWORK_IDLE_TIMEOUT_MS = 5000;

/**
 * At most one browser session at a time in this process: two concurrent
 * fetches would otherwise launch two Chromium instances and can exhaust memory.
 * The queue never rejects, so a failed session cannot poison later callers.
 */
let sessionChain: Promise<void> = Promise.resolve();

function runBrowserExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = sessionChain.then(() => task());
  sessionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Close a browser resource without letting a close failure mask the result. */
async function closeQuietly(
  close: () => Promise<void>,
  resource: string,
  url: string,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    log.debug(`Playwright ${resource} close failed`, {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fetch a page using Playwright headless browser.
 *
 * Only called when Playwright is confirmed available via
 * `detectBrowserCapabilities()` — the dynamic import may throw
 * if the package is not installed.
 *
 * Sessions are serialized and every resource (page, context, browser) is
 * released on a finally path, so a navigation error cannot leak a Chromium
 * process. Navigation waits for `domcontentloaded` and then makes one short,
 * best-effort attempt at `networkidle`: a hard networkidle wait is a common
 * total-timeout cause on pages with long-polling or analytics beacons.
 *
 * @param url - The URL to fetch
 * @param options - Optional settings (selector, timeout)
 * @returns Markdown string or null on failure
 */
export async function fetchWithPlaywright(
  url: string,
  options?: { selector?: string; timeout?: number },
): Promise<string | null> {
  return runBrowserExclusive(async () => {
    try {
      // The one assertion at this boundary: the ambient declarations for this
      // optional peer dependency are too narrow, so the import result is
      // narrowed to the contract used below.
      const mod: unknown = await import("playwright");
      const chromium = (mod as { chromium?: PlaywrightChromiumLike }).chromium;
      if (chromium === undefined) {
        log.warn("Playwright module exposes no chromium export", { url });
        return null;
      }

      const browser = await chromium.launch({
        headless: true,
        // Deliberately no --no-sandbox: it widens the blast radius of a
        // compromised page and is unnecessary on a normal desktop.
        args: ["--disable-blink-features=AutomationControlled"],
      });

      try {
        const context = await browser.newContext({
          userAgent: BROWSER_USER_AGENT,
          viewport: VIEWPORT,
          locale: "en-US",
          timezoneId: "UTC",
          // The profile the static fetch sends, so the JS-visible navigator
          // and the network headers agree.
          extraHTTPHeaders: buildBrowserHeaders(),
        });

        try {
          const page = await context.newPage();
          try {
            await page.addInitScript(HIDE_WEBDRIVER_SCRIPT);

            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: options?.timeout ?? 30000,
            });

            try {
              await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS });
            } catch (error) {
              // Best effort only: beacons and long-polling never go idle.
              log.debug("Playwright networkidle wait skipped", {
                url,
                error: error instanceof Error ? error.message : String(error),
              });
            }

            let html: string;
            if (options?.selector) {
              const element = await page.$(options.selector);
              html = element ? await element.innerHTML() : await page.content();
            } else {
              html = await page.content();
            }

            const markdown = convertHtmlToMarkdown(html, url);
            log.info("Playwright fetch succeeded", { url, bytes: Buffer.byteLength(markdown) });
            return markdown;
          } finally {
            await closeQuietly(() => page.close(), "page", url);
          }
        } finally {
          await closeQuietly(() => context.close(), "context", url);
        }
      } finally {
        await closeQuietly(() => browser.close(), "browser", url);
      }
    } catch (error) {
      log.warn("Playwright fetch failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });
}
