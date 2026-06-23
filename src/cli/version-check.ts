import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./paths.js";
import { compareVersions } from "./commands/update.js";

// ── ANSI Colors ──────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

// ── Constants ────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NPM_REGISTRY_URL = "https://registry.npmjs.org/rolebox/latest";
const FETCH_TIMEOUT_MS = 3000; // Don't block CLI for slow network

// ── Cache ────────────────────────────────────────────────────────

interface VersionCache {
  latestVersion: string;
  checkedAt: string;
}

function getCacheFile(): string {
  return join(getDataDir(), "cache", "version-check.json");
}

function readCache(): VersionCache | null {
  try {
    const file = getCacheFile();
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf-8")) as VersionCache;
    if (!data.latestVersion || !data.checkedAt) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  try {
    const file = getCacheFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(cache), "utf-8");
  } catch {
    // Non-fatal
  }
}

// ── Version Check ────────────────────────────────────────────────

/**
 * Check if a newer version of rolebox is available on npm.
 * Results are cached for 24 hours to avoid excessive network calls.
 * Never throws — all failures are silently swallowed.
 */
export async function checkForUpdate(currentVersion: string): Promise<void> {
  try {
    const cache = readCache();
    if (cache) {
      const cachedAt = new Date(cache.checkedAt).getTime();
      if (!isNaN(cachedAt) && Date.now() - cachedAt < CHECK_INTERVAL_MS) {
        printUpdateNotice(currentVersion, cache.latestVersion);
        return;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(NPM_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return;

    const data = (await response.json()) as { version?: string };
    const latestVersion = data.version;
    if (!latestVersion) return;

    writeCache({ latestVersion, checkedAt: new Date().toISOString() });
    printUpdateNotice(currentVersion, latestVersion);
  } catch {
    // Never throw — version check is best-effort, must not break CLI
  }
}

function printUpdateNotice(currentVersion: string, latestVersion: string): void {
  if (compareVersions(latestVersion, currentVersion) <= 0) return;

  const boxWidth = 46;
  const border = yellow("┃");
  const line = yellow("━".repeat(boxWidth));

  console.log("");
  console.log(yellow("┏") + line + yellow("┓"));
  console.log(border + " ".repeat(boxWidth) + border);
  console.log(
    border +
      centerPad(
        `${bold(yellow("Update available!"))} ${dim(currentVersion)} → ${bold(green(latestVersion))}`,
        boxWidth,
      ) +
      border,
  );
  console.log(border + " ".repeat(boxWidth) + border);
  console.log(
    border +
      centerPad(
        `Run ${cyan(bold("npm install rolebox"))} to update`,
        boxWidth,
      ) +
      border,
  );
  console.log(border + " ".repeat(boxWidth) + border);
  console.log(yellow("┗") + line + yellow("┛"));
  console.log("");
}

/**
 * Center-pad a string (accounting for ANSI escape codes in visible length).
 */
function centerPad(text: string, width: number): string {
  const visible = stripAnsi(text);
  const padding = Math.max(0, width - visible.length);
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
