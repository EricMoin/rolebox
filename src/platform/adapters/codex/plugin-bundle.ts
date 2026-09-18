/**
 * Codex plugin-bundle writer.
 *
 * Codex is extended through a local plugin marketplace: a marketplace root
 * (`{codexHome}/rolebox-marketplace`) carrying
 * `.agents/plugins/marketplace.json` plus one directory per plugin, and a
 * plugin directory (`{marketplaceRoot}/plugins/rolebox`) whose
 * `.codex-plugin/plugin.json` declares the skills directory and the MCP server
 * config (`.mcp.json`). This module owns that layout and the managed
 * registration block in the Codex `config.toml`, so `rolebox sync codex` is
 * idempotent and never rewrites bytes outside its own block.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDirSymlink } from "../../../utils/symlink.ts";
import { PLUGIN_ID } from "../../../constants.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodexPluginBundleOptions {
  /** Codex home directory (`$CODEX_HOME` or `~/.codex`). */
  codexHome: string;
  /** rolebox package root — the directory containing package.json. */
  packageRoot: string;
  /** rolebox package version, written into the plugin manifest. */
  version: string;
  /** Absolute path to the MCP server entry. Defaults to `{packageRoot}/dist/entries/codex.js`. */
  serverEntry?: string;
  /** Runtime that launches the server entry. Defaults to `node`. */
  runtimeCommand?: string;
}

export interface CodexPluginBundlePaths {
  /** Marketplace root: `{codexHome}/rolebox-marketplace`. */
  marketplaceDir: string;
  /** Plugin directory: `{marketplaceDir}/plugins/rolebox`. */
  pluginDir: string;
  /** `{pluginDir}/.codex-plugin/plugin.json`. */
  manifestPath: string;
  /** `{pluginDir}/.mcp.json`. */
  mcpConfigPath: string;
  /** `{marketplaceDir}/.agents/plugins/marketplace.json`. */
  marketplaceManifestPath: string;
  /** `{pluginDir}/skills` — the symlink exposing `{codexHome}/skills`. */
  skillsLinkPath: string;
  /** `{codexHome}/config.toml` — the managed registration block lives here. */
  configPath: string;
  /** Absolute path to the MCP server entry recorded in `.mcp.json`. */
  serverEntry: string;
  /**
   * Whether `serverEntry` exists on disk. A source checkout that was never
   * built is still a valid bundle — the CLI warns instead of failing.
   */
  serverEntryExists: boolean;
}

// ── Managed config block ────────────────────────────────────────────────────

const MANAGED_START =
  "# >>> rolebox (managed) — do not edit; `rolebox sync codex` rewrites this block >>>";
const MANAGED_END = "# <<< rolebox (managed) <<<";

