/**
 * Whether the browser driver can be started, answered synchronously.
 *
 * `playwright` is an optional peer dependency that this package also carries as
 * an exact devDependency, so it is absent in a lean consumer install and present
 * in CI. A tool must be able to answer "can I browse?" — and say what to install
 * — without importing Playwright or launching anything, which is why this probe
 * uses `createRequire(...).resolve()` and never a dynamic import: resolving a
 * module path does not evaluate it, so no browser or driver code loads here.
 *
 * The browser binaries are a second, separate install step. Playwright resolves
 * them from `PLAYWRIGHT_BROWSERS_PATH` when that is set, otherwise from its own
 * per-OS cache; the guidance names the command rather than guessing a path.
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";

/** The one command pair that makes the driver usable. */
export const PLAYWRIGHT_GUIDANCE =
  "Install the driver with `npm install playwright`, then download a browser with `npx playwright install chromium`.";

/** What {@link detectPlaywright} found. */
export interface PlaywrightAvailability {
  available: boolean;
  /** Absolute path of the resolved `playwright` entry point. */
  resolvedPath?: string;
  /** Why the module could not be resolved, when it could not. */
  reason?: string;
  /** The browser cache directory Playwright will use, when it is configured. */
  browsersPath?: string;
  /** Whether a Chromium build is present under {@link browsersPath}. */
  chromiumInstalled?: boolean;
  /** The install command, present only when something is missing. */
  guidance?: string;
}

const requireFromHere = createRequire(import.meta.url);

/**
 * Detect Playwright without loading it.
 *
 * `createRequire(import.meta.url)` resolves from this file, which is the same
 * resolution root a dynamic `import("playwright")` would use, so a positive
 * answer here is the same module the driver will import. A negative answer never
 * throws: the reason is returned so a tool can report it.
 */
export function detectPlaywright(): PlaywrightAvailability {
  let resolvedPath: string;
  try {
    resolvedPath = requireFromHere.resolve("playwright");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: `the playwright module is not resolvable from rolebox (${firstLine(reason)})`,
      browsersPath: configuredBrowsersPath(),
      guidance: PLAYWRIGHT_GUIDANCE,
    };
  }

  const browsersPath = configuredBrowsersPath();
  const chromiumInstalled = browsersPath === undefined ? undefined : hasChromiumBuild(browsersPath);
  const missingBrowser = chromiumInstalled === false;
  return {
    available: true,
    resolvedPath,
    browsersPath,
    chromiumInstalled,
    ...(missingBrowser
      ? { guidance: `No Chromium build was found under ${browsersPath}; run \`npx playwright install chromium\`.` }
      : {}),
  };
}

/**
 * The browser cache Playwright will read, or `undefined` when the environment
 * leaves it to Playwright's own per-OS default (which this module does not
 * guess, so it also cannot mis-report a path).
 */
export function configuredBrowsersPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env.PLAYWRIGHT_BROWSERS_PATH;
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Whether the cache directory contains any Chromium build. */
function hasChromiumBuild(browsersPath: string): boolean {
  if (!existsSync(browsersPath)) return false;
  try {
    return readdirSync(browsersPath).some(name => name.startsWith("chromium-") || name.startsWith("chromium_headless_shell-"));
  } catch {
    return false;
  }
}

/** A short reason: the first line of a resolver error, without its location noise. */
function firstLine(value: string): string {
  const line = value.split("\n")[0]?.trim() ?? value;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
