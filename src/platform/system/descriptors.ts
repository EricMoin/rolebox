/**
 * System descriptors — the OS facts, declared ONCE per operating system.
 *
 * Every path value is built with an explicit path flavor (`path.posix` for the
 * POSIX family, `path.win32` for Windows) so a descriptor answers the SAME
 * strings on every host and is exercisable anywhere: the running host's
 * separator and its notion of an absolute path never leak into a value that
 * describes another OS.
 *
 * Browser cache locations, from the projects' own documentation:
 *   - Playwright (https://playwright.dev/docs/browsers, "Managing browser
 *     binaries"): `%USERPROFILE%\AppData\Local\ms-playwright` on Windows,
 *     `~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux.
 *   - Puppeteer (https://pptr.dev/guides/configuration, "Changing the default
 *     cache directory"): `~/.cache/puppeteer` on every platform since v19.
 */

import { posix, win32 } from "node:path";
import type { SystemDescriptor, SystemId } from "./types.ts";

/**
 * Linux-family facts. `linux` and the `posix` fallback differ only in id and
 * label: an unlisted platform answers with these facts under its OWN descriptor
 * rather than being silently reported as Linux.
 */
function posixFamilyDescriptor(id: SystemId, label: string): SystemDescriptor {
  return {
    id,
    label,
    canSyncDirectoryEntries: true,
    browserCaches(home) {
      return {
        playwright: posix.join(home, ".cache", "ms-playwright"),
        puppeteer: posix.join(home, ".cache", "puppeteer"),
      };
    },
    disposableEnvironment(paths) {
      return {
        HOME: paths.home,
        XDG_CONFIG_HOME: paths.config,
        XDG_CACHE_HOME: paths.cache,
        TMPDIR: paths.temp,
      };
    },
    commandShell(command) {
      return ["/bin/sh", "-c", command];
    },
    shellHint: "/bin/sh is POSIX sh (dash on Debian/Ubuntu): brace expansion, arrays and process substitution are unavailable; write portable POSIX sh.",
  };
}

const darwinDescriptor: SystemDescriptor = {
  id: "darwin",
  label: "macOS",
  canSyncDirectoryEntries: true,
  browserCaches(home) {
    return {
      playwright: posix.join(home, "Library", "Caches", "ms-playwright"),
      puppeteer: posix.join(home, ".cache", "puppeteer"),
    };
  },
  disposableEnvironment(paths) {
    const environment: Record<string, string> = {
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.config,
      XDG_CACHE_HOME: paths.cache,
      TMPDIR: paths.temp,
      // Cocoa and Chromium on macOS do not use HOME/TMPDIR for these paths.
      CFFIXED_USER_HOME: paths.home,
      MAC_CHROMIUM_TMPDIR: paths.temp,
      xcrun_db: posix.join(paths.temp, "xcrun_db"),
    };
    // The selected developer toolchain is passed through, never relocated; an
    // empty value counts as unset, exactly as it did before this descriptor.
    const developerDir = paths.env.DEVELOPER_DIR;
    if (developerDir !== undefined && developerDir !== "") environment.DEVELOPER_DIR = developerDir;
    return environment;
  },
  commandShell(command) {
    return ["/bin/sh", "-c", command];
  },
  shellHint: "/bin/sh is bash in POSIX mode on macOS: brace expansion and arrays work, process substitution <(...) is a syntax error.",
};

const win32Descriptor: SystemDescriptor = {
  id: "win32",
  label: "Windows",
  canSyncDirectoryEntries: false,
  browserCaches(home) {
    return {
      playwright: win32.join(home, "AppData", "Local", "ms-playwright"),
      puppeteer: win32.join(home, ".cache", "puppeteer"),
    };
  },
  disposableEnvironment(paths) {
    // Node's os.homedir() reads USERPROFILE on Windows, so the disposable home
    // must be named there too; HOME and the XDG_* variables stay set as well,
    // matching src/cli/paths.ts's documented choice to honour XDG on Windows.
    return {
      HOME: paths.home,
      USERPROFILE: paths.home,
      LOCALAPPDATA: win32.join(paths.home, "AppData", "Local"),
      APPDATA: win32.join(paths.home, "AppData", "Roaming"),
      TEMP: paths.temp,
      TMP: paths.temp,
      XDG_CONFIG_HOME: paths.config,
      XDG_CACHE_HOME: paths.cache,
      TMPDIR: paths.temp,
    };
  },
  commandShell(command, env) {
    // A blank COMSPEC counts as unset, matching the repo's "blank env value is
    // unset" convention; the value itself is never rewritten.
    const comspec = env.COMSPEC;
    const shell = comspec !== undefined && comspec.trim() !== "" ? comspec : "cmd.exe";
    return [shell, "/d", "/s", "/c", command];
  },
  shellHint: "Commands run through cmd.exe (/d /s /c): POSIX idioms (single-quoted strings, $(...), <(...), brace expansion, arrays, VAR=x cmd) are unavailable; use cmd syntax such as set VAR=... and %VAR%.",
};

// ── Registry ─────────────────────────────────────────────────────────────────

/** Every operating system rolebox declares; `posix` is the fallback for the rest. */
export const posixDescriptor = posixFamilyDescriptor("posix", "POSIX (unlisted platform)");

/** Every system descriptor, one per {@link SystemId}. */
export const SYSTEM_REGISTRY: readonly SystemDescriptor[] = [
  darwinDescriptor,
  posixFamilyDescriptor("linux", "Linux"),
  win32Descriptor,
  posixDescriptor,
];
