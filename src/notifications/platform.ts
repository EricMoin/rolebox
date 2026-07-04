// ── Cross-Runtime Platform Detection & Command Finder ───────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformInfo } from "./types.ts";
import { createSubLogger } from "../logger.ts";

// ── Helpers ──────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

const logger = createSubLogger("notification-platform");

// ── Command Cache ────────────────────────────────────────────────────

/** In-memory cache for resolved command paths. */
const commandCache = new Map<string, string | null>();

// ── Platform Detection ───────────────────────────────────────────────

export function detectPlatform(): PlatformInfo {
  const os = process.platform;
  if (os === "darwin" || os === "linux" || os === "win32") {
    return { os };
  }
  return { os: "unknown" };
}

// ── Command Resolution ───────────────────────────────────────────────

/**
 * Resolve the full path to a command by searching PATH.
 * Uses `which` on Unix/macOS and `where` on Windows.
 *
 * Results are cached in-memory to avoid repeated filesystem lookups.
 * Never throws — returns `null` on any error.
 */
export async function findCommand(name: string): Promise<string | null> {
  // Return cached result if available (including cached null)
  const cached = commandCache.get(name);
  if (cached !== undefined) return cached;

  const platform = process.platform;
  const shellCmd = platform === "win32" ? "where" : "which";

  try {
    const { stdout } = await execFileAsync(shellCmd, [name]);
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      commandCache.set(name, null);
      return null;
    }
    commandCache.set(name, trimmed);
    return trimmed;
  } catch (err) {
    logger.warn(`command not found: "${name}"`, { err });
    commandCache.set(name, null);
    return null;
  }
}

export async function commandExists(name: string): Promise<boolean> {
  return (await findCommand(name)) !== null;
}

export async function preWarmCommandCache(names: string[]): Promise<void> {
  await Promise.allSettled(names.map((n) => findCommand(n)));
}

// ── Platform Defaults ────────────────────────────────────────────────

export function getDefaultSoundPath(platform: PlatformInfo["os"]): string {
  switch (platform) {
    case "darwin":
      return "/System/Library/Sounds/Glass.aiff";
    case "linux":
      return "/usr/share/sounds/freedesktop/stereo/complete.oga";
    case "win32":
      return "C:\\Windows\\Media\\notify.wav";
    case "unknown":
      return "";
  }
}

/**
 * Resolve the system command used to play audio notifications.
 *
 * - darwin: tries `afplay`
 * - linux: tries `paplay`, falls back to `aplay`
 * - win32: returns `"powershell"` (SoundPlayer via script)
 * - unknown: returns `null`
 */
export async function resolveSoundPlayer(
  platform: PlatformInfo["os"],
): Promise<string | null> {
  try {
    switch (platform) {
      case "darwin": {
        return (await findCommand("afplay")) !== null ? "afplay" : null;
      }
      case "linux": {
        const paplay = await findCommand("paplay");
        if (paplay) return "paplay";
        const aplay = await findCommand("aplay");
        return aplay ? "aplay" : null;
      }
      case "win32":
        return "powershell";
      case "unknown":
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the system command used to send desktop toast notifications.
 *
 * - darwin: tries `terminal-notifier`, falls back to `osascript`
 * - linux: tries `notify-send`
 * - win32: returns `"powershell"`
 * - unknown: returns `null`
 */
export async function resolveToastSender(
  platform: PlatformInfo["os"],
): Promise<string | null> {
  try {
    switch (platform) {
      case "darwin": {
        const tn = await findCommand("terminal-notifier");
        if (tn) return "terminal-notifier";
        const osa = await findCommand("osascript");
        return osa ? "osascript" : null;
      }
      case "linux": {
        const ns = await findCommand("notify-send");
        return ns ? "notify-send" : null;
      }
      case "win32":
        return "powershell";
      case "unknown":
        return null;
    }
  } catch {
    return null;
  }
}
