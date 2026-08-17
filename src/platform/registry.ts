/**
 * Platform registry — the single source of truth for every host platform
 * (harness) rolebox can target.
 *
 * Each harness contributes ONE {@link PlatformDescriptor} here. Everything that
 * used to be a hardcoded `switch (platformId)` — path resolution, sync-target
 * layout, CLI status/info reporting, integration/registration detection — now
 * iterates this registry. Adding a new harness is a single-entry change: append
 * a descriptor and the CLI, path helpers, and factory pick it up automatically,
 * with no edits to the consuming call sites.
 *
 * Design intent (why a registry, not a switch):
 *   - CLI commands (`rolebox status`, `rolebox info`) must report ALL targets,
 *     not just opencode. They iterate `PLATFORM_REGISTRY` instead of naming
 *     platforms one by one.
 *   - Platform-specific knowledge (how to detect that rolebox is registered
 *     with the host) lives WITH the platform descriptor, not smeared across
 *     the CLI. opencode knows about its `plugin` array; a future harness
 *     declares its own detection in its own descriptor.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  defaultPlatformPaths,
  piPlatformPaths,
  dshPlatformPaths,
  type PlatformPaths,
} from "./paths.ts";
import { PLUGIN_ID } from "../constants.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Host-integration status for a platform — i.e. whether rolebox is registered
 * with the host tool through that tool's own mechanism (opencode plugin array,
 * a future pi extension manifest, a dsh cordis profile bundle, ...).
 */
export interface PlatformIntegration {
  /** Name of the registration mechanism, e.g. "Plugin", "Extension", "Bundle". */
  mechanism: string;
  /** Whether rolebox is currently registered with the host tool. */
  registered: boolean;
  /** Human-readable state, e.g. "registered" / "not found in opencode config". */
  detail: string;
  /** Actionable hint shown when not registered (home dir collapsed to `~`). */
  hint?: string;
}

/**
 * A single host platform (harness) rolebox can deploy to.
 *
 * `id` MUST match the corresponding {@link SyncTarget} value so path helpers
 * and CLI sync commands resolve consistently.
 */
export interface PlatformDescriptor {
  /** Sync-target id — matches a `SyncTarget` value (e.g. "opencode", "pi", "dsh"). */
  id: string;
  /** Human-readable label for CLI output (e.g. "OpenCode", "pi", "dsh"). */
  label: string;
  /** Resolve this platform's directory layout. */
  paths: () => PlatformPaths;
  /**
   * Detect whether rolebox is registered with the host tool.
   *
   * Returns `null` when the platform exposes NO detectable registration
   * mechanism (rolebox cannot honestly report a state), so the CLI can omit
   * the line rather than fabricate a "registered/not registered" verdict.
   */
  detectIntegration: () => PlatformIntegration | null;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Collapse the home-directory prefix to `~` for display (no CLI dep). */
function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * Strip `//` line and block comments from JSONC while preserving string
 * literals. Shared by any descriptor whose host config is JSONC (opencode).
 */
function stripJsonComments(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      result += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") {
          result += input[i] + (input[i + 1] || "");
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      if (i < input.length) {
        result += '"';
        i++;
      }
    } else if (input[i] === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
    } else if (input[i] === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}

/** Whether the opencode config's `plugin` array lists rolebox. */
function isOpencodePluginRegistered(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(configPath, "utf-8"))) as {
      plugin?: string[];
    };
    if (!Array.isArray(parsed.plugin)) return false;
    return parsed.plugin.some((p) => p === PLUGIN_ID || p.startsWith(`${PLUGIN_ID}@`));
  } catch {
    return false;
  }
}

// ── Descriptors ────────────────────────────────────────────────────────────

const opencodeDescriptor: PlatformDescriptor = {
  id: "opencode",
  label: "OpenCode",
  paths: defaultPlatformPaths,
  detectIntegration() {
    const configPath = join(defaultPlatformPaths().configDir, "opencode.jsonc");
    const registered = isOpencodePluginRegistered(configPath);
    return {
      mechanism: "Plugin",
      registered,
      detail: registered ? "registered" : "not found in opencode config",
      hint: registered
        ? undefined
        : `Add "${PLUGIN_ID}" to the "plugin" array in ${tildify(configPath)}`,
    };
  },
};

const piDescriptor: PlatformDescriptor = {
  id: "pi",
  label: "pi",
  paths: piPlatformPaths,
  // pi registers extensions under {configDir}/extensions but has no single
  // manifest rolebox owns; no honest detection mechanism yet.
  detectIntegration: () => null,
};

const dshDescriptor: PlatformDescriptor = {
  id: "dsh",
  label: "dsh",
  paths: dshPlatformPaths,
  // dsh registration is a cordis profile bundle reconciled by `dsh plugin`;
  // not inspectable from a single file rolebox owns. No detection yet.
  detectIntegration: () => null,
};

// ── Registry ─────────────────────────────────────────────────────────────────

/** Every host platform rolebox can target. Order = CLI display order. */
export const PLATFORM_REGISTRY: readonly PlatformDescriptor[] = [
  opencodeDescriptor,
  piDescriptor,
  dshDescriptor,
];

/**
 * Look up a platform descriptor by id. Throws with the supported-id list when
 * the id is unknown — the strict contract used by CLI sync-target resolution.
 */
export function getPlatformDescriptor(id: string): PlatformDescriptor {
  const found = PLATFORM_REGISTRY.find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `Unknown platform: "${id}". Supported: ${PLATFORM_REGISTRY.map((p) => p.id).join(", ")}`,
    );
  }
  return found;
}

/**
 * Resolve platform paths leniently: an unknown or omitted id falls back to
 * opencode. This is the contract runtime entry points (factory, agent-file
 * helpers) rely on, where a missing platformId means "the default host".
 */
export function resolvePlatformPaths(id?: string): PlatformPaths {
  if (!id) return defaultPlatformPaths();
  const found = PLATFORM_REGISTRY.find((p) => p.id === id);
  return found ? found.paths() : defaultPlatformPaths();
}
