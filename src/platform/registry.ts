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
  codexPlatformPaths,
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

/**
 * Strip an unquoted `#` comment from a TOML line, so a commented-out table is
 * never mistaken for a live registration.
 */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote !== null) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * Split a TOML key or dotted key path into its segments, tolerating
 * whitespace around the dots and quoted keys (`plugins."rolebox@x"`).
 * Returns null when the text is not a well-formed key.
 */
function splitTomlKey(text: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index === text.length) break;

    let key: string;
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      const keyStart = ++index;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\" && quote === '"') index++;
        index++;
      }
      if (index === text.length) return null;
      key = text.slice(keyStart, index);
      index++;
    } else {
      const keyStart = index;
      while (index < text.length && text[index] !== "." && !/\s/.test(text[index])) index++;
      key = text.slice(keyStart, index);
      if (key === "") return null;
    }

    parts.push(key);
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index === text.length) break;
    if (text[index] !== ".") return null;
    index++;
  }
  return parts.length > 0 ? parts : null;
}

/** Parse a `[table]` / `[[array-of-tables]]` line into its key path. */
function parseTomlTableHeader(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  const arrayTable = trimmed.startsWith("[[");
  const open = arrayTable ? "[[" : "[";
  const close = arrayTable ? "]]" : "]";
  if (!trimmed.endsWith(close)) return null;
  return splitTomlKey(trimmed.slice(open.length, trimmed.length - close.length));
}

/** Whether a parsed table path names a rolebox registration table. */
function isRoleboxTable(table: string[]): boolean {
  if (table.length < 2) return false;
  const [root, name] = table;
  if (root === "mcp_servers" && name === PLUGIN_ID) return true;
  if (root === "marketplaces" && name === PLUGIN_ID) return true;
  return root === "plugins" && name.startsWith(`${PLUGIN_ID}@`);
}

/**
 * Whether a Codex `config.toml` carries a rolebox registration: an MCP server
 * table (or an inline `rolebox = { ... }` entry in `[mcp_servers]`), a local
 * marketplace table, or the plugin enablement table
 * (`[plugins."rolebox@<marketplace>"]`).
 *
 * A line-oriented scan, not a TOML parser: it skips blank and comment lines,
 * tracks the current table header (tolerating whitespace around dots and
 * quoted keys), and never throws. A table header quoted inside a multi-line
 * string is still counted — full TOML parsing is deliberately out of scope for
 * a status check.
 */
function isCodexRegistered(configText: string): boolean {
  let table: string[] | null = null;

  for (const rawLine of configText.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;

    if (line.startsWith("[")) {
      table = parseTomlTableHeader(line);
      if (table !== null && isRoleboxTable(table)) return true;
      continue;
    }

    // Inline MCP server entry: `rolebox = { command = "node", ... }`.
    if (table !== null && table.length === 1 && table[0] === "mcp_servers") {
      const equals = line.indexOf("=");
      if (equals > 0) {
        const key = splitTomlKey(line.slice(0, equals));
        if (key !== null && key.length === 1 && key[0] === PLUGIN_ID) return true;
      }
    }
  }
  return false;
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

const codexDescriptor: PlatformDescriptor = {
  id: "codex",
  label: "Codex",
  paths: codexPlatformPaths,
  // Codex registration is detected in `<codexHome>/config.toml`: the local
  // marketplace table and the plugin enablement table that `rolebox sync codex`
  // writes, or an `[mcp_servers.rolebox]` table registering the same server
  // without the plugin bundle. A missing or unreadable config reports
  // unregistered — detection never throws.
  detectIntegration() {
    const configPath = join(codexPlatformPaths().configDir, "config.toml");
    let registered = false;
    try {
      if (existsSync(configPath)) {
        registered = isCodexRegistered(readFileSync(configPath, "utf-8"));
      }
    } catch {
      registered = false;
    }
    return {
      mechanism: "Plugin + MCP",
      registered,
      detail: registered ? "registered" : "not found in codex config",
      hint: registered
        ? undefined
        : `Run \`rolebox sync codex\` to register the rolebox plugin in ${tildify(configPath)}`,
    };
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

/** Every host platform rolebox can target. Order = CLI display order. */
export const PLATFORM_REGISTRY: readonly PlatformDescriptor[] = [
  opencodeDescriptor,
  piDescriptor,
  dshDescriptor,
  codexDescriptor,
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