// TOML basic strings have a fixed short-escape set; every other control
// character (C0 plus DEL) must be written as \uXXXX or the document is invalid.
const TOML_STRING_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * Escape a TOML basic-string value: the named short escapes (\b \t \n \f \r
 * \" \\) plus \uXXXX for every other control character. The marketplace root
 * comes from the user's home directory, so an embedded newline or tab must not
 * be able to produce an unparseable config.toml.
 */
export function escapeTomlString(value: string): string {
  return value.replace(/["\\\u0000-\u001f\u007f]/g, (char) => {
    const escape = TOML_STRING_ESCAPES[char];
    return escape ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

/** The managed `config.toml` block for a marketplace root. */
function buildManagedBlock(marketplaceDir: string): string {
  return [
    MANAGED_START,
    "[marketplaces.rolebox]",
    'source_type = "local"',
    `source = "${escapeTomlString(marketplaceDir)}"`,
    '[plugins."rolebox@rolebox"]',
    "enabled = true",
    MANAGED_END,
  ].join("\n");
}

/** A managed block's byte range in a config file. */
interface ManagedRegion {
  /** First byte of the start-marker line (indentation included). */
  start: number;
  /** Exclusive end of the end-marker line; does NOT consume its newline. */
  end: number;
}

/** Delimiter that opened the multi-line TOML string the scanner is inside. */
type MultilineStringDelimiter = '"""' | "'''";

/** Index just past the single-line string starting at `start` (basic or literal). */
function skipSingleLineString(line: string, start: number): number {
  const quote = line[start];
  let index = start + 1;
  while (index < line.length) {
    if (quote === '"' && line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index++;
  }
  return index;
}

/**
 * Advance the multi-line string state across one physical line. Comments and
 * single-line strings are skipped, so a triple quote in either cannot swallow
 * the rest of the file. Multi-line basic strings honour backslash escapes,
 * literal strings do not, and content after a delimiter closed on the same
 * line is scanned normally.
 */
function advanceMultilineStringState(
  line: string,
  state: MultilineStringDelimiter | null,
): MultilineStringDelimiter | null {
  let index = 0;
  while (index < line.length) {
    if (state !== null) {
      if (state === '"""' && line[index] === "\\") {
        index += 2;
        continue;
      }
      if (line.startsWith(state, index)) {
        state = null;
        index += 3;
        continue;
      }
      index++;
      continue;
    }

    const char = line[index];
    if (char === "#") return null;
    if (char === '"' || char === "'") {
      const delimiter: MultilineStringDelimiter = char === '"' ? '"""' : "'''";
      if (line.startsWith(delimiter, index)) {
        state = delimiter;
        index += 3;
        continue;
      }
      index = skipSingleLineString(line, index);
      continue;
    }
    index++;
  }
  return state;
}

/**
 * Locate every managed block in an existing config.
 *
 * A region exists only when a whole line (after trimming) IS the start marker
 * and a later whole line IS the end marker. Marker text behind a comment, or
 * inside a single- or multi-line TOML string, is string content rather than a
 * region. A start marker with no closing end marker is refused loudly:
 * appending a second block there would leave a config.toml that no longer
 * parses (a duplicate marketplace table), so the user has to remove the stray
 * marker by hand.
 */
function findManagedRegions(configPath: string, content: string): ManagedRegion[] {
  const regions: ManagedRegion[] = [];
  let pendingStart: number | null = null;
  let multiline: MultilineStringDelimiter | null = null;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const rawLine = content.slice(lineStart, lineEnd);
    const line = rawLine.trim();

    if (multiline === null) {
      if (line === MANAGED_START && pendingStart === null) {
        pendingStart = lineStart;
      } else if (line === MANAGED_END && pendingStart !== null) {
        regions.push({ start: pendingStart, end: lineEnd });
        pendingStart = null;
      }
    }
    multiline = advanceMultilineStringState(rawLine, multiline);

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (pendingStart !== null) {
    throw new Error(
      `The Codex config ${configPath} contains the rolebox start marker ` +
        `${MANAGED_START} without a matching end marker ${MANAGED_END}. ` +
        "Remove the stray start marker by hand, then re-run `rolebox sync codex`.",
    );
  }
  return regions;
}

// ── Bundle contents ─────────────────────────────────────────────────────────

function buildPluginManifest(version: string): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    version,
    description:
      "Define custom AI agent roles with per-role prompts, models, skills and permissions.",
    author: { name: PLUGIN_ID },
    homepage: "https://github.com/EricMoin/rolebox",
    license: "MIT",
    keywords: ["agents", "roles", "skills", "mcp", "developer-tools"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: PLUGIN_ID,
      shortDescription: "Role-based agents, skills and tools",
      longDescription:
        "Defines custom AI agent roles, each with its own prompts, models, skills and permissions, and exposes rolebox's role, skill and graph tools to Codex over MCP.",
      developerName: PLUGIN_ID,
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
    },
  };
}

function buildMcpConfig(serverEntry: string, runtimeCommand: string): Record<string, unknown> {
  return {
    mcpServers: {
      [PLUGIN_ID]: {
        command: runtimeCommand,
        args: [serverEntry],
        startup_timeout_sec: 60,
        tool_timeout_sec: 600,
      },
    },
  };
}

function buildMarketplaceManifest(): Record<string, unknown> {
  return {
    name: PLUGIN_ID,
    interface: { displayName: PLUGIN_ID },
    plugins: [
      {
        name: PLUGIN_ID,
        source: { source: "local", path: `./plugins/${PLUGIN_ID}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  };
}

/** Write JSON with the 2-space indent + trailing newline the Codex bundle uses. */
function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/**
 * Normalize a symlink readback path: Windows junctions read back with a
 * \\?\ prefix, and a UNC junction as \\?\UNC\server\share, which must collapse
 * to \\server\share for a path comparison to work.
 */
export function normalizeLinkTarget(raw: string): string {
  return raw.replace(/^\\\\\?\\/, "").replace(/^UNC\\/i, "\\\\");
}

/** Whether the existing symlink at `linkPath` already points at `targetDir`. */
function linkPointsAt(linkPath: string, targetDir: string): boolean {
  try {
    return resolve(normalizeLinkTarget(readlinkSync(linkPath))) === resolve(targetDir);
  } catch {
    return false;
  }
}

/**
 * Expose `{codexHome}/skills` to the plugin as `{pluginDir}/skills`.
 *
 * Only a symlink is ever created here: a correct link is left untouched
 * (idempotent re-sync), a wrong link is replaced, and a real directory/file is
 * never destroyed.
 */
function ensureSkillsLink(linkPath: string, targetDir: string): void {
  let linkStat: Stats | null = null;
  try {
    linkStat = lstatSync(linkPath);
  } catch {
    linkStat = null;
  }

  if (linkStat === null) {
    createDirSymlink(targetDir, linkPath);
    return;
  }
  if (!linkStat.isSymbolicLink()) return;
  if (linkPointsAt(linkPath, targetDir)) return;
  unlinkSync(linkPath);
  createDirSymlink(targetDir, linkPath);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Walk up from a module URL to the directory containing package.json — bounded
 * because a missing package.json must fail loudly rather than walk to `/`.
 */
export function resolveRoleboxPackageRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve the rolebox package root from ${moduleUrl}`);
}

/**
 * Write the Codex plugin bundle (manifest, MCP config, marketplace manifest,
 * skills symlink) under `{codexHome}`. Idempotent: every file is rewritten
 * with identical bytes for identical options, and an existing correct skills
 * link is left untouched.
 */
export function writeCodexPluginBundle(
  opts: CodexPluginBundleOptions,
): CodexPluginBundlePaths {
  const marketplaceDir = join(opts.codexHome, "rolebox-marketplace");
  const pluginDir = join(marketplaceDir, "plugins", PLUGIN_ID);
  const serverEntry =
    opts.serverEntry ?? join(opts.packageRoot, "dist", "entries", "codex.js");

  const paths: CodexPluginBundlePaths = {
    marketplaceDir,
    pluginDir,
    manifestPath: join(pluginDir, ".codex-plugin", "plugin.json"),
    mcpConfigPath: join(pluginDir, ".mcp.json"),
    marketplaceManifestPath: join(marketplaceDir, ".agents", "plugins", "marketplace.json"),
    skillsLinkPath: join(pluginDir, "skills"),
    configPath: join(opts.codexHome, "config.toml"),
    serverEntry,
    serverEntryExists: existsSync(serverEntry),
  };

  mkdirSync(dirname(paths.manifestPath), { recursive: true });
  mkdirSync(dirname(paths.mcpConfigPath), { recursive: true });
  mkdirSync(dirname(paths.marketplaceManifestPath), { recursive: true });
  mkdirSync(join(opts.codexHome, "skills"), { recursive: true });

  writeJson(paths.manifestPath, buildPluginManifest(opts.version));
  writeJson(paths.mcpConfigPath, buildMcpConfig(serverEntry, opts.runtimeCommand ?? "node"));
  writeJson(paths.marketplaceManifestPath, buildMarketplaceManifest());
  ensureSkillsLink(paths.skillsLinkPath, join(opts.codexHome, "skills"));

  return paths;
}

/** Remove the marketplace directory. `removed` is true when it existed. */
export function removeCodexPluginBundle(codexHome: string): { removed: boolean } {
  const marketplaceDir = join(codexHome, "rolebox-marketplace");
  const existed = existsSync(marketplaceDir);
  rmSync(marketplaceDir, { recursive: true, force: true });
  return { removed: existed };
}

/**
 * Register the rolebox marketplace + plugin in a Codex `config.toml`.
 *
 * The registration is a comment-delimited managed block: when one is already
 * present it is replaced in place (so a second run with the same marketplace
 * root is byte-identical), otherwise it is appended after a single newline
 * separator (a blank line when the file already ends with one). Duplicate
 * blocks, left behind by a hand-edit, are repaired: the first is replaced with
 * the fresh block and every later one is removed. No other byte of the user's
 * file is touched. `changed` reports whether the file's bytes actually changed.
 */
export function registerCodexPlugin(
  configPath: string,
  marketplaceDir: string,
): { changed: boolean } {
  const block = buildManagedBlock(marketplaceDir);
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

  if (existing === null) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${block}\n`, "utf-8");
    return { changed: true };
  }

  const regions = findManagedRegions(configPath, existing);
  let next: string;
  if (regions.length > 0) {
    next = existing.slice(0, regions[0].start) + block;
    let after = regions[0].end;
    for (const region of regions.slice(1)) {
      next += existing.slice(after, region.start);
      after = region.end + (existing[region.end] === "\n" ? 1 : 0);
    }
    next += existing.slice(after);
  } else {
    // Exactly one leading newline: it terminates a non-empty file that lacks a
    // trailing one, and forms the blank line before the block otherwise. It is
    // also the single separator unregister removes, so the pre-existing bytes
    // come back either way.
    const separator = existing.length === 0 ? "" : "\n";
    next = `${existing}${separator}${block}\n`;
  }

  if (next === existing) return { changed: false };
  writeFileSync(configPath, next, "utf-8");
  return { changed: true };
}

/**
 * Remove every managed rolebox block from a Codex `config.toml`.
 *
 * Exactly the blocks and the single newline separator registration introduced
 * are removed, so a pre-existing file is restored byte for byte whether or not
 * it ended with a trailing newline. Duplicate blocks are all rolebox's own, so
 * all of them go. A file without a managed block (or a missing file) is a
 * no-op; a lone start marker is refused exactly as in registration, because an
 * unclosed block has no reliable extent to remove.
 */
export function unregisterCodexPlugin(configPath: string): { changed: boolean } {
  if (!existsSync(configPath)) return { changed: false };
  const existing = readFileSync(configPath, "utf-8");
  const regions = findManagedRegions(configPath, existing);
  if (regions.length === 0) return { changed: false };

  // Remove from the end so the earlier regions' offsets stay valid.
  let next = existing;
  for (let i = regions.length - 1; i >= 0; i--) {
    let start = regions[i].start;
    let end = regions[i].end;
    if (next[end] === "\n") end++;
    // Drop the single separator newline the append introduced before the first
    // block, but never the LF half of a CRLF the block did not introduce: that
    // would leave a lone \r behind.
    if (
      i === 0 &&
      start > 0 &&
      next[start - 1] === "\n" &&
      (start === 1 || next[start - 2] !== "\r")
    ) {
      start -= 1;
    }

    next = next.slice(0, start) + next.slice(end);
  }

  if (next === existing) return { changed: false };
  writeFileSync(configPath, next, "utf-8");
  return { changed: true };
}
