import { createSubLogger } from "../logger.ts";

const log = createSubLogger("web:browser");

interface BrowserCapabilities {
  playwright: boolean;
  crawlee: boolean;
  checked: boolean;
}

const capabilities: BrowserCapabilities = {
  playwright: false,
  crawlee: false,
  checked: false,
};

/**
 * Detect available browser automation packages at runtime.
 * Results are cached after first check — subsequent calls return instantly.
 *
 * Each backend is tested via a dynamic `await import()`. If the package
 * isn't installed, the import throws and the capability is marked false.
 */
export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  if (capabilities.checked) return capabilities;

  // Detect Playwright
  try {
    await import("playwright");
    capabilities.playwright = true;
    log.info("Playwright detected — browser rendering available");
  } catch {
    log.debug("Playwright not installed — skipping browser backend");
  }

  // Detect Crawlee
  try {
    await import("crawlee");
    capabilities.crawlee = true;
    log.info("Crawlee detected — advanced crawling available");
  } catch {
    log.debug("Crawlee not installed — skipping crawlee backend");
  }

  capabilities.checked = true;
  return capabilities;
}

/**
 * Return cached capabilities without triggering detection.
 * Useful for synchronous checks after detection has run.
 */
export function getCachedCapabilities(): BrowserCapabilities {
  return capabilities;
}

/**
 * Reset cached capabilities (for testing).
 */
export function __resetBrowserDetection(): void {
  capabilities.playwright = false;
  capabilities.crawlee = false;
  capabilities.checked = false;
}
